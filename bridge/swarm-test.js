'use strict';

/*
 * Rehearsal swarm: fake phones (and optionally fake attackers) against the relay.
 *
 *   node swarm-test.js --n 200                    200 honest phones
 *   node swarm-test.js --n 200 --attack           plus 5 sockets sending garbage
 *   node swarm-test.js --n 200 --leave-after 40   everyone "closes the tab" at 40s
 *
 * RELAY_URL defaults to http://localhost:8080.
 */

const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8080';
const N = Number(opt('n', 50));
const ATTACK = Boolean(opt('attack', false));
const LEAVE_AFTER = Number(opt('leave-after', 0));

const phones = [];
let live = 0;

for (let i = 0; i < N; i++) {
  setTimeout(() => {
    const s = io(RELAY_URL, { transports: ['websocket'], reconnection: false });
    let timer = null;
    s.on('status', (m) => {
      if (m.state === 'live') {
        live += 1;
        timer = setInterval(() => {
          s.emit('telemetry', {
            shake: Math.round(Math.random() ** 3 * 100) / 100,
            taps: Math.random() < 0.2 ? Math.ceil(Math.random() * 5) : 0,
            ts: Date.now(),
          });
        }, 1000);
      }
    });
    s.on('disconnect', () => clearInterval(timer));
    phones.push(s);
  }, i * 20); // stagger joins like a real room scanning a QR code
}

if (ATTACK) {
  const nasty = [
    ['telemetry', { shake: 5, taps: 0, ts: Date.now() }],                       // out of range
    ['telemetry', { shake: 0.5, taps: 1, ts: Date.now(), severity: 'critical' }], // extra field
    ['telemetry', { shake: 0.5, taps: 1, ts: 0 }],                              // ancient clock
    ['telemetry', 'jam everything'],                                            // wrong type
    ['admin', { action: 'end' }],                                               // unknown event
    ['telemetry', { shake: NaN, taps: 1, ts: Date.now() }],
  ];
  for (let a = 0; a < 5; a++) {
    const s = io(RELAY_URL, { transports: ['websocket'], reconnection: false });
    s.on('status', (m) => {
      if (m.state === 'kicked') console.log(`attacker ${a} kicked by the edge`);
    });
    s.on('connect', () => {
      let k = 0;
      const t = setInterval(() => {
        const [ev, payload] = nasty[k++ % nasty.length];
        s.emit(ev, payload);
        // and a flood burst to trip the rate limiter
        for (let f = 0; f < 5; f++) s.emit('telemetry', { shake: 0.1, taps: 0, ts: Date.now() });
      }, 200);
      s.on('disconnect', () => clearInterval(t));
    });
  }
}

const report = setInterval(() => console.log(`phones live: ${live}/${N}`), 3000);

if (LEAVE_AFTER > 0) {
  setTimeout(() => {
    console.log('everyone closes the tab...');
    phones.forEach((s) => s.disconnect());
    clearInterval(report);
    setTimeout(() => process.exit(0), 500);
  }, LEAVE_AFTER * 1000);
}
