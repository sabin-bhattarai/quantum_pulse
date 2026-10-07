/**
 * Quantum Pulse — Pulse Charge economy, abilities and the co-op Quantum Tether.
 *
 * All functions here run only inside the authoritative simulation.
 * @module server/Abilities
 */
import { PULSE, PLAYER, MODES, SIM } from '../shared/constants.js';
import { dirFromYawPitch, pointSegmentDistSq, clamp } from '../shared/math.js';
import { raycastArena } from '../shared/movement.js';
import { FractureMode } from '../shared/gravity.js';
import { EV } from '../shared/protocol.js';
import { UPGRADE_INFO } from '../shared/upgrades.js';

/**
 * Add Pulse Charge with upgrade scaling and a hard per-second cap, so no
 * combination of sources can fill the meter instantly.
 * @param {import('./World.js').World} world
 * @param {import('./Player.js').Player} p
 * @param {number} amount
 */
export function addPulse(world, p, amount) {
  if (!p.canAct || amount <= 0) return;
  if (world.time - p.pulseWindowStart >= 1) {
    p.pulseWindowStart = world.time;
    p.pulseGainedThisSecond = 0;
  }
  const room = PULSE.MAX_GAIN_PER_SECOND - p.pulseGainedThisSecond;
  if (room <= 0) return;
  const gain = Math.min(room, amount * p.mods.pulseGainMult);
  p.pulseGainedThisSecond += gain;
  p.pulse = Math.min(PULSE.MAX, p.pulse + gain);
  if (p.pulse > p.stats.maxPulse) p.stats.maxPulse = p.pulse;
}

/** Called after the movement step raised PHASE_START: consume charge and handle sync abilities. */
export function onPhaseActivated(world, p) {
  p.pulse = 0;
  p.lastPulseActivation = world.time;
  world.emit(EV.PULSE, p.id);
  // Co-op synchronized group ability: Rift Surge.
  if (world.mode === MODES.COOP && p.tetherPartner) {
    const partner = world.players.get(p.tetherPartner);
    if (partner && partner.canAct && world.time - partner.lastPulseActivation <= PULSE.SYNC_WINDOW_S) {
      riftSurge(world, p, partner);
    }
  }
}

/**
 * Rift Surge: both tethered runners phased within the sync window. Creates a
 * repelling fracture between them, damages nearby enemies and restores shields.
 */
function riftSurge(world, a, b) {
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 + 1, z = (a.z + b.z) / 2;
  world.spawnFracture(x, y, z, 10, 40, 2.5, FractureMode.REPEL, a.id);
  world.damageEnemiesInRadius(x, y, z, 10, 90, a, { environmental: false, falloff: true });
  for (const p of [a, b]) p.shield = p.maxShield;
  world.emit(EV.RIFT_SURGE, x, y, z);
}

/** G — Gravity Well: an attracting fracture where the player aims. */
export function tryGravityAbility(world, p) {
  if (p.gravityCooldown > 0) return;
  const m = p.move;
  const d = dirFromYawPitch(m.yaw, m.pitch, _dir);
  const ex = m.x, ey = m.y + PLAYER.EYE_HEIGHT, ez = m.z;
  const hit = raycastArena(world.env, ex, ey, ez, d.x, d.y, d.z, PULSE.GRAVITY_ABILITY_RANGE, false, false);
  const t = hit.t >= 0 ? Math.max(0, hit.t - 1.2) : PULSE.GRAVITY_ABILITY_RANGE;
  world.spawnFracture(ex + d.x * t, ey + d.y * t, ez + d.z * t, 8, 30, 3.2, FractureMode.ATTRACT, p.id);
  p.gravityCooldown = world.mode === MODES.TRAINING ? 2 : PULSE.GRAVITY_ABILITY_COOLDOWN;
}

const _dir = { x: 0, y: 0, z: 0 };

