'use strict';

/*
 * Stage agent — runs on the presenter laptop (the launcher starts it for you).
 *
 * Listens on the bus for presenter-panel commands (stage/command) aimed at the drone
 * replay, runs drone-replay/replay.js as a child process, and reports what it's doing
 * on stage/status/replay (retained) so the dashboard's Stage tab can show progress.
 *
 *   {"target":"replay","action":"start","args":{"speed":2}}
 *   {"target":"replay","action":"stop"}
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const { loadConfig } = require('./config');

const cfg = loadConfig();
const COMMAND_TOPIC = 'stage/command';
const STATUS_TOPIC = 'stage/status/replay';

const broker = mqtt.connect(cfg.mqttBroker, {
  clientId: `stage-agent-${process.pid}`,
  reconnectPeriod: 1000,
  will: { topic: STATUS_TOPIC, payload: JSON.stringify({ online: false, state: 'offline' }), qos: 1, retain: true },
});

let child = null;
let current = { online: true, state: 'idle' };

function publish(update) {
  current = { ...current, ...update, online: true, at: Date.now() };
  if (broker.connected) broker.publish(STATUS_TOPIC, JSON.stringify(current), { qos: 1, retain: true });
}

broker.on('connect', () => {
  console.log(`mqtt connected: ${cfg.mqttBroker}`);
  broker.subscribe(COMMAND_TOPIC);
  const problems = replayProblems();
  problems.forEach((p) => console.log(`WARNING: ${p}`));
  publish(problems.length ? { lastResult: `not ready: ${problems[0]}` } : {});
});
process.on('uncaughtException', (e) => { console.log(`agent error (kept running): ${e.stack || e.message}`); });
broker.on('error', (e) => console.log(`mqtt error: ${e.message}`));

broker.on('message', (topic, payload) => {
  if (topic !== COMMAND_TOPIC) return;
  let cmd;
  try { cmd = JSON.parse(payload.toString()); } catch { return; }
  if (cmd?.target !== 'replay') return;
  if (cmd.action === 'start') startReplay(cmd.args?.speed);
  else if (cmd.action === 'stop') stopReplay('stopped');
});

// Everything the replay needs, checked before starting, so a wrong path shows up in the
// dashboard as a clear message instead of a crash.
function replayProblems() {
  const r = cfg.replay;
  const problems = [];
  if (!fs.existsSync(r.dir)) problems.push(`replay folder not found: ${r.dir}`);
  else {
    if (!fs.existsSync(path.join(r.dir, 'replay.js'))) problems.push(`replay.js not found in ${r.dir}`);
    try { require.resolve('mqtt', { paths: [r.dir] }); } catch { problems.push('dependencies missing: run npm install in the repo root'); }
  }
  if (!fs.existsSync(r.profile)) problems.push(`profile not found: ${r.profile}`);
  r.flights.forEach((f) => { if (!fs.existsSync(f)) problems.push(`flight file not found: ${f}`); });
  return problems;
}

function startReplay(speedArg) {
  if (child) { console.log('replay already running, ignoring start'); return; }
  const r = cfg.replay;
  const speed = Math.min(8, Math.max(0.5, Number(speedArg) || r.defaultSpeed || 1));
  const problems = replayProblems();
  if (problems.length) {
    problems.forEach((p) => console.log(`cannot start replay: ${p}`));
    publish({ state: 'idle', phase: null, lastResult: `failed: ${problems[0]}` });
    return;
  }
  const script = path.join(r.dir, 'replay.js');
  const args = [script, '--status-json', '--speed', String(speed), '--mqtt', cfg.mqttBroker, '--api', cfg.api,
    '--profile', r.profile, ...r.flights];
  console.log(`starting replay at ${speed}x`);
  publish({ state: 'starting', speed, phase: null, startedAt: null, durationS: null, attackAtS: null, lastResult: null });

  try {
    child = spawn(process.execPath, args, { cwd: r.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    child = null;
    console.log(`cannot start replay: ${e.message}`);
    publish({ state: 'idle', phase: null, lastResult: `failed: ${e.message}` });
    return;
  }
  const proc = child;
  const finish = (result) => {
    if (child !== proc) return; // already handled
    child = null;
    console.log(`replay ${result}`);
    publish({ state: 'idle', phase: null, lastResult: result });
  };
  // Without this handler a failed spawn crashes the whole agent.
  proc.on('error', (e) => {
    console.log(`replay could not run: ${e.code || ''} ${e.message}`);
    proc._stopReason = `failed: ${e.code || e.message}`;
    if (proc.pid === undefined) finish(proc._stopReason); // never started, so no close event is guaranteed
  });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('@@STATUS ')) {
        try {
          const s = JSON.parse(line.slice(9));
          publish({ state: s.phase === 'finished' ? 'finishing' : 'running', ...s });
        } catch { /* ignore malformed status */ }
      } else if (line.trim()) {
        console.log(line.trim());
      }
    }
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  proc.on('close', (code, signal) => {
    if (buf.trim()) console.log(buf.trim()); // last line had no newline yet
    buf = '';
    finish(proc._stopReason || (code === 0 ? 'finished' : `failed (exit ${code ?? signal}): see agent lines above`));
  });
}

function stopReplay(reason) {
  if (!child) return;
  child._stopReason = reason;
  child.kill();
}

function shutdown() {
  stopReplay('stopped');
  broker.publish(STATUS_TOPIC, JSON.stringify({ online: false, state: 'offline' }), { qos: 1, retain: true }, () => {
    broker.end(false, () => process.exit(0));
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
