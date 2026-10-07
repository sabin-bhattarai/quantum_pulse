/**
 * Quantum Pulse — deterministic player movement.
 *
 * This module is the single source of truth for how a Pulse Runner moves. The
 * authoritative server runs `stepMovement` for every input command it accepts,
 * and the client runs the exact same function to PREDICT its own movement
 * before the server answers. Because both sides execute identical code with the
 * same fixed timestep, the prediction is correct whenever the server's world
 * matches the client's view of it; when it does not (knockback, a prop broke,
 * a fracture appeared), the client rewinds to the server state and replays its
 * pending inputs (see client/Prediction.js).
 *
 * Rules for editing this file:
 *  - No randomness, no Date.now(), no variable dt: everything must be a pure
 *    function of (state, input, env, dt).
 *  - Every velocity change must respect the caps in PLAYER.MAX_*_SPEED.
 *  - Add new persistent fields to `createMoveState`, `MOVE_FIELDS` (so they are
 *    snapshotted and reconciled), and the tests in tests/movement.test.js.
 * @module shared/movement
 */
import { PLAYER, PULSE, MoveState, BTN } from './constants.js';
import { clamp, rayAABB, raySphere } from './math.js';
import { ColliderKind } from './arenas.js';
import { accumulateFractureDeltaV } from './gravity.js';

/** Event flags raised during a single step (consumed by server/client for effects & scoring). */
export const MoveEvent = Object.freeze({
  JUMP: 1 << 0,
  LAND: 1 << 1,
  SLIDE: 1 << 2,
  DASH: 1 << 3,
  WALLJUMP: 1 << 4,
  GRAPPLE_ATTACH: 1 << 5,
  GRAPPLE_RELEASE: 1 << 6,
  GRAPPLE_LAUNCH: 1 << 7,
  PAD: 1 << 8,
  RING: 1 << 9,
  PHASE_START: 1 << 10,
  FELL_OUT: 1 << 11,
  HARD_LAND: 1 << 12,
  GRAPPLE_FAIL: 1 << 13,
});

/**
 * Persistent movement fields. These are exactly the fields serialised in the
 * owner's snapshot and restored during reconciliation. Order matters for the
 * compact array encoding (see protocol.js `encodeMoveState`).
 */
export const MOVE_FIELDS = Object.freeze([
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch',
  'onGround', 'airTime', 'jumpBuffer',
  'slideTimer', 'slideCooldown',
  'dashTimer', 'dashCooldown', 'dashCharges',
  'wallNx', 'wallNz', 'wallTimer', 'wallRunTime', 'wallJumpCooldown',
  'grappling', 'gx', 'gy', 'gz', 'glen', 'grappleTime', 'grappleCooldown',
  'phaseTimer', 'stunTimer', 'dead', 'pulseReady', 'speedMult',
  'ringCooldown', 'boostTimer', 'state',
]);

/** @returns {object} a fresh movement state at the given position */
export function createMoveState(x = 0, y = 0, z = 0, yaw = 0) {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0,
    onGround: 0, airTime: 0, jumpBuffer: 0,
    slideTimer: 0, slideCooldown: 0,
    dashTimer: 0, dashCooldown: 0, dashCharges: PLAYER.DASH_CHARGES,
    wallNx: 0, wallNz: 0, wallTimer: 9, wallRunTime: 0, wallJumpCooldown: 0,
    grappling: 0, gx: 0, gy: 0, gz: 0, glen: 0, grappleTime: 0, grappleCooldown: 0,
    phaseTimer: 0, stunTimer: 0, dead: 0, pulseReady: 0, speedMult: 1,
    ringCooldown: 0, boostTimer: 0, state: MoveState.FALLING,
    // transient (not snapshotted)
    events: 0, landSpeed: 0, ringIndex: -1,
  };
}

/** Copy persistent fields from `src` into `dst`. */
export function copyMoveState(dst, src) {
  for (let i = 0; i < MOVE_FIELDS.length; i++) {
    const k = MOVE_FIELDS[i];
    dst[k] = src[k];
  }
  return dst;
}

/* ------------------------------------------------------------------------ */
/* Collision environment                                                     */
/* ------------------------------------------------------------------------ */

const GRID_CELL = 8;

