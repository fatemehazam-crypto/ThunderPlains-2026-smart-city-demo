'use strict';

// Settings for the launcher and the stage agent.
// Everything has a default, so `npm start` works with no config at all.
// To change something, copy stage.config.example.json to stage.config.json and edit it.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const FILE = path.join(HERE, 'stage.config.json');

const DEFAULTS = {
  broker: 'built-in',                 // "built-in" = start our own MQTT broker; "external" = use mqttBroker below
  mqttBroker: 'mqtt://localhost:1883',
  api: 'http://localhost:3001',
  dashboardUrl: 'http://localhost:3000',
  openBrowser: true,
  demoMode: true,                     // simulate the sensors in backend/layout.json until real ones publish
  relay: 'local',                     // "local" = phones on your Wi-Fi; "remote" = a relay you deployed (see docs/DEPLOY_RELAY.md)
  relayPort: 8080,
  relayUrl: '',                       // remote relay only, e.g. https://your-name.onrender.com
  stageToken: '',                     // remote relay only: the same STAGE_TOKEN you set on the host
  backendEnv: {},                     // extra environment variables for the backend
  replay: {
    defaultSpeed: 2,
    profile: 'flights/profile_1.json',
    flights: ['flights/attacked_cf-e8.jsonl', 'flights/attacked_cf-e9.jsonl'],
  },
};

function loadConfig() {
  let raw = {};
  if (fs.existsSync(FILE)) {
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
      console.error(`stage/stage.config.json is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  const cfg = { ...DEFAULTS, ...raw, replay: { ...DEFAULTS.replay, ...(raw.replay || {}) } };
  const replayDir = path.join(ROOT, 'drone-replay');
  cfg.dirs = {
    root: ROOT,
    broker: path.join(ROOT, 'broker'),
    relay: path.join(ROOT, 'relay'),
    backend: path.join(ROOT, 'backend'),
    frontend: path.join(ROOT, 'frontend'),
    bridge: path.join(ROOT, 'bridge'),
    stage: HERE,
  };
  cfg.replay = {
    dir: replayDir,
    defaultSpeed: cfg.replay.defaultSpeed,
    profile: path.resolve(replayDir, cfg.replay.profile),
    flights: cfg.replay.flights.map((f) => path.resolve(replayDir, f)),
  };
  return cfg;
}

module.exports = { loadConfig, HERE, ROOT };
