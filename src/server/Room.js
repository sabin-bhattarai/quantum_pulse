/**
 * Quantum Pulse — a match room.
 *
 * A Room owns one authoritative World and the set of connected clients. It is
 * transport-agnostic: the WebSocket server (GameServer.js) and the in-browser
 * offline host (public/network.js LocalTransport) both talk to it through
 * "sinks" — objects with `send(msg)` and `snapshot(shared, me, getSharedJson)`.
 * @module server/Room
 */
import { SIM, NET, MATCH, MODES } from '../shared/constants.js';
import { MSG } from '../shared/protocol.js';
import { validateInputPacket, validateUpgrade, validatePing } from '../shared/validation.js';
import { World } from './World.js';
import { ARENA_IDS } from '../shared/arenas.js';

/** RFC 4122 v4 token using getRandomValues (works in insecure browser contexts too). */
export function makeToken() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Room {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.mode
   * @param {string} [opts.arenaId]
   * @param {string} [opts.code] private room code ('' = public)
   * @param {number} [opts.snapshotRate] snapshots per second
   * @param {number} [opts.maxPlayers]
   * @param {number} [opts.matchDuration]
   * @param {number} [opts.seed]
   */
  constructor(opts) {
    if (!Object.values(MODES).includes(opts.mode)) throw new Error(`unknown mode: ${opts.mode}`);
    if (opts.arenaId && !ARENA_IDS.includes(opts.arenaId)) throw new Error(`unknown arena: ${opts.arenaId}`);
    this.id = opts.id;
    this.mode = opts.mode;
    this.code = opts.code || '';
    this.maxPlayers = opts.maxPlayers || (opts.mode === MODES.FFA ? MATCH.FFA_MAX_PLAYERS : opts.mode === MODES.COOP ? MATCH.COOP_MAX_PLAYERS : 1);
    this.world = new World({ mode: opts.mode, arenaId: opts.arenaId, seed: opts.seed, matchDuration: opts.matchDuration });
    this.snapshotEvery = Math.max(1, Math.round(SIM.TICK_RATE / (opts.snapshotRate || SIM.SNAPSHOT_RATE)));
    this.snapshotCount = 0;
    /** @type {Map<number, object>} playerId -> sink */
    this.clients = new Map();
    /** @type {Map<string, number>} reconnection token -> playerId */
    this.tokens = new Map();
    this.tickMsAvg = 0;
  }

  get playerCount() {
    return this.world.players.size;
  }

  get connectedCount() {
    return this.clients.size;
  }

  /** Can a new player join right now? */
  get joinable() {
    if (this.world.players.size >= this.maxPlayers) return false;
    if (this.mode === MODES.COOP) {
      const ph = this.world.rules.phase;
      return ph === 'countdown' || ph === 'intermission' || ph === 'wave';
    }
    return true;
  }

  /**
   * Join or re-join (with a token) the room.
   * @param {{name:string, token:string|null}} hello validated hello payload
   * @param {object} sink
   * @returns {{ok:true, player:object}|{ok:false, error:string}}
   */
  join(hello, sink) {
    let p = null;
    if (hello.token && this.tokens.has(hello.token)) {
      p = this.world.players.get(this.tokens.get(hello.token));
      if (p && !this.clients.has(p.id)) {
        this.world.setPlayerActive(p, true);
      } else {
        p = null; // token in use by a live connection — treat as a fresh join
      }
    }
    if (!p) {
      if (!this.joinable) return { ok: false, error: 'room full or match in progress' };
      p = this.world.addPlayer(hello.name, makeToken());
      if (!p) return { ok: false, error: 'room full' };
      this.tokens.set(p.token, p.id);
    }
    this.clients.set(p.id, sink);
    sink.send({
      t: MSG.WELCOME,
      id: p.id,
      token: p.token,
      mode: this.mode,
      arena: this.world.arena.id,
      room: this.code || this.id,
      tick: this.world.tick,
      tickRate: SIM.TICK_RATE,
      snapshotRate: SIM.TICK_RATE / this.snapshotEvery,
      maxPlayers: this.maxPlayers,
      seed: this.world.seed,
    });
    return { ok: true, player: p };
  }

  /**
   * Remove a client. Graceful leaves free the slot immediately; dropped
   * connections keep the player (and stats) for RECONNECT_GRACE_MS.
   */
  leave(playerId, graceful) {
    this.clients.delete(playerId);
    const p = this.world.players.get(playerId);
    if (!p) return;
    if (graceful) {
      this.tokens.delete(p.token);
      this.world.removePlayer(playerId);
    } else {
      this.world.setPlayerActive(p, false);
      p.disconnectedAt = this.world.time;
    }
  }

  /**
   * Handle an already-parsed message from a joined client.
   * @returns {{ok:boolean, error?:string}}
   */
  handle(playerId, msg) {
    const p = this.world.players.get(playerId);
    const sink = this.clients.get(playerId);
    if (!p || !sink) return { ok: false, error: 'not in room' };
    switch (msg.t) {
      case MSG.INPUT: {
        const r = validateInputPacket(msg);
        if (!r.ok) return r;
        this.world.queueInputs(p, r.value);
        return { ok: true };
      }
      case MSG.UPGRADE: {
        const r = validateUpgrade(msg);
        if (!r.ok) return r;
        this.world.rules.onUpgradeChosen(p, r.value.choice);
        return { ok: true };
      }
      case MSG.PING: {
        const r = validatePing(msg);
        if (!r.ok) return r;
        if (r.value.r !== undefined) p.pingMs = r.value.r; // display only
        sink.send({ t: MSG.PONG, c: r.value.c, k: this.world.tick });
        return { ok: true };
      }
      case MSG.LEAVE:
        this.leave(playerId, true);
        return { ok: true };
      case MSG.HELLO:
        return { ok: false, error: 'already joined' };
      default:
        return { ok: false, error: 'unknown message' };
    }
  }

  /** Advance one fixed tick and broadcast snapshots on schedule. */
  tick() {
    const t0 = globalThis.performance ? performance.now() : Date.now();
    this.world.step();
    const t1 = globalThis.performance ? performance.now() : Date.now();
    this.tickMsAvg = this.tickMsAvg * 0.95 + (t1 - t0) * 0.05;
    this.world.serverTickMs = this.tickMsAvg;
    if (this.world.tick % this.snapshotEvery === 0) this.broadcast();
    if ((this.world.tick & 63) === 0) this.purgeDisconnected();
  }

  broadcast() {
    this.snapshotCount++;
    // Scoreboard rows are only needed ~2x per second.
    const snapshotsPerSecond = SIM.TICK_RATE / this.snapshotEvery;
    const scoreboardEvery = Math.max(1, Math.round(snapshotsPerSecond / 2));
    const includeScoreboard = (this.snapshotCount - 1) % scoreboardEvery === 0;
    const shared = this.world.buildSharedSnapshot(includeScoreboard);
    let json = null;
    const getJson = () => (json ??= JSON.stringify(shared));
    for (const [pid, sink] of this.clients) {
      const p = this.world.players.get(pid);
      if (!p) continue;
      sink.snapshot(shared, this.world.buildPrivateState(p), getJson);
    }
  }

  purgeDisconnected() {
    const grace = NET.RECONNECT_GRACE_MS / 1000;
    for (const p of [...this.world.players.values()]) {
      if (!p.connected && this.world.time - p.disconnectedAt > grace) {
        this.tokens.delete(p.token);
        this.world.removePlayer(p.id);
      }
    }
  }

  /** True when nobody is connected and no reconnect slot is pending. */
  get disposable() {
    return this.clients.size === 0 && [...this.world.players.values()].every((p) => !p.connected && this.world.time - p.disconnectedAt > NET.RECONNECT_GRACE_MS / 1000);
  }
}
