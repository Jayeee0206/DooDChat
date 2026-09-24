const crypto = require('crypto');
const WebSocket = require('ws');
const {
  deleteResumeSession,
  findLiveUserByResumeToken,
  getAllUsers,
  getResumeSession,
  getUser,
  getUsersMap,
  isUsernameTaken,
  rebindUserId,
  setUsername,
} = require('./users');
const { isRoomPasswordValid } = require('../security');
const { config } = require('../config');
const { IMAGE_PATH_RE, REACTION_VALUES, WEATHER_VALUES } = require('../protocol');
const history = require('./history');

const DEFAULT_WEATHER = 'rain';
let roomWeather = DEFAULT_WEATHER;

function getRoomWeather() {
  return roomWeather;
}

function resetRoomFeatures() {
  roomWeather = DEFAULT_WEATHER;
}

function replySnapshot(message) {
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    username: message.username,
    kind: message.kind,
    content: message.kind === 'image' ? '[图片]' : String(message.content).slice(0, 160),
  };
}

function reactionSnapshot(message) {
  const result = {};
  for (const emoji of REACTION_VALUES) {
    const actors = message.reactions?.[emoji];
    if (Array.isArray(actors) && actors.length) {
      result[emoji] = actors.map(actor => ({ userId: actor.userId, username: actor.username }));
    }
  }
  return result;
}

function broadcast(data, excludeId = null) {
  const message = JSON.stringify(data);
  for (const [id, user] of getUsersMap()) {
    if (id !== excludeId && user.authenticated && user.ws.readyState === WebSocket.OPEN) user.ws.send(message);
  }
}

function sendTo(id, data) {
  const user = getUser(id);
  if (user && user.ws.readyState === WebSocket.OPEN) user.ws.send(JSON.stringify(data));
}

