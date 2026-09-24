const os = require('os');
const path = require('path');

function integer(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function list(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

const runtimeDir = process.env.RUNTIME_DIR || path.join(os.tmpdir(), 'dood-runtime');

const config = Object.freeze({
  port: integer('PORT', 3000, 0, 65535),
  trustProxy: boolean('TRUST_PROXY', false),
  trustedProxies: list('TRUSTED_PROXIES'),
  allowedOrigins: list('ALLOWED_ORIGINS'),
  allowNoOrigin: boolean('ALLOW_NO_ORIGIN', true),
  roomPassword: String(process.env.ROOM_PASSWORD || ''),

  maxConnectionsPerIp: integer('MAX_CONNECTIONS_PER_IP', 20, 1, 1000),
  maxTotalConnections: integer('MAX_TOTAL_CONNECTIONS', 100, 1, 10000),
  maxAuthenticatedUsers: integer('MAX_AUTHENTICATED_USERS', 50, 1, 10000),
  maxVoiceUsers: integer('MAX_VOICE_USERS', 8, 2, 100),
  authenticationTimeoutMs: integer('AUTHENTICATION_TIMEOUT_MS', 15000, 1000, 300000),
  maxWsMessageBytes: integer('MAX_WS_MESSAGE_BYTES', 64 * 1024, 1024, 1024 * 1024),
  wsRateWindowMs: integer('WS_RATE_WINDOW_MS', 5000, 1000, 60000),
  wsRateMaxMessages: integer('WS_RATE_MAX_MESSAGES', 100, 1, 10000),
  wsInvalidWindowMs: integer('WS_INVALID_WINDOW_MS', 60000, 1000, 10 * 60000),
  wsInvalidMaxMessages: integer('WS_INVALID_MAX_MESSAGES', 10, 1, 1000),
  loginRateWindowMs: integer('LOGIN_RATE_WINDOW_MS', 60000, 1000, 60 * 60000),
  loginRateMaxAttempts: integer('LOGIN_RATE_MAX_ATTEMPTS', 10, 1, 1000),

  uploadBodyMaxBytes: integer('UPLOAD_BODY_MAX_BYTES', 15 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  uploadFileMaxBytes: integer('UPLOAD_FILE_MAX_BYTES', 10 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  uploadMaxPixels: integer('UPLOAD_MAX_PIXELS', 25_000_000, 1, 200_000_000),
  uploadMaxDimension: integer('UPLOAD_MAX_DIMENSION', 10000, 1, 50000),
  uploadStorageMaxBytes: integer('UPLOAD_STORAGE_MAX_BYTES', 512 * 1024 * 1024, 1024 * 1024, 20 * 1024 * 1024 * 1024),
  uploadRateWindowMs: integer('UPLOAD_RATE_WINDOW_MS', 60000, 1000, 60 * 60000),
  uploadRateMaxFiles: integer('UPLOAD_RATE_MAX_FILES', 10, 1, 1000),

  runtimeDir,
  roomEmptyGraceMs: integer('ROOM_EMPTY_GRACE_MS', 10 * 60 * 1000, 50, 24 * 60 * 60 * 1000),
  recallWindowMs: integer('RECALL_WINDOW_MS', 2 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  resumeWindowMs: integer('RESUME_WINDOW_MS', 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  uploadDir: process.env.UPLOAD_DIR || path.join(runtimeDir, 'uploads'),

  upstreamTimeoutMs: integer('UPSTREAM_TIMEOUT_MS', 12000, 1000, 120000),
  upstreamJsonMaxBytes: integer('UPSTREAM_JSON_MAX_BYTES', 5 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  audioMaxBytes: integer('AUDIO_MAX_BYTES', 30 * 1024 * 1024, 1024 * 1024, 200 * 1024 * 1024),
  audioCacheMaxBytes: integer('AUDIO_CACHE_MAX_BYTES', 200 * 1024 * 1024, 1024 * 1024, 5 * 1024 * 1024 * 1024),
  audioMaxRedirects: integer('AUDIO_MAX_REDIRECTS', 3, 0, 10),
  audioCacheDir: process.env.AUDIO_CACHE_DIR || path.join(runtimeDir, 'audio-cache'),

  historyMemoryLimit: integer('HISTORY_MEMORY_LIMIT', 100, 1, 10000),
});

function publicConfig() {
  return {
    roomPasswordRequired: config.roomPassword.length > 0,
    maxUploadBytes: config.uploadFileMaxBytes,
  };
}

module.exports = { config, publicConfig };
