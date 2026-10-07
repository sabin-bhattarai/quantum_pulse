/**
 * Quantum Pulse — weapon definitions (data only).
 *
 * Both sides read this table: the server uses it to simulate and validate
 * every shot (src/server/Weapons.js), the client uses it for HUD text,
 * crosshair spread and purely cosmetic muzzle effects. The client NEVER
 * decides hits, damage, ammunition or cooldowns.
 * @module shared/weapons
 */
import { clamp } from './math.js';
import { FractureMode } from './gravity.js';

export const WeaponType = Object.freeze({
  HITSCAN: 'hitscan',
  PELLETS: 'pellets',
  CHARGE: 'charge',
  PROJECTILE: 'projectile',
  MELEE: 'melee',
  ECHO: 'echo',
});

/**
 * @typedef {object} WeaponDef
 * @property {string} id
 * @property {string} name
 * @property {string} type one of WeaponType
 * @property {number} damage base damage per hit / pellet
 * @property {number} fireInterval seconds between shots
 * @property {number} magazine rounds per magazine (0 = no ammunition)
 * @property {number} reloadTime seconds
 * @property {number} range metres
 * @property {string} sfx audio hook id
 * @property {string} vfx visual effect hook id
 * @property {number} color hex colour used for tracers and HUD accents
 */

/** @type {ReadonlyArray<WeaponDef>} */
export const WEAPONS = Object.freeze([
  {
    id: 'carbine', name: 'Pulse Carbine', slot: 1, type: WeaponType.HITSCAN,
    description: 'Automatic mid-range rifle. Accurate while grounded, unstable at high speed.',
    damage: 13, headMult: 1.7, fireInterval: 0.095, magazine: 32, reloadTime: 1.35, range: 140,
    falloffStart: 45, falloffEnd: 120, falloffMin: 0.6,
    spreadBase: 0.004, spreadPerSpeed: 0.0016, spreadAir: 0.012, spreadMax: 0.05, aimSpreadScale: 0.45,
    recoil: 0.012, auto: true, sfx: 'carbine', vfx: 'tracer', color: 0x5ff6ff,
  },
  {
    id: 'scatter', name: 'Arc Scatter', slot: 2, type: WeaponType.PELLETS,
    description: 'Short-range energy shotgun. Arcing pellets briefly stun light enemies.',
    damage: 8.5, headMult: 1.25, pellets: 10, fireInterval: 0.78, magazine: 6, reloadTime: 1.8, range: 32,
    spreadBase: 0.085, spreadPerSpeed: 0.0006, spreadAir: 0.01, spreadMax: 0.12, aimSpreadScale: 0.7,
    projectileSpeed: 75, projectileGravity: 14, projectileLife: 0.45, projectileRadius: 0.18,
    stunLight: 0.45, recoil: 0.06, auto: false, sfx: 'scatter', vfx: 'arc', color: 0xff5bd8,
  },
  {
    id: 'lance', name: 'Vector Lance', slot: 3, type: WeaponType.CHARGE,
    description: 'Hold to charge, release to fire a piercing beam. Glows amber at full power.',
    damage: 30, minDamage: 30, maxDamage: 125, headMult: 1.5, chargeTime: 1.0, pierce: 3,
    fireInterval: 0.35, magazine: 5, reloadTime: 2.0, range: 220,
    spreadBase: 0.001, spreadPerSpeed: 0.0004, spreadAir: 0.004, spreadMax: 0.02, aimSpreadScale: 0.2,
    recoil: 0.05, auto: false, sfx: 'lance', vfx: 'beam', color: 0xb38cff,
  },
  {
    id: 'singularity', name: 'Singularity Launcher', slot: 4, type: WeaponType.PROJECTILE,
    description: 'Slow quantum orb that tears open a Gravity Fracture on impact. Long cooldown.',
    damage: 45, splashDamage: 55, splashRadius: 5, headMult: 1, fireInterval: 7.0, magazine: 1, reloadTime: 0.6,
    range: 80, projectileSpeed: 24, projectileGravity: 2, projectileLife: 3.2, projectileRadius: 0.45,
    fracture: { radius: 9, strength: 34, duration: 3.6, mode: FractureMode.ATTRACT },
    spreadBase: 0, spreadPerSpeed: 0, spreadAir: 0, spreadMax: 0, aimSpreadScale: 1,
    recoil: 0.08, auto: false, sfx: 'singularity', vfx: 'orb', color: 0xffb347,
  },
  {
    id: 'blades', name: 'Phase Blades', slot: 5, type: WeaponType.MELEE,
    description: 'Quantum melee slash. Chain swings on the beat for bonus damage; alt-fire deflects projectiles.',
    damage: 48, headMult: 1, fireInterval: 0.45, magazine: 0, reloadTime: 0, range: 3.6, arcCos: 0.55,
    timingWindowStart: 0.45, timingWindowEnd: 0.75, timingBonus: 1.6,
    deflectWindow: 0.32, deflectCooldown: 1.4, deflectRange: 3.6,
    spreadBase: 0, spreadPerSpeed: 0, spreadAir: 0, spreadMax: 0, aimSpreadScale: 1,
    recoil: 0, auto: true, sfx: 'blades', vfx: 'slash', color: 0x7dffb0,
  },
  {
    id: 'echo', name: 'Echo Repeater', slot: 6, type: WeaponType.ECHO,
    description: 'Each shot repeats from the same trajectory 0.6 s later. Watch the echo markers.',
    damage: 15, headMult: 1.6, echoDelay: 0.6, echoDamageMult: 0.6, fireInterval: 0.24, magazine: 12, reloadTime: 1.6,
    range: 150, spreadBase: 0.003, spreadPerSpeed: 0.001, spreadAir: 0.008, spreadMax: 0.03, aimSpreadScale: 0.5,
    recoil: 0.02, auto: true, sfx: 'echo', vfx: 'echo', color: 0x9dff5b,
  },
]);

export const WEAPON_COUNT = WEAPONS.length;

/** Look up by index with bounds checking. */
export function weaponDef(index) {
  return WEAPONS[clamp(index | 0, 0, WEAPONS.length - 1)];
}

/**
 * Shot spread (radians of cone half-angle) for the current movement.
 * Momentum combat: faster movement destabilises precision weapons; aiming
 * (right mouse) tightens the cone. Always clamped to spreadMax.
 */
export function computeSpread(def, horizontalSpeed, airborne, aiming) {
  let s = def.spreadBase + Math.max(0, horizontalSpeed - 6) * def.spreadPerSpeed + (airborne ? def.spreadAir : 0);
  if (aiming) s *= def.aimSpreadScale;
  return clamp(s, 0, def.spreadMax || s);
}

/**
 * Momentum bonus applied to damage. Capped at +30% so speed is rewarded
 * without making stationary play pointless.
 */
export function momentumDamageScale(speed) {
  return 1 + clamp((speed - 10) / 24, 0, 0.3);
}

/** Damage falloff for hitscan weapons. */
export function falloffScale(def, distance) {
  if (!def.falloffStart) return 1;
  if (distance <= def.falloffStart) return 1;
  const t = clamp((distance - def.falloffStart) / (def.falloffEnd - def.falloffStart), 0, 1);
  return 1 - t * (1 - def.falloffMin);
}

/** Vector Lance damage for a given charge fraction [0, 1]. */
export function lanceDamage(def, charge01) {
  const c = clamp(charge01, 0, 1);
  return def.minDamage + (def.maxDamage - def.minDamage) * c * c;
}
