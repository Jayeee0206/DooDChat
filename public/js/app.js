/* ====== SVG 图标工厂 ====== */
const Icons = {
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  micOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
};

/* ====== 状态 ====== */
try { localStorage.removeItem('dood_chat_history'); } catch (e) {}

const state = {
  ws: null,
  userId: '',
  username: '',
  connected: false,
  users: [],           // {id, username}[]
  voiceUsers: [],      // 在语音中的用户 {id, username}[]
  reconnectTimer: null,
  roomPassword: '',
  roomPasswordRequired: false,
  replyTarget: null,
  resumeToken: null,       // 服务端下发的短期会话恢复令牌，仅存内存，刷新页面即失效
  sessionStarted: false,   // 本页是否已经成功进入过聊天（用于区分首次登录与断线重连）
  historyMerge: false,     // 重连后的 history 只做合并，不清空已渲染的消息
  lastRenderedTs: 0,       // 已渲染消息的最大服务端时间戳，用于跳过重复的系统消息
};

/* ====== DOM 引用 ====== */
const $ = (id) => document.getElementById(id);
const loginContainer = $('login-container');
const chatContainer = $('chat-container');
const nicknameInput = $('nickname-input');
const joinBtn = $('join-btn');
const loginError = $('login-error');
const roomPasswordWrap = $('room-password-wrap');
const roomPasswordInput = $('room-password-input');
const messageList = $('message-list');
const messageInput = $('message-input');
const sendBtn = $('send-btn');
const userList = $('user-list');
const onlineCount = $('online-count');
const myNicknameDisplay = $('my-nickname-display');
const voiceToggleBtn = $('voice-toggle-btn');
const voiceStatus = $('voice-status');
const voiceUserList = $('voice-user-list');
const musicToggle = $('music-toggle');
const sidebarToggle = $('sidebar-toggle');
const sidebarOverlay = $('sidebar-overlay');
const statusIndicator = document.querySelector('.status-indicator');
const connectionStatusText = $('connection-status-text');
const userBadge = document.querySelector('.user-badge');
const notificationToggleBtn = $('notification-toggle-btn');
const notificationStatus = $('notification-status');
const replyPreview = $('reply-preview');
const replyPreviewUser = $('reply-preview-user');
const replyPreviewText = $('reply-preview-text');
const replyPreviewClose = $('reply-preview-close');
const polish = window.DooDPolish;

function setConnectionStatus(status) {
  const labels = {
    online: '在线',
    connecting: '连接中',
    offline: '离线',
  };
  const label = labels[status] || '状态未知';
  state.connectionStatus = status;
  statusIndicator?.classList.toggle('connecting', status === 'connecting');
  statusIndicator?.classList.toggle('offline', status === 'offline');
  if (statusIndicator) statusIndicator.title = label;
  if (connectionStatusText) {
    connectionStatusText.textContent = label;
    connectionStatusText.classList.toggle('connecting', status === 'connecting');
    connectionStatusText.classList.toggle('offline', status === 'offline');
  }
  if (userBadge) userBadge.title = label;
}

