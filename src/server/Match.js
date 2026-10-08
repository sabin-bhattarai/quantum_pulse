/**
 * Quantum Pulse — match rules for every game mode.
 *
 * Rules objects plug into World and decide waves, scoring, deaths, respawns,
 * objectives and win/lose conditions. They run only in the authoritative
 * simulation.
 * @module server/Match
 */
import { MODES, MATCH, SURVIVAL, SCORE, SIM, BTN, PULSE, ROGUE } from '../shared/constants.js';
import { raycastArena } from '../shared/movement.js';
import { FractureMode } from '../shared/gravity.js';
import { EV } from '../shared/protocol.js';
import { EnemyType, Telegraph } from './Enemy.js';
import { rollUpgrades, upgradeById } from './Abilities.js';
import { grantLoadout } from './Weapons.js';
import { Player } from './Player.js';

/** Factory used by World. */
export function createRules(world) {
  switch (world.mode) {
    case MODES.FFA: return new FFARules(world);
    case MODES.COOP: return new CoopRules(world);
    case MODES.TRAINING: return new TrainingRules(world);
    default: return new SurvivalRules(world);
  }
}

class BaseRules {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.phase = 'countdown';
    this.timer = 0;
    this.results = null;
  }
  get allowPvP() { return false; }
  start() {}
  preUpdate() {}
  update() {}
  onPlayerJoined() {}
  onPlayerLeft() {}
  onEnemyKilled() {}
  onPlayerKilled(p) { p.alive = false; p.stats.deaths++; }
  onInputProcessed() {}
  /** @returns {boolean} true if the interact press was consumed */
  onInteract() { return false; }
  onUpgradeChosen(p, index) {
    if (!p.pendingUpgrades || index < 0 || index >= p.pendingUpgrades.length) return false;
    const u = upgradeById(p.pendingUpgrades[index]);
    if (!u) return false;
    u.apply(p);
    p.upgradesTaken.push(u.id);
    p.pendingUpgrades = p.bonusUpgrade ? rollUpgrades(this.world, p, SURVIVAL.UPGRADE_CHOICES) : null;
    p.bonusUpgrade = false;
    return true;
  }
  /** Teleport a player who fell out of the arena back to safety. */
  onFellOut(p) {
    if (!p.alive) return;
    this.world.respawnPlayerKeepState(p);
    this.world.applyDamage(p, 20, null, { environment: true });
  }
  info() {
    return { md: this.world.mode, ph: this.phase, t: Math.max(0, Math.round(this.timer * 10) / 10), ar: this.world.arena.id, res: this.results };
  }
  scoreboard() {
    const rows = [];
    for (const p of this.world.players.values()) {
      const status = !p.connected ? 3 : !p.alive ? 2 : p.downed ? 1 : 0;
      rows.push([p.id, p.name, p.stats.kills, p.stats.deaths, p.stats.assists, Math.round(p.stats.score), p.stats.streak, Math.round(p.pingMs), status]);
    }
    rows.sort((a, b) => b[5] - a[5] || b[2] - a[2]);
    return rows;
  }

  /** Spawn an enemy group at a random rift. */
  spawnAtRift(type, count, opts) {
    const w = this.world;
    const rifts = w.arena.rifts;
    const r = rifts[Math.floor(w.rng() * rifts.length)];
    w.emit(EV.RIFT, r.x, r.y, r.z);
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2;
      const spread = count > 1 ? 1.5 : 0;
      w.enemies.spawn(type, r.x + Math.cos(a) * spread, r.y + (type === EnemyType.TITAN ? 6 : 0), r.z + Math.sin(a) * spread, opts);
    }
  }

  /**
   * Wave composition: spend a budget on enemy archetypes unlocked so far.
   * Every fifth wave is a boss wave; waves 3, 8, 13... promote some enemies
   * to elites.
   */
  composeWave(n, playerScale = 1) {
    const w = this.world;
    const unlocked = [EnemyType.SWARM];
    if (n >= 2) unlocked.push(EnemyType.RUNNER);
    if (n >= 3) unlocked.push(EnemyType.CASTER);
    if (n >= 4) unlocked.push(EnemyType.STALKER);
    if (n >= 6) unlocked.push(EnemyType.WARDEN);
    if (n >= 7) unlocked.push(EnemyType.MIRROR);
    if (n === 5) unlocked.push(EnemyType.MIRROR); // preview before it becomes common
    const isBoss = n % SURVIVAL.BOSS_EVERY === 0;
    const isElite = n % SURVIVAL.ELITE_WAVES_MOD === SURVIVAL.ELITE_WAVE_OFFSET;
    let budget = Math.round((4 + n * 3.2) * playerScale * (isBoss ? 0.45 : 1));
    const queue = [];
    if (isBoss) queue.push({ type: EnemyType.TITAN, count: 1, elite: false });
    let elites = isElite ? 1 + Math.floor(n / 5) : 0;
    let guard = 0;
    while (budget > 0 && guard++ < 200) {
      const type = unlocked[Math.floor(w.rng() * unlocked.length)];
      if (type === EnemyType.SWARM) {
        const count = 3 + Math.floor(w.rng() * 3);
        queue.push({ type, count, elite: false });
        budget -= count;
      } else {
        const cost = [1, 8, 4, 5, 3, 5, 40, 0][type];
        if (cost > budget + 2) continue;
        const elite = elites > 0;
        if (elite) elites--;
        queue.push({ type, count: 1, elite });
        budget -= cost;
      }
    }
    return { queue, isBoss, isElite };
  }

  difficultyFor(n, players = 1) {
    return {
      hp: (1 + 0.075 * (n - 1)) * (1 + 0.32 * (players - 1)),
      damage: 1 + 0.05 * (n - 1),
      speed: 1 + Math.min(0.25, 0.02 * (n - 1)),
      shooters: Math.min(5, 1 + players + (n >= 6 ? 1 : 0)), // Rogue Runners allowed to fire at once
    };
  }

  /** Spawn queued wave entries at a steady cadence. */
  pumpSpawns(dt) {
    const w = this.world;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || !this.spawnQueue.length) return;
    if (w.enemies.count >= SURVIVAL.MAX_ALIVE_ENEMIES) return;
    if (!this.canSpawn(this.spawnQueue[0])) return;
    const entry = this.spawnQueue.shift();
    this.spawnEntry(entry, { hpScale: w.difficulty.hp, damageScale: w.difficulty.damage, elite: entry.elite });
    this.spawnTimer = entry.type === EnemyType.TITAN ? 3 : SURVIVAL.SPAWN_INTERVAL;
  }

  /** Hold an entry back while the arena already has enough runners alive. */
  canSpawn(entry) {
    return entry.type !== EnemyType.ROGUE || this.world.enemies.countType(EnemyType.ROGUE) < this.maxAliveRogues();
  }

  maxAliveRogues() { return ROGUE.MAX_ALIVE; }

  /** Place one queued entry in the arena. */
  spawnEntry(entry, opts) {
    if (entry.type === EnemyType.ROGUE) this.spawnRogue(opts);
    else this.spawnAtRift(entry.type, entry.count, opts);
  }

  /**
   * One Rogue Runner at the spawn point that best spreads the wave out: at
   * least SPAWN_MIN_DIST from every player, as far as possible from the other
   * runners' home points, with a little randomness.
   */
  spawnRogue(opts) {
    const w = this.world;
    const homes = w.enemies.active.filter((e) => e.move);
    let best = null, bestScore = -Infinity;
    for (const s of w.arena.spawns) {
      let dp = Infinity;
      for (const p of w.activePlayers) if (p.alive) dp = Math.min(dp, Math.hypot(p.x - s.x, p.z - s.z));
      let dr = 40;
      for (const e of homes) dr = Math.min(dr, Math.hypot(e.homeX - s.x, e.homeZ - s.z));
      const score = (dp < ROGUE.SPAWN_MIN_DIST ? -1000 + dp : 0) + dr + w.rng() * 6;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (!best) return;
    w.emit(EV.RIFT, best.x, best.y + 1, best.z);
    w.enemies.spawn(EnemyType.ROGUE, best.x, best.y, best.z, { ...opts, yaw: Math.atan2(best.x, best.z) });
  }

  /**
   * Runner squad for wave n: `count` Rogue Runners, the first `elites` of them
   * elite. Every fifth wave is an elite squad (there are no flying bosses).
   */
  runnerWave(n, count) {
    const isElite = n % SURVIVAL.BOSS_EVERY === 0 || n % SURVIVAL.ELITE_WAVES_MOD === SURVIVAL.ELITE_WAVE_OFFSET;
    let elites = isElite ? 1 + Math.floor(n / 5) : 0;
    const queue = [];
    for (let i = 0; i < count; i++) {
      queue.push({ type: EnemyType.ROGUE, count: 1, elite: elites > 0 });
      elites--;
    }
    return { queue, isBoss: false, isElite };
  }

  /** Arena instability: telegraphed random fractures that ramp up with waves. */
  updateInstability(dt, wave) {
    const w = this.world;
    if (wave < SURVIVAL.INSTABILITY_START_WAVE) return;
    this.instabilityTimer = (this.instabilityTimer ?? 12) - dt;
    if (this.pendingFracture) {
      this.pendingFracture.t -= dt;
      if (this.pendingFracture.t <= 0) {
        const f = this.pendingFracture;
        w.spawnFracture(f.x, f.y, f.z, 7, 22 + wave, 3.5, f.mode, 0);
        this.pendingFracture = null;
      }
    }
    if (this.instabilityTimer <= 0 && !this.pendingFracture) {
      this.instabilityTimer = Math.max(7, 20 - wave);
      const ps = w.activePlayers.filter((p) => p.canAct);
      if (!ps.length) return;
      const target = ps[Math.floor(w.rng() * ps.length)];
      const x = target.x + (w.rng() - 0.5) * 16, z = target.z + (w.rng() - 0.5) * 16;
      const mode = [FractureMode.ATTRACT, FractureMode.REPEL, FractureMode.ORBIT][Math.floor(w.rng() * 3)];
      this.pendingFracture = { x, y: target.y + 1.5, z, mode, t: 1.6 };
      w.emit(EV.TELEGRAPH, 0, Telegraph.FRACTURE, Math.round(x * 100) / 100, Math.round((target.y + 1.5) * 100) / 100, Math.round(z * 100) / 100, 1.6, 7, mode, 0);
    }
  }

  resultsRows() {
    return this.scoreboard().map((r) => ({ id: r[0], name: r[1], k: r[2], d: r[3], a: r[4], s: r[5] }));
  }
}

