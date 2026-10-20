'use strict';

/*
 * Drone flight replay.
 *
 * Replays recorded Crazyflie flights (the .jsonl files your trial logger writes)
 * through the same path a live flight takes:
 *
 *   1. registers each drone's mission with the backend (POST /api/drones/:id/mission),
 *      exactly like the pre-flight step
 *   2. publishes every telemetry sample to smartcity/<droneId>/telemetry on MQTT,
 *      with the original timing between samples
 *
 * The backend, mission tracker, events and dashboard can't tell it from a live flight.
 * Ground-truth attack labels in the recording (attack_command_received etc.) are NOT
 * sent to the backend; they're only printed here so you know when the attack is coming.
 *
 * Usage:
 *   node replay.js --profile profile_1.json flight_cf-e8.jsonl flight_cf-e9.jsonl
 *
 * Options:
 *   --profile <file>   mission profile with roles [{start, waypoints}] (required)
 *   --speed <n>        playback speed, default 1 (real time)
 *   --api <url>        backend, default http://localhost:3001
 *   --mqtt <url>       broker, default $MQTT_BROKER or mqtt://localhost:1883
 *   --lead <seconds>   pause between mission registration and first sample, default 3
 *   --loop             replay again when finished
 *   --status-json      also print machine-readable "@@STATUS {...}" lines (used by the stage agent)
 */

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const files = [];
const opt = { speed: 1, api: 'http://localhost:3001', mqtt: process.env.MQTT_BROKER || 'mqtt://localhost:1883', lead: 3, loop: false, profile: null, statusJson: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--speed') opt.speed = Number(argv[++i]);
  else if (a === '--api') opt.api = argv[++i];
  else if (a === '--mqtt') opt.mqtt = argv[++i];
  else if (a === '--lead') opt.lead = Number(argv[++i]);
  else if (a === '--profile') opt.profile = argv[++i];
  else if (a === '--loop') opt.loop = true;
  else if (a === '--status-json') opt.statusJson = true;
  else files.push(a);
}
if (!opt.profile || files.length === 0 || !(opt.speed > 0)) {
  console.error('Usage: node replay.js --profile profile_1.json [--speed 1] flight1.jsonl [flight2.jsonl ...]');
  process.exit(1);
}

// ---------------------------------------------------------------- load
const profile = JSON.parse(fs.readFileSync(opt.profile, 'utf8'));
const sameWaypoints = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const flights = files.map((file) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (!lines[0].startsWith('#HEADER:')) throw new Error(`${path.basename(file)}: missing #HEADER line`);
  const header = JSON.parse(lines[0].slice('#HEADER:'.length));
  const role = (profile.roles || []).find((r) => sameWaypoints(r.waypoints, header.mission));
  if (!role) throw new Error(`${path.basename(file)}: no role in ${opt.profile} matches mission ${JSON.stringify(header.mission)}`);
  const records = lines.slice(1).map((l) => JSON.parse(l));
  const telemetry = records
    .filter((r) => r.type === 'drone:telemetry' && Number.isFinite(r.x))
    .map((r) => ({ t: Date.parse(r.timestamp), r }));
  const labels = records
    .filter((r) => r.type === 'trial:event' && /^attack|^attacker_(armed|landing_initiated)/.test(r.event))
    .map((r) => ({ t: Date.parse(r.wall_time), r }));
  return { file, header, role, telemetry, labels };
});

// One timeline across all drones, ordered by the original wall-clock time.
const timeline = flights
  .flatMap((f) => f.telemetry.map((s) => ({ ...s, droneId: f.header.drone_id })))
  .sort((a, b) => a.t - b.t);
const labels = flights.flatMap((f) => f.labels).sort((a, b) => a.t - b.t)
  .filter((l, i, all) => i === 0 || l.t !== all[i - 1].t || l.r.event !== all[i - 1].r.event);
const t0 = timeline[0].t;
const durationS = (timeline[timeline.length - 1].t - t0) / 1000;

// ---------------------------------------------------------------- run
const client = mqtt.connect(opt.mqtt, { clientId: `drone-replay-${process.pid}`, reconnectPeriod: 1000 });
client.on('error', (e) => log(`mqtt error: ${e.message}`));

