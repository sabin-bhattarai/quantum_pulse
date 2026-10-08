/**
 * Quantum Pulse — authoritative world simulation.
 *
 * One World = one match. It advances in fixed steps (SIM.DT) and owns every
 * gameplay decision: movement, weapons, damage, enemies, projectiles,
 * fractures, pickups, props and scoring (delegated to the mode rules).
 *
 * The file is isomorphic (no Node or DOM APIs) so the same code runs:
 *   - on the Node server for online modes, and
 *   - inside the browser for offline Solo Survival and the Training Range.
 * @module server/World
 */
import { SIM, NET, PULSE, PLAYER, LIMITS, TEAM, MODES, MATCH, FRACTURE, BTN, ROGUE } from '../shared/constants.js';
import { createArena, ColliderKind } from '../shared/arenas.js';
import { createCollisionEnv, stepMovement, MoveEvent, raycastArena } from '../shared/movement.js';
import { makeFracture, accumulateFractureDeltaV } from '../shared/gravity.js';
import { mulberry32, raySphere, rayVerticalCapsule, pointSegmentDistSq, clamp, quantize } from '../shared/math.js';
import { EV, PF, EF, PK, PICKUP, encodeMoveState } from '../shared/protocol.js';
import { Player } from './Player.js';
import { EnemySystem, EnemyType, AIState } from './Enemy.js';
import { SpatialHash } from './SpatialHash.js';
import { WEAPONS } from '../shared/weapons.js';
import { updatePlayerWeapons, tryDeflect, grantLoadout } from './Weapons.js';
import {
  addPulse, onPhaseActivated, tryGravityAbility, tryMeleePulse, landingShockwave,
  updateTethers, tryPulseTransfer, tickAbilityCooldowns,
} from './Abilities.js';
import { createRules } from './Match.js';

const MAX_REWIND_TICKS = Math.floor((NET.LAG_COMP_MAX_MS / 1000) * SIM.TICK_RATE);
const MAX_TRACE_HITS = 16;

const _hum = { t: -1, head: false };

/**
 * Ray vs a humanoid (player or Rogue Runner) standing with its feet at
 * (fx, fy, fz): body capsule + head sphere from PLAYER, lowered by `drop`
 * while sliding, both inflated by `pad` (projectile radius). The head wins
 * when it is struck no more than 0.35 m behind the body entry point, so shots
 * grazing the shoulders into the helmet still count as headshots.
 * @returns {{t:number, head:boolean}} shared result (t = -1 on a miss)
 */
function rayHumanoid(ox, oy, oz, dx, dy, dz, fx, fy, fz, drop, pad, maxT) {
  const b = fy - drop;
  const tb = rayVerticalCapsule(ox, oy, oz, dx, dy, dz, fx, b + PLAYER.BODY_BOTTOM, b + PLAYER.BODY_TOP, fz, PLAYER.BODY_RADIUS + pad, maxT);
  const th = raySphere(ox, oy, oz, dx, dy, dz, fx, b + PLAYER.HEAD_CENTER, fz, PLAYER.HEAD_RADIUS + pad, maxT);
  if (th >= 0 && (tb < 0 || th <= tb + 0.35)) { _hum.t = th; _hum.head = true; }
  else { _hum.t = tb; _hum.head = false; }
  return _hum;
}

const _pos = { x: 0, y: 0, z: 0 };
const _wp = { x: 0, y: 0, z: 0, r: 0 };
const _dv = { x: 0, y: 0, z: 0 };
const _nb = [];

export class World {
  /**
   * @param {object} opts
   * @param {string} opts.mode one of MODES
   * @param {string} [opts.arenaId]
   * @param {number} [opts.seed]
   * @param {number} [opts.matchDuration] FFA seconds
   */
  constructor(opts) {
    this.mode = opts.mode;
    this.arena = createArena(opts.arenaId || (opts.mode === MODES.COOP ? 'reactor_null' : 'neon_rupture'));
    this.env = createCollisionEnv(this.arena);
    this.seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.rng = mulberry32(this.seed);
    this.tick = 0;
    this.time = 0;
    this.idCounter = 1;
    this.config = { matchDuration: opts.matchDuration || MATCH.FFA_DURATION_S };

    /** @type {Map<number, Player>} */
    this.players = new Map();
    /** @type {Player[]} connected, simulated players (rebuilt on join/leave) */
    this.activePlayers = [];
    this.slots = new Array(12).fill(null);

    this.spatial = new SpatialHash();
    this.enemies = new EnemySystem(this);
    this.difficulty = { hp: 1, damage: 1, speed: 1 };

    // Fixed pools -------------------------------------------------------------
    this.projectiles = [];
    for (let i = 0; i < LIMITS.MAX_PROJECTILES; i++) this.projectiles.push({ active: false, id: 0 });
    this.projectileCursor = 0;
    this.pickups = [];
    for (let i = 0; i < LIMITS.MAX_PICKUPS; i++) this.pickups.push({ active: false, id: 0 });
    this.hazards = [];
    for (let i = 0; i < LIMITS.MAX_HAZARDS; i++) this.hazards.push({ active: false, id: 0 });
    this.echoes = [];
    for (let i = 0; i < LIMITS.MAX_ECHOES; i++) this.echoes.push({ active: false });

    /** Active fractures; shared with the collision env so movement sees them. */
    this.fractures = this.env.fractures;
    this.fractureCount = 0;

    this.events = [];
    this.eventsDropped = 0;

    this.reactor = this.mode === MODES.COOP && this.arena.reactor
      ? { isReactor: true, x: this.arena.reactor.x, y: this.arena.reactor.y, z: this.arena.reactor.z, radius: this.arena.reactor.radius, hp: MATCH.REACTOR_MAX_HP, maxHp: MATCH.REACTOR_MAX_HP, canAct: true }
      : null;

    this.arenaPulseTimer = this.arena.pulseHazard ? this.arena.pulseHazard.interval : 0;
    this.arenaPulseTelegraphed = false;

    this.serverTickMs = 0;
    this.traceResult = { hits: [], count: 0, endX: 0, endY: 0, endZ: 0, prop: null };
    for (let i = 0; i < MAX_TRACE_HITS; i++) this.traceResult.hits.push({ target: null, t: 0, head: false, x: 0, y: 0, z: 0 });

    this.rules = createRules(this);
    this.rules.start();
  }

  nextId() {
    this.idCounter = (this.idCounter + 1) % 0x3fffffff || 1;
    return this.idCounter;
  }

