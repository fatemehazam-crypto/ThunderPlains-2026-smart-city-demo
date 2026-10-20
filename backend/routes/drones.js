/**
 * routes/drones.js
 * All /api/drones/* endpoints
 * Requires: droneState, droneMissions, missionTracker, io injected via factory
 */
'use strict';

const express = require('express');

module.exports = function droneRoutes({ droneState, droneMissions, missionTracker, io }) {
  const router = express.Router();

  // GET /api/drones — live state + registered mission per drone
  router.get('/', (req, res) => {
    res.json(Object.fromEntries(
      Object.entries(droneState).map(([id, d]) => [id, { ...d, mission: droneMissions[id] || null }])
    ));
  });

  // POST /api/drones/:id/mission — register mission before flight
  router.post('/:id/mission', (req, res) => {
    const droneId = req.params.id;
    const { mission_profile, roles, condition, trial_id, waypoints, start } = req.body;
    droneMissions[droneId] = {
      mission_profile: mission_profile || 'unknown',
      condition:       condition       || 'unknown',
      trial_id:        trial_id        || null,
      registered_at:   new Date().toISOString(),
      roles: roles || (start && waypoints ? [{ start, waypoints }] : null),
    };
    missionTracker.register(droneId, droneMissions[droneId]);
    // Clear stale off-path state from previous flight
    if (droneState[droneId]) droneState[droneId]._lastOffPathTime = null;
    console.log(`📋 Mission registered for ${droneId}: ${mission_profile} (${condition})`);
    io.emit('drone:mission', { droneId, mission: droneMissions[droneId] });
    res.json({ success: true, droneId, mission: droneMissions[droneId] });
  });

  // GET /api/drones/:id/mission — get registered mission
  router.get('/:id/mission', (req, res) => {
    const mission = droneMissions[req.params.id];
    if (!mission) return res.status(404).json({ error: 'No mission registered for this drone' });
    res.json(mission);
  });

  // GET /api/drones/:id/progress — current waypoint progress
  router.get('/:id/progress', (req, res) => {
    const progress = missionTracker.getProgress(req.params.id);
    if (!progress) return res.status(404).json({ error: 'No mission registered for this drone' });
    res.json(progress);
  });

  return router;
};
