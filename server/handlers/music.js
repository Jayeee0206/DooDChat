/**
 * WebSocket 音乐消息处理器
 * 管理歌单分享、歌曲选择、播放控制
 * 同步策略：立即广播 startTime，客户端缓冲完成后 seek 到正确位置
 */
const WebSocket = require('ws');
const { getUsersMap, getUser } = require('./users');
const { resolvePlaylistId, getPlaylistDetail, getSongUrl, getLyrics } = require('../services/netease');
const { createSignedAudioPath } = require('../services/media-token');

const MusicState = {
  playlist: null,
  currentSong: null,
  playbackState: 'stopped',
  startTime: 0,
  elapsed: 0,
  sharedBy: null,
  sharedByUsername: null,
  currentProxyUrl: null,
  lyrics: null,
  nextTimer: null,
  syncTimer: null,
  // 播放代次。每次点歌、分享歌单或切歌自增；
  // 慢速 await 返回后代次不一致即放弃，避免旧请求覆盖新状态
  generation: 0,
};

/* ====== 速率限制 ====== */
const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const last = rateLimitMap.get(userId) || 0;
  if (now - last < 10000) return false;
  rateLimitMap.set(userId, now);
  if (rateLimitMap.size > 1000) {
    for (const [id, timestamp] of rateLimitMap) {
      if (now - timestamp > 60000) rateLimitMap.delete(id);
    }
  }
  return true;
}

/* ====== 消息发送 ====== */
function sendTo(id, data) {
  const users = getUsersMap();
  const user = users.get(id);
  if (user?.authenticated && user.ws.readyState === WebSocket.OPEN) {
    user.ws.send(JSON.stringify(data));
  }
}

function broadcastToAll(data) {
  const users = getUsersMap();
  const message = JSON.stringify(data);
  for (const user of users.values()) {
    if (user.authenticated && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(message);
    }
  }
}

/* ====== 定时器 ====== */
function clearAllTimers() {
  if (MusicState.nextTimer) { clearTimeout(MusicState.nextTimer); MusicState.nextTimer = null; }
  if (MusicState.syncTimer) { clearInterval(MusicState.syncTimer); MusicState.syncTimer = null; }
}

function startSyncInterval() {
  stopSyncInterval();
  MusicState.syncTimer = setInterval(() => {
    if (MusicState.playbackState !== 'playing') return;
    broadcastToAll({ type: 'music_sync', elapsed: Date.now() - MusicState.startTime });
  }, 15000);
}

function stopSyncInterval() {
  if (MusicState.syncTimer) { clearInterval(MusicState.syncTimer); MusicState.syncTimer = null; }
}

/* ====== 自动下一首 ====== */
function scheduleNextSong() {
  if (MusicState.nextTimer) clearTimeout(MusicState.nextTimer);
  if (!MusicState.currentSong || MusicState.playbackState !== 'playing') return;
  const duration = MusicState.currentSong.duration || 0;
  if (duration <= 0) return;
  const remaining = duration - (Date.now() - MusicState.startTime);
  if (remaining > 0) {
    MusicState.nextTimer = setTimeout(autoNextSong, remaining + 500);
  }
}

function autoNextSong() {
  if (!MusicState.playlist || !MusicState.currentSong) return;
  const songs = MusicState.playlist.songs;
  if (songs.length === 0) return;
  const idx = songs.findIndex(s => s.id === MusicState.currentSong.id);
  clearAllTimers();
  // 循环：最后一首播完回到第一首
  const next = idx + 1 < songs.length ? songs[idx + 1] : songs[0];
  startSong(next);
}

