/**
 * Quantum Pulse — netcode benchmark.
 *
 *   node scripts/netsim-bench.js                 # all profiles, 20 s each
 *   node scripts/netsim-bench.js --profiles good,poor --seconds 30 --json
 *
 * For every network profile (see netsim-proxy.js) it starts the real game
 * server in-process, routes two headless clients through the degrading proxy
 * and measures:
 *   - strafing target: prediction corrections (count and size),
 *   - shooter: how often interpolation had to extrapolate, snapshot gaps,
 *   - server: input starvation, catch-up ticks, timeouts, dropped inputs,
 *   - hit registration: server-confirmed accuracy of a shooter aiming exactly
 *     at what it sees (the interpolated target), i.e. lag compensation quality.
 *
 * The harness reaches into the in-process server only to stage the scenario
 * (positions, endless health); all gameplay still flows through the network.
 */
import http from 'node:http';
import { GameServer } from '../src/server/GameServer.js';
import { BTN, MATCH } from '../src/shared/constants.js';
import { raycastArena } from '../src/shared/movement.js';
import { startProxy, PROFILES } from './netsim-proxy.js';
import { NetBot } from './lib/netbot.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean));
const SECONDS = Number(args.seconds || 20);
const PROFILE_NAMES = (args.profiles || Object.keys(PROFILES).join(',')).split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? (100 * a) / b : 0);
const percentile = (arr, p) => (arr.length ? [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

// Clear lane on Reactor Null: shooter on the east side, target strafing to the south-east.
const SHOOTER = { x: 36, z: -4 };
const TARGET = { x: 36, z: -20, minX: 31, maxX: 40 };

async function startGameServer() {
  const server = http.createServer();
  const config = { maxRooms: 16, maxConnections: 64, ffaMaxPlayers: 12, ffaDuration: MATCH.FFA_DURATION_S, ffaArenas: ['reactor_null'], allowedOrigins: [] };
  const gs = new GameServer({ server, config, log: () => {} });
  gs.start();
  await new Promise((r) => server.listen(0, r));
  return { gs, server, port: server.address().port };
}

function stage(room, shooterId, targetId) {
  const w = room.world;
  if (w.rules.phase !== 'active') w.rules.beginMatch();
  w.rules.timer = 1e6;
  const place = (p, x, z, yaw) => {
    Object.assign(p.move, { x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw });
    p.protectedTimer = 0;
    p.historyTicks.fill(-1);
  };
  place(w.players.get(shooterId), SHOOTER.x, SHOOTER.z, 0);
  place(w.players.get(targetId), TARGET.x, TARGET.z, 0);
}

async function runProfile(name, gamePort) {
  const prof = PROFILES[name];
  const proxy = await startProxy({ port: 0, target: `http://localhost:${gamePort}`, ...prof });
  const room = `NB${Math.floor(Math.random() * 1e5)}`;
  const url = `ws://localhost:${proxy.port}/ws`;
  const shooter = new NetBot({ url, name: 'Shooter', mode: 'ffa', room, arena: 'reactor_null' });
  const target = new NetBot({ url, name: 'Target', mode: 'ffa', room, arena: 'reactor_null' });
  await shooter.connect();
  await target.connect();
  const srv = [...gameServer.gs.rooms.values()].find((r) => r.code === room);
  const sp = srv.world.players.get(shooter.welcome.id);
  const tp = srv.world.players.get(target.welcome.id);
  stage(srv, sp.id, tp.id);

  // Sanity: the lane must have line of sight.
  const los = raycastArena(srv.world.env, SHOOTER.x, 1.6, SHOOTER.z, 0, 0, -1, Math.abs(TARGET.z - SHOOTER.z), false, false);
  if (los.t >= 0) throw new Error('benchmark lane is blocked');

  // Target: strafe left/right with random reversals and occasional jumps.
  let dir = 1, flip = 0.5, jumpIn = 1.5;
  const rng = Math.random;
  target.start((bot) => {
    const m = bot.prediction.state;
    flip -= 1 / 60;
    jumpIn -= 1 / 60;
    if (flip <= 0 || m.x > TARGET.maxX) { dir = m.x > TARGET.maxX ? -1 : m.x < TARGET.minX ? 1 : -dir; flip = 0.35 + rng() * 0.6; }
    if (m.x < TARGET.minX) dir = 1;
    let buttons = 0;
    if (jumpIn <= 0) { buttons |= BTN.JUMP_P; jumpIn = 1.2 + rng() * 2; }
    return { mx: dir, mz: 0, yaw: 0, pitch: 0, buttons, weapon: 0 };
  });
  // Shooter: aim exactly at the interpolated target it can see, hold fire.
  shooter.start((bot) => {
    const m = bot.prediction.state;
    const o = bot.remote.get(target.welcome.id);
    if (!o) return { buttons: 0 };
    const dx = o.x - m.x, dy = o.y + 1.0 - (m.y + 1.62), dz = o.z - m.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), buttons: BTN.FIRE, weapon: 0 };
  });
  const keepAlive = setInterval(() => {
    for (const p of [sp, tp]) { p.health = p.maxHealth; p.shield = p.maxShield; p.protectedTimer = 0; }
  }, 50);

  await wait(2500); // settle: snapshots buffered, clocks synced, teleport corrections done
  const reset = () => {
    for (const b of [shooter, target]) Object.assign(b.stats, { delaySum: 0, ticks: 0, snapshots: 0, extrapolatedFrames: 0, frames: 0, corrections: 0, correctionSum: 0, correctionMax: 0, arrivalGaps: [] });
    for (const p of [sp, tp]) Object.assign(p.net, { ticks: 0, starved: 0, catchup: 0, timeouts: 0, dropped: 0, skipped: 0, queueSum: 0 });
    sp.stats.shots = 0; sp.stats.hits = 0;
  };
  reset();
  await wait(SECONDS * 1000);

  const tnet = tp.net, snet = sp.net;
  const res = {
    profile: name,
    rtt: Math.round(shooter.rtt),
    snapGapP95: Math.round(percentile(shooter.stats.arrivalGaps, 0.95)),
    interpMs: Math.round(((shooter.stats.delaySum || 0) / Math.max(1, shooter.stats.ticks)) * (1000 / 60)),
    extrapolatedPct: pct(shooter.stats.extrapolatedFrames, shooter.stats.frames),
    corrPerMin: (target.stats.corrections / SECONDS) * 60,
    corrAvgCm: target.stats.corrections ? (target.stats.correctionSum / target.stats.corrections) * 100 : 0,
    corrMaxCm: target.stats.correctionMax * 100,
    starvedPct: pct(tnet.starved + snet.starved, tnet.ticks + snet.ticks),
    catchupPct: pct(tnet.catchup + snet.catchup, tnet.ticks + snet.ticks),
    timeouts: tnet.timeouts + snet.timeouts,
    dropped: tnet.dropped + snet.dropped,
    skipped: tnet.skipped + snet.skipped,
    bufferTarget: `${sp.bufferTarget}/${tp.bufferTarget}`,
    queueAvg: (tnet.queueSum + snet.queueSum) / Math.max(1, tnet.ticks + snet.ticks),
    hitPct: pct(Math.min(sp.stats.hits, sp.stats.shots), sp.stats.shots),
    shots: sp.stats.shots,
  };
  clearInterval(keepAlive);
  shooter.stop();
  target.stop();
  await proxy.close();
  return res;
}

