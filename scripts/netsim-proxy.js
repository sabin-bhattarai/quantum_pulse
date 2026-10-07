/**
 * Quantum Pulse — network condition simulator.
 *
 * A reverse proxy that sits between browsers (or test bots) and the game
 * server and degrades the WebSocket link: added latency, jitter and packet
 * loss. HTTP requests (the page, scripts, /healthz) are forwarded untouched.
 *
 *   node scripts/netsim-proxy.js --profile poor            # proxy :3001 -> :3000
 *   node scripts/netsim-proxy.js --rtt 120 --jitter 30 --loss 0.02 --port 3001 --target http://localhost:3000
 *
 * Then open http://localhost:3001 to play through the degraded link.
 *
 * DELAY MODEL (per direction, per message):
 *   release = max(previousRelease, now + rtt/2 + jitterSample [+ lossPenalty])
 *   - rtt/2: each direction gets half of the configured round trip.
 *   - jitterSample: |gaussian| * jitter/2, so delays only ever grow.
 *   - lossPenalty: with probability `loss`, the message waits one TCP
 *     retransmission timeout (max(200 ms, rtt)). WebSocket runs over TCP, so a
 *     lost segment is never dropped — it delays that message AND everything
 *     behind it (head-of-line blocking). The `max(previousRelease, …)` keeps
 *     ordering intact, exactly like TCP.
 * ASSUMPTIONS: bandwidth is unlimited; delays are independent per message.
 * LIMITS: rtt 0–2000 ms, jitter 0–1000 ms, loss 0–0.5.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

export const PROFILES = Object.freeze({
  lan: { rtt: 2, jitter: 0, loss: 0 },
  good: { rtt: 40, jitter: 6, loss: 0 },
  average: { rtt: 90, jitter: 20, loss: 0.005 },
  poor: { rtt: 160, jitter: 45, loss: 0.02 },
  terrible: { rtt: 260, jitter: 90, loss: 0.05 },
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Standard normal sample (Box–Muller). */
function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Ordered delay line for one direction of one connection.
 * @param {{rtt:number, jitter:number, loss:number}} cond live conditions (may be changed at runtime)
 */
export function createDelayLine(cond, deliver, rng = Math.random) {
  // One FIFO drained by a single timer. (Scheduling a separate setTimeout per
  // message can reorder messages, because timer delays are truncated to whole
  // milliseconds — and TCP never reorders.)
  const queue = [];
  let lastRelease = 0;
  let timer = null;
  const drain = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].release <= now + 0.5) {
      const m = queue.shift();
      deliver(m.data, m.isBinary);
    }
    if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].release - now));
  };
  return {
    get pending() { return queue.length; },
    push(data, isBinary) {
      const now = performance.now();
      const oneWay = cond.rtt / 2 + Math.abs(gaussian(rng)) * (cond.jitter / 2);
      const penalty = rng() < cond.loss ? Math.max(200, cond.rtt) : 0;
      const release = Math.max(lastRelease, now + oneWay + penalty);
      lastRelease = release;
      queue.push({ data, isBinary, release });
      if (!timer) timer = setTimeout(drain, Math.max(0, queue[0].release - now));
    },
  };
}

/**
 * Start a proxy.
 * @param {{port:number, target:string, rtt:number, jitter:number, loss:number, log?:boolean}} opts
 * @returns {Promise<{server: http.Server, cond: object, close: () => Promise<void>, port: number}>}
 */
export function startProxy(opts) {
  const target = new URL(opts.target);
  const cond = {
    rtt: clamp(opts.rtt ?? 0, 0, 2000),
    jitter: clamp(opts.jitter ?? 0, 0, 1000),
    loss: clamp(opts.loss ?? 0, 0, 0.5),
  };
  const server = http.createServer((req, res) => {
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('upstream unavailable'); });
    req.pipe(up);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${target.host}${req.url}`, { headers: { origin: req.headers.origin || `http://${target.host}` } });
      const toServer = createDelayLine(cond, (d, b) => { if (upstream.readyState === 1) upstream.send(d, { binary: b }); });
      const toClient = createDelayLine(cond, (d, b) => { if (client.readyState === 1) client.send(d, { binary: b }); });
      const early = [];
      upstream.on('open', () => { for (const [d, b] of early) toServer.push(d, b); early.length = 0; });
      client.on('message', (d, b) => (upstream.readyState === 1 ? toServer.push(d, b) : early.push([d, b])));
      upstream.on('message', (d, b) => toClient.push(d, b));
      const closeBoth = (code, reason) => {
        const c = typeof code === 'number' && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
        // Close after in-flight messages have been delivered.
        setTimeout(() => {
          if (client.readyState <= 1) client.close(c, reason);
          if (upstream.readyState <= 1) upstream.close(c, reason);
        }, cond.rtt / 2 + cond.jitter);
      };
      client.on('close', (c, r) => closeBoth(c, r));
      upstream.on('close', (c, r) => closeBoth(c, r));
      client.on('error', () => {});
      upstream.on('error', () => client.close(1011, 'upstream error'));
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, () => {
      const port = server.address().port;
      if (opts.log) console.log(`netsim proxy :${port} -> ${opts.target}  rtt ${cond.rtt} ms, jitter ${cond.jitter} ms, loss ${(cond.loss * 100).toFixed(1)}%`);
      resolve({
        server, cond, port,
        close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const base = args.profile ? PROFILES[args.profile] : {};
  if (args.profile && !base) {
    console.error(`Unknown profile "${args.profile}". Available: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }
  startProxy({
    port: Number(args.port || 3001),
    target: args.target || 'http://localhost:3000',
    rtt: Number(args.rtt ?? base.rtt ?? 100),
    jitter: Number(args.jitter ?? base.jitter ?? 20),
    loss: Number(args.loss ?? base.loss ?? 0),
    log: true,
  });
}