/* ------------------------------------------------------------------------ */
/* Solo Survival                                                             */
/* ------------------------------------------------------------------------ */
/**
 * Solo waves are fought against Rogue Runners: bots that use the player
 * movement model and the multiplayer avatar, all on foot. Each one comes out
 * of its own rift at a different spawn point, away from the player, so a wave
 * is spread across the arena. Every fifth wave is an elite squad.
 */
class SurvivalRules extends BaseRules {
  composeWave(n) {
    // 3, 4, 4, 5, 5, 6, 6, 7, 7, 8 ... capped at MAX_PER_WAVE
    return this.runnerWave(n, Math.min(ROGUE.MAX_PER_WAVE, 2 + Math.ceil(n * 0.55)));
  }

  difficultyFor(n) {
    return {
      hp: 1 + 0.06 * (n - 1),
      damage: 1 + 0.04 * (n - 1),
      speed: 1,
      shooters: n < 4 ? 2 : n < 8 ? 3 : 4, // Rogue Runners allowed to fire at once
    };
  }

  start() {
    this.phase = 'countdown';
    this.timer = 3;
    this.wave = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.score = 0;
    this.elapsed = 0;
  }

  update(dt) {
    const w = this.world;
    if (this.phase !== 'over') this.elapsed += dt;
    switch (this.phase) {
      case 'countdown':
      case 'intermission':
        this.timer -= dt;
        if (this.timer <= 0) this.startWave(this.wave + 1);
        break;
      case 'wave':
        this.pumpSpawns(dt);
        this.updateInstability(dt, this.wave);
        if (!this.spawnQueue.length && w.enemies.count === 0) this.waveCleared();
        break;
      case 'upgrade': {
        const waiting = w.activePlayers.some((p) => p.pendingUpgrades);
        if (!waiting) { this.phase = 'intermission'; this.timer = 3; }
        break;
      }
      default:
        break;
    }
  }

