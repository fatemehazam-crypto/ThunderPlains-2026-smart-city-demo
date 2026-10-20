/**
 * mission-tracker.js
 *
 * Standalone module for drone mission tracking and path deviation detection.
 * Imported by server.js — no Express or Socket.io dependencies. Distances and times come from
 * config/alerting.json (drones section).
 *
 * Flight model:
 *   1. Drone flies north/south along a street — x stays near start.x
 *   2. At each waypoint y, drone moves horizontally to waypoint.x for delivery
 *   3. Drone descends to waypoint.z, pauses, ascends, returns to street x
 *   4. Continues to next waypoint, then returns to start
 *
 * Deviation = drone x is not near street x AND not near any waypoint x AND not mid-transit
 */

'use strict';

// ─── Thresholds: config/alerting.json → drones ────────────────────────────────
const { policy } = require('./config/alerting');
const WAYPOINT_REACH_RADIUS = policy.drones.waypointReachedWithinM;    // meters — waypoint considered reached
const OFF_PATH_THRESHOLD    = policy.drones.offRouteBeyondM;           // meters — max deviation before alert
const MIN_AIRBORNE_Z        = policy.drones.airborneAboveM;            // meters — below this z = on ground
const ALERT_COOLDOWN_MS     = policy.drones.offRouteMessageCooldownMs; // ms — min time between repeated off-path messages

// ─── Geometry helpers ─────────────────────────────────────────────────────────
function dist2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
}

// ─── MissionTracker ───────────────────────────────────────────────────────────
class MissionTracker {
  constructor() {
    this._missions      = {};   // registered mission per drone id
    this._waypointIdx   = {};   // current waypoint index per drone id
    this._lastAlert     = {};   // last off-path alert timestamp per drone id
    this._visitedCount  = {};   // count of waypoints reached per drone id
  }

  // ── Register a mission before flight ────────────────────────────────────────
  // mission: { mission_profile, condition, trial_id, roles: [{start, waypoints}] }
  register(droneId, mission) {
    this._missions[droneId]     = mission;
    this._waypointIdx[droneId]  = 0;
    this._lastAlert[droneId]    = 0;
    this._visitedCount[droneId] = 0;
  }

  // ── Reset after landing — ready for next flight ──────────────────────────────
  reset(droneId) {
    this._waypointIdx[droneId]  = 0;
    this._lastAlert[droneId]    = 0;
    this._visitedCount[droneId] = 0;
  }

  // ── Check if a mission is registered ────────────────────────────────────────
  hasMission(droneId) {
    return !!this._missions[droneId]?.roles?.length;
  }

  // ── Get current progress ────────────────────────────────────────────────────
  getProgress(droneId) {
    if (!this.hasMission(droneId)) return null;
    const allWaypoints = this._getAllWaypoints(droneId);
    const current      = this._waypointIdx[droneId] || 0;
    return {
      currentWaypointIdx: current,
      totalWaypoints:     allWaypoints.length,
      visited:            current,
      remaining:          allWaypoints.length - current,
      complete:           current >= allWaypoints.length,
    };
  }

  // ── Check if mission is complete ────────────────────────────────────────────
  isComplete(droneId) {
    if (!this.hasMission(droneId)) return false;
    const total = this._getAllWaypoints(droneId).length;
    return (this._waypointIdx[droneId] || 0) >= total;
  }

  // ── Check if position is near home/start ────────────────────────────────────
  isNearHome(droneId, pos) {
    if (!this.hasMission(droneId)) return false;
    for (const role of this._missions[droneId].roles) {
      if (!role.start) continue;
      const [sx, sy] = role.start;
      if (dist2D(pos, { x: sx, y: sy }) <= WAYPOINT_REACH_RADIUS) return true;
    }
    return false;
  }