/* ====== 核心：起播 ====== */
async function startSong(song, skipped = new Set()) {
  // 捕获进入时的代次，任何 await 之后都要校验
  const gen = ++MusicState.generation;
  try {
    const audioUrl = await getSongUrl(song.id);
    if (gen !== MusicState.generation) return; // 已有更新的点歌/歌单，放弃本次
    if (!audioUrl) {
      const songs = MusicState.playlist.songs;
      const index = songs.findIndex(s => s.id === song.id);
      if (index < 0) return; // 等待音频地址期间，歌曲可能已被手动移除
      song.unavailable = true;
      skipped.add(song.id);
      broadcastToAll({ type: 'music_error', content: `《${song.name}》暂时无法播放，已跳过；稍后可点击重试` });
      broadcastToAll({ type: 'music_playlist_update', playlist: MusicState.playlist });
      const next = [...songs.slice(index + 1), ...songs.slice(0, index)].find(s => !skipped.has(s.id));
      if (next) return startSong(next, skipped);
      clearAllTimers();
      MusicState.playbackState = 'stopped';
      MusicState.currentSong = null;
      MusicState.currentProxyUrl = null;
      MusicState.lyrics = null;
      MusicState.startTime = 0;
      MusicState.elapsed = 0;
      broadcastToAll({ type: 'music_state', playlist: MusicState.playlist, currentSong: null,
        playbackState: 'stopped', sharedBy: MusicState.sharedByUsername });
      broadcastToAll({ type: 'music_error', content: '当前歌单暂无可播放歌曲，列表已保留' });
      return;
    }

    clearAllTimers();
    if (song.unavailable) {
      delete song.unavailable;
      broadcastToAll({ type: 'music_playlist_update', playlist: MusicState.playlist });
    }
    const proxyUrl = createSignedAudioPath(audioUrl);

    MusicState.currentSong = song;
    MusicState.currentProxyUrl = proxyUrl;
    MusicState.lyrics = null;

    // 歌词后置异步获取，不阻塞全员起播
    getLyrics(song.id).then(lyrics => {
      if (gen !== MusicState.generation) return;
      if (!MusicState.currentSong || MusicState.currentSong.id !== song.id) return;
      MusicState.lyrics = lyrics;
      broadcastToAll({ type: 'music_lyrics_update', songId: song.id, lyrics });
    }).catch(() => {});

    // 期间可能已被暂停，此时只更新歌曲信息，不覆盖暂停状态
    if (MusicState.playbackState === 'paused') {
      // 切到新歌后旧进度作废，恢复时从头开始
      MusicState.elapsed = 0;
      broadcastToAll({
        type: 'music_song_loaded',
        song,
        proxyUrl,
        lyrics: null,
      });
      return;
    }

    MusicState.playbackState = 'playing';
    MusicState.startTime = Date.now();
    MusicState.elapsed = 0;

    broadcastToAll({
      type: 'music_song_start',
      song,
      proxyUrl,
      startTime: MusicState.startTime,
      // 下发已播放毫秒数，客户端据此换算本地时钟
      elapsed: 0,
      lyrics: null,
    });

    startSyncInterval();
    scheduleNextSong();
  } catch (err) {
    if (gen !== MusicState.generation) return;
    broadcastToAll({ type: 'music_error', content: `播放歌曲时出错: ${err.message}` });
  }
}

/* ====== 拖拽重排 ====== */
function handleReorderPlaylist(id, user, parsed) {
  if (!MusicState.playlist) return sendTo(id, { type: 'music_error', content: '当前没有歌单' });
  if (!Array.isArray(parsed.order) || parsed.order.length !== MusicState.playlist.songs.length) return;
  // order 必须是现有歌曲 id 的严格排列（无重复、全命中），防止歌单出现重复歌曲
  if (new Set(parsed.order).size !== parsed.order.length) return;
  var songMap = {};
  for (var i = 0; i < MusicState.playlist.songs.length; i++) {
    songMap[MusicState.playlist.songs[i].id] = MusicState.playlist.songs[i];
  }
  var reordered = [];
  for (var j = 0; j < parsed.order.length; j++) {
    if (songMap[parsed.order[j]]) reordered.push(songMap[parsed.order[j]]);
  }
  if (reordered.length !== MusicState.playlist.songs.length) return;
  MusicState.playlist.songs = reordered;
  broadcastToAll({ type: 'music_playlist_update', playlist: MusicState.playlist });
}

/* ====== 消息分发 ====== */
async function handleMusicMessage(ws, id, parsed) {
  const user = getUser(id);
  if (!user || !user.username) return;
  switch (parsed.type) {
    case 'music_share_playlist': return handleSharePlaylist(id, user, parsed);
    case 'music_select_song':    return handleSelectSong(id, user, parsed);
    case 'music_pause':          return handlePause(user);
    case 'music_resume':         return handleResume(user);
    case 'music_next':           return handleNext(user);
    case 'music_prev':           return handlePrev(user);
    case 'music_remove_song':    return handleRemoveSong(id, user, parsed);
    case 'music_reorder':        return handleReorderPlaylist(id, user, parsed);
    case 'music_resync':         return sendCurrentStateToUser(id);
  }
}

async function handleSharePlaylist(id, user, parsed) {
  if (!checkRateLimit(id)) return sendTo(id, { type: 'music_error', content: '操作太频繁' });
  const generation = ++MusicState.generation;
  try {
    const playlistId = await resolvePlaylistId(parsed.url);
    const playlist = await getPlaylistDetail(playlistId);
    if (generation !== MusicState.generation) return;
    clearAllTimers();
    MusicState.playlist = playlist;
    MusicState.currentSong = null;
    MusicState.playbackState = 'stopped';
    MusicState.sharedBy = id;
    MusicState.sharedByUsername = user.username;
    broadcastToAll({ type: 'music_playlist_data', playlist, sharedBy: user.username });
  } catch (err) {
    sendTo(id, { type: 'music_error', content: err.message });
  }
}

