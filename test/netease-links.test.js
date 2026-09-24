const assert = require('node:assert/strict');
const test = require('node:test');
const { resolvePlaylistId } = require('../server/services/netease');

function redirect(location, status = 302) {
  return {
    status,
    headers: new Headers({ location }),
    body: { async cancel() {} },
  };
}

test('网易云普通歌单链接直接提取，不访问网络', async () => {
  const fetchImpl = () => { throw new Error('不应访问网络'); };
  assert.equal(await resolvePlaylistId('https://music.163.com/#/playlist?id=12345', fetchImpl), '12345');
});

test('网易云短链接只手动读取官方跳转，忽略分享参数', async () => {
  let requestedUrl;
  let requestedOptions;
  const fetchImpl = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return redirect('https://y.music.163.com/m/playlist?id=987654321&userid=123');
  };
  assert.equal(await resolvePlaylistId('https://163cn.tv/AbC123xy?playlist?id=999', fetchImpl), '987654321');
  assert.equal(requestedUrl, 'https://163cn.tv/AbC123xy');
  assert.equal(requestedOptions.redirect, 'manual');
});

test('拒绝非官方短链接、非 HTTPS 和自定义端口', async () => {
  const fetchImpl = () => { throw new Error('不应访问网络'); };
  for (const url of [
    'https://163cn.tv.evil.example/AbC123xy',
    'http://163cn.tv/AbC123xy',
    'https://163cn.tv:8443/AbC123xy',
    'https://163cn.tv/a%2Fb',
  ]) {
    await assert.rejects(resolvePlaylistId(url, fetchImpl), /无法识别歌单链接/);
  }
});

test('拒绝跳转到非网易云域名或非 HTTPS 地址', async () => {
  for (const location of [
    'https://music.163.com.evil.example/playlist?id=123',
    'http://music.163.com/playlist?id=123',
    'https://music.163.com:8443/playlist?id=123',
  ]) {
    await assert.rejects(resolvePlaylistId('https://163cn.tv/AbC123xy', async () => redirect(location)),
      /短链接没有跳转到网易云歌单/);
  }
});

test('短链接没有有效跳转或有效歌单时明确报错', async () => {
  await assert.rejects(resolvePlaylistId('https://163cn.tv/AbC123xy', async () => redirect('', 200)),
    /暂时无法解析/);
  await assert.rejects(resolvePlaylistId('https://163cn.tv/AbC123xy', async () => redirect('https://music.163.com/')),
    /无法识别歌单链接/);
});