/* ====== WebSocket 连接 ====== */
function connectWebSocket() {
  if (state.ws) {
    state.ws.close();
  }
  setConnectionStatus('connecting');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.connected = true;
    // 发送昵称
    const hello = {
      type: 'set_nickname',
      username: state.username,
      roomPassword: state.roomPassword,
    };
    // 断线重连时携带恢复令牌，服务端校验通过后会复用原来的身份（消息归属、回应、撤回权限延续）
    if (state.resumeToken) hello.resumeToken = state.resumeToken;
    state.ws.send(JSON.stringify(hello));
    // 8 秒内未被服务端接纳（如昵称被占）则主动断开重连
    if (state.welcomeTimer) clearTimeout(state.welcomeTimer);
    if (chatContainer.style.display !== 'none') {
      state.welcomeTimer = setTimeout(() => {
        if (!state.welcomed && state.ws && state.ws.readyState === WebSocket.OPEN) {
          renderStatusMessage('重连未完成（昵称可能被占用），正在重试...');
          try { state.ws.close(); } catch (e) {}
        }
      }, 8000);
    }
    state.welcomed = false;
  };

  state.ws.onmessage = (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    // 语音信令转发给 voice.js
    const voiceTypes = ['voice_user_list', 'user_joined_voice', 'user_left_voice',
                        'voice_offer', 'voice_answer', 'voice_ice', 'voice_mute_update', 'voice_error'];
    if (voiceTypes.includes(parsed.type)) {
      handleVoiceSignal(parsed);
      return;
    }

    // 音乐消息转发给 music.js
    const musicTypes = ['music_state', 'music_playlist_data',
                        'music_song_start', 'music_song_loaded',
                        'music_pause', 'music_resume', 'music_sync',
                        'music_playlist_end', 'music_playlist_update', 'music_error',
                        'music_lyrics_update'];
    if (musicTypes.includes(parsed.type)) {
      handleMusicSignal(parsed);
      return;
    }

    // 其他消息
    switch (parsed.type) {
      case 'welcome':
        state.welcomed = true;
        setConnectionStatus('online');
        if (parsed.uploadToken) state.uploadToken = parsed.uploadToken;
        if (state.welcomeTimer) { clearTimeout(state.welcomeTimer); state.welcomeTimer = null; }
        state.userId = parsed.id;
        state.resumeToken = typeof parsed.resumeToken === 'string' ? parsed.resumeToken : null;
        // 首次进入：完整渲染历史；断线重连：只合并缺失的消息，保留已看到的内容与滚动位置
        state.historyMerge = state.sessionStarted;
        state.sessionStarted = true;
        setSelfId(parsed.id);
        // 切换到聊天界面
        loginContainer.style.display = 'none';
        chatContainer.style.display = 'flex';
        requestAnimationFrame(() => chatContainer.classList.add('fade-in'));
        myNicknameDisplay.textContent = `你好，${parsed.username}`;
        polish?.setLoggedIn(true);
        break;

      case 'history': {
        const merge = state.historyMerge;
        state.historyMerge = false;
        if (!merge) {
          messageList.innerHTML = '';
          state.lastRenderedTs = 0;
          polish?.resetMessageFlow();
        }
        for (const msg of parsed.messages || []) {
          if (msg.type === 'system') {
            if (merge && msg.timestamp && msg.timestamp <= state.lastRenderedTs) continue;
            renderSystemMessage(msg.content, msg.timestamp);
          } else if (msg.type === 'message') {
            if (merge) {
              const existing = findMessageEntry(msg.messageId);
              if (existing) { syncExistingMessage(existing, msg); continue; }
            }
            renderMessage(
              msg.username,
              msg.content,
              msg.timestamp,
              msg.kind,
              msg.senderId,
              msg.messageId,
              msg.replyTo,
              msg.reactions,
              msg.recalled,
              msg.recalledBy,
            );
          }
        }
        if (state.replyTarget && !findMessageEntry(state.replyTarget.messageId)) clearReplyTarget();
        break;
      }

      case 'system':
        renderSystemMessage(parsed.content, parsed.timestamp);
        break;

      case 'message':
        polish?.clearTyping(parsed.senderId || parsed.username);
        renderMessage(
          parsed.username,
          parsed.content,
          parsed.timestamp,
          parsed.kind,
          parsed.senderId,
          parsed.messageId,
          parsed.replyTo,
          parsed.reactions,
        );
        notifyIfNeeded(parsed);
        break;

      case 'reaction_state':
        updateMessageReactions(parsed.messageId, parsed.reactions);
        break;

      case 'message_recalled':
        applyRecalledMessage(parsed.messageId, parsed.recalledBy, parsed.username);
        if (state.replyTarget?.messageId === parsed.messageId) clearReplyTarget(parsed.messageId);
        break;

      case 'typing':
        polish?.handleTyping(parsed);
        break;

      case 'weather_state':
        polish?.handleWeatherState(parsed);
        break;

      case 'user_list':
        state.users = parsed.users || [];
        updateUserList();
        polish?.syncTypingUsers(state.users);
        break;

      case 'error':
        if (parsed.code === 'REPLY_TARGET_MISSING') clearReplyTarget();
        if (loginContainer.style.display !== 'none') {
          loginError.textContent = parsed.content;
          if (parsed.code === 'ROOM_PASSWORD_INVALID' && roomPasswordInput) {
            roomPasswordInput.value = '';
            roomPasswordInput.focus();
          }
        } else {
          // 聊天界面里也要显示服务端错误（如重连后昵称被占）
          renderStatusMessage('服务端错误: ' + parsed.content);
        }
        break;
    }
  };

  const thisWs = state.ws;
  state.ws.onclose = () => {
    // 只处理当前连接的关闭事件，避免旧连接的迟到回调叠加重连
    if (thisWs !== state.ws) return;
    state.connected = false;
    polish?.resetTyping();
    setConnectionStatus('offline');
    // 如果已在聊天中，显示断线并重连
    if (chatContainer.style.display !== 'none') {
      renderStatusMessage('连接已断开，3 秒后重连...');
      // 离开语音
      if (isInVoice()) {
        leaveVoice();
      }
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  };

  state.ws.onerror = () => {
    // onclose 也会触发，不需要额外处理
  };
}

/* ====== 发送消息 ====== */
function sendWs(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

function setReplyTarget(target) {
  if (!target?.messageId) return;
  state.replyTarget = {
    messageId: target.messageId,
    username: target.username || '未知用户',
    content: target.kind === 'image' ? '[图片]' : String(target.content || '').slice(0, 160),
    kind: target.kind || 'text',
  };
  if (replyPreview && replyPreviewUser && replyPreviewText) {
    replyPreviewUser.textContent = state.replyTarget.username;
    replyPreviewText.textContent = state.replyTarget.content;
    replyPreview.hidden = false;
  }
  messageInput.focus();
}

function clearReplyTarget(expectedMessageId = null) {
  if (expectedMessageId && state.replyTarget?.messageId !== expectedMessageId) return;
  state.replyTarget = null;
  if (replyPreview) replyPreview.hidden = true;
  if (replyPreviewUser) replyPreviewUser.textContent = '';
  if (replyPreviewText) replyPreviewText.textContent = '';
}

function sendMessage() {
  const content = messageInput.value.trim();
  if (!content) return false;

  // 断线时保留草稿并给出提示
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    renderStatusMessage('当前未连接，消息未发送（内容已保留，请稍后重试）');
    return false;
  }

  const replyTo = state.replyTarget?.messageId || null;
  const payload = { type: 'message', content };
  if (replyTo) payload.replyTo = replyTo;
  sendWs(payload);
  messageInput.value = '';
  clearReplyTarget(replyTo);
  polish?.afterMessageSent();
  messageInput.focus();
  return true;
}

/* ====== 渲染：消息 ====== */

// 判断某用户是否在语音中
function isUserInVoice(username) {
  if (!username) return false;
  if (username === state.username) return isInVoice();
  return state.voiceUsers.some(u => u.username === username);
}

// 头像颜色池
const AVATAR_COLORS = [
  '#a855f7', '#22c55e', '#ef4444', '#f59e0b',
  '#06b6d4', '#f472b6', '#8b5cf6', '#10b981',
];

function getAvatarColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// 图片使用白名单 DOM 构建，文本一律使用 textContent，避免 HTML 注入
function fillBubble(bubble, content, kind) {
  if (kind !== 'image' && isMentioned(content)) bubble.classList.add('mentioned');
  var url = null;
  if (kind === 'image') {
    url = content;
  } else if (typeof content === 'string' && content.indexOf('<img ') === 0) {
    var m = content.match(/src="([^"]+)"/);
    if (m) url = m[1];
  }
  if (url && /^\/uploads\/[A-Za-z0-9.\-]+\.(png|jpe?g|gif|webp)$/.test(url)) {
    var img = document.createElement('img');
    img.src = url;
    img.className = 'chat-img';
    img.alt = '聊天图片，点击查看大图';
    img.loading = 'lazy';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    bubble.appendChild(img);
    return;
  }
  bubble.textContent = content;
}

