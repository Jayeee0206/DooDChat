(() => {
  const canvas = document.getElementById('rain-canvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const context = canvas.getContext('2d');
  const drops = [];
  const dropCount = document.body.dataset.rain === 'heavy' ? 460 : 360;
  let frame = 0;
  let stopped = false;

  function resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * scale));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * scale));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function resetDrop(drop, initial = false) {
    drop.x = Math.random() * window.innerWidth;
    drop.speed = 3 + Math.random() * 7;
    drop.length = 12 + Math.random() * 24;
    drop.opacity = 0.16 + Math.random() * 0.26;
    drop.y = initial ? Math.random() * window.innerHeight : -drop.length;
  }

  for (let index = 0; index < dropCount; index += 1) {
    const drop = {};
    resetDrop(drop, true);
    drops.push(drop);
  }

  function draw() {
    frame = 0;
    const login = document.getElementById('login-container');
    if (stopped || document.hidden || !login || login.style.display === 'none') return;

    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const drop of drops) {
      context.beginPath();
      context.moveTo(drop.x, drop.y);
      context.lineTo(drop.x - 0.5, drop.y + drop.length);
      context.strokeStyle = `rgba(198,218,242,${drop.opacity})`;
      context.lineWidth = 0.9;
      context.stroke();
      drop.y += drop.speed;
      drop.x -= 0.2;
      if (drop.y > window.innerHeight + drop.length) resetDrop(drop);
    }
    frame = requestAnimationFrame(draw);
  }

  function resume() {
    if (!stopped && !frame) frame = requestAnimationFrame(draw);
  }

  window.__stopRain = function stopRain() {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  };

  resize();
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', resume);
  resume();
})();
