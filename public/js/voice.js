/**
 * WebRTC 语音模块 - 网状拓扑 (Mesh)
 * 每个加入语音的用户与所有其他语音用户建立 P2P 连接
 */

// 公网部署: 可在 index.html 里设置 window.ICE_CONFIG 覆盖(加 TURN 中继可提高公网连通率)
const STUN_SERVERS = (typeof window !== 'undefined' && window.ICE_CONFIG) || {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

const VoiceState = {
  localStream: null,           // 本地麦克风 MediaStream
  peerConnections: new Map(),  // userId -> RTCPeerConnection
  audioElements: new Map(),    // userId -> <audio> 元素（用于播放远端音频）
  inVoice: false,              // 是否在语音频道中
  volumeLevels: new Map(),     // userId -> volume (0-1)

  // 语音状态
  isMuted: false,              // 本机是否闭麦
  mutedUsers: new Map(),       // userId -> boolean（从服务端同步的闭麦状态）
  speakingUsers: new Map(),    // userId -> boolean（说话检测结果）
  audioContext: null,          // AudioContext 实例
  analysers: new Map(),        // userId -> { analyserNode, sourceNode } 说话检测用
  speakTimer: null,            // 轮询定时器
  selfId: null,                // 当前用户自己的 ID
  waveformData: {},            // userId -> Uint8Array 供 canvas 波形绘制
  voiceMembers: new Map(),     // 服务端权威语音成员列表
  pendingCandidates: new Map(),// PeerConnection 建立前到达的 ICE candidates
  reconnectTimers: new Map(),  // userId -> retry timer
};

/**
 * 加入语音频道
 */
async function joinVoice() {
  if (VoiceState.inVoice) return;

  try {
    VoiceState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // 回音消除
        noiseSuppression: true,   // 降噪
        autoGainControl: true,    // 自动增益
      },
    });
    VoiceState.inVoice = true;
    VoiceState.isMuted = false;

    sendWs({ type: 'join_voice' });

    if (typeof onVoiceJoined === 'function') onVoiceJoined();
  } catch (err) {
    console.error('麦克风访问被拒绝:', err);
    if (typeof onVoiceError === 'function') onVoiceError('麦克风访问被拒绝，请允许麦克风权限');
    VoiceState.inVoice = false;
  }
}

/**
 * 离开语音频道
 */
function leaveVoice() {
  if (!VoiceState.inVoice) return;

  // 停止说话检测
  stopSpeakingDetection();

  // 关闭所有 peer connection
  for (const [userId, pc] of VoiceState.peerConnections) {
    pc.close();
  }
  VoiceState.peerConnections.clear();

  // 移除所有 audio 元素
  for (const [userId, audio] of VoiceState.audioElements) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  VoiceState.audioElements.clear();

  // 释放麦克风
  if (VoiceState.localStream) {
    VoiceState.localStream.getTracks().forEach(track => track.stop());
    VoiceState.localStream = null;
  }

  VoiceState.inVoice = false;
  VoiceState.isMuted = false;
  VoiceState.mutedUsers.clear();
  VoiceState.speakingUsers.clear();
  VoiceState.voiceMembers.clear();
  VoiceState.pendingCandidates.clear();
  for (const timer of VoiceState.reconnectTimers.values()) clearTimeout(timer);
  VoiceState.reconnectTimers.clear();

  sendWs({ type: 'leave_voice' });

  if (typeof onVoiceLeft === 'function') onVoiceLeft();
}

/* ====== 闭麦/开麦 ====== */

function toggleMute() {
  if (!VoiceState.inVoice || !VoiceState.localStream) return;

  VoiceState.isMuted = !VoiceState.isMuted;

  // 启用/禁用本地音频轨道
  VoiceState.localStream.getAudioTracks().forEach(track => {
    track.enabled = !VoiceState.isMuted;
  });

  // 播放提示音
  playMuteSound();

  // 通知服务端
  sendWs({ type: 'voice_mute', muted: VoiceState.isMuted });

  if (typeof onMuteChange === 'function') onMuteChange(VoiceState.isMuted);
}

/** 播放短促提示音（用 Web Audio API 生成） */
function playMuteSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.08);
    // 完成后自动关闭 ctx
    osc.onended = () => ctx.close();
  } catch (e) {
    // 浏览器不支持 AudioContext，静默忽略
  }
}

