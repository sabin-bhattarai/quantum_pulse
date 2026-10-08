import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/Room.js';
import { MODES, PLAYER, ROGUE } from '../src/shared/constants.js';
import { EnemyType } from '../src/server/Enemy.js';
import { PK } from '../src/shared/protocol.js';
import { raycastArena } from '../src/shared/movement.js';

const sink = () => ({ send() {}, snapshot() {} });

function ffaRoom() {
  const room = new Room({ id: 'h', mode: MODES.FFA, seed: 3, arenaId: 'folded_archive' });
  const a = room.join({ name: 'A', token: null }, sink()).player;
  const b = room.join({ name: 'B', token: null }, sink()).player;
  const w = room.world;
  let seq = 0;
  const step = () => {
    for (const p of [a, b]) room.handle(p.id, { t: 'in', i: [[seq, 0, 0, 0, 0, 0, 0, w.tick]] });
    seq++;
    room.tick();
  };
  return { room, w, a, b, step };
}

function place(p, x, z, y = 0) {
  Object.assign(p.move, { x, y, z, vx: 0, vy: 0, vz: 0, slideTimer: 0 });
  p.protectedTimer = 0;
}

/** Two spawn points on the same floor, 10-25 m apart, with clear sight at every test height. */
function lane(w) {
  const sp = w.arena.spawns;
  for (const s of sp) {
    for (const t of sp) {
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (s === t || Math.abs(s.y - t.y) > 0.05 || d < 10 || d > 25) continue;
      const clear = [0.35, 1.1, PLAYER.HEAD_CENTER, 2.15, 4].every((h) => {
        const dx = t.x - s.x, dy = h - PLAYER.EYE_HEIGHT, dz = t.z - s.z;
        const l = Math.hypot(dx, dy, dz);
        return raycastArena(w.env, s.x, s.y + PLAYER.EYE_HEIGHT, s.z, dx / l, dy / l, dz / l, l + 1, false, false).t < 0;
      });
      if (clear) return { from: s, to: t };
    }
  }
  throw new Error('no clear lane in this arena');
}

/** Fire a ray from the shooter's eye toward a point; returns the first hit or null. */
function shoot(w, shooter, ox, oz, tx, ty, tz) {
  const oy = shooter.move.y + PLAYER.EYE_HEIGHT;
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const l = Math.hypot(dx, dy, dz);
  dx /= l; dy /= l; dz /= l;
  const res = w.traceShot(shooter, ox, oy, oz, dx, dy, dz, 200, 0, w.tick);
  return res.count ? res.hits[0] : null;
}

test('player hitbox matches the drawn runner: helmet = headshot, knees hit, above the head misses', () => {
  const { w, a, b, step } = ffaRoom();
  const { from, to } = lane(w);
  const setup = () => { place(a, from.x, from.z, from.y); place(b, to.x, to.z, to.y); };
  setup(); step(); setup(); step();
  const at = (y) => shoot(w, a, a.move.x, a.move.z, b.move.x, y, b.move.z);
  const helmet = at(b.move.y + PLAYER.HEAD_CENTER);
  assert.ok(helmet && helmet.target === b && helmet.head, 'aiming at the helmet is a headshot');
  const knees = at(b.move.y + 0.4);
  assert.ok(knees && knees.target === b && !knees.head, 'aiming at the knees is a body hit');
  const chest = at(b.move.y + 1.1);
  assert.ok(chest && chest.target === b && !chest.head, 'chest is a body hit');
  assert.equal(at(b.move.y + 2.15), null, 'a shot clearly above the head misses');
});

test('Rogue Runner hitbox matches the drawn rig as well', () => {
  const { w, a, b, step } = ffaRoom();
  const { from, to } = lane(w);
  place(b, -45, -45, 0);
  place(a, from.x, from.z, from.y);
  const e = w.enemies.spawn(EnemyType.ROGUE, to.x, to.y, to.z, {});
  w.enemies.updateRogue = () => {}; // hold still for the measurement
  step(); place(a, from.x, from.z, from.y);
  const feet = e.y - ROGUE.CENTER;
  const head = shoot(w, a, from.x, from.z, e.x, feet + PLAYER.HEAD_CENTER, e.z);
  assert.ok(head && head.target === e && head.head);
  const legs = shoot(w, a, from.x, from.z, e.x, feet + 0.35, e.z);
  assert.ok(legs && legs.target === e && !legs.head, 'legs are part of the body now');
});

test('scatter pellets are lag compensated and can land headshots', () => {
  const { w, a, b, step } = ffaRoom();
  const { from, to } = lane(w);
  // B side-steps 2.5 m just before the pellet arrives. The shooter, who sees the
  // world LAG ticks late, still sees B in the pellet's path, so it must hit.
  const LAG = 12;
  const lx = to.x - from.x, lz = to.z - from.z, ll = Math.hypot(lx, lz);
  const sx = (-lz / ll) * 2.5, sz = (lx / ll) * 2.5;
  let off = 0;
  const setup = () => { place(a, from.x, from.z, from.y); place(b, to.x + sx * off, to.z + sz * off, to.y); };
  for (let i = 0; i < LAG + 2; i++) { setup(); step(); }
  const hp = b.health + b.shield;
  const ox = from.x, oy = from.y + PLAYER.EYE_HEIGHT, oz = from.z;
  const dx = to.x - ox, dy = to.y + PLAYER.HEAD_CENTER - oy, dz = to.z - oz, l = Math.hypot(dx, dy, dz);
  w.spawnProjectile({
    kind: PK.PELLET, owner: a, team: a.team, x: ox, y: oy, z: oz, vx: (dx / l) * 75, vy: (dy / l) * 75, vz: (dz / l) * 75,
    gravity: 0, life: 1, radius: 0.18, damage: 8.5, weapon: 1, lag: LAG,
  });
  const pellet = w.projectiles.find((pr) => pr.active && pr.kind === PK.PELLET);
  for (let i = 0; i < 40 && pellet.active; i++) {
    if (Math.hypot(pellet.x - to.x, pellet.z - to.z) < 4) off = 1; // dodge at the last moment
    setup(); step();
  }
  assert.ok(b.health + b.shield < hp, 'the pellet hits where the shooter saw the target');
  assert.ok(a.stats.headshots >= 1, 'and counts as a headshot');
});
