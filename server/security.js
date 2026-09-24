const crypto = require('crypto');
const net = require('net');
const { config } = require('./config');

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  return net.isIP(ip) ? ip : 'unknown';
}

function shouldTrustProxy(req) {
  if (!config.trustProxy) return false;
  const remote = normalizeIp(req.socket && req.socket.remoteAddress);
  if (config.trustedProxies.length > 0) {
    return config.trustedProxies.some(value => normalizeIp(value) === remote);
  }
  return remote === '127.0.0.1' || remote === '::1';
}

function getClientIp(req) {
  if (shouldTrustProxy(req)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const normalized = normalizeIp(forwarded);
    if (normalized !== 'unknown') return normalized;
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function requestHost(req) {
  const forwarded = shouldTrustProxy(req) ? req.headers['x-forwarded-host'] : null;
  return String(forwarded || req.headers.host || '').split(',')[0].trim().toLowerCase();
}

function isAllowedOrigin(req) {
  const raw = req.headers.origin;
  if (!raw) return config.allowNoOrigin;
  const origin = normalizeOrigin(raw);
  if (!origin) return false;

  if (config.allowedOrigins.length > 0) {
    return config.allowedOrigins.some(value => normalizeOrigin(value) === origin);
  }

  try {
    return new URL(origin).host.toLowerCase() === requestHost(req);
  } catch {
    return false;
  }
}

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://music.163.com https://*.music.163.com https://music.126.net https://*.music.126.net",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
  ].join('; '));

  const forwardedProto = shouldTrustProxy(req) ? req.headers['x-forwarded-proto'] : null;
  if (req.socket?.encrypted || String(forwardedProto).split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isRoomPasswordValid(candidate) {
  if (!config.roomPassword) return true;
  return timingSafeTextEqual(candidate || '', config.roomPassword);
}

class FixedWindowLimiter {
  constructor({ windowMs, max, maxKeys = 10000 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.lastPrune = 0;
  }

  take(key, now = Date.now()) {
    if (now - this.lastPrune > this.windowMs || this.entries.size > this.maxKeys) {
      this.prune(now);
    }
    let entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      entry = { startedAt: now, count: 0 };
    }
    entry.count += 1;
    this.entries.set(key, entry);
    return { allowed: entry.count <= this.max, remaining: Math.max(0, this.max - entry.count) };
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.lastPrune = 0;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    }
    this.lastPrune = now;
  }
}

module.exports = {
  FixedWindowLimiter,
  applySecurityHeaders,
  getClientIp,
  isAllowedOrigin,
  isRoomPasswordValid,
  normalizeIp,
  shouldTrustProxy,
  timingSafeTextEqual,
};
