'use strict';
/*
 * A pretend ESP32 that publishes like a real sensor. Use it to:
 *   - see how a device joins the bus (its tile appears on the dashboard by itself)
 *   - try the watchdog demo without hardware: press Ctrl+C and watch it go offline
 *
 *   npm run sensor                          a new node called "my-sensor"
 *   npm run sensor -- --id building-b       take over a sensor from the layout (demo mode stops faking it)
 *   npm run sensor -- --mqtt mqtt://192.168.1.50:1883 --every 2000
 *
 * Each reading goes out as one message per metric, like the ESP32 firmware:
 *   topic    smartcity/<id>/<metric>
 *   payload  {"value": 22.4, "unit": "°C", "collected_ms": 123456}
 * collected_ms is the device's own clock (millis() on an ESP32), and every metric of one
 * reading shares it, so the backend counts them as ONE reading.
 */
const mqtt = require('mqtt');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const ID = arg('id', 'my-sensor');
const URL = arg('mqtt', process.env.MQTT_BROKER || 'mqtt://localhost:1883');
const EVERY = Number(arg('every', 1000));
const t0 = Date.now();

const client = mqtt.connect(URL, { clientId: `fake-${ID}-${process.pid}`, reconnectPeriod: 2000 });
client.on('connect', () => console.log(`${ID}: connected to ${URL}, publishing every ${EVERY} ms. Ctrl+C to "unplug" it.`));
client.on('error', (e) => console.log(`${ID}: ${e.message}`));

let temp = 22, hum = 48, rssi = -58;
setInterval(() => {
  if (!client.connected) return;
  const collected_ms = Date.now() - t0;           // like millis() on the device
  temp = +(temp + (Math.random() - 0.5) * 0.3).toFixed(1);
  hum = +(hum + (Math.random() - 0.5) * 0.8).toFixed(1);
  rssi = Math.max(-75, Math.min(-45, Math.round(rssi + (Math.random() - 0.5) * 3)));
  const send = (metric, value, unit) =>
    client.publish(`smartcity/${ID}/${metric}`, JSON.stringify({ value, unit, collected_ms }));
  send('temperature', temp, '°C');
  send('humidity', hum, '%');
  send('wifi_rssi', rssi, 'dBm');
  process.stdout.write(`\r${ID}: ${temp} °C  ${hum} %  ${rssi} dBm   `);
}, EVERY);

process.on('SIGINT', () => { console.log(`\n${ID}: unplugged. Watch its tile go offline.`); client.end(true, () => process.exit(0)); });