  /** Queue a gameplay event for the next snapshot (bounded). */
  emit(code, ...args) {
    if (this.events.length >= LIMITS.MAX_EVENTS_PER_SNAPSHOT) { this.eventsDropped++; return; }
    args.unshift(code);
    this.events.push(args);
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /* ---------------------------------------------------------------------- */
  /* Players                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Add a player. Returns null if the world is full. */
  addPlayer(name, token) {
    const slot = this.slots.indexOf(null);
    if (slot < 0) return null;
    const p = new Player(this.nextId(), name, token, slot);
    this.slots[slot] = p;
    this.players.set(p.id, p);
    grantLoadout(p, this.mode);
    this.respawnPlayer(p);
    this.rebuildActive();
    this.rules.onPlayerJoined(p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.slots[p.slot] = null;
    this.rebuildActive();
    this.rules.onPlayerLeft(p);
  }

  setPlayerActive(p, active) {
    p.active = active;
    p.connected = active;
    p.inputQueue.length = 0;
    this.rebuildActive();
  }

  rebuildActive() {
    this.activePlayers = [...this.players.values()].filter((p) => p.active);
  }

  /** Accept validated inputs from the transport layer. */
  queueInputs(p, inputs) {
    if (inputs.length) this.observeArrival(p, inputs[inputs.length - 1].seq);
    for (const inp of inputs) {
      if (inp.seq <= p.lastAckSeq) continue; // duplicate / replay
      const last = p.inputQueue.length ? p.inputQueue[p.inputQueue.length - 1].seq : p.lastAckSeq;
      if (inp.seq <= last) continue;
      p.inputQueue.push(inp);
    }
    // Hard cap (1 s of commands): only a client sending faster than real time
    // reaches it. The oldest commands are dropped.
    while (p.inputQueue.length > NET.MAX_INPUT_QUEUE) {
      const dropped = p.inputQueue.shift();
      p.lastAckSeq = dropped.seq;
      p.net.dropped++;
    }
  }

  /**
   * Input arrival jitter estimate -> jitter buffer target.
   *
   * WHAT: for each packet, offset = (server tick on arrival) - (newest seq in
   * the packet). Client ticks and server ticks advance at the same rate, so on
   * a perfect network the offset is constant; any extra delay shows up as a
   * larger offset. Lateness = offset - (smallest offset in the window).
   * The buffer target is the 90th-percentile lateness (in ticks) + 1.
   *
   * WHY: holding exactly as many commands as the network usually needs gives
   * smooth one-per-tick consumption with the least added input delay. Using
   * p90 rather than the maximum ignores rare loss stalls (TCP retransmits),
   * which catch-up handles better than a permanently deeper buffer.
   *
   * LIMITS: window of INPUT_JITTER_WINDOW packets; target clamped to
   * [INPUT_BUFFER_MIN, INPUT_BUFFER_MAX]; recomputed every 16 packets.
   */
  observeArrival(p, newestSeq) {
    p.lastArrivalTick = this.tick;
    const n = NET.INPUT_JITTER_WINDOW;
    p.arrivalOffsets[p.arrivalCount % n] = this.tick - newestSeq;
    p.arrivalCount++;
    if (p.arrivalCount % 16 !== 0) return;
    const count = Math.min(p.arrivalCount, n);
    const sorted = Array.from(p.arrivalOffsets.subarray(0, count)).sort((a, b) => a - b);
    const lateness = sorted[Math.floor(count * 0.9)] - sorted[0];
    p.bufferTarget = clamp(Math.ceil(lateness) + 1, NET.INPUT_BUFFER_MIN, NET.INPUT_BUFFER_MAX);
  }

  /**
   * Choose a spawn point maximising the distance to enemies and opponents
   * (spawn safety). Ties are broken randomly so spawns are not predictable.
   */
  findSpawn(p) {
    const spawns = this.arena.spawns;
    let best = spawns[0], bestScore = -Infinity;
    for (const s of spawns) {
      let nearest = 1e9;
      for (const e of this.enemies.active) nearest = Math.min(nearest, Math.hypot(e.x - s.x, e.y - s.y, e.z - s.z));
      if (this.mode === MODES.FFA) {
        for (const o of this.activePlayers) {
          if (o === p || !o.alive) continue;
          nearest = Math.min(nearest, Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z));
        }
      }
      const safeBonus = nearest >= MATCH.SPAWN_SAFE_RADIUS ? 100 : 0;
      const score = safeBonus + Math.min(nearest, 60) + this.rng() * 8;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /** Teleport to a safe spawn while keeping health, ammo and Pulse (out-of-bounds recovery). */
  respawnPlayerKeepState(p) {
    const s = this.findSpawn(p);
    const m = p.move;
    m.x = s.x; m.y = s.y + 0.05; m.z = s.z;
    m.vx = 0; m.vy = 0; m.vz = 0;
    m.grappling = 0;
    m.onGround = 0;
    p.historyTicks.fill(-1);
  }

  /** Rules helper: grant Pulse Charge through the capped economy. */
  addPulseFor(p, amount) {
    addPulse(this, p, amount);
  }

  respawnPlayer(p) {
    const s = this.findSpawn(p);
    const prot = this.mode === MODES.FFA ? MATCH.SPAWN_PROTECTION_S : 1;
    p.spawnAt(s.x + (this.rng() - 0.5), s.y + 0.05, s.z + (this.rng() - 0.5), s.yaw, prot);
    p.move.speedMult = p.mods.speedMult;
  }

  /* ---------------------------------------------------------------------- */
  /* Main step                                                               */
  /* ---------------------------------------------------------------------- */

  step() {
    const dt = SIM.DT;
    this.tick++;
    this.time += dt;
    this.env.fractureCount = this.fractureCount;

    this.rules.preUpdate(dt);

    // 1) players: consume inputs through their jitter buffers (see simulatePlayerInputs)
    for (const p of this.activePlayers) this.simulatePlayerInputs(p);

    // 2) per-tick player upkeep
    for (const p of this.activePlayers) this.updatePlayerTick(p, dt);
    if (this.mode === MODES.COOP) updateTethers(this);

    // 3) world systems
    this.enemies.update(dt);
    this.updateProjectiles(dt);
    this.updateEchoes();
    this.updateFractures(dt);
    this.updatePickups(dt);
    this.updateHazards(dt);
    this.updateProps(dt);
    this.updateArenaPulse(dt);

    // 4) mode rules (waves, timers, win/lose)
    this.rules.update(dt);

    for (const p of this.activePlayers) p.recordHistory(this.tick);
  }

  /**
   * Consume queued input commands for one player this tick.
   *
   * JITTER BUFFER: commands arrive in bursts (clients batch them at 30 Hz and
   * networks add jitter), but the simulation needs one per tick. Consuming
   * whatever is queued would make players lurch (two steps, then none) for
   * everyone watching them. Instead the server consumes exactly one command
   * per tick while keeping `bufferTarget` commands in reserve (the target
   * follows measured arrival jitter, see observeArrival). When the queue runs
   * dry, consumption pauses until it refills to the target ("rebuffering").
   *
   * CATCH-UP: a backlog well above the target (e.g. after a TCP retransmission
   * stall) is drained at up to INPUT_CATCHUP_MAX_PER_TICK per tick.
   *
   * ANTI SPEED-HACK: every consumed command spends one unit of time credit,
   * which accrues at one per tick and is capped. However fast a client
   * sends, it can never be simulated faster than real time on average.
   *
   * IF MODIFIED: consuming more than one command per tick without a backlog
   * reintroduces lurching; removing the credit cap lets clients bank time.
   */
  simulatePlayerInputs(p) {
    const q = p.inputQueue;
    const net = p.net;
    p.inputCredit = Math.min(p.inputCredit + 1, NET.INPUT_CREDIT_MAX_TICKS);
    // Commands for ticks that were already simulated with neutral input (after
    // a stall) are acknowledged but not re-simulated, keeping time consistent.
    while (p.owedSkips > 0 && q.length) {
      const inp = q.shift();
      p.lastAckSeq = inp.seq;
      p.lastInput = inp;
      p.owedSkips--;
      net.skipped++;
    }
    if (p.rebuffering && q.length >= p.bufferTarget) p.rebuffering = false;
    let budget = 0;
    if (!p.rebuffering && q.length) {
      const excess = q.length - p.bufferTarget;
      budget = excess > 6 ? NET.INPUT_CATCHUP_MAX_PER_TICK : excess > 2 ? 2 : 1;
    }
    let processed = 0;
    while (processed < budget && q.length && p.inputCredit >= 1) {
      const inp = q.shift();
      this.processInput(p, inp);
      p.lastAckSeq = inp.seq;
      p.lastInput = inp;
      p.inputCredit -= 1;
      p.lastInputTick = this.tick;
      processed++;
    }
    net.ticks++;
    if (processed > 1) net.catchup++;
    if (processed === 0) {
      net.starved++;
      p.rebuffering = true; // ran dry: refill to the target before resuming
      // Timeout is measured from the last packet ARRIVAL, so commands that are
      // queued (or being skipped after a stall) never trigger it.
      if ((this.tick - p.lastArrivalTick) * SIM.DT * 1000 > NET.INPUT_TIMEOUT_MS) {
        // Client stalled: keep simulating physics with a neutral command so the
        // player cannot freeze mid-air. The matching late commands are skipped.
        net.timeouts++;
        p.owedSkips = Math.min(p.owedSkips + 1, NET.MAX_INPUT_QUEUE);
        p.inputCredit = Math.max(0, p.inputCredit - 1);
        const li = p.lastInput;
        this.processInput(p, { seq: li.seq, mx: 0, mz: 0, yaw: li.yaw, pitch: li.pitch, buttons: 0, weapon: p.weaponIndex, viewTick: this.tick });
      }
    }
    net.queueSum += q.length;
  }

  processInput(p, inp) {
    const m = p.move;
    m.pulseReady = p.pulse >= PULSE.MAX ? 1 : 0;
    m.dead = p.alive ? 0 : 1;
    if (p.downed) m.stunTimer = Math.max(m.stunTimer, 0.25);
    p.viewTick = inp.viewTick;

    const ev = stepMovement(m, inp, this.env, SIM.DT);
    if (ev) {
      if (ev & MoveEvent.PHASE_START) onPhaseActivated(this, p);
      if (ev & MoveEvent.RING) {
        addPulse(this, p, PULSE.RING_BONUS * (m.grappling ? 1.5 : 1));
        this.emit(EV.RING, p.id, m.ringIndex);
      }
      if (ev & MoveEvent.HARD_LAND) landingShockwave(this, p, m.landSpeed);
      if (ev & MoveEvent.FELL_OUT) this.rules.onFellOut(p);
      if (ev & MoveEvent.GRAPPLE_ATTACH) this.emit(EV.GRAPPLE, p.id);
      if (ev & MoveEvent.DASH) this.emit(EV.DASH, p.id);
    }
    if (p.canAct) {
      updatePlayerWeapons(this, p, inp, SIM.DT);
      const b = inp.buttons;
      if (b & BTN.GRAVITY_P) tryGravityAbility(this, p);
      if (b & BTN.MELEE_P) tryMeleePulse(this, p);
      if (b & BTN.INTERACT_P) {
        if (!this.rules.onInteract(p) && this.mode === MODES.COOP) tryPulseTransfer(this, p);
      }
    }
    this.rules.onInputProcessed(p, inp);
    p.prevButtons = inp.buttons;
  }

  updatePlayerTick(p, dt) {
    tickAbilityCooldowns(p, dt);
    p.comboTimer -= dt;
    if (p.comboTimer <= 0) p.combo = 0;
    if (!p.alive) return;
    p.stats.timeAlive += dt;
    p.protectedTimer = Math.max(0, p.protectedTimer - dt);
    const m = p.move;

    // Shield regeneration after a delay without damage.
    if (this.time - p.lastDamageTime > PLAYER.SHIELD_REGEN_DELAY && p.shield < p.maxShield && !p.downed) {
      p.shield = Math.min(p.maxShield, p.shield + PLAYER.SHIELD_REGEN_RATE * p.mods.shieldRegenMult * dt);
    }
    if (p.downed) return;

    // Momentum: Pulse Charge for sustained high speed.
    const hs = Math.hypot(m.vx, m.vz);
    if (hs > PULSE.SPEED_THRESHOLD) addPulse(this, p, PULSE.PER_SECOND_AT_SPEED * dt);

    // Recovery zones heal.
    for (const z of this.arena.healZones) {
      if (Math.hypot(m.x - z.x, m.z - z.z) < z.r && Math.abs(m.y - z.y) < 1.2) {
        p.health = Math.min(p.maxHealth, p.health + 14 * dt);
      }
    }
    // Arena hazards (energy channels).
    for (const h of this.arena.hazards) {
      if (m.x > h.minX && m.x < h.maxX && m.z > h.minZ && m.z < h.maxZ && m.y < h.maxY && m.phaseTimer <= 0) {
        this.applyDamage(p, h.dps * dt, null, { x: m.x, y: m.y, z: m.z, environment: true });
      }
    }
    // Slide attack: sliding fast into light enemies staggers them.
    if (m.slideTimer > 0 && hs > 9) {
      this.spatial.query(m.x, m.y + 0.6, m.z, 1.6, _nb, null);
      for (const e of _nb) {
        if (!e.targetable || !e.def.light || e.stunTimer > 0) continue;
        e.stun(0.9);
        this.applyDamage(e, 12 * p.mods.damageMult, p, { weapon: -1, x: e.x, y: e.y, z: e.z, slide: true });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Damage                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Single entry point for all damage. Never called with client-provided
   * numbers: every caller computes damage from server-side state.
   * @param {object} target Player or Enemy
   * @param {number} amount
   * @param {object|null} source Player, Enemy or null (environment)
   * @param {object} opts {weapon, headshot, x, y, z, ...}
   */
  applyDamage(target, amount, source, opts = {}) {
    if (!(amount > 0)) return;
    amount = Math.min(amount, 5000);
    if (target.isEnemy) this.damageEnemy(target, amount, source, opts);
    else if (target.isPlayer) this.damagePlayer(target, amount, source, opts);
  }

  damageEnemy(e, amount, source, opts) {
    if (!e.targetable) return;
    let dmg = amount;
    if (e.type === EnemyType.TITAN) {
      // Armoured body; the core is the weak point (wide open after phase changes).
      dmg *= opts.headshot ? (e.weakOpenTimer > 0 ? 3 : 1.6) : (e.weakOpenTimer > 0 ? 0.8 : 0.5);
    }
    if (e.shield > 0) {
      const absorbed = Math.min(e.shield, dmg);
      e.shield -= absorbed;
      dmg -= absorbed;
    }
    e.hp -= dmg;
    e.lastDamageTime = this.time;
    if (e.state === AIState.SUPPORT && e.type === EnemyType.RUNNER) e.windupDamage += amount;
    if (e.type === EnemyType.STALKER && e.state === AIState.EVADE && amount > e.maxHp * 0.3) e.setState(AIState.RETREAT);
    if (source && source.isPlayer) {
      e.lastHitBy = source;
      e.lastHitTime = this.time;
      source.stats.damage += amount;
      source.lastDealtDamageTime = this.time;
      if (opts.headshot) source.stats.headshots++;
      addPulse(this, source, amount * PULSE.PER_DAMAGE + (opts.headshot ? PULSE.HEADSHOT_BONUS : 0));
      this.emit(EV.HIT, source.id, e.id, Math.round(amount), opts.headshot ? 1 : 0, q(opts.x ?? e.x), q(opts.y ?? e.y), q(opts.z ?? e.z), 1);
    }
    if (e.hp <= 0) this.killEnemy(e, source && source.isPlayer ? source : null, opts);
  }

  damagePlayer(p, amount, source, opts) {
    if (!p.canAct || !p.alive) return;
    if (source === p) return; // no self damage
    if (source && source.isPlayer && !this.rules.allowPvP) return;
    if (p.protectedTimer > 0) return;
    let dmg = amount;
    if (p.move.phaseTimer > 0) dmg *= 1 - PULSE.PHASE_DAMAGE_REDUCTION;
    if (this.mode === MODES.TRAINING) dmg = 0;
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, dmg);
      p.shield -= absorbed;
      dmg -= absorbed;
    }
    p.health -= dmg;
    p.lastDamageTime = this.time;
    if (amount >= 1) p.combo = 0; // chaining requires not taking damage
    if (source && source.isPlayer) {
      p.damagers.set(source.id, this.time);
      source.stats.damage += amount;
      source.lastDealtDamageTime = this.time;
      if (opts.headshot) source.stats.headshots++;
      addPulse(this, source, amount * PULSE.PER_DAMAGE + (opts.headshot ? PULSE.HEADSHOT_BONUS : 0));
      this.emit(EV.HIT, source.id, p.id, Math.round(amount), opts.headshot ? 1 : 0, q(opts.x ?? p.x), q(opts.y ?? p.y + 1), q(opts.z ?? p.z), 0);
    }
    if (amount >= 1) {
      const sx = source ? source.x : (opts.x ?? p.x), sy = source ? source.y : (opts.y ?? p.y), sz = source ? source.z : (opts.z ?? p.z);
      this.emit(EV.DAMAGED, p.id, Math.round(amount), q(sx), q(sy), q(sz));
    }
    if (p.health <= 0) {
      p.health = 0;
      this.rules.onPlayerKilled(p, source, opts);
    }
  }

  /** Kill an enemy and award credit. */
  killEnemy(e, killer, opts = {}) {
    if (!e.active || e.state === AIState.DEAD) return;
    const environmental = !!opts.environmental || this.time - e.inFractureTime < 0.3;
    if (!killer && e.lastHitBy && this.time - e.lastHitTime < 5) killer = e.lastHitBy;
    this.emit(EV.DEATH_FX, e.type, q(e.x), q(e.y), q(e.z), e.elite ? 1 : 0);
    if (killer && killer.isPlayer && this.players.has(killer.id)) {
      const k = killer;
      k.stats.kills++;
      k.combo = Math.min(k.combo + 1, 10);
      k.comboTimer = 4;
      let gain = PULSE.PER_KILL + e.def.pulse * 0.3;
      const airborne = !k.move.onGround;
      if (airborne) gain += PULSE.AIRBORNE_KILL_BONUS;
      if (opts.headshot) gain += PULSE.HEADSHOT_BONUS;
      if (environmental) gain += PULSE.ENVIRONMENT_KILL_BONUS;
      gain += Math.min(PULSE.COMBO_BONUS_CAP, k.combo * PULSE.COMBO_BONUS_PER_STEP);
      addPulse(this, k, gain);
      if (k.mods.leech > 0) k.health = Math.min(k.maxHealth, k.health + k.mods.leech);
      const flags = (opts.headshot ? 1 : 0) | (airborne ? 2 : 0) | (environmental ? 4 : 0) | (e.elite ? 8 : 0);
      this.emit(EV.KILL, k.id, k.name, e.id, e.name || e.def.name, opts.weapon ?? -1, flags);
    }
    this.dropLoot(e);
    this.enemies.release(e);
    this.rules.onEnemyKilled(e, killer, { ...opts, environmental });
  }

  dropLoot(e) {
    if (e.type === EnemyType.DUMMY) return;
    const r = this.rng();
    if (e.def.boss) {
      for (let i = 0; i < 6; i++) this.spawnPickup(i % 2 ? PICKUP.HEALTH : PICKUP.PULSE, e.x + (this.rng() - 0.5) * 4, e.y, e.z + (this.rng() - 0.5) * 4);
      return;
    }
    if (r < 0.12 * (e.elite ? 3 : 1)) this.spawnPickup(PICKUP.HEALTH, e.x, e.y, e.z);
    else if (r < 0.3) this.spawnPickup(PICKUP.PULSE, e.x, e.y, e.z);
    else if (r < 0.36) this.spawnPickup(PICKUP.AMMO, e.x, e.y, e.z);
  }

  damageReactor(amount) {
    if (!this.reactor || this.reactor.hp <= 0) return;
    this.reactor.hp = Math.max(0, this.reactor.hp - amount);
    this.emit(EV.REACTOR_HIT, Math.round(amount));
  }

  knockback(target, vx, vy, vz) {
    if (target.isPlayer) {
      if (!target.canAct) return;
      const m = target.move;
      m.vx += vx; m.vy = Math.max(m.vy, 0) + vy; m.vz += vz;
      m.onGround = 0;
    } else if (target.isEnemy) {
      const k = 1 / Math.max(1, target.def.mass);
      target.vx += vx * k; target.vy += vy * k; target.vz += vz * k;
    }
  }

  /** Iterate damageable targets near a point, from the perspective of `source`. */
  forEachTargetNear(source, x, y, z, r, cb) {
    this.spatial.query(x, y, z, r + 3.5, _nb, null);
    const list = _nb.slice(); // callbacks may kill enemies and mutate the hash
    for (const e of list) {
      if (!e.targetable) continue;
      const rr = r + e.radius;
      if ((e.x - x) ** 2 + (e.y - y) ** 2 + (e.z - z) ** 2 <= rr * rr) cb(e, true);
    }
    if (this.rules.allowPvP) {
      for (const p of this.activePlayers) {
        if (p === source || !p.canAct) continue;
        if ((p.x - x) ** 2 + (p.y + 0.9 - y) ** 2 + (p.z - z) ** 2 <= (r + 0.6) ** 2) cb(p, false);
      }
    }
  }

  forEachEnemy(cb) {
    const list = this.enemies.active.slice();
    for (const e of list) if (e.active) cb(e);
  }

  damageEnemiesInRadius(x, y, z, r, dmg, source, opts = {}) {
    this.forEachTargetNear(source, x, y, z, r, (t) => {
      const d = Math.hypot(t.x - x, t.y - y, t.z - z);
      const f = opts.falloff ? clamp(1 - d / (r + 1), 0.3, 1) : 1;
      this.applyDamage(t, dmg * f, source, { ...opts, x: t.x, y: t.y, z: t.z });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Props                                                                   */
  /* ---------------------------------------------------------------------- */

  damageProp(c, amount) {
    if (!c || c.kind !== ColliderKind.PROP || !c.alive) return;
    c.hp -= amount;
    if (c.hp <= 0) {
      c.alive = false;
      c.respawnAt = this.time + 45;
      this.emit(EV.PROP_BREAK, c.id);
      // Debris burst damages nearby enemies a little (environmental).
      this.emit(EV.EXPLODE, q((c.minX + c.maxX) / 2), q(c.maxY), q((c.minZ + c.maxZ) / 2), 2.5, 4);
    }
  }

  damagePropsInRadius(x, y, z, r, amount) {
    for (const c of this.arena.colliders) {
      if (c.kind !== ColliderKind.PROP || !c.alive) continue;
      const cx = clamp(x, c.minX, c.maxX), cy = clamp(y, c.minY, c.maxY), cz = clamp(z, c.minZ, c.maxZ);
      if ((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2 <= r * r) this.damageProp(c, amount);
    }
  }

  updateProps() {
    if ((this.tick & 31) !== 0) return;
    for (const c of this.arena.colliders) {
      if (c.kind !== ColliderKind.PROP || c.alive || this.time < c.respawnAt) continue;
      // Only restore cover when nobody is standing inside it.
      let blocked = false;
      for (const p of this.activePlayers) {
        if (p.x + 0.5 > c.minX && p.x - 0.5 < c.maxX && p.z + 0.5 > c.minZ && p.z - 0.5 < c.maxZ && p.y < c.maxY + 0.2) blocked = true;
      }
      if (blocked) continue;
      c.alive = true;
      c.hp = c.maxHp;
      this.emit(EV.PROP_BREAK, -c.id - 1); // negative = restored
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Hitscan with lag compensation                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Clamp the client's reported view tick to the allowed rewind window.
   *
   * Lag compensation: the client renders remote entities ~INTERP_DELAY_MS in
   * the past. To make "what you see is what you hit" true, the server tests
   * shots against where targets were at the tick the shooter was looking at.
   * The window is capped (LAG_COMP_MAX_MS) so high-latency players cannot
   * shoot targets that have long since moved behind cover.
   */
  clampRewindTick(viewTick) {
    return clamp(viewTick | 0, this.tick - MAX_REWIND_TICKS, this.tick);
  }

  /**
   * Trace a shot through the world.
   * @returns {object} reused result {hits, count, endX, endY, endZ, prop}
   */
  traceShot(shooter, ox, oy, oz, dx, dy, dz, range, pierce, rewindTick) {
    const res = this.traceResult;
    res.count = 0;
    res.prop = null;
    const phased = shooter.isPlayer && shooter.move.phaseTimer > 0;
    const wall = raycastArena(this.env, ox, oy, oz, dx, dy, dz, range, phased, false);
    const maxT = wall.t >= 0 ? wall.t : range;
    const wallCollider = wall.collider;
    let n = 0;

    // enemies (rewound)
    if (!shooter.isEnemy) {
      for (const e of this.enemies.active) {
        if (!e.targetable) continue;
        e.positionAt(rewindTick, _pos);
        if (e.def.humanoid) {
          const r = rayHumanoid(ox, oy, oz, dx, dy, dz, _pos.x, _pos.y - ROGUE.CENTER, _pos.z, e.move && e.move.slideTimer > 0 ? PLAYER.SLIDE_DROP : 0, 0, maxT);
          if (r.t < 0 || n >= MAX_TRACE_HITS) continue;
          const h = res.hits[n++];
          h.target = e; h.t = r.t; h.head = r.head;
          continue;
        }
        let t = raySphere(ox, oy, oz, dx, dy, dz, _pos.x, _pos.y, _pos.z, e.radius, maxT);
        let head = false;
        if (e.weakPoint(_pos.x, _pos.y, _pos.z, _wp)) {
          const tw = raySphere(ox, oy, oz, dx, dy, dz, _wp.x, _wp.y, _wp.z, _wp.r, maxT);
          if (tw >= 0 && (t < 0 || tw <= t + 0.3)) { t = tw; head = true; }
        }
        if (t < 0 || n >= MAX_TRACE_HITS) continue;
        const h = res.hits[n++];
        h.target = e; h.t = t; h.head = head;
      }
    }
    // players (rewound) — only when PvP is enabled
    if (this.rules.allowPvP && shooter.isPlayer) {
      for (const p of this.activePlayers) {
        if (p === shooter || !p.canAct) continue;
        p.positionAt(rewindTick, _pos);
        const r = rayHumanoid(ox, oy, oz, dx, dy, dz, _pos.x, _pos.y, _pos.z, p.move.slideTimer > 0 ? PLAYER.SLIDE_DROP : 0, 0, maxT);
        if (r.t < 0 || n >= MAX_TRACE_HITS) continue;
        const h = res.hits[n++];
        h.target = p; h.t = r.t; h.head = r.head;
      }
    }
    // sort by distance (insertion sort; n is tiny)
    for (let i = 1; i < n; i++) {
      const h = res.hits[i];
      let j = i - 1;
      while (j >= 0 && res.hits[j].t > h.t) { res.hits[j + 1] = res.hits[j]; j--; }
      res.hits[j + 1] = h;
    }
    const allowed = Math.min(n, pierce + 1);
    for (let i = 0; i < allowed; i++) {
      const h = res.hits[i];
      h.x = ox + dx * h.t; h.y = oy + dy * h.t; h.z = oz + dz * h.t;
    }
    res.count = allowed;
    const endT = allowed > 0 && allowed === pierce + 1 ? res.hits[allowed - 1].t : maxT;
    res.endX = ox + dx * endT; res.endY = oy + dy * endT; res.endZ = oz + dz * endT;
    if (wallCollider && wallCollider.kind === ColliderKind.PROP && endT >= maxT - 1e-3) res.prop = wallCollider;
    return res;
  }

  /** Echo Repeater: replay a shot along the same trajectory later. */
  scheduleEcho(p, ox, oy, oz, dx, dy, dz, delay, damage, weapon) {
    const slot = this.echoes.find((e) => !e.active);
    if (!slot) return;
    slot.active = true;
    slot.time = this.time + delay;
    slot.owner = p;
    slot.ox = ox; slot.oy = oy; slot.oz = oz;
    slot.dx = dx; slot.dy = dy; slot.dz = dz;
    slot.damage = damage;
    slot.weapon = weapon;
  }

  updateEchoes() {
    for (const e of this.echoes) {
      if (!e.active || this.time < e.time) continue;
      e.active = false;
      const p = e.owner;
      if (!p || !this.players.has(p.id) || !p.canAct) continue;
      const res = this.traceShot(p, e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, 150, 0, this.tick);
      for (let i = 0; i < res.count; i++) {
        const h = res.hits[i];
        this.applyDamage(h.target, e.damage * (h.head ? 1.6 : 1), p, { weapon: e.weapon, headshot: h.head, x: h.x, y: h.y, z: h.z });
      }
      if (res.prop) this.damageProp(res.prop, e.damage);
      this.emit(EV.FIRE, p.id, e.weapon, q(e.ox), q(e.oy), q(e.oz), q(res.endX), q(res.endY), q(res.endZ), -1);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Projectiles                                                             */
  /* ---------------------------------------------------------------------- */

  spawnProjectile(o) {
    // Round-robin search for a free slot (bounded pool; oldest is never evicted).
    const pool = this.projectiles;
    for (let k = 0; k < pool.length; k++) {
      const i = (this.projectileCursor + k) % pool.length;
      const pr = pool[i];
      if (pr.active) continue;
      this.projectileCursor = (i + 1) % pool.length;
      pr.active = true;
      pr.id = this.nextId();
      pr.kind = o.kind;
      pr.owner = o.owner;
      pr.team = o.team;
      pr.x = o.x; pr.y = o.y; pr.z = o.z;
      pr.vx = o.vx; pr.vy = o.vy; pr.vz = o.vz;
      pr.gravity = o.gravity || 0;
      pr.life = o.life || 3;
      pr.radius = o.radius || 0.2;
      pr.damage = o.damage || 0;
      pr.splashDamage = o.splashDamage || 0;
      pr.splashRadius = o.splashRadius || 0;
      pr.fracture = o.fracture || null;
      pr.weapon = o.weapon ?? -1;
      pr.lag = Math.max(0, Math.min(o.lag || 0, MAX_REWIND_TICKS)); // rewind ticks for lag compensation
      pr.stunLight = o.stunLight || 0;
      pr.nearMask = 0;
      return pr;
    }
    return null;
  }

  updateProjectiles(dt) {
    for (const pr of this.projectiles) {
      if (!pr.active) continue;
      pr.life -= dt;
      if (pr.life <= 0) { this.impactProjectile(pr, null, pr.x, pr.y, pr.z, false); continue; }
      pr.vy -= pr.gravity * dt;
      if (this.fractureCount > 0) {
        accumulateFractureDeltaV(this.fractures, this.fractureCount, pr.x, pr.y, pr.z, 0.5, dt, _dv);
        pr.vx += _dv.x; pr.vy += _dv.y; pr.vz += _dv.z;
      }
      const ox = pr.x, oy = pr.y, oz = pr.z;
      const nx = ox + pr.vx * dt, ny = oy + pr.vy * dt, nz = oz + pr.vz * dt;
      const sx = nx - ox, sy = ny - oy, sz = nz - oz;
      const segLen = Math.hypot(sx, sy, sz) || 1e-6;
      const dx = sx / segLen, dy = sy / segLen, dz = sz / segLen;

      // Entity hits along the segment
      let hitTarget = null, hitT = segLen, hitHead = false;
      if (pr.team === TEAM.PLAYERS) {
        // Lag compensation: a player's projectile is tested against targets where the shooter
        // saw them (pr.lag ticks in the past), exactly like hitscan shots.
        const rewind = this.tick - pr.lag;
        this.spatial.query((ox + nx) / 2, (oy + ny) / 2, (oz + nz) / 2, segLen / 2 + 4 + pr.lag * 0.25, _nb, null);
        for (const e of _nb) {
          if (!e.targetable) continue;
          e.positionAt(rewind, _pos);
          if (e.def.humanoid) {
            const r = rayHumanoid(ox, oy, oz, dx, dy, dz, _pos.x, _pos.y - ROGUE.CENTER, _pos.z, e.move && e.move.slideTimer > 0 ? PLAYER.SLIDE_DROP : 0, pr.radius, segLen);
            if (r.t >= 0 && r.t < hitT) { hitT = r.t; hitTarget = e; hitHead = r.head; }
            continue;
          }
          const rr = e.radius + pr.radius;
          if (pointSegmentDistSq(_pos.x, _pos.y, _pos.z, ox, oy, oz, nx, ny, nz) <= rr * rr) {
            const t = Math.max(0, (_pos.x - ox) * dx + (_pos.y - oy) * dy + (_pos.z - oz) * dz);
            if (t < hitT) { hitT = t; hitTarget = e; hitHead = false; }
          }
        }
        if (this.rules.allowPvP) {
          for (const p of this.activePlayers) {
            if (p === pr.owner || !p.canAct) continue;
            p.positionAt(rewind, _pos);
            const r = rayHumanoid(ox, oy, oz, dx, dy, dz, _pos.x, _pos.y, _pos.z, p.move.slideTimer > 0 ? PLAYER.SLIDE_DROP : 0, pr.radius, segLen);
            if (r.t >= 0 && r.t < hitT) { hitT = r.t; hitTarget = p; hitHead = r.head; }
          }
        }
      } else {
        for (const p of this.activePlayers) {
          if (!p.canAct) continue;
          const d2 = pointSegmentDistSq(p.x, p.y + 0.9, p.z, ox, oy, oz, nx, ny, nz);
          if (d2 > 25) continue;
          if (tryDeflect(this, p, pr)) break;
          const r = rayHumanoid(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, p.move.slideTimer > 0 ? PLAYER.SLIDE_DROP : 0, pr.radius, segLen);
          if (r.t >= 0) {
            if (p.move.phaseTimer > 0) continue; // Phase Break: enemy projectiles pass through
            hitTarget = p; hitT = r.t;
            break;
          }
          // Near-miss dodge: rewarded once per projectile per player.
          const nm = 0.55 + pr.radius + PULSE.NEAR_MISS_RADIUS;
          if (d2 <= nm * nm && !(pr.nearMask & (1 << p.slot))) {
            pr.nearMask |= 1 << p.slot;
            addPulse(this, p, PULSE.NEAR_MISS);
            this.emit(EV.NEAR_MISS, p.id);
          }
        }
        if (pr.team !== TEAM.ENEMIES) { pr.x = nx; pr.y = ny; pr.z = nz; continue; } // just deflected
        if (!hitTarget && this.reactor && this.reactor.hp > 0) {
          const r = this.reactor;
          const rr = r.radius + pr.radius;
          if (pointSegmentDistSq(r.x, r.y, r.z, ox, oy, oz, nx, ny, nz) <= rr * rr) {
            this.damageReactor(pr.damage);
            this.impactProjectile(pr, null, nx, ny, nz, true);
            continue;
          }
        }
      }

      // Arena geometry
      const wall = raycastArena(this.env, ox, oy, oz, dx, dy, dz, Math.min(segLen, hitT), false, false);
      if (wall.t >= 0) {
        const ix = ox + dx * wall.t, iy = oy + dy * wall.t, iz = oz + dz * wall.t;
        if (wall.collider.kind === ColliderKind.PROP && pr.team === TEAM.PLAYERS) this.damageProp(wall.collider, pr.damage);
        this.impactProjectile(pr, null, ix - dx * 0.05, iy - dy * 0.05, iz - dz * 0.05, true);
        continue;
      }
      if (hitTarget) {
        const ix = ox + dx * hitT, iy = oy + dy * hitT, iz = oz + dz * hitT;
        const headMult = hitHead && pr.weapon >= 0 ? WEAPONS[pr.weapon].headMult : 1;
        this.applyDamage(hitTarget, pr.damage * headMult, pr.owner, { weapon: pr.weapon, headshot: hitHead, x: ix, y: iy, z: iz });
        if (pr.stunLight && hitTarget.isEnemy && hitTarget.def.light) hitTarget.stun(pr.stunLight);
        if (pr.owner && pr.owner.isPlayer && pr.kind === PK.PELLET) pr.owner.stats.hits += 0.1; // 10 pellets == one hit
        this.impactProjectile(pr, hitTarget, ix, iy, iz, true);
        continue;
      }
      pr.x = nx; pr.y = ny; pr.z = nz;
      if (pr.y < this.arena.killY) pr.active = false;
    }
  }

  impactProjectile(pr, directTarget, x, y, z, collided) {
    pr.active = false;
    if (pr.kind === PK.PELLET && !collided) return;
    if (pr.splashRadius > 0) {
      this.emit(EV.EXPLODE, q(x), q(y), q(z), pr.splashRadius, pr.kind === PK.ORB ? 1 : pr.team === TEAM.ENEMIES ? 2 : 0);
      if (pr.team === TEAM.PLAYERS) {
        this.forEachTargetNear(pr.owner, x, y, z, pr.splashRadius, (t) => {
          if (t === directTarget) return;
          this.applyDamage(t, pr.splashDamage, pr.owner, { weapon: pr.weapon, x: t.x, y: t.y, z: t.z });
        });
        this.damagePropsInRadius(x, y, z, pr.splashRadius, pr.splashDamage);
      } else {
        for (const p of this.activePlayers) {
          if (!p.canAct || p === directTarget || p.move.phaseTimer > 0) continue;
          if (Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z) <= pr.splashRadius) this.applyDamage(p, pr.splashDamage, pr.owner, { x, y, z });
        }
      }
    } else if (collided && pr.kind !== PK.PELLET) {
      this.emit(EV.EXPLODE, q(x), q(y), q(z), 0.8, pr.team === TEAM.ENEMIES ? 2 : 3);
    }
    if (pr.fracture) {
      const f = pr.fracture;
      this.spawnFracture(x, y, z, f.radius, f.strength, f.duration, f.mode, pr.owner ? pr.owner.id : 0);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Fractures, pickups, hazards                                             */
  /* ---------------------------------------------------------------------- */

  spawnFracture(x, y, z, radius, strength, duration, mode, owner) {
    if (this.fractureCount >= FRACTURE.MAX_ACTIVE) return null;
    const f = makeFracture(this.nextId(), x, y, z, radius, strength, duration, mode, owner);
    this.fractures[this.fractureCount++] = f;
    this.env.fractureCount = this.fractureCount;
    return f;
  }

  updateFractures(dt) {
    let j = 0;
    for (let i = 0; i < this.fractureCount; i++) {
      const f = this.fractures[i];
      f.age += dt;
      if (f.age < f.duration) this.fractures[j++] = f;
    }
    this.fractures.length = j;
    this.fractureCount = j;
    this.env.fractureCount = j;
  }

  spawnPickup(kind, x, y, z) {
    const pk = this.pickups.find((p) => !p.active);
    if (!pk) return;
    pk.active = true;
    pk.id = this.nextId();
    pk.kind = kind;
    pk.x = x; pk.y = y; pk.z = z;
    pk.vx = (this.rng() - 0.5) * 3; pk.vy = 3; pk.vz = (this.rng() - 0.5) * 3;
    pk.life = 20;
  }

  updatePickups(dt) {
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      pk.life -= dt;
      if (pk.life <= 0) { pk.active = false; continue; }
      pk.vy -= 6 * dt;
      if (this.fractureCount > 0) {
        accumulateFractureDeltaV(this.fractures, this.fractureCount, pk.x, pk.y, pk.z, 0.4, dt, _dv);
        pk.vx += _dv.x; pk.vy += _dv.y; pk.vz += _dv.z;
      }
      pk.vx *= 0.98; pk.vz *= 0.98;
      const sp = Math.hypot(pk.vx, pk.vy, pk.vz);
      const d = Math.max(sp * dt, 1e-4);
      const hit = raycastArena(this.env, pk.x, pk.y, pk.z, pk.vx / (sp || 1), pk.vy / (sp || 1), pk.vz / (sp || 1), d + 0.3, false, false);
      if (hit.t >= 0) { pk.vx *= 0.3; pk.vz *= 0.3; pk.vy = Math.abs(pk.vy) * 0.2; }
      else { pk.x += pk.vx * dt; pk.y += pk.vy * dt; pk.z += pk.vz * dt; }
      if (pk.y < this.arena.killY) { pk.active = false; continue; }
      for (const p of this.activePlayers) {
        if (!p.canAct) continue;
        if (Math.hypot(p.x - pk.x, p.y + 0.9 - pk.y, p.z - pk.z) < 1.8) {
          if (pk.kind === PICKUP.HEALTH) p.health = Math.min(p.maxHealth, p.health + 25);
          else if (pk.kind === PICKUP.PULSE) addPulse(this, p, 10);
          else {
            const ws = p.weapons[p.weaponIndex];
            ws.ammo = p.magazineOf(ws);
          }
          this.emit(EV.PICKUP, p.id, pk.kind);
          pk.active = false;
          break;
        }
      }
    }
  }

  spawnHazard(x, y, z, r, dps, life, owner) {
    const h = this.hazards.find((hz) => !hz.active);
    if (!h) return;
    h.active = true;
    h.id = this.nextId();
    h.x = x; h.y = y; h.z = z; h.r = r; h.dps = dps; h.life = life; h.maxLife = life; h.owner = owner;
  }

  updateHazards(dt) {
    for (const h of this.hazards) {
      if (!h.active) continue;
      h.life -= dt;
      if (h.life <= 0) { h.active = false; continue; }
      for (const p of this.activePlayers) {
        if (!p.canAct || p.move.phaseTimer > 0) continue;
        if (Math.hypot(p.x - h.x, p.y + 0.5 - h.y, p.z - h.z) < h.r + 0.4) {
          this.applyDamage(p, h.dps * dt, h.owner && h.owner.active ? h.owner : null, { x: h.x, y: h.y, z: h.z });
        }
      }
    }
  }

  /** Reactor Null's periodic arena-wide pulse (telegraphed). */
  updateArenaPulse(dt) {
    const ph = this.arena.pulseHazard;
    if (!ph || this.mode === MODES.TRAINING) return;
    this.arenaPulseTimer -= dt;
    if (!this.arenaPulseTelegraphed && this.arenaPulseTimer <= ph.telegraph) {
      this.arenaPulseTelegraphed = true;
      this.emit(EV.ARENA_PULSE, 0);
    }
    if (this.arenaPulseTimer <= 0) {
      this.arenaPulseTimer = ph.interval;
      this.arenaPulseTelegraphed = false;
      this.emit(EV.ARENA_PULSE, 1);
      for (const p of this.activePlayers) {
        if (!p.canAct || !p.move.onGround || p.y > ph.safeY) continue;
        this.applyDamage(p, ph.damage, null, { x: 0, y: 0, z: 0, environment: true });
      }
      // The reactor pulse also scorches enemies hugging the core.
      if (this.reactor) {
        this.forEachEnemy((e) => {
          if (Math.hypot(e.x - this.reactor.x, e.z - this.reactor.z) < 14) this.applyDamage(e, 80, null, { environmental: true });
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Snapshots                                                               */
  /* ---------------------------------------------------------------------- */

  /** Snapshot data shared by every client in the match. */
  buildSharedSnapshot(includeScoreboard) {
    const p = [];
    for (const pl of this.activePlayers) {
      const m = pl.move;
      let flags = 0;
      if (m.grappling) flags |= PF.GRAPPLING;
      if (m.phaseTimer > 0) flags |= PF.PHASED;
      if (pl.downed) flags |= PF.DOWNED;
      if (!pl.alive) flags |= PF.DEAD;
      if (pl.protectedTimer > 0) flags |= PF.PROTECTED;
      if (m.slideTimer > 0) flags |= PF.SLIDING;
      if (m.boostTimer > 0) flags |= PF.BOOSTED;
      if (pl.weapons[pl.weaponIndex].charging) flags |= PF.CHARGING;
      if (pl.revealed) flags |= PF.REVEALED;
      p.push([
        pl.id, quantize(m.x), quantize(m.y), quantize(m.z), quantize(m.yaw, 3), quantize(m.pitch, 3),
        m.state, flags, Math.round((pl.health / pl.maxHealth) * 100), pl.weaponIndex,
        m.grappling ? quantize(m.gx, 1) : 0, m.grappling ? quantize(m.gy, 1) : 0, m.grappling ? quantize(m.gz, 1) : 0,
        pl.tetherPartner, pl.slot, Math.round(pl.tetherStress * 100),
      ]);
    }
    const e = [];
    for (const en of this.enemies.active) {
      let flags = 0;
      if (en.elite) flags |= EF.ELITE;
      if (en.cloaked) flags |= EF.CLOAKED;
      if (en.telegraph) flags |= EF.TELEGRAPH;
      if (en.shield > 0) flags |= EF.SHIELDED;
      if (en.stunTimer > 0) flags |= EF.STUNNED;
      if (en.charging) flags |= EF.CHARGING;
      if (en.weakOpenTimer > 0) flags |= EF.WEAKPOINT_OPEN;
      const row = [en.id, en.type, quantize(en.x), quantize(en.y), quantize(en.z), quantize(en.yaw, 2), Math.max(0, Math.round((en.hp / en.maxHp) * 100)), en.state, flags];
      if (en.move) row.push(en.move.state, quantize(en.move.pitch, 2)); // Rogue Runner: animate like a player
      e.push(row);
    }
    const pr = [];
    for (const x of this.projectiles) {
      if (!x.active) continue;
      pr.push([x.id, x.kind, quantize(x.x), quantize(x.y), quantize(x.z), quantize(x.vx, 1), quantize(x.vy, 1), quantize(x.vz, 1)]);
    }
    const f = [];
    for (let i = 0; i < this.fractureCount; i++) {
      const fr = this.fractures[i];
      f.push([fr.id, quantize(fr.x), quantize(fr.y), quantize(fr.z), fr.radius, fr.strength, fr.mode, quantize(fr.age, 2), fr.duration]);
    }
    const pk = [];
    for (const x of this.pickups) if (x.active) pk.push([x.id, x.kind, quantize(x.x), quantize(x.y), quantize(x.z)]);
    const hz = [];
    for (const x of this.hazards) if (x.active) hz.push([x.id, quantize(x.x), quantize(x.y), quantize(x.z), x.r, quantize(x.life / x.maxLife, 2)]);
    const d = [];
    for (const c of this.arena.colliders) if (c.kind === ColliderKind.PROP && !c.alive) d.push(c.id);

    const snap = {
      k: this.tick,
      st: quantize(this.serverTickMs, 2),
      p, e, pr, f, pk, hz, d,
      ev: this.drainEvents(),
      m: this.rules.info(),
    };
    if (this.reactor) snap.rc = Math.round((this.reactor.hp / this.reactor.maxHp) * 1000) / 10;
    if (includeScoreboard) snap.sb = this.rules.scoreboard();
    return snap;
  }

  /** Owner-only state: reconciliation data, ammo, cooldowns, private stats. */
  buildPrivateState(p) {
    const ws = p.weapons[p.weaponIndex];
    const am = p.weapons.map((w) => (w.def.magazine > 0 ? w.ammo : -1));
    const s = p.stats;
    return {
      a: p.lastAckSeq,
      ms: encodeMoveState(p.move),
      hp: Math.ceil(p.health), sh: Math.ceil(p.shield), mhp: p.maxHealth, msh: p.maxShield,
      pc: Math.floor(p.pulse),
      w: p.weaponIndex,
      am,
      mg: p.weapons.map((w) => p.magazineOf(w)),
      rl: ws.reloadTimer > 0 ? quantize(1 - ws.reloadTimer / (ws.def.reloadTime * p.mods.reloadMult), 2) : -1,
      ch: quantize(ws.charge, 2),
      cdw: quantize(ws.cooldown, 2),
      ow: p.ownedMask(),
      cd: [quantize(p.gravityCooldown, 1), quantize(p.meleeCooldown, 1), quantize(ws.deflectCooldown, 1), quantize(p.transferCooldown, 1), quantize(p.tetherArcCooldown, 1)],
      al: p.alive ? 1 : 0,
      dn: p.downed ? quantize(p.downedTimer, 1) : 0,
      rs: !p.alive ? quantize(p.respawnTimer, 1) : 0,
      rv: quantize(p.reviveProgress, 2),
      pr: p.protectedTimer > 0 ? 1 : 0,
      nb: [p.bufferTarget, p.inputQueue.length], // server input jitter buffer: target, current depth (diagnostics)
      up: p.pendingUpgrades,
      cb: p.combo,
      st: {
        k: s.kills, d: s.deaths, a: s.assists, s: Math.round(s.score), sk: s.streak,
        acc: s.shots > 0 ? Math.round((Math.min(s.hits, s.shots) / s.shots) * 100) : 0,
        dmg: Math.round(s.damage), mp: Math.round(s.maxPulse), t: Math.round(s.timeAlive), hs: s.headshots,
      },
    };
  }
}

function q(v, d = 2) {
  return quantize(v, d);
}