function handleMessage(ws, id, parsed) {
  const user = getUser(id);
  if (!user) return { accepted: false };

  switch (parsed.type) {
    case 'set_nickname': {
      if (user.authenticated) return { accepted: true, authenticated: true, justAuthenticated: false };
      if (!isRoomPasswordValid(parsed.roomPassword)) {
        sendTo(id, { type: 'error', code: 'ROOM_PASSWORD_INVALID', content: '房间密码错误' });
        return { accepted: false, authenticated: false };
      }

      // 会话恢复：密码已通过、令牌有效且昵称一致时，复用上一连接的 id，
      // 让重连后的消息归属、回应高亮和撤回权限延续。令牌不能绕过密码、昵称占用和人数上限。
      const resume = resolveResumeSession(id, parsed);

      if (isUsernameTaken(parsed.username, id, resume?.live?.id ?? null)) {
        sendTo(id, { type: 'error', code: 'USERNAME_TAKEN', content: '昵称已被使用' });
        return { accepted: false, authenticated: false };
      }
      if (getAllUsers().length - (resume?.live ? 1 : 0) >= config.maxAuthenticatedUsers) {
        sendTo(id, { type: 'error', code: 'ROOM_FULL', content: '房间人数已满' });
        return { accepted: false, authenticated: false };
      }

      let effectiveId = id;
      let announceJoin = true;
      if (resume) {
        if (resume.live) {
          // 旧连接尚未被心跳判死：静默移除并终止，其 close 事件不会再影响新连接
          require('./connection').handleDisconnect(resume.live.id, { silent: true });
          try { resume.live.ws.terminate(); } catch {}
          announceJoin = false;
        }
        if (rebindUserId(id, resume.id)) effectiveId = resume.id;
        if (resume.fromSession) deleteResumeSession(parsed.resumeToken);
      }

      setUsername(effectiveId, parsed.username);
      user.uploadToken = crypto.randomUUID();
      user.resumeToken = crypto.randomBytes(24).toString('base64url');
      sendTo(effectiveId, {
        type: 'welcome',
        id: effectiveId,
        username: parsed.username,
        uploadToken: user.uploadToken,
        resumeToken: user.resumeToken,
        resumed: effectiveId !== id,
      });
      sendTo(effectiveId, { type: 'weather_state', weather: roomWeather, username: null });
      sendTo(effectiveId, { type: 'history', messages: history.getRecent(10) });

      if (announceJoin) {
        const systemMessage = { type: 'system', content: `${parsed.username} 加入了聊天室`, timestamp: Date.now() };
        history.add(systemMessage);
        broadcast(systemMessage);
      }
      broadcast({ type: 'user_list', users: getAllUsers() });
      return {
        accepted: true,
        authenticated: true,
        justAuthenticated: true,
        resumedId: effectiveId !== id ? effectiveId : null,
      };
    }

    case 'message': {
      if (!user.authenticated || !user.username) return { accepted: false };
      let kind = parsed.kind || 'text';
      let content = parsed.content;

      if (kind === 'image') {
        if (!IMAGE_PATH_RE.test(content)) return { accepted: false };
      } else if (content.startsWith('<img ')) {
        const match = content.match(/src="([^"]+)"/);
        if (!match || !IMAGE_PATH_RE.test(match[1])) return { accepted: false };
        kind = 'image';
        content = match[1];
      }

      const kaomoji = {
        '/shrug': '¯\\_(ツ)_/¯',
        '/tableflip': '(╯°□°）╯︵ ┻━┻',
        '/unflip': '┬─┬ノ( º _ ºノ)',
      };
      if (kind === 'text') content = kaomoji[content.toLocaleLowerCase('en-US')] || content;

      if (user.typingActive) {
        user.typingActive = false;
        broadcast({ type: 'typing', userId: id, username: user.username, active: false, timestamp: Date.now() }, id);
      }

      if (kind === 'text' && content.startsWith('/') && !Object.values(kaomoji).includes(content)) {
        const commandMessage = handleCommand(user.username, content);
        if (commandMessage) {
          history.add(commandMessage);
          broadcast(commandMessage);
          return { accepted: true };
        }
      }

      let replyTo = null;
      if (parsed.replyTo) {
        const target = history.findMessageById(parsed.replyTo);
        if (!target || target.recalled) {
          sendTo(id, { type: 'error', code: 'REPLY_TARGET_MISSING', content: '要回复的消息已经不在当前房间记录中' });
          return { accepted: false };
        }
        replyTo = replySnapshot(target);
      }

      const message = {
        type: 'message',
        messageId: crypto.randomUUID(),
        kind,
        senderId: id,
        username: user.username,
        content,
        replyTo,
        reactions: {},
        timestamp: Date.now(),
      };
      history.add(message);
      broadcast(message);
      return { accepted: true };
    }

    case 'message_reaction': {
      if (!user.authenticated || !user.username || !REACTION_VALUES.has(parsed.emoji)) return { accepted: false };
      const target = history.findMessageById(parsed.messageId);
      if (!target || target.recalled) {
        sendTo(id, { type: 'error', code: 'REACTION_TARGET_MISSING', content: '要回应的消息已经不在当前房间记录中' });
        return { accepted: false };
      }
      const now = Date.now();
      if (user.reactionLastAt && now - user.reactionLastAt < 300) return { accepted: true, throttled: true };
      user.reactionLastAt = now;
      if (!target.reactions || typeof target.reactions !== 'object') target.reactions = {};
      const actors = Array.isArray(target.reactions[parsed.emoji]) ? target.reactions[parsed.emoji] : [];
      const existingIndex = actors.findIndex(actor => actor.userId === id);
      let active;
      if (existingIndex >= 0) {
        actors.splice(existingIndex, 1);
        active = false;
      } else {
        actors.push({ userId: id, username: user.username });
        active = true;
      }
      if (actors.length) target.reactions[parsed.emoji] = actors;
      else delete target.reactions[parsed.emoji];
      const state = reactionSnapshot(target);
      broadcast({
        type: 'reaction_state',
        messageId: target.messageId,
        reactions: state,
        changedBy: id,
        active,
        timestamp: now,
      });
      return { accepted: true, active };
    }

    case 'message_recall': {
      if (!user.authenticated || !user.username) return { accepted: false };
      const target = history.findMessageById(parsed.messageId);
      if (!target || target.recalled) {
        sendTo(id, { type: 'error', code: 'RECALL_TARGET_MISSING', content: '要撤回的消息已经不在当前房间记录中' });
        return { accepted: false };
      }
      if (target.senderId !== id) {
        sendTo(id, { type: 'error', code: 'RECALL_NOT_OWNER', content: '只能撤回自己发送的消息' });
        return { accepted: false };
      }
      const now = Date.now();
      if (config.recallWindowMs > 0 && now - target.timestamp > config.recallWindowMs) {
        sendTo(id, { type: 'error', code: 'RECALL_WINDOW_EXPIRED', content: '已经超过可撤回的时间' });
        return { accepted: false };
      }
      if (user.recallLastAt && now - user.recallLastAt < 300) return { accepted: true, throttled: true };
      user.recallLastAt = now;

      // 服务端权威地把内存历史改为墓碑：内容立即清空，
      // 新加入用户同步时只会看到“已撤回”占位，拿不到原文。
      const recalledUploadUrl = target.kind === 'image' && IMAGE_PATH_RE.test(target.content) ? target.content : null;
      target.recalled = true;
      target.recalledBy = id;
      target.recalledAt = now;
      target.content = '';
      target.reactions = {};
      broadcast({
        type: 'message_recalled',
        messageId: target.messageId,
        recalledBy: id,
        username: user.username,
        timestamp: now,
      });
      return { accepted: true, recalledUploadUrl };
    }

    case 'typing': {
      if (!user.authenticated || !user.username) return { accepted: false };
      const active = parsed.active !== false;
      const now = Date.now();
      if (!active) {
        if (user.typingActive) {
          user.typingActive = false;
          broadcast({ type: 'typing', userId: id, username: user.username, active: false, timestamp: now }, id);
        }
        return { accepted: true };
      }
      if (user.typingLastAt && now - user.typingLastAt < 2000) return { accepted: true, throttled: true };
      user.typingLastAt = now;
      user.typingActive = true;
      broadcast({ type: 'typing', userId: id, username: user.username, active: true, timestamp: now }, id);
      return { accepted: true };
    }

    case 'weather_change': {
      if (!user.authenticated || !user.username || !WEATHER_VALUES.has(parsed.weather)) return { accepted: false };
      const now = Date.now();
      if (user.weatherLastAt && now - user.weatherLastAt < 3000) return { accepted: true, throttled: true };
      user.weatherLastAt = now;
      roomWeather = parsed.weather;
      broadcast({
        type: 'weather_state',
        weather: roomWeather,
        senderId: id,
        username: user.username,
        timestamp: now,
      });
      return { accepted: true };
    }

    default:
      return { accepted: false };
  }
}