/**
 * Build the collision environment for an arena.
 *
 * Spatial partitioning: colliders are bucketed into an XZ grid of 8 m cells so
 * a player's collision query only inspects boxes in the 1–4 cells it overlaps
 * instead of every box in the arena. A per-query stamp array de-duplicates
 * boxes spanning several cells without allocating a Set.
 *
 * @param {object} arena from shared/arenas.js
 * @returns {object} env passed to stepMovement
 */
export function createCollisionEnv(arena) {
  const half = arena.half + 8;
  const cells = Math.ceil((half * 2) / GRID_CELL);
  const grid = new Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  const cellOf = (v) => clamp(Math.floor((v + half) / GRID_CELL), 0, cells - 1);
  arena.colliders.forEach((c, idx) => {
    const x0 = cellOf(c.minX), x1 = cellOf(c.maxX), z0 = cellOf(c.minZ), z1 = cellOf(c.maxZ);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) grid[gx * cells + gz].push(idx);
  });
  return {
    arena,
    colliders: arena.colliders,
    grid, cells, half, cellOf,
    stamps: new Uint32Array(arena.colliders.length),
    stamp: 1,
    query: [], // reused result list
    fractures: [],
    fractureCount: 0,
    pads: arena.pads,
    rings: arena.rings,
    killY: arena.killY,
  };
}

/**
 * Collect colliders overlapping an XZ rectangle into env.query.
 * The returned array is reused by the next query — consume it immediately.
 */
export function queryColliders(env, minX, maxX, minZ, maxZ) {
  const q = env.query;
  q.length = 0;
  env.stamp = (env.stamp + 1) >>> 0;
  if (env.stamp === 0) { env.stamps.fill(0); env.stamp = 1; }
  const x0 = env.cellOf(minX), x1 = env.cellOf(maxX), z0 = env.cellOf(minZ), z1 = env.cellOf(maxZ);
  for (let gx = x0; gx <= x1; gx++) {
    for (let gz = z0; gz <= z1; gz++) {
      const list = env.grid[gx * env.cells + gz];
      for (let i = 0; i < list.length; i++) {
        const idx = list[i];
        if (env.stamps[idx] === env.stamp) continue;
        env.stamps[idx] = env.stamp;
        q.push(env.colliders[idx]);
      }
    }
  }
  return q;
}

function blocks(c, phased) {
  if (!c.alive) return false;
  if (c.kind === ColliderKind.PHASE && phased) return false;
  return true;
}

/** True when the player box at (x, y, z) overlaps any blocking collider. */
export function boxBlocked(env, x, y, z, phased) {
  const hw = PLAYER.HALF_WIDTH;
  const q = queryColliders(env, x - hw, x + hw, z - hw, z + hw);
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (!blocks(c, phased)) continue;
    if (x - hw < c.maxX && x + hw > c.minX && y < c.maxY && y + PLAYER.HEIGHT > c.minY &&
      z - hw < c.maxZ && z + hw > c.minZ) return true;
  }
  return false;
}

/**
 * Raycast against arena colliders.
 * @returns {{t:number, collider:object|null}} reused result object; t < 0 when nothing was hit.
 */
const _rayResult = { t: -1, collider: null };
export function raycastArena(env, ox, oy, oz, dx, dy, dz, maxT, phased = false, forGrapple = false) {
  _rayResult.t = -1;
  _rayResult.collider = null;
  let best = maxT;
  const cols = env.colliders;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!blocks(c, phased)) continue;
    if (forGrapple && c.noGrapple) continue;
    const t = rayAABB(ox, oy, oz, dx, dy, dz, c, best);
    if (t >= 0 && t < best) {
      best = t;
      _rayResult.t = t;
      _rayResult.collider = c;
    }
  }
  return _rayResult;
}

/* ------------------------------------------------------------------------ */
/* Collision response                                                        */
/* ------------------------------------------------------------------------ */

const _contact = { floor: false, ceil: false, wall: false, wnx: 0, wnz: 0, stepped: false };

/**
 * Move the player box along one axis and resolve penetration.
 *
 * Collision response math: the player is an axis-aligned box. Moving one axis
 * at a time ("axis-separated sweep") means any overlap after the move can only
 * have been caused by that axis, so the box is pushed back to the touching
 * face along the same axis. This is robust for boxes and never tunnels as long
 * as each sub-step moves less than the thinnest collider (guaranteed by the
 * sub-stepping in `moveAndCollide`: max 0.35 m per sub-step, colliders >= 0.5 m).
 *
 * Step-up / ledge forgiveness: when a horizontal move hits a box whose top is
 * only slightly above the feet, and the space above it is free, the player is
 * lifted onto it instead of being stopped. Grounded players climb STEP_HEIGHT;
 * airborne players moving into a ledge get the larger LEDGE_MANTLE_HEIGHT so
 * near-miss jumps onto platforms still succeed.
 */
