const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const users = require('../server/handlers/users');

test('不可播放歌曲保留在歌单，自动跳过有终点，重试成功可恢复', async t => {
  const neteasePath = require.resolve('../server/services/netease');
  const musicPath = require.resolve('../server/handlers/music');
  const originalNetease = require(neteasePath);
  const playable = new Set();
  const songs = [11, 22].map(id => ({
    id, name: `测试歌曲 ${id}`, artists: [], album: { name: '', picUrl: '' }, duration: 60000,
  }));
  require.cache[neteasePath].exports = {
    ...originalNetease,
    resolvePlaylistId: async () => '1',
    getPlaylistDetail: async () => ({ id: 1, name: '测试歌单', songCount: songs.length,
      songs: songs.map(song => ({ ...song })) }),
    getSongUrl: async id => playable.has(id) ? 'https://music.126.net/test.mp3' : null,
    getLyrics: async () => null,
  };
  delete require.cache[musicPath];
  const music = require(musicPath);
  t.after(() => {
    music.shutdownMusic();
    users.clearUsers();
    require.cache[neteasePath].exports = originalNetease;
    delete require.cache[musicPath];
  });

  const messages = [];
  const ws = { readyState: WebSocket.OPEN, send: data => messages.push(JSON.parse(data)) };
  users.addUser('tester', ws);
  users.setUsername('tester', 'Tester');
  const share = () => music.handleMusicMessage(ws, 'tester', { type: 'music_share_playlist', url: 'https://music.163.com/playlist?id=1' });
  const select = id => music.handleMusicMessage(ws, 'tester', { type: 'music_select_song', songId: id });

  await share();
  await select(11);
  assert.deepEqual(music.MusicState.playlist.songs.map(song => song.id), [11, 22]);
  assert.ok(music.MusicState.playlist.songs.every(song => song.unavailable));
  assert.equal(music.MusicState.playbackState, 'stopped');
  assert.ok(messages.some(message => message.type === 'music_state' && message.playlist?.songs.length === 2));
  assert.equal(messages.some(message => message.type === 'music_playlist_end'), false);

  music.shutdownMusic();
  messages.length = 0;
  playable.add(22);
  await share();
  await select(11);
  assert.deepEqual(music.MusicState.playlist.songs.map(song => song.id), [11, 22]);
  assert.equal(music.MusicState.playlist.songs[0].unavailable, true);
  assert.equal(music.MusicState.currentSong.id, 22);
  assert.ok(messages.some(message => message.type === 'music_song_start' && message.song.id === 22));

  playable.add(11);
  await select(11);
  assert.equal(music.MusicState.currentSong.id, 11);
  assert.equal(music.MusicState.playlist.songs[0].unavailable, undefined);
});