const imageLightbox = document.getElementById('image-lightbox');
const imageLightboxImg = document.getElementById('image-lightbox-img');
const imageLightboxClose = document.getElementById('image-lightbox-close');
let lastLightboxTrigger = null;

function closeImageLightbox() {
  if (!imageLightbox || imageLightbox.hidden) return;
  imageLightbox.hidden = true;
  if (imageLightboxImg) imageLightboxImg.removeAttribute('src');
  lastLightboxTrigger?.focus?.();
  lastLightboxTrigger = null;
}

function openImageLightbox(image) {
  if (!image || !imageLightbox || !imageLightboxImg) return;
  lastLightboxTrigger = image;
  imageLightboxImg.src = image.src;
  imageLightbox.hidden = false;
  imageLightboxClose?.focus();
}

messageList.addEventListener('click', event => {
  openImageLightbox(event.target.closest('.chat-img'));
});
messageList.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.chat-img')) {
    event.preventDefault();
    openImageLightbox(event.target);
  }
});
imageLightboxClose?.addEventListener('click', closeImageLightbox);
imageLightbox?.addEventListener('click', event => {
  if (event.target === imageLightbox) closeImageLightbox();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeImageLightbox();
});

const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👀'];

function findMessageEntry(messageId) {
  if (!messageId) return null;
  for (const entry of messageList.querySelectorAll('.message-entry')) {
    if (entry.dataset.messageId === messageId) return entry;
  }
  return null;
}

function renderMessageReactions(entry, reactions) {
  const container = entry?.querySelector('.message-reactions');
  if (!container) return;
  container.replaceChildren();
  for (const emoji of MESSAGE_REACTIONS) {
    const actors = Array.isArray(reactions?.[emoji]) ? reactions[emoji] : [];
    if (!actors.length) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-reaction';
    button.dataset.action = 'toggle-reaction';
    button.dataset.emoji = emoji;
    button.classList.toggle('active', actors.some(actor => actor.userId === state.userId));
    button.setAttribute('aria-pressed', button.classList.contains('active') ? 'true' : 'false');
    const names = actors.map(actor => actor.username).filter(Boolean);
    button.title = names.length ? `${names.join('、')} 回应了 ${emoji}` : `回应 ${emoji}`;
    button.setAttribute('aria-label', `${emoji}，${actors.length}个回应${button.classList.contains('active') ? '，你已回应' : ''}`);
    const icon = document.createElement('span');
    icon.textContent = emoji;
    const count = document.createElement('span');
    count.textContent = String(actors.length);
    button.append(icon, count);
    container.appendChild(button);
  }
  entry._messageData.reactions = reactions || {};
}

function updateMessageReactions(messageId, reactions) {
  const entry = findMessageEntry(messageId);
  if (entry) renderMessageReactions(entry, reactions);
}

function createMessageEntry({ username, content, kind, isSelf, messageId, replyTo, reactions, recalled, recalledBy }) {
  const entry = document.createElement('div');
  entry.className = 'message-entry';
  if (messageId) entry.dataset.messageId = messageId;
  entry._messageData = { username, content, kind, messageId, replyTo, reactions: reactions || {} };

  if (recalled) {
    entry.classList.add('message-entry-recalled');
    entry.appendChild(buildRecallTombstone(recalledBy === state.userId ? '你' : username));
    return entry;
  }

  if (replyTo?.messageId) {
    const context = document.createElement('button');
    context.type = 'button';
    context.className = 'message-reply-context';
    context.dataset.action = 'jump-to-message';
    context.dataset.targetMessageId = replyTo.messageId;
    context.setAttribute('aria-label', `查看回复的消息，来自${replyTo.username || '未知用户'}`);
    const author = document.createElement('strong');
    author.textContent = replyTo.username || '未知用户';
    const preview = document.createElement('span');
    preview.textContent = replyTo.kind === 'image' ? '[图片]' : String(replyTo.content || '');
    context.append(author, preview);
    entry.appendChild(context);
  }

  const row = document.createElement('div');
  row.className = 'message-bubble-row';
  const bubble = document.createElement('div');
  bubble.className = `msg-bubble${isSelf ? ' self' : ''}`;
  fillBubble(bubble, content, kind);
  row.appendChild(bubble);

  if (messageId) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const toolsButton = document.createElement('button');
    toolsButton.type = 'button';
    toolsButton.className = 'message-action-btn message-more-btn';
    toolsButton.dataset.action = 'open-reactions';
    toolsButton.setAttribute('aria-haspopup', 'true');
    toolsButton.setAttribute('aria-expanded', 'false');
    toolsButton.setAttribute('aria-label', '打开消息操作');
    toolsButton.title = '消息操作';
    toolsButton.textContent = '···';
    actions.appendChild(toolsButton);
    row.appendChild(actions);

    const picker = document.createElement('div');
    picker.id = `message-tools-${messageId}`;
    picker.className = 'message-reaction-picker';
    picker.hidden = true;
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '消息操作');
    toolsButton.setAttribute('aria-controls', picker.id);

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'message-tool-reply';
    replyButton.dataset.action = 'reply';
    replyButton.setAttribute('aria-label', '回复这条消息');
    const replyIcon = document.createElement('span');
    replyIcon.setAttribute('aria-hidden', 'true');
    replyIcon.textContent = '↩';
    const replyText = document.createElement('span');
    replyText.textContent = '回复';
    replyButton.append(replyIcon, replyText);

    const reactionOptions = document.createElement('div');
    reactionOptions.className = 'message-reaction-options';
    reactionOptions.setAttribute('role', 'group');
    reactionOptions.setAttribute('aria-label', '选择表情回应');
    for (const emoji of MESSAGE_REACTIONS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.action = 'pick-reaction';
      option.dataset.emoji = emoji;
      option.textContent = emoji;
      option.setAttribute('aria-label', `用${emoji}回应`);
      reactionOptions.appendChild(option);
    }
    if (kind !== 'image') {
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'message-tool-reply message-tool-copy';
      copyButton.dataset.action = 'copy';
      copyButton.setAttribute('aria-label', '复制这条消息内容');
      const copyIcon = document.createElement('span');
      copyIcon.setAttribute('aria-hidden', 'true');
      copyIcon.textContent = '⧉';
      const copyText = document.createElement('span');
      copyText.textContent = '复制';
      copyButton.append(copyIcon, copyText);
      picker.append(replyButton, copyButton, reactionOptions);
    } else {
      picker.append(replyButton, reactionOptions);
    }

    if (isSelf) {
      const recallButton = document.createElement('button');
      recallButton.type = 'button';
      recallButton.className = 'message-tool-reply message-tool-recall';
      recallButton.dataset.action = 'recall';
      recallButton.setAttribute('aria-label', '撤回这条消息');
      const recallIcon = document.createElement('span');
      recallIcon.setAttribute('aria-hidden', 'true');
      recallIcon.textContent = '↺';
      const recallText = document.createElement('span');
      recallText.textContent = '撤回';
      recallButton.append(recallIcon, recallText);
      picker.insertBefore(recallButton, reactionOptions);
    }
    entry.append(row, picker);
  } else {
    entry.appendChild(row);
  }

  const reactionList = document.createElement('div');
  reactionList.className = 'message-reactions';
  entry.appendChild(reactionList);
  renderMessageReactions(entry, reactions || {});
  return entry;
}