function sweepAxis(s, env, axis, delta, phased, stepLimit) {
  if (delta === 0) return;
  const hw = PLAYER.HALF_WIDTH;
  if (axis === 0) s.x += delta; else if (axis === 1) s.y += delta; else s.z += delta;
  const q = queryColliders(env, s.x - hw, s.x + hw, s.z - hw, s.z + hw);
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (!blocks(c, phased)) continue;
    if (!(s.x - hw < c.maxX && s.x + hw > c.minX && s.y < c.maxY && s.y + PLAYER.HEIGHT > c.minY &&
      s.z - hw < c.maxZ && s.z + hw > c.minZ)) continue;

    if (axis === 1) {
      if (delta < 0) { s.y = c.maxY; _contact.floor = true; }
      else { s.y = c.minY - PLAYER.HEIGHT; _contact.ceil = true; }
      continue;
    }
    const rise = c.maxY - s.y;
    if (rise > 0 && rise <= stepLimit && !boxBlocked(env, s.x, c.maxY + 0.001, s.z, phased)) {
      s.y = c.maxY + 0.001;
      _contact.stepped = true;
      continue;
    }
    if (axis === 0) {
      if (delta > 0) { s.x = c.minX - hw - 1e-4; _contact.wnx = -1; }
      else { s.x = c.maxX + hw + 1e-4; _contact.wnx = 1; }
      _contact.wnz = 0;
    } else {
      if (delta > 0) { s.z = c.minZ - hw - 1e-4; _contact.wnz = -1; }
      else { s.z = c.maxZ + hw + 1e-4; _contact.wnz = 1; }
      _contact.wnx = 0;
    }
    _contact.wall = true;
  }
}

function moveAndCollide(s, env, dx, dy, dz, phased, stepLimit) {
  _contact.floor = false; _contact.ceil = false; _contact.wall = false; _contact.stepped = false;
  const maxD = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const n = Math.min(8, Math.max(1, Math.ceil(maxD / 0.35)));
  const sx = dx / n, sy = dy / n, sz = dz / n;
  for (let i = 0; i < n; i++) {
    sweepAxis(s, env, 0, sx, phased, stepLimit);
    sweepAxis(s, env, 2, sz, phased, stepLimit);
    sweepAxis(s, env, 1, sy, phased, 0);
  }
  return _contact;
}

/* ------------------------------------------------------------------------ */
/* Main step                                                                 */
/* ------------------------------------------------------------------------ */

function accelerate(s, wx, wz, wishSpeed, accel, dt) {
  // Only the velocity component along the wish direction is limited, so
  // existing momentum in other directions is preserved (air control).
  const current = s.vx * wx + s.vz * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const a = Math.min(accel * dt, add);
  s.vx += wx * a;
  s.vz += wz * a;
}

function applyFriction(s, friction, dt) {
  const speed = Math.hypot(s.vx, s.vz);
  if (speed < 1e-4) { s.vx = 0; s.vz = 0; return; }
  const drop = Math.max(speed, 4) * friction * dt;
  const ns = Math.max(0, speed - drop) / speed;
  s.vx *= ns;
  s.vz *= ns;
}

function clampVelocity(s) {
  const h = Math.hypot(s.vx, s.vz);
  if (h > PLAYER.MAX_HORIZONTAL_SPEED) {
    const k = PLAYER.MAX_HORIZONTAL_SPEED / h;
    s.vx *= k; s.vz *= k;
  }
  s.vy = clamp(s.vy, -PLAYER.MAX_VERTICAL_SPEED, PLAYER.MAX_VERTICAL_SPEED);
}

function releaseGrapple(s) {
  if (!s.grappling) return;
  s.grappling = 0;
  s.grappleCooldown = PLAYER.GRAPPLE_COOLDOWN;
  s.events |= MoveEvent.GRAPPLE_RELEASE;
}

const _dv = { x: 0, y: 0, z: 0 };

/**
 * Advance one player by one fixed step.
 *
 * @param {object} s movement state (mutated)
 * @param {{mx:number,mz:number,yaw:number,pitch:number,buttons:number}} inp validated input
 * @param {object} env collision environment from createCollisionEnv
 * @param {number} dt fixed timestep (SIM.DT)
 * @returns {number} event flags (also stored in s.events)
 */
