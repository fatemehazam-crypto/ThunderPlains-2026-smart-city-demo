'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mqtt     = require('mqtt');
const dgram    = require('dgram');
// Node's built-in SQLite (Node 22.13+): nothing to compile, works the same on Mac, Windows, Linux.
const { DatabaseSync } = require('node:sqlite');
// Alerting policy (when alerts fire, clear and group) lives in config/alerting.json, not in this file.
// It is checked first: a mistake there stops the backend with a clear message instead of running wrong.
let alerting;
try { alerting = require('./config/alerting'); }
catch (e) { if (e.code !== 'ALERTING_POLICY_INVALID') throw e; console.error(`\n❌ ${e.message}\n`); process.exit(1); }
const { policy: POLICY, ruleTiming, clearMargin } = alerting;
const { missionTracker, MIN_AIRBORNE_Z } = require('./mission-tracker');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── Layout file ──────────────────────────────────────────────────────────────
const LAYOUT_FILE = path.join(__dirname, 'layout.json');

// ─── Database ─────────────────────────────────────────────────────────────────
const DB_DIR  = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'smartcity.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id   TEXT NOT NULL,
    metric    TEXT NOT NULL,
    value     REAL,
    unit      TEXT,
    timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sr_node_metric_ts ON sensor_readings (node_id, metric, timestamp);

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    node_id   TEXT,
    message   TEXT,
    severity  TEXT DEFAULT 'info',
    timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS rf_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id    TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail     TEXT,
    timestamp  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

console.log(`✅ Database ready: ${DB_PATH}`);