// 根据恢复令牌找到可复用的身份：优先使用断线后保留的会话，其次是尚未被心跳清理的在线旧连接。
// 昵称必须与上一连接完全一致，否则视为普通新登录。
function resolveResumeSession(currentId, parsed) {
  if (!parsed.resumeToken) return null;
  const session = getResumeSession(parsed.resumeToken);
  if (session) {
    return session.username === parsed.username ? { id: session.id, fromSession: true, live: null } : null;
  }
  const live = findLiveUserByResumeToken(parsed.resumeToken);
  if (live && live.id !== currentId && live.username === parsed.username) {
    return { id: live.id, fromSession: false, live };
  }
  return null;
}

function handleCommand(username, text) {
  const system = content => ({ type: 'system', content, timestamp: Date.now() });
  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === '/roll') {
    let max = Number.parseInt(parts[1], 10);
    if (!Number.isSafeInteger(max) || max < 2 || max > 1_000_000) max = 100;
    return system(`🎲 ${username} 掷出了 ${1 + Math.floor(Math.random() * max)} 点（1-${max}）`);
  }
  if (command === '/coin') return system(`🪙 ${username} 抛出了硬币：${Math.random() < 0.5 ? '正面' : '反面'}`);
  if (command === '/pick') {
    const options = parts.slice(1).filter(Boolean).slice(0, 50);
    if (options.length < 2) return system('🤔 用法：/pick 选项1 选项2 ...（至少两个选项）');
    const chosen = options[Math.floor(Math.random() * options.length)];
    return system(`🎯 ${username} 发起抉择（${options.join(' / ')}）→ 命运选择了「${chosen}」`);
  }
  if (command === '/help') return system('可用指令：/roll [上限] 掷骰子 · /coin 抛硬币 · /pick A B C 随机抉择 · /shrug 耸肩 · /tableflip 掀桌 · /unflip 扶桌');
  return null;
}

module.exports = {
  broadcast,
  getRoomWeather,
  handleCommand,
  handleMessage,
  resetRoomFeatures,
  sendTo,
};
