const { config } = require('../config');

// 房间历史只存在于当前 Node.js 进程的内存中。
// 房间结束或服务器关闭后会清空，不向磁盘写入聊天内容。
const messages = [];

function add(message) {
  messages.push(message);
  if (messages.length > config.historyMemoryLimit) messages.shift();
}

function getRecent(count = 10) {
  const safeCount = Number.isSafeInteger(count)
    ? Math.max(0, Math.min(count, config.historyMemoryLimit))
    : 10;
  return messages.slice(-safeCount);
}

function findMessageById(messageId) {
  if (typeof messageId !== 'string') return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'message' && message.messageId === messageId) return message;
  }
  return null;
}

function clearMemory() {
  messages.length = 0;
}

module.exports = { add, clearMemory, findMessageById, getRecent };
