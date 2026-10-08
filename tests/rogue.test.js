import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/Room.js';
import { MODES, SIM, ROGUE, PLAYER } from '../src/shared/constants.js';
import { EnemyType } from '../src/server/Enemy.js';

const sink = () => ({ send() {}, snapshot() {} });

/** Solo room with one runner who stands still and cannot die (we only observe the bots). */
function soloRoom(arenaId = 'neon_rupture', seed = 7) {
  const room = new Room({ id: 's', mode: MODES.SURVIVAL, seed, arenaId });
  const p = room.join({ name: 'P', token: null }, sink()).player;
  const w = room.world;
  let taken = 0;
  const applyDamage = w.applyDamage.bind(w);
  w.applyDamage = (t, amount, src, opts) => (t === p ? void (taken += amount) : applyDamage(t, amount, src, opts));
  let seq = 0;
  const run = (seconds, each) => {
    for (let i = 0; i < SIM.TICK_RATE * seconds; i++) {
      room.handle(p.id, { t: 'in', i: [[seq++, 0, 0, 0, 0, 0, 0, w.tick]] });
      room.tick();
      if (each) each(w);
    }
  };
  return { room, world: w, p, run, damageTaken: () => taken };
}

const rogues = (w) => w.enemies.active.filter((e) => e.type === EnemyType.ROGUE);

test('solo waves are Rogue Runners spread over different spawn points, away from the player', () => {
  const { world, p, run } = soloRoom();
  run(5);
  assert.equal(world.rules.wave, 1);
  const list = rogues(world);
  assert.equal(list.length, 3, 'wave 1 sends three runners');
  assert.equal(world.enemies.count, list.length, 'and nothing else');
  const homes = new Set(list.map((e) => `${e.homeX},${e.homeZ}`));
  assert.equal(homes.size, list.length, 'each runner has its own spawn point');
  for (const e of list) assert.ok(Math.hypot(e.homeX - p.x, e.homeZ - p.z) >= ROGUE.SPAWN_MIN_DIST);
});

test('every fifth solo wave is an elite runner squad; nothing flies', () => {
  const { world } = soloRoom();
  const { queue, isBoss, isElite } = world.rules.composeWave(5);
  assert.ok(!isBoss && isElite);
  assert.ok(queue.every((q) => q.type === EnemyType.ROGUE), 'runners only');
  assert.ok(queue.filter((q) => q.elite).length >= 2, 'with elites');
  for (let n = 1; n <= 20; n++) assert.ok(world.rules.composeWave(n).queue.every((q) => q.type === EnemyType.ROGUE));
});

test('co-op waves are runner squads that push the reactor and never fly off the map', () => {
  const room = new Room({ id: 'c', mode: MODES.COOP, seed: 5 });
  const a = room.join({ name: 'A', token: null }, sink()).player;
  const w = room.world;
  const applyDamage = w.applyDamage.bind(w);
  w.applyDamage = (t, amount, src, opts) => (t === a ? undefined : applyDamage(t, amount, src, opts));
  let falls = 0;
  const kill = w.killEnemy.bind(w);
  w.killEnemy = (e, k, o = {}) => { if (o.environmental) falls++; kill(e, k, o); };
  let seq = 0, seenTypes = new Set();
  for (let i = 0; i < SIM.TICK_RATE * 60; i++) {
    room.handle(a.id, { t: 'in', i: [[seq++, 0, 0, 0, 0, 0, 0, w.tick]] });
    room.tick();
    for (const e of w.enemies.active) seenTypes.add(e.type);
  }
  assert.deepEqual([...seenTypes], [EnemyType.ROGUE], 'only Rogue Runners in co-op');
  assert.ok(w.reactor.hp < w.reactor.maxHp, 'runners attack the reactor');
  assert.equal(falls, 0);
});

test('wave sizes stay small and capped', () => {
  const { world } = soloRoom();
  for (let n = 1; n <= 30; n++) {
    const runners = world.rules.composeWave(n).queue.filter((q) => q.type === EnemyType.ROGUE).length;
    assert.ok(runners <= ROGUE.MAX_PER_WAVE, `wave ${n}: ${runners} runners`);
  }
});

for (const arenaId of ['neon_rupture', 'folded_archive']) {
  test(`Rogue Runners engage without walking off the map and share fire tokens (${arenaId})`, () => {
    const { world, run, damageTaken } = soloRoom(arenaId);
    let falls = 0, maxBursting = 0;
    const kill = world.killEnemy.bind(world);
    world.killEnemy = (e, k, o = {}) => { if (o.environmental) falls++; kill(e, k, o); };
    run(90, (w) => {
      let bursting = 0;
      for (const e of w.enemies.active) if (e.move && e.burstLeft > 0) bursting++;
      maxBursting = Math.max(maxBursting, bursting);
    });
    assert.equal(falls, 0, 'no runner fell into the void on its own');
    assert.ok(maxBursting <= world.difficulty.shooters, `at most ${world.difficulty.shooters} fire at once (saw ${maxBursting})`);
    assert.ok(damageTaken() > 0, 'they find and shoot the player');
    // a player who never moves is worn down slowly enough to react
    assert.ok(damageTaken() / 90 < 9, `damage per second ${(damageTaken() / 90).toFixed(1)}`);
  });
}

test('a Rogue Runner head is its weak point, at head height above the feet', () => {
  const { world } = soloRoom();
  const e = world.enemies.spawn(EnemyType.ROGUE, 0, 0, 20, {});
  const wp = {};
  assert.ok(e.weakPoint(e.x, e.y, e.z, wp));
  assert.ok(Math.abs(wp.y - e.move.y - PLAYER.HEAD_CENTER) < 0.01);
  assert.ok(e.name.length > 0, 'runners carry a callsign for the kill feed');
});
