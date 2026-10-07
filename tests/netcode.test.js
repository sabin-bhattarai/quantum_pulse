import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/Room.js';
import { NET, SIM, MODES } from '../src/shared/constants.js';
import { ServerClock } from '../src/client/Interpolation.js';

const sink = () => ({ send() {}, snapshot() {} });

function ffaPlayer() {
  const room = new Room({ id: 'n', mode: MODES.FFA, seed: 4 });
  const { player } = room.join({ name: 'N', token: null }, sink());
  let seq = 0;
  const packet = (n) => {
    const i = [];
    for (let k = 0; k < n; k++) i.push([seq++, 1, 0, 0, 0, 0, 0, room.world.tick]);
    room.handle(player.id, { t: 'in', i });
  };
  return { room, p: player, packet, seq: () => seq };
}

test('jitter buffer consumes one command per tick when packets carry two', () => {
  const { room, p, packet } = ffaPlayer();
  for (let t = 0; t < 120; t++) {
    if (t % 2 === 0) packet(2); // 30 Hz batches, like the browser client
    room.tick();
  }
  Object.assign(p.net, { ticks: 0, starved: 0, catchup: 0 });
  for (let t = 0; t < 120; t++) {
    if (t % 2 === 0) packet(2);
    room.tick();
  }
  assert.equal(p.net.starved, 0, 'no lurching: the player moves every tick');
  assert.equal(p.net.catchup, 0);
});

test('a burst after a stall is caught up without dropping commands', () => {
  const { room, p, packet } = ffaPlayer();
  for (let t = 0; t < 30; t++) { packet(1); room.tick(); }
  for (let t = 0; t < 12; t++) room.tick(); // 200 ms stall (below the timeout)
  packet(10);
  packet(2);
  for (let t = 0; t < 20; t++) room.tick();
  assert.equal(p.net.dropped, 0);
  assert.ok(p.net.catchup > 0, 'backlog drained faster than one per tick');
  assert.equal(p.inputQueue.length <= p.bufferTarget + 1, true);
});

test('time credit: flooding commands cannot move faster than real time', () => {
  const { room, p, packet } = ffaPlayer();
  const ticks = 300;
  const startAck = p.lastAckSeq;
  let simulated = 0;
  const orig = room.world.processInput.bind(room.world);
  room.world.processInput = (pl, inp) => { if (pl === p) simulated++; orig(pl, inp); };
  for (let t = 0; t < ticks; t++) { packet(3); room.tick(); } // 3x real time
  assert.ok(simulated <= ticks + NET.INPUT_CREDIT_MAX_TICKS, `${simulated} steps in ${ticks} ticks`);
  assert.ok(p.net.dropped > 0, 'excess commands are discarded at the queue cap');
  assert.ok(p.lastAckSeq > startAck);
});

test('a stalled client is simulated with neutral input and its late commands are skipped', () => {
  const { room, p, packet } = ffaPlayer();
  for (let t = 0; t < 30; t++) { packet(1); room.tick(); }
  const stallTicks = Math.ceil((NET.INPUT_TIMEOUT_MS / 1000) * SIM.TICK_RATE) + 15;
  for (let t = 0; t < stallTicks; t++) room.tick();
  assert.ok(p.net.timeouts > 0);
  const owed = p.owedSkips;
  packet(Math.min(owed + 4, NET.MAX_INPUTS_PER_PACKET));
  room.tick();
  assert.ok(p.net.skipped > 0, 'commands covering already-simulated time are acknowledged, not re-run');
  assert.ok(p.net.timeouts <= owed, 'no further timeouts once input resumes');
});

test('adaptive interpolation delay follows snapshot jitter within its limits', () => {
  const interval = SIM.TICK_RATE / SIM.SNAPSHOT_RATE;
  const steady = new ServerClock(interval);
  const jittery = new ServerClock(interval);
  let tick = 0;
  for (let i = 0; i < 200; i++) {
    tick += interval;
    const t = (tick / SIM.TICK_RATE) * 1000;
    steady.observe(tick, t);
    jittery.observe(tick, t + (i % 5 === 0 ? 90 : 0)); // every 5th snapshot 90 ms late
  }
  for (let i = 0; i < 600; i++) { steady.update(1 / 60); jittery.update(1 / 60); }
  assert.ok(steady.delayTicks < interval + 1.5, `steady delay ${steady.delayTicks}`);
  assert.ok(jittery.delayTicks > steady.delayTicks + 3, `jittery delay ${jittery.delayTicks}`);
  assert.ok(jittery.delayTicks <= (NET.INTERP_DELAY_MAX_MS / 1000) * SIM.TICK_RATE + 1e-9);
});
