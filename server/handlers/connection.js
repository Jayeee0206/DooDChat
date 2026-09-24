const { removeUser, getUser, getAllUsers, rememberResumeSession } = require('./users');
const { config } = require('../config');
const { removeFromVoice, getVoiceUsers, getVoiceUserList, broadcastToVoice } = require('./voice');
const { broadcast } = require('./message');
const history = require('./history');

// options.ws：只在该 socket 仍是此 id 的当前连接时才处理（身份被新连接接管后，旧 socket 的 close 不得移除新连接）。
// options.silent：被同身份新连接接管的旧连接，静默移除，不广播离开、不记录可恢复会话。
function handleDisconnect(id, { ws = null, silent = false } = {}) {
  const user = getUser(id);
  if (!user) return null;
  if (ws && user.ws !== ws) return null;

  const username = user.username;
  const authenticated = user.authenticated;
  const wasInVoice = getVoiceUsers().has(id);
  if (wasInVoice) removeFromVoice(id);
  removeUser(id);

  if (authenticated && username && user.typingActive) {
    broadcast({ type: 'typing', userId: id, username, active: false, timestamp: Date.now() });
  }

  if (authenticated && username && !silent) {
    rememberResumeSession(user, config.resumeWindowMs);
    const message = { type: 'system', content: `${username} 离开了聊天室`, timestamp: Date.now() };
    history.add(message);
    broadcast(message);
    broadcast({ type: 'user_list', users: getAllUsers() });
  }

  if (wasInVoice) {
    broadcastToVoice({ type: 'user_left_voice', userId: id, username });
    broadcastToVoice({ type: 'voice_user_list', users: getVoiceUserList() });
  }
  return user;
}

module.exports = { handleDisconnect };