const gameServer = await startGameServer();
const results = [];
for (const name of PROFILE_NAMES) {
  if (!PROFILES[name]) { console.error(`unknown profile ${name}`); process.exit(1); }
  process.stdout.write(`running ${name}… `);
  const r = await runProfile(name, gameServer.port);
  results.push(r);
  console.log('done');
}
gameServer.gs.stop();
gameServer.server.close();

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const f = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : v);
  const cols = [
    ['profile', (r) => r.profile], ['rtt ms', (r) => r.rtt], ['snap gap p95', (r) => r.snapGapP95], ['interp ms', (r) => r.interpMs], ['extrap %', (r) => f(r.extrapolatedPct)],
    ['corr/min', (r) => f(r.corrPerMin)], ['corr avg cm', (r) => f(r.corrAvgCm)], ['corr max cm', (r) => f(r.corrMaxCm)],
    ['srv starved %', (r) => f(r.starvedPct)], ['catch-up %', (r) => f(r.catchupPct)], ['timeouts', (r) => r.timeouts], ['dropped', (r) => r.dropped], ['skipped', (r) => r.skipped], ['buffer', (r) => r.bufferTarget],
    ['queue avg', (r) => f(r.queueAvg, 2)], ['hit %', (r) => f(r.hitPct)], ['shots', (r) => r.shots],
  ];
  console.log(`\n${SECONDS}s per profile\n`);
  console.log(`| ${cols.map((c) => c[0]).join(' | ')} |`);
  console.log(`|${cols.map(() => '---').join('|')}|`);
  for (const r of results) console.log(`| ${cols.map((c) => c[1](r)).join(' | ')} |`);
}
process.exit(0);