/** 播放用户加入语音频道的提示音 */
function playUserJoinedSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    // 两段上升音：500ms → 700ms
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    osc.frequency.setValueAtTime(700, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.setValueAtTime(0.25, ctx.currentTime + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => ctx.close();
  } catch (e) { }
}

function isMuted() {
  return VoiceState.isMuted;
}

function getUserMuted(userId) {
  return VoiceState.mutedUsers.get(userId) || false;
}

function getSpeakingUsers() {
  const result = [];
  for (const [id, speaking] of VoiceState.speakingUsers) {
    if (speaking) result.push(id);
  }
  return result;
}

/* ====== 说话检测 ====== */

function startSpeakingDetection() {
  if (VoiceState.speakTimer) return;

  // 创建 AudioContext
  try {
    VoiceState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // 如果 AudioContext 被浏览器挂起，主动恢复
    if (VoiceState.audioContext.state === 'suspended') {
      VoiceState.audioContext.resume();
    }
  } catch (e) {
    console.error('AudioContext 创建失败:', e);
    return;
  }

  // 为本地麦克风创建 Analyser
  if (VoiceState.localStream) {
    createAnalyser('__self__', VoiceState.localStream);
  }

  // 为每个已连接的远端流创建 Analyser
  for (const [userId, pc] of VoiceState.peerConnections) {
    const audio = VoiceState.audioElements.get(userId);
    if (audio && audio.srcObject) {
      createAnalyser(userId, audio.srcObject);
    }
  }

  // 每 200ms 检测一次
  VoiceState.speakTimer = setInterval(() => {
    let changed = false;

    for (const [userId, { analyser }] of VoiceState.analysers) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);

      // 保存波形数据供 canvas 绘制
      if (!VoiceState.waveformData) VoiceState.waveformData = {};
      VoiceState.waveformData[userId] = data;

      // 计算音量水平
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128);
        sum += v;
      }
      const avg = sum / data.length;
      const isSpeaking = avg > 12; // 阈值

      const prev = VoiceState.speakingUsers.get(userId);
      if (isSpeaking !== prev) {
        VoiceState.speakingUsers.set(userId, isSpeaking);
        changed = true;
      }
    }

    // 每次间隔绘制波形（即使说话状态未变也持续更新画布）
    if (typeof drawWaveforms === 'function') drawWaveforms();
    // 波形与说话高亮各自独立更新
    if (changed && typeof onSpeakingUpdate === 'function') {
      onSpeakingUpdate();
    }
  }, 200);
}

function stopSpeakingDetection() {
  if (VoiceState.speakTimer) {
    clearInterval(VoiceState.speakTimer);
    VoiceState.speakTimer = null;
  }

  // 清理 Analyser
  for (const [, { sourceNode, analyser }] of VoiceState.analysers) {
    try { sourceNode.disconnect(); } catch { }
    try { analyser.disconnect(); } catch { }
  }
  VoiceState.analysers.clear();
  VoiceState.speakingUsers.clear();

  if (VoiceState.audioContext) {
    VoiceState.audioContext.close().catch(() => { });
    VoiceState.audioContext = null;
  }
}

function createAnalyser(userId, stream) {
  if (!VoiceState.audioContext) return;
  if (VoiceState.analysers.has(userId)) return;

  try {
    const sourceNode = VoiceState.audioContext.createMediaStreamSource(stream);
    const analyser = VoiceState.audioContext.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);
    // analyser 只做说话检测，不接扬声器。
    // 远端声音由对应的 <audio> 元素播放（受每人音量滑条控制）；
    // 原先 analyser.connect(destination) 造成第二条不受音量控制的出声通路。
    VoiceState.analysers.set(userId, { sourceNode, analyser });
  } catch (e) {
    // 流可能已关闭
  }
}

function addAnalyserForStream(userId, stream) {
  if (VoiceState.speakTimer) {
    createAnalyser(userId, stream);
  }
}

/* ====== 信令处理 ====== */

