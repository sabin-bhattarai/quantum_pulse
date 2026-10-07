import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, WeaponType, computeSpread, momentumDamageScale, falloffScale, lanceDamage } from '../src/shared/weapons.js';
import { BTN, MODES, SIM, NET } from '../src/shared/constants.js';
import { Room } from '../src/server/Room.js';
import { EnemyType } from '../src/server/Enemy.js';

const sink = () => ({ send() {}, snapshot() {} });

/** Create an offline room with one player standing still. */
function setup(mode = MODES.TRAINING, arenaId = 'reactor_null') {
  const room = new Room({ id: 't', mode, arenaId, seed: 1 });
  const { player } = room.join({ name: 'Tester', token: null }, sink());
  room.world.enemies.clear();
  for (let i = 0; i < 3; i++) room.tick();
  let seq = 0;
  const input = (buttons, weapon, opts = {}) => {
    room.handle(player.id, { t: 'in', i: [[seq++, 0, 0, opts.yaw ?? player.move.yaw, opts.pitch ?? 0, buttons, weapon, opts.viewTick ?? room.world.tick]] });
    room.tick();
  };
  return { room, world: room.world, p: player, input };
}

/** Spawn a training dummy straight ahead of the player and return aim angles. */
function dummyAhead(world, p, dist = 8) {
  const yaw = p.move.yaw;
  const x = p.x - Math.sin(yaw) * dist, z = p.z - Math.cos(yaw) * dist;
  const e = world.enemies.spawn(EnemyType.DUMMY, x, p.y + 1.62, z, {});
  e.maxHp = e.hp = 1e6;
  return e;
}

test('weapon table: six weapons with every required hook', () => {
  assert.ok(WEAPONS.length >= 6);
  const types = new Set(WEAPONS.map((w) => w.type));
  for (const t of Object.values(WeaponType)) assert.ok(types.has(t), `weapon type ${t} present`);
  for (const w of WEAPONS) {
    for (const k of ['id', 'name', 'type', 'damage', 'fireInterval', 'magazine', 'reloadTime', 'range', 'sfx', 'vfx', 'color']) {
      assert.ok(w[k] !== undefined, `${w.id}.${k}`);
    }
    assert.ok(w.fireInterval > 0 && w.damage > 0);
  }
});

test('spread: capped, worse in the air and at speed, tighter when aiming', () => {
  const carbine = WEAPONS[0];
  const still = computeSpread(carbine, 0, false, false);
  assert.ok(computeSpread(carbine, 25, false, false) > still);
  assert.ok(computeSpread(carbine, 0, true, false) > still);
  assert.ok(computeSpread(carbine, 0, false, true) < still);
  assert.ok(computeSpread(carbine, 1000, true, false) <= carbine.spreadMax);
});

test('momentum bonus is capped at +30%, falloff and lance charge are monotonic', () => {
  assert.equal(momentumDamageScale(0), 1);
  assert.ok(Math.abs(momentumDamageScale(1e6) - 1.3) < 1e-9);
  assert.equal(falloffScale(WEAPONS[0], 10), 1);
  assert.ok(falloffScale(WEAPONS[0], 200) >= WEAPONS[0].falloffMin);
  const lance = WEAPONS[2];
  assert.equal(lanceDamage(lance, 0), lance.minDamage);
  assert.equal(lanceDamage(lance, 1), lance.maxDamage);
  assert.ok(lanceDamage(lance, 0.5) < lanceDamage(lance, 0.9));
});

test('server enforces fire rate regardless of how often fire is held', () => {
  const { p, input } = setup();
  const def = WEAPONS[0];
  const ticks = SIM.TICK_RATE; // one second of held fire
  for (let i = 0; i < ticks; i++) input(BTN.FIRE, 0);
  const maxShots = Math.ceil(1 / def.fireInterval) + 1;
  assert.ok(p.stats.shots <= maxShots, `${p.stats.shots} <= ${maxShots}`);
  assert.ok(p.stats.shots >= maxShots - 2);
});