// ─── Auto-cleanup sensor readings older than 7 days ───────────────────────────
function cleanupOldData() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM sensor_readings WHERE timestamp < ?`).run(cutoff);
  if (result.changes > 0) console.log(`🧹 Cleaned up ${result.changes} sensor readings`);
  // Retention for the event tables too: they used to grow forever.
  const rfCut = db.prepare(`DELETE FROM rf_events WHERE timestamp < ?`).run(cutoff);
  if (rfCut.changes > 0) console.log(`🧹 Cleaned up ${rfCut.changes} RF timing events`);
  const evCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const evCut = db.prepare(`DELETE FROM events WHERE timestamp < ?`).run(evCutoff);
  if (evCut.changes > 0) console.log(`🧹 Cleaned up ${evCut.changes} events older than 30 days`);
}
cleanupOldData();
setInterval(cleanupOldData, 6 * 60 * 60 * 1000);

// ─── DB helpers ───────────────────────────────────────────────────────────────
function dbRun(sql, params = []) { try { db.prepare(sql).run(...params); } catch(e) { console.warn('DB run error:', e.message); } }
function dbAll(sql, params = []) { try { return db.prepare(sql).all(...params); } catch(e) { console.warn('DB query error:', e.message); return []; } }
function dbGet(sql, params = []) { try { return db.prepare(sql).get(...params); } catch(e) { console.warn('DB get error:', e.message); return null; } }

// ─── Default nodes ────────────────────────────────────────────────────────────
const DEFAULT_NODES = {
  'building-a':   { label:'Building A',   type:'hub',           metrics:['video_fps','audio_db','wifi_rssi'],                       rfFrequency:'2.4ghz',   publishIntervalMs:1000, thresholds:{} },
  'building-b':   { label:'Building B',   type:'environmental', metrics:['temperature','humidity','wifi_rssi','alerts_433'],        rfFrequency:'2.4ghz',   publishIntervalMs:1000, thresholds:{} },
  'building-c':   { label:'Building C',   type:'medical',       metrics:['heart_rate','spo2','wifi_rssi'],                         rfFrequency:'2.4ghz',   publishIntervalMs:1000, thresholds:{} },
  'building-d':   { label:'Building D',   type:'automation',    metrics:['plug_state','wifi_rssi'],                                rfFrequency:'2.4ghz',   publishIntervalMs:1000, thresholds:{} },
  'intersection': { label:'Intersection', type:'traffic',       metrics:['light_state','wifi_rssi'],                               rfFrequency:'2.4ghz',   publishIntervalMs:1000, thresholds:{} },
  'perimeter':    { label:'Perimeter',    type:'security',      metrics:['motion_detected','door_open','signal_433'],              rfFrequency:'433mhz',   publishIntervalMs:500,  thresholds:{} },
  'gps-node':     { label:'GPS Node',     type:'gps',           metrics:['satellites','snr_l1','snr_l5','lock_status','lat','lng'],rfFrequency:'gps-l1l5', publishIntervalMs:1000, thresholds:{} },
  'cf-e9':        { label:'Crazyflie E9', type:'drone',         metrics:['x','y','z','yaw','battery','rssi'],                     rfFrequency:'2.4ghz',   publishIntervalMs:600,  thresholds:{} },
  'cf-e8':        { label:'Crazyflie E8', type:'drone',         metrics:['x','y','z','yaw','battery','rssi'],                     rfFrequency:'2.4ghz',   publishIntervalMs:600,  thresholds:{} },
  // Phones are no longer fixed slots: any phone that actually publishes
  // (phone.html → smartcity/phoneN/..., or the audience relay → smartcity/aud-*/...)
  // registers itself and is never simulated by demo mode.
};

// ─── Config ───────────────────────────────────────────────────────────────────
// Starting thresholds come from config/alerting.json; the Settings tab changes them while running.
let CONFIG = { ...POLICY.thresholds };

// ─── Live state ───────────────────────────────────────────────────────────────
let NODES = { ...DEFAULT_NODES };
let currentLayout = null;
let nodeState = {}, watchdogTimers = {}, packetCounters = {}, lastMetrics = {}, rfHealth = {}, timestampHistory = {};
let mqttClient = null, demoInterval = null;

// ─── Drone state ──────────────────────────────────────────────────────────────
let droneState = {}, droneWatchdogTimers = {}, droneMissions = {};
const DRONE_TELEMETRY_TIMEOUT_MS = POLICY.drones.telemetryTimeoutMs;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function logEvent(type, nodeId, message, severity = 'info') {
  dbRun(`INSERT INTO events (type, node_id, message, severity) VALUES (?, ?, ?, ?)`, [type, nodeId, message, severity]);
  const event = { type, node_id: nodeId, message, severity, timestamp: new Date().toISOString() };
  io.emit('event:new', event);
  emitEventStats();
}

// Event counts for the live session (since the backend started or the last Reset), counted in the
// database itself so the dashboard's numbers always match what was actually logged.
let eventStatsTimer = null;
function eventStats() {
  const rows = dbAll(`SELECT severity, COUNT(*) AS n FROM events WHERE rowid > ? GROUP BY severity`, [eventsResetRowid]);
  const by = Object.fromEntries(rows.map(r => [r.severity, r.n]));
  return { total: rows.reduce((t, r) => t + r.n, 0), critical: by.critical || 0, warning: by.warning || 0, info: by.info || 0 };
}
function emitEventStats() {
  if (eventStatsTimer) return;
  eventStatsTimer = setTimeout(() => { eventStatsTimer = null; io.emit('events:stats', eventStats()); }, 300);
}

function logRfEvent(nodeId, eventType, detail = {}) {
  if (typeof isInjectionTarget === 'function' && !DEMO_MODE && isInjectionTarget(nodeId)) detail = { ...detail, simulated: true };
  dbRun(`INSERT INTO rf_events (node_id, event_type, detail) VALUES (?, ?, ?)`, [nodeId, eventType, JSON.stringify(detail)]);
}

function getUnit(metric) {
  const units = { temperature:'°C', humidity:'%', wifi_rssi:'dBm', signal_433:'dBm', heart_rate:'bpm', spo2:'%', satellites:'', snr_l1:'dB-Hz', snr_l5:'dB-Hz', lat:'°', lng:'°', video_fps:'fps', audio_db:'dB', x:'m', y:'m', z:'m', yaw:'°', battery:'V' };
  return units[metric] || '';
}

function getThreshold(nodeId, key) {
  return NODES[nodeId]?.thresholds?.[key] ?? CONFIG[key];
}

// ─── Stage control (presenter panel) ─────────────────────────────────────────
// The dashboard's Stage tab sends commands here. Interference and reset happen in
// this process; audience and replay commands go out on the bus as events
// (stage/command) and the bridge / stage agent act on them. They report back on
// stage/status/<name>, which is relayed to the dashboard. None of this touches
// smartcity/#, so sensor ingest never sees it.
const STAGE_COMMAND_TOPIC = 'stage/command';
const INTERFERENCE_PRESETS = {
  wifi: { rssiThreshold: -50 },   // demo RSSI sits around -45..-60 dBm, so most nodes trip
  gps:  { snrL1Threshold: 50 },   // demo L1 SNR sits around 35..45 dB-Hz
};
const stageStatus = { audience: null, replay: null, interference: { wifi: false, gps: false },
  interferenceMode: 'simulated' };
const interferenceSaved = {};
// Events at or below this rowid belong to earlier sessions: the live dashboard starts at backend
// startup (and again at each Reset). Everything stays in the database and the Data Explorer.
let eventsResetRowid = dbGet('SELECT MAX(rowid) AS m FROM events')?.m || 0;

function emitStageStatus() { io.emit('stage:status', stageStatus); }

function applyConfigUpdate(updates) {
  CONFIG = { ...CONFIG, ...updates };
  if (updates.watchdogTimeout) Object.keys(NODES).forEach(id => { if (nodeState[id]?.status==='online') resetWatchdog(id); });
  io.emit('config:current', CONFIG);
  logEvent('system', null, `Config updated: ${Object.keys(updates).join(', ')}`, 'info');
}

function setInterference(kind, on) {
  const preset = INTERFERENCE_PRESETS[kind];
  if (!preset || stageStatus.interference[kind] === on) return;
  if (true) {
    // Simulate the interference itself, in demo mode (simulated nodes) AND on live sensors (fault
    // injection at ingest). Thresholds stay where you set them; nothing is transmitted.
    simInterference[kind] = on;
    if (on) {
      simStartedAt[kind] = Date.now();
      for (const k of Object.keys(simNodeDelay)) if (k.startsWith(kind + '|')) delete simNodeDelay[k];
    }
    logEvent('system', null, `${kind === 'gps' ? 'GPS' : '2.4 GHz'} interference simulation ${on ? 'started' : 'stopped'}${DEMO_MODE ? '' : ' on live sensor readings (nothing is transmitted)'}`, 'info');
  } else if (on) {
    interferenceSaved[kind] = Object.fromEntries(Object.keys(preset).map(k => [k, CONFIG[k]]));
    applyConfigUpdate(preset);
  } else {
    applyConfigUpdate(interferenceSaved[kind]);
  }
  stageStatus.interference[kind] = on;
  emitStageStatus();
}

// Fresh slate between rehearsals: hides earlier events from the live view (the
// database keeps everything), clears drone state and missions, ends interference.
function resetDashboard() {
  setInterference('wifi', false);
  setInterference('gps', false);
  eventsResetRowid = dbGet('SELECT MAX(rowid) AS m FROM events')?.m || 0;
  io.emit('events:stats', eventStats());
  Object.values(droneWatchdogTimers).forEach(t => clearTimeout(t));
  for (const k of Object.keys(droneWatchdogTimers)) delete droneWatchdogTimers[k];
  for (const k of Object.keys(droneState)) { missionTracker.reset(k); delete droneState[k]; }
  for (const k of Object.keys(droneMissions)) delete droneMissions[k]; // mutate: routes hold this object
  for (const id of Object.keys(rfHealth)) {           // fresh RF picture for every node
    const h = rfHealth[id];
    Object.assign(h, { gapCount:0, bulkSendCount:0, transmissionRhythm:[], rssiHistory:[], signalHistory:[], recentGaps:0, recentBulks:0, disruptionType:'none', lastRecoveryMs:null });
    if (timestampHistory[id]) timestampHistory[id] = [];
    h.collectedMsHistory = [];
  }
  io.emit('rfhealth:full', rfHealth);
  for (const k of Object.keys(activeAlerts)) delete activeAlerts[k];
  for (const b of Object.keys(incidents)) { clearTimeout(incidents[b].timer); delete incidents[b]; }
  io.emit('alerts:active', activeAlertList());
  purgeAllAudiencePhones('dashboard reset'); // phones still live come back with their next message
  io.emit('stage:reset');
  io.emit('drone:state', droneState);
  emitStageStatus();
}

function handleStageStatus(name, payload) {
  if (!['audience', 'replay'].includes(name)) return;
  const prev = stageStatus[name];
  let next;
  try { next = JSON.parse(payload.toString()); } catch { return; }
  stageStatus[name] = next;
  if (name === 'audience') {
    // The bridge ended the session (Stage tab or its e key): phones leave the dashboard now.
    if (next?.endedAt && next.endedAt !== prev?.endedAt) {
      audienceEndedUntil = Date.now() + AUDIENCE_END_GUARD_MS;
      purgeAllAudiencePhones('session ended');
    }
    // A bridge just started: phones left over from an earlier run are cleared.
    // Phones still connected to the relay reappear with their next message.
    else if (next?.online && !prev?.online) purgeAllAudiencePhones('bridge started');
  }
  emitStageStatus();
}

function handleStageCommand(cmd, done) {
  const { target, action, args } = cmd || {};
  if (target === 'interference' && (action === 'on' || action === 'off') && INTERFERENCE_PRESETS[args?.kind]) {
    setInterference(args.kind, action === 'on');
    return done({ ok: true });
  }
  if (target === 'dashboard' && action === 'reset') {
    if (mqttClient?.connected) mqttClient.publish(STAGE_COMMAND_TOPIC, JSON.stringify({ target: 'replay', action: 'stop', at: Date.now() }));
    resetDashboard();
    return done({ ok: true });
  }
  const forBus = (target === 'audience' && ['open', 'close', 'end'].includes(action))
              || (target === 'replay'   && ['start', 'stop'].includes(action));
  if (!forBus) return done({ ok: false, error: 'unknown command' });
  if (!mqttClient?.connected) return done({ ok: false, error: 'MQTT broker not connected' });
  const safeArgs = target === 'replay' && action === 'start'
    ? { speed: Math.min(8, Math.max(0.5, Number(args?.speed) || 1)) }
    : undefined;
  mqttClient.publish(STAGE_COMMAND_TOPIC, JSON.stringify({ target, action, args: safeArgs, at: Date.now() }));
  done({ ok: true });
}

// ─── Audience demo nodes (ThunderPlains) ─────────────────────────────────────
// Everything here applies ONLY to node ids starting with "aud-" (audience
// phones, via the relay + bridge) or "audience-" (the bridge's status nodes).
// Every other node goes through exactly the same code path as before.
const AUDIENCE_WATCHDOG_MS     = POLICY.audience.watchdogMs;     // config/alerting.json (env AUDIENCE_WATCHDOG_MS still wins)
const AUDIENCE_STORM_WINDOW_MS = POLICY.audience.stormWindowMs;
const AUDIENCE_STORM_THRESHOLD = POLICY.audience.stormMinPhones;
// Phones that go silent stay on the dashboard (offline) until you end the session with
// "Disconnect all phones" (Stage tab or bridge key e). Set AUDIENCE_AUTO_PURGE_MS to also
// remove them automatically after that long offline. (The old AUDIENCE_PURGE_MS is ignored.)
const AUDIENCE_AUTO_PURGE_MS   = POLICY.audience.autoPurgeMs;    // env AUDIENCE_AUTO_PURGE_MS still wins
const AUDIENCE_END_GUARD_MS    = POLICY.audience.endGuardMs; // after "end", ignore phone messages still in flight
let audienceEndedUntil = 0;

const isAudiencePhone = id => typeof id === 'string' && id.startsWith('aud-');
const isAudienceInfra = id => typeof id === 'string' && id.startsWith('audience-');
const isAudienceNode  = id => isAudiencePhone(id) || isAudienceInfra(id);

const audienceWatchdogs = {}, audiencePurgeTimers = {};
let audienceSilent = [], audienceStormTimer = null, audienceStateTimer = null;

// Registers ONE audience node without touching any other node's state.
function registerAudienceNode(nodeId) {
  const phone = isAudiencePhone(nodeId);
  NODES[nodeId] = {
    label: phone ? `Phone ${nodeId.slice(4)}` : nodeId,
    type: phone ? 'phone' : 'dynamic',
    metrics: [], rfFrequency: phone ? 'wifi' : 'unknown',
    publishIntervalMs: 1000, thresholds: {},
    autoRegistered: true,
  };
  ensureNodeState(nodeId);
  io.emit('node:update', { nodeId, metrics:{}, status:'offline', lastSeen:null, packetLoss:0 });
}

// Phones get their own short watchdog. When it fires, the phone goes offline
// on the dashboard and is queued for the storm check below.
function resetAudienceWatchdog(nodeId) {
  clearTimeout(audienceWatchdogs[nodeId]);
  clearTimeout(audiencePurgeTimers[nodeId]);
  delete audiencePurgeTimers[nodeId];
  audienceWatchdogs[nodeId] = setTimeout(() => {
    delete audienceWatchdogs[nodeId];
    if (nodeState[nodeId]?.status !== 'online') return;
    nodeState[nodeId].status = 'offline';
    io.emit('node:update', { nodeId, metrics:{}, status:'offline', lastSeen:nodeState[nodeId].lastSeen, packetLoss:nodeState[nodeId].packetLoss });
    queueAudienceSilence(nodeId);
    if (AUDIENCE_AUTO_PURGE_MS > 0) audiencePurgeTimers[nodeId] = setTimeout(() => purgeAudienceNode(nodeId), AUDIENCE_AUTO_PURGE_MS);
  }, AUDIENCE_WATCHDOG_MS);
}

// Many phones going silent together becomes ONE critical event, not hundreds.
function queueAudienceSilence(nodeId) {
  audienceSilent.push(nodeId);
  if (audienceStormTimer) return;
  audienceStormTimer = setTimeout(() => {
    const lost = audienceSilent;
    audienceSilent = []; audienceStormTimer = null;
    if (lost.length >= AUDIENCE_STORM_THRESHOLD) {
      logEvent('watchdog', 'audience-swarm', `${lost.length} audience phones went silent within ${AUDIENCE_STORM_WINDOW_MS / 1000}s`, 'critical');
    } else {
      lost.forEach(id => logEvent('watchdog', id, `${NODES[id]?.label || id} went silent`, 'info'));
    }
  }, AUDIENCE_STORM_WINDOW_MS);
}

// Phones that stay offline are removed so the dashboard doesn't keep
// hundreds of dead cards. Clients get one refreshed full state per batch.
function purgeAudienceNode(nodeId) {
  delete audiencePurgeTimers[nodeId];
  if (!isAudiencePhone(nodeId) || !NODES[nodeId] || nodeState[nodeId]?.status === 'online') return;
  delete NODES[nodeId]; delete nodeState[nodeId]; delete rfHealth[nodeId];
  delete packetCounters[nodeId]; delete lastMetrics[nodeId]; delete timestampHistory[nodeId];
  if (audienceStateTimer) return;
  audienceStateTimer = setTimeout(() => {
    audienceStateTimer = null;
    io.emit('state:full', { nodes:nodeState, nodeDefinitions:NODES, droneState });
  }, 1000);
}

// "Disconnect all phones": every phone leaves the dashboard at once, online or not.
function purgeAllAudiencePhones(reason) {
  const ids = Object.keys(NODES).filter(isAudiencePhone);
  for (const id of ids) {
    clearTimeout(audienceWatchdogs[id]); delete audienceWatchdogs[id];
    clearTimeout(audiencePurgeTimers[id]); delete audiencePurgeTimers[id];
    delete NODES[id]; delete nodeState[id]; delete rfHealth[id];
    delete packetCounters[id]; delete lastMetrics[id]; delete timestampHistory[id];
  }
  audienceSilent = audienceSilent.filter(id => !isAudiencePhone(id));
  clearTimeout(audienceStateTimer); audienceStateTimer = null;
  io.emit('state:full', { nodes:nodeState, nodeDefinitions:NODES, droneState });
  if (ids.length) console.log(`📱 Removed ${ids.length} audience phones (${reason})`);
}

// ─── Drone telemetry lost — mission-aware ─────────────────────────────────────
function triggerDroneTelemetryLost(droneId) {
  const last = droneState[droneId];
  if (!last || last.status === 'telemetry_lost') return;
  const pos = last.x != null ? { x:last.x, y:last.y, z:last.z||0 } : null;
  const posStr = pos ? `x:${pos.x.toFixed(2)} y:${pos.y.toFixed(2)} z:${pos.z.toFixed(2)}m` : 'position unknown';

  // "On the ground" is a little above 0 to allow for Lighthouse positioning noise near the floor
  const nearGround  = pos ? pos.z < POLICY.drones.landedBelowM : false;
  const nearHome    = pos ? missionTracker.isNearHome(droneId, pos) : false;
  const missionDone = missionTracker.isComplete(droneId);

  // Did it leave its route recently? (attack signature; window in config/alerting.json)
  const recentOffPath = last._lastOffPathTime && (Date.now() - last._lastOffPathTime < POLICY.drones.offRouteMemoryMs);

  // ── Normal landing ─────────────────────────────────────────────────────────
  // Drone is near ground AND (near home OR mission complete) AND no recent attack
  if (nearGround && (nearHome || missionDone) && !recentOffPath) {
    console.log(`🏠 ${droneId} landed normally at ${posStr}`);
    droneState[droneId] = { ...last, status:'offline', telemetryLostAt:null };
    io.emit('drone:telemetry', droneState[droneId]);
    missionTracker.reset(droneId);
    closeNodeAlertsQuietly(droneId); // flight over: battery etc. close with it
    logEvent('drone_landed', droneId, `${droneId} landed — mission ended`, 'info');
    return;
  }

  // ── Landed off-path (attack) ───────────────────────────────────────────────
  // Drone is near ground but not home, and had recent off-path deviation
  // This is an attacked drone that landed in the wrong place — not signal loss
  if (nearGround && recentOffPath) {
    console.warn(`⚠️  ${droneId} landed off expected path — possible attack — ${posStr}`);
    droneState[droneId] = { ...last, status:'offline', telemetryLostAt:null };
    io.emit('drone:telemetry', droneState[droneId]);
    missionTracker.reset(droneId);
    // The off-route incident ends here, with its outcome
    closeAlert(droneId, 'off_route', d => `${droneId} landed off expected path — last position ${posStr}${d ? ` · left its route ${d} earlier` : ''}`, 'critical', 'drone_off_path');
    closeNodeAlertsQuietly(droneId);
    return;
  }

  // ── Unexpected telemetry loss ──────────────────────────────────────────────
  const reason = !nearGround ? 'drone was airborne'
    : !nearHome && !missionDone ? 'mission not complete and drone not at home'
    : 'unexpected position';
  console.warn(`⚠️  ${droneId} telemetry lost (${reason}) — ${posStr}`);
  droneState[droneId] = { ...last, status:'telemetry_lost', telemetryLostAt:new Date().toISOString() };
  io.emit('drone:telemetry', droneState[droneId]);
  raiseAlert(droneId, 'telemetry', { type:'drone_telemetry_lost', severity:'critical', title:'Telemetry lost',
    fmt: () => reason, fireText: () => `${droneId} telemetry lost (${reason}) — last position ${posStr}` });
}

// ─── Node state management ────────────────────────────────────────────────────
// Creates state for ONE node if missing. Never touches any other node.
function ensureNodeState(id) {
  if (!nodeState[id])        nodeState[id]        = { status:'offline', metrics:{}, lastSeen:null, packetLoss:0 };
  if (!packetCounters[id])   packetCounters[id]   = { received:0, window:[] };
  if (!lastMetrics[id])      lastMetrics[id]      = {};
  if (!rfHealth[id])         rfHealth[id]         = { packetLossRate:0, bulkSendCount:0, gapCount:0, rssiVariance:0, rssiHistory:[], lastGapDuration:0, disruptionType:'none', lastRecoveryMs:null, transmissionRhythm:[] };
  if (!timestampHistory[id]) timestampHistory[id] = [];
}

// Full sync with a complete node set (startup / layout): adds missing nodes
// and removes state for nodes no longer in the set. Only call it with ALL nodes.
function initNodeState(nodes) {
  Object.keys(nodes).forEach(ensureNodeState);
  Object.keys(nodeState).forEach(id => {
    if (!nodes[id]) {
      delete nodeState[id]; delete rfHealth[id]; delete packetCounters[id];
      delete lastMetrics[id]; delete timestampHistory[id];
      if (watchdogTimers[id]) { clearTimeout(watchdogTimers[id]); delete watchdogTimers[id]; }
    }
  });
}

function resetWatchdog(nodeId) {
  if (isAudiencePhone(nodeId)) return resetAudienceWatchdog(nodeId); // audience only
  if (watchdogTimers[nodeId]) clearTimeout(watchdogTimers[nodeId]);
  watchdogTimers[nodeId] = setTimeout(() => {
    if (nodeState[nodeId]?.status === 'online') {
      nodeState[nodeId].status = 'offline';
      io.emit('node:update', { nodeId, metrics:{}, status:'offline', lastSeen:nodeState[nodeId].lastSeen, packetLoss:nodeState[nodeId].packetLoss });
      markNodeStale(nodeId); // its value alerts can't resolve without data
      if (rfHealth[nodeId]) rfHealth[nodeId].offlineSinceHeartbeat = true; // the next heartbeat gap is this outage
      if (NODES[nodeId]?.type !== 'drone') { // drones have their own telemetry-lost alert
        raiseAlert(nodeId, 'offline', { type:'watchdog', severity:'critical', title:'Offline',
          fmt: () => `no data for ${CONFIG.watchdogTimeout}s`,
          fireText: () => `${nodeLabel(nodeId)} went offline: no data for ${CONFIG.watchdogTimeout}s` });
      }
    }
  }, CONFIG.watchdogTimeout * 1000);
}

// Packet loss on the DEVICE's clock when it sends collected_ms: a buffered backlog flushed in one
// burst is several readings, not one, and only readings never measured or never delivered count as lost.
function trackPacketByDeviceClock(nodeId, counter, cms) {
  const windowMs = CONFIG.packetLossWindow * 1000;
  const c = counter.dev || (counter.dev = { window: [], since: null });
  const last = c.window.at(-1);
  if (last === cms) return nodeState[nodeId].packetLoss || 0;                      // same reading, another metric
  if (last !== undefined && cms < last) { c.window = []; c.since = null; }          // device rebooted (millis restarted)
  if (c.since === null) c.since = cms;
  c.window.push(cms);
  c.window = c.window.filter(t => t > cms - windowMs);
  let loss = 0;
  if (c.window.length >= 6) {
    const gaps = [];
    for (let i = 1; i < c.window.length; i++) gaps.push(c.window[i] - c.window[i - 1]);
    gaps.sort((a, b) => a - b);
    const typical = Math.max(1, gaps[Math.floor(gaps.length / 2)]);
    const observed = cms - c.since;
    const expected = observed < windowMs ? observed / typical + 1 : windowMs / typical;
    const raw = Math.round((1 - c.window.length / expected) * 100);
    loss = raw <= 5 ? 0 : Math.min(100, raw);
  }
  nodeState[nodeId].packetLoss = loss;
  rfHealth[nodeId].packetLossRate = loss;
  return loss;
}

function trackPacket(nodeId, collectedMs) {
  const now = Date.now();
  const counter = packetCounters[nodeId];
  if (!counter) return 0;
  if (typeof collectedMs === 'number' && Number.isFinite(collectedMs)) { counter.received++; return trackPacketByDeviceClock(nodeId, counter, collectedMs); }
  counter.received++;
  const windowMs = CONFIG.packetLossWindow * 1000;
  const last = counter.window[counter.window.length - 1];

  // Back after a silence longer than the whole window: start measuring fresh.
  if (last !== undefined && now - last > windowMs) { counter.window = []; counter.since = null; }
  if (!counter.since) counter.since = now;

  // Metrics published as separate messages in the same instant are one sample, not several packets.
  if (last !== undefined && now - last < 100) return nodeState[nodeId].packetLoss || 0;

  counter.window.push(now);
  counter.window = counter.window.filter(t => t > now - windowMs);

  // Judge each node against its OWN usual cadence (median gap between samples), and only over
  // the time we've actually been listening. The old formula assumed 1 msg/s over a full 30 s
  // window, so every node showed ~40-50% loss after startup and fast nodes could never show loss.
  let loss = 0;
  if (counter.window.length >= 6) {
    const gaps = [];
    for (let i = 1; i < counter.window.length; i++) gaps.push(counter.window[i] - counter.window[i - 1]);
    gaps.sort((a, b) => a - b);
    const typical = Math.max(1, gaps[Math.floor(gaps.length / 2)]);
    const observed = now - counter.since;
    const expected = observed < windowMs ? observed / typical + 1 : windowMs / typical;
    const raw = Math.round((1 - counter.window.length / expected) * 100);
    loss = raw <= 5 ? 0 : Math.min(100, raw); // under 5% is normal timing jitter, not loss
  }
  nodeState[nodeId].packetLoss = loss;
  rfHealth[nodeId].packetLossRate = loss;
  return loss;
}

// Radio timing (gaps, bursts, packet loss) is judged ONLY on each device's heartbeat: the metric it
// sends on a timer. Event-driven metrics (light changes, motion, sensor status) arrive whenever
// something happens, so mixing them in made loss and burst estimates meaningless. Measured on the
// testbed: wifi_rssi every 2 s (building-c, perimeter) and 5 s (intersection). Override per node
// with "heartbeatMetric" in the layout.
function heartbeatMetricOf(nodeId) {
  const n = NODES[nodeId] || {};
  if (n.heartbeatMetric) return n.heartbeatMetric;
  if (n.type === 'gps') return 'snr_l1';
  if (n.type === 'drone') return 'z';
  return 'wifi_rssi';
}
const medianOf = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function analyzeTransmissionRhythm(nodeId, metrics, wasOffline = false) {
  if (isAudiencePhone(nodeId)) return true; // audience only: phone network jitter isn't RF disruption
  const nodeType = NODES[nodeId]?.type;
  if (nodeType === 'security') return true;
  const receiveTime = Date.now();
  const hist = timestampHistory[nodeId];
  const health = rfHealth[nodeId];
  if (!hist || !health) return true;
  const hasCollectedMs = metrics._collected_ms !== undefined && metrics._received_ms !== undefined;
  const collectedMs = hasCollectedMs ? metrics._collected_ms : null;
  if (!health.collectedMsHistory) health.collectedMsHistory = [];
  // Devices that publish each metric as its own message (temperature, humidity, wifi_rssi…) send
  // several messages per reading with the same collected_ms. They are ONE sample: counting them
  // separately made every such sensor look like it was flushing buffered readings, permanently.
  // Real buffering is still caught: a flushed backlog carries DIFFERENT collected_ms values.
  const sameSample = collectedMs !== null
    ? health.collectedMsHistory.at(-1) === collectedMs
    : (hist.length > 0 && receiveTime - hist.at(-1) < 100);
  if (!sameSample) {
    if (collectedMs !== null) {
      health.collectedMsHistory.push(collectedMs);
      if (health.collectedMsHistory.length > 200) health.collectedMsHistory.shift();
    }
    hist.push(receiveTime);
    if (hist.length > 200) hist.shift();
  }
  if (!sameSample && hist.length >= 2) {
    let delta, usingCollectionTime = false;
    if (collectedMs !== null && health.collectedMsHistory.length >= 2) {
      const len = health.collectedMsHistory.length;
      const cd  = health.collectedMsHistory[len-1] - health.collectedMsHistory[len-2];
      if (cd > 0 && cd < 300000) { delta = cd; usingCollectionTime = true; }
    }
    const recvDelta = receiveTime - hist[hist.length-2];
    if (!usingCollectionTime) delta = recvDelta;
    const src = usingCollectionTime ? 'collected_ms' : 'receive_time';
    let rhythmType = 'normal';
    // Bursts and gaps are relative to THIS device's real rhythm, learned from its own heartbeat
    // (median of its recent intervals), not the layout's declared interval, which did not match the
    // hardware. Until rf.learnFromReadings intervals are seen it only learns; it judges nothing.
    const learned = health.heartbeatIntervals || (health.heartbeatIntervals = []);
    const RHY = POLICY.rf;
    const learning = learned.length < RHY.learnFromReadings;
    const intervalMs = learning ? delta : medianOf(learned);
    const gapLimit = Math.max(CONFIG.gapThresholdMs, intervalMs * RHY.gapAfterIntervals);
    // With collected_ms: readings measured a normal interval apart but ARRIVING together were
    // queued on the device while the link was down (delayed, not lost).
    const deliveredInBurst = !learning && usingCollectionTime && delta <= gapLimit && recvDelta < intervalMs * RHY.burstUnderInterval;
    if (!learning && delta >= intervalMs * RHY.burstUnderInterval) { learned.push(delta); if (learned.length > 20) learned.shift(); }
    else if (learning) learned.push(delta);
    if (learning) {
      // still learning this device's rhythm
    } else if (deliveredInBurst || delta < intervalMs * RHY.burstUnderInterval) {
      rhythmType = 'bulk'; health.bulkSendCount++;
      logRfEvent(nodeId, 'bulk_send', { deltaMs:delta, source:src });
    } else if (delta > gapLimit) {
      rhythmType = 'gap'; health.gapCount++; health.lastGapDuration = delta;
      logRfEvent(nodeId, 'gap', { gapMs:delta, source:src }); // every gap is kept in rf_events; the event log gets one alert per incident
    } else if (health.transmissionRhythm.length > 0 && health.transmissionRhythm[health.transmissionRhythm.length-1].type === 'gap') {
      health.lastRecoveryMs = delta;
      logRfEvent(nodeId, 'recovery', { recoveryMs:delta });
    }
    // A gap that spans an Offline period is an outage (the Offline alert covers it), not radio loss.
    health.transmissionRhythm.push({ t:receiveTime, intervalMs:delta, type:rhythmType, source:src, outage: rhythmType === 'gap' && wasOffline });
    if (health.transmissionRhythm.length > 60) health.transmissionRhythm.shift();
  }
  if (metrics.wifi_rssi !== undefined) {
    health.rssiHistory.push(metrics.wifi_rssi);
    if (health.rssiHistory.length > CONFIG.rssiVarianceWindow) health.rssiHistory.shift();
    if (health.rssiHistory.length >= 3) {
      const mean = health.rssiHistory.reduce((a,b)=>a+b,0) / health.rssiHistory.length;
      health.rssiVariance = +Math.sqrt(health.rssiHistory.reduce((a,b)=>a+Math.pow(b-mean,2),0)/health.rssiHistory.length).toFixed(2);
    }
  }
  const recent = health.transmissionRhythm.slice(-20);
  const gaps = recent.filter(r=>r.type==='gap').length;
  const bulks = recent.filter(r=>r.type==='bulk').length;
  health.disruptionType = gaps===0&&bulks===0 ? 'none' : gaps>0&&bulks>0 ? 'intermittent' : gaps>=3 ? 'severe' : 'partial';
  return !sameSample;
}

// ─── RF verdict: the single answer both the overview and the RF Analysis tab show ───
// Uses the same thresholds as detectAnomalies(), so "interference" on a node card,
// the alert events, and the RF tab can never disagree.
const RF_SIGNALS = [
  { metric:'wifi_rssi',  key:'rssiThreshold',      unit:'dBm',   name:'Wi-Fi signal' },
  { metric:'signal_433', key:'signal433Threshold', unit:'dBm',   name:'433 MHz signal' },
  { metric:'snr_l1',     key:'snrL1Threshold',     unit:'dB-Hz', name:'GPS L1 signal quality' },
  { metric:'snr_l5',     key:'snrL5Threshold',     unit:'dB-Hz', name:'GPS L5 signal quality' },
];
const RF_RECENT_WINDOW    = POLICY.rf.recentReadings;      // readings considered "recent" for gaps/bursts
const RSSI_VARIANCE_ALERT = POLICY.rf.signalSpreadAlertDb; // dB; demo noise alone sits around 3
const PACKET_LOSS_ALERT   = POLICY.rf.packetLossAlertPct;  // %

function computeRfVerdict(nodeId, metrics, newReading = true) {
  const h = rfHealth[nodeId];
  if (!h) return;
  const latest = nodeState[nodeId]?.metrics || {};
  const reasons = [];
  let level = 0; // 0 clear, 1 degraded, 2 interference
  let signal = null;
  for (const sig of RF_SIGNALS) {
    const v = latest[sig.metric];
    if (typeof v !== 'number') continue;
    const threshold = getThreshold(nodeId, sig.key);
    if (!signal) signal = { metric: sig.metric, name: sig.name, value: v, threshold, unit: sig.unit };
    if (v < threshold) { level = 2; reasons.push(`${sig.name} ${v} ${sig.unit} is below the ${threshold} ${sig.unit} threshold`); }
  }
  // History of the primary signal, recorded only when this update carried it
  if (signal && typeof metrics[signal.metric] === 'number') {
    if (!h.signalHistory) h.signalHistory = [];
    h.signalHistory.push(metrics[signal.metric]);
    if (h.signalHistory.length > 30) h.signalHistory.shift();
  }
  // Recent = the last N readings, but never older than the recent window (20 readings of a 5 s heartbeat is 100 s).
  const recentCutoff = Date.now() - POLICY.rf.recentWindowMs;
  const recent = (h.transmissionRhythm || []).slice(-RF_RECENT_WINDOW).filter(r => r.t >= recentCutoff);
  // A gap longer than the watchdog timeout is an outage (the Offline alert covers it), not radio loss
  h.recentGaps  = recent.filter(r => r.type === 'gap' && !r.outage).length;
  h.recentBulks = recent.filter(r => r.type === 'bulk').length;
  if (newReading && NODES[nodeId]?.type !== 'security' && !isAudiencePhone(nodeId)) { // once per reading, not per message
    const longest = Math.max(0, ...recent.filter(r => r.type === 'gap' && !r.outage).map(r => r.intervalMs));
    checkCondition(nodeId, 'readings_lost', h.recentGaps > 0, longest / 1000,
      { type:'rf_disruption', severity:'warning', title:'Readings lost', fmt: v => `${v.toFixed(1)} s gap`, threshold:`${h.recentGaps} gap(s) in the last minute`, worse:'higher', ...ruleTiming('readings_lost') });
  }
  if (h.recentGaps)  { level = Math.max(level, 1); reasons.push(`${h.recentGaps} transmission gap${h.recentGaps > 1 ? 's' : ''} in the last minute`); }
  if (h.recentBulks) { level = Math.max(level, 1); reasons.push(`${h.recentBulks} buffered burst${h.recentBulks > 1 ? 's' : ''} in the last minute`); }
  if ((h.packetLossRate || 0) > PACKET_LOSS_ALERT) { level = Math.max(level, 1); reasons.push(`${h.packetLossRate}% packet loss`); }
  // When the signal recovers above its threshold, the stability window restarts: otherwise the weak
  // readings still in it make the jump back up look like "fluctuating".
  if (signal) {
    const below = signal.value < signal.threshold;
    if (h.signalWasBelow && !below) { h.rssiHistory = []; h.rssiVariance = 0; }
    h.signalWasBelow = below;
  }
  if ((h.rssiVariance || 0) > RSSI_VARIANCE_ALERT) { level = Math.max(level, 1); reasons.push(`signal fluctuating (σ ${h.rssiVariance} dB)`); }
  h.verdict = ['clear', 'degraded', 'interference'][level];
  h.reasons = reasons;
  h.signal  = signal;
  // Every non-clear verdict has a matching alert, so the RF tab and the Events tab always agree.
  // Gaps are covered by "Readings lost"; this covers bursts, packet loss and an unstable signal.
  if (newReading && !isAudiencePhone(nodeId)) {
    const otherReasons = reasons.filter(r => !/gap/.test(r) && !/threshold/.test(r));
    checkCondition(nodeId, 'rf_degraded', h.verdict === 'degraded' && h.recentGaps === 0 && otherReasons.length > 0, null, {
      type:'rf_disruption', severity:'warning', title:'RF degraded',
      fmt: () => otherReasons.join('; ') || 'recovered', ...ruleTiming('rf_degraded'),
    });
  }
}

function rfHealthForClient(nodeId) {
  const h = rfHealth[nodeId] || {};
  return {
    verdict: h.verdict, reasons: h.reasons, signal: h.signal, signalHistory: h.signalHistory,
    recentGaps: h.recentGaps, recentBulks: h.recentBulks,
    disruptionType: h.disruptionType, packetLossRate: h.packetLossRate, rssiVariance: h.rssiVariance,
    gapCount: h.gapCount, bulkSendCount: h.bulkSendCount, lastRecoveryMs: h.lastRecoveryMs,
    transmissionRhythm: h.transmissionRhythm, // the RF tab's charts used to freeze at page load without this
  };
}

// ─── Alerting: state-based, like Prometheus Alertmanager / ISA-18.2 alarm management ───
// Conditions log ONE event when they start and ONE when they end; readings stay in
// sensor_readings and the charts. Every number below comes from config/alerting.json
// (see docs/ALERTING.md); this file holds the mechanism, the config holds the policy. Per condition:
//   forMs      on-delay (alertAfterMs): must hold this long before firing (0 = fire at once)
//   deadband   (clearMargin) the value must recover past the threshold by a margin before it can resolve
//   resolveMs  off-delay (clearAfterMs): must stay recovered this long before resolving (no flapping)
//   severity   fixed, or a function of the value: a firing alert ESCALATES instead of re-firing
// Related alerts are held for GROUP_WAIT_MS; signal problems on one radio band with 2+
// alerts become ONE incident ("2.4 GHz interference: 5 devices affected").
// When a node stops reporting, its alerts go stale (no data) and close after STALE_CLOSE_MS.
const SEVERITY_RANK      = { info: 0, warning: 1, critical: 2 };
const DEFAULT_FOR_MS     = POLICY.defaults.alertAfterMs;
const DEFAULT_RESOLVE_MS = POLICY.defaults.clearAfterMs;
const ALERT_REPEAT_MS    = POLICY.defaults.remindEveryMs;
const EDGE_COOLDOWN_MS   = POLICY.defaults.oneOffEventCooldownMs;
// Real sensors report every 2–5 s, so their alerts for one cause can fire 5+ s apart: wait longer
// to group them ("live"). Demo nodes report every second ("demo").
const GROUP_WAIT_MS      = alerting.groupWaitMs(process.env.DEMO_MODE !== 'false');
const STALE_CLOSE_MS     = POLICY.silence.staleAlertCloseMs;
const INCIDENT_AFTERMATH_MS = POLICY.grouping.aftermathMs;
const activeAlerts = {};   // `${nodeId}|${key}` -> alert
const incidents    = {};   // band -> incident (pending during group wait, then active / recovering)
const lastEdgeEvent = {};
let alertsEmitTimer = null;

// Root-cause grouping: these are signal problems; the second set are their symptoms
const BAND_NAMES   = POLICY.grouping.bands;
const CAUSE_KEYS   = new Set(POLICY.grouping.causes);
const SYMPTOM_KEYS = new Set(POLICY.grouping.symptoms);
const alertGroupOf = (nodeId, key) => {
  if (!CAUSE_KEYS.has(key) && !SYMPTOM_KEYS.has(key)) return null;
  if (NODES[nodeId]?.type === 'drone') return null;
  const band = NODES[nodeId]?.rfFrequency;
  return BAND_NAMES[band] ? band : null;
};

const fmtDuration = ms => ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
const nodeLabel = id => NODES[id]?.label || id;
const below   = (v, t, db) => v < t ? 'bad' : v >= t + db ? 'ok' : 'hold';                          // deadband above t
const outside = (v, min, max, db) => (v < min || v > max) ? 'bad' : (v >= min + db && v <= max - db) ? 'ok' : 'hold';

function activeAlertList() {
  const list = Object.values(activeAlerts).filter(a => a.firing).map(a => ({
    nodeId: a.nodeId, key: a.key, type: a.type, severity: a.severity, title: a.title, since: a.since,
    count: a.count, last: a.lastText, worst: a.worstText, stale: !!a.stale, staleSince: a.staleSince || null,
    incident: a.incidentId && incidents[a.incidentId]?.open ? a.incidentId : null,
  }));
  const incs = Object.values(incidents).filter(i => i.open).map(i => ({
    id: i.band, title: `${BAND_NAMES[i.band]} interference`, state: i.state, severity: i.severity, since: i.since,
    endedAt: i.endedAt || null, nodes: [...new Set(list.filter(a => a.incident === i.band).map(a => nodeLabel(a.nodeId)))],
    worst: i.worstText || null,
  }));
  return { incidents: incs, alerts: list };
}
function emitActiveAlerts() {
  if (alertsEmitTimer) return;
  alertsEmitTimer = setTimeout(() => { alertsEmitTimer = null; io.emit('alerts:active', activeAlertList()); }, 500);
}

function announce(a, message, severity) { a.notified = true; a.lastNotified = Date.now(); logEvent(a.type, a.nodeId, message, severity); }

function fireAlert(a, value, now) {
  const spec = a.spec;
  a.firing = true;
  a.since = a.pendingSince || now;
  a.severity = typeof spec.severity === 'function' ? spec.severity(value) : spec.severity;
  a.fireText = spec.fireText ? spec.fireText(value)
    : `${spec.title} on ${nodeLabel(a.nodeId)}: ${spec.fmt(value)}${spec.threshold ? ` (${spec.threshold})` : ''}`;
  const band = alertGroupOf(a.nodeId, a.key);
  if (!band) return announce(a, a.fireText, a.severity);
  let inc = incidents[band];
  if (inc?.open && inc.state === 'recovering' && CAUSE_KEYS.has(a.key)) {
    delete incidents[band]; inc = null;  // the cause is back: that's a new episode, not the old one
  }
  if (inc?.open) { a.incidentId = band; inc.alerts.add(a.k); inc.devices.add(a.nodeId); updateIncidentSeverity(inc); return; } // joins quietly
  if (!inc) {
    inc = incidents[band] = { band, open: false, alerts: new Set(), devices: new Set(), createdAt: now };
    inc.timer = setTimeout(() => flushGroup(band), GROUP_WAIT_MS);
  }
  a.incidentId = band;
  inc.alerts.add(a.k);
  inc.devices.add(a.nodeId);
}

// End of group wait: 2+ alerts with at least one signal cause → one incident; otherwise announce individually
function flushGroup(band) {
  const inc = incidents[band];
  if (!inc || inc.open) return;
  const members = [...inc.alerts].map(k => activeAlerts[k]).filter(a => a?.firing);
  const causes = members.filter(a => CAUSE_KEYS.has(a.key));
  if (members.length >= 2 && causes.length >= 1) {
    inc.open = true; inc.state = 'active';
    inc.since = Math.min(...members.map(a => a.since));
    updateIncidentSeverity(inc);
    const devices = [...new Set(members.map(a => nodeLabel(a.nodeId)))];
    const worst = worstCause(inc);
    logEvent('interference', null,
      `${BAND_NAMES[band]} interference: ${devices.length} device${devices.length > 1 ? 's' : ''} affected (${devices.join(', ')})${worst ? ` · worst ${worst}` : ''}`,
      inc.severity);
  } else {
    members.forEach(a => { a.incidentId = null; announce(a, a.fireText, a.severity); });
    delete incidents[band];
  }
  emitActiveAlerts();
}

function updateIncidentSeverity(inc) {
  const members = [...inc.alerts].map(k => activeAlerts[k]).filter(Boolean);
  const devices = new Set(members.map(a => a.nodeId)).size;
  let sev = members.reduce((s, a) => SEVERITY_RANK[a.severity] > SEVERITY_RANK[s] ? a.severity : s, 'warning');
  if (devices >= POLICY.grouping.siteLevelDevices) sev = 'critical'; // many devices at once is a site-level problem
  inc.severity = sev;
  trackIncidentWorst(inc);
}
// The incident's worst value only ever gets worse over its life (resolved members included)
function trackIncidentWorst(inc) {
  for (const k of inc.alerts) {
    const a = activeAlerts[k];
    if (!a || !CAUSE_KEYS.has(a.key) || typeof a.worst !== 'number') continue;
    if (inc.worstVal === undefined || a.worst < inc.worstVal) { inc.worstVal = a.worst; inc.worstText = `${a.worstText} on ${nodeLabel(a.nodeId)}`; }
  }
  return inc.worstText || null;
}
const worstCause = trackIncidentWorst;

function resolveAlert(a, text, severity) {
  if (a.notified) logEvent(a.type, a.nodeId, `${a.title} on ${nodeLabel(a.nodeId)} ${text}`, severity);
  delete activeAlerts[a.k];
  const inc = a.incidentId && incidents[a.incidentId];
  if (inc) {
    inc.alerts.delete(a.k);
    if (!inc.open) { if (!inc.alerts.size) { clearTimeout(inc.timer); delete incidents[inc.band]; } }
    else {
      const remaining = [...inc.alerts].map(k => activeAlerts[k]).filter(Boolean);
      if (inc.state === 'active' && !remaining.some(m => CAUSE_KEYS.has(m.key))) {
        // Root cause is gone: close the incident now; lingering symptoms clear quietly
        inc.state = 'recovering'; inc.endedAt = Date.now();
        const n = inc.devices.size;
        logEvent('interference', null,
          `${BAND_NAMES[inc.band]} interference ended after ${fmtDuration(inc.endedAt - inc.since)} · ${n} device${n > 1 ? 's' : ''} affected${inc.worstText ? ` · worst ${inc.worstText}` : ''}`, 'info');
      }
      // Ended incidents stay "recovering" for a minute so their aftermath (bursts, lost readings still
      // inside the evidence window) joins them quietly instead of raising new alerts.
      if (!remaining.length && inc.state === 'recovering' && Date.now() - inc.endedAt >= INCIDENT_AFTERMATH_MS) delete incidents[inc.band];
    }
  }
  emitActiveAlerts();
}

// Reading-driven conditions. state: 'bad' | 'ok' | 'hold' (inside the deadband), or a boolean.
function checkCondition(nodeId, key, state, value, spec) {
  if (state === true) state = 'bad'; else if (state === false) state = 'ok';
  const k = `${nodeId}|${key}`, now = Date.now();
  let a = activeAlerts[k];
  if (a) { a.stale = false; a.staleSince = null; a.spec = spec; }
  if (state === 'bad') {
    if (!a) a = activeAlerts[k] = { k, nodeId, key, type: spec.type, title: spec.title, firing: false, count: 0, spec };
    a.okSince = null;
    a.count++;
    const better = spec.worse === 'higher' ? (v, w) => v > w : (v, w) => v < w;
    if (typeof value === 'number' && (a.worst === undefined || better(value, a.worst))) { a.worst = value; a.worstText = spec.fmt(value); }
    a.lastText = spec.fmt(value);
    if (!a.firing) {
      if (!a.pendingSince) a.pendingSince = now;
      if (now - a.pendingSince >= (spec.forMs ?? DEFAULT_FOR_MS)) fireAlert(a, value, now);
    } else {
      const sev = typeof spec.severity === 'function' ? spec.severity(value) : spec.severity;
      if (SEVERITY_RANK[sev] > SEVERITY_RANK[a.severity]) {       // escalate, sustained like the on-delay
        if (a.escCandidate !== sev) { a.escCandidate = sev; a.escSince = now; }
        if (now - a.escSince >= (spec.forMs ?? DEFAULT_FOR_MS)) {
          a.severity = sev; a.escCandidate = null;
          if (a.notified) announce(a, `${spec.title} on ${nodeLabel(nodeId)} escalated to ${sev}: ${spec.fmt(value)}`, sev);
          const inc = a.incidentId && incidents[a.incidentId]; if (inc) updateIncidentSeverity(inc);
        }
      } else a.escCandidate = null;
      if (a.notified && now - a.lastNotified >= ALERT_REPEAT_MS)
        announce(a, `${spec.title} on ${nodeLabel(nodeId)} still active after ${fmtDuration(now - a.since)} · worst ${a.worstText}`, a.severity);
      const inc = a.incidentId && incidents[a.incidentId]; if (inc) trackIncidentWorst(inc);
    }
    emitActiveAlerts();
  } else if (state === 'hold') {
    if (!a) return;
    if (!a.firing) { delete activeAlerts[k]; return; } // never fired: inside the deadband is not bad
    a.okSince = null;                                  // firing: not recovered enough to start resolving
  } else {
    if (!a) return;
    if (!a.firing) { if (a.incidentId) incidents[a.incidentId]?.alerts.delete(k); delete activeAlerts[k]; return; }
    if (!a.okSince) { a.okSince = now; return; }
    if (now - a.okSince >= (spec.resolveMs ?? DEFAULT_RESOLVE_MS)) {
      const worst = spec.worse && a.worstText ? ` · worst ${a.worstText}` : '';
      resolveAlert(a, `resolved after ${fmtDuration(a.okSince - a.since)}${worst} · ${a.count} reading${a.count === 1 ? '' : 's'}`, 'info');
    }
  }
}

// Configured nodes that haven't reported 60 s after startup get a "Not reporting" alert,
// which resolves the moment they send anything. Drones only report while flying: excluded.
const STARTUP_GRACE_MS = POLICY.silence.startupGraceMs;
setTimeout(() => {
  for (const id of Object.keys(NODES)) {
    const n = NODES[id];
    if (!n || n.autoRegistered || n.type === 'drone' || nodeState[id]?.lastSeen) continue;
    raiseAlert(id, 'offline', { type:'watchdog', severity:'warning', title:'Not reporting',
      fmt: () => 'no data since startup',
      fireText: () => `${nodeLabel(id)} has not reported since the backend started` });
  }
}, STARTUP_GRACE_MS).unref();

// Event-driven alerts (node offline, drone telemetry lost): fire now, close explicitly.
function raiseAlert(nodeId, key, spec, value) { checkCondition(nodeId, key, 'bad', value, { ...spec, forMs: 0 }); }
function closeAlert(nodeId, key, makeMessage, severity, type) {
  const a = activeAlerts[`${nodeId}|${key}`];
  const msg = makeMessage(a?.firing ? fmtDuration(Date.now() - a.since) : null, a);
  if (a) { delete activeAlerts[a.k]; emitActiveAlerts(); }
  if (msg) logEvent(type || a?.type || key, nodeId, msg, severity);
}
function closeNodeAlertsQuietly(nodeId) {
  for (const a of Object.values(activeAlerts)) if (a.nodeId === nodeId) resolveAlert({ ...a, notified: false }, '', 'info');
}
function markNodeStale(nodeId) {
  const now = Date.now();
  for (const a of Object.values(activeAlerts)) if (a.nodeId === nodeId && a.firing && !a.stale) { a.stale = true; a.staleSince = now; }
  emitActiveAlerts();
}
setInterval(() => { // stale alerts whose node never came back are closed, not left open forever
  const now = Date.now();
  for (const inc of Object.values(incidents)) {   // recovering incidents leave once their aftermath window passes
    if (inc.open && inc.state === 'recovering' && now - inc.endedAt >= INCIDENT_AFTERMATH_MS
        && ![...inc.alerts].some(k => activeAlerts[k])) { delete incidents[inc.band]; emitActiveAlerts(); }
  }
  for (const a of Object.values(activeAlerts))
    if (a.stale && now - a.staleSince >= STALE_CLOSE_MS) resolveAlert(a, `closed: no data for ${fmtDuration(now - a.staleSince)}`, 'info');
}, 5000).unref();

function edgeEvent(nodeId, kind, type, message, severity) {
  const k = `${nodeId}|${kind}`, now = Date.now();
  if (now - (lastEdgeEvent[k] || 0) < EDGE_COOLDOWN_MS) return;
  lastEdgeEvent[k] = now;
  logEvent(type, nodeId, message, severity);
}

function detectAnomalies(nodeId, metrics) {
  const prev = lastMetrics[nodeId] || {};
  const gt = key => getThreshold(nodeId, key);
  const label = nodeLabel(nodeId);
  const num = v => typeof v === 'number' && Number.isFinite(v); // null / missing is "no reading", never "out of range"
  const nt = NODES[nodeId]?.thresholds || {};

  // ── Ongoing conditions. Delays and clear margins per alert: config/alerting.json → rules ──
  if (num(metrics.wifi_rssi)) checkCondition(nodeId, 'wifi_low', below(metrics.wifi_rssi, gt('rssiThreshold'), clearMargin('wifi_low')), metrics.wifi_rssi,
    { type:'interference', severity:'warning', title:'Wi-Fi signal low', fmt: v => `${v} dBm`, threshold:`alert below ${gt('rssiThreshold')} dBm`, worse:'lower', ...ruleTiming('wifi_low') });
  if (num(metrics.signal_433)) checkCondition(nodeId, '433_low', below(metrics.signal_433, gt('signal433Threshold'), clearMargin('433_low')), metrics.signal_433,
    { type:'interference', severity:'warning', title:'433 MHz signal low', fmt: v => `${v} dBm`, threshold:`alert below ${gt('signal433Threshold')} dBm`, worse:'lower', ...ruleTiming('433_low') });
  if (num(metrics.snr_l1)) checkCondition(nodeId, 'gps_l1_low', below(metrics.snr_l1, gt('snrL1Threshold'), clearMargin('gps_l1_low')), metrics.snr_l1,
    { type:'interference', severity:'critical', title:'GPS L1 signal quality low', fmt: v => `${v} dB-Hz`, threshold:`alert below ${gt('snrL1Threshold')} dB-Hz`, worse:'lower', ...ruleTiming('gps_l1_low') });
  if (num(metrics.snr_l5)) checkCondition(nodeId, 'gps_l5_low', below(metrics.snr_l5, gt('snrL5Threshold'), clearMargin('gps_l5_low')), metrics.snr_l5,
    { type:'interference', severity:'critical', title:'GPS L5 signal quality low', fmt: v => `${v} dB-Hz`, threshold:`alert below ${gt('snrL5Threshold')} dB-Hz`, worse:'lower', ...ruleTiming('gps_l5_low') });
  if (metrics.lock_status !== undefined) checkCondition(nodeId, 'gps_lock', metrics.lock_status === 'lost', metrics.lock_status,
    { type:'interference', severity:'critical', title:'GPS lock lost', fmt: v => String(v), ...ruleTiming('gps_lock') });

  // Life-critical vitals: the shortest on-delay (1 s, see config); noise is handled by the clear margin and off-delay
  // The MAX30102 node sends heart_rate 30 with sensor_status "no_finger" when nobody is touching it:
  // that is "no reading", never a heart rate. The status arrives ~170 ms AFTER the heart rate, so the
  // range check waits 1 s (one more reading) before firing; a no-contact status then cancels it.
  const contactStatus = metrics.sensor_status ?? nodeState[nodeId]?.metrics?.sensor_status;
  const noContact = typeof contactStatus === 'string' && /no[_ ]?(finger|contact)/i.test(contactStatus);
  if (metrics.heart_rate !== undefined) {
    const hrMin = nt.heart_rate_min || gt('heartRateMin'), hrMax = nt.heart_rate_max || gt('heartRateMax');
    if (num(metrics.heart_rate)) checkCondition(nodeId, 'hr_range', noContact ? 'ok' : outside(metrics.heart_rate, hrMin, hrMax, clearMargin('hr_range')), metrics.heart_rate,
      { type:'medical', severity:'critical', title:'Heart rate out of range', fmt: v => `${v} bpm`, threshold:`${hrMin}–${hrMax} bpm`, ...ruleTiming('hr_range') });
    checkCondition(nodeId, 'hr_missing', metrics.heart_rate === null, null,
      { type:'medical', severity:'warning', title:'Heart-rate sensor not reporting', fmt: () => 'no reading', ...ruleTiming('hr_missing') });
  }
  if (metrics.spo2 !== undefined && num(metrics.spo2)) {
    const spMin = nt.spo2_min || gt('spo2Min');
    checkCondition(nodeId, 'spo2_low', noContact ? 'ok' : below(metrics.spo2, spMin, clearMargin('spo2_low')), metrics.spo2,
      { type:'medical', severity:'critical', title:'SpO2 low', fmt: v => `${v}%`, threshold:`alert below ${spMin}%`, worse:'lower', ...ruleTiming('spo2_low') });
  }
  if (num(metrics.temperature) && (nt.temp_min !== undefined || nt.temp_max !== undefined)) {
    checkCondition(nodeId, 'temp_range', outside(metrics.temperature, nt.temp_min ?? -Infinity, nt.temp_max ?? Infinity, clearMargin('temp_range')), metrics.temperature,
      { type:'anomaly', severity:'warning', title:'Temperature out of range', fmt: v => `${v}°C`, threshold:`${nt.temp_min ?? '—'}–${nt.temp_max ?? '—'}°C`, ...ruleTiming('temp_range') });
  }
  if (num(metrics.video_fps) && nt.video_fps_min !== undefined) checkCondition(nodeId, 'fps_low', below(metrics.video_fps, nt.video_fps_min, clearMargin('fps_low')), metrics.video_fps,
    { type:'anomaly', severity:'warning', title:'Video frame rate low', fmt: v => `${v} fps`, threshold:`alert below ${nt.video_fps_min} fps`, worse:'lower', ...ruleTiming('fps_low') });

  // ── One-off events: cooldown per node, inhibited when a bigger alert already covers them ──
  const wifiLowCovers = num(metrics.wifi_rssi) && metrics.wifi_rssi < gt('rssiThreshold');
  const gpsLossCovers = metrics.lock_status === 'lost' || (num(metrics.snr_l1) && metrics.snr_l1 < gt('snrL1Threshold'));
  if (!wifiLowCovers && num(metrics.wifi_rssi) && num(prev.wifi_rssi) && (prev.wifi_rssi - metrics.wifi_rssi) > gt('rssiJumpThreshold'))
    edgeEvent(nodeId, 'rssi_drop', 'anomaly', `Sudden Wi-Fi signal drop on ${label}: ${prev.wifi_rssi} → ${metrics.wifi_rssi} dBm`, 'warning');
  if (!gpsLossCovers && num(metrics.satellites) && num(prev.satellites) && (prev.satellites - metrics.satellites) >= gt('satDropThreshold'))
    edgeEvent(nodeId, 'sat_drop', 'anomaly', `Satellite count dropped on ${label}: ${prev.satellites} → ${metrics.satellites}`, 'critical');
  if (num(metrics.temperature) && num(prev.temperature) && Math.abs(metrics.temperature - prev.temperature) > (nt.temp_jump || gt('tempJumpThreshold')))
    edgeEvent(nodeId, 'temp_spike', 'anomaly', `Temperature spike on ${label}: ${prev.temperature}°C → ${metrics.temperature}°C`, 'warning');

  lastMetrics[nodeId] = { ...lastMetrics[nodeId], ...metrics };
}

function updateNodeState(nodeId, metrics, collectedAt = null) {
  if (!NODES[nodeId]) return;
  if (!nodeState[nodeId]) nodeState[nodeId] = { status:'offline', metrics:{}, lastSeen:null, packetLoss:0 };
  resetWatchdog(nodeId);
  if (activeAlerts[`${nodeId}|offline`]) closeAlert(nodeId, 'offline', (d, a) => a?.title === 'Not reporting'
    ? `${nodeLabel(nodeId)} started reporting${d ? ` after ${d}` : ''}` : `${nodeLabel(nodeId)} back online after ${d}`, 'info', 'watchdog');
  const isHeartbeat = metrics[heartbeatMetricOf(nodeId)] !== undefined;
  // Any message can bring a node back online, but only its next HEARTBEAT closes the gap, so the
  // outage is remembered until then (otherwise it was also reported as "readings lost").
  const wasOffline = !!rfHealth[nodeId]?.offlineSinceHeartbeat;
  // Back from an outage: packet loss starts fresh (the Offline alert already covered the silence).
  if (isHeartbeat && wasOffline && packetCounters[nodeId]) packetCounters[nodeId] = { received: 0, window: [] };
  if (isHeartbeat) trackPacket(nodeId, metrics?._collected_ms);
  const newReading = isHeartbeat && analyzeTransmissionRhythm(nodeId, metrics, wasOffline) !== false;
  if (isHeartbeat && rfHealth[nodeId]) rfHealth[nodeId].offlineSinceHeartbeat = false;
  detectAnomalies(nodeId, metrics);
  nodeState[nodeId].status  = 'online';
  nodeState[nodeId].lastSeen = new Date().toISOString();
  nodeState[nodeId].metrics  = { ...nodeState[nodeId].metrics, ...metrics };
  computeRfVerdict(nodeId, metrics, newReading);
  const dbTimestamp = collectedAt || new Date().toISOString();
  Object.entries(metrics).forEach(([metric, value]) => {
    if (metric.startsWith('_')) return;
    if (isAudiencePhone(nodeId)) return; // audience only: don't write hundreds of rows/sec to disk
    if (metrics._injected) return;        // simulated interference: not real sensor data
    if (typeof value === 'number') dbRun(`INSERT INTO sensor_readings (node_id, metric, value, unit, timestamp) VALUES (?,?,?,?,?)`, [nodeId, metric, value, getUnit(metric), dbTimestamp]);
  });
  io.emit('node:update', {
    nodeId, metrics, status:'online',
    lastSeen: nodeState[nodeId].lastSeen,
    packetLoss: nodeState[nodeId].packetLoss,
    collectedAt,
    rfHealth: rfHealthForClient(nodeId),
  });
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function applyLayout(layout, broadcast = false) {
  currentLayout = layout;
  const newNodes = {};
  (layout.sensors || []).forEach(s => {
    newNodes[s.id] = {
      label: s.label || s.id, type: s.type || 'hub',
      metrics: s.metrics || [], rfFrequency: s.rfFrequency || '2.4ghz',
      publishIntervalMs: s.publishIntervalMs || 1000, thresholds: s.thresholds || {},
      position: s.position || null,
    };
  });
  NODES = Object.keys(newNodes).length ? newNodes : { ...DEFAULT_NODES };
  initNodeState(NODES);
  if (broadcast) io.emit('layout:current', currentLayout);
  console.log(`✅ Layout applied — ${Object.keys(NODES).length} nodes active`);
}

function loadLayoutFromFile() {
  try {
    if (fs.existsSync(LAYOUT_FILE)) {
      const layout = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
      applyLayout(layout);
      console.log(`✅ Layout loaded from layout.json — ${Object.keys(NODES).length} nodes`);
    } else {
      initNodeState(NODES);
      console.log(`ℹ️  No layout.json — using ${Object.keys(NODES).length} default nodes`);
    }
  } catch(e) {
    console.warn('Layout load error:', e.message);
    initNodeState(NODES);
  }
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';

const plainValue = (text) => { const n = parseFloat(text); return Number.isFinite(n) && /^\s*-?[\d.]/.test(text) ? n : text; };

function connectMQTT() {
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod:5000, connectTimeout:3000 });
    mqttClient.on('connect', () => {
      console.log('✅ MQTT connected:', MQTT_BROKER);
      mqttClient.subscribe('smartcity/#');
      mqttClient.subscribe('stage/status/#'); // presenter panel: bridge + stage agent report here
      logEvent('system', null, 'MQTT broker connected', 'info');
    });
    mqttClient.on('error', err => { console.warn('⚠️  MQTT unavailable:', err.message); mqttClient.end(); });
    mqttClient.on('message', (topic, payload) => {
      if (topic.startsWith('stage/status/')) return handleStageStatus(topic.slice('stage/status/'.length), payload);
      const parts = topic.split('/');
      if (parts.length < 3 || parts[0] !== 'smartcity') return;
      const nodeId = parts[1];
      const metric = parts[2];

      // ── Drone telemetry ─────────────────────────────────────────────────────
      if (metric === 'telemetry') {
        try {
          const data = JSON.parse(payload.toString());
          const droneId = data.id || nodeId;
          const wasLost = droneState[droneId]?.status === 'telemetry_lost';
          markRealData(droneId); // a real (or replayed) drone: demo mode stops simulating it
          // Carry the off-path mark forward: each packet replaces the state object, and without this the
          // landing classifier never sees it, so a hijacked drone landing away from home was reported as
          // plain telemetry loss instead of "landed off expected path".
          const lastOffPathTime = droneState[droneId]?._lastOffPathTime ?? null;
          droneState[droneId] = { ...data, lastSeen:new Date().toISOString(), status:'online', telemetryLostAt:null, _lastOffPathTime:lastOffPathTime };
          if (wasLost) {
            const pos = data.x != null ? `x:${data.x.toFixed(2)} y:${data.y.toFixed(2)} z:${data.z?.toFixed(2)??'?'}m` : 'position unknown';
            closeAlert(droneId, 'telemetry', d => `${droneId} telemetry recovered${d ? ` after ${d}` : ''} — now at ${pos}`, 'warning', 'drone_telemetry_recovered');
          }
          if (droneWatchdogTimers[droneId]) clearTimeout(droneWatchdogTimers[droneId]);
          droneWatchdogTimers[droneId] = setTimeout(() => triggerDroneTelemetryLost(droneId), DRONE_TELEMETRY_TIMEOUT_MS);
          if (data.x != null && missionTracker.hasMission(droneId)) {
            const pos    = { x:data.x, y:data.y, z:data.z||0 };
            const result = missionTracker.update(droneId, pos);
            if (result.waypointReached) {
              const progress = missionTracker.getProgress(droneId);
              console.log(`📍 ${droneId} reached waypoint ${progress.visited}/${progress.totalWaypoints}`);
              if (result.missionComplete) logEvent('drone_mission_complete', droneId, `${droneId} mission complete — returning to home`, 'info');
            }
            if (result.offPath) droneState[droneId]._lastOffPathTime = Date.now(); // used by the landing classifier
            // Off route: one alert per excursion. The tracker decides; this only logs state changes.
            if ((pos.z || 0) >= MIN_AIRBORNE_Z) {
              const firstMsg = result.alertMessage;
              checkCondition(droneId, 'off_route', result.offPath ? 'bad' : 'ok', result.deviation ?? 0, {
                type:'drone_off_path', severity:'critical', title:'Off route',
                fmt: v => `${(+v).toFixed(2)} m outside the allowed zone`, worse:'higher', ...ruleTiming('off_route'),
                fireText: v => firstMsg || `${droneId} left its route: ${(+v).toFixed(2)} m outside the allowed zone`,
              });
            }
            // The tracker's verdict travels with the telemetry, so the map shows exactly what the detector decided.
            const prog = missionTracker.getProgress(droneId);
            droneState[droneId].pathCheck = {
              offPath:   result.offPath,
              deviation: result.deviation,
              visited:   prog?.visited ?? 0,
              total:     prog?.totalWaypoints ?? 0,
              complete:  !!prog?.complete,
            };
          }
          if (NODES[droneId]) updateNodeState(droneId, { x:data.x, y:data.y, z:data.z, yaw:data.yaw, battery:data.battery, rssi:data.rssi }, data.timestamp);
          io.emit('drone:telemetry', droneState[droneId]);
          // Battery: one alert per flight that escalates (monitor → low → critical) instead of new events.
          // The on-delay ignores brief voltage sag under thrust. Voltages and delay: config/alerting.json → rules.battery
          const bat = data.battery, B = POLICY.rules.battery;
          if (bat != null && bat > 0) checkCondition(droneId, 'battery', bat < B.alertBelowV ? 'bad' : bat >= B.clearAboveV ? 'ok' : 'hold', bat, {
            type:'drone_battery', title:'Battery low', worse:'lower', ...ruleTiming('battery'),
            severity: v => v < B.criticalBelowV ? 'critical' : v < B.warningBelowV ? 'warning' : 'info',
            fmt: v => `${v.toFixed(2)} V`, fireText: v => `${droneId} battery low: ${v.toFixed(2)} V`,
          });
          // halt flag is ML training label only — not reported to dashboard
        } catch(e) { console.warn('Drone telemetry parse error:', e.message); }
        return;
      }

      // ── Sensor message ──────────────────────────────────────────────────────
      if (isAudiencePhone(nodeId) && Date.now() < audienceEndedUntil) return; // session just ended
      markRealData(nodeId); // real device: demo mode stops simulating this node
      // Audience nodes register through their own path (see registerAudienceNode)
      if (!NODES[nodeId] && isAudienceNode(nodeId)) registerAudienceNode(nodeId);
      // Auto-register unknown nodes (e.g. phones joining via WebSocket MQTT)
      if (!NODES[nodeId]) {
        const phoneMatch = /^phone(\d+)$/.exec(nodeId);
        NODES[nodeId] = {
          label: phoneMatch ? `Phone ${phoneMatch[1]}` : nodeId,
          type: phoneMatch ? 'phone' : 'dynamic',
          metrics: [], rfFrequency: phoneMatch ? 'wifi' : 'unknown',
          publishIntervalMs: 1000, thresholds: {},
          autoRegistered: true, // real traffic only; demo mode never simulates it
        };
        ensureNodeState(nodeId); // was initNodeState({ [nodeId]: ... }), which wiped every other node's state
        console.log(`📱 Auto-registered new node: ${nodeId}`);
        io.emit('state:full', { nodes:nodeState, nodeDefinitions:NODES, droneState }); // open dashboards show it right away
      }
      let metrics = {}, collectedAt = null;
      try {
        const parsed = JSON.parse(payload.toString());
        if (typeof parsed === 'object' && parsed !== null && 'value' in parsed) {
          metrics = { [metric]: parsed.value };
          if (parsed.collected_ms !== undefined) { metrics._collected_ms = parsed.collected_ms; metrics._received_ms = Date.now(); }
          if (parsed.collected_at) collectedAt = parsed.collected_at;
          if (parsed.timestamp_source) metrics._timestamp_source = parsed.timestamp_source;
          // audience only: taps ride along in the same message, so it's still one message per phone per second
          if (isAudiencePhone(nodeId) && Number.isInteger(parsed.pings) && parsed.pings >= 0) metrics.pings = Math.min(parsed.pings, 30);
        } else if (typeof parsed === 'object' && parsed !== null) {
          metrics = parsed;
        } else {
          metrics = { [metric]: plainValue(payload.toString()) };
        }
      } catch { metrics = { [metric]: plainValue(payload.toString()) }; }
      metrics = injectInterference(nodeId, metrics); // no-op unless simulated interference is on
      if (!metrics) return;                          // this reading was "lost"
      updateNodeState(nodeId, metrics, collectedAt);
    });
  } catch(e) { console.warn('⚠️  MQTT unavailable'); }
}

// ─── UDP stub ─────────────────────────────────────────────────────────────────
const UDP_PORT = process.env.UDP_PORT || 9870;
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('message', msg => { try { const data = JSON.parse(msg.toString()); io.emit('drone:telemetry', { ...data, timestamp:new Date().toISOString() }); } catch(e) {} });
udpSocket.on('error', err => console.warn('UDP error:', err.message));
udpSocket.bind(UDP_PORT, () => console.log(`📡 UDP stub on port ${UDP_PORT}`));

// ─── Demo mode ────────────────────────────────────────────────────────────────
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
// Simulated interference (demo mode only). Real interference doesn't just lower a number:
// signal gets weaker and unstable, readings are lost, and devices flush queued readings
// in bursts when they get through. Every detector then sees the same cause.
const simInterference = { wifi: false, gps: false };
// How the simulation behaves: config/simulation.json. Real interference builds up as a source powers on
// or gets closer, and devices farther away notice later, so it ramps in instead of switching on.
const SIM = (() => {
  const def = { rampUpMs: 8000, staggerMs: 1000, autoInterference: false };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'simulation.json'), 'utf8'));
    const out = { ...def };
    for (const k of Object.keys(def)) if (j[k] !== undefined) out[k] = j[k];
    if (!(Number.isInteger(out.rampUpMs) && out.rampUpMs >= 0) || !(Number.isInteger(out.staggerMs) && out.staggerMs >= 0) || typeof out.autoInterference !== 'boolean')
      throw new Error('rampUpMs and staggerMs must be whole milliseconds (0 or more), autoInterference true or false');
    return out;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`⚠️  config/simulation.json ignored (${e.message}); using defaults`);
    return def;
  }
})();
const simStartedAt = { wifi: 0, gps: 0 };
const simNodeDelay = {};                 // per device: how much later it feels the interference
const SIM_FULL = 0.8;                    // from here on the link is effectively broken
const lerp = (a, b, t) => a + (b - a) * t;
// Once the link breaks, losses grow from none to their full rate as the interference peaks
const simLossShare = (lvl) => Math.max(0, Math.min(1, (lvl - SIM_FULL) / (1 - SIM_FULL)));
const simKindOf = (n) => n.type === 'gps' ? 'gps' : (n.rfFrequency === '2.4ghz' && n.type !== 'drone') ? 'wifi' : null;
// 0 = not affected, 1 = full effect
function simIntensity(nodeId) {
  const kind = simKindOf(NODES[nodeId] || {});
  if (!kind || !simInterference[kind]) return 0;
  const key = `${kind}|${nodeId}`;
  if (simNodeDelay[key] === undefined) simNodeDelay[key] = Math.random() * SIM.staggerMs;
  const t = Date.now() - simStartedAt[kind] - simNodeDelay[key];
  if (SIM.rampUpMs === 0) return t >= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, t / SIM.rampUpMs));
}
const realDataSeen = new Set(); // nodes that have sent real MQTT data: demo mode stops simulating them
// First real data for a node that demo mode was simulating: start its radio measurements fresh,
// so simulated timing never mixes with the real device's (it read as ~40% "packet loss" for 30 readings).
function markRealData(nodeId) {
  if (realDataSeen.has(nodeId)) return;
  realDataSeen.add(nodeId);
  if (packetCounters[nodeId]) packetCounters[nodeId] = { received: 0, window: [] };
  if (timestampHistory[nodeId]) timestampHistory[nodeId] = [];
  const h = rfHealth[nodeId];
  if (h) Object.assign(h, { transmissionRhythm: [], collectedMsHistory: [], rssiHistory: [], signalHistory: [], heartbeatIntervals: [],
    recentGaps: 0, recentBulks: 0, packetLossRate: 0, disruptionType: 'none' });
}
// Random automatic interference in demo mode: off unless simulation.json or DEMO_AUTO_INTERFERENCE=true turns it on
const DEMO_AUTO_INTERFERENCE = process.env.DEMO_AUTO_INTERFERENCE !== undefined && process.env.DEMO_AUTO_INTERFERENCE !== ''
  ? process.env.DEMO_AUTO_INTERFERENCE !== 'false' : SIM.autoInterference;

// ─── Simulated interference on LIVE sensors (fault injection) ────────────────
// With demo mode off, the Stage tab's Trigger degrades real readings as they arrive: weaker,
// unstable signal; ~35% of heartbeats dropped; some delivered late as a burst. Nothing is
// transmitted over the air. Injected readings are not stored as real sensor data, and RF timing
// events logged during it are marked "simulated", so research data stays clean.
const injectState = {};
const isInjectionTarget = (nodeId) => {
  const n = NODES[nodeId] || {};
  if (isAudiencePhone(nodeId) || n.autoRegistered) return false;
  return (simInterference.wifi && n.rfFrequency === '2.4ghz' && n.type !== 'drone')
      || (simInterference.gps && n.type === 'gps');
};
function injectInterference(nodeId, metrics) {
  const lvl = isInjectionTarget(nodeId) ? simIntensity(nodeId) : 0;
  if (lvl <= 0) return metrics;
  const full = lvl >= SIM_FULL;            // before this the signal only weakens; after it, readings are lost
  const toward = (v, bad) => full ? bad : lerp(v, bad, lvl);
  const weakRssi = () => -(86 + Math.floor(Math.random() * 12));
  const hb = heartbeatMetricOf(nodeId);
  const isHb = metrics[hb] !== undefined;
  if (full && isHb && Math.random() < 0.35 * simLossShare(lvl)) { injectState[nodeId] = { pending: true }; return null; } // lost reading
  const out = { ...metrics, _injected: true };
  // Signal slides toward the alert line while it builds, and crosses it when the link breaks
  const fade = (v, key) => full ? weakRssi() : Math.round(lerp(v, getThreshold(nodeId, key) + 3, lvl / SIM_FULL));
  if (typeof out.wifi_rssi === 'number')  out.wifi_rssi  = fade(out.wifi_rssi, 'rssiThreshold');
  if (typeof out.signal_433 === 'number') out.signal_433 = fade(out.signal_433, 'signal433Threshold');
  if (typeof out.snr_l1 === 'number')     out.snr_l1     = +toward(out.snr_l1, Math.random() * 10 + 10).toFixed(1);
  if (typeof out.snr_l5 === 'number')     out.snr_l5     = +toward(out.snr_l5, Math.random() * 8 + 8).toFixed(1);
  if (typeof out.satellites === 'number') out.satellites = Math.round(toward(out.satellites, Math.floor(Math.random() * 3)));
  if (full && out.lock_status !== undefined) out.lock_status = 'lost';
  if (full && isHb && injectState[nodeId]?.pending) {   // the queued reading arrives right behind this one
    injectState[nodeId].pending = false;
    const late = { ...out };
    delete late._collected_ms;
    setTimeout(() => { if (isInjectionTarget(nodeId)) updateNodeState(nodeId, { ...late, ...(typeof late.wifi_rssi === 'number' ? { wifi_rssi: weakRssi() } : {}) }); }, 150);
  }
  return out;
}

function startDemoMode() {
  if (demoInterval) { clearInterval(demoInterval); demoInterval = null; }
  if (!DEMO_MODE) return;
  console.log('🎮 Demo mode active' + (DEMO_AUTO_INTERFERENCE ? '' : ' (no automatic interference)'));
  let tick = 0, interferenceActive = false, interferenceNode = null;
  const pendingBurst = {};
  demoInterval = setInterval(() => {
    tick++;
    // Only simulate nodes you defined, and never one that is sending real data
    const nodeIds = Object.keys(NODES).filter(id => !NODES[id]?.autoRegistered && !realDataSeen.has(id));
    if (!nodeIds.length) return;
    if (DEMO_AUTO_INTERFERENCE && tick%60===0&&!interferenceActive) { interferenceNode=nodeIds[Math.floor(Math.random()*nodeIds.length)]; interferenceActive=true; setTimeout(()=>{interferenceActive=false;interferenceNode=null;},15000); }
    if (tick%43===0) { const sn=nodeIds.find(id=>NODES[id]?.type==='security')||nodeIds[0]; logEvent('security',sn,'433 MHz motion sensor triggered','warning'); }
    // How strongly each device is affected right now: 0 = not at all, 1 = fully (ramps in, see config/simulation.json)
    const level = id => (interferenceActive && interferenceNode === id) ? 1 : simIntensity(id);
    nodeIds.forEach(id => {
      const type = NODES[id]?.type, lvl = level(id), jammed = lvl >= SIM_FULL;
      // Badly interfered devices lose readings...
      if (jammed && Math.random() < 0.3 * simLossShare(lvl)) { pendingBurst[id] = true; return; }
      let metrics = {};
      switch(type) {
        case 'environmental': metrics={temperature:+(Math.random()*3+22).toFixed(1),humidity:+(Math.random()*10+45).toFixed(1),wifi_rssi:jammed?-95:+(Math.random()*10-60).toFixed(0),alerts_433:Math.random()>0.97?1:0}; break;
        case 'medical':       metrics={heart_rate:jammed?null:Math.floor(Math.random()*20+65),spo2:jammed?null:+(Math.random()*3+96).toFixed(1),wifi_rssi:jammed?-94:+(Math.random()*10-62).toFixed(0)}; break;
        case 'hub':           metrics={video_fps:jammed?0:+(Math.random()*5+25).toFixed(1),audio_db:jammed?null:+(Math.random()*10+55).toFixed(1),wifi_rssi:jammed?-95:+(Math.random()*10-60).toFixed(0)}; break;
        case 'automation':    metrics={plug_state:jammed?'unknown':(Math.random()>0.3?'on':'off'),wifi_rssi:jammed?-90:+(Math.random()*10-55).toFixed(0)}; break;
        case 'traffic':       metrics={light_state:jammed?'green':['green','green','green','yellow','red','red','red'][Math.floor(tick/4)%7],wifi_rssi:jammed?-93:+(Math.random()*10-57).toFixed(0)}; break;
        case 'security':      metrics={motion_detected:jammed?0:(Math.random()>0.92?1:0),door_open:jammed?0:(Math.random()>0.97?1:0),signal_433:jammed?-85:+(Math.random()*10-55).toFixed(0)}; break;
        case 'gps':           metrics={satellites:jammed?Math.floor(Math.random()*3):Math.floor(Math.random()*4+8),snr_l1:jammed?+(Math.random()*10+10).toFixed(1):+(Math.random()*10+35).toFixed(1),snr_l5:jammed?+(Math.random()*8+8).toFixed(1):+(Math.random()*8+38).toFixed(1),lock_status:jammed?'lost':'locked'}; break;
        default: metrics={wifi_rssi:+(Math.random()*10-60).toFixed(0)};
      }
      // ...their signal weakens as the interference builds, then is weak AND unstable, not a flat number
      const unstable = () => -(86 + Math.floor(Math.random() * 12));
      // While it builds, the signal slides down toward the alert line; it crosses when the link breaks (SIM_FULL)
      const fade = (v, key) => jammed ? unstable() : Math.round(lerp(v, getThreshold(id, key) + 3, lvl / SIM_FULL));
      if (lvl > 0 && typeof metrics.wifi_rssi === 'number')  metrics.wifi_rssi  = fade(metrics.wifi_rssi, 'rssiThreshold');
      if (lvl > 0 && typeof metrics.signal_433 === 'number') metrics.signal_433 = fade(metrics.signal_433, 'signal433Threshold');
      if (lvl > 0 && !jammed && type === 'gps') {   // GPS: signal quality and satellites fall first, then the lock goes
        metrics.snr_l1 = +lerp(metrics.snr_l1, Math.random() * 10 + 10, lvl).toFixed(1);
        metrics.snr_l5 = +lerp(metrics.snr_l5, Math.random() * 8 + 8, lvl).toFixed(1);
        metrics.satellites = Math.round(lerp(metrics.satellites, 1, lvl));
      }
      updateNodeState(id, metrics);
      // ...and when a reading gets through after a loss, the queued one arrives right behind it
      if (pendingBurst[id]) {
        pendingBurst[id] = false;
        if (Math.random() < 0.5) setTimeout(() => {
          if (!realDataSeen.has(id)) updateNodeState(id, { ...metrics, ...(typeof metrics.wifi_rssi === 'number' ? { wifi_rssi: unstable() } : {}) });
        }, 150); // > 100 ms so it counts as a separate (queued) reading, < 200 ms so it reads as a burst
      }
    });
  }, 1000);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const droneRoutes    = require('./routes/drones')({ droneState, droneMissions, missionTracker, io });
// NODES and CONFIG are replaced when the layout or settings change, so routes read them through getters.
const live = { nodes: () => NODES, config: () => CONFIG, nodeState: () => nodeState, rfHealth: () => rfHealth };
const nodeRoutes     = require('./routes/nodes')({ db, live });
const generalRoutes  = require('./routes/general')({ db, live, getLayout: () => currentLayout, LAYOUT_FILE, applyLayout, startDemoMode, DEMO_MODE });

// Read-only view of the alerting policy in effect (config/alerting.json + any override file)
app.get('/api/alerting-policy', (req, res) => res.json({ files: alerting.sources.map(f => path.basename(f)), policy: POLICY }));
app.use('/api/drones',           droneRoutes);
app.use('/api/nodes',            nodeRoutes);
app.use('/api',                  generalRoutes);

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.emit('state:full', { nodes:nodeState, nodeDefinitions:NODES, droneState });
  socket.emit('config:current', CONFIG);
  socket.emit('config:defaults', POLICY.thresholds); // Settings → Reset defaults
  socket.emit('rfhealth:full', rfHealth);
  socket.emit('layout:current', currentLayout);
  socket.emit('drone:state', droneState);
  socket.emit('events:recent', dbAll(`SELECT * FROM events WHERE rowid > ? ORDER BY rowid DESC LIMIT 100`, [eventsResetRowid]).reverse());
  socket.emit('events:stats', eventStats());
  socket.emit('stage:status', stageStatus);
  socket.emit('alerts:active', activeAlertList());
  socket.on('config:update', updates => applyConfigUpdate(updates));
  socket.on('stage:command', (cmd, ack) => handleStageCommand(cmd, r => { if (typeof ack === 'function') ack(r); }));
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Smart City Monitor on http://localhost:${PORT}`);
  console.log(`📊 API:    http://localhost:${PORT}/api/nodes`);
  console.log(`📋 Layout: http://localhost:${PORT}/api/layout`);
  console.log(`📡 UDP:    port ${UDP_PORT}\n`);
  loadLayoutFromFile();
  connectMQTT();
  startDemoMode();
});