  startWave(n) {
    const w = this.world;
    this.wave = n;
    w.difficulty = this.difficultyFor(n, Math.max(1, w.activePlayers.length));
    const { queue, isBoss, isElite } = this.composeWave(n);
    this.spawnQueue = queue;
    this.spawnTimer = 0.5;
    this.phase = 'wave';
    w.emit(EV.WAVE, n, isBoss ? 1 : 0, isElite ? 1 : 0);
  }

  waveCleared() {
    const w = this.world;
    for (const p of w.activePlayers) {
      if (!p.alive) continue;
      p.health = Math.min(p.maxHealth, p.health + p.maxHealth * 0.35);
      p.pendingUpgrades = rollUpgrades(w, p, SURVIVAL.UPGRADE_CHOICES, this.wave === 1 || this.wave === 3 || this.wave === 6);
    }
    this.phase = 'upgrade';
  }

  onEnemyKilled(e, killer) {
    if (!killer || !killer.isPlayer) return;
    const pts = e.def.score * (e.elite ? 3 : 1) * (1 + 0.1 * killer.combo);
    killer.stats.score += pts;
    this.score += pts;
    if (e.def.boss) killer.bonusUpgrade = true;
  }

  onPlayerKilled(p) {
    const w = this.world;
    p.alive = false;
    p.stats.deaths++;
    if (w.activePlayers.every((q) => !q.alive)) {
      this.phase = 'over';
      const s = p.stats;
      this.results = {
        title: 'RUN ENDED',
        wave: this.wave,
        score: Math.round(this.score),
        time: Math.round(this.elapsed),
        kills: s.kills,
        acc: s.shots > 0 ? Math.round((Math.min(s.hits, s.shots) / s.shots) * 100) : 0,
        maxPulse: Math.round(s.maxPulse),
        headshots: s.headshots,
        rows: this.resultsRows(),
      };
    }
  }