test('ammunition depletes and a reload refills it on the server', () => {
  const { p, input } = setup();
  const ws = p.weapons[0];
  for (let i = 0; i < 60 * 5 && ws.ammo > 0; i++) input(BTN.FIRE, 0);
  assert.equal(ws.ammo, 0);
  input(BTN.RELOAD_P, 0);
  assert.ok(ws.reloadTimer > 0);
  for (let i = 0; i < 60 * 3; i++) input(0, 0);
  assert.equal(ws.ammo, p.magazineOf(ws));
});

test('weapon ownership is validated: unowned weapons cannot be selected', () => {
  const { p, input } = setup(MODES.SURVIVAL, 'neon_rupture');
  assert.equal(p.weapons[3].owned, false, 'singularity starts locked in survival');
  input(BTN.FIRE, 3);
  assert.notEqual(p.weaponIndex, 3);
});

test('hitscan damage is computed by the server and lands on a target in front', () => {
  const { world, p, input } = setup();
  const e = dummyAhead(world, p);
  const hp0 = e.hp;
  for (let i = 0; i < 30; i++) input(BTN.FIRE, 0);
  assert.ok(e.hp < hp0);
  assert.ok(p.stats.damage > 0);
});

test('lag compensation: a stale viewTick is clamped to the rewind window', () => {
  const { world } = setup();
  for (let i = 0; i < 120; i++) world.step();
  const clamped = world.clampRewindTick(0);
  assert.ok(world.tick - clamped <= Math.floor((NET.LAG_COMP_MAX_MS / 1000) * SIM.TICK_RATE), 'cannot rewind further than LAG_COMP_MAX_MS');
  assert.equal(world.clampRewindTick(world.tick + 500), world.tick, 'cannot shoot into the future');
});

test('Echo Repeater repeats each shot after its delay', () => {
  const { world, p, input } = setup();
  const e = dummyAhead(world, p);
  input(BTN.FIRE, 5); // switch
  for (let i = 0; i < 20; i++) input(0, 5);
  const before = e.hp;
  input(BTN.FIRE, 5);
  const afterShot = e.hp;
  for (let i = 0; i < 45; i++) input(0, 5);
  assert.ok(afterShot < before, 'primary shot hit');
  assert.ok(e.hp < afterShot, 'echo shot hit later');
});

test('Singularity Launcher creates a Gravity Fracture on impact', () => {
  const { world, input } = setup();
  input(BTN.FIRE, 3);
  for (let i = 0; i < 20; i++) input(0, 3);
  input(BTN.FIRE, 3);
  let created = false;
  for (let i = 0; i < 60 * 4 && !created; i++) { input(0, 3); if (world.fractureCount > 0) created = true; }
  assert.ok(created);
});

test('Vector Lance charges while held and fires on release', () => {
  const { world, p, input } = setup();
  const e = dummyAhead(world, p, 12);
  input(0, 2);
  for (let i = 0; i < 20; i++) input(0, 2);
  for (let i = 0; i < 70; i++) input(BTN.FIRE, 2);
  assert.ok(p.weapons[2].charge > 0.9);
  const hp0 = e.hp;
  input(0, 2);
  assert.ok(hp0 - e.hp >= WEAPONS[2].maxDamage * 0.85);
});

test('clients cannot inject damage, score or positions through any message', () => {
  const { room, p } = setup();
  const before = { ...p.stats, x: p.x };
  assert.equal(room.handle(p.id, { t: 'in', i: [[9999, 0, 0, 0, 0, 0, 0, 0]], damage: 9999 }).ok, false);
  assert.equal(room.handle(p.id, { t: 'kill', target: 1 }).ok, false);
  assert.equal(room.handle(p.id, { t: 'up', c: 0, score: 1e9 }).ok, false);
  assert.equal(p.stats.score, before.score);
  assert.equal(p.x, before.x);
});