  // ── Main update — call on every telemetry packet ─────────────────────────────
  // Returns { waypointReached, missionComplete, offPath, deviation, alertMessage }
  update(droneId, pos) {
    const result = {
      waypointReached: false,
      missionComplete: false,
      offPath:         false,
      deviation:       null,   // meters from expected corridor, if offPath
      alertMessage:    null,
    };

    if (!this.hasMission(droneId)) return result;

    // Skip checks when on ground
    if ((pos.z || 0) < MIN_AIRBORNE_Z) return result;

    // ── Waypoint progress ──────────────────────────────────────────────────────
    const allWaypoints = this._getAllWaypoints(droneId);
    const currentIdx   = this._waypointIdx[droneId] || 0;

    if (currentIdx < allWaypoints.length) {
      const target = allWaypoints[currentIdx];
      // Check x,y proximity — delivery height (z) handled by drone, we track x,y
      if (dist2D(pos, { x: target.x, y: target.y }) <= WAYPOINT_REACH_RADIUS) {
        this._waypointIdx[droneId] = currentIdx + 1;
        this._visitedCount[droneId] = currentIdx + 1;
        result.waypointReached = true;
        if (this._waypointIdx[droneId] >= allWaypoints.length) {
          result.missionComplete = true;
        }
      }
    }

    // ── Off-path detection ─────────────────────────────────────────────────────
    // Don't check when mission is complete — drone is returning home
    if (!this.isComplete(droneId)) {
      const offPath = this._checkOffPath(droneId, pos);
      if (offPath.isOff) {
        result.offPath  = true;
        result.deviation = offPath.deviation;

        // Respect cooldown — don't flood with repeated alerts
        const now = Date.now();
        if (now - (this._lastAlert[droneId] || 0) > ALERT_COOLDOWN_MS) {
          this._lastAlert[droneId] = now;
          const role    = this._missions[droneId].roles[0];
          const streetX = role?.start?.[0]?.toFixed(2) ?? '?';
          result.alertMessage = `${droneId} deviated from expected flight path — at x:${pos.x.toFixed(2)} expected near x:${streetX}`;
        }
      }
    }

    return result;
  }

  // ── Internal: get flat waypoint list ────────────────────────────────────────
  _getAllWaypoints(droneId) {
    return (this._missions[droneId]?.roles || []).flatMap(r =>
      (r.waypoints || []).map(wp => ({ x: wp[0], y: wp[1], z: wp[2] || 1 }))
    );
  }

  // ── Internal: path deviation check ──────────────────────────────────────────
  // Checks drone x against: street corridor, delivery excursion, mid-transit
  _checkOffPath(droneId, pos) {
    const role = this._missions[droneId]?.roles?.[0];
    if (!role?.start || !role?.waypoints?.length) return { isOff: false };

    const streetX = role.start[0];

    // Check 1 — on street corridor?
    const distFromStreet = Math.abs(pos.x - streetX);
    if (distFromStreet <= OFF_PATH_THRESHOLD) return { isOff: false };

    // Check 2 — near any waypoint x (delivery excursion)?
    for (const wp of role.waypoints) {
      const distFromWpX = Math.abs(pos.x - wp[0]);
      if (distFromWpX <= OFF_PATH_THRESHOLD) return { isOff: false };
    }

    // Check 3 — mid-transit between street x and a waypoint x?
    for (const wp of role.waypoints) {
      const wpX  = wp[0];
      const minX = Math.min(streetX, wpX) - OFF_PATH_THRESHOLD;
      const maxX = Math.max(streetX, wpX) + OFF_PATH_THRESHOLD;
      if (pos.x >= minX && pos.x <= maxX) return { isOff: false };
    }

    // Genuine deviation — compute how far from nearest valid corridor
    const deviations = [
      distFromStreet,
      ...role.waypoints.map(wp => Math.abs(pos.x - wp[0])),
    ];
    const deviation = Math.min(...deviations) - OFF_PATH_THRESHOLD;

    return { isOff: true, deviation: +deviation.toFixed(3) };
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
const missionTracker = new MissionTracker();

module.exports = {
  missionTracker,
  MissionTracker,   // exported for unit testing
  WAYPOINT_REACH_RADIUS,
  OFF_PATH_THRESHOLD,
  MIN_AIRBORNE_Z,
};
