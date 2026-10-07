import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionEnv, createMoveState, stepMovement, MoveEvent, copyMoveState } from '../src/shared/movement.js';
import { ColliderKind, createArena, ARENA_IDS } from '../src/shared/arenas.js';
import { PLAYER, BTN, SIM, MoveState } from '../src/shared/constants.js';
import { makeFracture, FractureMode } from '../src/shared/gravity.js';
import { encodeMoveState } from '../src/shared/protocol.js';
import { mulberry32 } from '../src/shared/math.js';
import { Prediction } from '../src/client/Prediction.js';

const DT = SIM.DT;

function box(id, minX, minY, minZ, maxX, maxY, maxZ, kind = ColliderKind.SOLID) {
  return { id, minX, minY, minZ, maxX, maxY, maxZ, kind, alive: true, zone: 0, noGrapple: false };
}

/** Small test arena: a floor, a wall at x = 10, a phase wall at z = -10, a 0.3 m step and a tall tower. */
function testEnv() {
  const arena = {
    half: 40, killY: -20, pads: [], rings: [],
    colliders: [
      box(0, -40, -1, -40, 40, 0, 40),
      box(1, 10, 0, -40, 12, 10, 40),
      box(2, -40, 0, -10.25, 40, 6, -9.75, ColliderKind.PHASE),
      box(3, -5, 0, 3, -3, 0.3, 6),
      box(4, -2, 0, 20, 2, 30, 24),
    ],
  };
  return createCollisionEnv(arena);
}

const inp = (o = {}) => ({ mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, ...o });

function run(s, env, n, input) {
  let ev = 0;
  for (let i = 0; i < n; i++) ev |= stepMovement(s, typeof input === 'function' ? input(i) : input, env, DT);
  return ev;
}

test('falls under gravity and lands on the floor', () => {
  const env = testEnv();
  const s = createMoveState(0, 5, 0);
  const ev = run(s, env, 120, inp());
  assert.equal(s.onGround, 1);
  assert.ok(Math.abs(s.y) < 1e-9);
  assert.equal(s.vy, 0);
  assert.ok(ev & MoveEvent.LAND);
  assert.equal(s.state, MoveState.GROUNDED);
});

test('movement is deterministic for identical input streams', () => {
  const env = testEnv();
  const a = createMoveState(0, 0, 0), b = createMoveState(0, 0, 0);
  const rng = mulberry32(99);
  const script = Array.from({ length: 900 }, () => ({
    mx: Math.round(rng() * 2 - 1), mz: Math.round(rng() * 2 - 1), yaw: rng() * 6 - 3, pitch: rng() - 0.5,
    buttons: (rng() < 0.05 ? BTN.JUMP_P : 0) | (rng() < 0.5 ? BTN.SPRINT : 0) | (rng() < 0.03 ? BTN.SLIDE_P | BTN.SLIDE : 0) | (rng() < 0.02 ? BTN.DASH_P : 0),
  }));
  for (const c of script) stepMovement(a, c, env, DT);
  for (const c of script) stepMovement(b, c, env, DT);
  assert.deepEqual(encodeMoveState(a), encodeMoveState(b));
});

test('walk and sprint speeds are reached but not exceeded', () => {
  const env = testEnv();
  const s = createMoveState(-20, 0, 30, 0); // open lane toward -Z
  run(s, env, 60, inp({ mz: 1 }));
  assert.ok(Math.abs(Math.hypot(s.vx, s.vz) - PLAYER.WALK_SPEED) < 0.2);
  const t = createMoveState(-20, 0, 30, 0);
  run(t, env, 60, inp({ mz: 1, buttons: BTN.SPRINT }));
  assert.ok(Math.abs(Math.hypot(t.vx, t.vz) - PLAYER.SPRINT_SPEED) < 0.2);
});

test('walls block movement without penetration', () => {
  const env = testEnv();
  const s = createMoveState(5, 0, 0, -Math.PI / 2); // facing +X toward the wall at x = 10
  run(s, env, 180, inp({ mz: 1, yaw: -Math.PI / 2, buttons: BTN.SPRINT }));
  assert.ok(s.x <= 10 - PLAYER.HALF_WIDTH + 1e-3, `x = ${s.x}`);
  assert.ok(s.x > 9);
});

