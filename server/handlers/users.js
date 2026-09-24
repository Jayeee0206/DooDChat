const users = new Map();
// 断线后短期保留的“可恢复会话”：resumeToken -> { id, username, expiresAt }。
// 只存在于内存，房间结束、关闭服务器或到期即清除；不含聊天内容。
const resumeSessions = new Map();
const MAX_RESUME_SESSIONS = 1000;

function getUsersMap() {
  return users;
}

function addUser(id, ws, metadata = {}) {
  const user = {
    ws,
    id,
    username: null,
    authenticated: false,
    uploadToken: null,
    ip: metadata.ip || 'unknown',
    resumeToken: null,
    connectedAt: Date.now(),
    typingActive: false,
    typingLastAt: 0,
    weatherLastAt: 0,
    reactionLastAt: 0,
    recallLastAt: 0,
  };
  users.set(id, user);
  return user;
}

function setUsername(id, username) {
  const user = users.get(id);
  if (!user) return false;
  user.username = username;
  user.authenticated = true;
  return true;
}

function removeUser(id) {
  const user = users.get(id);
  users.delete(id);
  return user || null;
}

function getUser(id) {
  return users.get(id) || null;
}

function getAllUsers() {
  const result = [];
  for (const user of users.values()) {
    if (user.authenticated && user.username) result.push({ id: user.id, username: user.username });
  }
  return result;
}

function isUsernameTaken(username, excludeId = null, alsoExcludeId = null) {
  const lower = username.toLocaleLowerCase('zh-CN');
  for (const user of users.values()) {
    if (user.id === excludeId || user.id === alsoExcludeId) continue;
    if (user.authenticated && user.username?.toLocaleLowerCase('zh-CN') === lower) return true;
  }
  return false;
}

// 把当前连接改绑到上一连接的 id，使消息归属、回应和撤回权限在重连后延续。
function rebindUserId(currentId, targetId) {
  const user = users.get(currentId);
  if (!user || currentId === targetId || users.has(targetId)) return false;
  users.delete(currentId);
  user.id = targetId;
  users.set(targetId, user);
  return true;
}

function pruneResumeSessions(now = Date.now()) {
  for (const [token, session] of resumeSessions) {
    if (session.expiresAt <= now) resumeSessions.delete(token);
  }
}

function rememberResumeSession(user, windowMs, now = Date.now()) {
  if (!user?.resumeToken || !user.authenticated || !user.username || !(windowMs > 0)) return;
  pruneResumeSessions(now);
  if (resumeSessions.size >= MAX_RESUME_SESSIONS) {
    resumeSessions.delete(resumeSessions.keys().next().value);
  }
  resumeSessions.set(user.resumeToken, { id: user.id, username: user.username, expiresAt: now + windowMs });
}

function getResumeSession(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  pruneResumeSessions(now);
  return resumeSessions.get(token) || null;
}

function deleteResumeSession(token) {
  resumeSessions.delete(token);
}

// 旧连接可能尚未被心跳判定为断开（最长约 60 秒），此时按令牌找到仍在线的旧身份。
function findLiveUserByResumeToken(token) {
  if (typeof token !== 'string') return null;
  for (const user of users.values()) {
    if (user.authenticated && user.resumeToken === token) return user;
  }
  return null;
}

function clearResumeSessions() {
  resumeSessions.clear();
}

function getOnlineCount() {
  return getAllUsers().length;
}

function clearUsers() {
  users.clear();
  resumeSessions.clear();
}

module.exports = {
  addUser,
  clearResumeSessions,
  clearUsers,
  deleteResumeSession,
  findLiveUserByResumeToken,
  getAllUsers,
  getOnlineCount,
  getResumeSession,
  getUser,
  getUsersMap,
  isUsernameTaken,
  rebindUserId,
  rememberResumeSession,
  removeUser,
  setUsername,
};
