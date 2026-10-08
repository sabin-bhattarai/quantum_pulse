/**
 * Quantum Pulse — enemies.
 *
 * Architecture: every enemy runs a finite-state machine (AIState). A shared
 * per-tick pipeline handles timers, stun, target selection, line-of-sight and
 * physics; a per-type behaviour function decides state transitions and steering.
 * Enemies live in a fixed-size pool (no allocation while playing) and are
 * simulated only by the authoritative world — clients render snapshots.
 * @module server/Enemy
 */
import { LIMITS, TEAM, PLAYER, BTN, ROGUE, rogueName } from '../shared/constants.js';
import { clamp, pointSegmentDistSq, wrapAngle } from '../shared/math.js';
import { raycastArena, queryColliders, createMoveState, stepMovement, MoveEvent } from '../shared/movement.js';
import { accumulateFractureDeltaV, FractureMode } from '../shared/gravity.js';
import { EV, PK } from '../shared/protocol.js';
import { HISTORY_TICKS } from './Player.js';

export const EnemyType = Object.freeze({
  SWARM: 0, WARDEN: 1, STALKER: 2, CASTER: 3, RUNNER: 4, MIRROR: 5, TITAN: 6, DUMMY: 7, ROGUE: 8,
});

export const AIState = Object.freeze({
  IDLE: 0, PATROL: 1, SEARCH: 2, CHASE: 3, ATTACK: 4, EVADE: 5, SUPPORT: 6, STUNNED: 7, RETREAT: 8, DEAD: 9,
});
export const AI_STATE_NAMES = ['Idle', 'Patrol', 'Search', 'Chase', 'Attack', 'Evade', 'Support', 'Stunned', 'Retreat', 'Dead'];

/** Telegraph kinds carried by EV.TELEGRAPH so clients can draw readable warnings. */
export const Telegraph = Object.freeze({
  FLASH: 0, GROUND_RING: 1, LINE: 2, FRACTURE: 3, ARENA_PULSE: 4, BEAM: 5, SHIELD: 6, PORTAL: 7,
});

/**
 * Enemy archetypes. `weak` describes a weak-point sphere relative to the body
 * centre (y offset, optional forward offset along the facing direction).
 */
export const ENEMY_DEFS = Object.freeze([
  { type: 0, name: 'Drift Swarm', hp: 28, radius: 0.55, speed: 12.5, accel: 30, mass: 0.6, light: true, score: 40, pulse: 3, hover: 1.6, damage: 6, weak: null, cost: 1 },
  { type: 1, name: 'Anchor Warden', hp: 420, radius: 1.5, speed: 3.2, accel: 6, mass: 5, heavy: true, score: 300, pulse: 12, hover: 2.4, damage: 20, weak: { y: 1.45, r: 0.6, f: 0 }, cost: 8, objective: true },
  { type: 2, name: 'Phase Stalker', hp: 95, radius: 0.75, speed: 11, accel: 26, mass: 1, score: 150, pulse: 8, hover: 0.9, damage: 24, weak: { y: 0.55, r: 0.32, f: 0 }, cost: 4 },
  { type: 3, name: 'Rift Caster', hp: 140, radius: 0.85, speed: 6.5, accel: 14, mass: 1.4, score: 200, pulse: 9, hover: 5, damage: 10, weak: { y: 0.7, r: 0.35, f: 0 }, cost: 5 },
  { type: 4, name: 'Shard Runner', hp: 85, radius: 0.75, speed: 8.5, accel: 22, mass: 0.9, light: true, score: 120, pulse: 6, hover: 0.9, damage: 22, weak: { y: 0.45, r: 0.3, f: 0 }, cost: 3, objective: true },
  { type: 5, name: 'Mirror Drone', hp: 150, radius: 0.8, speed: 14, accel: 28, mass: 1.2, score: 220, pulse: 9, hover: 2.5, damage: 9, weak: { y: 0, r: 0.38, f: 0.6 }, cost: 5 },
  { type: 6, name: 'Singularity Titan', hp: 3600, radius: 3.4, speed: 3, accel: 4, mass: 20, heavy: true, boss: true, score: 5000, pulse: 30, hover: 9, damage: 14, weak: { y: 0, r: 1.25, f: 3.1 }, cost: 40 },
  { type: 7, name: 'Target Dummy', hp: 600, radius: 0.75, speed: 0, accel: 0, mass: 99, heavy: true, score: 0, pulse: 2, hover: 1.0, damage: 0, weak: { y: 0.95, r: 0.32, f: 0 }, cost: 0 },
  // Humanoid bot: moves with the player movement model; the weak point is the head.
  { type: 8, name: 'Rogue Runner', hp: 70, radius: 0.62, speed: 0, accel: 0, mass: 1, light: true, humanoid: true, score: 150, pulse: 6, hover: ROGUE.CENTER, damage: 5, weak: { y: 0.78, r: 0.27, f: 0 }, cost: 3 },
]);

/* Boids tuning (Drift Swarm). See updateSwarm for the explanation. */
const BOIDS = Object.freeze({
  NEIGHBOR_RADIUS: 5,
  SEPARATION_RADIUS: 1.8,
  W_SEPARATION: 16,
  W_ALIGNMENT: 1.1,
  W_COHESION: 0.7,
  W_TARGET: 2.6,
  W_AVOID: 34,
  MAX_ACCEL: 34,
});

const MIRROR_DELAY_TICKS = 45; // 0.75 s
const MIRROR_BUFFER = 64;
const MAX_ENEMY_SPEED = 40;

export class Enemy {
  constructor(poolIndex) {
    this.poolIndex = poolIndex;
    this.active = false;
    this.isEnemy = true;
    this.team = TEAM.ENEMIES;
    this.history = new Float32Array(HISTORY_TICKS * 3);
    this.historyTicks = new Int32Array(HISTORY_TICKS).fill(-1);
    this.mirrorBuf = new Float32Array(MIRROR_BUFFER * 6); // vx,vy,vz,x,y,z of the target
    this.reset(0, EnemyType.SWARM, 0, 0, 0, {});
    this.active = false;
  }

  reset(id, type, x, y, z, opts) {
    const def = ENEMY_DEFS[type];
    this.id = id;
    this.type = type;
    this.def = def;
    this.active = true;
    this.elite = !!opts.elite;
    const hpScale = (opts.hpScale || 1) * (this.elite ? 2.2 : 1);
    this.maxHp = def.hp * hpScale;
    this.hp = this.maxHp;
    this.damageScale = (opts.damageScale || 1) * (this.elite ? 1.35 : 1);
    this.radius = def.radius * (this.elite ? 1.25 : 1);
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.homeX = x; this.homeY = y; this.homeZ = z;
    this.yaw = 0;
    this.state = AIState.IDLE;
    this.stateTime = 0;
    this.stunTimer = 0;
    this.attackCooldown = 1 + (id % 7) * 0.15;
    this.abilityCooldown = 3 + (id % 5) * 0.4;
    this.supportCooldown = 6;
    this.summonCooldown = 10;
    this.target = null;
    this.targetTimer = 0;
    this.hasLOS = false;
    this.losTimer = (id % 10) * 0.03;
    this.lostTime = 0;
    this.lastKnownX = x; this.lastKnownY = y; this.lastKnownZ = z;
    this.avoidX = 0; this.avoidY = 0; this.avoidZ = 0;
    this.cloaked = false;
    this.telegraph = false;
    this.shield = 0;
    this.charging = false;
    this.chargeDirX = 0; this.chargeDirZ = 0;
    this.windupDamage = 0;
    this.trailTimer = 0;
    this.hitThisCharge = false;
    this.lastHitBy = null;
    this.lastHitTime = -100;
    this.inFractureTime = 0;
    this.mirrorHead = 0;
    this.mirrorCount = 0;
    this.summoned = 0;
    this.lastDamageTime = -100;
    this.stuckTime = 0;
    // Titan
    this.phase = 1;
    this.attack = 0;
    this.attackTimer = 0;
    this.attackStage = 0;
    this.beamAngle = 0;
    this.beamY = 0;
    this.beamSweep = 0;
    this.slamX = 0; this.slamY = 0; this.slamZ = 0;
    this.weakOpenTimer = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.historyTicks.fill(-1);
    this.dummyMoving = !!opts.moving;
    this.spawnTime = 0;
    // Rogue Runner (set up by EnemySystem.spawn)
    this.move = null;
    this.name = '';
    this.engaged = false;
    this.hunting = false;
    this.canShoot = false;
    this.reaction = 0;
    this.idleTime = 0;
    this.searchTime = 0;
    this.strafeDir = id % 2 ? 1 : -1;
    this.strafeTimer = 0;
    this.hopTimer = 2 + (id % 5) * 0.6;
    this.wanderX = x; this.wanderZ = z;
    this.wanderTimer = 0;
    this.safeX = x; this.safeY = y; this.safeZ = z;
    this.wantMove = false;
    this.blocked = false;
  }

  get targetable() {
    return this.active && this.state !== AIState.DEAD && !this.cloaked;
  }

