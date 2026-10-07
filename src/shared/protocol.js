/**
 * Quantum Pulse — wire protocol.
 *
 * Messages are small JSON objects `{t: <type>, ...}`. Hot-path payloads
 * (input commands, entities, events) are encoded as flat arrays with
 * quantised numbers instead of keyed objects; this "snapshot compression"
 * typically shrinks a 12-player snapshot by ~70% compared to naive JSON.
 *
 * Protocol changes MUST bump PROTOCOL_VERSION in constants.js and be listed in
 * the pull request's migration notes (see CONTRIBUTING.md).
 * @module shared/protocol
 */
import { MOVE_FIELDS } from './movement.js';
import { quantize } from './math.js';

/** Message type identifiers. */
export const MSG = Object.freeze({
  // client -> server
  HELLO: 'hello',
  INPUT: 'in',
  UPGRADE: 'up',
  PING: 'ping',
  LEAVE: 'bye',
  // server -> client
  WELCOME: 'welcome',
  SNAPSHOT: 's',
  PONG: 'pong',
  ERROR: 'err',
});

/** Allowed client -> server message types (anything else is a protocol violation). */
export const CLIENT_MESSAGE_TYPES = Object.freeze([MSG.HELLO, MSG.INPUT, MSG.UPGRADE, MSG.PING, MSG.LEAVE]);

/** Gameplay events carried inside snapshots as `[code, ...args]`. */
export const EV = Object.freeze({
  HIT: 1, // shooterId, targetId, damage, headshot(0/1), x, y, z, isEnemyTarget
  KILL: 2, // killerId, victimId, weaponIndex, flags, victimName/type
  FIRE: 3, // shooterId, weaponIndex, ox, oy, oz, ex, ey, ez, charge
  EXPLODE: 4, // x, y, z, radius, colorIndex
  DEATH_FX: 5, // enemyType, x, y, z, elite
  DAMAGED: 6, // victimId, damage, fromX, fromY, fromZ
  PULSE: 7, // playerId
  RING: 8, // playerId, ringIndex
  WAVE: 9, // waveNumber, isBoss, isElite
  BOSS: 10, // enemyId, phase
  PROP_BREAK: 11, // colliderId
  DEFLECT: 12, // playerId, x, y, z
  ECHO_MARK: 13, // ownerId, ox, oy, oz, dx, dy, dz, delay
  REVIVE: 14, // reviverId, targetId
  DOWNED: 15, // playerId
  NEAR_MISS: 16, // playerId
  SHOCKWAVE: 17, // x, y, z, radius
  STALKER_WARN: 18, // x, y, z
  TETHER_ARC: 19, // x, y, z
  STREAK: 20, // playerId, count
  TELEGRAPH: 21, // enemyId, kind, x, y, z, duration, dx, dy, dz
  RIFT: 22, // x, y, z
  RELOAD: 23, // playerId, weaponIndex
  MELEE: 24, // playerId, x, y, z
  GRAPPLE: 25, // playerId
  PICKUP: 26, // playerId, kind
  REACTOR_HIT: 27, // damage
  ARENA_PULSE: 28, // phase (0 = telegraph, 1 = fire)
  RIFT_SURGE: 29, // x, y, z
  TRANSFER: 30, // fromId, toId
  ANNOUNCE: 31, // text key, arg
  PLAYER_SHOCKWAVE: 32, // playerId, x, y, z
  DASH: 33, // playerId
});

/** Player entity flags (bitmask in snapshots). */
export const PF = Object.freeze({
  GRAPPLING: 1, PHASED: 2, DOWNED: 4, DEAD: 8, PROTECTED: 16, SLIDING: 32, BOOSTED: 64, CHARGING: 128, REVEALED: 256,
});

/** Enemy entity flags. */
export const EF = Object.freeze({
  ELITE: 1, CLOAKED: 2, TELEGRAPH: 4, SHIELDED: 8, STUNNED: 16, CHARGING: 32, WEAKPOINT_OPEN: 64,
});

/** Projectile kinds. */
export const PK = Object.freeze({
  PELLET: 0, ORB: 1, ENEMY_BOLT: 2, HEAVY_ORB: 3, TITAN_ORB: 4, DEFLECTED: 5,
});

/** Pickup kinds. */
export const PICKUP = Object.freeze({ HEALTH: 0, PULSE: 1, AMMO: 2 });

/** Input command -> compact array. */
export function encodeInput(cmd) {
  return [
    cmd.seq | 0,
    cmd.mx | 0,
    cmd.mz | 0,
    quantize(cmd.yaw, 4),
    quantize(cmd.pitch, 4),
    cmd.buttons | 0,
    cmd.weapon | 0,
    cmd.viewTick | 0,
  ];
}

/** Number of elements in an encoded input. */
export const INPUT_ARRAY_LENGTH = 8;

/** Movement state -> compact array (owner-only reconciliation payload). */
export function encodeMoveState(s) {
  const out = new Array(MOVE_FIELDS.length);
  for (let i = 0; i < MOVE_FIELDS.length; i++) {
    const v = s[MOVE_FIELDS[i]];
    out[i] = typeof v === 'number' ? quantize(v, 4) : (v ? 1 : 0);
  }
  return out;
}

/** Array -> movement state (writes into `out`). */
export function decodeMoveState(arr, out) {
  for (let i = 0; i < MOVE_FIELDS.length; i++) out[MOVE_FIELDS[i]] = arr[i];
  return out;
}
