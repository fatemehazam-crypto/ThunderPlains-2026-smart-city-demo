// Built-in MQTT broker, so you don't have to install Mosquitto to try the demos.
// Plain MQTT over TCP on port 1883 (the same port Mosquitto uses), reachable from
// ESP32s on your network. Nothing is saved to disk: it's a message bus, not a database.
//
//   node broker.mjs              listen on 1883
//   MQTT_PORT=1884 node broker.mjs
//
// Already running Mosquitto? Set "broker": "external" in stage/stage.config.json.

import net from 'node:net';
import { Aedes } from 'aedes';

const PORT = Number(process.env.MQTT_PORT) || 1883;
const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);

let clients = 0;
aedes.on('client', (c) => { clients++; console.log(`client connected: ${c.id} (${clients} total)`); });
aedes.on('clientDisconnect', (c) => { clients--; console.log(`client left: ${c.id} (${clients} total)`); });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Another MQTT broker (Mosquitto?) is probably running: stop it, or set "broker": "external" in stage/stage.config.json to use it.`);
  else console.error(`broker error: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, () => console.log(`MQTT broker listening on port ${PORT}`));

const stop = () => { server.close(); aedes.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
