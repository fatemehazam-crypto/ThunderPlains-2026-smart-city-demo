'use strict';

/*
 * Stage bridge — runs on the presenter laptop.
 *
 * Connects OUT to the public relay (so the laptop needs no inbound ports),
 * receives already-validated audience events, checks them again, and publishes
 * them to the local Mosquitto over plain TCP MQTT, in exactly the format the
 * backend expects:
 *
 *   topic:   smartcity/<nodeId>/<metric>
 *   payload: {"value": <number>, "unit": "", "collected_ms": <ms epoch>}
 *            (phones add "pings": <taps this second> when they tapped)
 *
 * Keys while running:  o = open joining   c = close joining
 *                      e = end (disconnect every phone)   q = quit
 */

const { io } = require('socket.io-client');
const mqtt = require('mqtt');

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8080';
const JOIN_URL = process.env.JOIN_URL || RELAY_URL; // the address phones open (shown with the QR code)
const STAGE_TOKEN = process.env.STAGE_TOKEN || '';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883'; // TCP, not the 9001 WebSocket listener
const PREFIX = 'smartcity';
// Presenter panel (dashboard Stage tab): commands arrive on stage/command, status goes
// to stage/status/audience (retained). Outside smartcity/#, so sensor ingest never sees it.
// If this process dies, the broker publishes the Last Will below for us. Watch with:
//   mosquitto_sub -t 'stage/#' -v
const COMMAND_TOPIC = 'stage/command';
const STATUS_TOPIC  = 'stage/status/audience';
const LWT_TOPIC     = STATUS_TOPIC;
const OFFLINE_STATUS = JSON.stringify({ online: false });

if (!STAGE_TOKEN) {
  console.error('Set STAGE_TOKEN (same value as on the relay).');
  process.exit(1);
}

// ---------------------------------------------------------------- MQTT
const broker = mqtt.connect(MQTT_URL, {
  clientId: `audience-bridge-${process.pid}`,
  reconnectPeriod: 1000,
  // If this process dies, the broker announces it for us (MQTT Last Will).
  will: { topic: LWT_TOPIC, payload: OFFLINE_STATUS, qos: 1, retain: true },
});
broker.on('connect', () => {
  log(`mqtt connected: ${MQTT_URL}`);
  broker.subscribe(COMMAND_TOPIC);
  publishStatus();
});
broker.on('message', (topic, payload) => {
  if (topic !== COMMAND_TOPIC) return;
  let cmd;
  try { cmd = JSON.parse(payload.toString()); } catch { return; }
  if (cmd?.target !== 'audience' || !['open', 'close', 'end'].includes(cmd.action)) return;
  log(`stage panel: ${cmd.action}`);
  control(cmd.action);
});

let endedAt = null; // when every phone was last disconnected ("end")

// Retained, so the dashboard gets the latest state even if it connects later.
function publishStatus() {
  if (!broker.connected) return;
  const s = lastStats || {};
  broker.publish(STATUS_TOPIC, JSON.stringify({
    online: true,
    relay: relay.connected,
    relayUrl: RELAY_URL,
    joinUrl: JOIN_URL,
    relayError: relay.connected ? null : relayError,
    joinOpen: !!s.joinOpen,
    endedAt,   // set when every phone was disconnected: the dashboard removes them
    devices: s.devices ?? 0,
    waiting: s.waiting ?? 0,
    rejected: (s.rejectedTotal ?? 0) + dropped,
    kicked: s.kicked ?? 0,
    at: Date.now(),
  }), { qos: 1, retain: true });
}
broker.on('error', (err) => log(`mqtt error: ${err.message}`));
broker.on('offline', () => log('mqtt offline, retrying'));

// One metric per node per message, in the backend's payload shape.
function publish(nodeId, metric, value, collectedMs, extra) {
  if (!broker.connected) return;
  broker.publish(
    `${PREFIX}/${nodeId}/${metric}`,
    JSON.stringify({ value, unit: '', collected_ms: collectedMs, ...extra }),
  );
}

// ---------------------------------------------------------------- safety net
// Second check, independent of the relay. Even if the relay or its token were
// compromised, nothing from the internet can publish to a real node id
// (building-c, gps-node, cf-e9...) or send a metric the backend acts on.
const PHONE_ID = /^aud-[a-z]{2,20}-\d{3,6}$/;
const MAX_CLOCK_SKEW_MS = 10000;
let dropped = 0;

function acceptAudienceEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (typeof evt.nodeId !== 'string' || !PHONE_ID.test(evt.nodeId)) return null;
  const m = evt.metrics;
  if (!m || typeof m !== 'object') return null;
  const keys = Object.keys(m);
  if (!keys.includes('activity') || keys.some((k) => k !== 'activity' && k !== 'pings')) return null;
  const a = m.activity;
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 1) return null;
  const pings = m.pings === undefined ? 0 : m.pings;
  if (!Number.isInteger(pings) || pings < 0 || pings > 30) return null;
  const now = Date.now();
  const ts = Number.isFinite(evt.timestamp) && Math.abs(now - evt.timestamp) <= MAX_CLOCK_SKEW_MS
    ? evt.timestamp
    : now;
  return { nodeId: evt.nodeId, activity: a, pings, collectedMs: ts };
}

// ---------------------------------------------------------------- relay
const relay = io(`${RELAY_URL}/stage`, {
  auth: { token: STAGE_TOKEN },
  transports: ['websocket'],
  reconnectionDelayMax: 3000,
});

let relayed = 0;
let lastStats = null;

let relayError = null; // last reason the relay connection failed, shown in the dashboard's Stage tab
relay.on('connect', () => { relayError = null; log(`relay connected: ${RELAY_URL}`); publishStatus(); });
relay.on('connect_error', (err) => {
  const changed = relayError !== err.message;
  relayError = err.message;
  log(`relay connect error: ${err.message}`);
  if (changed) publishStatus();
});
relay.on('disconnect', (reason) => { log(`relay disconnected (${reason}), retrying`); publishStatus(); });

relay.on('event', (evt) => {
  const ok = acceptAudienceEvent(evt);
  if (!ok) { dropped += 1; return; }
  relayed += 1;
  // Taps ride in the same message as "pings", so it's still one message per phone per second.
  publish(ok.nodeId, 'activity', ok.activity, ok.collectedMs, ok.pings > 0 ? { pings: ok.pings } : undefined);
});

relay.on('stats', (s) => {
  const changed = !lastStats || s.rejectedTotal !== lastStats.rejectedTotal;
  lastStats = s;
  statusLine();
  publishStatus();
  if (changed && s.rejectedTotal > 0) {
    const reasons = Object.entries(s.rejected).map(([k, v]) => `${k}=${v}`).join(' ');
    log(`rejected so far: ${reasons}`);
  }
});

// Status nodes heartbeat once a second (the backend flags gaps over 2 s), each
// with exactly ONE metric (two in the same second would look like a bulk send).
// They only publish while the relay link is up, so if the link dies the
// dashboard's own watchdog sees them go silent.
setInterval(() => {
  if (!relay.connected) return;
  const now = Date.now();
  publish('audience-bridge', 'relayed', relayed, now);
  if (lastStats) {
    publish('audience-devices', 'count', lastStats.devices, now);
    publish('audience-rejected', 'count', lastStats.rejectedTotal + dropped, now);
  }
}, 1000);

// ---------------------------------------------------------------- keyboard
function control(action) {
  relay.timeout(3000).emit('control', { action }, (err, res) => {
    if (err) return log(`control "${action}" timed out`);
    log(`control "${action}": ${res && res.ok ? 'ok' : JSON.stringify(res)}`);
    if (action === 'end' && res?.ok) { endedAt = Date.now(); publishStatus(); }
  });
}

if (process.stdin.isTTY) {
  require('readline').emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') shutdown();
    else if (str === 'o') control('open');
    else if (str === 'c') control('close');
    else if (str === 'e') control('end');
    else if (str === 'q') shutdown();
  });
  log('keys: o=open  c=close  e=end  q=quit');
}

function statusLine() {
  if (!lastStats || !process.stdout.isTTY) return; // the stage launcher pipes output; skip the live line there
  const s = lastStats;
  process.stdout.write(
    `\r  devices ${String(s.devices).padStart(3)}  waiting ${String(s.waiting).padStart(3)}  ` +
      `joining ${s.joinOpen ? 'OPEN  ' : 'closed'}  accepted ${s.accepted}  rejected ${s.rejectedTotal}  ` +
      `kicked ${s.kicked}  bridge-dropped ${dropped}   `,
  );
}
// Piped (stage launcher): end each line with a newline so it shows up immediately.
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  process.stdout.write(process.stdout.isTTY ? `\n${line}` : `${line}\n`);
}
function shutdown() {
  log('shutting down');
  broker.publish(LWT_TOPIC, OFFLINE_STATUS, { qos: 1, retain: true }, () => {
    broker.end(false, () => process.exit(0));
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
