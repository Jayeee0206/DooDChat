const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`等待 ${type} 超时`)), 5000);
    function finish(error, value) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    }
    function onMessage(data) {
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch { return; }
      if (message.type === type) finish(null, message);
    }
    function onClose() { finish(new Error(`连接在收到 ${type} 前关闭`)); }
    ws.on('message', onMessage);
    ws.once('close', onClose);
  });
}

test('服务启动、双人聊天、图片上传和关闭清理', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dood-smoke-'));
  process.env.RUNTIME_DIR = runtimeDir;
  process.env.ROOM_PASSWORD = 'test-room-password';
  const { createDoodServer } = require('../server/index');
  const app = createDoodServer();
  let closed = false;
  t.after(async () => {
    try { if (!closed) await app.close(); }
    finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
  });

  const address = await app.start(0);
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await fetch(`${base}/`)).status, 200);

  const denied = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'invalid' }),
  });
  assert.equal(denied.status, 401);

  const first = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin: base });
  await once(first, 'open');
  const firstWelcome = waitForMessage(first, 'welcome');
  first.send(JSON.stringify({ type: 'set_nickname', username: 'Alice', roomPassword: 'test-room-password' }));
  const { uploadToken } = await firstWelcome;
  assert.ok(uploadToken);

  const second = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin: base });
  await once(second, 'open');
  const secondWelcome = waitForMessage(second, 'welcome');
  second.send(JSON.stringify({ type: 'set_nickname', username: 'Bob', roomPassword: 'test-room-password' }));
  await secondWelcome;

  const received = waitForMessage(second, 'message');
  first.send(JSON.stringify({ type: 'message', kind: 'text', content: 'release smoke test' }));
  assert.equal((await received).content, 'release smoke test');

  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9WZL8GQAAAABJRU5ErkJggg==';
  const uploaded = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upload-token': uploadToken },
    body: JSON.stringify({ data: tinyPng }),
  });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  assert.match(url, /^\/uploads\/[A-Za-z0-9.-]+\.png$/);
  assert.equal((await fetch(`${base}${url}`)).status, 200);

  await app.close();
  closed = true;
  assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'uploads')), ['.dood-ephemeral-storage']);
});