  /** Lightweight enemies are staggered; heavy ones ignore stun. */
  stun(seconds) {
    if (this.def.heavy || this.state === AIState.DEAD) return;
    this.stunTimer = Math.max(this.stunTimer, seconds);
    this.charging = false;
    this.telegraph = false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  recordHistory(tick) {
    const i = tick % HISTORY_TICKS;
    this.history[i * 3] = this.x;
    this.history[i * 3 + 1] = this.y;
    this.history[i * 3 + 2] = this.z;
    this.historyTicks[i] = tick;
  }

  positionAt(tick, out) {
    const i = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    if (this.historyTicks[i] === tick) {
      out.x = this.history[i * 3]; out.y = this.history[i * 3 + 1]; out.z = this.history[i * 3 + 2];
    } else {
      out.x = this.x; out.y = this.y; out.z = this.z;
    }
    return out;
  }

  /** Weak point world position for a body centre (bx, by, bz); returns false if none. */
  weakPoint(bx, by, bz, out) {
    const w = this.def.weak;
    if (!w) return false;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const s = this.elite ? 1.25 : 1;
    out.x = bx + fx * w.f * s;
    out.y = by + w.y * s;
    out.z = bz + fz * w.f * s;
    out.r = w.r * s;
    return true;
  }
}

const _nb = [];
const _dv = { x: 0, y: 0, z: 0 };
const _cp = { x: 0, y: 0, z: 0 };

export class EnemySystem {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.pool = [];
    for (let i = 0; i < LIMITS.MAX_ENEMIES; i++) this.pool.push(new Enemy(i));
    /** @type {Enemy[]} active enemies (compacted every tick) */
    this.active = [];
    this.free = [];
    for (let i = LIMITS.MAX_ENEMIES - 1; i >= 0; i--) this.free.push(i);
  }

  get count() { return this.active.length; }

  countType(type) {
    let n = 0;
    for (const e of this.active) if (e.type === type) n++;
    return n;
  }