/** F — Melee Pulse: short cone knockback that also staggers light enemies. */
export function tryMeleePulse(world, p) {
  if (p.meleeCooldown > 0) return;
  p.meleeCooldown = PULSE.MELEE_COOLDOWN;
  const m = p.move;
  const d = dirFromYawPitch(m.yaw, m.pitch, _dir);
  const cx = m.x + d.x * 1.6, cy = m.y + 1.0 + d.y * 1.6, cz = m.z + d.z * 1.6;
  world.emit(EV.MELEE, p.id, cx, cy, cz);
  const speed = Math.hypot(m.vx, m.vz);
  const dmg = PULSE.MELEE_DAMAGE * (1 + clamp((speed - 8) / 30, 0, 0.3)) * p.mods.damageMult;
  world.forEachTargetNear(p, cx, cy, cz, PULSE.MELEE_RANGE, (target, isEnemy) => {
    world.applyDamage(target, dmg, p, { weapon: -1, melee: true, x: cx, y: cy, z: cz });
    const kx = target.x - m.x, kz = target.z - m.z;
    const kl = Math.hypot(kx, kz) || 1;
    world.knockback(target, (kx / kl) * PULSE.MELEE_KNOCKBACK, 4, (kz / kl) * PULSE.MELEE_KNOCKBACK);
    if (isEnemy && target.def.light) target.stun(0.8);
  });
  // Melee pulse also breaks destructible props in front of the player.
  world.damagePropsInRadius(cx, cy, cz, 2.2, dmg);
}

/**
 * Hard landing shockwave (momentum combat): falling fast enough damages and
 * pushes nearby targets. Damage scales with fall speed but is capped.
 */
export function landingShockwave(world, p, fallSpeed) {
  const m = p.move;
  const scale = clamp(fallSpeed / PLAYER.SHOCKWAVE_MIN_FALL_SPEED, 1, 1.6);
  const dmg = PLAYER.SHOCKWAVE_DAMAGE * scale * p.mods.damageMult;
  world.emit(EV.PLAYER_SHOCKWAVE, p.id, m.x, m.y, m.z);
  world.forEachTargetNear(p, m.x, m.y + 0.5, m.z, PLAYER.SHOCKWAVE_RADIUS, (target, isEnemy) => {
    world.applyDamage(target, dmg, p, { weapon: -1, shockwave: true, x: m.x, y: m.y, z: m.z });
    const kx = target.x - m.x, kz = target.z - m.z;
    const kl = Math.hypot(kx, kz) || 1;
    world.knockback(target, (kx / kl) * 9, 7, (kz / kl) * 9);
    if (isEnemy && target.def.light) target.stun(0.6);
  });
}

/**
 * Co-op Quantum Tether, updated once per tick.
 *
 * Each runner links to the nearest teammate within TETHER_LINK_RANGE. The
 * link never constrains movement (no collision, no pulling) — it only grants
 * bonuses, so it can never trap a player:
 *   - speed bonus while the partner is between TETHER_BONUS_MIN and _MAX away,
 *   - "stress" rises past TETHER_BONUS_MAX and the link snaps at BREAK_RANGE,
 *   - E (interact, when nobody needs reviving) transfers Pulse Charge,
 *   - enemies crossing the tether segment take a cutting-arc hit (cooldown).
 */
export function updateTethers(world) {
  const players = world.activePlayers;
  for (const p of players) {
    if (!p.canAct) {
      p.tetherPartner = 0;
      p.move.speedMult = p.mods.speedMult;
      continue;
    }
    let partner = p.tetherPartner ? world.players.get(p.tetherPartner) : null;
    if (partner && (!partner.canAct || dist(p, partner) > PULSE.TETHER_BREAK_RANGE)) partner = null;
    if (!partner) {
      let best = null, bestD = PULSE.TETHER_LINK_RANGE;
      for (const q of players) {
        if (q === p || !q.canAct) continue;
        const d = dist(p, q);
        if (d < bestD) { bestD = d; best = q; }
      }
      partner = best;
    }
    p.tetherPartner = partner ? partner.id : 0;
    if (!partner) {
      p.tetherStress = 0;
      p.move.speedMult = p.mods.speedMult;
      continue;
    }
    const d = dist(p, partner);
    p.tetherStress = clamp((d - PULSE.TETHER_BONUS_MAX) / (PULSE.TETHER_BREAK_RANGE - PULSE.TETHER_BONUS_MAX), 0, 1);
    const coordinated = d >= PULSE.TETHER_BONUS_MIN && d <= PULSE.TETHER_BONUS_MAX;
    p.move.speedMult = clamp(p.mods.speedMult * (coordinated ? PULSE.TETHER_SPEED_BONUS : 1), 0.5, 1.25);

    // Cutting arc: evaluated once per pair (lower id owns the check).
    if (p.id < partner.id && p.tetherArcCooldown <= 0 && p.tetherStress < 0.5) {
      const ax = p.x, ay = p.y + 1, az = p.z, bx = partner.x, by = partner.y + 1, bz = partner.z;
      let hitAny = false;
      world.forEachEnemy((e) => {
        if (!e.targetable) return;
        const w = PULSE.TETHER_ARC_WIDTH + e.radius;
        if (pointSegmentDistSq(e.x, e.y, e.z, ax, ay, az, bx, by, bz) <= w * w) {
          world.applyDamage(e, PULSE.TETHER_ARC_DAMAGE, p, { weapon: -1, tether: true, x: e.x, y: e.y, z: e.z });
          world.emit(EV.TETHER_ARC, e.x, e.y, e.z);
          hitAny = true;
        }
      });
      if (hitAny) {
        p.tetherArcCooldown = PULSE.TETHER_ARC_COOLDOWN;
        partner.tetherArcCooldown = PULSE.TETHER_ARC_COOLDOWN;
      }
    }
  }
}