function buildRecallTombstone(actorName) {
  const tombstone = document.createElement('div');
  tombstone.className = 'message-recall-tombstone';
  tombstone.textContent = `${actorName}撤回了一条消息`;
  return tombstone;
}

function applyRecalledMessage(messageId, recalledBy, username) {
  const entry = findMessageEntry(messageId);
  if (!entry || entry.classList.contains('message-entry-recalled')) return;
  entry.classList.add('message-entry-recalled');
  entry.replaceChildren();
  entry.appendChild(buildRecallTombstone(recalledBy === state.userId ? '你' : (username || '对方')));
  entry._messageData = { ...(entry._messageData || {}), content: '', reactions: {}, recalled: true };
}

// 重连合并历史：页面上已有的消息只同步撤回状态和回应，不重复渲染
function syncExistingMessage(entry, msg) {
  if (msg.recalled) {
    applyRecalledMessage(msg.messageId, msg.recalledBy, msg.username);
    return;
  }
  if (!entry.classList.contains('message-entry-recalled')) renderMessageReactions(entry, msg.reactions || {});
}

function copyMessageContent(content) {
  const text = String(content ?? '');
  if (!text.trim()) return;
  const finish = ok => renderStatusMessage(ok ? '已复制消息内容' : '复制失败，请长按文本手动复制');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => copyFallbackMessage(text, finish));
    return;
  }
  copyFallbackMessage(text, finish);
}

function copyFallbackMessage(text, finish) {
  try {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.setAttribute('readonly', '');
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    const ok = !!(document.execCommand && document.execCommand('copy'));
    temp.remove();
    finish(ok);
  } catch {
    finish(false);
  }
}

function closeReactionPickers(except = null, restoreFocus = false) {
  let focusTarget = null;
  for (const picker of messageList.querySelectorAll('.message-reaction-picker:not([hidden])')) {
    if (picker === except) continue;
    picker.hidden = true;
    const trigger = picker.closest('.message-entry')?.querySelector('[data-action="open-reactions"]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (!focusTarget) focusTarget = trigger;
  }
  if (restoreFocus) focusTarget?.focus();
}

function renderMessage(username, content, timestamp, kind, senderId, messageId, replyTo, reactions, recalled, recalledBy) {
  const isSelf = senderId ? senderId === state.userId : username === state.username;
  if (timestamp > state.lastRenderedTs) state.lastRenderedTs = timestamp;
  const messageOwner = senderId || username;
  const shouldStickToBottom = isMessageListNearBottom();
  polish?.beforeRenderMessage(timestamp);
  const last = messageList.lastElementChild;
  const entry = createMessageEntry({ username, content, kind, isSelf, messageId, replyTo, reactions, recalled, recalledBy });

  // 时间分组：同一用户 60 秒内合并，但每条气泡仍保留自己的消息ID和操作。
  if (last && last.classList.contains('message-item') && last.dataset.user === messageOwner && timestamp) {
    const previousTime = Number.parseInt(last.dataset.ts, 10);
    if (timestamp - previousTime < 60000) {
      last.querySelector('.message-bubbles').appendChild(entry);
      last.querySelector('.message-time').textContent = formatTime(timestamp);
      last.dataset.ts = timestamp;
      autoScroll(shouldStickToBottom);
      return;
    }
  }

  const item = document.createElement('div');
  item.className = `message-item${isSelf ? ' self' : ''}`;
  item.dataset.user = messageOwner;
  item.dataset.username = username;
  if (timestamp) item.dataset.ts = timestamp;

  const initial = username.charAt(0).toUpperCase();
  const color = getAvatarColor(username);
  const time = timestamp ? formatTime(timestamp) : '';

  item.innerHTML =
      '<div class="message-avatar" style="background:' + color + '">' + escapeHtml(initial) + '</div>' +
    '<div class="message-body">' +
      '<div class="message-header">' +
        '<span class="message-username" style="color:' + color + '">' + escapeHtml(username) + '</span>' +
        '<span class="message-time">' + time + '</span>' +
      '</div>' +
      '<div class="message-bubbles"></div>' +
    '</div>';
  item.querySelector('.message-bubbles').appendChild(entry);

  messageList.appendChild(item);
  if (isUserInVoice(username)) item.querySelector('.message-avatar').classList.add('voice-active');
  autoScroll(shouldStickToBottom);
}

messageList.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || !messageList.contains(button)) return;
  const entry = button.closest('.message-entry');
  const data = entry?._messageData;
  const action = button.dataset.action;
  if (action === 'reply' && data?.messageId) {
    closeReactionPickers();
    setReplyTarget(data);
  } else if (action === 'copy' && data) {
    closeReactionPickers();
    copyMessageContent(data.content);
  } else if (action === 'recall' && data?.messageId) {
    closeReactionPickers();
    sendWs({ type: 'message_recall', messageId: data.messageId });
  } else if (action === 'open-reactions') {
    const picker = entry.querySelector('.message-reaction-picker');
    const willOpen = picker.hidden;
    closeReactionPickers(willOpen ? picker : null);
    picker.hidden = !willOpen;
    button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) requestAnimationFrame(() => {
      picker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      picker.querySelector('button')?.focus({ preventScroll: true });
    });
  } else if ((action === 'pick-reaction' || action === 'toggle-reaction') && data?.messageId) {
    sendWs({ type: 'message_reaction', messageId: data.messageId, emoji: button.dataset.emoji });
    closeReactionPickers();
  } else if (action === 'jump-to-message') {
    const target = findMessageEntry(button.dataset.targetMessageId);
    if (target) {
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      target.classList.add('message-entry-highlight');
      window.setTimeout(() => target.classList.remove('message-entry-highlight'), 1400);
    } else {
      renderStatusMessage('原消息已经不在当前页面中');
    }
  }
});

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.message-reaction-picker, [data-action="open-reactions"]')) closeReactionPickers();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeReactionPickers(null, true);
});
replyPreviewClose?.addEventListener('click', () => {
  clearReplyTarget();
  messageInput.focus();
});