  /** Spawn from the pool. Returns null when the pool is exhausted. */
  spawn(type, x, y, z, opts = {}) {
    if (!this.free.length) return null;
    const e = this.pool[this.free.pop()];
    e.reset(this.world.nextId(), type, x, y, z, opts);
    e.spawnTime = this.world.time;
    if (type === EnemyType.ROGUE) {
      // (x, y, z) are the feet; e.y is the hit-sphere centre
      e.move = createMoveState(x, y, z, opts.yaw || 0);
      e.yaw = opts.yaw || 0;
      e.y = y + ROGUE.CENTER;
      e.homeY = y;
      e.name = rogueName(e.id);
      e.botInput = e.botInput || { mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
    }
    this.active.push(e);
    if (e.def.boss) this.world.emit(EV.BOSS, e.id, 1);
    return e;
  }

  release(e) {
    e.active = false;
    e.state = AIState.DEAD;
    this.free.push(e.poolIndex);
  }

  clear() {
    for (const e of this.active) this.release(e);
    this.active.length = 0;
  }

  /** Main per-tick update. */
  update(dt) {
    const w = this.world;
    // Rebuild the spatial hash with live enemies (see SpatialHash.js).
    w.spatial.clear();
    for (const e of this.active) if (e.active) w.spatial.insert(e);
    this.assignFireTokens();

    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active) continue;
      this.updateOne(e, dt);
    }
    // Compact the active list (released enemies drop out).
    let j = 0;
    for (let i = 0; i < this.active.length; i++) if (this.active[i].active) this.active[j++] = this.active[i];
    this.active.length = j;
    for (const e of this.active) e.recordHistory(w.tick);
  }

  updateOne(e, dt) {
    const w = this.world;
    e.stateTime += dt;
    e.attackCooldown -= dt;
    e.abilityCooldown -= dt;
    e.supportCooldown -= dt;
    e.summonCooldown -= dt;
    e.weakOpenTimer = Math.max(0, e.weakOpenTimer - dt);

    if (e.type === EnemyType.DUMMY) { this.updateDummy(e, dt); return; }

    // ---- targeting (re-evaluated a few times per second) ----
    e.targetTimer -= dt;
    if (e.targetTimer <= 0 || !this.validTarget(e.target)) {
      e.target = this.chooseTarget(e);
      e.targetTimer = 0.5;
    }
    // ---- line of sight (staggered) ----
    e.losTimer -= dt;
    if (e.losTimer <= 0 && e.target) {
      e.losTimer = 0.25;
      const t = e.target;
      const ty = t.isReactor ? t.y : t.y + 1.2;
      const dx = t.x - e.x, dy = ty - e.y, dz = t.z - e.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const hit = raycastArena(w.env, e.x, e.y, e.z, dx / d, dy / d, dz / d, d, false, false);
      e.hasLOS = hit.t < 0 || !!t.isReactor;
    }
    if (e.target && e.hasLOS) {
      e.lastKnownX = e.target.x; e.lastKnownY = e.target.y; e.lastKnownZ = e.target.z;
      e.lostTime = 0;
    } else {
      e.lostTime += dt;
    }
    if (e.move) { this.updateRogue(e, dt); return; }
    // Anti-stall "rift recall": an enemy that stays slow and sightless for a
    // long time is re-emitted from the rift nearest its target, so a wave can
    // never soft-lock on an enemy wedged in geometry.
    if (!e.hasLOS && Math.hypot(e.vx, e.vy, e.vz) < 1.5 && e.type !== EnemyType.TITAN) e.stuckTime = (e.stuckTime || 0) + dt;
    else e.stuckTime = Math.max(0, (e.stuckTime || 0) - dt * 2);
    if (e.stuckTime > 12 && e.target) this.recall(e);

    // ---- stun overrides everything ----
    if (e.stunTimer > 0) {
      e.stunTimer -= dt;
      e.setState(AIState.STUNNED);
      e.vx *= 0.9; e.vz *= 0.9; e.vy = e.vy * 0.9 - 4 * dt;
      this.integrate(e, dt);
      if (e.stunTimer <= 0) e.setState(AIState.CHASE);
      return;
    }

    switch (e.type) {
      case EnemyType.SWARM: this.updateSwarm(e, dt); break;
      case EnemyType.WARDEN: this.updateWarden(e, dt); break;
      case EnemyType.STALKER: this.updateStalker(e, dt); break;
      case EnemyType.CASTER: this.updateCaster(e, dt); break;
      case EnemyType.RUNNER: this.updateRunner(e, dt); break;
      case EnemyType.MIRROR: this.updateMirror(e, dt); break;
      case EnemyType.TITAN: this.updateTitan(e, dt); break;
      default: break;
    }
    this.integrate(e, dt);
  }

  validTarget(t) {
    if (!t) return false;
    if (t.isReactor) return t.hp > 0;
    return t.canAct;
  }

  /**
   * Target selection: nearest acting player. Objective-focused enemies (Warden,
   * Runner) attack the co-op reactor unless a player is close.
   */
  chooseTarget(e) {
    const w = this.world;
    let best = null, bestD = Infinity;
    for (const p of w.activePlayers) {
      if (!p.canAct) continue;
      const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2 + (p.z - e.z) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    const reactor = w.reactor;
    if (reactor && reactor.hp > 0) {
      const dr = (reactor.x - e.x) ** 2 + (reactor.z - e.z) ** 2;
      if (!best || (e.def.objective && bestD > 100) || dr < bestD * 0.5) return reactor;
    }
    return best;
  }

  /** Most isolated player (largest distance to their nearest teammate). Used by the Phase Stalker. */
  isolatedPlayer() {
    const ps = this.world.activePlayers.filter((p) => p.canAct);
    if (ps.length <= 1) return ps[0] || null;
    let best = null, bestScore = -1;
    for (const p of ps) {
      let nearest = Infinity;
      for (const q of ps) if (q !== p) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.z - q.z));
      if (nearest > bestScore) { bestScore = nearest; best = p; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Steering helpers                                                    */
  /* ------------------------------------------------------------------ */

  /** Accelerate toward a desired velocity, limited by the archetype's accel. */
  steer(e, dvx, dvy, dvz, accel, dt) {
    let ax = dvx - e.vx, ay = dvy - e.vy, az = dvz - e.vz;
    const al = Math.hypot(ax, ay, az);
    const max = accel * dt;
    if (al > max) { ax *= max / al; ay *= max / al; az *= max / al; }
    e.vx += ax; e.vy += ay; e.vz += az;
  }

  /** Desired velocity toward (tx, ty, tz) at `speed`, slowing inside `arrive` metres. */
  seek(e, tx, ty, tz, speed, arrive, dt, accel = e.def.accel) {
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) { this.steer(e, 0, 0, 0, accel, dt); return d; }
    const s = arrive > 0 ? speed * Math.min(1, d / arrive) : speed;
    this.steer(e, (dx / d) * s + e.avoidX, (dy / d) * s + e.avoidY, (dz / d) * s + e.avoidZ, accel, dt);
    return d;
  }

  /**
   * Obstacle avoidance: a look-ahead ray along the velocity. When it hits
   * arena geometry, steer upward and away from the surface. Re-evaluated
   * every third tick per enemy (staggered by pool index) to bound cost.
   */
  updateAvoidance(e) {
    if ((this.world.tick + e.poolIndex) % 3 !== 0) return;
    let sp = Math.hypot(e.vx, e.vy, e.vz);
    e.avoidX = e.avoidY = e.avoidZ = 0;
    let dx, dy, dz;
    if (sp >= 1.5) {
      dx = e.vx / sp; dy = e.vy / sp; dz = e.vz / sp;
    } else {
      // Nearly stopped (often: pressed against a wall). Look along the
      // intended direction instead of the velocity so avoidance still fires.
      const tx = (e.target ? e.target.x : e.lastKnownX) - e.x, tz = (e.target ? e.target.z : e.lastKnownZ) - e.z;
      const tl = Math.hypot(tx, tz);
      if (tl < 1) return;
      dx = tx / tl; dy = 0; dz = tz / tl;
      sp = 2;
    }
    const look = e.radius + 1.5 + sp * 0.35;
    const hit = raycastArena(this.world.env, e.x, e.y, e.z, dx, dy, dz, look, false, false);
    if (hit.t >= 0) {
      const c = hit.collider;
      const urgency = 1 - hit.t / look;
      // Prefer climbing over the obstacle when its top is reachable.
      const climb = c.maxY - e.y < 8 ? 1 : 0.2;
      e.avoidY = urgency * 9 * climb;
      // Sideways: perpendicular to the velocity on the horizontal plane.
      const side = ((e.poolIndex & 1) ? 1 : -1) * urgency * 6;
      e.avoidX = -dz * side;
      e.avoidZ = dx * side;
    }
  }

  /** Physics integration + fracture forces + sphere-vs-box collision. */
  integrate(e, dt) {
    const w = this.world;
    if (w.fractureCount > 0) {
      accumulateFractureDeltaV(w.fractures, w.fractureCount, e.x, e.y, e.z, e.def.mass, dt, _dv);
      e.vx += _dv.x; e.vy += _dv.y; e.vz += _dv.z;
      if (_dv.x * _dv.x + _dv.y * _dv.y + _dv.z * _dv.z > 1e-4) e.inFractureTime = w.time;
    }
    const sp = Math.hypot(e.vx, e.vy, e.vz);
    if (sp > MAX_ENEMY_SPEED) {
      const k = MAX_ENEMY_SPEED / sp;
      e.vx *= k; e.vy *= k; e.vz *= k;
    }
    e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;

    // Sphere vs AABB push-out: move the centre out along the vector from the
    // closest point on the box, and remove the velocity component into it.
    const r = e.radius;
    const cols = queryColliders(w.env, e.x - r, e.x + r, e.z - r, e.z + r);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c.alive) continue;
      if (e.y + r < c.minY || e.y - r > c.maxY) continue;
      _cp.x = clamp(e.x, c.minX, c.maxX); _cp.y = clamp(e.y, c.minY, c.maxY); _cp.z = clamp(e.z, c.minZ, c.maxZ);
      let nx = e.x - _cp.x, ny = e.y - _cp.y, nz = e.z - _cp.z;
      const d2 = nx * nx + ny * ny + nz * nz;
      if (d2 >= r * r) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-5) { nx = 0; ny = 1; nz = 0; d = 0; e.y = c.maxY; }
      else { nx /= d; ny /= d; nz /= d; }
      const push = r - d;
      e.x += nx * push; e.y += ny * push; e.z += nz * push;
      const into = e.vx * nx + e.vy * ny + e.vz * nz;
      if (into < 0) { e.vx -= nx * into; e.vy -= ny * into; e.vz -= nz * into; }
      // Side contact: flying enemies climb along the wall instead of pinning against it.
      if (Math.abs(ny) < 0.5 && c.maxY - e.y < 12) e.vy = Math.max(e.vy, 4);
      if (e.charging) this.onChargeImpact(e);
    }

    // Out-of-bounds protection
    const a = w.arena;
    const lim = a.half - 1;
    if (e.x < -lim) { e.x = -lim; e.vx = Math.abs(e.vx); }
    if (e.x > lim) { e.x = lim; e.vx = -Math.abs(e.vx); }
    if (e.z < -lim) { e.z = -lim; e.vz = Math.abs(e.vz); }
    if (e.z > lim) { e.z = lim; e.vz = -Math.abs(e.vz); }
    if (e.y > a.ceiling - 1) { e.y = a.ceiling - 1; e.vy = Math.min(0, e.vy); }
    if (e.y < a.killY + 1) {
      // Fell into the void (e.g. knocked off by a fracture): environmental kill.
      w.killEnemy(e, e.lastHitBy, { environmental: true });
      return;
    }
    if (sp > 0.1) e.yaw = Math.atan2(-e.vx, -e.vz);
  }

  faceTarget(e) {
    if (!e.target) return;
    e.yaw = Math.atan2(-(e.target.x - e.x), -(e.target.z - e.z));
  }

  /** Wander around the home point when there is nothing to fight. */
  patrol(e, dt) {
    e.setState(AIState.PATROL);
    const a = this.world.time * 0.4 + e.poolIndex;
    this.seek(e, e.homeX + Math.cos(a) * 6, e.homeY + 1, e.homeZ + Math.sin(a) * 6, e.def.speed * 0.4, 2, dt);
  }

  /** Move toward the last known target position when LOS was lost. */
  search(e, dt) {
    e.setState(AIState.SEARCH);
    const d = this.seek(e, e.lastKnownX, e.lastKnownY + e.def.hover, e.lastKnownZ, e.def.speed * 0.8, 3, dt);
    // Rift sense: reaching the last known position without regaining sight
    // (or never having seen the target, e.g. spawning behind cover) re-reads
    // the target's current position, so enemies never idle behind walls.
    if (d < 3 && e.target) {
      e.lastKnownX = e.target.x;
      e.lastKnownY = e.target.y;
      e.lastKnownZ = e.target.z;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Drift Swarm — Boids                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Boids steering for the Drift Swarm.
   *
   * SEPARATION pushes each drone away from neighbours closer than
   * SEPARATION_RADIUS, weighted by how deep the intrusion is. Without it the
   * drones collapse into the same point and visually overlap into one blob.
   *
   * ALIGNMENT steers toward the average velocity of neighbours, so nearby
   * drones turn together and the group reads as one coherent stream instead of
   * independent particles.
   *
   * COHESION steers toward the local centre of mass, which keeps the flock
   * together and creates the characteristic "school of fish" motion.
   *
   * TARGET attraction adds a desired-velocity term toward the player or
   * objective, and AVOIDANCE adds the look-ahead obstacle vector.
   *
   * Neighbour lookup uses the spatial hash rebuilt each tick, so each drone
   * inspects only its own cell neighbourhood (~O(n·k) instead of O(n²)).
   *
   * TUNING: separation is weighted strongest (it must win at close range),
   * alignment and cohesion are weak so they shape motion without overpowering
   * the target pull, and the final steering vector is clamped to
   * BOIDS.MAX_ACCEL and speed to def.speed. Raising cohesion above alignment
   * produces oscillating clumps; raising target above separation makes the
   * swarm stack on the player.
   */
  updateSwarm(e, dt) {
    const w = this.world;
    const t = e.target;
    this.updateAvoidance(e);
    if (e.state === AIState.IDLE) {
      if (e.stateTime > 0.5) e.setState(AIState.CHASE);
      this.steer(e, 0, 2, 0, 20, dt);
      return;
    }
    if (!t) { this.patrol(e, dt); return; }

    const tx = t.x, ty = t.isReactor ? t.y : t.y + e.def.hover, tz = t.z;
    const dist = Math.hypot(tx - e.x, ty - e.y, tz - e.z);

    if (e.state === AIState.ATTACK) {
      // Dive: committed straight-line attack (readable, dodgeable).
      if (e.stateTime > 0.65) { e.setState(AIState.EVADE); e.attackCooldown = 2.8 + (e.poolIndex % 5) * 0.25; return; }
      if (this.contact(e, t, e.radius + 0.75)) {
        this.hitTarget(e, t, e.def.damage * e.damageScale, 4);
        e.setState(AIState.EVADE);
        e.attackCooldown = 3.2 + (e.poolIndex % 3) * 0.3;
      }
      return;
    }
    if (e.state === AIState.EVADE) {
      // Peel away upward after an attack.
      this.steer(e, (e.x - tx) * 0.8, 7, (e.z - tz) * 0.8, BOIDS.MAX_ACCEL, dt);
      if (e.stateTime > 0.7) e.setState(AIState.CHASE);
      return;
    }
    if (e.lostTime > 3) { this.search(e, dt); return; }
    e.setState(AIState.CHASE);

    let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, cx = 0, cy = 0, cz = 0, n = 0;
    w.spatial.query(e.x, e.y, e.z, BOIDS.NEIGHBOR_RADIUS, _nb, e);
    for (let i = 0; i < _nb.length; i++) {
      const o = _nb[i];
      if (o.type !== EnemyType.SWARM) continue;
      const dx = e.x - o.x, dy = e.y - o.y, dz = e.z - o.z;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      if (d < BOIDS.SEPARATION_RADIUS) {
        const k = (BOIDS.SEPARATION_RADIUS - d) / (BOIDS.SEPARATION_RADIUS * d);
        sx += dx * k; sy += dy * k; sz += dz * k;
      }
      ax += o.vx; ay += o.vy; az += o.vz;
      cx += o.x; cy += o.y; cz += o.z;
      n++;
    }
    let fx = sx * BOIDS.W_SEPARATION, fy = sy * BOIDS.W_SEPARATION, fz = sz * BOIDS.W_SEPARATION;
    if (n > 0) {
      fx += (ax / n - e.vx) * BOIDS.W_ALIGNMENT + (cx / n - e.x) * BOIDS.W_COHESION;
      fy += (ay / n - e.vy) * BOIDS.W_ALIGNMENT + (cy / n - e.y) * BOIDS.W_COHESION;
      fz += (az / n - e.vz) * BOIDS.W_ALIGNMENT + (cz / n - e.z) * BOIDS.W_COHESION;
    }
    // Target attraction: orbit slightly offset so the swarm surrounds instead of stacking.
    const orbit = (e.poolIndex % 2 ? 1 : -1) * 0.35;
    const odx = (tx - e.x) / (dist || 1), odz = (tz - e.z) / (dist || 1);
    const wantX = (odx - odz * orbit) * e.def.speed, wantY = ((ty - e.y) / (dist || 1)) * e.def.speed, wantZ = (odz + odx * orbit) * e.def.speed;
    fx += (wantX - e.vx) * BOIDS.W_TARGET;
    fy += (wantY - e.vy) * BOIDS.W_TARGET;
    fz += (wantZ - e.vz) * BOIDS.W_TARGET;
    fx += e.avoidX * BOIDS.W_AVOID * 0.1; fy += e.avoidY * BOIDS.W_AVOID * 0.1; fz += e.avoidZ * BOIDS.W_AVOID * 0.1;

    const fl = Math.hypot(fx, fy, fz);
    if (fl > BOIDS.MAX_ACCEL) { const k = BOIDS.MAX_ACCEL / fl; fx *= k; fy *= k; fz *= k; }
    e.vx += fx * dt; e.vy += fy * dt; e.vz += fz * dt;
    const sp = Math.hypot(e.vx, e.vy, e.vz);
    const max = e.def.speed * (this.world.difficulty.speed || 1);
    if (sp > max) { const k = max / sp; e.vx *= k; e.vy *= k; e.vz *= k; }

    if (dist < 7 && e.attackCooldown <= 0 && e.hasLOS) {
      e.setState(AIState.ATTACK);
      const d = dist || 1;
      e.vx = ((tx - e.x) / d) * 19; e.vy = ((ty - 0.8 - e.y) / d) * 19; e.vz = ((tz - e.z) / d) * 19;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Anchor Warden — heavy, creates gravity fractures                    */
  /* ------------------------------------------------------------------ */
  updateWarden(e, dt) {
    const w = this.world;
    const t = e.target;
    this.updateAvoidance(e);
    if (!t) { this.patrol(e, dt); return; }
    this.faceTarget(e);
    const ty = t.isReactor ? t.y + 2 : t.y + e.def.hover;
    const dist = Math.hypot(t.x - e.x, t.z - e.z);

    if (e.state === AIState.ATTACK) {
      // Casting a fracture at the locked position.
      this.steer(e, 0, 0, 0, e.def.accel, dt);
      if (e.stateTime >= 1.4) {
        w.spawnFracture(e.slamX, e.slamY + 1, e.slamZ, 7.5, 28, 4, FractureMode.ATTRACT, e.id);
        e.telegraph = false;
        e.abilityCooldown = 9;
        e.setState(AIState.CHASE);
      }
      return;
    }
    if (e.abilityCooldown <= 0 && e.hasLOS && !t.isReactor) {
      e.setState(AIState.ATTACK);
      e.telegraph = true;
      e.slamX = t.x; e.slamY = t.y; e.slamZ = t.z;
      w.emit(EV.TELEGRAPH, e.id, Telegraph.FRACTURE, q(t.x), q(t.y), q(t.z), 1.4, 7.5, 0, 0);
      return;
    }
    if (e.lostTime > 4) { this.search(e, dt); return; }
    e.setState(AIState.CHASE);
    const want = dist > 16 ? e.def.speed : dist < 9 ? -e.def.speed * 0.5 : 0;
    const dx = (t.x - e.x) / (dist || 1), dz = (t.z - e.z) / (dist || 1);
    this.steer(e, dx * want + e.avoidX, (ty - e.y) * 0.8 + e.avoidY, dz * want + e.avoidZ, e.def.accel, dt);
    if (e.attackCooldown <= 0 && (e.hasLOS || t.isReactor) && dist < 40) {
      e.attackCooldown = 3.2;
      this.fireBolt(e, t, PK.HEAVY_ORB, 13, e.def.damage, 0.5, 0, { splashRadius: 3.5, splashDamage: 14 });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phase Stalker — cloaks, flanks isolated players, telegraphs         */
  /* ------------------------------------------------------------------ */
  updateStalker(e, dt) {
    const w = this.world;
    this.updateAvoidance(e);
    if (e.state === AIState.IDLE) {
      if (e.stateTime > 0.6) { e.setState(AIState.SEARCH); e.cloaked = true; }
      return;
    }
    // The stalker hunts the most isolated runner, not just the nearest.
    if (e.state === AIState.SEARCH && (e.stateTime < dt * 1.5 || !this.validTarget(e.target) || e.target.isReactor)) {
      e.target = this.isolatedPlayer() || e.target;
      e.targetTimer = 99;
    }
    const t = e.target;
    if (!t) { e.cloaked = false; this.patrol(e, dt); return; }

    switch (e.state) {
      case AIState.SEARCH: {
        // Cloaked approach to a point behind the target.
        e.cloaked = true;
        const bx = t.isReactor ? t.x : t.x + Math.sin(t.move ? t.move.yaw : 0) * 6;
        const bz = t.isReactor ? t.z : t.z + Math.cos(t.move ? t.move.yaw : 0) * 6;
        const d = this.seek(e, bx, t.y + 1.2, bz, e.def.speed, 1.5, dt);
        if (d < 2 || e.stateTime > 3.5) {
          e.setState(AIState.SUPPORT); // "materialising" warning window
          e.cloaked = false;
          e.telegraph = true;
          w.emit(EV.STALKER_WARN, q(e.x), q(e.y), q(e.z));
        }
        break;
      }
      case AIState.SUPPORT: {
        // Readable warning: visible shimmer + audio cue for 0.85 s before the lunge.
        this.steer(e, 0, 0, 0, e.def.accel, dt);
        this.faceTarget(e);
        if (e.stateTime > 0.85) {
          e.telegraph = false;
          e.setState(AIState.ATTACK);
          const dx = t.x - e.x, dy = t.y + 1 - e.y, dz = t.z - e.z;
          const d = Math.hypot(dx, dy, dz) || 1;
          e.vx = (dx / d) * 22; e.vy = (dy / d) * 22; e.vz = (dz / d) * 22;
          e.hitThisCharge = false;
        }
        break;
      }
      case AIState.ATTACK: {
        if (!e.hitThisCharge && this.contact(e, t, e.radius + 0.8)) {
          this.hitTarget(e, t, e.def.damage * e.damageScale, 6);
          e.hitThisCharge = true;
        }
        if (e.stateTime > 0.4) e.setState(AIState.EVADE);
        break;
      }
      case AIState.EVADE: {
        this.steer(e, (e.x - t.x) * 1.2, 3, (e.z - t.z) * 1.2, e.def.accel, dt);
        if (e.stateTime > 1.8) { e.setState(AIState.SEARCH); e.cloaked = true; }
        break;
      }
      case AIState.RETREAT: {
        this.steer(e, (e.x - t.x) * 2, 4, (e.z - t.z) * 2, e.def.accel, dt);
        if (e.stateTime > 2.2) { e.setState(AIState.SEARCH); e.cloaked = true; }
        break;
      }
      default:
        e.setState(AIState.SEARCH);
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rift Caster — support: shields allies, portals, projectile patterns */
  /* ------------------------------------------------------------------ */
  updateCaster(e, dt) {
    const w = this.world;
    this.updateAvoidance(e);
    const t = e.target;
    if (!t) { this.patrol(e, dt); return; }
    this.faceTarget(e);
    const dist = Math.hypot(t.x - e.x, t.z - e.z);
    const ty = t.y + e.def.hover;

    if (e.state === AIState.ATTACK) {
      this.steer(e, 0, 0, 0, e.def.accel, dt);
      if (e.stateTime > 0.6) {
        e.telegraph = false;
        const ring = (Math.floor(w.time / 3.5) + e.poolIndex) % 2 === 0;
        if (ring) {
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            this.fireBoltDir(e, Math.cos(a), -0.12, Math.sin(a), PK.ENEMY_BOLT, 11, e.def.damage, 0.3);
          }
        } else {
          for (let i = -2; i <= 2; i++) this.fireBolt(e, t, PK.ENEMY_BOLT, 17, e.def.damage, 0.3, i * 0.12);
        }
        e.attackCooldown = 3.6;
        e.setState(AIState.CHASE);
      }
      return;
    }
    if (e.state === AIState.SUPPORT) {
      this.steer(e, 0, 0, 0, e.def.accel, dt);
      if (e.stateTime > 0.8) e.setState(AIState.CHASE);
      return;
    }
    // Support: shield nearby allies.
    if (e.supportCooldown <= 0) {
      w.spatial.query(e.x, e.y, e.z, 14, _nb, e);
      let shielded = 0;
      for (const o of _nb) {
        if (o.type === EnemyType.TITAN || o.shield > 0 || shielded >= 3) continue;
        o.shield = 40 * e.damageScale;
        shielded++;
      }
      e.supportCooldown = shielded ? 10 : 2;
      if (shielded) {
        e.setState(AIState.SUPPORT);
        w.emit(EV.TELEGRAPH, e.id, Telegraph.SHIELD, q(e.x), q(e.y), q(e.z), 0.8, 14, 0, 0);
        return;
      }
    }
    // Portal: summon a pair of swarm drones (bounded).
    if (e.summonCooldown <= 0 && e.summoned < 6 && this.countType(EnemyType.SWARM) < 26) {
      e.summonCooldown = 14;
      const ox = e.x + Math.cos(w.time) * 4, oz = e.z + Math.sin(w.time) * 4;
      w.emit(EV.RIFT, q(ox), q(e.y), q(oz));
      for (let i = 0; i < 2; i++) {
        if (this.spawn(EnemyType.SWARM, ox + i, e.y, oz, { hpScale: w.difficulty.hp, damageScale: w.difficulty.damage })) e.summoned++;
      }
    }
    if (dist < 9) {
      e.setState(AIState.RETREAT);
      const dx = (e.x - t.x) / (dist || 1), dz = (e.z - t.z) / (dist || 1);
      this.steer(e, dx * e.def.speed + e.avoidX, (ty + 2 - e.y) + e.avoidY, dz * e.def.speed + e.avoidZ, e.def.accel, dt);
      return;
    }
    if (e.lostTime > 4) { this.search(e, dt); return; }
    e.setState(AIState.CHASE);
    // Keep a 16–24 m band and strafe around the target.
    const radial = dist > 24 ? 1 : dist < 16 ? -1 : 0;
    const dx = (t.x - e.x) / (dist || 1), dz = (t.z - e.z) / (dist || 1);
    const strafe = (e.poolIndex % 2 ? 1 : -1) * 0.6;
    this.steer(e, (dx * radial - dz * strafe) * e.def.speed + e.avoidX, (ty - e.y) + e.avoidY, (dz * radial + dx * strafe) * e.def.speed + e.avoidZ, e.def.accel, dt);
    if (e.attackCooldown <= 0 && (e.hasLOS || t.isReactor)) {
      e.setState(AIState.ATTACK);
      e.telegraph = true;
      w.emit(EV.TELEGRAPH, e.id, Telegraph.FLASH, q(e.x), q(e.y), q(e.z), 0.6, 0, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shard Runner — interruptible charge, damaging trails                 */
  /* ------------------------------------------------------------------ */
  updateRunner(e, dt) {
    const w = this.world;
    const t = e.target;
    if (e.state !== AIState.ATTACK) this.updateAvoidance(e);
    if (!t) { this.patrol(e, dt); return; }
    const ty = t.isReactor ? 1 : t.y + e.def.hover;
    const dist = Math.hypot(t.x - e.x, t.z - e.z);

    if (e.state === AIState.SUPPORT) {
      // Wind-up: locked in place, readable line telegraph. Taking enough damage interrupts it.
      e.charging = false;
      this.steer(e, 0, (ty - e.y) * 2, 0, 30, dt);
      this.faceTarget(e);
      if (e.windupDamage >= 25) {
        e.telegraph = false;
        e.stun(1.6);
        return;
      }
      if (e.stateTime >= 0.9) {
        e.telegraph = false;
        e.setState(AIState.ATTACK);
        e.charging = true;
        e.hitThisCharge = false;
        e.vx = e.chargeDirX * 30; e.vz = e.chargeDirZ * 30; e.vy = 0;
      }
      return;
    }
    if (e.state === AIState.ATTACK) {
      e.vx = e.chargeDirX * 30; e.vz = e.chargeDirZ * 30; e.vy = (ty - e.y) * 2;
      e.trailTimer -= dt;
      if (e.trailTimer <= 0) {
        e.trailTimer = 0.08;
        w.spawnHazard(e.x, e.y - 0.4, e.z, 1.1, 18 * e.damageScale, 2.2, e);
      }
      if (!e.hitThisCharge) {
        if (t.isReactor) {
          if (Math.hypot(t.x - e.x, t.z - e.z) < t.radius + 1.5) {
            w.damageReactor(35 * e.damageScale);
            e.hitThisCharge = true;
          }
        } else {
          for (const p of w.activePlayers) {
            if (!p.canAct) continue;
            if (this.contact(e, p, e.radius + 0.9)) {
              this.hitTarget(e, p, e.def.damage * e.damageScale, 10);
              e.hitThisCharge = true;
              break;
            }
          }
        }
      }
      if (e.stateTime > 0.7) this.endCharge(e);
      return;
    }
    if (e.state === AIState.EVADE) {
      // Recovery window: slow and vulnerable.
      this.steer(e, 0, (ty - e.y), 0, 10, dt);
      if (e.stateTime > 1.2) e.setState(AIState.CHASE);
      return;
    }
    if (e.lostTime > 3) { this.search(e, dt); return; }
    e.setState(AIState.CHASE);
    this.seek(e, t.x, ty, t.z, e.def.speed, 0, dt);
    if (dist < 22 && dist > 4 && e.attackCooldown <= 0 && (e.hasLOS || t.isReactor)) {
      e.setState(AIState.SUPPORT);
      e.telegraph = true;
      e.windupDamage = 0;
      const d = dist || 1;
      e.chargeDirX = (t.x - e.x) / d; e.chargeDirZ = (t.z - e.z) / d;
      e.attackCooldown = 4.2;
      w.emit(EV.TELEGRAPH, e.id, Telegraph.LINE, q(e.x), q(e.y), q(e.z), 0.9, q(e.chargeDirX, 3), 0, q(e.chargeDirZ, 3));
    }
  }

  recall(e) {
    const w = this.world;
    let best = null, bd = Infinity;
    for (const r of w.arena.rifts) {
      const d = Math.hypot(r.x - e.target.x, r.z - e.target.z);
      if (d < bd) { bd = d; best = r; }
    }
    if (!best) return;
    e.x = best.x; e.y = best.y; e.z = best.z;
    e.vx = e.vy = e.vz = 0;
    e.stuckTime = 0;
    e.cloaked = false;
    e.setState(AIState.CHASE);
    w.emit(EV.RIFT, q(best.x), q(best.y), q(best.z));
  }

  endCharge(e) {
    e.charging = false;
    e.vx *= 0.2; e.vz *= 0.2;
    e.setState(AIState.EVADE);
  }

  onChargeImpact(e) {
    // Charging into a wall interrupts the runner and briefly stuns it.
    e.charging = false;
    e.vx = 0; e.vz = 0;
    e.setState(AIState.EVADE);
    e.stunTimer = 1.0;
  }

  /* ------------------------------------------------------------------ */
  /* Mirror Drone — replays the target's movement with a delay           */
  /* ------------------------------------------------------------------ */
  /**
   * The drone records its target's velocity and position every tick and
   * replays the velocity from MIRROR_DELAY_TICKS ago. It never reads player
   * input or identity — only the authoritative motion everyone can see.
   * Counterplay: abrupt direction changes make it overshoot, and it aims at
   * where you were 0.75 s ago, so constant movement dodges its bursts.
   */
  updateMirror(e, dt) {
    const w = this.world;
    this.updateAvoidance(e);
    const t = e.target;
    if (!t) { this.patrol(e, dt); return; }
    const tm = t.move; // undefined when targeting the reactor
    // record
    const h = e.mirrorHead;
    e.mirrorBuf[h * 6] = tm ? tm.vx : 0; e.mirrorBuf[h * 6 + 1] = tm ? tm.vy : 0; e.mirrorBuf[h * 6 + 2] = tm ? tm.vz : 0;
    e.mirrorBuf[h * 6 + 3] = t.x; e.mirrorBuf[h * 6 + 4] = t.y; e.mirrorBuf[h * 6 + 5] = t.z;
    e.mirrorHead = (h + 1) % MIRROR_BUFFER;
    e.mirrorCount = Math.min(MIRROR_BUFFER, e.mirrorCount + 1);
    const delayed = (e.mirrorHead - 1 - Math.min(MIRROR_DELAY_TICKS, e.mirrorCount - 1) + MIRROR_BUFFER * 2) % MIRROR_BUFFER;
    const dvx = e.mirrorBuf[delayed * 6], dvy = e.mirrorBuf[delayed * 6 + 1], dvz = e.mirrorBuf[delayed * 6 + 2];
    const pastX = e.mirrorBuf[delayed * 6 + 3], pastY = e.mirrorBuf[delayed * 6 + 4], pastZ = e.mirrorBuf[delayed * 6 + 5];

    // Spring toward a 12–16 m standoff in front of the target.
    const dist = Math.hypot(t.x - e.x, t.z - e.z) || 1;
    const radial = dist > 16 ? 1 : dist < 12 ? -1 : 0;
    const dx = (t.x - e.x) / dist, dz = (t.z - e.z) / dist;
    const vx = clamp(dvx, -e.def.speed, e.def.speed) * 0.9 + dx * radial * 6 + e.avoidX;
    const vz = clamp(dvz, -e.def.speed, e.def.speed) * 0.9 + dz * radial * 6 + e.avoidZ;
    const vy = clamp(dvy, -6, 6) * 0.5 + (t.y + e.def.hover - e.y) * 1.2 + e.avoidY;

    if (e.state === AIState.ATTACK) {
      this.steer(e, vx * 0.4, vy, vz * 0.4, e.def.accel, dt);
      if (e.attackStage === 0) {
        // 0.5 s telegraph glow before the burst
        if (e.stateTime > 0.5) {
          e.attackStage = 1;
          e.telegraph = false;
          e.burstLeft = 3;
          e.burstTimer = 0;
        }
      } else {
        e.burstTimer -= dt;
        if (e.burstTimer <= 0 && e.burstLeft > 0) {
          e.burstTimer = 0.12;
          e.burstLeft--;
          // Aims at the target's position from 0.75 s ago (echo aim).
          this.fireBoltAt(e, pastX, pastY + 1.1, pastZ, PK.ENEMY_BOLT, 26, e.def.damage, 0.28, 0);
        }
        if (e.burstLeft <= 0) {
          e.attackStage = 0;
          e.attackCooldown = 2.4;
          e.setState(AIState.CHASE);
        }
      }
      return;
    }
    e.setState(AIState.CHASE);
    this.steer(e, vx, vy, vz, e.def.accel, dt);
    if (e.attackCooldown <= 0 && e.hasLOS && e.mirrorCount > MIRROR_DELAY_TICKS) {
      e.setState(AIState.ATTACK);
      e.attackStage = 0;
      e.telegraph = true;
      e.burstLeft = 0;
      w.emit(EV.TELEGRAPH, e.id, Telegraph.FLASH, q(e.x), q(e.y), q(e.z), 0.5, 0, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Singularity Titan — multi-phase boss                                 */
  /* ------------------------------------------------------------------ */
  updateTitan(e, dt) {
    const w = this.world;
    const frac = e.hp / e.maxHp;
    const phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (phase !== e.phase) {
      e.phase = phase;
      e.weakOpenTimer = 4.5; // phase transition exposes the core
      e.attack = 0;
      e.telegraph = false;
      w.emit(EV.BOSS, e.id, phase);
      w.spawnFracture(e.x, e.y, e.z, 12, 30, 2, FractureMode.REPEL, e.id);
    }
    const t = e.target;
    // Hover near arena centre, drifting toward the target.
    const cx = t ? clamp(t.x * 0.35, -14, 14) : 0;
    const cz = t ? clamp(t.z * 0.35, -14, 14) : 0;
    const hoverY = (t && !t.isReactor ? Math.max(4, t.y) : 4) + e.def.hover;
    this.steer(e, (cx - e.x) * 0.5, (hoverY - e.y) * 0.8, (cz - e.z) * 0.5, e.def.accel, dt);
    if (!t) return;
    if (e.attack === 0) this.faceTarget(e);

    const speedUp = phase === 3 ? 0.75 : 1;
    if (e.attack === 0) {
      e.setState(AIState.CHASE);
      if (e.attackCooldown > 0) return;
      // Choose the next attack based on phase.
      const options = [1, 2];
      if (phase >= 2) options.push(3, 4);
      if (phase >= 3) options.push(5);
      e.attack = options[Math.floor(w.rng() * options.length)];
      e.attackStage = 0;
      e.attackTimer = 0;
      e.telegraph = true;
      e.setState(AIState.ATTACK);
      const tgY = t.isReactor ? 0 : t.y;
      switch (e.attack) {
        case 1: // orb barrage
          w.emit(EV.TELEGRAPH, e.id, Telegraph.FLASH, q(e.x), q(e.y), q(e.z), 0.8 * speedUp, 0, 0, 0);
          break;
        case 2: // gravity slam
          e.slamX = t.x; e.slamY = tgY; e.slamZ = t.z;
          w.emit(EV.TELEGRAPH, e.id, Telegraph.GROUND_RING, q(t.x), q(tgY), q(t.z), 1.6 * speedUp, 7, 0, 0);
          break;
        case 3: // beam sweep
          e.beamAngle = Math.atan2(t.z - e.z, t.x - e.x) - Math.PI / 2;
          e.beamSweep = Math.PI;
          e.beamY = tgY + 1.0;
          w.emit(EV.TELEGRAPH, e.id, Telegraph.BEAM, q(e.x), q(e.beamY), q(e.z), 1.2 * speedUp, q(e.beamAngle, 3), q(e.beamSweep, 3), 2.6);
          break;
        case 4: // summon
          w.emit(EV.TELEGRAPH, e.id, Telegraph.PORTAL, q(e.x), q(e.y), q(e.z), 0.9, 0, 0, 0);
          break;
        case 5: // arena pulse
          w.emit(EV.TELEGRAPH, e.id, Telegraph.ARENA_PULSE, q(e.x), q(e.y), q(e.z), 2.5, 0, 0, 0);
          break;
        default: break;
      }
      return;
    }
    e.attackTimer += dt;
    switch (e.attack) {
      case 1: {
        if (e.attackStage === 0 && e.attackTimer >= 0.8 * speedUp) { e.attackStage = 1; e.telegraph = false; e.burstLeft = 6 + phase * 2; e.burstTimer = 0; }
        if (e.attackStage === 1) {
          e.burstTimer -= dt;
          if (e.burstTimer <= 0 && e.burstLeft > 0) {
            e.burstTimer = 0.1;
            e.burstLeft--;
            this.fireBolt(e, t, PK.TITAN_ORB, 17, e.def.damage, 0.6, (w.rng() - 0.5) * 0.35);
          }
          if (e.burstLeft <= 0) this.finishTitanAttack(e, 2.2 * speedUp);
        }
        break;
      }
      case 2: {
        if (e.attackTimer >= 1.6 * speedUp) {
          e.telegraph = false;
          w.emit(EV.SHOCKWAVE, q(e.slamX), q(e.slamY), q(e.slamZ), 7);
          for (const p of w.activePlayers) {
            if (!p.canAct) continue;
            const d = Math.hypot(p.x - e.slamX, p.z - e.slamZ);
            if (d < 7 && p.y - e.slamY < 1.2) {
              w.applyDamage(p, 30 * e.damageScale, e, { x: e.slamX, y: e.slamY, z: e.slamZ });
              w.knockback(p, 0, 11, 0);
            }
          }
          w.spawnFracture(e.slamX, e.slamY + 1, e.slamZ, 8, 30, 1.5, FractureMode.REPEL, e.id);
          this.finishTitanAttack(e, 2.4 * speedUp);
        }
        break;
      }
      case 3: {
        if (e.attackStage === 0 && e.attackTimer >= 1.2 * speedUp) { e.attackStage = 1; e.telegraph = false; e.attackTimer = 0; }
        if (e.attackStage === 1) {
          const sweepTime = 2.6;
          const a = e.beamAngle + e.beamSweep * clamp(e.attackTimer / sweepTime, 0, 1);
          const bx = e.x + Math.cos(a) * 48, bz = e.z + Math.sin(a) * 48;
          for (const p of w.activePlayers) {
            if (!p.canAct) continue;
            // Beam is a horizontal segment at beamY; jump over it or phase through it.
            if (!(p.y < e.beamY && p.y + PLAYER.HEIGHT > e.beamY)) continue;
            const d2 = pointSegmentDistSq(p.x, 0, p.z, e.x, 0, e.z, bx, 0, bz);
            if (d2 < 0.9 * 0.9) w.applyDamage(p, 45 * e.damageScale * dt, e, { x: p.x, y: e.beamY, z: p.z, beam: true });
          }
          if (e.attackTimer >= sweepTime) this.finishTitanAttack(e, 2.0 * speedUp);
        }
        break;
      }
      case 4: {
        if (e.attackTimer >= 0.9) {
          e.telegraph = false;
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            const sx = e.x + Math.cos(a) * 6, sz = e.z + Math.sin(a) * 6;
            w.emit(EV.RIFT, q(sx), q(e.y - 2), q(sz));
            if (this.countType(EnemyType.SWARM) < 30) this.spawn(EnemyType.SWARM, sx, e.y - 2, sz, { hpScale: w.difficulty.hp, damageScale: w.difficulty.damage });
          }
          this.finishTitanAttack(e, 2.5 * speedUp);
        }
        break;
      }
      case 5: {
        if (e.attackTimer >= 2.5) {
          e.telegraph = false;
          w.emit(EV.ARENA_PULSE, 1);
          for (const p of w.activePlayers) {
            if (!p.canAct || !p.move.onGround) continue;
            w.applyDamage(p, 22 * e.damageScale, e, { x: e.x, y: e.y, z: e.z, arena: true });
          }
          this.finishTitanAttack(e, 3 * speedUp);
        }
        break;
      }
      default:
        this.finishTitanAttack(e, 1);
    }
  }

  finishTitanAttack(e, cooldown) {
    e.attack = 0;
    e.attackStage = 0;
    e.telegraph = false;
    e.attackCooldown = cooldown;
    e.setState(AIState.CHASE);
  }

  /* ------------------------------------------------------------------ */
  /* Training dummies                                                     */
  /* ------------------------------------------------------------------ */
  updateDummy(e, dt) {
    e.setState(AIState.IDLE);
    if (e.dummyMoving) {
      e.vx = Math.cos(this.world.time * 1.3 + e.poolIndex) * 6;
      e.x += e.vx * dt;
    }
    if (this.world.time - e.lastDamageTime > 3) e.hp = e.maxHp;
    e.yaw = Math.atan2(-(0 - e.x), -(0 - e.z));
  }

  /* ------------------------------------------------------------------ */
  /* Rogue Runner — solo bots that move exactly like players              */
  /* ------------------------------------------------------------------ */

  /**
   * Fire tokens: only the few engaged Rogue Runners nearest their target may
   * shoot this tick, so a crowd never opens fire at once and solo fights stay
   * readable. The cap comes from the wave difficulty (2 early, up to 4 late).
   */
  assignFireTokens() {
    const list = _rogues;
    list.length = 0;
    for (const e of this.active) {
      if (!e.move) continue;
      e.canShoot = false;
      if (e.active && e.engaged && e.hasLOS && e.target) {
        e.tokenDist = (e.target.x - e.x) ** 2 + (e.target.z - e.z) ** 2;
        list.push(e);
      }
    }
    if (!list.length) return;
    list.sort((a, b) => a.tokenDist - b.tokenDist);
    const n = Math.min(list.length, (this.world.difficulty && this.world.difficulty.shooters) || 2);
    for (let i = 0; i < n; i++) list[i].canShoot = true;
  }

  /**
   * Rogue Runners drive the shared player movement model (stepMovement) with
   * synthesized inputs, so they run, jump, step up and fall like real runners.
   *
   *   PATROL  wander around their own spawn point, so a wave is spread across
   *           the arena instead of piled on the player
   *   CHASE   (engaged) hold a BAND_NEAR..BAND_FAR range, strafe, hop and fire
   *           short bursts of dodgeable bolts, if they hold a fire token
   *   SEARCH  walk to where the player was last seen, then return to patrol
   *
   * Awareness needs line of sight within SIGHT metres inside a forward view
   * cone, or being shot. A runner left unengaged for HUNT_AFTER seconds starts
   * hunting the player, so a wave can never stall. Every step is probed for
   * floor ahead: runners never walk off an island by themselves (fractures and
   * knockback still can push them, which counts as an environmental kill).
   */
  updateRogue(e, dt) {
    const w = this.world;
    const m = e.move;
    const inp = e.botInput;
    m.vx = e.vx; m.vy = e.vy; m.vz = e.vz; // keep knockback and other external pushes
    inp.mx = 0; inp.mz = 0; inp.buttons = 0; inp.pitch = m.pitch;
    e.wantMove = false;
    e.blocked = false;
    if (m.onGround) { e.safeX = m.x; e.safeY = m.y; e.safeZ = m.z; }
    const t = e.target;

    if (e.stunTimer > 0) {
      e.stunTimer -= dt;
      e.setState(AIState.STUNNED);
      e.burstLeft = 0;
    } else if (!t) {
      this.roguePatrol(e, dt);
    } else {
      const dx = t.x - e.x, dz = t.z - e.z;
      const dist = Math.hypot(dx, dz) || 1;
      const inView = (-Math.sin(e.yaw) * dx - Math.cos(e.yaw) * dz) / dist > ROGUE.VIEW_COS || dist < ROGUE.NEAR;
      const shot = w.time - e.lastDamageTime < 1;
      if ((e.hasLOS && dist < ROGUE.SIGHT && inView) || shot) {
        if (!e.engaged || e.lostTime > 0.5) e.reaction = Math.max(e.reaction, ROGUE.REACTION + w.rng() * 0.35);
        if (shot && !e.hasLOS) { e.lastKnownX = t.x; e.lastKnownY = t.y; e.lastKnownZ = t.z; e.lostTime = 0; }
        e.engaged = true;
        e.hunting = false;
        e.idleTime = 0;
        e.searchTime = 0;
      }
      if (e.engaged && e.lostTime < ROGUE.FORGET) {
        this.rogueFight(e, t, dist, dt);
      } else if (e.engaged || e.hunting) {
        e.setState(AIState.SEARCH);
        e.searchTime += dt;
        const left = this.rogueWalkTo(e, e.lastKnownX, e.lastKnownZ, e.hunting, dt);
        if (left < 2.5 && e.hunting) { e.lastKnownX = t.x; e.lastKnownZ = t.z; } // hunting re-reads the target
        // the way is cut by a gap: a searcher gives up; a hunter re-enters nearer (see stuck check below)
        if (!e.hunting && (left < 2.5 || e.blocked || e.searchTime > ROGUE.SEARCH)) { e.engaged = false; e.searchTime = 0; }
      } else {
        this.roguePatrol(e, dt);
        e.idleTime += dt;
        const huntAfter = this.countType(EnemyType.ROGUE) <= 2 ? ROGUE.HUNT_AFTER_LAST : ROGUE.HUNT_AFTER;
        if (e.idleTime > huntAfter) {
          e.hunting = true;
          e.lastKnownX = t.x; e.lastKnownZ = t.z;
        }
      }
    }

    // Airborne over the void (pad launch, knockback, a hop near an edge): steer back to the last floor.
    if (!m.onGround && this.groundAt(m.x + m.vx * 0.3, m.z + m.vz * 0.3, m.y + 0.5, 40) === null) {
      inp.mx = 0; inp.mz = 0; inp.buttons &= ~(BTN.JUMP | BTN.JUMP_P);
      this.rogueInput(e, e.safeX - m.x, e.safeZ - m.z, false);
    }

    inp.yaw = e.yaw;
    const px = m.x, pz = m.z;
    const ev = stepMovement(m, inp, w.env, dt);
    e.x = m.x; e.y = m.y + ROGUE.CENTER; e.z = m.z;
    e.vx = m.vx; e.vy = m.vy; e.vz = m.vz;
    if ((ev & MoveEvent.FELL_OUT) || m.y < w.arena.killY) { w.killEnemy(e, e.lastHitBy, { environmental: true }); return; }

    // Wants to get somewhere but makes no progress without sight (pressed into a wall, or cut
    // off by a gap): re-enter through a rift elsewhere. Progress is measured from the actual
    // displacement; the movement velocity stays high while pushing against a wall.
    const progress = Math.hypot(m.x - px, m.z - pz) / dt > 0.8;
    e.stuckTime = e.wantMove && !progress && !e.hasLOS ? (e.stuckTime || 0) + dt : Math.max(0, (e.stuckTime || 0) - dt);
    if (e.stuckTime > (e.hunting ? 4 : 8)) this.rogueRelocate(e);
  }

  /** Engaged: range band, strafing, hops and burst fire. */
  rogueFight(e, t, dist, dt) {
    const w = this.world;
    const m = e.move;
    const inp = e.botInput;
    e.setState(e.burstLeft > 0 ? AIState.ATTACK : AIState.CHASE);
    // aim (smoothly: flanking a runner works)
    const tx = e.hasLOS ? t.x : e.lastKnownX, tz = e.hasLOS ? t.z : e.lastKnownZ;
    const ax = tx - e.x, az = tz - e.z;
    const ay = (e.hasLOS ? t.y : e.lastKnownY) + 1.1 - (m.y + PLAYER.EYE_HEIGHT);
    e.yaw = turnToward(e.yaw, Math.atan2(-ax, -az), ROGUE.TURN_RATE * dt);
    inp.pitch = clamp(Math.atan2(ay, Math.hypot(ax, az)), -1.2, 1.2);

    // movement: hold the band and strafe; close in when sight is lost
    e.strafeTimer -= dt;
    if (e.strafeTimer <= 0) { e.strafeDir = w.rng() < 0.5 ? -1 : 1; e.strafeTimer = 1.1 + w.rng() * 1.6; }
    const radial = !e.hasLOS ? 1 : dist > ROGUE.BAND_FAR ? 1 : dist < ROGUE.BAND_NEAR ? -1 : 0;
    const ux = ax / (Math.hypot(ax, az) || 1), uz = az / (Math.hypot(ax, az) || 1);
    const strafe = e.hasLOS ? e.strafeDir * 0.8 : 0;
    let wx = ux * radial - uz * strafe, wz = uz * radial + ux * strafe;
    if (!this.rogueSafe(e, wx, wz)) {
      e.strafeDir = -e.strafeDir; // edge on this side: strafe the other way
      wx = ux * radial - uz * -strafe; wz = uz * radial + ux * -strafe;
      if (!this.rogueSafe(e, wx, wz)) { wx = 0; wz = 0; }
    }
    this.rogueInput(e, wx, wz);
    if (wx || wz) e.wantMove = true;
    if (!e.hasLOS && dist > ROGUE.BAND_FAR + 8) inp.buttons |= BTN.SPRINT;
    e.hopTimer -= dt;
    if (e.hopTimer <= 0 && m.onGround && e.hasLOS && this.rogueSafe(e, wx || ux, wz || uz, 3)) { inp.buttons |= BTN.JUMP | BTN.JUMP_P; e.hopTimer = 3 + w.rng() * 4; }

    // fire: short bursts of visible bolts, only with a fire token
    e.reaction -= dt;
    if (e.burstLeft > 0) {
      e.burstTimer -= dt;
      if (e.burstTimer <= 0) {
        this.rogueShoot(e, t);
        e.burstLeft--;
        e.burstTimer = ROGUE.BURST_GAP;
      }
    } else if (e.canShoot && e.hasLOS && e.reaction <= 0 && e.attackCooldown <= 0 && dist < ROGUE.RANGE) {
      e.burstLeft = ROGUE.BURST;
      e.burstTimer = 0;
      e.attackCooldown = ROGUE.COOLDOWN + w.rng() * 0.8;
    }
  }

  /** One bolt from the rifle, with aim error; dodgeable because it travels. */
  rogueShoot(e, t) {
    const w = this.world;
    const m = e.move;
    const ox = m.x - Math.sin(e.yaw) * 0.5, oy = m.y + 1.35, oz = m.z - Math.cos(e.yaw) * 0.5;
    const yaw = Math.atan2(-(t.x - ox), -(t.z - oz)) + (w.rng() - 0.5) * 2 * ROGUE.SPREAD;
    const pitch = Math.atan2(t.y + 1.1 - oy, Math.hypot(t.x - ox, t.z - oz)) + (w.rng() - 0.5) * 2 * ROGUE.SPREAD;
    const cp = Math.cos(pitch);
    const speed = ROGUE.BOLT_SPEED;
    w.spawnProjectile({
      kind: PK.ENEMY_BOLT, owner: e, team: TEAM.ENEMIES, x: ox, y: oy, z: oz,
      vx: -Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * cp * speed,
      gravity: 0, life: 2, radius: 0.22, damage: e.def.damage * e.damageScale, weapon: -1, splashRadius: 0, splashDamage: 0,
    });
  }

  /** Wander around the spawn point, looking about; never off a ledge. */
  roguePatrol(e, dt) {
    const w = this.world;
    e.setState(AIState.PATROL);
    e.wanderTimer -= dt;
    const m = e.move;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = 4 + w.rng() * 4;
      for (let i = 0; i < 4; i++) {
        const a = w.rng() * Math.PI * 2, r = 3 + w.rng() * (ROGUE.WANDER_RADIUS - 3);
        const px = e.homeX + Math.cos(a) * r, pz = e.homeZ + Math.sin(a) * r;
        const gy = this.groundAt(px, pz, e.homeY + 2.5);
        if (gy !== null && Math.abs(gy - e.homeY) < 1.2) { e.wanderX = px; e.wanderZ = pz; break; }
      }
    }
    const left = this.rogueWalkTo(e, e.wanderX, e.wanderZ, false, dt);
    if (left < 1.2) e.yaw = wrapAngle(e.yaw + Math.sin(w.time * 0.7 + e.poolIndex) * 0.9 * dt); // look around
    e.botInput.pitch *= 0.9;
  }

  /** Walk (or sprint) toward a point, facing the way they go. Returns the remaining distance. */
  rogueWalkTo(e, x, z, sprint, dt) {
    const dx = x - e.x, dz = z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.2) return d;
    const wx = dx / d, wz = dz / d;
    e.yaw = turnToward(e.yaw, Math.atan2(-wx, -wz), ROGUE.TURN_RATE * 0.7 * dt);
    e.wantMove = true;
    if (!this.rogueSafe(e, wx, wz)) { e.wanderTimer = 0; e.blocked = true; return d; } // edge ahead: pick another point
    this.rogueInput(e, wx, wz);
    if (sprint) e.botInput.buttons |= BTN.SPRINT;
    return d;
  }

  /** World-space wish direction -> yaw-relative movement axes (+ hop over low cover with floor beyond). */
  rogueInput(e, wx, wz, hop = true) {
    const inp = e.botInput;
    const len = Math.hypot(wx, wz);
    if (len < 1e-3) return;
    wx /= len; wz /= len;
    const sy = Math.sin(e.yaw), cy = Math.cos(e.yaw);
    inp.mz = -sy * wx - cy * wz; // along forward (-sin, -cos)
    inp.mx = cy * wx - sy * wz; // along right (cos, -sin)
    const m = e.move;
    if (hop && m.onGround) {
      const hit = raycastArena(this.world.env, m.x, m.y + 0.45, m.z, wx, 0, wz, 1.2, false, false);
      const c = hit.t >= 0 ? hit.collider : null;
      if (c && c.maxY - m.y < 1.5 && this.groundAt(m.x + wx * 2.4, m.z + wz * 2.4, c.maxY + 0.5, 3) !== null) {
        inp.buttons |= BTN.JUMP | BTN.JUMP_P;
      }
    }
  }

  /**
   * True if there is floor `ahead` metres in this direction and it is not a
   * launch pad (a pad's arc carries a runner off its island).
   */
  rogueSafe(e, wx, wz, ahead = 1.4) {
    const len = Math.hypot(wx, wz);
    if (len < 1e-3) return true;
    const m = e.move;
    const px = m.x + (wx / len) * ahead, pz = m.z + (wz / len) * ahead;
    for (const pad of this.world.arena.pads || []) {
      if (Math.abs(pad.y - m.y) < 2 && Math.hypot(pad.x - px, pad.z - pz) < pad.r + 0.9) return false;
    }
    return this.groundAt(px, pz, m.y + 0.6, 3.5) !== null;
  }

  /** Floor height under (x, z) searching down from fromY, or null. */
  groundAt(x, z, fromY, depth = 6) {
    const hit = raycastArena(this.world.env, x, fromY, z, 0, -1, 0, depth, false, false);
    return hit.t >= 0 ? fromY - hit.t : null;
  }

  /** Re-enter through a rift at a spawn point away from the player. */
  rogueRelocate(e) {
    const w = this.world;
    const t = e.target;
    let best = null, bestScore = -Infinity;
    for (const s of w.arena.spawns) {
      const d = t ? Math.hypot(s.x - t.x, s.z - t.z) : 30;
      if (d < ROGUE.SPAWN_MIN_DIST) continue;
      const score = -Math.abs(d - 28) + w.rng() * 6;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (!best) return;
    const m = e.move;
    m.x = best.x; m.y = best.y; m.z = best.z;
    m.vx = m.vy = m.vz = 0;
    e.vx = e.vy = e.vz = 0;
    e.homeX = best.x; e.homeY = best.y; e.homeZ = best.z;
    e.wanderX = best.x; e.wanderZ = best.z;
    e.stuckTime = 0;
    e.engaged = false;
    w.emit(EV.RIFT, q(best.x), q(best.y + 1), q(best.z));
  }

  /* ------------------------------------------------------------------ */
  /* Attack helpers                                                       */
  /* ------------------------------------------------------------------ */

  contact(e, t, range) {
    const ty = t.isReactor ? t.y : t.y + 0.9;
    const r = t.isReactor ? t.radius + range : range;
    return (t.x - e.x) ** 2 + (ty - e.y) ** 2 + (t.z - e.z) ** 2 <= r * r;
  }

  hitTarget(e, t, damage, knock) {
    const w = this.world;
    if (t.isReactor) { w.damageReactor(damage); return; }
    w.applyDamage(t, damage, e, { x: e.x, y: e.y, z: e.z });
    const kx = t.x - e.x, kz = t.z - e.z;
    const kl = Math.hypot(kx, kz) || 1;
    w.knockback(t, (kx / kl) * knock, 2, (kz / kl) * knock);
  }

  fireBolt(e, t, kind, speed, damage, radius, yawOffset, extra) {
    const ty = t.isReactor ? t.y : t.y + 1.1;
    this.fireBoltAt(e, t.x, ty, t.z, kind, speed, damage, radius, yawOffset, extra);
  }

  fireBoltAt(e, tx, ty, tz, kind, speed, damage, radius, yawOffset, extra) {
    let dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    if (yawOffset) {
      const c = Math.cos(yawOffset), s = Math.sin(yawOffset);
      const nx = dx * c - dz * s, nz = dx * s + dz * c;
      dx = nx; dz = nz;
    }
    const d = Math.hypot(dx, dy, dz) || 1;
    this.fireBoltDir(e, dx / d, dy / d, dz / d, kind, speed, damage, radius, extra);
  }

  fireBoltDir(e, dx, dy, dz, kind, speed, damage, radius, extra = null) {
    const off = e.radius + 0.3;
    this.world.spawnProjectile({
      kind, owner: e, team: TEAM.ENEMIES,
      x: e.x + dx * off, y: e.y + dy * off, z: e.z + dz * off,
      vx: dx * speed, vy: dy * speed, vz: dz * speed,
      gravity: 0, life: 4, radius, damage: damage * e.damageScale, weapon: -1,
      splashRadius: extra ? extra.splashRadius : 0, splashDamage: extra ? extra.splashDamage * e.damageScale : 0,
    });
  }
}

const _rogues = [];

/** Rotate angle `a` toward `b` by at most `max` radians. */
function turnToward(a, b, max) {
  const d = wrapAngle(b - a);
  return wrapAngle(a + clamp(d, -max, max));
}

function q(v, d = 2) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

/** Wave composition helper used by survival and co-op rules. */
export function enemyCost(type) {
  return ENEMY_DEFS[type].cost;
}
