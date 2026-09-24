/** 网易云音乐 API 客户端 */
const { config } = require('../config');

const NETEASE_BASE = 'https://music.163.com';
const ALLOWED_HOSTS = ['music.163.com', 'music.126.net'];
const API_HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function extractPlaylistId(url) {
  if (typeof url !== 'string' || url.length > 500) throw new Error('无效的链接');
  const match = url.match(/playlist(?:\/|.*?id=)(\d+)/i);
  if (!match) throw new Error('无法识别歌单链接，请使用网易云音乐歌单链接');
  return match[1];
}

async function resolvePlaylistId(url, fetchImpl = fetch) {
  if (typeof url !== 'string' || url.length > 500) throw new Error('无效的链接');
  let shortUrl;
  try {
    shortUrl = new URL(url.trim());
  } catch {
    return extractPlaylistId(url);
  }
  if (shortUrl.hostname !== '163cn.tv') return extractPlaylistId(url);
  if (shortUrl.protocol !== 'https:' || shortUrl.port || shortUrl.username || shortUrl.password
    || !/^\/[A-Za-z0-9_-]{4,64}\/?$/.test(shortUrl.pathname)) {
    throw new Error('无法识别歌单链接，请使用网易云音乐歌单链接');
  }

  // 仅请求固定的网易云短链域名，不自动跟随跳转。
  shortUrl.search = '';
  shortUrl.hash = '';
  const response = await fetchImpl(shortUrl.toString(), {
    redirect: 'manual',
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  try {
    if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error('网易云短链接暂时无法解析');
    const target = new URL(response.headers.get('location'), shortUrl);
    if (target.protocol !== 'https:' || target.port || target.username || target.password
      || !['music.163.com', 'y.music.163.com'].includes(target.hostname)) {
      throw new Error('短链接没有跳转到网易云歌单');
    }
    return extractPlaylistId(target.toString());
  } finally {
    try { await response.body?.cancel(); } catch {}
  }
}

function cleanText(value, fallback = '', maxLength = 200) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) || fallback;
}

function normalizeCoverUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return '';
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !ALLOWED_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))) return '';
    url.protocol = 'https:';
    return url.toString().length <= 1000 ? url.toString() : '';
  } catch {
    return '';
  }
}

async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('上游响应过大');
  if (!response.body) throw new Error('上游响应为空');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { await response.body.cancel(); } catch {}
      throw new Error('上游响应过大');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...API_HEADERS, ...(options.headers || {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  if (!response.ok) throw new Error(`网易云音乐临时不可用 (${response.status})`);
  const text = await readTextLimited(response, config.upstreamJsonMaxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('网易云音乐返回了无效数据');
  }
}

async function getPlaylistDetail(playlistId) {
  if (!/^\d{1,20}$/.test(String(playlistId))) throw new Error('歌单 ID 无效');
  const json = await fetchJson(`${NETEASE_BASE}/api/v3/playlist/detail?id=${playlistId}`);
  if (json.code !== 200 || !json.playlist) throw new Error('歌单不存在或已设置为私有');

  const playlist = json.playlist;
  const songs = (Array.isArray(playlist.tracks) ? playlist.tracks : [])
    .slice(0, 100)
    .filter(song => Number.isSafeInteger(song.id) && song.id > 0)
    .map(song => ({
      id: song.id,
      name: cleanText(song.name, '未知歌曲'),
      artists: (Array.isArray(song.ar) ? song.ar : []).slice(0, 20).map(artist => ({
        id: Number.isSafeInteger(artist.id) ? artist.id : 0,
        name: cleanText(artist.name, '未知歌手'),
      })),
      album: {
        id: Number.isSafeInteger(song.al?.id) ? song.al.id : 0,
        name: cleanText(song.al?.name, '', 200),
        picUrl: normalizeCoverUrl(song.al?.picUrl),
      },
      duration: Number.isFinite(song.dt) ? Math.max(0, Math.min(song.dt, 24 * 60 * 60 * 1000)) : 0,
    }));

  return {
    id: Number.isSafeInteger(playlist.id) ? playlist.id : Number(playlistId),
    name: cleanText(playlist.name, '未知歌单'),
    coverImgUrl: normalizeCoverUrl(playlist.coverImgUrl),
    songCount: songs.length,
    songs,
  };
}

async function getSongUrl(songId, bitrate = 320000) {
  if (!Number.isSafeInteger(songId) || songId <= 0) throw new Error('歌曲 ID 无效');
  const json = await fetchJson(`${NETEASE_BASE}/api/song/enhance/player/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `ids=[${songId}]&br=${bitrate}`,
  });
  const audioUrl = json.data?.[0]?.url;
  if (!audioUrl) {
    if (bitrate >= 320000) return getSongUrl(songId, 192000);
    if (bitrate >= 192000) return getSongUrl(songId, 128000);
    return null;
  }
  if (!isAllowedAudioUrl(audioUrl)) throw new Error('网易云返回了不受信任的音频地址');
  return audioUrl;
}

async function getLyrics(songId) {
  if (!Number.isSafeInteger(songId) || songId <= 0) return null;
  let json;
  try {
    json = await fetchJson(`${NETEASE_BASE}/api/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1`);
  } catch {
    return null;
  }
  const raw = json.lrc?.lyric;
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return null;

  const lines = [];
  const lineRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
  let match;
  while ((match = lineRegex.exec(raw)) !== null && lines.length < 5000) {
    const min = Number(match[1]);
    const sec = Number(match[2]);
    const ms = Number(match[3].padEnd(3, '0'));
    const text = cleanText(match[4], '', 500);
    if (text) lines.push({ time: min * 60 + sec + ms / 1000, text });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.length > 0 ? lines : null;
}

function isAllowedAudioUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

module.exports = {
  extractPlaylistId,
  resolvePlaylistId,
  fetchJson,
  getLyrics,
  getPlaylistDetail,
  getSongUrl,
  isAllowedAudioUrl,
  normalizeCoverUrl,
  readTextLimited,
};
