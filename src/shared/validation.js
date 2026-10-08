/**
 * Quantum Pulse — payload validation.
 *
 * Every message from a client is untrusted. These validators:
 *   - reject unknown message types and unknown fields,
 *   - reject wrong types / non-finite numbers,
 *   - clamp numeric ranges,
 *   - bound array sizes,
 *   - sanitise free text (display names).
 * They return `{ ok: true, value }` with a NEW clean object, or
 * `{ ok: false, error }`. Callers must only ever use `value`.
 *
 * NOTE: these checks are protocol hygiene. Real anti-cheat is the fact that
 * the server simulates movement, cooldowns, ammunition, hits and damage
 * itself; a client can only ask "I pressed these buttons while looking here".
 * @module shared/validation
 */
import { NET, BTN_ALL, MODES, LIMITS, PROTOCOL_VERSION } from './constants.js';
import { CLIENT_MESSAGE_TYPES, MSG, INPUT_ARRAY_LENGTH } from './protocol.js';
import { WEAPON_COUNT } from './weapons.js';
import { ARENA_IDS } from './arenas.js';
import { clamp, wrapAngle, isFiniteNumber } from './math.js';

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

/** True for plain JSON objects (not arrays / null). */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reject objects that carry keys outside the allow-list. */
function hasOnlyKeys(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return false;
  return true;
}

/**
 * Parse a raw network frame into an object.
 * @param {string|Uint8Array|ArrayBuffer} raw
 * @param {number} [maxBytes]
 */
export function parseMessage(raw, maxBytes = NET.MAX_PACKET_BYTES) {
  let text;
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw.byteLength === 'number') {
    if (raw.byteLength > maxBytes) return fail('packet too large');
    text = new TextDecoder().decode(raw);
  } else return fail('unsupported frame');
  if (text.length > maxBytes) return fail('packet too large');
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail('malformed JSON');
  }
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return fail('missing message type');
  if (!CLIENT_MESSAGE_TYPES.includes(msg.t)) return fail(`unknown message type`);
  return ok(msg);
}

/**
 * Sanitise a display name: printable characters only, no markup characters,
 * collapsed whitespace, bounded length. Never returns an empty string.
 */
export function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC');
  // Strip control characters, zero-width/bidi overrides and HTML-sensitive characters.
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-\u200F\u202A-\u202E\u2066-\u2069<>&"'`\\/]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, LIMITS.MAX_NAME_LENGTH).join('');
  if (!s) s = `Runner-${Math.floor(1000 + Math.random() * 9000)}`;
  return s;
}

/**
 * Validate the hello/join message.
 * @param {object} msg parsed message
 * @param {{allowOffline?: boolean}} [opts] offline modes are only accepted by the in-browser host
 */
export function validateHello(msg, opts = {}) {
  if (!isPlainObject(msg) || msg.t !== MSG.HELLO) return fail('not a hello');
  if (!hasOnlyKeys(msg, ['t', 'v', 'name', 'mode', 'room', 'token', 'arena', 'action'])) return fail('unknown fields');
  if (msg.v !== PROTOCOL_VERSION) return fail(`protocol mismatch (server ${PROTOCOL_VERSION})`);
  const allowedModes = opts.allowOffline ? Object.values(MODES) : [MODES.FFA, MODES.COOP];
  if (!allowedModes.includes(msg.mode)) return fail('invalid mode');
  let room = '';
  if (msg.room !== undefined) {
    if (typeof msg.room !== 'string' || !/^[A-Za-z0-9]{0,8}$/.test(msg.room)) return fail('invalid room code');
    room = msg.room.toUpperCase();
  }
  let token = null;
  if (msg.token !== undefined && msg.token !== null) {
    if (typeof msg.token !== 'string' || !/^[a-f0-9-]{36}$/.test(msg.token)) return fail('invalid token');
    token = msg.token;
  }
  let arena = null;
  if (msg.arena !== undefined && msg.arena !== null) {
    if (!ARENA_IDS.includes(msg.arena)) return fail('invalid arena');
    arena = msg.arena;
  }
  // create a room / join by code / quick match (FFA); omitted = join if a code is given, else quick
  let action = room ? 'join' : 'quick';
  if (msg.action !== undefined) {
    if (!['create', 'join', 'quick'].includes(msg.action)) return fail('invalid action');
    action = msg.action;
  }
  return ok({ name: sanitizeName(msg.name), mode: msg.mode, room, token, arena, action });
}

/**
 * Validate a single encoded input command array.
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
export function validateInputArray(a) {
  if (!Array.isArray(a) || a.length !== INPUT_ARRAY_LENGTH) return fail('bad input shape');
  for (let i = 0; i < a.length; i++) if (!isFiniteNumber(a[i])) return fail('non-finite input');
  const [seq, mx, mz, yaw, pitch, buttons, weapon, viewTick] = a;
  if (!Number.isInteger(seq) || seq < 0 || seq > 0x7fffffff) return fail('bad seq');
  if (!Number.isInteger(buttons) || buttons < 0 || buttons > BTN_ALL) return fail('bad buttons');
  if (!Number.isInteger(weapon) || weapon < 0 || weapon >= WEAPON_COUNT) return fail('bad weapon');
  if (!Number.isInteger(viewTick) || viewTick < 0) return fail('bad view tick');
  return ok({
    seq,
    mx: clamp(Math.round(mx), -1, 1),
    mz: clamp(Math.round(mz), -1, 1),
    yaw: wrapAngle(yaw),
    pitch: clamp(pitch, -1.55, 1.55),
    buttons,
    weapon,
    viewTick,
  });
}

/** Validate an input packet `{t:'in', i:[[...], ...]}`. */
export function validateInputPacket(msg) {
  if (!isPlainObject(msg) || msg.t !== MSG.INPUT) return fail('not an input packet');
  if (!hasOnlyKeys(msg, ['t', 'i'])) return fail('unknown fields');
  if (!Array.isArray(msg.i) || msg.i.length === 0 || msg.i.length > NET.MAX_INPUTS_PER_PACKET) return fail('bad input count');
  const out = [];
  let lastSeq = -1;
  for (const a of msg.i) {
    const r = validateInputArray(a);
    if (!r.ok) return r;
    if (r.value.seq <= lastSeq) return fail('inputs out of order');
    lastSeq = r.value.seq;
    out.push(r.value);
  }
  return ok(out);
}

/** Validate an upgrade choice `{t:'up', c:<index>}`. */
export function validateUpgrade(msg) {
  if (!isPlainObject(msg) || msg.t !== MSG.UPGRADE) return fail('not an upgrade');
  if (!hasOnlyKeys(msg, ['t', 'c'])) return fail('unknown fields');
  if (!Number.isInteger(msg.c) || msg.c < 0 || msg.c > 7) return fail('bad choice');
  return ok({ choice: msg.c });
}

/**
 * Validate a ping `{t:'ping', c:<client time>, r?:<last measured RTT ms>}`.
 * The reported RTT is used for scoreboard display only, never for gameplay.
 */
export function validatePing(msg) {
  if (!isPlainObject(msg) || msg.t !== MSG.PING) return fail('not a ping');
  if (!hasOnlyKeys(msg, ['t', 'c', 'r'])) return fail('unknown fields');
  if (!isFiniteNumber(msg.c)) return fail('bad ping');
  const value = { c: msg.c };
  if (msg.r !== undefined) {
    if (!isFiniteNumber(msg.r)) return fail('bad rtt');
    value.r = clamp(Math.round(msg.r), 0, 5000);
  }
  return ok(value);
}
