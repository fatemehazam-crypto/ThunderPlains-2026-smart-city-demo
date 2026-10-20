'use strict';
/*
 * Sensor check: watches the MQTT bus and tells you what each sensor really sends.
 * Handy when you add your own ESP32. From the repo root:
 *
 *   npm run check-sensors                                 listens to mqtt://localhost:1883 for 60 s
 *   npm run check-sensors -- mqtt://192.168.1.50:1883 90   another broker, 90 s
 *
 * If your broker needs a login, set MQTT_USERNAME and MQTT_PASSWORD first.
 *
 * It prints:
 *   1. the first raw messages, as they arrive
 *   2. per sensor: how many readings vs messages, which metrics share a reading
 *   3. per sensor and metric: how often it really arrives (by collected_ms and by arrival time)
 */
const mqtt = require('mqtt');

const url = process.argv[2] || process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const seconds = Number(process.argv[3] || 60);

// ── Listen to the live bus ──────────────────────────────────────────────
const opts = { reconnectPeriod: 0, connectTimeout: 8000 };
if (process.env.MQTT_USERNAME) { opts.username = process.env.MQTT_USERNAME; opts.password = process.env.MQTT_PASSWORD; }
const client = mqtt.connect(url, opts);

const t0 = Date.now();
const streams = {};   // `${node}|${metric}` -> [{ t, cms }]
const readings = {};  // node -> Map(collected_ms -> Set(metric))
const messages = {};  // node -> count
let shown = 0;
const SHOW = 40;

client.on('error', (e) => { console.log(`\nCannot connect to ${url}: ${e.message}`); process.exit(1); });
client.on('connect', () => {
  console.log(`\nListening to ${url} for ${seconds} s (smartcity/#)...`);
  console.log(`\n1. First ${SHOW} raw messages (time since start, topic, payload):`);
  client.subscribe('smartcity/#');
});

client.on('message', (topic, payload) => {
  const t = Date.now() - t0;
  const text = payload.toString();
  if (shown < SHOW) { console.log(`   ${String(t).padStart(6)} ms  ${topic}  ${text.slice(0, 120)}`); shown++; }
  const [, node, metric] = topic.split('/');
  if (!node || !metric || node.startsWith('aud') || node.startsWith('audience-') || metric === 'telemetry') return;
  let cms = null;
  try { const p = JSON.parse(text); if (p && typeof p.collected_ms === 'number') cms = p.collected_ms; } catch { /* not JSON */ }
  (streams[`${node}|${metric}`] ||= []).push({ t, cms });
  messages[node] = (messages[node] || 0) + 1;
  if (cms !== null) {
    const m = (readings[node] ||= new Map());
    if (!m.has(cms)) m.set(cms, new Set());
    m.get(cms).add(metric);
  }
});

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const stats = (vals) => {
  const d = []; for (let i = 1; i < vals.length; i++) d.push(vals[i] - vals[i - 1]);
  if (!d.length) return { median: '—', min: '—', max: '—' };
  return { median: median(d), min: Math.min(...d), max: Math.max(...d) };
};

setTimeout(() => {
  client.end(true);
  console.log(`\n2. Readings vs messages per sensor (${seconds} s):`);
  const perNode = Object.keys(messages).sort().map((node) => {
    const m = readings[node];
    const groups = m ? [...m.values()] : [];
    const combos = {};
    groups.forEach((g) => { const k = [...g].sort().join('+'); combos[k] = (combos[k] || 0) + 1; });
    return {
      sensor: node,
      messages: messages[node],
      readings_by_collected_ms: m ? m.size : 'no collected_ms',
      metrics_per_reading: m ? +(messages[node] / m.size).toFixed(2) : '—',
      metric_groups_seen: Object.entries(combos).map(([k, n]) => `${k} ×${n}`).join(', ') || '—',
    };
  });
  if (perNode.length) console.table(perNode); else console.log('   no sensor messages received');

  console.log('\n3. How often each metric really arrives (milliseconds between messages):');
  const perMetric = Object.keys(streams).sort().map((k) => {
    const [node, metric] = k.split('|');
    const s = streams[k];
    const byDevice = stats(s.filter((x) => x.cms !== null).map((x) => x.cms));
    const byArrival = stats(s.map((x) => x.t));
    return { sensor: node, metric, count: s.length,
      device_median: byDevice.median, device_min: byDevice.min, device_max: byDevice.max,
      arrival_median: byArrival.median, arrival_min: byArrival.min, arrival_max: byArrival.max };
  });
  if (perMetric.length) console.table(perMetric);
  console.log('\n');
  process.exit(0);
}, seconds * 1000);
