/**
 * routes/nodes.js — /api/nodes/*
 * Current state, stored history and RF health per sensor node.
 */
'use strict';

const express = require('express');

module.exports = function nodeRoutes({ db, live }) {
  const router = express.Router();
  const dbAll = (sql, p = []) => { try { return db.prepare(sql).all(...p); } catch (e) { console.warn('DB query error:', e.message); return []; } };

  // GET /api/nodes — every node: its definition plus live state
  router.get('/', (req, res) => {
    const state = live.nodeState();
    res.json(Object.entries(live.nodes()).map(([id, def]) => ({ id, ...def, ...state[id] })));
  });

  // GET /api/nodes/:id/history?metric=wifi_rssi&limit=200 — stored readings, oldest first
  router.get('/:id/history', (req, res) => {
    const { metric } = req.query;
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 100));
    let sql = 'SELECT metric, value, unit, timestamp FROM sensor_readings WHERE node_id = ?';
    const params = [req.params.id];
    if (metric) { sql += ' AND metric = ?'; params.push(metric); }
    sql += ' ORDER BY rowid DESC LIMIT ?';
    params.push(limit);
    res.json(dbAll(sql, params).reverse());
  });

  // GET /api/nodes/:id/rf-health — the backend's live RF picture for one node
  router.get('/:id/rf-health', (req, res) => {
    const h = live.rfHealth()[req.params.id];
    if (!h) return res.status(404).json({ error: 'Node not found' });
    res.json(h);
  });

  return router;
};
