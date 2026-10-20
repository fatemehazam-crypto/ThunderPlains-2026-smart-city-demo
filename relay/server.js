'use strict';

/*
 * Audience relay — the public "edge" for untrusted devices.
 *
 * Phones connect here (default namespace) and send one `telemetry` message per
 * second. The relay assigns every phone its node id, validates and rate-limits
 * each message, normalizes it into the unified event shape, and forwards it to
 * the stage bridge (/stage namespace, token-protected), which publishes it onto
 * the local MQTT bus. Phones never touch the bus directly.
 *
 * Run exactly ONE instance: all state is in memory.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 8080;
const STAGE_TOKEN = process.env.STAGE_TOKEN || '';
// Render sets RENDER_EXTERNAL_URL for you; the launcher sets PUBLIC_URL to your laptop's Wi-Fi address.
const PUBLIC_URL_SET = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const PUBLIC_URL = PUBLIC_URL_SET || `http://localhost:${PORT}`;
const MAX_DEVICES = Number(process.env.MAX_DEVICES) || 300;
const MAX_SKEW_MS = Number(process.env.MAX_SKEW_MS) || 5000;
const MAX_STRIKES = 20;               // bad messages before a socket is kicked
const BUCKET = { capacity: 4, refillPerSec: 2 }; // honest phones send 1/s
let joinOpen = process.env.JOIN_OPEN === 'true';

if (STAGE_TOKEN.length < 16) {
  console.error('Set STAGE_TOKEN to a random string of 16+ characters.');
  process.exit(1);
}

// Only enforce Origin when PUBLIC_URL was set explicitly. Non-browser clients
// (the bridge, scripts) send no Origin and are allowed; validation is the real
// defense, not this check.
const ALLOWED_ORIGIN = PUBLIC_URL_SET ? new URL(PUBLIC_URL).origin : null;

// Storm-themed labels, so nothing an attendee types ever reaches the projector.
const WORDS = [
  'supercell', 'derecho', 'dryline', 'anvil', 'updraft', 'downdraft',
  'wallcloud', 'hailstone', 'squall', 'gustfront', 'mesocyclone', 'cumulus',
  'outflow', 'shelfcloud', 'mammatus', 'bolt', 'thunder', 'stormcell',
];

// ---------------------------------------------------------------- state
const admitted = new Map(); // socket.id -> device record
const waiting = new Set();  // sockets connected before joining opened
let nextIndex = 1;
const stats = {
  accepted: 0,
  clockAdjusted: 0,
  kicked: 0,
  rejected: {}, // reason -> count
};

function reject(socket, reason) {
  if (socket.data.kicked) return; // already dropped; ignore whatever is still in flight
  stats.rejected[reason] = (stats.rejected[reason] || 0) + 1;
  socket.data.strikes = (socket.data.strikes || 0) + 1;
  if (socket.data.strikes >= MAX_STRIKES) {
    socket.data.kicked = true;
    stats.kicked += 1;
    socket.emit('status', { state: 'kicked' });
    socket.disconnect(true);
  }
}

function takeToken(dev, now) {
  const elapsed = (now - dev.bucketAt) / 1000;
  dev.tokens = Math.min(BUCKET.capacity, dev.tokens + elapsed * BUCKET.refillPerSec);
  dev.bucketAt = now;
  if (dev.tokens < 1) return false;
  dev.tokens -= 1;
  return true;
}

const ALLOWED_KEYS = ['shake', 'taps', 'ts'];
function validate(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not_object';
  const keys = Object.keys(p);
  if (keys.length !== ALLOWED_KEYS.length || !ALLOWED_KEYS.every((k) => keys.includes(k))) {
    return 'wrong_fields';
  }
  if (typeof p.shake !== 'number' || !Number.isFinite(p.shake) || p.shake < 0 || p.shake > 1) {
    return 'bad_shake';
  }
  if (!Number.isInteger(p.taps) || p.taps < 0 || p.taps > 30) return 'bad_taps';
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return 'bad_timestamp';
  return null;
}

// Normalize into the same shape every other device on the bus uses.
// One metric per phone per heartbeat: two messages in the same second look like
// a bulk send to the backend. Taps fold into the same 0–1 activity level.
// Severity and type are decided HERE, never by the client.
function normalize(dev, p, now) {
  let timestamp = p.ts;
  if (Math.abs(now - p.ts) > MAX_SKEW_MS) {
    // Trust the source clock only when it's plausible; otherwise the edge stamps it.
    timestamp = now;
    stats.clockAdjusted += 1;
  }
  const activity = Math.round(Math.max(p.shake, Math.min(1, p.taps / 5)) * 100) / 100;
  return {
    nodeId: dev.nodeId,
    type: 'audience',
    metrics: { activity, pings: p.taps },
    severity: activity >= 0.85 ? 'warning' : 'info',
    timestamp,
  };
}

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, devices: admitted.size, joinOpen, bridgeConnected: stageUp() });
});

let qrCache = null;
app.get('/qr.svg', async (req, res) => {
  try {
    qrCache = qrCache || (await QRCode.toString(PUBLIC_URL, { type: 'svg', margin: 2 }));
    res.type('image/svg+xml').send(qrCache);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2048, // a telemetry message is ~50 bytes
  pingInterval: 10000,
  pingTimeout: 8000,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    cb(null, !ALLOWED_ORIGIN || !origin || origin === ALLOWED_ORIGIN);
  },
});

// ---------------------------------------------------------------- stage
const stage = io.of('/stage');
// Phones only go live while a bridge is connected; otherwise their data would go nowhere.
const stageUp = () => stage.sockets.size > 0;
stage.use((socket, next) => {
  const given = Buffer.from(String(socket.handshake.auth?.token || ''));
  const expected = Buffer.from(STAGE_TOKEN);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  return ok ? next() : next(new Error('unauthorized'));
});

stage.on('connection', (socket) => {
  console.log(`[stage] bridge connected (${socket.id})`);
  for (const [id, dev] of admitted) devices.sockets.get(id)?.emit('status', { state: 'live', label: dev.label });
  if (joinOpen) { for (const s of waiting) admit(s); waiting.clear(); }
  socket.emit('stats', snapshot());

  socket.on('control', (msg, ack) => {
    const action = msg && msg.action;
    if (action === 'open') {
      joinOpen = true;
      for (const s of waiting) admit(s);
      waiting.clear();
    } else if (action === 'close') {
      joinOpen = false;
    } else if (action === 'end') {
      joinOpen = false;
      for (const s of devices.sockets.values()) {
        s.emit('status', { state: 'ended' });
        s.disconnect(true);
      }
    } else {
      if (typeof ack === 'function') ack({ ok: false, error: 'unknown action' });
      return;
    }
    console.log(`[stage] ${action}`);
    broadcastStats();
    if (typeof ack === 'function') ack({ ok: true, joinOpen });
  });

  socket.on('disconnect', () => {
    console.log('[stage] bridge disconnected');
    if (stageUp()) return; // another bridge is still connected
    for (const id of admitted.keys()) devices.sockets.get(id)?.emit('status', { state: 'paused' });
    broadcastStats();
  });
});

function snapshot() {
  return {
    devices: admitted.size,
    waiting: waiting.size,
    joinOpen,
    accepted: stats.accepted,
    clockAdjusted: stats.clockAdjusted,
    kicked: stats.kicked,
    rejected: { ...stats.rejected },
    rejectedTotal: Object.values(stats.rejected).reduce((a, b) => a + b, 0),
  };
}
function broadcastStats() {
  stage.emit('stats', snapshot());
}
setInterval(broadcastStats, 2000).unref();

// ---------------------------------------------------------------- devices
const devices = io.of('/');

function admit(socket) {
  if (!socket.connected) return;
  if (admitted.size >= MAX_DEVICES) {
    socket.emit('status', { state: 'full' });
    socket.disconnect(true);
    return;
  }
  const n = nextIndex++;
  const label = `${WORDS[n % WORDS.length]}-${String(n).padStart(3, '0')}`;
  const now = Date.now();
  admitted.set(socket.id, {
    nodeId: `aud-${label}`,
    label,
    tokens: BUCKET.capacity,
    bucketAt: now,
  });
  socket.emit('status', { state: 'live', label });
}

devices.on('connection', (socket) => {
  if (joinOpen && stageUp()) admit(socket);
  else {
    waiting.add(socket);
    socket.emit('status', { state: 'waiting' });
  }

  // One router for every incoming event, so unknown event names get counted too.
  socket.onAny((event, payload) => {
    if (socket.data.kicked) return;
    if (event !== 'telemetry') return void reject(socket, 'unknown_event');
    const dev = admitted.get(socket.id);
    if (!dev) return void reject(socket, 'not_admitted');
    if (!stageUp()) return; // bridge offline: phone is paused, drop quietly

    const now = Date.now();
    if (!takeToken(dev, now)) return void reject(socket, 'rate_limited');

    const problem = validate(payload);
    if (problem) return void reject(socket, problem);

    stats.accepted += 1;
    stage.emit('event', normalize(dev, payload, now));
  });

  socket.on('disconnect', () => {
    waiting.delete(socket);
    admitted.delete(socket.id);
    // Deliberately no "offline" event: silence is the signal, and the
    // dashboard's watchdog is the thing that notices it.
  });
});

server.listen(PORT, () => {
  console.log(`relay listening on :${PORT}  public url: ${PUBLIC_URL}  joining ${joinOpen ? 'open' : 'closed'}`);
});
