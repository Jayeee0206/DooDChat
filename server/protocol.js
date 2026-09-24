const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_PATH_RE = /^\/uploads\/[A-Za-z0-9.-]+\.(png|jpe?g|gif|webp)$/;
const RESUME_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
// Unicode 格式字符（零宽空格、方向控制符等）不可见；昵称去掉它们后必须仍有可见内容
const INVISIBLE_FORMAT_RE = /\p{Cf}/gu;
const SIMPLE_TYPES = new Set([
  'join_voice',
  'leave_voice',
  'music_pause',
  'music_resume',
  'music_next',
  'music_prev',
  'music_resync',
]);

const WEATHER_VALUES = new Set(['rain', 'snow', 'stars', 'sakura']);
const REACTION_VALUES = new Set(['👍', '❤️', '😂', '😮', '😢', '👀']);

function fail(error) {
  return { ok: false, error };
}

function pass(value) {
  return { ok: true, value };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateSessionDescription(value, expectedType) {
  return isPlainObject(value)
    && value.type === expectedType
    && typeof value.sdp === 'string'
    && value.sdp.length > 0
    && value.sdp.length <= 48 * 1024;
}

function validateIceCandidate(value) {
  if (!isPlainObject(value) || typeof value.candidate !== 'string' || value.candidate.length > 8192) return false;
  if (value.sdpMid != null && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 256)) return false;
  if (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 256)) return false;
  if (value.usernameFragment != null && (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256)) return false;
  return true;
}

function validateClientMessage(input) {
  if (!isPlainObject(input) || typeof input.type !== 'string') return fail('消息格式无效');
  const type = input.type;

  if (SIMPLE_TYPES.has(type)) return pass({ type });

  switch (type) {
    case 'set_nickname': {
      if (typeof input.username !== 'string') return fail('昵称格式无效');
      const username = input.username.trim();
      if (!username || username.length > 20 || /[\u0000-\u001f\u007f]/.test(username)) return fail('昵称不合法（1-20 个字符）');
      if (!username.replace(INVISIBLE_FORMAT_RE, '').trim()) return fail('昵称不能只包含不可见字符');
      if (input.roomPassword != null && (typeof input.roomPassword !== 'string' || input.roomPassword.length > 256)) return fail('房间密码格式无效');
      if (input.resumeToken != null && (typeof input.resumeToken !== 'string' || !RESUME_TOKEN_RE.test(input.resumeToken))) return fail('会话恢复令牌无效');
      return pass({ type, username, roomPassword: input.roomPassword || '', resumeToken: input.resumeToken || null });
    }
    case 'message': {
      if (typeof input.content !== 'string') return fail('消息内容格式无效');
      const content = input.content.trim();
      if (!content || content.length > 500) return fail('消息长度必须为 1-500 个字符');
      const kind = input.kind == null ? 'text' : input.kind;
      if (kind !== 'text' && kind !== 'image') return fail('消息类型无效');
      if (kind === 'image' && !IMAGE_PATH_RE.test(content)) return fail('图片路径无效');
      if (input.replyTo != null && !isUuid(input.replyTo)) return fail('回复目标无效');
      return pass({ type, kind, content, replyTo: input.replyTo || null });
    }
    case 'message_reaction':
      if (!isUuid(input.messageId)) return fail('回应目标无效');
      if (typeof input.emoji !== 'string' || !REACTION_VALUES.has(input.emoji)) return fail('回应表情无效');
      return pass({ type, messageId: input.messageId, emoji: input.emoji });
    case 'message_recall':
      if (!isUuid(input.messageId)) return fail('撤回目标无效');
      return pass({ type, messageId: input.messageId });
    case 'typing':
      if (input.active != null && typeof input.active !== 'boolean') return fail('输入状态无效');
      return pass({ type, active: input.active !== false });
    case 'weather_change':
      if (typeof input.weather !== 'string' || !WEATHER_VALUES.has(input.weather)) return fail('天气类型无效');
      return pass({ type, weather: input.weather });
    case 'voice_offer':
      if (!isUuid(input.target) || !validateSessionDescription(input.sdp, 'offer')) return fail('语音 offer 无效');
      return pass({ type, target: input.target, sdp: input.sdp });
    case 'voice_answer':
      if (!isUuid(input.target) || !validateSessionDescription(input.sdp, 'answer')) return fail('语音 answer 无效');
      return pass({ type, target: input.target, sdp: input.sdp });
    case 'voice_ice':
      if (!isUuid(input.target) || !validateIceCandidate(input.candidate)) return fail('ICE candidate 无效');
      return pass({ type, target: input.target, candidate: input.candidate });
    case 'voice_mute':
      if (typeof input.muted !== 'boolean') return fail('静音状态无效');
      return pass({ type, muted: input.muted });
    case 'music_share_playlist':
      if (typeof input.url !== 'string' || input.url.length < 1 || input.url.length > 500) return fail('歌单链接无效');
      return pass({ type, url: input.url.trim() });
    case 'music_select_song':
    case 'music_remove_song':
      if (!isPositiveId(input.songId)) return fail('歌曲 ID 无效');
      return pass({ type, songId: input.songId });
    case 'music_reorder':
      if (!Array.isArray(input.order) || input.order.length > 100 || input.order.some(id => !isPositiveId(id))) return fail('歌曲顺序无效');
      if (new Set(input.order).size !== input.order.length) return fail('歌曲顺序存在重复项');
      return pass({ type, order: [...input.order] });
    default:
      return fail('未知消息类型');
  }
}

module.exports = {
  IMAGE_PATH_RE,
  REACTION_VALUES,
  RESUME_TOKEN_RE,
  WEATHER_VALUES,
  isPlainObject,
  validateClientMessage,
};