  info() {
    const i = super.info();
    i.w = this.wave;
    i.el = this.world.enemies.count + this.spawnQueue.reduce((a, q) => a + q.count, 0);
    i.sc = Math.round(this.score);
    i.tt = Math.round(this.elapsed);
    return i;
  }
}

/* ------------------------------------------------------------------------ */
/* Training Range                                                            */
/* ------------------------------------------------------------------------ */
class TrainingRules extends BaseRules {
  start() {
    this.phase = 'training';
    this.timer = 0;
    this.dummyTimer = 0;
  }

  groundY(x, z, fromY) {
    const hit = raycastArena(this.world.env, x, fromY, z, 0, -1, 0, 60, false, false);
    return hit.t >= 0 ? fromY - hit.t : 0;
  }

  /**
   * Choose the spawn + facing whose forward lane has the most valid dummy
   * spots: same floor level as the spawn, not inside geometry, inside the
   * arena and with clear line of sight from the spawn's eye.
   */
  planRange() {
    const w = this.world;
    let best = null;
    for (const s of w.arena.spawns) {
      for (const off of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        const yaw = s.yaw + off;
        const spots = this.validSpots(s, yaw);
        if (!best || spots.length > best.spots.length) best = { spawn: s, yaw, spots };
      }
    }
    this.plan = best;
    return best;
  }