export function stepMovement(s, inp, env, dt) {
  s.events = 0;
  s.ringIndex = -1;
  if (s.dead) {
    s.state = MoveState.DEAD;
    s.vx = s.vy = s.vz = 0;
    return 0;
  }
  const b = inp.buttons | 0;
  s.yaw = inp.yaw;
  s.pitch = clamp(inp.pitch, -1.55, 1.55);

  // ---- timers -------------------------------------------------------------
  s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  s.dashCooldown = Math.max(0, s.dashCooldown - dt);
  s.dashTimer = Math.max(0, s.dashTimer - dt);
  s.wallJumpCooldown = Math.max(0, s.wallJumpCooldown - dt);
  s.grappleCooldown = Math.max(0, s.grappleCooldown - dt);
  s.phaseTimer = Math.max(0, s.phaseTimer - dt);
  s.stunTimer = Math.max(0, s.stunTimer - dt);
  s.ringCooldown = Math.max(0, s.ringCooldown - dt);
  s.boostTimer = Math.max(0, s.boostTimer - dt);
  s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);
  s.wallTimer = Math.min(9, s.wallTimer + dt);
  if (!s.onGround) s.airTime = Math.min(9, s.airTime + dt);
  if (b & BTN.JUMP_P) s.jumpBuffer = PLAYER.JUMP_BUFFER;

  // ---- Quantum Pulse: Phase Break ----------------------------------------
  // `pulseReady` is granted by the server when Pulse Charge reaches 100; the
  // client only predicts the activation. The server consumes the charge.
  if ((b & BTN.PULSE_P) && s.pulseReady && s.phaseTimer <= 0) {
    s.phaseTimer = PULSE.PHASE_DURATION;
    s.pulseReady = 0;
    s.events |= MoveEvent.PHASE_START;
  }
  const phased = s.phaseTimer > 0;
  const stunned = s.stunTimer > 0;

  // ---- wish direction (camera-relative, flattened) ------------------------
  const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
  const mx = stunned ? 0 : clamp(inp.mx, -1, 1);
  const mz = stunned ? 0 : clamp(inp.mz, -1, 1);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  let wx = cosY * mx - sinY * mz;
  let wz = -sinY * mx - cosY * mz;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const hasWish = wl > 0.01;
  const speedScale = (phased ? PULSE.PHASE_SPEED_SCALE : 1) * clamp(s.speedMult, 0.5, 1.3);

  // ---- grapple: attach / release ------------------------------------------
  if ((b & BTN.GRAPPLE_P) && !stunned) {
    if (s.grappling) {
      releaseGrapple(s);
    } else if (s.grappleCooldown <= 0) {
      const cp = Math.cos(s.pitch);
      const dx = -sinY * cp, dy = Math.sin(s.pitch), dz = -cosY * cp;
      const ex = s.x, ey = s.y + PLAYER.EYE_HEIGHT, ez = s.z;
      let range = PLAYER.GRAPPLE_RANGE;
      let anchorRing = -1;
      // Quantum rings are valid anchors.
      for (let i = 0; i < env.rings.length; i++) {
        const r = env.rings[i];
        const t = raySphere(ex, ey, ez, dx, dy, dz, r.x, r.y, r.z, r.r, range);
        if (t >= 0) { range = t; anchorRing = i; }
      }
      const hit = raycastArena(env, ex, ey, ez, dx, dy, dz, range, phased, true);
      if (hit.t >= 0 || anchorRing >= 0) {
        if (hit.t >= 0) {
          s.gx = ex + dx * hit.t; s.gy = ey + dy * hit.t; s.gz = ez + dz * hit.t;
        } else {
          const r = env.rings[anchorRing];
          s.gx = r.x; s.gy = r.y; s.gz = r.z;
        }
        s.grappling = 1;
        s.grappleTime = 0;
        s.glen = Math.max(PLAYER.GRAPPLE_MIN_LENGTH, Math.hypot(s.gx - ex, s.gy - ey, s.gz - ez));
        s.slideTimer = 0;
        s.events |= MoveEvent.GRAPPLE_ATTACH;
      } else {
        s.grappleCooldown = 0.2;
        s.events |= MoveEvent.GRAPPLE_FAIL;
      }
    }
  }
  if (s.grappling) {
    s.grappleTime += dt;
    if (s.grappleTime > PLAYER.GRAPPLE_MAX_TIME || stunned) releaseGrapple(s);
  }

  // ---- jumping, wall jumps, grapple launch --------------------------------
  const canGroundJump = s.onGround || s.airTime < PLAYER.COYOTE_TIME;
  if (s.jumpBuffer > 0 && !stunned) {
    if (s.grappling) {
      // Grapple launch: keep momentum, scale it slightly and add lift.
      s.vx *= PLAYER.GRAPPLE_LAUNCH_SCALE;
      s.vz *= PLAYER.GRAPPLE_LAUNCH_SCALE;
      s.vy = Math.max(s.vy, 0) + PLAYER.GRAPPLE_LAUNCH_UP;
      releaseGrapple(s);
      s.boostTimer = 1.0;
      s.jumpBuffer = 0;
      s.events |= MoveEvent.GRAPPLE_LAUNCH;
    } else if (canGroundJump) {
      if (s.slideTimer > 0) {
        s.vx *= PLAYER.SLIDE_JUMP_SCALE;
        s.vz *= PLAYER.SLIDE_JUMP_SCALE;
        s.slideTimer = 0;
        s.slideCooldown = PLAYER.SLIDE_COOLDOWN;
      }
      s.vy = PLAYER.JUMP_VELOCITY;
      s.onGround = 0;
      s.airTime = PLAYER.COYOTE_TIME + 1; // consume coyote time
      s.jumpBuffer = 0;
      s.events |= MoveEvent.JUMP;
    } else if (s.wallTimer < 0.15 && s.wallJumpCooldown <= 0) {
      // Wall jump: push away from the wall normal, keep tangential speed.
      const into = s.vx * s.wallNx + s.vz * s.wallNz;
      if (into < 0) { s.vx -= s.wallNx * into; s.vz -= s.wallNz * into; }
      s.vx += s.wallNx * PLAYER.WALL_JUMP_PUSH;
      s.vz += s.wallNz * PLAYER.WALL_JUMP_PUSH;
      s.vy = PLAYER.WALL_JUMP_UP;
      s.wallJumpCooldown = PLAYER.WALL_JUMP_COOLDOWN;
      s.wallRunTime = PLAYER.WALLRUN_MAX_TIME; // no wall-run straight after a wall jump
      s.dashCharges = PLAYER.DASH_CHARGES; // reward chaining
      s.jumpBuffer = 0;
      s.events |= MoveEvent.WALLJUMP;
    }
  }

  // ---- air dash ------------------------------------------------------------
  if ((b & BTN.DASH_P) && !s.onGround && !stunned && s.dashCharges > 0 && s.dashCooldown <= 0 && !s.grappling) {
    let dxd = wx, dzd = wz;
    if (!hasWish) { dxd = -sinY; dzd = -cosY; }
    const dl = Math.hypot(dxd, dzd) || 1;
    dxd /= dl; dzd /= dl;
    const along = s.vx * dxd + s.vz * dzd;
    const target = Math.max(along, PLAYER.DASH_SPEED * speedScale);
    s.vx = dxd * target;
    s.vz = dzd * target;
    s.vy = Math.max(s.vy, 0.5);
    s.dashTimer = PLAYER.DASH_TIME;
    s.dashCooldown = PLAYER.DASH_COOLDOWN;
    s.dashCharges -= 1;
    s.events |= MoveEvent.DASH;
  }

  // ---- slide -----------------------------------------------------------------
  const hSpeed = Math.hypot(s.vx, s.vz);
  const slideHeld = (b & BTN.SLIDE) !== 0;
  if (s.onGround && s.slideTimer <= 0 && s.slideCooldown <= 0 && !stunned &&
    (b & BTN.SLIDE_P) && hSpeed >= PLAYER.SLIDE_MIN_SPEED) {
    const inv = 1 / hSpeed;
    s.vx += s.vx * inv * PLAYER.SLIDE_BOOST;
    s.vz += s.vz * inv * PLAYER.SLIDE_BOOST;
    s.slideTimer = PLAYER.SLIDE_DURATION;
    s.events |= MoveEvent.SLIDE;
  } else if (s.slideTimer > 0) {
    s.slideTimer = Math.max(0, s.slideTimer - dt);
    // Slides end when the timer runs out, when the player lets go of the key
    // (after a short minimum), or when they have bled off most of their speed.
    const releasedEarly = !slideHeld && s.slideTimer < PLAYER.SLIDE_DURATION - 0.15;
    if (s.slideTimer <= 0 || releasedEarly || hSpeed < 3) {
      s.slideTimer = 0;
      s.slideCooldown = PLAYER.SLIDE_COOLDOWN;
    }
  }

  // ---- horizontal acceleration ---------------------------------------------
  const sprinting = (b & BTN.SPRINT) !== 0 && mz > 0;
  if (s.onGround && s.dashTimer <= 0) {
    if (s.slideTimer > 0) {
      applyFriction(s, PLAYER.SLIDE_FRICTION, dt);
      if (hasWish) accelerate(s, wx, wz, 2.5, 10, dt);
    } else {
      applyFriction(s, PLAYER.GROUND_FRICTION, dt);
      if (hasWish) {
        const wishSpeed = (sprinting ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED) * speedScale;
        accelerate(s, wx, wz, wishSpeed, PLAYER.GROUND_ACCEL * wishSpeed, dt);
      }
    }
  } else if (hasWish && s.dashTimer <= 0) {
    accelerate(s, wx, wz, PLAYER.AIR_SPEED * speedScale, PLAYER.AIR_ACCEL, dt);
  }

  // ---- wall-run --------------------------------------------------------------
  let wallRunning = false;
  if (!s.onGround && !s.grappling && s.wallTimer < 0.1 && mz > 0 &&
    s.wallRunTime < PLAYER.WALLRUN_MAX_TIME && Math.hypot(s.vx, s.vz) >= PLAYER.WALLRUN_MIN_SPEED) {
    wallRunning = true;
    s.wallRunTime += dt;
    if (s.vy < 0) s.vy *= 0.88;
    // Press gently into the wall (2 m/s²) so contact is re-detected every tick.
    s.vx -= s.wallNx * 2 * dt;
    s.vz -= s.wallNz * 2 * dt;
  }

  // ---- gravity ---------------------------------------------------------------
  if (s.dashTimer <= 0) {
    const g = PLAYER.GRAVITY * (wallRunning ? PLAYER.WALLRUN_GRAVITY_SCALE : 1);
    s.vy -= g * dt;
  }

  // ---- gravity fractures (see shared/gravity.js for the formula) -------------
  if (env.fractureCount > 0) {
    accumulateFractureDeltaV(env.fractures, env.fractureCount, s.x, s.y + PLAYER.HEIGHT * 0.5, s.z, 1, dt, _dv);
    s.vx += _dv.x; s.vy += _dv.y; s.vz += _dv.z;
  }

  // ---- grapple rope (reel + swing constraint) --------------------------------
  if (s.grappling) {
    const px = s.x, py = s.y + PLAYER.EYE_HEIGHT, pz = s.z;
    let rx = s.gx - px, ry = s.gy - py, rz = s.gz - pz;
    const d = Math.hypot(rx, ry, rz) || 1e-4;
    rx /= d; ry /= d; rz /= d; // unit vector player -> anchor
    if (b & BTN.GRAPPLE) {
      // Reeling: shorten the rope and pull toward the anchor.
      s.glen = Math.max(PLAYER.GRAPPLE_MIN_LENGTH, s.glen - PLAYER.GRAPPLE_REEL_SPEED * dt);
      s.vx += rx * PLAYER.GRAPPLE_PULL_ACCEL * dt;
      s.vy += ry * PLAYER.GRAPPLE_PULL_ACCEL * dt;
      s.vz += rz * PLAYER.GRAPPLE_PULL_ACCEL * dt;
    }
    // Swing constraint (pendulum): when the rope is taut, the velocity
    // component pointing away from the anchor is removed, which converts the
    // player's momentum into tangential swing. If the player is already past
    // the rope length (e.g. it was just reeled in), require a minimum inward
    // speed proportional to the overshoot so the error decays at ~10/s.
    // Limit: the correction never exceeds 10 m/s, so a bad anchor cannot fling
    // the player.
    if (d >= s.glen) {
      const radial = s.vx * rx + s.vy * ry + s.vz * rz; // positive = toward anchor
      const minRadial = Math.min((d - s.glen) * 10, 10);
      if (radial < minRadial) {
        const k = minRadial - radial;
        s.vx += rx * k; s.vy += ry * k; s.vz += rz * k;
      }
    }
  }

  clampVelocity(s);

  // ---- integrate + collide -----------------------------------------------------
  const wasGround = s.onGround;
  const preVy = s.vy;
  const stepLimit = s.onGround ? PLAYER.STEP_HEIGHT : (s.vy < 6 && hasWish ? PLAYER.LEDGE_MANTLE_HEIGHT : 0);
  const contact = moveAndCollide(s, env, s.vx * dt, s.vy * dt, s.vz * dt, phased, stepLimit);

  if (contact.floor) {
    s.onGround = 1;
    if (s.vy < 0) s.vy = 0;
  } else {
    s.onGround = 0;
  }
  if (contact.ceil && s.vy > 0) s.vy = 0;
  if (contact.stepped && !wasGround && s.vy < 0) s.vy = 0; // mantle: stop falling
  if (contact.wall) {
    s.wallNx = contact.wnx;
    s.wallNz = contact.wnz;
    s.wallTimer = 0;
    // remove velocity into the wall
    const into = s.vx * s.wallNx + s.vz * s.wallNz;
    if (into < 0) { s.vx -= s.wallNx * into; s.vz -= s.wallNz * into; }
  }

  if (s.onGround) {
    if (!wasGround) {
      s.events |= MoveEvent.LAND;
      s.landSpeed = -preVy;
      if (-preVy >= PLAYER.SHOCKWAVE_MIN_FALL_SPEED) s.events |= MoveEvent.HARD_LAND;
      // Holding slide while landing with speed starts a slide (slide-hop chains).
      if (slideHeld && s.slideCooldown <= 0 && Math.hypot(s.vx, s.vz) >= PLAYER.SLIDE_MIN_SPEED) {
        s.slideTimer = PLAYER.SLIDE_DURATION * 0.8;
        s.events |= MoveEvent.SLIDE;
      }
    }
    s.airTime = 0;
    s.dashCharges = PLAYER.DASH_CHARGES;
    s.wallRunTime = 0;
  }

  // ---- launch pads -------------------------------------------------------------
  if (s.onGround) {
    const pads = env.pads;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const dx = s.x - p.x, dz = s.z - p.z;
      if (dx * dx + dz * dz <= p.r * p.r && Math.abs(s.y - p.y) < 0.35) {
        let tx = p.tx - p.x, tz = p.tz - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        s.vx = tx * p.push;
        s.vz = tz * p.push;
        s.vy = p.vy;
        s.onGround = 0;
        s.airTime = PLAYER.COYOTE_TIME + 1;
        s.slideTimer = 0;
        s.events |= MoveEvent.PAD;
        break;
      }
    }
  }

  // ---- quantum rings -------------------------------------------------------------
  if (s.ringCooldown <= 0) {
    const cy = s.y + PLAYER.HEIGHT * 0.5;
    for (let i = 0; i < env.rings.length; i++) {
      const r = env.rings[i];
      const dx = s.x - r.x, dy = cy - r.y, dz = s.z - r.z;
      const rr = r.r + 0.6;
      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        s.ringCooldown = 1.2;
        s.ringIndex = i;
        // small capped speed boost for flowing through a ring
        s.vx *= 1.12; s.vz *= 1.12;
        s.boostTimer = Math.max(s.boostTimer, 0.6);
        clampVelocity(s);
        s.events |= MoveEvent.RING;
        break;
      }
    }
  }

  if (s.y < env.killY) s.events |= MoveEvent.FELL_OUT;

  // ---- movement state machine label ----------------------------------------------
  let st;
  if (stunned) st = MoveState.STUNNED;
  else if (s.grappling) st = MoveState.GRAPPLING;
  else if (s.dashTimer > 0) st = MoveState.DASHING;
  else if (s.slideTimer > 0) st = MoveState.SLIDING;
  else if (wallRunning) st = MoveState.WALLRUN;
  else if (s.onGround) st = MoveState.GROUNDED;
  else if (s.vy > 0) st = MoveState.JUMPING;
  else st = MoveState.FALLING;
  if (phased && (st === MoveState.GROUNDED || st === MoveState.JUMPING || st === MoveState.FALLING)) st = MoveState.PHASED;
  s.state = st;
  return s.events;
}

/** Eye position helper. */
export function eyeY(s) {
  return s.y + (s.slideTimer > 0 ? PLAYER.SLIDE_EYE_HEIGHT : PLAYER.EYE_HEIGHT);
}