test('jump buffering and coyote time', () => {
  const env = testEnv();
  // Buffer: press jump a few ticks before touching the ground.
  const s = createMoveState(0, 0.15, 0);
  s.vy = -6;
  let jumped = 0;
  run(s, env, 20, (i) => inp({ buttons: i === 0 ? BTN.JUMP_P : 0 }));
  jumped = s.vy > 0 || s.y > 0.5;
  assert.ok(jumped, 'buffered jump fired on landing');
  // Coyote: leave a ledge, jump 4 ticks later.
  const env2 = createCollisionEnv({ half: 40, killY: -20, pads: [], rings: [], colliders: [box(0, -40, -1, -40, 0, 0, 40)] });
  const c = createMoveState(-0.2, 0, 0, -Math.PI / 2);
  c.onGround = 1;
  let leftAt = -1;
  let ev = 0;
  for (let i = 0; i < 40; i++) {
    const press = leftAt >= 0 && i === leftAt + 4;
    ev |= stepMovement(c, inp({ mz: 1, yaw: -Math.PI / 2, buttons: press ? BTN.JUMP_P : 0 }), env2, DT);
    if (leftAt < 0 && !c.onGround) leftAt = i;
  }
  assert.ok(ev & MoveEvent.JUMP, 'coyote jump allowed shortly after leaving the ledge');
});

test('slide boosts speed and slide-jump keeps it', () => {
  const env = testEnv();
  const s = createMoveState(-20, 0, 35, 0); // open lane toward -Z
  run(s, env, 60, inp({ mz: 1, buttons: BTN.SPRINT }));
  const before = Math.hypot(s.vx, s.vz);
  const ev = stepMovement(s, inp({ mz: 1, buttons: BTN.SPRINT | BTN.SLIDE | BTN.SLIDE_P }), env, DT);
  assert.ok(ev & MoveEvent.SLIDE);
  assert.ok(Math.hypot(s.vx, s.vz) > before + PLAYER.SLIDE_BOOST * 0.8);
  stepMovement(s, inp({ mz: 1, buttons: BTN.SLIDE | BTN.JUMP_P }), env, DT);
  assert.ok(s.vy > 0);
  assert.ok(Math.hypot(s.vx, s.vz) > before);
});

test('air dash: one per airtime, refilled on landing, speed capped', () => {
  const env = testEnv();
  const s = createMoveState(-20, 0, 30, 0);
  stepMovement(s, inp({ buttons: BTN.JUMP_P }), env, DT);
  const e1 = stepMovement(s, inp({ mz: 1, buttons: BTN.DASH_P }), env, DT);
  assert.ok(e1 & MoveEvent.DASH);
  assert.ok(Math.hypot(s.vx, s.vz) <= PLAYER.MAX_HORIZONTAL_SPEED + 1e-9);
  s.dashCooldown = 0; // isolate the charge rule from the cooldown rule
  const e2 = stepMovement(s, inp({ mz: 1, buttons: BTN.DASH_P }), env, DT);
  assert.ok(!(e2 & MoveEvent.DASH), 'no second dash before landing');
  run(s, env, 120, inp());
  assert.equal(s.onGround, 1);
  assert.equal(s.dashCharges, PLAYER.DASH_CHARGES, 'landing refills dash charges');
});

test('small steps are climbed automatically', () => {
  const env = testEnv();
  const s = createMoveState(-4, 0, 1, Math.PI); // facing +Z toward the step spanning z = 3..6
  run(s, env, 30, inp({ mz: 1, yaw: Math.PI }));
  assert.ok(s.z > 3.3 && s.z < 6, `z = ${s.z}`);
  assert.ok(Math.abs(s.y - 0.3) < 0.01, `y = ${s.y}`);
});

test('phase barriers block normally but are passable during Phase Break', () => {
  const env = testEnv();
  const s = createMoveState(0, 0, -6, 0); // facing -Z toward the barrier at z = -10
  run(s, env, 120, inp({ mz: 1 }));
  assert.ok(s.z > -9.75, 'blocked without phase');
  const t = createMoveState(0, 0, -6, 0);
  t.pulseReady = 1;
  const ev = stepMovement(t, inp({ mz: 1, buttons: BTN.PULSE_P }), env, DT);
  assert.ok(ev & MoveEvent.PHASE_START);
  run(t, env, 100, inp({ mz: 1 }));
  assert.ok(t.z < -10.5, `phased through: z = ${t.z}`);
  assert.equal(t.pulseReady, 0, 'activation consumes readiness');
});