  validSpots(s, yaw) {
    const w = this.world;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const layout = [[8, -3, false], [8, 3, false], [14, 0, false], [20, -5, true], [20, 5, true], [28, 0, false]];
    const out = [];
    const ex = s.x, ey = s.y + 1.62, ez = s.z;
    for (const [d, side, moving] of layout) {
      const x = s.x + fx * d + rx * side, z = s.z + fz * d + rz * side;
      if (Math.abs(x) > w.arena.half - 3 || Math.abs(z) > w.arena.half - 3) continue;
      const gy = this.groundY(x, z, s.y + 3);
      if (Math.abs(gy - s.y) > 1.2) continue;
      const cy = gy + 1.0;
      let blocked = false;
      for (const c of w.arena.colliders) {
        if (x > c.minX - 1.4 && x < c.maxX + 1.4 && z > c.minZ - 1.4 && z < c.maxZ + 1.4 && cy + 1 > c.minY && cy - 1 < c.maxY) { blocked = true; break; }
      }
      if (blocked) continue;
      const dx = x - ex, dy = cy - ey, dz = z - ez;
      const dist = Math.hypot(dx, dy, dz);
      const hit = raycastArena(w.env, ex, ey, ez, dx / dist, dy / dist, dz / dist, dist, false, false);
      if (hit.t >= 0) continue;
      out.push({ x, y: cy, z, moving });
    }
    return out;
  }

  /** Place target dummies along the best practice lane. */
  placeDummies() {
    const plan = this.plan || this.planRange();
    for (const sp of plan.spots) this.world.enemies.spawn(EnemyType.DUMMY, sp.x, sp.y, sp.z, { moving: sp.moving });
  }

  /** Start the runner at the head of the practice lane, facing the dummies. */
  onPlayerJoined(p) {
    const plan = this.plan || this.planRange();
    const m = p.move;
    m.x = plan.spawn.x; m.y = plan.spawn.y + 0.05; m.z = plan.spawn.z;
    m.yaw = plan.yaw;
  }

  update(dt) {
    const w = this.world;
    if (w.enemies.countType(EnemyType.DUMMY) === 0) {
      this.dummyTimer -= dt;
      if (this.dummyTimer <= 0) { this.placeDummies(); this.dummyTimer = 2; }
    }
    // Pulse Charge refills quickly so abilities can be practised.
    for (const p of w.activePlayers) {
      if (p.move.phaseTimer <= 0) p.pulse = Math.min(PULSE.MAX, p.pulse + 30 * dt);
      p.health = p.maxHealth;
    }
  }

  /** E summons a harmless practice squad of three Rogue Runners ahead of the player (bounded). */
  onInteract(p) {
    const w = this.world;
    if (w.enemies.countType(EnemyType.ROGUE) >= ROGUE.MAX_ALIVE) return true;
    const fx = -Math.sin(p.move.yaw), fz = -Math.cos(p.move.yaw);
    for (let i = -1; i <= 1; i++) {
      const x = p.x + fx * 16 - fz * i * 3, z = p.z + fz * 16 + fx * i * 3;
      const y = w.enemies.groundAt(x, z, p.y + 3);
      if (y === null || Math.abs(y - p.y) > 3) continue; // only on solid floor near the player's level
      w.emit(EV.RIFT, x, y + 1, z);
      w.enemies.spawn(EnemyType.ROGUE, x, y, z, { hpScale: 1, damageScale: 0, yaw: Math.atan2(x - p.x, z - p.z) });
    }
    return true;
  }

  onPlayerKilled(p) { p.health = p.maxHealth; }

  info() {
    const i = super.info();
    i.el = this.world.enemies.count;
    return i;
  }
}

