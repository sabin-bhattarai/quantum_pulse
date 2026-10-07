import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/Room.js';
import { BTN, MATCH, PULSE, MODES } from '../src/shared/constants.js';

const sink = () => ({ send() {}, snapshot() {} });

function coopRoom() {
  const room = new Room({ id: 'c', mode: MODES.COOP, seed: 2 });
  const a = room.join({ name: 'A', token: null }, sink()).player;
  const b = room.join({ name: 'B', token: null }, sink()).player;
  let seq = 0;
  const step = (inputs = {}) => {
    for (const p of [a, b]) {
      const buttons = inputs[p.id] || 0;
      room.handle(p.id, { t: 'in', i: [[seq, 0, 0, 0, 0, buttons, 0, room.world.tick]] });
    }
    seq++;
    room.tick();
  };
  return { room, world: room.world, a, b, step };
}

function place(p, x, z) {
  Object.assign(p.move, { x, y: 0, z, vx: 0, vy: 0, vz: 0 });
  p.protectedTimer = 0; // skip the 1 s spawn protection for these tests
}

test('tethers link nearby teammates and never constrain movement', () => {
  const { a, b, step } = coopRoom();
  place(a, 20, 20); place(b, 30, 20);
  step();
  assert.equal(a.tetherPartner, b.id);
  assert.equal(b.tetherPartner, a.id);
  assert.ok(a.move.speedMult > 1, 'coordinated distance grants a speed bonus');
  place(b, 20 + PULSE.TETHER_BREAK_RANGE + 5, 20);
  step();
  assert.equal(a.tetherPartner, 0, 'stretched too far: the link breaks');
  assert.equal(a.move.speedMult, a.mods.speedMult);
});

test('lethal damage downs a runner; holding E nearby revives them', () => {
  const { world, a, b, step } = coopRoom();
  place(a, 20, 20); place(b, 21.5, 20);
  world.applyDamage(b, 9999, null, {});
  assert.equal(b.downed, true);
  assert.equal(b.alive, true);
  assert.equal(b.canAct, false);
  const ticks = Math.ceil(MATCH.COOP_REVIVE_TIME_S * 60) + 2;
  for (let i = 0; i < ticks; i++) {
    step({ [a.id]: BTN.INTERACT | (i === 0 ? BTN.INTERACT_P : 0) });
    place(b, 21.5, 20); // keep the downed runner in range
  }
  assert.equal(b.downed, false);
  assert.ok(b.health > 0);
  assert.equal(a.stats.revives, 1);
});

test('downed runners bleed out if nobody helps', () => {
  const { world, a, b, step } = coopRoom();
  place(a, 20, 20); place(b, -20, -20);
  world.applyDamage(b, 9999, null, {});
  for (let i = 0; i < MATCH.COOP_DOWNED_BLEEDOUT_S * 60 + 5; i++) {
    a.health = a.maxHealth;
    step();
  }
  assert.equal(b.alive, false);
});

test('pulse transfer moves charge to the tethered partner', () => {
  const { a, b, step } = coopRoom();
  place(a, 20, 20); place(b, 28, 20);
  step();
  a.pulse = 50; b.pulse = 0;
  step({ [a.id]: BTN.INTERACT_P });
  assert.equal(b.pulse > 0, true);
  assert.ok(a.pulse < 50);
});