test('grapple attaches to geometry and reeling shortens the rope', () => {
  const env = testEnv();
  const s = createMoveState(0, 0, 8, Math.PI); // tower at z = 20..24 is ahead (+Z)
  const pitch = 0.6;
  const ev = stepMovement(s, inp({ yaw: Math.PI, pitch, buttons: BTN.GRAPPLE_P | BTN.GRAPPLE }), env, DT);
  assert.ok(ev & MoveEvent.GRAPPLE_ATTACH);
  const len0 = s.glen;
  run(s, env, 30, inp({ yaw: Math.PI, pitch, buttons: BTN.GRAPPLE }));
  assert.ok(s.glen < len0 - 3);
  assert.ok(s.z > 8.5, 'pulled toward the anchor');
  assert.equal(s.state, MoveState.GRAPPLING);
  const launch = stepMovement(s, inp({ yaw: Math.PI, pitch, buttons: BTN.JUMP_P }), env, DT);
  assert.ok(launch & MoveEvent.GRAPPLE_LAUNCH);
  assert.equal(s.grappling, 0);
});

test('velocity stays capped even inside many stacked fractures', () => {
  const env = testEnv();
  for (let i = 0; i < 24; i++) {
    const f = makeFracture(i, 0, 5, 0, 16, 999, 8, FractureMode.REPEL);
    f.age = 1;
    env.fractures[i] = f;
  }
  env.fractureCount = 24;
  const s = createMoveState(1, 0, 1);
  for (let i = 0; i < 300; i++) {
    stepMovement(s, inp(), env, DT);
    assert.ok(Math.hypot(s.vx, s.vz) <= PLAYER.MAX_HORIZONTAL_SPEED + 1e-9);
    assert.ok(Math.abs(s.vy) <= PLAYER.MAX_VERTICAL_SPEED + 1e-9);
  }
});

test('every arena spawn point is on solid ground', () => {
  for (const id of ARENA_IDS) {
    const arena = createArena(id);
    const env = createCollisionEnv(arena);
    for (const sp of arena.spawns) {
      const s = createMoveState(sp.x, sp.y + 0.5, sp.z, sp.yaw);
      run(s, env, 60, inp());
      assert.equal(s.onGround, 1, `${id} spawn ${sp.x},${sp.z}`);
      assert.ok(Math.abs(s.y - sp.y) < 0.01, `${id} spawn ${sp.x},${sp.z} at y=${s.y}`);
    }
  }
});

test('prediction + reconciliation converges to the authoritative state', () => {
  const serverEnv = testEnv(), clientEnv = testEnv();
  const server = createMoveState(0, 0, 0);
  const pred = new Prediction(clientEnv);
  pred.reconcile(encodeMoveState(server), -1); // first snapshot initialises
  const rng = mulberry32(5);
  const cmds = [];
  for (let seq = 0; seq < 240; seq++) {
    const cmd = { seq, mx: Math.round(rng() * 2 - 1), mz: 1, yaw: rng() * 0.4 - 0.2, pitch: 0, buttons: rng() < 0.05 ? BTN.JUMP_P : 0, weapon: 0, viewTick: 0 };
    cmds.push(cmd);
    pred.apply(cmd);
  }
  // The server lags behind by 12 commands and applies a knockback the client did not predict.
  for (let i = 0; i < 228; i++) {
    if (i === 100) server.vx += 15;
    stepMovement(server, cmds[i], serverEnv, DT);
  }
  pred.reconcile(encodeMoveState(server), 227);
  // Ground truth: the server continuing with the remaining commands.
  const truth = createMoveState();
  copyMoveState(truth, server);
  for (let i = 228; i < 240; i++) stepMovement(truth, cmds[i], serverEnv, DT);
  assert.ok(Math.hypot(pred.state.x - truth.x, pred.state.y - truth.y, pred.state.z - truth.z) < 1e-3);
  assert.ok(pred.corrections >= 1, 'the unpredicted knockback produced a correction');
});