/* ------------------------------------------------------------------------ */
/* Online Free-for-All                                                       */
/* ------------------------------------------------------------------------ */
class FFARules extends BaseRules {
  get allowPvP() { return true; }

  start() {
    this.phase = 'warmup';
    this.timer = 0;
  }

  connectedCount() {
    let n = 0;
    for (const p of this.world.players.values()) if (p.connected) n++;
    return n;
  }

  update(dt) {
    const w = this.world;
    const n = this.connectedCount();
    switch (this.phase) {
      case 'warmup':
        if (n >= MATCH.FFA_MIN_PLAYERS) { this.phase = 'countdown'; this.timer = MATCH.FFA_WARMUP_S; }
        break;
      case 'countdown':
        if (n < MATCH.FFA_MIN_PLAYERS) { this.phase = 'warmup'; break; }
        this.timer -= dt;
        if (this.timer <= 0) this.beginMatch();
        break;
      case 'active':
        this.timer -= dt;
        if (this.timer <= 0 || n === 0) this.endMatch();
        break;
      case 'ended':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.results = null;
          this.phase = n >= MATCH.FFA_MIN_PLAYERS ? 'countdown' : 'warmup';
          this.timer = MATCH.FFA_WARMUP_S;
        }
        break;
      default:
        break;
    }
    for (const p of w.activePlayers) {
      if (!p.alive) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0 && this.phase !== 'ended') w.respawnPlayer(p);
      }
      // Anti-stall: campers who deal no damage for a while are revealed to everyone.
      p.revealed = this.phase === 'active' && p.alive && w.time - Math.max(p.lastDealtDamageTime, p.lastSpawnTime || 0) > MATCH.ANTI_STALL_S;
    }
  }

  beginMatch() {
    const w = this.world;
    this.phase = 'active';
    this.timer = w.config.matchDuration;
    for (const p of w.players.values()) {
      Object.assign(p.stats, { kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, bestStreak: 0, damage: 0, shots: 0, hits: 0, headshots: 0 });
      if (p.active) { w.respawnPlayer(p); p.lastSpawnTime = w.time; p.lastDealtDamageTime = w.time; }
    }
    w.emit(EV.ANNOUNCE, 'match_start', 0);
  }

  endMatch() {
    this.phase = 'ended';
    this.timer = MATCH.RESULTS_S;
    const rows = this.resultsRows();
    this.results = { title: 'MATCH COMPLETE', winner: rows[0] ? rows[0].name : '-', rows };
  }

  onPlayerJoined(p) { p.lastSpawnTime = this.world.time; p.lastDealtDamageTime = this.world.time; }

  onPlayerKilled(victim, killer, opts = {}) {
    const w = this.world;
    victim.alive = false;
    victim.respawnTimer = MATCH.RESPAWN_S;
    victim.stats.deaths++;
    victim.stats.streak = 0;
    victim.move.dead = 1;
    // Environmental death: credit the last attacker within 5 s.
    let k = killer && killer.isPlayer && killer !== victim ? killer : null;
    let environmental = false;
    if (!k) {
      let best = 0;
      for (const [id, t] of victim.damagers) {
        if (w.time - t < 5 && t > best && w.players.has(id)) { best = t; k = w.players.get(id); }
      }
      environmental = !!k;
    }
    const counts = this.phase !== 'ended';
    if (k && counts) {
      k.stats.kills++;
      k.stats.streak++;
      k.stats.bestStreak = Math.max(k.stats.bestStreak, k.stats.streak);
      k.stats.score += SCORE.FFA_KILL + (opts.headshot ? SCORE.HEADSHOT_BONUS : 0) + Math.max(0, k.stats.streak - 2) * SCORE.FFA_STREAK_BONUS;
      w.addPulseFor(k, PULSE.PER_KILL + (!k.move.onGround ? PULSE.AIRBORNE_KILL_BONUS : 0) + (environmental ? PULSE.ENVIRONMENT_KILL_BONUS : 0));
      if ([3, 5, 8, 12].includes(k.stats.streak)) w.emit(EV.STREAK, k.id, k.stats.streak);
    }
    if (counts) {
      for (const [id, t] of victim.damagers) {
        if (k && id === k.id) continue;
        if (w.time - t > MATCH.ASSIST_WINDOW_S) continue;
        const a = w.players.get(id);
        if (!a) continue;
        a.stats.assists++;
        a.stats.score += SCORE.FFA_ASSIST;
      }
    }
    const flags = (opts.headshot ? 1 : 0) | (k && !k.move.onGround ? 2 : 0) | (environmental ? 4 : 0);
    w.emit(EV.KILL, k ? k.id : 0, k ? k.name : '', victim.id, victim.name, opts.weapon ?? -1, flags);
    victim.damagers.clear();
  }

  onFellOut(p) {
    if (!p.alive) return;
    p.health = 0;
    this.onPlayerKilled(p, null, { environment: true });
  }

  info() {
    const i = super.info();
    i.np = this.connectedCount();
    i.mn = MATCH.FFA_MIN_PLAYERS;
    return i;
  }
}

