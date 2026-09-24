const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { isAllowedAudioUrl } = require('./netease');
const { verifySignedAudioRequest } = require('./media-token');
const { clearOwnedDirectory, prepareOwnedDirectory } = require('./ephemeral-directory');

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const UPSTREAM_HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function cacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function normalizeContentType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('audio/') || type === 'application/octet-stream') return type;
  throw new Error('Upstream did not return audio');
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Audio exceeds size limit');
  if (!response.body) throw new Error('Upstream response has no body');

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { await response.body.cancel(); } catch {}
      throw new Error('Audio exceeds size limit');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (total === 0) throw new Error('Upstream returned empty audio');
  return Buffer.concat(chunks, total);
}

async function fetchAudio(url, fetchImpl = fetch) {
  let current = url;
  for (let redirects = 0; redirects <= config.audioMaxRedirects; redirects += 1) {
    if (!isAllowedAudioUrl(current)) throw new Error('Audio source is not allowed');
    const response = await fetchImpl(current, {
      headers: UPSTREAM_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch {}
      if (!location || redirects === config.audioMaxRedirects) throw new Error('Too many audio redirects');
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(`Audio upstream returned ${response.status}`);
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    const buffer = await readLimitedBody(response, config.audioMaxBytes);
    return { buffer, contentType, finalUrl: current };
  }
  throw new Error('Too many audio redirects');
}

class AudioCache {
  constructor(directory = config.audioCacheDir) {
    this.directory = directory;
    this.entries = new Map();
    this.pending = new Map();
    prepareOwnedDirectory(directory);
    this.loadIndex();
  }

  async clear() {
    await Promise.allSettled([...this.pending.values()]);
    this.entries.clear();
    this.pending.clear();
    await clearOwnedDirectory(this.directory);
  }

  loadIndex() {
    const files = fs.readdirSync(this.directory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.bin$/.test(file.name)) continue;
      const key = file.name.slice(0, -4);
      const filePath = path.join(this.directory, file.name);
      try {
        const stat = fs.statSync(filePath);
        const metadataPath = path.join(this.directory, `${key}.json`);
        let contentType = 'audio/mpeg';
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          contentType = normalizeContentType(metadata.contentType);
        } catch {}
        this.entries.set(key, {
          filePath,
          metadataPath,
          contentType,
          size: stat.size,
          lastUsed: stat.mtimeMs,
          buffer: null,
        });
      } catch {}
    }
    this.evictSync();
  }

  totalBytes() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    return total;
  }

  evictSync(protectedKey = null) {
    let total = this.totalBytes();
    if (total <= config.audioCacheMaxBytes) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of oldest) {
      if (total <= config.audioCacheMaxBytes) break;
      if (key === protectedKey) continue;
      this.entries.delete(key);
      total -= entry.size;
      try { fs.unlinkSync(entry.filePath); } catch {}
      try { fs.unlinkSync(entry.metadataPath); } catch {}
    }
  }

  async get(url) {
    const key = cacheKey(url);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      if (!existing.buffer) existing.buffer = await fs.promises.readFile(existing.filePath);
      fs.promises.utimes(existing.filePath, new Date(), new Date()).catch(() => {});
      return existing;
    }
    if (this.pending.has(key)) return this.pending.get(key);

    const request = this.download(key, url).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  async download(key, url) {
    const fetched = await fetchAudio(url);
    const filePath = path.join(this.directory, `${key}.bin`);
    const metadataPath = path.join(this.directory, `${key}.json`);
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tempPath, fetched.buffer, { flag: 'wx' });
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.writeFile(metadataPath, JSON.stringify({ contentType: fetched.contentType, finalUrl: fetched.finalUrl }));

    const entry = {
      filePath,
      metadataPath,
      contentType: fetched.contentType,
      size: fetched.buffer.length,
      lastUsed: Date.now(),
      buffer: fetched.buffer,
    };
    this.entries.set(key, entry);
    this.evictSync(key);
    return entry;
  }
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      return { invalid: true };
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function createAudioProxy() {
  const cache = new AudioCache();

  async function handle(req, res) {
    let targetUrl;
    let expires;
    let signature;
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      targetUrl = requestUrl.searchParams.get('url');
      expires = requestUrl.searchParams.get('expires');
      signature = requestUrl.searchParams.get('sig');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (!targetUrl) {
      res.writeHead(400).end('Missing url parameter');
      return;
    }
    if (!isAllowedAudioUrl(targetUrl) || !verifySignedAudioRequest(targetUrl, expires, signature)) {
      res.writeHead(403).end('Forbidden: invalid audio request');
      return;
    }

    try {
      const entry = await cache.get(targetUrl);
      const isHead = req.method === 'HEAD';
      const range = parseRange(req.headers.range, entry.buffer.length);
      if (range?.invalid) {
        res.writeHead(416, { 'Content-Range': `bytes */${entry.buffer.length}` });
        res.end();
        return;
      }

      if (range) {
        const chunk = entry.buffer.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          'Content-Type': entry.contentType,
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${range.start}-${range.end}/${entry.buffer.length}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        if (isHead) res.end();
        else res.end(chunk);
        return;
      }

      res.writeHead(200, {
        'Content-Type': entry.contentType,
        'Content-Length': entry.buffer.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      if (isHead) res.end();
      else res.end(entry.buffer);
    } catch (error) {
      console.error('音频代理失败:', error.message);
      const status = error.name === 'TimeoutError' ? 504 : 502;
      res.writeHead(status).end(status === 504 ? 'Gateway Timeout' : 'Bad Gateway');
    }
  }

  return { cache, handle };
}

module.exports = {
  AudioCache,
  createAudioProxy,
  fetchAudio,
  parseRange,
  readLimitedBody,
};