function renderSystemMessage(content, timestamp) {
  if (timestamp > state.lastRenderedTs) state.lastRenderedTs = timestamp;
  const shouldStickToBottom = isMessageListNearBottom();
  polish?.beforeRenderMessage(timestamp);
  const div = document.createElement('div');
  div.className = 'system-message';
  div.textContent = content;
  messageList.appendChild(div);
  autoScroll(shouldStickToBottom);
}

/* ====== @提及 + 浏览器通知 + 标题未读数 ====== */
let unreadCount = 0;
const BASE_TITLE = document.title;

document.addEventListener('visibilitychange', function() {
  if (!document.hidden) { unreadCount = 0; document.title = BASE_TITLE; }
});

function isMentioned(content) {
  return !!state.username && typeof content === 'string' && content.indexOf('@' + state.username) !== -1;
}

function notifyIfNeeded(msg) {
  if (msg.senderId === state.userId || msg.username === state.username) return; // 自己发的不提醒
  const mentioned = isMentioned(msg.content);
  const repliedToMe = msg.replyTo?.senderId === state.userId;

  // 后台标签页：更新标题未读数
  if (document.hidden) {
    unreadCount++;
    document.title = '(' + unreadCount + (mentioned || repliedToMe ? ' @' : '') + ') ' + BASE_TITLE;
  }

  // 被 @ 或被回复时弹系统通知（需要用户主动授权过）
  if ((mentioned || repliedToMe) && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      const body = msg.kind === 'image' ? '[图片]' : String(msg.content).slice(0, 80);
      const verb = repliedToMe ? '回复了你' : '提到了你';
      const notification = new Notification('💬 ' + msg.username + ' ' + verb, { body, tag: 'dood-mention' });
      notification.onclick = function() { window.focus(); notification.close(); };
    } catch (e) {}
  }
}

function updateNotificationUi(message) {
  if (!notificationToggleBtn || !notificationStatus) return;
  if (!('Notification' in window)) {
    notificationToggleBtn.textContent = '浏览器不支持通知';
    notificationToggleBtn.disabled = true;
    notificationStatus.textContent = '当前浏览器无法使用后台提醒';
    return;
  }
  const permission = Notification.permission;
  notificationToggleBtn.classList.toggle('enabled', permission === 'granted');
  if (permission === 'granted') {
    notificationToggleBtn.textContent = '已开启 @ 提醒';
    notificationToggleBtn.disabled = true;
    notificationStatus.textContent = message || '页面在后台且有人提到你时会通知';
  } else if (permission === 'denied') {
    notificationToggleBtn.textContent = '通知已被阻止';
    notificationToggleBtn.disabled = true;
    notificationStatus.textContent = '如需开启，请在浏览器的网站权限中允许通知';
  } else {
    notificationToggleBtn.textContent = '开启 @ 提醒';
    notificationToggleBtn.disabled = false;
    notificationStatus.textContent = message || '只有点击按钮后才会请求浏览器权限';
  }
}

notificationToggleBtn?.addEventListener('click', async function() {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    updateNotificationUi();
    return;
  }
  try {
    await Notification.requestPermission();
    updateNotificationUi();
  } catch {
    updateNotificationUi('通知权限请求失败');
  }
});
updateNotificationUi();

