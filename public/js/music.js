/* ====== 音乐播放器模块 ====== */
/* 同步策略：收到 startTime，缓冲完成后 seek 到正确位置 */

const MusicState = {
  playlist: null,
  currentSong: null,
  playbackState: 'stopped',
  startTime: 0,
  elapsed: 0,
  sharedBy: '',
  volume: 0.1,
  lyrics: null,

  // 内部
  audio: null,
  progressTimer: null,
};

/* ====== DOM 引用 ====== */
let _dom = {};
function initDom() {
  const $ = (id) => document.getElementById(id);
  _dom = {
    urlInput: $('music-url-input'),
    shareBtn: $('music-share-btn'),
    nowPlaying: $('music-now-playing'),
    songList: $('music-song-list'),
    songItems: $('music-song-items'),
    emptyState: $('music-empty-state'),
    cover: $('music-cover'),
    songName: $('music-song-name'),
    artist: $('music-artist'),
    progressFill: $('music-progress-fill'),
    timeCurrent: $('music-time-current'),
    timeTotal: $('music-time-total'),
    playPauseBtn: $('music-play-pause-btn'),
    prevBtn: $('music-prev-btn'),
    nextBtn: $('music-next-btn'),
    volumeSlider: $('music-volume-slider'),
  };
}

/* ====== 工具 ====== */
function formatDuration(ms) {
  if (!ms || ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ====== 音频引擎 ====== */
function initAudio() {
  if (MusicState.audio) return;
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.volume = MusicState.volume;
  audio.preload = 'auto';
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('error', () => {
    const err = audio.error;
    if (!MusicState.currentSong || !audio.getAttribute('src')) return;
    if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) return;
    const msg = err.code === MediaError.MEDIA_ERR_NETWORK ? '网络错误，音频加载失败'
      : err.code === MediaError.MEDIA_ERR_DECODE ? '音频解码失败'
        : err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? '音频链接已失效或格式不支持'
          : '音频加载失败';
    showMsg(msg);
  });
  MusicState.audio = audio;
}

let _playId = 0;

/** 加载音频并在缓冲足够后 seek 到目标位置播放 */
function playSongFrom(proxyUrl, startTime) {
  initAudio();
  const audio = MusicState.audio;
  const playId = ++_playId;

  // 清理上一次 playSongFrom 的残留
  if (MusicState._playTimeout) { clearTimeout(MusicState._playTimeout); MusicState._playTimeout = null; }
  if (MusicState._canplayHandler) { audio.removeEventListener('canplaythrough', MusicState._canplayHandler); MusicState._canplayHandler = null; }

  if (audio.src !== proxyUrl) audio.src = proxyUrl;

  const doPlay = () => {
    if (playId !== _playId) return;
    // 无论从哪条路径进来，都先清掉另一条路径的触发器，防止 8 秒后重复 seek
    if (MusicState._playTimeout) { clearTimeout(MusicState._playTimeout); }
    if (MusicState._canplayHandler) { audio.removeEventListener('canplaythrough', MusicState._canplayHandler); }
    MusicState._playTimeout = null;
    MusicState._canplayHandler = null;
    const elapsed = Math.max(0, (Date.now() - startTime) / 1000);
    audio.currentTime = elapsed;
    audio.play().catch(() => { });
    MusicState.startTime = startTime;
    MusicState.playbackState = 'playing';
    startProgressTimer();
    updatePlayPauseBtn();
  };

  // 等缓冲足够播完全曲再开始（减少卡顿杂音）
  MusicState._canplayHandler = doPlay;
  audio.addEventListener('canplaythrough', doPlay, { once: true });
  // 保底：8 秒后无论如何强制开始
  MusicState._playTimeout = setTimeout(doPlay, 8000);
}

/* ====== 播放控制 ====== */
function pausePlayback(elapsed) {
  // 取消 playSongFrom 的 pending 超时/事件，防止自动恢复播放
  if (MusicState._playTimeout) { clearTimeout(MusicState._playTimeout); MusicState._playTimeout = null; }
  if (MusicState._canplayHandler && MusicState.audio) { MusicState.audio.removeEventListener('canplaythrough', MusicState._canplayHandler); MusicState._canplayHandler = null; }
  _playId++;

  if (MusicState.audio) MusicState.audio.pause();
  MusicState.playbackState = 'paused';
  MusicState.elapsed = elapsed;
  updatePlayPauseBtn();
  stopProgressTimer();
}

function resumePlayback(startTime) {
  if (!MusicState.audio) return;
  const audio = MusicState.audio;
  MusicState.playbackState = 'playing';
  const elapsed = Math.max(0, (Date.now() - startTime) / 1000);

  // 绑定代次；期间再次暂停或停止会使 _playId 前进，保底定时器失效
  const resumeId = ++_playId;
  let resumed = false;
  const doResume = () => {
    if (resumed || resumeId !== _playId) return;
    resumed = true;
    audio.removeEventListener('seeked', doResume);
    audio.play().catch(() => { });
    MusicState.startTime = startTime;
    startProgressTimer();
    updatePlayPauseBtn();
  };

  audio.addEventListener('seeked', doResume, { once: true });
  audio.currentTime = elapsed;
  // 保底：3s 后没完成 seek 也强制播（doResume 内部校验代次）
  setTimeout(doResume, 3000);
}

function stopPlayback() {
  if (MusicState._playTimeout) { clearTimeout(MusicState._playTimeout); MusicState._playTimeout = null; }
  if (MusicState._canplayHandler && MusicState.audio) { MusicState.audio.removeEventListener('canplaythrough', MusicState._canplayHandler); MusicState._canplayHandler = null; }
  _playId++;

  MusicState.playbackState = 'stopped';
  MusicState.currentSong = null;
  if (MusicState.audio) {
    MusicState.audio.pause();
    MusicState.audio.removeAttribute('src');
    MusicState.audio.load();
  }
  MusicState.startTime = 0;
  stopProgressTimer();
  updateNowPlaying();
  updatePlayPauseBtn();
  clearLyrics();
}

/** 漂移校正 */
function syncPlayback(elapsed) {
  const audio = MusicState.audio;
  if (!audio || MusicState.playbackState !== 'playing') return;
  const drift = audio.currentTime * 1000 - elapsed;
  if (Math.abs(drift) > 1000) {
    audio.currentTime = elapsed / 1000;
  }
}

/* ====== 进度 ====== */
function startProgressTimer() {
  stopProgressTimer();
  MusicState.progressTimer = setInterval(updateProgress, 250);
}
function stopProgressTimer() {
  if (MusicState.progressTimer) { clearInterval(MusicState.progressTimer); MusicState.progressTimer = null; }
}

function updateProgress() {
  const audio = MusicState.audio;
  if (!audio || !MusicState.currentSong) {
    _dom.progressFill.style.width = '0%';
    _dom.timeCurrent.textContent = '00:00';
    return;
  }
  const cur = audio.currentTime || 0;
  const total = (MusicState.currentSong.duration || 0) / 1000;
  _dom.progressFill.style.width = `${total > 0 ? Math.min(100, cur / total * 100) : 0}%`;
  _dom.timeCurrent.textContent = formatDuration(cur * 1000);
  _dom.timeTotal.textContent = formatDuration(MusicState.currentSong.duration);
  syncLyrics(cur); // 同步歌词
}

/* ====== UI ====== */
function updateNowPlaying() {
  if (!MusicState.currentSong) {
    _dom.nowPlaying.style.display = 'none';
    _dom.cover.classList.remove('playing');
    window.DooDPolish?.clearCoverAccent();
    return;
  }
  _dom.nowPlaying.style.display = 'block';
  const song = MusicState.currentSong;
  const coverUrl = song.album?.picUrl || '';
  _dom.cover.src = coverUrl;
  _dom.cover.alt = song.album?.name || '封面';
  _dom.songName.textContent = song.name || '';
  _dom.artist.textContent = (song.artists || []).map(artist => artist.name).join(' / ');
  window.DooDPolish?.setCoverAccent(coverUrl);
}

function updatePlayPauseBtn() {
  const isPlaying = MusicState.playbackState === 'playing';
  _dom.cover?.classList.toggle('playing', isPlaying);
  _dom.playPauseBtn.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
  _dom.playPauseBtn.innerHTML = isPlaying
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

var _dragId = null;

function renderPlaylist(playlist) {
  if (!playlist || !playlist.songs || !playlist.songs.length) {
    _dom.emptyState.style.display = 'block';
    _dom.songList.style.display = 'none';
    return;
  }
  _dom.emptyState.style.display = 'none';
  _dom.songList.style.display = 'block';
  _dom.songItems.innerHTML = '';
  for (const song of playlist.songs) {
    const item = document.createElement('div');
    item.className = 'music-song-item';
    item.dataset.songId = song.id;
    item.draggable = true;
    if (song.unavailable) item.title = '暂不可播放，点击可重试';
    item.innerHTML = `
      <span class="music-song-idx">${song.unavailable ? '⚠' : ''}</span>
      <span class="music-song-name-col">${escapeHtml(song.name)}</span>
      <span class="music-song-artist-col">${escapeHtml((song.artists || []).map(a => a.name).join(' / '))}</span>
      <span class="music-song-dur-col">${formatDuration(song.duration)}</span>
      <button class="music-song-del" aria-label="移除" data-song-id="${song.id}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    // 拖拽事件
    item.addEventListener('dragstart', function(e) {
      _dragId = this.dataset.songId;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      document.querySelectorAll('.music-song-item').forEach(function(el) { el.classList.remove('drag-over'); });
    });
    item.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    item.addEventListener('dragenter', function(e) {
      e.preventDefault();
      if (this.dataset.songId !== _dragId) this.classList.add('drag-over');
    });
    item.addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });
    item.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('drag-over');
      if (!_dragId || this.dataset.songId === _dragId) return;
      var parent = _dom.songItems;
      var items = parent.querySelectorAll('.music-song-item');
      var fromEl, toEl = this;
      for (var i = 0; i < items.length; i++) {
        if (items[i].dataset.songId === _dragId) fromEl = items[i];
      }
      if (!fromEl || fromEl === toEl) return;
      // 放到目标项上方；拖到紧邻下一项也生效
      parent.insertBefore(fromEl, toEl);
      // 发送新顺序到服务端
      var newOrder = parent.querySelectorAll('.music-song-item');
      var orderIds = [];
      for (var k = 0; k < newOrder.length; k++) {
        orderIds.push(parseInt(newOrder[k].dataset.songId));
      }
      sendWs({ type: 'music_reorder', order: orderIds });
    });

    item.addEventListener('click', (e) => {
      if (e.target.closest('.music-song-del')) return;
      sendWs({ type: 'music_select_song', songId: song.id });
    });
    item.querySelector('.music-song-del').addEventListener('click', (e) => {
      e.stopPropagation();
      sendWs({ type: 'music_remove_song', songId: song.id });
    });
    _dom.songItems.appendChild(item);
  }
}

function highlightCurrentSong() {
  for (const item of _dom.songItems.querySelectorAll('.music-song-item')) {
    item.classList.toggle('active', MusicState.currentSong?.id === parseInt(item.dataset.songId));
  }
}

/* ====== WebSocket 消息处理 ====== */
function handleMusicSignal(parsed) {
  initDom();
  initAudio();

  switch (parsed.type) {
    case 'music_state':
      handleMusicState(parsed);
      break;
    case 'music_playlist_data':
      handlePlaylistData(parsed);
      break;
    case 'music_song_start':
      handleSongStart(parsed);
      break;
    case 'music_song_loaded':
      handleSongLoaded(parsed);
      break;
    case 'music_pause':
      pausePlayback(parsed.elapsed);
      break;
    case 'music_resume':
      resumePlayback(parsed.elapsed != null ? Date.now() - parsed.elapsed : parsed.startTime);
      break;
    case 'music_sync':
      syncPlayback(parsed.elapsed);
      break;
    case 'music_playlist_end':
      handlePlaylistEnd();
      break;
    case 'music_playlist_update':
      handlePlaylistUpdate(parsed);
      break;
    case 'music_lyrics_update':
      // 歌词后置补发，仅当前歌曲应用
      if (MusicState.currentSong && MusicState.currentSong.id === parsed.songId) setLyrics(parsed.lyrics || null);
      break;
    case 'music_error':
      showMsg(parsed.content);
      break;
  }
}

function handleMusicState(parsed) {
  MusicState.playlist = parsed.playlist;
  MusicState.currentSong = parsed.currentSong;
  MusicState.playbackState = parsed.playbackState;
  MusicState.sharedBy = parsed.sharedBy || '';
  if (parsed.playlist) {
    renderPlaylist(parsed.playlist);
  } else {
    // 服务端状态为“无歌单”时清空本地缓存与列表
    try { localStorage.removeItem('dood_music_state'); } catch (e) {}
    stopPlayback();
    if (_dom.emptyState) _dom.emptyState.style.display = 'block';
    if (_dom.songList) _dom.songList.style.display = 'none';
    if (_dom.songItems) _dom.songItems.innerHTML = '';
  }

  if (parsed.currentSong) setLyrics(parsed.lyrics || null);

  if (parsed.playbackState === 'playing' && parsed.currentSong && parsed.proxyUrl) {
    MusicState.currentSong = parsed.currentSong;
    updateNowPlaying();
    playSongFrom(parsed.proxyUrl, parsed.elapsed != null ? Date.now() - parsed.elapsed : parsed.startTime);
  } else if (parsed.playbackState === 'paused' && parsed.currentSong) {
    MusicState.currentSong = parsed.currentSong;
    MusicState.elapsed = parsed.elapsed || 0;
    updateNowPlaying();
    updatePlayPauseBtn();
    if (parsed.proxyUrl) {
      // 预加载音频
      initAudio();
      MusicState.audio.src = parsed.proxyUrl;
    }
  } else if (parsed.playlist && parsed.playbackState === 'stopped') {
    stopPlayback();
  }
}

function handlePlaylistData(parsed) {
  MusicState.playlist = parsed.playlist;
  MusicState.sharedBy = parsed.sharedBy || '';
  MusicState.currentSong = null;
  stopPlayback();
  renderPlaylist(parsed.playlist);
  showMsg(`${parsed.sharedBy} 分享了歌单「${parsed.playlist.name}」`);
}

function handleSongStart(parsed) {
  MusicState.currentSong = parsed.song;
  updateNowPlaying();
  highlightCurrentSong();
  setLyrics(parsed.lyrics || null);
  // 优先用 elapsed 换算本地时钟基准，消除两端时钟偏差
  const base = parsed.elapsed != null ? Date.now() - parsed.elapsed : parsed.startTime;
  playSongFrom(parsed.proxyUrl, base);
}

function handleSongLoaded(parsed) {
  // 暂停期间切歌：更新歌曲信息并预加载，保持暂停状态
  MusicState.currentSong = parsed.song;
  updateNowPlaying();
  highlightCurrentSong();
  setLyrics(parsed.lyrics || null);
  if (parsed.proxyUrl) {
    initAudio();
    MusicState.audio.src = parsed.proxyUrl;
  }
}

function handlePlaylistEnd() {
  MusicState.currentSong = null;
  MusicState.playlist = null;
  MusicState.playbackState = 'stopped';
  // 播完清掉本地缓存，防止刷新后旧歌单重新出现
  try { localStorage.removeItem('dood_music_state'); } catch (e) {}
  stopPlayback();
  updateNowPlaying();
  updatePlayPauseBtn();
  // 清空歌曲列表 UI
  _dom.emptyState.style.display = 'block';
  _dom.songList.style.display = 'none';
  _dom.songItems.innerHTML = '';
  showMsg('歌单已全部播放完毕');
}

function handlePlaylistUpdate(parsed) {
  MusicState.playlist = parsed.playlist;
  // 先重建列表 DOM，再给当前歌曲加高亮
  renderPlaylist(parsed.playlist);
  highlightCurrentSong();
}

/* ====== 临时状态 ====== */

function showMsg(content) {
  if (typeof renderSystemMessage === 'function') renderSystemMessage(`🎵 ${content}`);
}

/* ====== KTV 歌词：按当前句时间逐字扫光 ====== */
var _lyricsDisplay;
var KtvState = { index: -9, fill: -1, lineElement: null };

function initLyrics() {
  _lyricsDisplay = document.getElementById('lyrics-display');
}

function resetKtvState() {
  KtvState.index = -9;
  KtvState.fill = -1;
  KtvState.lineElement = null;
}

function setLyrics(lines) {
  MusicState.lyrics = Array.isArray(lines) && lines.length ? lines : null;
  if (!_lyricsDisplay) initLyrics();
  resetKtvState();
  _lyricsDisplay.replaceChildren();
  _lyricsDisplay.style.display = MusicState.lyrics ? '' : 'none';
}

function clearLyrics() {
  MusicState.lyrics = null;
  resetKtvState();
  if (_lyricsDisplay) {
    _lyricsDisplay.replaceChildren();
    _lyricsDisplay.style.display = 'none';
  }
}

function syncLyrics(currentTime) {
  const lines = MusicState.lyrics;
  if (!lines?.length || !_lyricsDisplay) return;
  if (_lyricsDisplay.style.display === 'none') _lyricsDisplay.style.display = '';
  let index = -1;
  for (let cursor = lines.length - 1; cursor >= 0; cursor -= 1) {
    if (currentTime >= lines[cursor].time) {
      index = cursor;
      break;
    }
  }

  const visibleIndex = index >= 0 ? index : 0;
  const stateIndex = index >= 0 ? index : -9;
  if (stateIndex !== KtvState.index || !KtvState.lineElement) {
    KtvState.index = stateIndex;
    KtvState.fill = -1;
    const line = document.createElement('span');
    line.className = 'lyric-fill';
    line.textContent = lines[visibleIndex].text || '♪';
    line.style.setProperty('--fill', '0%');
    _lyricsDisplay.replaceChildren(line);
    KtvState.lineElement = line;
  }
  if (index < 0) return;
  const start = lines[index].time;
  const end = index + 1 < lines.length ? lines[index + 1].time : start + 4;
  const progress = end > start ? Math.min(1, Math.max(0, (currentTime - start) / (end - start))) : 1;
  const rounded = Math.round(progress * 100);
  if (rounded !== KtvState.fill) {
    KtvState.fill = rounded;
    KtvState.lineElement.style.setProperty('--fill', `${rounded}%`);
  }
}

/* ====== 初始化 ====== */
function initMusic() {
  initDom();
  initLyrics();
  try { localStorage.removeItem('dood_music_state'); } catch (e) {}
  if (!_dom.urlInput) return;

  _dom.shareBtn.addEventListener('click', () => {
    const url = _dom.urlInput.value.trim();
    if (!url) return;
    sendWs({ type: 'music_share_playlist', url });
    _dom.urlInput.value = '';
  });
  _dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _dom.shareBtn.click();
  });

  _dom.playPauseBtn.addEventListener('click', () => {
    if (MusicState.playbackState === 'playing') sendWs({ type: 'music_pause' });
    else if (MusicState.playbackState === 'paused') sendWs({ type: 'music_resume' });
  });
  _dom.nextBtn.addEventListener('click', () => sendWs({ type: 'music_next' }));
  _dom.prevBtn.addEventListener('click', () => sendWs({ type: 'music_prev' }));

  // 音量记忆
  const savedVol = parseFloat(localStorage.getItem('dood_music_volume'));
  if (savedVol >= 0 && savedVol <= 1) {
    MusicState.volume = savedVol;
    _dom.volumeSlider.value = savedVol;
  }
  _dom.volumeSlider.addEventListener('input', (e) => {
    MusicState.volume = parseFloat(e.target.value);
    if (MusicState.audio) MusicState.audio.volume = MusicState.volume;
    localStorage.setItem('dood_music_volume', MusicState.volume);
  });

  _dom.volumeSlider.value = MusicState.volume;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMusic);
} else {
  initMusic();
}
