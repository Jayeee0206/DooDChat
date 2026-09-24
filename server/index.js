const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const { config, publicConfig } = require('./config');
const { addUser, clearResumeSessions, getOnlineCount, getUser, getUsersMap } = require('./handlers/users');
const { handleMessage, resetRoomFeatures, sendTo } = require('./handlers/message');
const { handleDisconnect } = require('./handlers/connection');
const history = require('./handlers/history');
const { clearVoiceUsers, handleVoiceMessage } = require('./handlers/voice');
const { handleMusicMessage, sendCurrentStateToUser, shutdownMusic } = require('./handlers/music');
const { IMAGE_PATH_RE, validateClientMessage } = require('./protocol');
const {
  FixedWindowLimiter,
  applySecurityHeaders,
  getClientIp,
  isAllowedOrigin,
} = require('./security');
const { createAudioProxy } = require('./services/audio-proxy');
const { createRoomLifecycle } = require('./services/room-lifecycle');
const { HttpError, UploadStore, readJsonBody } = require('./services/uploads');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = config.uploadDir;
const PUBLIC_REAL = fs.realpathSync(PUBLIC_DIR);

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return;
  const body = `${message}\n`;
  socket.end([
    `HTTP/1.1 ${status} ${message}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

function withinDirectory(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  const isUpload = pathname.startsWith('/uploads/');
  if (isUpload && !IMAGE_PATH_RE.test(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>404 Not Found</h1>');
    return;
  }
  const rootDirectory = isUpload ? UPLOADS_DIR : PUBLIC_DIR;
  const relative = pathname === '/'
    ? 'index.html'
    : isUpload
      ? pathname.slice('/uploads/'.length)
      : pathname.replace(/^[/\\]+/, '');
  const resolvedRoot = path.resolve(rootDirectory);
  const candidate = path.resolve(rootDirectory, relative);
  if (!withinDirectory(resolvedRoot, candidate)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let realPath;
  let stat;
  try {
    const realRoot = isUpload ? await fs.promises.realpath(rootDirectory) : PUBLIC_REAL;
    realPath = await fs.promises.realpath(candidate);
    if (!withinDirectory(realRoot, realPath)) throw new Error('outside static directory');
    stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>404 Not Found</h1>');
    return;
  }

  const extension = path.extname(realPath).toLowerCase();
  const isHtml = extension === '.html';
  res.writeHead(200, {
    'Content-Type': MIME_MAP[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHtml || isUpload ? 'no-store' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(realPath);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  stream.pipe(res);
}

function windowCounter(windowMs, max) {
  let start = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - start >= windowMs) { start = now; count = 0; }
    count += 1;
    return count <= max;
  };
}

function findUploadUser(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  for (const user of getUsersMap().values()) {
    if (user.authenticated && user.uploadToken === token) return user;
  }
  return null;
}

function createDoodServer() {
  const uploadStore = new UploadStore(UPLOADS_DIR);
  const audioProxy = createAudioProxy();
  const uploadLimiter = new FixedWindowLimiter({
    windowMs: config.uploadRateWindowMs,
    max: config.uploadRateMaxFiles,
  });
  const loginLimiter = new FixedWindowLimiter({
    windowMs: config.loginRateWindowMs,
    max: config.loginRateMaxAttempts,
  });
  const ipConnections = new Map();
  const roomLifecycle = createRoomLifecycle({
    graceMs: config.roomEmptyGraceMs,
    uploadStore,
    audioCache: audioProxy.cache,
    resetMemoryState() {
      shutdownMusic();
      clearVoiceUsers();
      resetRoomFeatures();
      history.clearMemory();
      clearResumeSessions();
      uploadLimiter.clear();
    },
  });

  async function handleUpload(req, res) {
    const token = req.headers['x-upload-token'];
    const user = findUploadUser(token);
    if (!user) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!uploadLimiter.take(token).allowed) {
      sendJson(res, 429, { error: 'Upload rate limit exceeded' }, { 'Retry-After': Math.ceil(config.uploadRateWindowMs / 1000) });
      return;
    }

    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.data !== 'string') {
        throw new HttpError(400, 'Invalid upload payload');
      }
      const saved = await uploadStore.saveBase64(body.data);
      sendJson(res, 200, saved);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('图片上传失败:', error.message);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal Server Error' : error.message });
    }
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(req, res);
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    try {
      if (requestUrl.pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
          return;
        }
        if (req.method === 'HEAD') { res.writeHead(204).end(); return; }
        sendJson(res, 200, { ok: true, uptime: Math.floor(process.uptime()) });
        return;
      }
      if (requestUrl.pathname === '/api/config') {
        if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end('Method Not Allowed'); return; }
        sendJson(res, 200, publicConfig(), { 'Cache-Control': 'no-store' });
        return;
      }
      if (requestUrl.pathname === '/api/proxy/audio') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed'); return; }
        await audioProxy.handle(req, res);
        return;
      }
      if (requestUrl.pathname === '/api/upload') {
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed'); return; }
        await handleUpload(req, res);
        return;
      }
      await serveStatic(req, res, decodeURIComponent(requestUrl.pathname));
    } catch (error) {
      console.error('HTTP 请求处理失败:', error.message);
      if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      else res.end();
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: config.maxWsMessageBytes,
    perMessageDeflate: false,
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
    catch { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    if (pathname !== '/') { rejectUpgrade(socket, 404, 'Not Found'); return; }
    if (!isAllowedOrigin(req)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    if (wss.clients.size >= config.maxTotalConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const ip = getClientIp(req);
    const current = ipConnections.get(ip) || 0;
    if (current >= config.maxConnectionsPerIp) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ipConnections.set(ip, current + 1);
      ws._clientIp = ip;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    // 会话恢复成功时 id 会改绑为上一连接的 id，因此使用 let
    let id = crypto.randomUUID();
    const ip = ws._clientIp || getClientIp(req);
    addUser(id, ws, { ip });
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    const authenticationTimer = setTimeout(() => {
      const user = getUser(id);
      if (user && !user.authenticated) ws.close(1008, 'authentication timeout');
    }, config.authenticationTimeoutMs);
    authenticationTimer.unref?.();

    const takeMessage = windowCounter(config.wsRateWindowMs, config.wsRateMaxMessages);
    const takeInvalid = windowCounter(config.wsInvalidWindowMs, config.wsInvalidMaxMessages);

    function invalid(reason) {
      if (ws.readyState === WebSocket.OPEN) sendTo(id, { type: 'error', code: 'INVALID_MESSAGE', content: reason });
      if (!takeInvalid()) ws.close(1008, 'too many invalid messages');
    }

    ws.on('message', (rawData, isBinary) => {
      if (!takeMessage()) { ws.close(1008, 'message rate limit exceeded'); return; }
      if (isBinary || rawData.length > config.maxWsMessageBytes) { invalid('不支持的消息格式'); return; }

      let input;
      try { input = JSON.parse(rawData.toString('utf8')); }
      catch { invalid('JSON 格式无效'); return; }

      const validation = validateClientMessage(input);
      if (!validation.ok) { invalid(validation.error); return; }
      const parsed = validation.value;
      const user = getUser(id);
      if (!user) return;

      if (!user.authenticated && parsed.type !== 'set_nickname') {
        invalid('请先完成登录');
        return;
      }
      if (parsed.type === 'set_nickname' && !user.authenticated && !loginLimiter.take(ip).allowed) {
        sendTo(id, { type: 'error', code: 'LOGIN_RATE_LIMIT', content: '登录尝试过于频繁，请稍后再试' });
        ws.close(1008, 'login rate limit exceeded');
        return;
      }
      if (parsed.type === 'set_nickname' && !user.authenticated && roomLifecycle.isCleaning()) {
        ws.close(1012, 'room is resetting');
        return;
      }

      try {
        const voiceTypes = new Set(['join_voice', 'leave_voice', 'voice_offer', 'voice_answer', 'voice_ice', 'voice_mute']);
        const musicTypes = new Set(['music_share_playlist', 'music_select_song', 'music_pause', 'music_resume', 'music_next', 'music_prev', 'music_remove_song', 'music_reorder', 'music_resync']);
        if (voiceTypes.has(parsed.type)) {
          handleVoiceMessage(ws, id, parsed);
        } else if (musicTypes.has(parsed.type)) {
          Promise.resolve(handleMusicMessage(ws, id, parsed)).catch(error => {
            console.error('音乐消息处理失败:', error.message);
            sendTo(id, { type: 'music_error', content: '音乐操作失败' });
          });
        } else {
          const result = handleMessage(ws, id, parsed);
          // 撤回图片消息时删除对应临时文件；失败不阻断广播，残留由房间结束清理兜底
          if (result?.recalledUploadUrl) {
            uploadStore.deleteByUrl(result.recalledUploadUrl).catch(() => {});
          }
          // 只在本次真正完成登录时接线；已认证连接重复发送 set_nickname 不再重推音乐状态
          if (parsed.type === 'set_nickname' && result.justAuthenticated) {
            if (result.resumedId) id = result.resumedId;
            clearTimeout(authenticationTimer);
            roomLifecycle.markOccupied();
            sendCurrentStateToUser(id);
          }
        }
      } catch (error) {
        console.error('消息处理异常（已隔离）:', error.message);
        sendTo(id, { type: 'error', code: 'MESSAGE_HANDLER_ERROR', content: '消息处理失败' });
      }
    });

    ws.once('close', () => {
      clearTimeout(authenticationTimer);
      const count = Math.max(0, (ipConnections.get(ip) || 1) - 1);
      if (count === 0) ipConnections.delete(ip);
      else ipConnections.set(ip, count);
      // 传入 ws：若该 id 已被同身份的新连接接管，旧 socket 的 close 不会移除新连接
      const user = handleDisconnect(id, { ws });
      if (user?.uploadToken) uploadLimiter.delete(user.uploadToken);
      if (user?.authenticated) roomLifecycle.scheduleIfEmpty(getOnlineCount());
    });
    ws.on('error', error => console.warn(`WebSocket ${id} 错误:`, error.message));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws._alive) { ws.terminate(); continue; }
      ws._alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  async function start(port = config.port) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server.address();
  }

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    await new Promise(resolve => wss.close(() => resolve()));
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    await roomLifecycle.shutdown();
  }

  return { audioProxy, close, ipConnections, roomLifecycle, server, start, uploadStore, wss };
}

if (require.main === module) {
  const app = createDoodServer();
  app.start().then(address => {
    console.log('🚀 DooDChat 已启动！');
    console.log(`   本地访问: http://localhost:${address.port}`);
    console.log(`   局域网访问: http://<你的IP>:${address.port}`);
  }).catch(error => {
    console.error('服务启动失败:', error);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在安全关闭...`);
    app.close().then(() => process.exit(0)).catch(error => {
      console.error('安全关闭失败:', error);
      process.exit(1);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createDoodServer, sendJson, serveStatic };