function renderStatusMessage(content) {
  const shouldStickToBottom = isMessageListNearBottom();
  const div = document.createElement('div');
  div.className = 'status-message';
  // 断线/重连用 warning，纯错误用 danger
  if (/错误|失败|拒绝/i.test(content)) {
    div.classList.add('error');
  } else if (/断开|断线|重连/i.test(content)) {
    div.classList.add('warning');
  }
  div.textContent = content;
  messageList.appendChild(div);
  autoScroll(shouldStickToBottom);
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isMessageListNearBottom() {
  return messageList.scrollTop + messageList.clientHeight >= messageList.scrollHeight - 50;
}

function autoScroll(shouldScroll = true) {
  if (shouldScroll) messageList.scrollTop = messageList.scrollHeight;
}

/* ====== 渲染：用户列表 ====== */

function updateOnlineBadge(count) {
  const badge = document.getElementById('online-badge');
  if (badge) badge.textContent = String(count);
}

function updateUserList() {
  userList.innerHTML = '';
  const count = state.users.length;
  onlineCount.textContent = `${count} 人在线`;
  updateOnlineBadge(count);

  for (const u of state.users) {
    const li = document.createElement('li');
    li.className = 'user-list-item';
    li.innerHTML = `<span class="user-dot"></span><span>${escapeHtml(u.username)}</span>`;
    userList.appendChild(li);
  }
}

/* ====== 渲染：语音用户列表 ====== */
function updateVoiceUserList() {
  voiceUserList.innerHTML = '';
  const speakingIds = getSpeakingUsers();

  for (const u of state.voiceUsers) {
    const isSelf = u.id === state.userId;
    const li = document.createElement('li');
    li.className = 'voice-user-item';
    if (isSelf) li.classList.add('self');
    li.dataset.userId = isSelf ? '__self__' : u.id;

    // 闭麦状态
    const muted = isSelf ? VoiceState.isMuted : getUserMuted(u.id);
    const micIcon = muted ? Icons.micOff : Icons.mic;

    // 说话状态
    const isSpeaking = speakingIds.includes(isSelf ? '__self__' : u.id);
    if (isSpeaking) li.classList.add('speaking');

    if (isSelf) {
      li.innerHTML =
        '<span class="voice-user-mic ' + (muted ? 'muted' : '') + '">' + micIcon + '</span>' +
        '<span class="voice-user-name">' + escapeHtml(u.username) + '（我）</span>' +
        '<canvas class="voice-waveform" data-uid="' + (isSelf ? '__self__' : u.id) + '" width="40" height="20"></canvas>' +
        '<button class="voice-mute-btn" data-muted="' + muted + '">' + (muted ? '开麦' : '闭麦') + '</button>';

      li.querySelector('.voice-mute-btn').addEventListener('click', function() { toggleMute(); });
    } else {
      var vol = VoiceState.volumeLevels.get(u.id) ?? 1;

      li.innerHTML =
        '<span class="voice-user-mic ' + (muted ? 'muted' : '') + '">' + micIcon + '</span>' +
        '<span class="voice-user-name">' + escapeHtml(u.username) + '</span>' +
        '<canvas class="voice-waveform" data-uid="' + (isSelf ? '__self__' : u.id) + '" width="48" height="20"></canvas>' +
        '<input type="range" class="voice-volume-slider" min="0" max="1" step="0.05" value="' + vol + '">';

      const slider = li.querySelector('.voice-volume-slider');
      slider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        setVoiceVolume(u.id, v);
      });
    }

    voiceUserList.appendChild(li);
  }
}

/* ====== 语音 UI ====== */

function onVoiceJoined() {
  const btnText = voiceToggleBtn.querySelector('span');
  if (btnText) btnText.textContent = '离开语音';
  voiceToggleBtn.classList.add('active');
  voiceStatus.style.display = 'flex';
  VoiceState.mutedUsers.clear();
  // 启动说话检测
  startSpeakingDetection();
}

function onVoiceLeft() {
  const btnText = voiceToggleBtn.querySelector('span');
  if (btnText) btnText.textContent = '加入语音';
  voiceToggleBtn.classList.remove('active');
  voiceStatus.style.display = 'none';
  voiceUserList.innerHTML = '';
  state.voiceUsers = [];
  // 停止说话检测
  stopSpeakingDetection();
}

function onVoiceError(msg) {
  // 在聊天界面直接提示语音错误（如麦克风权限被拒）
  if (chatContainer.style.display !== 'none') {
    renderStatusMessage('🎙️ ' + msg);
  } else {
    loginError.textContent = msg;
  }
}

function refreshMessageVoiceIndicators() {
  for (const item of messageList.querySelectorAll('.message-item')) {
    const avatar = item.querySelector('.message-avatar');
    if (avatar) avatar.classList.toggle('voice-active', isUserInVoice(item.dataset.username || item.dataset.user));
  }
}

