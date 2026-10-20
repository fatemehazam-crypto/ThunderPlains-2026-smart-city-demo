/**
 * routes/general.js — layout, state, config, events and time-window history.
 */
'use strict';

const express = require('express');
const fs = require('fs');

module.exports = function generalRoutes({ db, live, getLayout, LAYOUT_FILE, applyLayout, startDemoMode, DEMO_MODE }) {
  const router = express.Router();
  const dbAll = (sql, p = []) => { try { return db.prepare(sql).all(...p); } catch (e) { console.warn('DB query error:', e.message); return []; } };
  const limitOf = (v, d, max = 1000) => Math.min(max, Math.max(1, parseInt(v, 10) || d));

  // GET /api/layout — buildings, sensors and positions (backend/layout.json)
  router.get('/layout', (req, res) => {
    res.json(getLayout() || { sensors: Object.entries(live.nodes()).map(([id, n]) => ({ id, ...n })), buildings: [], router: { mx: 0, my: 0 } });
  });

  // POST /api/layout — replace the layout, save it to layout.json and apply it live
  router.post('/layout', (req, res) => {
    const layout = req.body;
    if (!layout || !Array.isArray(layout.sensors) || layout.sensors.length === 0)
      return res.status(400).json({ error: 'Invalid layout: expected { sensors: [...] } with at least one sensor' });
    try {
      fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf8');
      applyLayout(layout, true);
      if (DEMO_MODE) startDemoMode();
      res.json({ success: true, nodes: Object.keys(live.nodes()), timestamp: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/state — all node definitions and their live state
  router.get('/state', (req, res) => res.json({ nodes: live.nodeState(), nodeDefinitions: live.nodes() }));

  // GET /api/config — current thresholds and timing settings
  router.get('/config', (req, res) => res.json(live.config()));

  // GET /api/events?limit=50&severity=critical&type=interference — newest last
  router.get('/events', (req, res) => {
    const { severity, type } = req.query;
    const where = [], params = [];
    if (severity) { where.push('severity = ?'); params.push(severity); }
    if (type)     { where.push('type = ?');     params.push(type); }
    let sql = 'SELECT * FROM events';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY rowid DESC LIMIT ?';
    params.push(limitOf(req.query.limit, 50));
    res.json(dbAll(sql, params).reverse());
  });

  // GET /api/history?from=ISO&to=ISO&node=gps-node&metric=snr_l1 — readings in a time window
  router.get('/history', (req, res) => {
    const { node, metric, from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (ISO 8601 timestamps)' });
    let sql = 'SELECT * FROM sensor_readings WHERE timestamp >= ? AND timestamp <= ?';
    const params = [from, to];
    if (node)   { sql += ' AND node_id = ?'; params.push(node); }
    if (metric) { sql += ' AND metric = ?';  params.push(metric); }
    sql += ' ORDER BY timestamp ASC LIMIT ?';
    params.push(limitOf(req.query.limit, 1000, 10000));
    res.json(dbAll(sql, params));
  });

  return router;
};
