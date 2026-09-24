const crypto = require('crypto');

const secret = crypto.randomBytes(32);
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function signature(url, expires) {
  return crypto.createHmac('sha256', secret).update(`${expires}\n${url}`).digest('base64url');
}

function createSignedAudioPath(url, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const expires = now + ttlMs;
  const sig = signature(url, expires);
  return `/api/proxy/audio?url=${encodeURIComponent(url)}&expires=${expires}&sig=${encodeURIComponent(sig)}`;
}

function verifySignedAudioRequest(url, expiresValue, providedSignature, now = Date.now()) {
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + DEFAULT_TTL_MS + 60_000) return false;
  if (typeof providedSignature !== 'string' || providedSignature.length > 128) return false;
  const expected = signature(url, expires);
  const left = Buffer.from(expected);
  const right = Buffer.from(providedSignature);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { createSignedAudioPath, verifySignedAudioRequest };