/* ------------------------------------------------------------------------ */
/* Online Co-op Rift Defense                                                 */
/* ------------------------------------------------------------------------ */
class CoopRules extends BaseRules {
  /** A bigger squad can face a few more runners at once. */
  maxAliveRogues() { return ROGUE.MAX_ALIVE + Math.max(0, this.activeCount() - 1); }

  start() {
    this.phase = 'countdown';
    this.timer = 8;
    this.wave = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.score = 0;
    this.elapsed = 0;
  }

  activeCount() {
    return this.world.activePlayers.length;
  }

  update(dt) {
    const w = this.world;
    if (this.phase === 'countdown' || this.phase === 'wave' || this.phase === 'intermission') this.elapsed += dt;
    switch (this.phase) {
      case 'countdown':
        if (this.activeCount() === 0) break;
        this.timer -= dt;
        if (this.timer <= 0) this.startWave(1);
        break;
      case 'wave':
        this.pumpSpawns(dt);
        this.updateInstability(dt, this.wave);
        if (!this.spawnQueue.length && w.enemies.count === 0) this.waveCleared();
        break;
      case 'intermission':
        this.timer -= dt;
        if (this.timer <= 0) {
          for (const p of w.activePlayers) if (p.pendingUpgrades) this.onUpgradeChosen(p, 0);
          this.startWave(this.wave + 1);
        }
        break;
      case 'victory':
      case 'defeat':
        this.timer -= dt;
        if (this.timer <= 0) this.restart();
        return;
      default:
        break;
    }
    // Downed players bleed out.
    for (const p of w.activePlayers) {
      if (p.downed) {
        p.downedTimer -= dt;
        if (p.downedTimer <= 0) {
          p.downed = false;
          p.alive = false;
          p.move.dead = 1;
        }
      }
    }
    // Loss conditions
    if (this.phase === 'wave' || this.phase === 'intermission') {
      const reactorDown = w.reactor && w.reactor.hp <= 0;
      const everyoneDown = w.activePlayers.length > 0 && w.activePlayers.every((p) => !p.canAct);
      if (reactorDown || everyoneDown) this.finish(false, reactorDown ? 'REACTOR DESTROYED' : 'SQUAD ELIMINATED');
    }
  }

  startWave(n) {
    const w = this.world;
    this.wave = n;
    const players = Math.max(1, this.activeCount());
    w.difficulty = this.difficultyFor(n, players);
    const { queue, isBoss, isElite } = this.runnerWave(n, Math.min(ROGUE.MAX_PER_WAVE + 4, Math.round((2 + n * 0.6) * (0.75 + 0.3 * players))));
    this.spawnQueue = queue;
    this.spawnTimer = 0.5;
    this.phase = 'wave';
    w.emit(EV.WAVE, n, isBoss ? 1 : 0, isElite ? 1 : 0);
  }