function onVoiceUserListUpdate(users) {
  const source = Array.isArray(users)
    ? users
    : Array.from(VoiceState.voiceMembers ? VoiceState.voiceMembers.values() : []);
  const seen = new Set();
  state.voiceUsers = source.filter(user => {
    if (!user || !user.id || seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
  state.voiceUsers.sort((a, b) => {
    if (a.id === state.userId) return -1;
    if (b.id === state.userId) return 1;
    return String(a.username).localeCompare(String(b.username), 'zh-CN');
  });
  updateVoiceUserList();
  refreshMessageVoiceIndicators();
}

// 本机闭麦状态变化
function onMuteChange(muted) {
  updateVoiceUserList();
}

// 收到远端闭麦状态更新
function onMuteChangeUpdate(userId, muted) {
  updateVoiceUserList();
}

// 说话状态变化（由 voice.js 每 200ms 调用）
function onSpeakingUpdate() {
  const speakingIds = getSpeakingUsers();
  const items = voiceUserList.querySelectorAll('.voice-user-item');
  for (const item of items) {
    const uid = item.dataset.userId;
    const isSpeaking = uid && speakingIds.includes(uid);
    item.classList.toggle('speaking', !!isSpeaking);
  }
}

// 波形绘制（voice.js 每 200ms 调用此函数）
function drawWaveforms() {
  if (!VoiceState.analysers) return;
  var canvases = document.querySelectorAll('.voice-waveform');
  for (var i = 0; i < canvases.length; i++) {
    var cv = canvases[i];
    var uid = cv.dataset.uid;
    var data = VoiceState.waveformData && VoiceState.waveformData[uid];
    if (!data) {
      // 无数据时绘制平坦线
      var ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.beginPath();
      ctx.moveTo(0, cv.height / 2);
      ctx.lineTo(cv.width, cv.height / 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
      continue;
    }
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    var w = cv.width, h = cv.height, mid = h / 2;
    ctx.beginPath();
    var step = Math.max(1, Math.floor(data.length / w));
    for (var x = 0; x < w; x++) {
      var idx = Math.min(Math.floor(x * data.length / w), data.length - 1);
      var val = (data[idx] - 128) / 128;
      var y = mid + val * (mid - 1);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--cover-accent').trim()
      || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      || '#a855f7';
    ctx.strokeStyle = themeColor;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/* ====== 登录逻辑 ====== */
function joinChat() {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    loginError.textContent = '请输入昵称';
    return;
  }
  if (nickname.length > 20) {
    loginError.textContent = '昵称最多 20 个字符';
    return;
  }

  if (state.roomPasswordRequired && !roomPasswordInput.value) {
    loginError.textContent = '请输入房间密码';
    roomPasswordInput.focus();
    return;
  }

  state.username = nickname;
  state.roomPassword = roomPasswordInput ? roomPasswordInput.value : '';
  loginError.textContent = '';
  connectWebSocket();
}

/* ====== 事件绑定 ====== */

// 登录
joinBtn.addEventListener('click', joinChat);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (state.roomPasswordRequired && roomPasswordInput && !roomPasswordInput.value) roomPasswordInput.focus();
    else joinChat();
  }
});
roomPasswordInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinChat();
});

// 发送消息（键盘、自动增高、@ 补全由 polish.js 统一处理）
sendBtn.addEventListener('click', sendMessage);

// 语音切换
voiceToggleBtn.addEventListener('click', () => {
  if (isInVoice()) {
    leaveVoice();
  } else {
    joinVoice();
  }
});

/* ====== 图片上传：常见静态格式重新编码，避免直接上传原图附带的元数据 ====== */
function compressImage(file) {
  return new Promise(function(resolve, reject) {
    if (file.type === 'image/gif') return resolve(file); // 保留动图；GIF 原始元数据仍可能随文件上传
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return reject(new Error('只支持 JPEG、PNG、WebP 或 GIF 图片'));
    }
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(url);
      var MAX = 1600;
      var scale = Math.min(1, MAX / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      var context = canvas.getContext('2d');
      if (!context) return reject(new Error('浏览器无法处理这张图片'));
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function(blob) {
        if (!blob) return reject(new Error('图片处理失败'));
        resolve(blob);
      }, file.type, file.type === 'image/jpeg' ? 0.85 : undefined);
    };
    img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
    img.src = url;
  });
}

function uploadImage(rawFile) {
  if (!rawFile) return;
  const replyTo = state.replyTarget?.messageId || null;
  compressImage(rawFile)
    .then(function(file) { doUploadImage(file, replyTo); })
    .catch(function(error) { renderStatusMessage('图片上传失败: ' + error.message); });
}

function doUploadImage(file, replyTo) {
  var reader = new FileReader();
  reader.onload = function() {
    var base64 = reader.result.split(',')[1];
    fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Token': state.uploadToken || '' },
      body: JSON.stringify({ data: base64 })
    }).then(async function(response) {
      var payload = await response.json().catch(function() { return {}; });
      if (!response.ok) throw new Error(payload.error || '图片上传失败');
      return payload;
    }).then(function(resp) {
      if (resp.url) {
        const payload = { type: 'message', kind: 'image', content: resp.url };
        if (replyTo) payload.replyTo = replyTo;
        sendWs(payload);
        clearReplyTarget(replyTo);
      }
    }).catch(function(error) {
      renderStatusMessage('图片上传失败: ' + error.message);
    });
  };
  reader.onerror = function() { renderStatusMessage('图片上传失败: 无法读取图片'); };
  reader.readAsDataURL(file);
}

// 手机和桌面都可使用的图片选择入口
const imageFileInput = document.getElementById('image-file-input');
const imageUploadBtn = document.getElementById('image-upload-btn');
imageUploadBtn?.addEventListener('click', function() {
  imageFileInput?.click();
});
imageFileInput?.addEventListener('change', function() {
  const file = imageFileInput.files && imageFileInput.files[0];
  imageFileInput.value = '';
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) {
    renderStatusMessage('请选择图片文件');
    return;
  }
  uploadImage(file);
});

// 剪贴板粘贴图片
messageInput.addEventListener('paste', function(e) {
  var items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      e.preventDefault();
      uploadImage(items[i].getAsFile());
      return;
    }
  }
});

// 拖拽图片到输入区（保留高亮）；上传由下方的全窗口监听统一处理
var inputArea = document.getElementById('input-area');
inputArea.addEventListener('dragover', function(e) { e.preventDefault(); inputArea.classList.add('drag-over'); });
inputArea.addEventListener('dragleave', function() { inputArea.classList.remove('drag-over'); });
inputArea.addEventListener('drop', function(e) {
  e.preventDefault();
  inputArea.classList.remove('drag-over');
});

// 全窗口拖入图片：显示提示层并防止浏览器把图片当链接打开
var dropOverlay = $('drop-overlay');
var dropDepth = 0;
function eventHasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
}
function hideDropOverlay() {
  dropDepth = 0;
  if (dropOverlay) dropOverlay.classList.remove('active');
}
window.addEventListener('dragenter', function(e) {
  if (!state.welcomed || !eventHasFiles(e)) return;
  dropDepth += 1;
  if (dropOverlay) dropOverlay.classList.add('active');
});
window.addEventListener('dragover', function(e) {
  if (state.welcomed && eventHasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', function(e) {
  if (!eventHasFiles(e)) return;
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth && dropOverlay) dropOverlay.classList.remove('active');
});
window.addEventListener('drop', function(e) {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  hideDropOverlay();
  if (!state.welcomed) return;
  var files = Array.from(e.dataTransfer.files || []).filter(function(file) {
    return file.type && file.type.indexOf('image/') === 0;
  });
  if (!files.length) { renderStatusMessage('拖入的文件不是图片'); return; }
  if (files.length > 4) renderStatusMessage('一次最多拖动发送 4 张图片');
  files.slice(0, 4).forEach(function(file) { uploadImage(file); });
});
document.addEventListener('visibilitychange', hideDropOverlay);