function handleVoiceSignal(parsed) {
  switch (parsed.type) {
    case 'voice_user_list':
      handleVoiceUserList(parsed.users);
      break;
    case 'user_joined_voice':
      handleUserJoinedVoice(parsed.userId, parsed.username);
      break;
    case 'user_left_voice':
      handleUserLeftVoice(parsed.userId);
      break;
    case 'voice_offer':
      handleVoiceOffer(parsed.from, parsed.sdp);
      break;
    case 'voice_answer':
      handleVoiceAnswer(parsed.from, parsed.sdp);
      break;
    case 'voice_ice':
      handleVoiceIce(parsed.from, parsed.candidate);
      break;
    case 'voice_mute_update':
      handleVoiceMuteUpdate(parsed.userId, parsed.muted);
      break;
    case 'voice_error':
      if (VoiceState.inVoice) leaveVoice();
      if (typeof onVoiceError === 'function') onVoiceError(parsed.content || '语音操作失败');
      break;
  }
}

function setSelfId(id) {
  VoiceState.selfId = id;
}

function notifyVoiceMembers() {
  if (typeof onVoiceUserListUpdate === 'function') {
    onVoiceUserListUpdate(Array.from(VoiceState.voiceMembers.values()));
  }
}

function shouldInitiate(userId) {
  return VoiceState.selfId && String(VoiceState.selfId) < String(userId);
}

function handleVoiceUserList(users) {
  const nextMembers = new Map();
  for (const user of Array.isArray(users) ? users : []) {
    if (user && typeof user.id === 'string' && typeof user.username === 'string') {
      nextMembers.set(user.id, { id: user.id, username: user.username });
    }
  }
  VoiceState.voiceMembers = nextMembers;

  for (const userId of Array.from(VoiceState.peerConnections.keys())) {
    if (!nextMembers.has(userId)) closePeerConnection(userId);
  }
  for (const userId of nextMembers.keys()) {
    if (userId !== VoiceState.selfId && !VoiceState.peerConnections.has(userId) && shouldInitiate(userId)) {
      createPeerConnection(userId, true);
    }
  }
  notifyVoiceMembers();
}

function handleUserJoinedVoice(userId, username) {
  if (!userId || userId === VoiceState.selfId) return;
  VoiceState.voiceMembers.set(userId, { id: userId, username: username || '未知用户' });
  playUserJoinedSound();
  if (!VoiceState.peerConnections.has(userId) && shouldInitiate(userId)) createPeerConnection(userId, true);
  notifyVoiceMembers();
}

function handleUserLeftVoice(userId) {
  VoiceState.voiceMembers.delete(userId);
  VoiceState.pendingCandidates.delete(userId);
  const reconnectTimer = VoiceState.reconnectTimers.get(userId);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  VoiceState.reconnectTimers.delete(userId);

  const analyser = VoiceState.analysers.get(userId);
  if (analyser) {
    try { analyser.sourceNode.disconnect(); } catch {}
    try { analyser.analyser.disconnect(); } catch {}
    VoiceState.analysers.delete(userId);
  }
  VoiceState.speakingUsers.delete(userId);
  VoiceState.mutedUsers.delete(userId);
  closePeerConnection(userId);
  notifyVoiceMembers();
}

function queueCandidate(userId, candidate) {
  const queue = VoiceState.pendingCandidates.get(userId) || [];
  if (queue.length < 100) queue.push(candidate);
  VoiceState.pendingCandidates.set(userId, queue);
}

async function flushCandidates(userId, pc) {
  const queue = VoiceState.pendingCandidates.get(userId) || [];
  VoiceState.pendingCandidates.delete(userId);
  for (const candidate of queue) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (error) { console.warn('延迟 ICE candidate 处理失败:', error); }
  }
}

async function handleVoiceOffer(from, sdp) {
  if (!VoiceState.inVoice || !VoiceState.voiceMembers.has(from)) return;
  const existing = VoiceState.peerConnections.get(from);
  if (existing) {
    if (existing.connectionState === 'connected' && existing.signalingState === 'stable') return;
    closePeerConnection(from, false);
  }

  const pc = createRTCPeerConnection(from, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushCandidates(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: 'voice_answer', target: from, sdp: pc.localDescription });
    notifyVoiceMembers();
  } catch (error) {
    console.error('handleVoiceOffer error:', error);
    schedulePeerReconnect(from);
  }
}

async function handleVoiceAnswer(from, sdp) {
  const pc = VoiceState.peerConnections.get(from);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushCandidates(from, pc);
  } catch (error) {
    console.error('handleVoiceAnswer error:', error);
    schedulePeerReconnect(from);
  }
}