async function registerMissions() {
  for (const f of flights) {
    const { drone_id, mission_profile, condition, trial_id } = f.header;
    const body = { mission_profile, condition: `replay (${condition})`, trial_id, roles: [f.role] };
    let res;
    try {
      res = await fetch(`${opt.api}/api/drones/${encodeURIComponent(drone_id)}/mission`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`cannot reach the backend at ${opt.api} to register ${drone_id}'s mission. Is it running? (${e.cause?.code || e.message})`);
    }
    if (!res.ok) throw new Error(`registering ${drone_id}: HTTP ${res.status}`);
    log(`mission registered: ${drone_id}  start ${JSON.stringify(f.role.start)}  waypoints ${JSON.stringify(f.role.waypoints)}`);
  }
}

function publish(sample) {
  const r = sample.r;
  // Flight fields only. The recording's halt/controller fields are trial labels, not telemetry.
  const payload = {
    id: sample.droneId, x: r.x, y: r.y, z: r.z, yaw: r.yaw, roll: r.roll, pitch: r.pitch,
    battery: r.battery, rssi: r.rssi, timestamp: new Date().toISOString(),
  };
  client.publish(`smartcity/${sample.droneId}/telemetry`, JSON.stringify(payload));
}

function play() {
  return new Promise((resolve) => {
    const start = Date.now();
    log(`replaying ${timeline.length} samples from ${flights.length} drone(s), ${durationS.toFixed(0)} s of flight at ${opt.speed}x`);
    const firstAttack = labels.find((l) => l.r.event === 'attack_command_received');
    if (firstAttack) log(`first attack command at ${((firstAttack.t - t0) / 1000 / opt.speed).toFixed(1)} s into the replay`);
    status({
      phase: 'flying', speed: opt.speed, startedAt: start,
      durationS: durationS / opt.speed,
      attackAtS: firstAttack ? (firstAttack.t - t0) / 1000 / opt.speed : null,
      drones: flights.map((f) => f.header.drone_id),
    });

    timeline.forEach((s) => setTimeout(() => publish(s), (s.t - t0) / opt.speed));

    // Presenter cues (terminal only): countdown to the attack, then each attack step.
    if (firstAttack) {
      const at = (firstAttack.t - t0) / opt.speed;
      [10, 5, 3, 2, 1].forEach((n) => {
        if (at - n * 1000 > 0) setTimeout(() => log(`attack in ${n}...`), at - n * 1000);
      });
    }
    labels.forEach((l) => setTimeout(() => {
      const r = l.r;
      const extra = r.commanded_x != null ? ` → commanded (${r.commanded_x}, ${r.commanded_y}, ${r.commanded_z})` : '';
      log(`[ground truth] ${r.event}${extra}`);
    }, (l.t - t0) / opt.speed));

    const progress = setInterval(() => {
      if (!process.stdout.isTTY) return; // piped (stage agent): no live progress line
      const s = (Date.now() - start) / 1000 * opt.speed;
      process.stdout.write(`\r  flight time ${s.toFixed(0).padStart(4)} / ${durationS.toFixed(0)} s   `);
    }, 1000);
    setTimeout(() => { clearInterval(progress); resolve(); }, (durationS * 1000) / opt.speed + 500);
  });
}

// Piped (stage launcher/agent): end each line with a newline so it shows up immediately.
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  process.stdout.write(process.stdout.isTTY ? `\n${line}` : `${line}\n`);
}
function status(obj) { if (opt.statusJson) process.stdout.write(`\n@@STATUS ${JSON.stringify(obj)}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

client.on('connect', async () => {
  log(`mqtt connected: ${opt.mqtt}`);
  try {
    do {
      status({ phase: 'registering', speed: opt.speed });
      await registerMissions();
      await sleep(opt.lead * 1000);
      await play();
      log('replay finished');
      status({ phase: 'finished' });
      if (opt.loop) await sleep(8000); // let landing/telemetry-lost classification finish first
    } while (opt.loop);
  } catch (e) {
    log(`error: ${e.message}`);
    process.exitCode = 1;
  }
  client.end(false, () => process.exit());
});
process.on('SIGINT', () => { log('stopped'); client.end(true, () => process.exit()); });