// Emoji 选择器
(function initEmoji() {
  var emojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😜','😝','🤔','🤗','😐','😑','😶','🙄','😏','😒','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤧','🥳','🤩','👍','👎','👊','✌️','🤞','👀','🔥','💯','💀','🎉','🎊','❤️','💔','💖','💙','💚','💜','🖤','⭐','✨','🌈','🍕','🎵','🎶','💡','📌','💪','🧠','👏','🙏','💅','🫡','🤝','🗿','👾','🤖','🎮','🌙','☀️'];
  var panel = document.getElementById('emoji-panel');
  var trigger = document.getElementById('emoji-btn');
  var input = document.getElementById('message-input');
  if (!panel || !trigger || !input) return;

  emojis.forEach(function(e) {
    var btn = document.createElement('button');
    btn.textContent = e;
    btn.addEventListener('click', function() {
      input.value += e;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      panel.style.display = 'none';
    });
    panel.appendChild(btn);
  });

  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });

  document.addEventListener('click', function(e) {
    if (!panel.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
      panel.style.display = 'none';
    }
  });
})();

// 移动端抽屉：音乐和成员使用独立入口，同一时间只允许打开一个
const mobileLayout = window.matchMedia('(max-width: 900px), (max-width: 950px) and (max-height: 500px)');
const compactInputLayout = window.matchMedia('(max-width: 600px)');
const sidePanel = document.getElementById('side-panel');
const musicPanel = document.getElementById('music-panel');
const desktopMessagePlaceholder = '输入消息…（回车发送，Shift+Enter 换行，@ 可呼出补全）';

function syncResponsiveInputHint() {
  if (messageInput) messageInput.placeholder = compactInputLayout.matches ? '输入消息…' : desktopMessagePlaceholder;
}

function closeMobilePanels() {
  sidePanel?.classList.remove('open');
  musicPanel?.classList.remove('open');
  sidebarOverlay?.classList.remove('active');
  sidebarToggle?.setAttribute('aria-expanded', 'false');
  musicToggle?.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

function toggleMobilePanel(panel, toggle) {
  if (!mobileLayout.matches || !panel) return;
  const shouldOpen = !panel.classList.contains('open');
  closeMobilePanels();
  if (!shouldOpen) return;
  panel.classList.add('open');
  sidebarOverlay?.classList.add('active');
  toggle?.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}

musicToggle?.addEventListener('click', () => toggleMobilePanel(musicPanel, musicToggle));
sidebarToggle?.addEventListener('click', () => toggleMobilePanel(sidePanel, sidebarToggle));
sidebarOverlay?.addEventListener('click', closeMobilePanels);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMobilePanels();
});
if (mobileLayout.addEventListener) mobileLayout.addEventListener('change', closeMobilePanels);
else mobileLayout.addListener?.(closeMobilePanels);
if (compactInputLayout.addEventListener) compactInputLayout.addEventListener('change', syncResponsiveInputHint);
else compactInputLayout.addListener?.(syncResponsiveInputHint);
syncResponsiveInputHint();

/* ====== 移动端边缘手势抽屉 ====== */
(function initEdgeDrawerGestures() {
  const EDGE_PX = 28;
  const TRIGGER_PX = 56;
  let gesture = null;
  window.addEventListener('touchstart', function(event) {
    if (!mobileLayout.matches || !event.touches.length) { gesture = null; return; }
    const touch = event.touches[0];
    const anyOpen = sidePanel?.classList.contains('open') || musicPanel?.classList.contains('open');
    if (anyOpen) {
      gesture = { mode: 'close', startX: touch.clientX, startY: touch.clientY };
      return;
    }
    if (touch.clientX < window.innerWidth - EDGE_PX) { gesture = null; return; }
    gesture = {
      mode: touch.clientY >= window.innerHeight * 0.44 ? 'music' : 'members',
      startX: touch.clientX,
      startY: touch.clientY,
    };
  }, { passive: true });
  window.addEventListener('touchend', function(event) {
    if (!gesture || !event.changedTouches.length) { gesture = null; return; }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - gesture.startX;
    const dy = Math.abs(touch.clientY - gesture.startY);
    const mode = gesture.mode;
    gesture = null;
    if (dy > 72) return;
    if (mode === 'members' && dx <= -TRIGGER_PX) toggleMobilePanel(sidePanel, sidebarToggle);
    else if (mode === 'music' && dx <= -TRIGGER_PX) toggleMobilePanel(musicPanel, musicToggle);
    else if (mode === 'close' && dx >= TRIGGER_PX) closeMobilePanels();
  }, { passive: true });
})();

/* ====== 主题切换 ====== */
(function initTheme() {
  var saved = localStorage.getItem('dood_theme') || 'default';
  document.documentElement.setAttribute('data-theme', saved);
  document.querySelectorAll('.theme-btn').forEach(function(btn) {
    if (btn.dataset.theme === saved) btn.classList.add('active');
    btn.addEventListener('click', function() {
      document.querySelectorAll('.theme-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var theme = btn.dataset.theme;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('dood_theme', theme);
    });
  });
})();

/* ====== 启动 ====== */
polish?.init({
  getAvatarColor,
  getUserId: () => state.userId,
  getUsername: () => state.username,
  getUsers: () => state.users,
  sendMessage,
  sendWs,
});

async function loadPublicConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('config unavailable');
    const serverConfig = await response.json();
    state.roomPasswordRequired = serverConfig.roomPasswordRequired === true;
    if (roomPasswordWrap) roomPasswordWrap.style.display = state.roomPasswordRequired ? '' : 'none';
  } catch {
    state.roomPasswordRequired = false;
    if (roomPasswordWrap) roomPasswordWrap.style.display = 'none';
  }
}

loadPublicConfig();
nicknameInput.focus();
