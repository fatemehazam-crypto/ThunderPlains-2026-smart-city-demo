# GPS node (ESP32-S3 + u-blox NEO-F10N, GPS L1/L5)

A real sensor for the bus. It publishes satellite count, L1 and L5 signal strength (C/N0), lock status, position and its Wi-Fi RSSI once per second. Its node ID is `gps-node`, the same as the simulated GPS in `backend/layout.json`, so when it starts publishing, demo mode stops faking that sensor and the dashboard shows your real one.

## Hardware

- ESP32-S3 dev board (tested on an ESP32-S3-WROOM-1 N16R8 DevKitC clone)
- SparkFun GNSS L1/L5 Breakout, NEO-F10N, plus an L1/L5 antenna

| NEO-F10N | ESP32-S3 |
|---|---|
| TXO | GPIO 18 |
| RXI | GPIO 17 |
| 3V3 | 3.3V |
| GND | GND |

## Arduino IDE setup

1. **Boards Manager:** install **esp32** by Espressif Systems.
2. **Library Manager:** install **SparkFun u-blox GNSS v3** (the name must end in v3) and **PubSubClient** by Nick O'Leary.
3. **Tools menu:**
   - Board: **ESP32S3 Dev Module**
   - Flash Size: match your board (16MB for N16R8)
   - PSRAM: **OPI PSRAM** for R8 boards
   - USB CDC On Boot: **Enabled** if you plug into the port labeled USB, **Disabled** for the port labeled COM/UART
4. Near the top of `gps_node.ino`, fill in:
   - your Wi-Fi name and password (2.4 GHz network)
   - `MQTT_SERVER`: your laptop's IP, which `npm start` prints on the `ESP32 / MQTT` line
5. Upload, then open the Serial Monitor at 115200 baud. You should see `Push mode: position ok, signals ok, 1 fixes per second`, then one line per second.

If the upload hangs on "Connecting...", hold BOOT while it starts. If it seems stuck after "Hard resetting via RTS pin", the upload is done: press RESET.

## What it sends

One message per metric, all sharing the reading's `collected_ms`:

```
smartcity/gps-node/snr_l1   {"value":28.4,"unit":"dB-Hz","collected_ms":64791}
smartcity/gps-node/lock_status   {"value":"locked","unit":"","collected_ms":64791}
```

It also keeps `status/gps-node` set to `online`, with an MQTT Last Will of `offline` the broker publishes if the node dies.

## Design notes

- **The module pushes each fix; the loop never waits for it.** Polling the module (ask, then wait for the answer) blocked Wi-Fi and MQTT for up to a second per question. Push mode keeps the loop free.
- **Change the rate in one place:** `NAV_RATE_HZ`. The dashboard learns each device's rhythm, so any steady rate works.
- **Reconnects happen in the background**, so a Wi-Fi or broker hiccup doesn't freeze or reboot the node.
- Don't commit your real Wi-Fi password: keep a local copy, or move the two lines into a `secrets.h` (already git-ignored).
