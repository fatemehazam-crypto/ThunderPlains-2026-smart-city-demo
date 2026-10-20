'use strict';

/*
 * One command for everything:   npm start   (from the repo root)
 *
 * Starts, in this one window with coloured prefixes:
 *   broker    built-in MQTT broker (unless you use your own)
 *   relay     the phone page + gatekeeper for the audience demo (local mode)
 *   backend   event-bus backend on :3001
 *   bridge    relay -> MQTT, for the audience phones
 *   agent     runs drone replays when you press the button in the Stage tab
 *   frontend  the dashboard on :3000
 *
 * Ctrl+C stops all of them. Works on Mac, Windows and Linux.
 * Settings: stage/stage.config.json (optional, see stage.config.example.json).
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { loadConfig } = require('./config');

const cfg = loadConfig();
const isWin = process.platform === 'win32';
const NODE = `"${process.execPath}"`;
const COLORS = { broker: 34, relay: 94, backend: 36, frontend: 35, bridge: 33, agent: 32, stage: 37 };
const children = [];
let stopping = false;

function say(name, line, isErr) {
  const c = COLORS[name] || 37;
  (isErr ? process.stderr : process.stdout).write(`\x1b[${c}m${name.padEnd(8)}\x1b[0m | ${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Checks ───────────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  say('stage', `Node ${process.versions.node} is too old. Install Node 22 LTS or newer (https://nodejs.org), then run npm install and npm start again.`, true);
  process.exit(1);
}
if (!fs.existsSync(path.join(cfg.dirs.root, 'node_modules'))) {
  say('stage', 'First run: installing everything (one time, about a minute)...');
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], { cwd: cfg.dirs.root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { say('stage', 'npm install failed. Fix the error above and run npm start again.', true); process.exit(1); }
}

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}
async function waitForPort(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await portInUse(port)) return true; await sleep(250); }
  return false;
}

// The address phones and ESP32s use to reach this laptop.
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(vEthernet|docker|br-|veth|utun|awdl|llw|bridge|vmnet|VirtualBox|Hyper-V)/i.test(name)) continue;
      candidates.push(a.address);
    }
  }
  const priv = candidates.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv || candidates[0] || 'localhost';
}

// ─── Processes ────────────────────────────────────────────────────────────────
function run(name, command, dir, env = {}) {
  const child = spawn(command, {
    cwd: dir,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    shell: true,
    detached: !isWin, // own process group on Mac/Linux so we can stop the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ name, child });
  const pipe = (stream, isErr) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach((l) => { if (l.trim()) say(name, l, isErr); });
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on('exit', (code) => {
    if (!stopping) say(name, `\x1b[41m STOPPED (exit ${code}) \x1b[0m  the rest keeps running; fix the error above and run npm start again`, true);
  });
  return child;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  say('stage', 'stopping everything...');
  // Bridge and agent first so their "offline" status reaches the broker before it stops.
  const order = ['agent', 'bridge', 'frontend', 'backend', 'relay', 'broker'];
  children.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).forEach(({ child }) => killTree(child));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
// Closing the terminal window sends SIGHUP: stop everything then too, or the children
// (in their own process groups) keep running and pile up on the next npm start.
process.on('SIGHUP', stopAll);

function openBrowser(url) {
  const cmd = isWin ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  const lan = lanAddress();
  const mqttPort = Number(new URL(cfg.mqttBroker).port) || 1883;
  const apiPort = Number(new URL(cfg.api).port) || 3001;
  const dashPort = Number(new URL(cfg.dashboardUrl).port) || 3000;

  // Leftovers from an earlier run are the most common problem: say so clearly.
  const busy = [];
  if (await portInUse(apiPort)) busy.push(apiPort);
  if (await portInUse(dashPort)) busy.push(dashPort);
  if (cfg.relay === 'local' && await portInUse(cfg.relayPort)) busy.push(cfg.relayPort);
  if (busy.length) {
    say('stage', `Port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} already in use: something from an earlier run is still going.`, true);
    say('stage', isWin
      ? 'Close the other terminal windows running it (or restart the computer), then run npm start again.'
      : `Stop it with:  kill $(lsof -ti ${busy.map((p) => `tcp:${p}`).join(' -ti ')})   then run npm start again.`, true);
    process.exit(1);
  }

  // 1. MQTT broker
  if (cfg.broker === 'built-in') {
    if (await portInUse(mqttPort)) {
      say('broker', `an MQTT broker is already running on port ${mqttPort}; using that one`);
    } else {
      run('broker', `${NODE} broker.mjs`, cfg.dirs.broker, { MQTT_PORT: String(mqttPort) });
      if (!(await waitForPort(mqttPort, 10000))) say('broker', 'did not start in time', true);
    }
  }

  // 2. Phone relay. Local mode makes a fresh secret every run to link it to the bridge.
  let relayUrl = cfg.relayUrl, stageToken = cfg.stageToken, phoneUrl = '';
  if (cfg.relay === 'local') {
    stageToken = crypto.randomBytes(24).toString('hex');
    phoneUrl = `http://${lan}:${cfg.relayPort}`;
    relayUrl = `http://localhost:${cfg.relayPort}`;
    run('relay', `${NODE} server.js`, cfg.dirs.relay, { PORT: String(cfg.relayPort), STAGE_TOKEN: stageToken, PUBLIC_URL: phoneUrl });
    await waitForPort(cfg.relayPort, 10000);
  } else if (relayUrl) {
    phoneUrl = relayUrl;
    // Wake the hosted relay early (free tiers sleep when idle).
    fetch(`${relayUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(90000) })
      .then((r) => r.json()).then((j) => say('stage', `remote relay is up: ${JSON.stringify(j)}`))
      .catch((e) => say('stage', `remote relay not reachable yet (${e.message}); the bridge keeps retrying`, true));
  }

  // 3. Backend
  run('backend', `${NODE} --no-warnings=ExperimentalWarning server.js`, cfg.dirs.backend, {
    PORT: String(apiPort),
    MQTT_BROKER: cfg.mqttBroker,
    DEMO_MODE: cfg.demoMode ? 'true' : 'false',
    DEMO_AUTO_INTERFERENCE: 'false',
    ...(cfg.backendEnv || {}),
  });
  if (!(await waitForPort(apiPort, 20000))) say('backend', 'did not open its port in time', true);

  // 4. Audience bridge
  if (relayUrl && stageToken && stageToken.length >= 16) {
    run('bridge', `${NODE} bridge.js`, cfg.dirs.bridge, { RELAY_URL: relayUrl, JOIN_URL: phoneUrl, STAGE_TOKEN: stageToken, MQTT_URL: cfg.mqttBroker });
  } else {
    say('stage', 'phone demo off: relay is "remote" but relayUrl / stageToken (16+ characters) are missing in stage/stage.config.json', true);
  }

  // 5. Stage agent (drone replays) and 6. dashboard
  run('agent', `${NODE} agent.js`, cfg.dirs.stage);
  run('frontend', 'npm run dev', cfg.dirs.frontend);
  await waitForPort(dashPort, 30000);

  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  Dashboard        ${cfg.dashboardUrl}`);
  if (phoneUrl) console.log(`  Phones join at   ${phoneUrl}   (QR code in the Stage tab)`);
  console.log(`  ESP32 / MQTT     ${cfg.broker === 'built-in' ? lan : new URL(cfg.mqttBroker).hostname}:${mqttPort}   topic smartcity/<node-id>/<metric>`);
  console.log(`  Stop everything  Ctrl+C`);
  console.log(`${line}\n`);
  if (cfg.openBrowser) openBrowser(cfg.dashboardUrl);
})();
