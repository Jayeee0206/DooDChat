const WebSocket = require('ws');
const { getUsersMap, getUser } = require('./users');
const { sendCurrentStateToUser } = require('./music');
const { config } = require('../config');

const voiceUsers = new Set();

function getVoiceUsers() {
  return voiceUsers;
}

function getVoiceUserList() {
  const users = getUsersMap();
  const list = [];
  for (const id of voiceUsers) {
    const user = users.get(id);
    if (user?.authenticated && user.username) list.push({ id, username: user.username });
  }
  return list;
}

function addToVoice(id) {
  voiceUsers.add(id);
}

function removeFromVoice(id) {
  voiceUsers.delete(id);
}

function sendTo(id, data) {
  const user = getUser(id);
  if (user?.authenticated && user.ws.readyState === WebSocket.OPEN) user.ws.send(JSON.stringify(data));
}

function broadcastToVoice(data, excludeId = null) {
  const message = JSON.stringify(data);
  for (const id of voiceUsers) {
    if (id === excludeId) continue;
    const user = getUser(id);
    if (user?.authenticated && user.ws.readyState === WebSocket.OPEN) user.ws.send(message);
  }
}

function handleVoiceMessage(ws, id, parsed) {
  const user = getUser(id);
  if (!user?.authenticated || !user.username) return;

  if (parsed.type === 'join_voice') {
    if (voiceUsers.has(id)) {
      sendTo(id, { type: 'voice_user_list', users: getVoiceUserList() });
      return;
    }
    if (voiceUsers.size >= config.maxVoiceUsers) {
      sendTo(id, { type: 'voice_error', content: `语音频道最多允许 ${config.maxVoiceUsers} 人` });
      return;
    }
    addToVoice(id);
    const users = getVoiceUserList();
    sendTo(id, { type: 'voice_user_list', users });
    sendCurrentStateToUser(id);
    broadcastToVoice({ type: 'user_joined_voice', userId: id, username: user.username }, id);
    broadcastToVoice({ type: 'voice_user_list', users }, id);
    return;
  }

  if (!voiceUsers.has(id)) return;

  if (parsed.type === 'leave_voice') {
    removeFromVoice(id);
    const users = getVoiceUserList();
    broadcastToVoice({ type: 'user_left_voice', userId: id, username: user.username });
    broadcastToVoice({ type: 'voice_user_list', users });
    return;
  }

  if (parsed.type === 'voice_mute') {
    broadcastToVoice({
      type: 'voice_mute_update',
      userId: id,
      username: user.username,
      muted: parsed.muted,
    });
    return;
  }

  if (!parsed.target || parsed.target === id || !voiceUsers.has(parsed.target)) return;
  if (parsed.type === 'voice_offer') sendTo(parsed.target, { type: 'voice_offer', from: id, sdp: parsed.sdp });
  if (parsed.type === 'voice_answer') sendTo(parsed.target, { type: 'voice_answer', from: id, sdp: parsed.sdp });
  if (parsed.type === 'voice_ice') sendTo(parsed.target, { type: 'voice_ice', from: id, candidate: parsed.candidate });
}

function clearVoiceUsers() {
  voiceUsers.clear();
}

module.exports = {
  addToVoice,
  broadcastToVoice,
  clearVoiceUsers,
  getVoiceUserList,
  getVoiceUsers,
  handleVoiceMessage,
  removeFromVoice,
};
