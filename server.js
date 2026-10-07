/**
 * Quantum Pulse — HTTP + WebSocket entry point.
 *
 *   node server.js            (PORT=3000 by default)
 *
 * Serves the browser client and hosts authoritative online matches.
 * See README.md for environment variables.
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameServer } from './src/server/GameServer.js';
import { MATCH } from './src/shared/constants.js';
import { ARENA_IDS } from './src/shared/arenas.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.warn(`[config] ignoring invalid ${name}=${raw} (expected ${min}..${max})`);
    return fallback;
  }
  return v;
}

const config = {
  port: intEnv('PORT', 3000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  maxRooms: intEnv('MAX_ROOMS', MATCH.MAX_ROOMS, 1, 1000),
  maxConnections: intEnv('MAX_CONNECTIONS', 256, 1, 10000),
  ffaMaxPlayers: intEnv('FFA_MAX_PLAYERS', MATCH.FFA_MAX_PLAYERS, 2, 12),
  ffaDuration: intEnv('MATCH_DURATION', MATCH.FFA_DURATION_S, 60, 3600),
  ffaArenas: (process.env.FFA_ARENAS || ARENA_IDS.join(',')).split(',').map((s) => s.trim()).filter((s) => ARENA_IDS.includes(s)),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: process.env.TRUST_PROXY === '1',
};
if (!config.ffaArenas.length) config.ffaArenas = [...ARENA_IDS];

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, msg, extra) {
  if ((LEVELS[level] ?? 20) < (LEVELS[config.logLevel] ?? 20)) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// Security headers. The client uses no inline scripts and no eval.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss: https://vitals.vercel-insights.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const staticOpts = { index: false, fallthrough: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 };

// Browser client
app.use('/', express.static(path.join(ROOT, 'public'), { ...staticOpts, index: 'index.html' }));
// Shared modules (constants, math, movement, protocol, validation, arenas, weapons)
app.use('/shared', express.static(path.join(ROOT, 'src/shared'), staticOpts));
// Client modules
app.use('/client', express.static(path.join(ROOT, 'src/client'), staticOpts));
// Isomorphic simulation modules, used by the browser ONLY for offline Solo and
// Training. The WebSocket host (GameServer.js) is never exposed.
const SIM_ALLOW = new Set(['World.js', 'Player.js', 'Enemy.js', 'Weapons.js', 'Abilities.js', 'SpatialHash.js', 'Match.js', 'Room.js']);
app.use('/sim', (req, res, next) => {
  const name = path.posix.basename(req.path);
  if (!SIM_ALLOW.has(name) || req.path !== `/${name}`) { res.status(404).end(); return; }
  next();
}, express.static(path.join(ROOT, 'src/server'), staticOpts));
// Three.js (installed via npm; only the build directory is exposed)
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three/build'), staticOpts));
// Self-hosted open-licence fonts (OFL-1.1): CSS + woff2 files only
const FONT_FILES = /^\/(?:[\w.-]+\.css|files\/[\w.-]+\.woff2?)$/;
const fontRoute = (dir) => [(req, res, next) => (FONT_FILES.test(req.path) ? next() : res.status(404).end()), express.static(path.join(ROOT, 'node_modules', dir), staticOpts)];
app.use('/vendor/fonts/anton', ...fontRoute('@fontsource/anton'));
app.use('/vendor/fonts/archivo', ...fontRoute('@fontsource-variable/archivo'));

let gameServer = null;
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ...(gameServer ? gameServer.stats() : {}) });
});

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

const server = http.createServer(app);
gameServer = new GameServer({ server, config, log });
gameServer.start();

server.listen(config.port, config.host, () => {
  log('info', `Quantum Pulse listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

function shutdown(signal) {
  log('info', `received ${signal}, shutting down`);
  gameServer.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
