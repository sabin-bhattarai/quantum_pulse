/**
 * Quantum Pulse — authoritative player record.
 *
 * Holds everything the server knows about a Pulse Runner: movement state,
 * health, Pulse Charge, weapons, cooldowns, stats and the position history
 * used for lag compensation. Nothing in here is ever taken from the client
 * except the validated input commands in `inputQueue`.
 * @module server/Player
 */
import { PLAYER, NET, SIM, TEAM } from '../shared/constants.js';
import { createMoveState } from '../shared/movement.js';
import { WEAPONS } from '../shared/weapons.js';

/** Number of ticks of position history kept for lag compensation. */
export const HISTORY_TICKS = Math.ceil((NET.LAG_COMP_MAX_MS / 1000) * SIM.TICK_RATE) + 6;

/** Per-weapon runtime state. */
export class WeaponState {
  constructor(def) {
    this.def = def;
    this.owned = false;
    this.ammo = def.magazine;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.charge = 0;
    this.charging = false;
    this.lastSwing = -10;
    this.deflectTimer = 0;
    this.deflectCooldown = 0;
  }
}

export class Player {
  /**
   * @param {number} id unique entity id
   * @param {string} name sanitised display name
   * @param {string} token reconnection token
   * @param {number} slot 0..11 (used for compact bitmasks)
   */
  constructor(id, name, token, slot) {
    this.id = id;
    this.name = name;
    this.token = token;
    this.slot = slot;
    this.team = TEAM.PLAYERS;
    this.isPlayer = true;
    this.move = createMoveState();
    this.connected = true;
    this.active = true; // false while disconnected (kept for reconnection)
    this.disconnectedAt = 0;

    // Inputs
    /** @type {object[]} validated, ordered input commands awaiting simulation */
    this.inputQueue = [];
    this.lastAckSeq = -1;
    this.lastInput = { seq: -1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0, viewTick: 0 };
    this.lastInputTick = 0;
    /** token bucket: earns one input per tick so long-term input rate == tick rate (anti speed-hack) */
    this.inputBudget = 4;
    this.prevButtons = 0;
    this.viewTick = 0;
    /** Input-arrival health counters (diagnostics; see World.simulatePlayerInputs). */
    this.net = { ticks: 0, starved: 0, catchup: 0, timeouts: 0, dropped: 0, queueSum: 0 };

    // Vital stats
    this.mods = Player.defaultMods();
    this.health = PLAYER.MAX_HEALTH;
    this.shield = PLAYER.MAX_SHIELD;
    this.lastDamageTime = -100;
    this.lastDealtDamageTime = 0;
    this.alive = true;
    this.downed = false;
    this.downedTimer = 0;
    this.reviveProgress = 0;
    this.respawnTimer = 0;
    this.protectedTimer = 0;
    this.revealed = false;

    // Quantum Pulse
    this.pulse = 0;
    this.pulseGainedThisSecond = 0;
    this.pulseWindowStart = 0;
    this.lastPulseActivation = -100;

    // Abilities
    this.gravityCooldown = 0;
    this.meleeCooldown = 0;
    this.transferCooldown = 0;
    this.tetherArcCooldown = 0;
    this.tetherPartner = 0;
    this.tetherStress = 0;

    // Weapons
    this.weapons = WEAPONS.map((d) => new WeaponState(d));
    this.weaponIndex = 0;
    this.switchTimer = 0;

    // Scoring & stats
    this.stats = {
      kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, bestStreak: 0,
      damage: 0, shots: 0, hits: 0, headshots: 0, maxPulse: 0, timeAlive: 0, revives: 0,
    };
    this.combo = 0;
    this.comboTimer = 0;
    /** attackerId -> last time they damaged us (for assists / environmental credit) */
    this.damagers = new Map();

    /** Upgrade choices currently offered (ids) or null. */
    this.pendingUpgrades = null;
    this.upgradesTaken = [];

    // Lag compensation history (ring buffer of x, y, z per tick)
    this.history = new Float32Array(HISTORY_TICKS * 3);
    this.historyTicks = new Int32Array(HISTORY_TICKS).fill(-1);

    this.pingMs = 0;
  }

  static defaultMods() {
    return {
      damageMult: 1, reloadMult: 1, magMult: 1, fireRateMult: 1, pulseGainMult: 1,
      maxHealthBonus: 0, shieldBonus: 0, shieldRegenMult: 1, leech: 0, speedMult: 1,
    };
  }

  get maxHealth() { return PLAYER.MAX_HEALTH + this.mods.maxHealthBonus; }
  get maxShield() { return PLAYER.MAX_SHIELD + this.mods.shieldBonus; }
  get x() { return this.move.x; }
  get y() { return this.move.y; }
  get z() { return this.move.z; }
  get canAct() { return this.active && this.alive && !this.downed; }

  /** Magazine size including upgrades. */
  magazineOf(ws) {
    return ws.def.magazine > 0 ? Math.max(1, Math.round(ws.def.magazine * this.mods.magMult)) : 0;
  }

  /** Give the player a weapon (fills its magazine). */
  grantWeapon(index) {
    const ws = this.weapons[index];
    if (!ws) return;
    ws.owned = true;
    ws.ammo = this.magazineOf(ws);
  }

  /** Bitmask of owned weapons. */
  ownedMask() {
    let m = 0;
    for (let i = 0; i < this.weapons.length; i++) if (this.weapons[i].owned) m |= 1 << i;
    return m;
  }

  /** Reset vital state for a (re)spawn at a position. */
  spawnAt(x, y, z, yaw, protectionSeconds) {
    const keepSpeedMult = this.mods.speedMult;
    const m = createMoveState(x, y, z, yaw);
    m.speedMult = keepSpeedMult;
    this.move = m;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.alive = true;
    this.downed = false;
    this.downedTimer = 0;
    this.reviveProgress = 0;
    this.respawnTimer = 0;
    this.protectedTimer = protectionSeconds;
    this.combo = 0;
    this.damagers.clear();
    for (const ws of this.weapons) {
      ws.ammo = this.magazineOf(ws);
      ws.reloadTimer = 0;
      ws.cooldown = 0;
      ws.charge = 0;
      ws.charging = false;
    }
    this.historyTicks.fill(-1);
  }

  /** Record the current position for lag compensation. */
  recordHistory(tick) {
    const i = tick % HISTORY_TICKS;
    this.history[i * 3] = this.move.x;
    this.history[i * 3 + 1] = this.move.y;
    this.history[i * 3 + 2] = this.move.z;
    this.historyTicks[i] = tick;
  }

  /**
   * Position at a past tick (falls back to the current position when the
   * requested tick is not in the buffer, e.g. right after a respawn).
   */
  positionAt(tick, out) {
    const i = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    if (this.historyTicks[i] === tick) {
      out.x = this.history[i * 3];
      out.y = this.history[i * 3 + 1];
      out.z = this.history[i * 3 + 2];
    } else {
      out.x = this.move.x;
      out.y = this.move.y;
      out.z = this.move.z;
    }
    return out;
  }
}
