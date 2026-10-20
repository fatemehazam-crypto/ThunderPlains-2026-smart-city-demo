(() => {
  const $ = (id) => document.getElementById(id);
  const show = (...ids) => ids.forEach((id) => { $(id).hidden = false; });
  const hide = (...ids) => ids.forEach((id) => { $(id).hidden = true; });

  const INTRO = ['v-intro', 'intro-copy', 'intro-fine', 'join'];
  const MSG = ['v-msg', 'msg-copy'];
  const LIVE = ['v-live', 'storm', 'join-order', 'live-rule', 'status', 'readout', 'tap', 'leave-note'];

  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // "supercell-017" → storm card for "supercell", and "17th phone to join"
  function showStorm(label) {
    const [word, num] = String(label).split('-');
    const storm = (typeof STORMS !== 'undefined' && STORMS[word]) || null;
    if (storm) {
      $('storm-icon').innerHTML = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + storm.svg + '</svg>';
      $('storm-title').textContent = storm.title;
      $('storm-text').textContent = storm.meaning;
    }
    $('storm').hidden = !storm;
    const n = parseInt(num, 10);
    $('join-order').textContent = Number.isFinite(n)
      ? `You were the ${ordinal(n)} phone to join. Every node gets a storm name: this is ThunderPlains, after all.`
      : '';
    $('join-order').hidden = !Number.isFinite(n);
  }

  let socket = null;
  let sendTimer = null;
  let peakShake = 0;        // highest shake seen since the last send
  let displayShake = 0;     // smoothed value for the meter
  let tapsPending = 0;
  let tapsTotal = 0;
  let motionOn = false;

  function message(title, copy) {
    hide(...INTRO, ...LIVE, 'motion-note');
    $('msg-title').textContent = title;
    $('msg-copy').textContent = copy;
    show(...MSG);
  }

  // ---------------------------------------------------------------- motion
  async function startMotion() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const answer = await DeviceMotionEvent.requestPermission(); // iOS, needs the tap
        if (answer !== 'granted') return false;
      }
    } catch { return false; }
    window.addEventListener('devicemotion', (e) => {
      let mag = 0;
      const a = e.acceleration;
      if (a && a.x != null) {
        mag = Math.hypot(a.x, a.y, a.z);
      } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
        const g = e.accelerationIncludingGravity;
        mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
      }
      const level = Math.min(1, mag / 20); // a hard shake is roughly 20 m/s²
      if (level > peakShake) peakShake = level;
      if (level > displayShake) displayShake = level;
    });
    return true;
  }

  function animateMeter() {
    displayShake *= 0.9;
    const pct = Math.round(displayShake * 100);
    $('meter-fill').style.width = pct + '%';
    $('meter').setAttribute('aria-valuenow', String(pct));
    requestAnimationFrame(animateMeter);
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* optional */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket && socket.connected) keepAwake();
  });

  // ---------------------------------------------------------------- telemetry
  function startSending() {
    stopSending();
    sendTimer = setInterval(() => {
      if (!socket || !socket.connected) return;
      socket.emit('telemetry', {
        shake: Math.round(peakShake * 100) / 100,
        taps: Math.min(tapsPending, 30),
        ts: Date.now(), // stamped at the source
      });
      tapsTotal += Math.min(tapsPending, 30);
      $('taps-total').textContent = String(tapsTotal);
      tapsPending = 0;
      peakShake = 0;
      const dot = $('dot');
      dot.classList.remove('beat');
      void dot.offsetWidth; // restart the animation
      dot.classList.add('beat');
    }, 1000);
  }
  function stopSending() { if (sendTimer) clearInterval(sendTimer); sendTimer = null; }

  function setStatus(kind, text) {
    const s = $('status');
    s.classList.toggle('live', kind === 'live');
    s.classList.toggle('down', kind === 'down');
    $('status-text').textContent = text;
  }

  // ---------------------------------------------------------------- join
  $('join').addEventListener('click', async () => {
    $('join').disabled = true;
    $('join').textContent = 'Joining';
    motionOn = await startMotion();
    keepAwake();

    socket = io({ reconnectionAttempts: 10 });

    socket.on('status', (msg) => {
      switch (msg && msg.state) {
        case 'live':
          hide(...INTRO, ...MSG);
          $('label').textContent = msg.label;
          show(...LIVE);
          showStorm(msg.label);
          if (!motionOn) show('motion-note');
          setStatus('live', 'Live, sending every second');
          startSending();
          break;
        case 'waiting':
          message('Hold tight', 'Joining opens during the talk. Keep this page open and you\'ll go live automatically.');
          break;
        case 'paused':
          stopSending();
          message('Hold tight', 'The stage is reconnecting. Keep this page open and you\'ll be back live automatically.');
          break;
        case 'full':
          stopSending();
          message('The testbed is full', 'Every node slot is taken. Watch the stage to see the swarm.');
          break;
        case 'ended':
          stopSending();
          message('Testbed closed', 'Thanks for being a node.');
          break;
        case 'kicked':
          stopSending();
          message('Disconnected', 'This node sent too many invalid messages, so the edge dropped it. Nice try.');
          break;
      }
    });

    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') return; // handled by a status message
      setStatus('down', 'Signal lost, reconnecting');
    });
    socket.io.on('reconnect_failed', () => {
      stopSending();
      message('Can\'t reach the testbed', 'Check your connection, then reload this page to rejoin.');
    });
    socket.on('connect_error', () => setStatus('down', 'Can\'t reach the testbed, retrying'));
  });

  $('tap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tapsPending += 1;
    if (navigator.vibrate) navigator.vibrate(12);
  });
  // Keyboard users: Enter/Space fire click, not pointerdown.
  $('tap').addEventListener('click', (e) => { if (e.detail === 0) tapsPending += 1; });

  requestAnimationFrame(animateMeter);
})();