async function handleVoiceIce(from, candidate) {
  const pc = VoiceState.peerConnections.get(from);
  if (!pc || !pc.remoteDescription) {
    queueCandidate(from, candidate);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch (error) { console.warn('handleVoiceIce error:', error); }
}

function handleVoiceMuteUpdate(userId, muted) {
  VoiceState.mutedUsers.set(userId, muted);
  if (typeof onMuteChangeUpdate === 'function') onMuteChangeUpdate(userId, muted);
}

/* ====== P2P 连接管理 ====== */

function createPeerConnection(userId, isInitiator) {
  if (VoiceState.peerConnections.has(userId)) return;

  const pc = createRTCPeerConnection(userId, isInitiator);

  if (isInitiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        sendWs({
          type: 'voice_offer',
          target: userId,
          sdp: pc.localDescription,
        });
      })
      .catch(err => console.error('createOffer error:', err));
  }
}

function createRTCPeerConnection(userId, isInitiator) {
  const pc = new RTCPeerConnection(STUN_SERVERS);
  VoiceState.peerConnections.set(userId, pc);

  if (VoiceState.localStream) {
    VoiceState.localStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, VoiceState.localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWs({
        type: 'voice_ice',
        target: userId,
        candidate: event.candidate,
      });
    }
  };

  pc.ontrack = (event) => {
    if (!event.streams[0]) return;

    const oldAudio = VoiceState.audioElements.get(userId);
    if (oldAudio) {
      oldAudio.pause();
      oldAudio.srcObject = null;
      oldAudio.remove();
    }

    const audio = document.createElement('audio');
    audio.srcObject = event.streams[0];
    audio.controls = false;
    const vol = VoiceState.volumeLevels.get(userId);
    if (vol !== undefined) audio.volume = vol;
    document.body.appendChild(audio);
    // 显式调用 play（autoplay 不可靠，浏览器会阻止）
    audio.play().catch(() => { });
    VoiceState.audioElements.set(userId, audio);

    // 为远端流添加说话检测
    addAnalyserForStream(userId, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      const timer = VoiceState.reconnectTimers.get(userId);
      if (timer) clearTimeout(timer);
      VoiceState.reconnectTimers.delete(userId);
      notifyVoiceMembers();
    } else if (pc.connectionState === 'failed') {
      schedulePeerReconnect(userId);
    } else if (pc.connectionState === 'disconnected') {
      schedulePeerReconnect(userId, 5000);
    }
  };

  return pc;
}

function schedulePeerReconnect(userId, delay = 1200) {
  if (!VoiceState.inVoice || !VoiceState.voiceMembers.has(userId)) return;
  const previous = VoiceState.reconnectTimers.get(userId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    VoiceState.reconnectTimers.delete(userId);
    if (!VoiceState.inVoice || !VoiceState.voiceMembers.has(userId)) return;
    const current = VoiceState.peerConnections.get(userId);
    if (current && (current.connectionState === 'connected' || current.connectionState === 'connecting')) return;
    VoiceState.pendingCandidates.delete(userId);
    closePeerConnection(userId, false);
    if (shouldInitiate(userId)) createPeerConnection(userId, true);
  }, delay);
  VoiceState.reconnectTimers.set(userId, timer);
}

function closePeerConnection(userId, clearPending = true) {
  const pc = VoiceState.peerConnections.get(userId);
  if (pc) {
    pc.close();
    VoiceState.peerConnections.delete(userId);
  }

  const audio = VoiceState.audioElements.get(userId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    VoiceState.audioElements.delete(userId);
  }
  const analyser = VoiceState.analysers.get(userId);
  if (analyser) {
    try { analyser.sourceNode.disconnect(); } catch {}
    try { analyser.analyser.disconnect(); } catch {}
    VoiceState.analysers.delete(userId);
  }
  VoiceState.speakingUsers.delete(userId);
  if (clearPending) VoiceState.pendingCandidates.delete(userId);
}

/* ====== 音量控制 ====== */

function setVoiceVolume(userId, volume) {
  VoiceState.volumeLevels.set(userId, volume);
  const audio = VoiceState.audioElements.get(userId);
  if (audio) {
    audio.volume = volume;
  }
}

function getVoicePeerIds() {
  return Array.from(VoiceState.peerConnections.keys());
}

function isInVoice() {
  return VoiceState.inVoice;
}
