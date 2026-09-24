(() => {
  'use strict';

  const WEATHER_META = {
    rain: { icon: '🌧️', label: '雨夜' },
    snow: { icon: '❄️', label: '落雪' },
    stars: { icon: '🌠', label: '星空' },
    sakura: { icon: '🌸', label: '樱花' },
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const typingUsers = new Map();
  const lightningTimers = new Set();
  let api = null;
  let initialized = false;
  let lastDateKey = '';
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionMatch = null;
  let typingLastSent = 0;
  let typingActiveSent = false;
  let typingStopTimer = 0;
  let shortcutOverlay = null;
  let shortcutReturnFocus = null;
  let lightningStopped = false;
  let chatFlashTimer = 0;

  const weather = {
    canvas: null,
    context: null,
    mode: 'rain',
    width: 0,
    height: 0,
    particles: [],
    shootingStar: null,
    nextShootingStar: 0,
    frame: 0,
    lastFrame: 0,
    loggedIn: false,
  };

  const byId = id => document.getElementById(id);

  function setTimeMood() {
    const hour = new Date().getHours();
    document.body.dataset.time = hour >= 6 && hour < 9 ? 'dawn' : hour >= 9 && hour < 18 ? 'day' : 'night';
    document.body.dataset.rain = hour >= 18 || hour < 6 ? 'heavy' : 'normal';
  }

  function scheduleLightning(callback, delay) {
    const timer = window.setTimeout(() => {
      lightningTimers.delete(timer);
      callback();
    }, delay);
    lightningTimers.add(timer);
  }

  function strikeLightning(intensity) {
    const flash = byId('lightning-flash');
    const box = document.querySelector('.login-box');
    const login = byId('login-container');
    if (!flash || !box || !login || lightningStopped || document.hidden || login.style.display === 'none') return;
    flash.style.transition = 'opacity 60ms linear';
    flash.style.opacity = String(intensity);
    box.classList.add('struck');
    scheduleLightning(() => {
      flash.style.transition = 'opacity 420ms ease-out';
      flash.style.opacity = '0';
    }, 110 + Math.random() * 70);
    scheduleLightning(() => box.classList.remove('struck'), 540);
  }

  function scheduleLightningLoop() {
    if (lightningStopped || reduceMotion.matches) return;
    scheduleLightning(() => {
      strikeLightning(0.28 + Math.random() * 0.09);
      if (Math.random() < 0.3) {
        scheduleLightning(() => strikeLightning(0.14 + Math.random() * 0.07), 260 + Math.random() * 140);
      }
      scheduleLightningLoop();
    }, 5000 + Math.random() * 5000);
  }

  function initLightning() {
    if (reduceMotion.matches) return;
    scheduleLightning(() => strikeLightning(0.36), 1200);
    scheduleLightningLoop();
  }

  function stopLoginEffects() {
    lightningStopped = true;
    for (const timer of lightningTimers) clearTimeout(timer);
    lightningTimers.clear();
    const flash = byId('lightning-flash');
    const box = document.querySelector('.login-box');
    if (flash) flash.style.opacity = '0';
    box?.classList.remove('struck');
    if (typeof window.__stopRain === 'function') window.__stopRain();
  }

  function scheduleChatFlash() {
    if (chatFlashTimer || reduceMotion.matches) return;
    chatFlashTimer = window.setTimeout(() => {
      chatFlashTimer = 0;
      const layer = byId('chat-flash');
      const chat = byId('chat-container');
      if (layer && chat && chat.style.display !== 'none' && !document.hidden) {
        layer.classList.add('active');
        window.setTimeout(() => layer.classList.remove('active'), 1250);
      }
      scheduleChatFlash();
    }, 90000 + Math.random() * 60000);
  }

  function initChatFlash() {
    const background = byId('bg-effects');
    if (!background || byId('chat-flash')) return;
    const layer = document.createElement('div');
    layer.id = 'chat-flash';
    layer.setAttribute('aria-hidden', 'true');
    background.appendChild(layer);
    scheduleChatFlash();
  }

  function clearCoverAccent() {
    document.documentElement.style.removeProperty('--cover-accent');
  }

  function setCoverAccent(imageUrl) {
    if (!imageUrl) {
      clearCoverAccent();
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 8, 8);
        const pixels = context.getImageData(0, 0, 8, 8).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 100) continue;
          red += pixels[index];
          green += pixels[index + 1];
          blue += pixels[index + 2];
          count += 1;
        }
        if (!count) return;
        red = Math.round(red / count);
        green = Math.round(green / count);
        blue = Math.round(blue / count);
        const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
        if (luminance < 90) {
          const lift = 0.45;
          red = Math.round(red + (255 - red) * lift);
          green = Math.round(green + (255 - green) * lift);
          blue = Math.round(blue + (255 - blue) * lift);
        }
        document.documentElement.style.setProperty('--cover-accent', `rgb(${red}, ${green}, ${blue})`);
      } catch {
        clearCoverAccent();
      }
    };
    image.onerror = clearCoverAccent;
    image.src = imageUrl;
  }

  function resizeWeather() {
    if (!weather.canvas || !weather.context) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    weather.width = window.innerWidth;
    weather.height = window.innerHeight;
    weather.canvas.width = Math.max(1, Math.floor(weather.width * scale));
    weather.canvas.height = Math.max(1, Math.floor(weather.height * scale));
    weather.canvas.style.width = `${weather.width}px`;
    weather.canvas.style.height = `${weather.height}px`;
    weather.context.setTransform(scale, 0, 0, scale, 0, 0);
    buildWeatherParticles();
  }

  function buildWeatherParticles() {
    const width = weather.width || window.innerWidth;
    const height = weather.height || window.innerHeight;
    const particles = [];
    let index;
    if (weather.mode === 'rain') {
      for (index = 0; index < 120; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          speed: 800 + Math.random() * 600,
          length: 26 + Math.random() * 38,
          alpha: 0.09 + Math.random() * 0.13,
        });
      }
    } else if (weather.mode === 'snow') {
      for (index = 0; index < 90; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          radius: 0.9 + Math.random() * 1.9,
          speed: 26 + Math.random() * 46,
          phase: Math.random() * Math.PI * 2,
          sway: 16 + Math.random() * 26,
          alpha: 0.3 + Math.random() * 0.45,
        });
      }
    } else if (weather.mode === 'stars') {
      for (index = 0; index < 150; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height * 0.9,
          radius: 0.4 + Math.random() * 1.1,
          speed: 0.6 + Math.random() * 1.7,
          phase: Math.random() * Math.PI * 2,
        });
      }
      weather.nextShootingStar = performance.now() + 3000 + Math.random() * 5000;
      weather.shootingStar = null;
    } else if (weather.mode === 'sakura') {
      for (index = 0; index < 34; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          speed: 46 + Math.random() * 52,
          phase: Math.random() * Math.PI * 2,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 2.2,
          size: 4 + Math.random() * 4,
          alpha: 0.45 + Math.random() * 0.35,
        });
      }
    }
    weather.particles = particles;
  }

  function chatIsVisible() {
    const chat = byId('chat-container');
    return weather.loggedIn && chat && chat.style.display !== 'none' && !document.hidden;
  }

  function drawWeather(now) {
    weather.frame = 0;
    if (!weather.context || reduceMotion.matches || !chatIsVisible()) return;
    const delta = Math.min(0.05, (now - (weather.lastFrame || now)) / 1000);
    weather.lastFrame = now;
    const context = weather.context;
    const width = weather.width;
    const height = weather.height;
    context.clearRect(0, 0, width, height);

    if (weather.mode === 'rain') {
      context.lineWidth = 1;
      for (const drop of weather.particles) {
        drop.y += drop.speed * delta;
        drop.x += drop.speed * 0.12 * delta;
        if (drop.y - drop.length > height) {
          drop.y = -drop.length;
          drop.x = Math.random() * width;
        }
        context.strokeStyle = `rgba(174,196,226,${drop.alpha})`;
        context.beginPath();
        context.moveTo(drop.x, drop.y);
        context.lineTo(drop.x - drop.length * 0.12, drop.y - drop.length);
        context.stroke();
      }
    } else if (weather.mode === 'snow') {
      for (const flake of weather.particles) {
        flake.y += flake.speed * delta;
        flake.x += Math.sin(now / 1000 * 0.6 + flake.phase) * flake.sway * delta;
        if (flake.y > height + 4) {
          flake.y = -4;
          flake.x = Math.random() * width;
        }
        context.fillStyle = `rgba(235,242,250,${flake.alpha})`;
        context.beginPath();
        context.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
        context.fill();
      }
    } else if (weather.mode === 'stars') {
      const seconds = now / 1000;
      for (const star of weather.particles) {
        const twinkle = 0.5 + 0.5 * Math.sin(seconds * star.speed + star.phase);
        context.fillStyle = `rgba(230,238,250,${(0.18 + 0.6 * twinkle).toFixed(3)})`;
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }
      if (now >= weather.nextShootingStar) {
        weather.nextShootingStar = now + 6000 + Math.random() * 9000;
        weather.shootingStar = {
          x: width * 0.25 + Math.random() * width * 0.6,
          y: 30 + Math.random() * height * 0.25,
          velocityX: -(480 + Math.random() * 240),
          velocityY: 170 + Math.random() * 130,
          life: 1,
        };
      }
      const star = weather.shootingStar;
      if (star) {
        star.life -= delta * 0.85;
        if (star.life <= 0) weather.shootingStar = null;
        else {
          const nextX = star.x + star.velocityX * delta;
          const nextY = star.y + star.velocityY * delta;
          const gradient = context.createLinearGradient(nextX, nextY, nextX - star.velocityX * 0.22, nextY - star.velocityY * 0.22);
          gradient.addColorStop(0, `rgba(255,255,255,${(0.85 * star.life).toFixed(3)})`);
          gradient.addColorStop(1, 'rgba(255,255,255,0)');
          context.strokeStyle = gradient;
          context.lineWidth = 1.6;
          context.beginPath();
          context.moveTo(nextX, nextY);
          context.lineTo(nextX - star.velocityX * 0.22, nextY - star.velocityY * 0.22);
          context.stroke();
          star.x = nextX;
          star.y = nextY;
        }
      }
    } else if (weather.mode === 'sakura') {
      for (const petal of weather.particles) {
        petal.phase += delta * (0.7 + petal.speed * 0.012);
        petal.y += petal.speed * delta;
        petal.x += Math.sin(petal.phase) * 34 * delta;
        petal.rotation += petal.rotationSpeed * delta;
        if (petal.y > height + 12) {
          petal.y = -12;
          petal.x = Math.random() * width;
        }
        context.save();
        context.translate(petal.x, petal.y);
        context.rotate(petal.rotation);
        context.fillStyle = `rgba(255,183,197,${petal.alpha})`;
        context.beginPath();
        context.ellipse(0, 0, petal.size, petal.size * 0.45, 0, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }
    }
    weather.frame = requestAnimationFrame(drawWeather);
  }

  function resumeWeather() {
    if (weather.frame || reduceMotion.matches || !chatIsVisible()) return;
    weather.lastFrame = performance.now();
    weather.frame = requestAnimationFrame(drawWeather);
  }

  function pauseWeather() {
    if (weather.frame) cancelAnimationFrame(weather.frame);
    weather.frame = 0;
  }

  function updateWeatherButton() {
    const button = byId('weather-btn');
    if (!button) return;
    const meta = WEATHER_META[weather.mode];
    button.textContent = meta.icon;
    button.title = `当前房间天气：${meta.label}`;
    button.setAttribute('aria-label', `切换房间天气，当前为${meta.label}`);
  }

  function applyWeather(mode) {
    if (!WEATHER_META[mode]) return;
    if (weather.mode !== mode) {
      weather.mode = mode;
      document.body.dataset.weather = mode;
      buildWeatherParticles();
    }
    updateWeatherButton();
    resumeWeather();
  }

  function closeWeatherMenu() {
    const menu = document.querySelector('.weather-dropdown');
    const button = byId('weather-btn');
    if (menu) menu.remove();
    button?.setAttribute('aria-expanded', 'false');
  }

  function openWeatherMenu() {
    const button = byId('weather-btn');
    if (!button || document.querySelector('.weather-dropdown')) return;
    const menu = document.createElement('div');
    menu.className = 'weather-dropdown';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '房间天气');
    for (const [mode, meta] of Object.entries(WEATHER_META)) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `weather-option${mode === weather.mode ? ' current' : ''}`;
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', mode === weather.mode ? 'true' : 'false');
      option.dataset.weather = mode;
      const icon = document.createElement('span');
      icon.textContent = meta.icon;
      const label = document.createElement('span');
      label.textContent = meta.label;
      option.append(icon, label);
      option.addEventListener('click', () => {
        api?.sendWs({ type: 'weather_change', weather: mode });
        closeWeatherMenu();
        button.focus();
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
    const rectangle = button.getBoundingClientRect();
    menu.style.top = `${rectangle.bottom + 8}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rectangle.right)}px`;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('.current')?.focus();
  }

  function initWeather() {
    const background = byId('bg-effects');
    const button = byId('weather-btn');
    if (!background || !button) return;
    weather.canvas = document.createElement('canvas');
    weather.canvas.id = 'weather-canvas';
    weather.canvas.setAttribute('aria-hidden', 'true');
    background.appendChild(weather.canvas);
    weather.context = weather.canvas.getContext('2d');
    resizeWeather();
    updateWeatherButton();
    window.addEventListener('resize', resizeWeather, { passive: true });
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (document.querySelector('.weather-dropdown')) closeWeatherMenu();
      else openWeatherMenu();
    });
    document.addEventListener('pointerdown', event => {
      const menu = document.querySelector('.weather-dropdown');
      if (menu && !menu.contains(event.target) && event.target !== button) closeWeatherMenu();
    });
  }

  function handleWeatherState(message) {
    applyWeather(message?.weather);
  }

  function setLoggedIn(value) {
    weather.loggedIn = value === true;
    if (weather.loggedIn) {
      stopLoginEffects();
      resumeWeather();
    } else {
      pauseWeather();
    }
  }

  function hideMentionPopup() {
    const popup = byId('mention-popup');
    mentionItems = [];
    mentionIndex = 0;
    mentionMatch = null;
    if (popup) {
      popup.hidden = true;
      popup.replaceChildren();
    }
    byId('message-input')?.removeAttribute('aria-activedescendant');
  }

  function renderMentionPopup() {
    const popup = byId('mention-popup');
    const input = byId('message-input');
    if (!popup || !input || !api) return;
    const caret = input.selectionStart || 0;
    const prefixText = input.value.slice(0, caret);
    const match = prefixText.match(/@([^@\s]*)$/u);
    if (!match) {
      hideMentionPopup();
      return;
    }
    const prefix = match[1].toLocaleLowerCase('zh-CN');
    mentionItems = api.getUsers().filter(user => (
      user.username !== api.getUsername()
      && user.username.toLocaleLowerCase('zh-CN').startsWith(prefix)
    )).slice(0, 20);
    if (!mentionItems.length) {
      hideMentionPopup();
      return;
    }
    mentionMatch = match;
    if (mentionIndex >= mentionItems.length) mentionIndex = 0;
    popup.replaceChildren();
    mentionItems.forEach((user, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `mention-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', index === mentionIndex ? 'true' : 'false');
      option.classList.toggle('selected', index === mentionIndex);
      option.dataset.index = String(index);
      const dot = document.createElement('span');
      dot.className = 'mention-dot';
      dot.style.background = api.getAvatarColor(user.username);
      const name = document.createElement('span');
      name.className = 'mention-name';
      name.textContent = user.username;
      option.append(dot, name);
      option.addEventListener('pointerdown', event => {
        event.preventDefault();
        applyMention(index);
      });
      popup.appendChild(option);
    });
    popup.hidden = false;
    input.setAttribute('aria-activedescendant', `mention-option-${mentionIndex}`);
  }

  function applyMention(index) {
    const input = byId('message-input');
    const selected = mentionItems[index];
    if (!input || !selected || !mentionMatch) return;
    const caret = input.selectionStart || 0;
    const beforeCaret = input.value.slice(0, caret);
    input.value = `${beforeCaret.slice(0, mentionMatch.index)}@${selected.username} ${input.value.slice(caret)}`;
    const nextCaret = mentionMatch.index + selected.username.length + 2;
    hideMentionPopup();
    input.focus();
    input.setSelectionRange(nextCaret, nextCaret);
    updateInputUi();
  }

  function updateCounter() {
    const input = byId('message-input');
    const counter = byId('char-counter');
    if (!input || !counter) return;
    const remaining = 500 - input.value.length;
    counter.textContent = String(remaining);
    counter.classList.toggle('warn', remaining < 100 && remaining >= 20);
    counter.classList.toggle('danger', remaining < 20);
  }

  function autoGrowInput() {
    const input = byId('message-input');
    if (!input) return;
    input.style.height = 'auto';
    const height = Math.min(input.scrollHeight, 140);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
  }

  function updateInputUi() {
    autoGrowInput();
    updateCounter();
    renderMentionPopup();
  }

  function sendTyping(active) {
    if (!api) return;
    if (active) {
      const now = Date.now();
      if (now - typingLastSent < 2500) return;
      typingLastSent = now;
      typingActiveSent = true;
      api.sendWs({ type: 'typing', active: true });
    } else if (typingActiveSent) {
      typingActiveSent = false;
      api.sendWs({ type: 'typing', active: false });
    }
  }

  function scheduleTypingStop() {
    clearTimeout(typingStopTimer);
    typingStopTimer = window.setTimeout(() => sendTyping(false), 3200);
  }

  function onInput() {
    const input = byId('message-input');
    updateInputUi();
    if (input?.value.trim()) {
      sendTyping(true);
      scheduleTypingStop();
    } else {
      clearTimeout(typingStopTimer);
      sendTyping(false);
    }
  }

  function onInputKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const popupOpen = !byId('mention-popup')?.hidden && mentionItems.length > 0;
    if (popupOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      mentionIndex = event.key === 'ArrowDown'
        ? (mentionIndex + 1) % mentionItems.length
        : (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
      renderMentionPopup();
      return;
    }
    if (popupOpen && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      applyMention(mentionIndex);
      return;
    }
    if (popupOpen && event.key === 'Escape') {
      event.preventDefault();
      hideMentionPopup();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      api?.sendMessage();
    }
  }

  function afterMessageSent() {
    clearTimeout(typingStopTimer);
    sendTyping(false);
    hideMentionPopup();
    updateInputUi();
  }

  function handleTyping(message) {
    if (!message || message.userId === api?.getUserId() || message.username === api?.getUsername()) return;
    const key = message.userId || message.username;
    if (message.active === false) typingUsers.delete(key);
    else typingUsers.set(key, { username: message.username, expiresAt: Date.now() + 5000 });
    renderTyping();
  }

  function clearTyping(key) {
    if (!key) return;
    typingUsers.delete(key);
    for (const [entryKey, value] of typingUsers) {
      if (value.username === key) typingUsers.delete(entryKey);
    }
    renderTyping();
  }

  function syncTypingUsers(users) {
    const validIds = new Set((users || []).map(user => user.id));
    for (const key of typingUsers.keys()) {
      if (!validIds.has(key)) typingUsers.delete(key);
    }
    renderTyping();
  }

  function resetTyping() {
    typingUsers.clear();
    renderTyping();
  }

  function renderTyping() {
    const indicator = byId('typing-indicator');
    if (!indicator) return;
    const now = Date.now();
    const names = [];
    for (const [key, value] of typingUsers) {
      if (value.expiresAt <= now) typingUsers.delete(key);
      else names.push(value.username);
    }
    indicator.replaceChildren();
    if (!names.length) {
      indicator.hidden = true;
      indicator.style.display = 'none';
      return;
    }
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    for (let index = 0; index < 3; index += 1) dots.appendChild(document.createElement('i'));
    const text = document.createElement('span');
    const first = document.createElement('strong');
    first.textContent = names[0];
    text.appendChild(first);
    if (names.length === 1) {
      text.append(' 正在输入…');
    } else if (names.length === 2) {
      text.append(' 和 ');
      const second = document.createElement('strong');
      second.textContent = names[1];
      text.append(second, ' 正在输入…');
    } else {
      text.append(` 等 ${names.length} 人正在输入…`);
    }
    indicator.append(dots, text);
    indicator.hidden = false;
    indicator.style.display = 'flex';
  }

  function formatDateLabel(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const key = value => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
    if (key(date) === key(today)) return '今天';
    if (key(date) === key(yesterday)) return '昨天';
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function beforeRenderMessage(timestamp) {
    const date = new Date(timestamp || Date.now());
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key === lastDateKey) return;
    lastDateKey = key;
    const list = byId('message-list');
    if (!list) return;
    const separator = document.createElement('div');
    separator.className = 'date-separator';
    const label = document.createElement('span');
    label.textContent = formatDateLabel(date.getTime());
    separator.appendChild(label);
    list.appendChild(separator);
  }

  function resetMessageFlow() {
    lastDateKey = '';
  }

  function initScrollButton() {
    const list = byId('message-list');
    const button = byId('scroll-bottom-btn');
    if (!list || !button) return;
    const update = () => {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
      button.classList.toggle('visible', !nearBottom);
    };
    list.addEventListener('scroll', update, { passive: true });
    button.addEventListener('click', () => {
      list.scrollTo({ top: list.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      button.classList.remove('visible');
    });
  }

  function closeShortcuts() {
    if (!shortcutOverlay) return;
    shortcutOverlay.remove();
    shortcutOverlay = null;
    shortcutReturnFocus?.focus();
    shortcutReturnFocus = null;
  }

  function openShortcuts() {
    if (shortcutOverlay) return;
    shortcutReturnFocus = document.activeElement;
    const rows = [
      ['Enter', '发送消息'],
      ['Shift + Enter', '换行'],
      ['@', '呼出成员补全'],
      ['↑ / ↓', '在补全列表中选择'],
      ['Esc', '关闭弹窗、抽屉或图片预览'],
      ['Ctrl + /', '打开这个快捷键面板'],
      ['/shrug', '发送耸肩颜文字'],
      ['/tableflip', '发送掀桌颜文字'],
      ['/unflip', '发送扶桌颜文字'],
    ];
    shortcutOverlay = document.createElement('div');
    shortcutOverlay.className = 'shortcut-overlay';
    shortcutOverlay.setAttribute('role', 'dialog');
    shortcutOverlay.setAttribute('aria-modal', 'true');
    shortcutOverlay.setAttribute('aria-labelledby', 'shortcut-title');
    const card = document.createElement('div');
    card.className = 'shortcut-card';
    const header = document.createElement('div');
    header.className = 'shortcut-header';
    const title = document.createElement('h4');
    title.id = 'shortcut-title';
    title.textContent = '快捷键与快捷指令';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'shortcut-close';
    close.setAttribute('aria-label', '关闭快捷键面板');
    close.textContent = '×';
    close.addEventListener('click', closeShortcuts);
    header.append(title, close);
    card.appendChild(header);
    for (const [key, description] of rows) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const text = document.createElement('span');
      text.textContent = description;
      const keyboard = document.createElement('kbd');
      keyboard.textContent = key;
      row.append(text, keyboard);
      card.appendChild(row);
    }
    shortcutOverlay.appendChild(card);
    shortcutOverlay.addEventListener('pointerdown', event => {
      if (event.target === shortcutOverlay) closeShortcuts();
    });
    document.body.appendChild(shortcutOverlay);
    close.focus();
  }

  function onDocumentKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === '/') {
      event.preventDefault();
      if (shortcutOverlay) closeShortcuts();
      else openShortcuts();
      return;
    }
    if (event.key === 'Escape') {
      if (shortcutOverlay) closeShortcuts();
      closeWeatherMenu();
    }
  }

  function init(options) {
    if (initialized) return;
    initialized = true;
    api = options;
    const input = byId('message-input');
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('keyup', renderMentionPopup);
      input.addEventListener('click', renderMentionPopup);
      input.addEventListener('keydown', onInputKeydown);
      input.addEventListener('blur', () => {
        window.setTimeout(hideMentionPopup, 120);
        sendTyping(false);
      });
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', 'mention-popup');
    }
    initScrollButton();
    initWeather();
    updateInputUi();
    document.addEventListener('keydown', onDocumentKeydown);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pauseWeather();
        sendTyping(false);
      } else {
        resumeWeather();
      }
    });
    reduceMotion.addEventListener?.('change', () => {
      if (reduceMotion.matches) {
        pauseWeather();
        weather.context?.clearRect(0, 0, weather.width, weather.height);
      } else {
        resumeWeather();
      }
    });
    window.setInterval(renderTyping, 1000);
  }

  setTimeMood();
  initLightning();
  initChatFlash();

  window.DooDPolish = {
    afterMessageSent,
    applyWeather,
    beforeRenderMessage,
    clearCoverAccent,
    clearTyping,
    handleTyping,
    handleWeatherState,
    init,
    resetMessageFlow,
    resetTyping,
    setCoverAccent,
    setLoggedIn,
    stopLoginEffects,
    syncTypingUsers,
    updateInputUi,
  };
})();
