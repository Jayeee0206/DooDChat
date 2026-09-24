const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCoverUrl } = require('../server/services/netease');

test('网易云官方 HTTP 封面升级为 HTTPS', () => {
  assert.equal(normalizeCoverUrl('http://p2.music.126.net/cover.jpg'), 'https://p2.music.126.net/cover.jpg');
  assert.equal(normalizeCoverUrl('https://p1.music.126.net/cover.jpg'), 'https://p1.music.126.net/cover.jpg');
});

test('不接受伪装域名、凭据或非图片来源地址', () => {
  for (const url of [
    'http://p2.music.126.net.evil.example/cover.jpg',
    'http://user@p2.music.126.net/cover.jpg',
    'http://p2.music.126.net:8080/cover.jpg',
    'data:image/png;base64,AA==',
  ]) assert.equal(normalizeCoverUrl(url), '');
});
