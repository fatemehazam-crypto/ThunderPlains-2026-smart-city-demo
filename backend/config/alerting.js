'use strict';
/*
 * Loads the alerting policy (config/alerting.json): when alerts fire, clear and group.
 *
 *   1. config/alerting.json        the defaults, kept in git
 *   2. an override file, optional:  ALERTING_CONFIG=/path/to/file.json, or config/alerting.local.json
 *      Only the keys you want to change; it is merged over the defaults.
 *
 * The result is checked once at startup. Any mistake (a typo in a key, a negative time,
 * a margin that isn't a number) stops the backend with a message that names the key,
 * instead of quietly running with a policy nobody intended.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS_FILE = path.join(__dirname, 'alerting.json');
const LOCAL_FILE = path.join(__dirname, 'alerting.local.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`Alerting policy: cannot read ${file}: ${e.message}`); }
}

// Keys starting with "_" are notes for people, not settings.
function stripNotes(v) {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripNotes(x)]));
}

// Override keys must already exist in the defaults (catches typos); objects merge, everything else replaces.
function merge(base, over, where, errors) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const at = where ? `${where}.${k}` : k;
    const isRuleOption = /^rules\.[^.]+\.[^.]+$/.test(at); // a rule may set any rule option, even one its default doesn't
    if (!(k in base) && !isRuleOption) { errors.push(`${at}: unknown setting (typo?)`); continue; }
    out[k] = isObj(base[k]) && isObj(v) ? merge(base[k], v, at, errors) : v;
  }
  return out;
}

const RULE_OPTIONS = new Set(['alertAfterMs', 'clearAfterMs', 'clearMargin', 'alertBelowV', 'clearAboveV', 'warningBelowV', 'criticalBelowV']);

function validate(p) {
  const errors = [];
  const walk = (v, at) => {
    if (isObj(v)) return Object.entries(v).forEach(([k, x]) => walk(x, at ? `${at}.${k}` : k));
    if (Array.isArray(v)) return v.forEach((x, i) => { if (typeof x !== 'string') errors.push(`${at}[${i}]: must be text`); });
    if (typeof v === 'number' && !Number.isFinite(v)) return errors.push(`${at}: must be a number`);
    const leaf = at.split('.').pop();
    if (/Ms$/.test(leaf) && !(Number.isInteger(v) && v >= 0)) errors.push(`${at}: must be a whole number of milliseconds, 0 or more (got ${JSON.stringify(v)})`);
    else if (/(Margin|M|Pct|Db|Devices|Readings|Phones|Intervals|Interval)$/.test(leaf) && !(typeof v === 'number' && v >= 0)) errors.push(`${at}: must be a number, 0 or more (got ${JSON.stringify(v)})`);
    else if (typeof v !== 'number' && typeof v !== 'string') errors.push(`${at}: must be a number (got ${JSON.stringify(v)})`);
  };
  walk(p, '');
  for (const [key, r] of Object.entries(p.rules || {})) {
    if (!isObj(r)) { errors.push(`rules.${key}: must be an object`); continue; }
    for (const opt of Object.keys(r)) if (!RULE_OPTIONS.has(opt)) errors.push(`rules.${key}.${opt}: unknown rule option (use ${[...RULE_OPTIONS].join(', ')})`);
  }
  const b = p.rules?.battery || {};
  if (!(b.criticalBelowV <= b.warningBelowV && b.warningBelowV <= b.alertBelowV && b.alertBelowV < b.clearAboveV))
    errors.push('rules.battery: needs criticalBelowV <= warningBelowV <= alertBelowV < clearAboveV');
  const t = p.thresholds || {};
  if (!(t.heartRateMin < t.heartRateMax)) errors.push('thresholds: heartRateMin must be below heartRateMax');
  if (!(t.watchdogTimeout > 0)) errors.push('thresholds.watchdogTimeout: must be more than 0 seconds');
  const g = p.grouping || {};
  for (const k of [...(g.causes || []), ...(g.symptoms || [])]) if (!(k in (p.rules || {})) && !KNOWN_ALERT_KEYS.has(k)) errors.push(`grouping: "${k}" is not an alert this system raises`);
  return errors;
}
// Alerts raised in code that have no rule entry of their own (they use the defaults).
const KNOWN_ALERT_KEYS = new Set(['wifi_low', '433_low', 'gps_l1_low', 'gps_l5_low', 'gps_lock', 'hr_range', 'hr_missing', 'spo2_low',
  'temp_range', 'fps_low', 'readings_lost', 'rf_degraded', 'off_route', 'battery', 'offline', 'telemetry']);

function deepFreeze(o) { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); }

function load() {
  const errors = [];
  const sources = [DEFAULTS_FILE];
  let policy = stripNotes(readJson(DEFAULTS_FILE));
  const overrideFile = process.env.ALERTING_CONFIG ? path.resolve(process.env.ALERTING_CONFIG) : (fs.existsSync(LOCAL_FILE) ? LOCAL_FILE : null);
  if (overrideFile) {
    policy = merge(policy, stripNotes(readJson(overrideFile)), '', errors);
    sources.push(overrideFile);
  }
  // Older environment variables keep working and win over the files.
  const envMs = (name) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : undefined);
  policy.audience = { ...policy.audience };
  if (envMs('AUDIENCE_WATCHDOG_MS') !== undefined) policy.audience.watchdogMs = envMs('AUDIENCE_WATCHDOG_MS');
  if (envMs('AUDIENCE_AUTO_PURGE_MS') !== undefined) policy.audience.autoPurgeMs = envMs('AUDIENCE_AUTO_PURGE_MS');

  errors.push(...validate(policy));
  if (errors.length) {
    const msg = `Alerting policy is invalid (${sources.map((s) => path.basename(s)).join(' + ')}):\n  - ${errors.join('\n  - ')}`;
    const err = new Error(msg); err.code = 'ALERTING_POLICY_INVALID'; throw err;
  }
  return { policy: deepFreeze(policy), sources };
}

const { policy, sources } = load();

// Timing for one alert: its own rule, falling back to the defaults.
function ruleTiming(key) {
  const r = policy.rules[key] || {};
  return {
    forMs: r.alertAfterMs ?? policy.defaults.alertAfterMs,
    resolveMs: r.clearAfterMs ?? policy.defaults.clearAfterMs,
  };
}
const clearMargin = (key) => policy.rules[key]?.clearMargin ?? 0;
const groupWaitMs = (demoMode) => (demoMode ? policy.grouping.waitMs.demo : policy.grouping.waitMs.live);

module.exports = { policy, sources, ruleTiming, clearMargin, groupWaitMs, _internal: { load, validate, merge, stripNotes } };
