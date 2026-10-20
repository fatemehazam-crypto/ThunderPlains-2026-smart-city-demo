# Alerting policy

The backend decides **what** is wrong (thresholds) and **when** that becomes an alert: how long to wait, how far a value must recover before the alert clears, and which alerts belong to one incident. All of these numbers live in one file, [`backend/config/alerting.json`](../backend/config/alerting.json). The code holds the mechanism; the file holds the policy.

- Change the policy without touching code, and review policy changes on their own in git.
- The backend checks the file when it starts. A typo in a key, a negative time or a word where a number belongs stops it with a message naming the key, instead of running with a policy nobody meant.
- See what is in effect while it runs: `http://localhost:3001/api/alerting-policy`.

Restart the backend after editing (`Ctrl+C`, then `npm start`).

## Changing it for one site or one test

Keep `alerting.json` as the shared defaults, and put only your changes in an override file. It is merged over the defaults:

```json
{ "defaults": { "alertAfterMs": 3000 }, "grouping": { "waitMs": { "live": 15000 } } }
```

The backend uses, in this order:

1. `backend/config/alerting.json`, the defaults (in git)
2. an override file: the path in the `ALERTING_CONFIG` environment variable, or `backend/config/alerting.local.json` if it exists (ignored by git)
3. the older environment variables `AUDIENCE_WATCHDOG_MS` and `AUDIENCE_AUTO_PURGE_MS`, which still win

The Settings tab changes **thresholds** while the backend runs; its **Reset defaults** button goes back to the values in this file. Settings changes are not saved: a restart starts from the file again.

## What each section means

Times are in milliseconds (keys end in `Ms`), distances in metres (`M`), voltages in volts (`V`). Keys starting with `_` are notes and are ignored.

### `thresholds`: what counts as bad

The starting values for the Settings tab. A sensor's own `thresholds` in `layout.json` win over these for that sensor.

| Key | Default | Meaning |
|---|---|---|
| `watchdogTimeout` | 15 | Seconds of silence before a sensor is offline |
| `rssiThreshold` | −85 | Wi-Fi signal (dBm) below which the Wi-Fi alert fires |
| `signal433Threshold` | −80 | Same for 433 MHz |
| `snrL1Threshold`, `snrL5Threshold` | 25 | GPS signal quality (dB-Hz) |
| `heartRateMin`, `heartRateMax`, `spo2Min` | 40, 120, 94 | Vitals range |
| `rssiJumpThreshold`, `tempJumpThreshold`, `satDropThreshold` | 15, 5, 4 | Sudden changes reported as one-off events |
| `packetLossWindow`, `gapThresholdMs`, … | | Radio-health bookkeeping |

### `defaults` and `rules`: when an alert fires and clears

Every alert uses `defaults` unless its entry in `rules` says otherwise.

| Option | Default | Meaning |
|---|---|---|
| `alertAfterMs` | 2000 | How long a problem must last before it is an alert. Measured in time, not in readings, so a sensor that reports ten times a second doesn't alert sooner than one that reports once a second. `0` = the first bad reading. |
| `clearAfterMs` | 5000 | How long it must stay fixed before the alert clears, so a wobbling value doesn't fire and clear over and over |
| `clearMargin` | 0 | How far past the threshold a value must recover before it counts as fixed, in the metric's own unit. Wi-Fi fires below −85 dBm and, with a margin of 3, only counts as recovered above −82. |
| `remindEveryMs` | 300000 | A still-active alert is repeated in the event log this often |
| `oneOffEventCooldownMs` | 30000 | Minimum time between repeats of a one-off event (a sudden Wi-Fi drop) on the same device |

Current rules:

| Alert | Setting | Why |
|---|---|---|
| `gps_lock` | `alertAfterMs: 0` | Safety: losing position is reported on the first reading |
| `hr_range`, `spo2_low` | `alertAfterMs: 1000` | Vitals wait one second, just long enough for the sensor's "no finger" status to arrive |
| `hr_missing` | `alertAfterMs: 3000` | A missing heart-rate reading is reported after 3 s |
| `readings_lost` | `alertAfterMs: 0` | The gap itself already lasted long enough |
| `rf_degraded` | `alertAfterMs` and `clearAfterMs: 10000` | A summary of radio health; slow on purpose |
| `off_route` | `alertAfterMs: 0`, `clearAfterMs: 2000` | A drone leaving its route is reported at once |
| `battery` | `alertAfterMs: 3000`, `alertBelowV: 3.7`, `clearAboveV: 3.75`, `warningBelowV: 3.5`, `criticalBelowV: 3.2` | Ignores brief voltage sag under thrust; one alert per flight that escalates |
| `wifi_low`, `433_low`, `gps_l1_low`, `gps_l5_low`, `temp_range`, `fps_low` | `clearMargin` | Recovery margins in each metric's unit |

### `grouping`: one cause, one incident

| Key | Default | Meaning |
|---|---|---|
| `waitMs.demo` / `waitMs.live` | 3000 / 10000 | How long to hold new alerts so related ones can arrive. Real sensors report every 2–5 s, so live mode waits longer. |
| `causes`, `symptoms` | | Signal problems, and what they cause. Two or more on the same radio band, with at least one cause, become one incident. |
| `bands` | | Radio bands and their display names |
| `siteLevelDevices` | 3 | An incident touching this many devices is critical |
| `aftermathMs` | 60000 | After an incident ends, its leftovers join it quietly for this long instead of raising new alerts |

### `silence`: when a device goes quiet

| Key | Default | Meaning |
|---|---|---|
| `staleAlertCloseMs` | 600000 | An offline sensor's open alerts are marked "no data", not cleared. They close after this long if it never comes back. |
| `startupGraceMs` | 60000 | Sensors in the layout that haven't reported this long after startup get a "Not reporting" alert |

### `rf`: radio health

| Key | Default | Meaning |
|---|---|---|
| `learnFromReadings` | 5 | Readings used to learn a device's own rhythm before judging it |
| `gapAfterIntervals` | 2.5 | A gap is a silence longer than this many of the device's usual intervals |
| `burstUnderInterval` | 0.2 | A burst is readings arriving closer together than this fraction of the usual interval |
| `recentReadings`, `recentWindowMs` | 20, 60000 | What counts as "recent" for gaps and bursts |
| `signalSpreadAlertDb`, `packetLossAlertPct` | 5, 10 | When radio health counts as degraded |

### `drones`: silence judged against the mission

| Key | Default | Meaning |
|---|---|---|
| `telemetryTimeoutMs` | 4000 | Silence before the landing check runs |
| `landedBelowM` | 0.25 | Below this height the drone counts as on the ground |
| `offRouteMemoryMs` | 180000 | A landing this soon after leaving the route is "landed off expected path" |
| `waypointReachedWithinM`, `offRouteBeyondM` | 0.3, 0.3 | Mission tracking distances |
| `airborneAboveM` | 0.15 | Route checks only run above this height |
| `offRouteMessageCooldownMs` | 10000 | Minimum time between repeated off-route messages |

### `audience`: phones in the audience demo

| Key | Default | Meaning |
|---|---|---|
| `watchdogMs` | 5000 | A phone that is silent this long goes offline |
| `stormWindowMs`, `stormMinPhones` | 3000, 10 | This many phones going silent within the window is one event, not one per phone |
| `endGuardMs` | 3000 | After the session ends, messages still in flight are ignored this long |
| `autoPurgeMs` | 0 | Remove offline phones automatically after this long (0 = only "Disconnect all phones" removes them) |
