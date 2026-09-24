'use strict';

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MINIMUM_NODE_MAJOR = 20;

function nodeMajor(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10);
}

function assertSupportedNode(version = process.versions.node) {
  const major = nodeMajor(version);
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(`需要 Node.js ${MINIMUM_NODE_MAJOR} 或更高版本，当前版本是 ${version || '未知'}`);
  }
}

function hasRuntimeDependencies() {
  try {
    require.resolve('ws', { paths: [PROJECT_ROOT] });
    return true;
  } catch {
    return false;
  }
}

function ensureRuntimeDependencies() {
  if (hasRuntimeDependencies()) return;

  const npmArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmCommandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm.cmd ${npmArgs.join(' ')}`]
    : npmArgs;
  console.log('首次运行需要安装 DooDChat 依赖，请保持网络连接，通常只需执行一次。');
  const result = spawnSync(
    npmCommand,
    npmCommandArgs,
    { cwd: PROJECT_ROOT, stdio: 'inherit', windowsHide: false },
  );
  if (result.error) {
    throw new Error(`无法运行 npm：${result.error.message}`);
  }
  if (result.status !== 0 || !hasRuntimeDependencies()) {
    throw new Error('依赖安装失败，请检查网络后重新双击“启动DooDChat.cmd”');
  }
}

function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return parts[0] === 192 && parts[1] === 168;
}

function listLanAddresses(networks = os.networkInterfaces()) {
  const addresses = new Set();
  for (const entries of Object.values(networks || {})) {
    for (const entry of entries || []) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIpv4 || entry.internal || !entry.address || !isPrivateIpv4(entry.address)) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort((left, right) => left.localeCompare(right, 'en'));
}

function friendUrls(port, networks = os.networkInterfaces()) {
  return listLanAddresses(networks).map(address => `http://${address}:${port}`);
}

function openLocalBrowser(url) {
  if (process.platform !== 'win32' || process.env.DOOD_NO_BROWSER === '1') return;
  const command = `start "" "${url}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function friendlyStartError(error) {
  if (error?.code === 'EADDRINUSE') {
    return '端口已被占用。DooDChat 可能已经启动，请先检查是否还有另一个 DooDChat 黑色窗口。';
  }
  if (error?.code === 'EACCES') {
    return '没有权限使用当前端口，请检查安全软件或端口设置。';
  }
  return error?.message || String(error);
}

function printStarted(address, config) {
  const localUrl = `http://127.0.0.1:${address.port}`;
  const urls = friendUrls(address.port);
  console.log('');
  console.log('============================================================');
  console.log('DooDChat 已启动');
  console.log(`本机访问：${localUrl}`);
  if (urls.length > 0) {
    console.log('');
    console.log('同一 Wi-Fi / 局域网内的朋友可尝试打开：');
    for (const url of urls) console.log(`  ${url}`);
  } else {
    console.log('');
    console.log('暂未找到可用的局域网地址，本机仍可正常使用。');
  }
  console.log('');
  console.log(config.roomPassword
    ? '房间密码：已启用（启动器不会在窗口中显示密码）'
    : '房间密码：未设置，仅建议在可信的私人网络中使用');
  console.log('首次出现 Windows 防火墙提示时，只允许“专用网络”即可。');
  console.log('手机或异地语音通常需要 HTTPS；当前启动器不会自动开放公网。');
  console.log('');
  console.log('请保持此窗口开启。使用结束后，在这里按一次回车安全关闭。');
  console.log('============================================================');
  console.log('');
  return localUrl;
}

async function runLauncher() {
  process.chdir(PROJECT_ROOT);
  assertSupportedNode();
  ensureRuntimeDependencies();

  const { config } = require('../server/config');
  const { createDoodServer } = require('../server/index');
  const app = createDoodServer();
  let started = false;
  let closed = false;
  let stopRequested = false;
  let resolveStop;
  const stopPromise = new Promise(resolve => { resolveStop = resolve; });
  const requestStop = reason => {
    if (stopRequested) return;
    stopRequested = true;
    resolveStop(reason);
  };

  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  input.once('line', () => requestStop('按下回车'));
  input.on('SIGINT', () => requestStop('Ctrl+C'));
  const onSigint = () => requestStop('Ctrl+C');
  const onSigterm = () => requestStop('系统关闭请求');
  const onSighup = () => requestStop('窗口关闭请求');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);

  try {
    const address = await app.start();
    started = true;
    const localUrl = printStarted(address, config);
    try {
      openLocalBrowser(localUrl);
    } catch (error) {
      console.warn(`未能自动打开浏览器，请手动访问 ${localUrl}（${error.message}）`);
    }

    const reason = await stopPromise;
    input.close();
    console.log(`收到${reason}，正在清理本轮房间并安全关闭...`);
    await app.close();
    closed = true;
    console.log('DooDChat 已安全关闭，本轮聊天、图片和音频缓存已清理。');
  } finally {
    input.close();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    if (started && !closed) await app.close().catch(() => {});
  }
}

if (require.main === module) {
  runLauncher().catch(error => {
    console.error('');
    console.error(`DooDChat 启动失败：${friendlyStartError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertSupportedNode,
  friendUrls,
  friendlyStartError,
  listLanAddresses,
  nodeMajor,
  printStarted,
  runLauncher,
};