async function handleSelectSong(id, user, parsed) {
  if (!MusicState.playlist) return sendTo(id, { type: 'music_error', content: '当前没有歌单' });
  const song = MusicState.playlist.songs.find(s => s.id === parsed.songId);
  if (!song) return sendTo(id, { type: 'music_error', content: '未找到该歌曲' });
  await startSong(song);
}

function handlePause(user) {
  if (MusicState.playbackState !== 'playing') return;
  MusicState.playbackState = 'paused';
  MusicState.elapsed = Date.now() - MusicState.startTime;
  stopSyncInterval();
  if (MusicState.nextTimer) clearTimeout(MusicState.nextTimer);
  broadcastToAll({ type: 'music_pause', elapsed: MusicState.elapsed });
}

function handleResume(user) {
  if (MusicState.playbackState !== 'paused') return;
  MusicState.playbackState = 'playing';
  MusicState.startTime = Date.now() - MusicState.elapsed;
  broadcastToAll({ type: 'music_resume', startTime: MusicState.startTime, elapsed: MusicState.elapsed });
  startSyncInterval();
  scheduleNextSong();
}

function handleNext(user) {
  if (!MusicState.currentSong || !MusicState.playlist) return;
  const songs = MusicState.playlist.songs;
  if (songs.length === 0) return;
  const idx = songs.findIndex(s => s.id === MusicState.currentSong.id);
  clearAllTimers();
  startSong(idx + 1 < songs.length ? songs[idx + 1] : songs[0]);
}

function handlePrev(user) {
  if (!MusicState.currentSong || !MusicState.playlist) return;
  const songs = MusicState.playlist.songs;
  if (songs.length === 0) return;
  const idx = songs.findIndex(s => s.id === MusicState.currentSong.id);
  clearAllTimers();
  startSong(idx > 0 ? songs[idx - 1] : songs[songs.length - 1]);
}

function handleRemoveSong(id, user, parsed) {
  if (!MusicState.playlist) return sendTo(id, { type: 'music_error', content: '当前没有歌单' });
  const songs = MusicState.playlist.songs;
  const idx = songs.findIndex(s => s.id === parsed.songId);
  if (idx === -1) return sendTo(id, { type: 'music_error', content: '未找到该歌曲' });

  const isCurrentSong = MusicState.currentSong?.id === parsed.songId;
  songs.splice(idx, 1);
  MusicState.playlist.songCount = songs.length;

  if (isCurrentSong) clearAllTimers();

  // 先广播列表更新，再处理播放状态变化
  broadcastToAll({ type: 'music_playlist_update', playlist: MusicState.playlist });

  if (songs.length === 0) {
    clearAllTimers();
    MusicState.generation++;
    MusicState.playbackState = 'stopped';
    MusicState.currentSong = null;
    MusicState.currentProxyUrl = null;
    MusicState.playlist = null;
    broadcastToAll({ type: 'music_playlist_end' });
    return;
  }

  if (isCurrentSong) {
    if (songs.length > 0) {
      const nextIdx = Math.min(idx, songs.length - 1);
      startSong(songs[nextIdx]);
    } else {
      MusicState.playbackState = 'stopped';
      MusicState.currentSong = null;
      MusicState.currentProxyUrl = null;
      MusicState.playlist = null;
      broadcastToAll({ type: 'music_playlist_end' });
    }
  }
}

/* ====== 新连接同步 ====== */
function sendCurrentStateToUser(userId) {
  // 无歌单时也下发权威空状态，确保新连接不会显示上一会话的歌单
  if (!MusicState.playlist) {
    sendTo(userId, { type: 'music_state', playlist: null, currentSong: null, playbackState: 'stopped', sharedBy: null });
    return;
  }
  const state = {
    type: 'music_state',
    playlist: MusicState.playlist,
    currentSong: MusicState.currentSong,
    playbackState: MusicState.playbackState,
    sharedBy: MusicState.sharedByUsername,
  };
  if (MusicState.playbackState === 'playing') {
    state.startTime = MusicState.startTime;
    // 下发已播放毫秒数
    state.elapsed = Date.now() - MusicState.startTime;
    state.proxyUrl = MusicState.currentProxyUrl;
  } else if (MusicState.playbackState === 'paused') {
    state.elapsed = MusicState.elapsed;
    state.proxyUrl = MusicState.currentProxyUrl;
  }
  if (MusicState.currentSong) state.lyrics = MusicState.lyrics;
  sendTo(userId, state);
}

function shutdownMusic() {
  MusicState.generation++;
  clearAllTimers();
  MusicState.playlist = null;
  MusicState.currentSong = null;
  MusicState.playbackState = 'stopped';
  MusicState.startTime = 0;
  MusicState.elapsed = 0;
  MusicState.sharedBy = null;
  MusicState.sharedByUsername = null;
  MusicState.currentProxyUrl = null;
  MusicState.lyrics = null;
  rateLimitMap.clear();
}

module.exports = { handleMusicMessage, sendCurrentStateToUser, shutdownMusic, MusicState };