  waveCleared() {
    const w = this.world;
    if (this.wave >= MATCH.COOP_FINAL_WAVE) { this.finish(true, 'RIFT SEALED'); return; }
    // Fallen runners return between waves; everyone picks an upgrade.
    for (const p of w.activePlayers) {
      if (!p.alive || p.downed) w.respawnPlayer(p);
      p.pendingUpgrades = rollUpgrades(w, p, SURVIVAL.UPGRADE_CHOICES);
    }
    if (w.reactor) w.reactor.hp = Math.min(w.reactor.maxHp, w.reactor.hp + w.reactor.maxHp * 0.1);
    this.phase = 'intermission';
    this.timer = MATCH.INTERMISSION_S + 4;
  }

  finish(victory, title) {
    this.phase = victory ? 'victory' : 'defeat';
    this.timer = MATCH.RESULTS_S;
    this.results = { title, victory, wave: this.wave, score: Math.round(this.score), time: Math.round(this.elapsed), rows: this.resultsRows() };
    this.world.enemies.clear();
  }

  restart() {
    const w = this.world;
    w.enemies.clear();
    if (w.reactor) w.reactor.hp = w.reactor.maxHp;
    for (const p of w.players.values()) {
      p.mods = Player.defaultMods();
      p.pendingUpgrades = null;
      p.upgradesTaken = [];
      p.pulse = 0;
      Object.assign(p.stats, { kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, damage: 0, shots: 0, hits: 0, headshots: 0, revives: 0 });
      grantLoadout(p, MODES.COOP);
      if (p.active) w.respawnPlayer(p);
    }
    this.results = null;
    this.start();
  }

  onEnemyKilled(e, killer) {
    if (!killer || !killer.isPlayer) return;
    const pts = e.def.score * (e.elite ? 3 : 1) * (1 + 0.1 * killer.combo);
    killer.stats.score += pts;
    this.score += pts;
  }

  onPlayerKilled(p) {
    if (p.downed || !p.alive) return;
    p.downed = true;
    p.downedTimer = MATCH.COOP_DOWNED_BLEEDOUT_S;
    p.health = 0;
    p.stats.deaths++;
    p.move.grappling = 0;
    this.world.emit(EV.DOWNED, p.id);
  }

  onFellOut(p) {
    if (!p.alive) return;
    this.world.respawnPlayerKeepState(p);
    this.world.applyDamage(p, 25, null, { environment: true });
  }

  nearestDowned(p) {
    let best = null, bestD = MATCH.COOP_REVIVE_RANGE;
    for (const q of this.world.activePlayers) {
      if (q === p || !q.downed) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }

  onInteract(p) {
    return !!this.nearestDowned(p);
  }

  /** Holding interact next to a downed teammate revives them. */
  onInputProcessed(p, inp) {
    if (!p.canAct) { p.reviveProgress = 0; return; }
    const target = (inp.buttons & BTN.INTERACT) ? this.nearestDowned(p) : null;
    if (!target) { p.reviveProgress = 0; return; }
    p.reviveProgress += SIM.DT / MATCH.COOP_REVIVE_TIME_S;
    if (p.reviveProgress >= 1) {
      p.reviveProgress = 0;
      target.downed = false;
      target.health = target.maxHealth * 0.5;
      target.move.stunTimer = 0;
      p.stats.revives++;
      p.stats.score += 75;
      this.world.emit(EV.REVIVE, p.id, target.id);
    }
  }

  info() {
    const i = super.info();
    i.w = this.wave;
    i.wt = MATCH.COOP_FINAL_WAVE;
    i.el = this.world.enemies.count + this.spawnQueue.reduce((a, q) => a + q.count, 0);
    i.sc = Math.round(this.score);
    i.np = this.activeCount();
    return i;
  }
}