/** E with no downed teammate nearby: share Pulse Charge with the tether partner. */
export function tryPulseTransfer(world, p) {
  if (p.transferCooldown > 0 || !p.tetherPartner) return false;
  const partner = world.players.get(p.tetherPartner);
  if (!partner || !partner.canAct) return false;
  const amount = Math.min(PULSE.TETHER_TRANSFER_AMOUNT, p.pulse, PULSE.MAX - partner.pulse);
  if (amount <= 0) return false;
  p.pulse -= amount;
  partner.pulse += amount;
  p.transferCooldown = PULSE.TETHER_TRANSFER_COOLDOWN;
  world.emit(EV.TRANSFER, p.id, partner.id);
  return true;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Per-tick cooldown bookkeeping for abilities. */
export function tickAbilityCooldowns(p, dt = SIM.DT) {
  p.gravityCooldown = Math.max(0, p.gravityCooldown - dt);
  p.meleeCooldown = Math.max(0, p.meleeCooldown - dt);
  p.transferCooldown = Math.max(0, p.transferCooldown - dt);
  p.tetherArcCooldown = Math.max(0, p.tetherArcCooldown - dt);
}

/* ------------------------------------------------------------------------ */
/* Upgrades                                                                  */
/* ------------------------------------------------------------------------ */

const APPLY = {
  vitality: (p) => { p.mods.maxHealthBonus = Math.min(100, p.mods.maxHealthBonus + 25); p.health = Math.min(p.maxHealth, p.health + 25); },
  overclock: (p) => { p.mods.damageMult = Math.min(2, p.mods.damageMult * 1.12); },
  quickhands: (p) => { p.mods.reloadMult = Math.max(0.45, p.mods.reloadMult * 0.8); },
  capacitor: (p) => { p.mods.magMult = Math.min(2.5, p.mods.magMult * 1.25); },
  resonance: (p) => { p.mods.pulseGainMult = Math.min(2, p.mods.pulseGainMult * 1.25); },
  aegis: (p) => { p.mods.shieldBonus = Math.min(100, p.mods.shieldBonus + 25); p.mods.shieldRegenMult = Math.min(2.5, p.mods.shieldRegenMult * 1.25); },
  tempo: (p) => { p.mods.fireRateMult = Math.min(1.5, p.mods.fireRateMult * 1.1); },
  leech: (p) => { p.mods.leech = Math.min(24, p.mods.leech + 6); },
  stride: (p) => { p.mods.speedMult = Math.min(1.2, p.mods.speedMult * 1.05); p.move.speedMult = p.mods.speedMult; },
  unlock_lance: (p) => p.grantWeapon(2),
  unlock_singularity: (p) => p.grantWeapon(3),
  unlock_echo: (p) => p.grantWeapon(5),
};

/**
 * Upgrade catalogue: display data from shared/upgrades.js joined with the
 * authoritative effect. Every effect is clamped so stacking can never produce
 * absurd values (e.g. zero reload time).
 */
export const UPGRADES = Object.freeze(UPGRADE_INFO.map((info) => ({ ...info, apply: APPLY[info.id] })));

export function upgradeById(id) {
  return UPGRADES.find((u) => u.id === id) || null;
}

/**
 * Roll `count` distinct upgrade ids for a player using the world's seeded RNG.
 * Weapon unlocks are only offered when not yet owned, and one is guaranteed
 * on the given waves so new players see the whole arsenal.
 */
export function rollUpgrades(world, p, count, preferWeapon = false) {
  const pool = UPGRADES.filter((u) => u.weapon === undefined || !p.weapons[u.weapon].owned);
  const picks = [];
  if (preferWeapon) {
    const weapons = pool.filter((u) => u.weapon !== undefined);
    if (weapons.length) picks.push(weapons[Math.floor(world.rng() * weapons.length)].id);
  }
  let guard = 0;
  while (picks.length < count && guard++ < 50) {
    const u = pool[Math.floor(world.rng() * pool.length)];
    if (u && !picks.includes(u.id)) picks.push(u.id);
  }
  return picks;
}
