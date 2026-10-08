/**
 * Quantum Pulse — WebSocket game server (Node only).
 *
 * Responsibilities:
 *   - accept WebSocket connections and enforce transport-level limits
 *     (max payload, message rate, protocol violations, heartbeats),
 *   - route validated messages to Rooms,
 *   - run every room's fixed-timestep simulation loop.
 *
 * Security model: the server is authoritative. Clients send only input
 * commands; damage, hits, ammunition, cooldowns, kills and scores are always
 * computed by the simulation. Any client-side "anti-cheat" would be advisory
 * only — it can be bypassed by a modified client — so none is relied upon.
 * @module server/GameServer
 */
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { SIM, NET, MATCH, MODES, PROTOCOL_VERSION } from '../shared/constants.js';
import { MSG } from '../shared/protocol.js';
import { parseMessage, validateHello } from '../shared/validation.js';
import { Room } from './Room.js';

let connectionCounter = 0;

/** Room codes: no 0/O or 1/I so they can be read out loud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export class GameServer {
  /**
   * @param {object} opts
   * @param {import('http').Server} opts.server HTTP server to attach to
   * @param {object} opts.config runtime configuration (see server.js)
   * @param {(level:string, msg:string, extra?:object)=>void} [opts.log]
   */
  constructor({ server, config, log }) {
    this.config = config;
    this.log = log || (() => {});
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.connections = new Set();
    this.roomCounter = 0;
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: NET.MAX_PACKET_BYTES,
      perMessageDeflate: false, // avoids compression-bomb and CPU amplification attacks
      verifyClient: (info, cb) => this.verifyClient(info, cb),
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.loopHandle = null;
    this.heartbeatHandle = null;
  }

  /** Optional Origin allow-list (ALLOWED_ORIGINS). */
  verifyClient(info, cb) {
    const allowed = this.config.allowedOrigins;
    if (allowed.length && !allowed.includes(info.origin)) {
      this.log('warn', 'rejected origin', { origin: info.origin });
      cb(false, 403, 'origin not allowed');
      return;
    }
    if (this.connections.size >= this.config.maxConnections) {
      cb(false, 503, 'server full');
      return;
    }
    cb(true);
  }

  start() {
    // Fixed-timestep loop: real time accumulates, the simulation consumes it in
    // exact SIM.DT steps. Catch-up is capped so a stalled process cannot spiral.
    let last = performance.now();
    let acc = 0;
    const stepMs = 1000 / SIM.TICK_RATE;
    this.loopHandle = setInterval(() => {
      const now = performance.now();
      acc += now - last;
      last = now;
      let steps = 0;
      while (acc >= stepMs && steps < SIM.MAX_CATCHUP_TICKS) {
        for (const room of this.rooms.values()) {
          try {
            room.tick();
          } catch (err) {
            this.log('error', 'room tick failed', { room: room.id, err: String(err && err.stack || err) });
          }
        }
        acc -= stepMs;
        steps++;
      }
      if (steps === SIM.MAX_CATCHUP_TICKS) acc = 0;
      this.collectRooms();
    }, Math.max(1, Math.floor(stepMs / 2)));

    this.heartbeatHandle = setInterval(() => {
      const now = Date.now();
      for (const c of this.connections) {
        if (now - c.lastSeen > NET.HEARTBEAT_TIMEOUT_MS) {
          c.ws.terminate();
          continue;
        }
        try { c.ws.ping(); } catch { /* socket closing */ }
      }
    }, NET.PING_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.loopHandle);
    clearInterval(this.heartbeatHandle);
    for (const c of this.connections) c.ws.close(1001, 'server shutting down');
    this.wss.close();
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.connectedCount;
    return { rooms: this.rooms.size, players, connections: this.connections.size, protocol: PROTOCOL_VERSION };
  }

  onConnection(ws, req) {
    const conn = {
      id: ++connectionCounter,
      ws,
      ip: req.socket.remoteAddress,
      tokens: NET.MSG_BURST,
      lastRefill: Date.now(),
      lastSeen: Date.now(),
      violations: 0,
      kicked: false,
      room: null,
      playerId: 0,
      closed: false,
    };
    this.connections.add(conn);
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('pong', () => { conn.lastSeen = Date.now(); });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', (err) => this.log('debug', 'socket error', { id: conn.id, err: String(err) }));
    // Clients must say hello quickly.
    conn.helloTimer = setTimeout(() => {
      if (!conn.room && !conn.closed) ws.close(1008, 'hello timeout');
    }, 5000);
  }

  /** Token-bucket rate limiter. Returns false when the message must be dropped. */
  rateLimit(conn) {
    const now = Date.now();
    conn.tokens = Math.min(NET.MSG_BURST, conn.tokens + ((now - conn.lastRefill) / 1000) * NET.MSG_RATE_PER_SEC);
    conn.lastRefill = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  violation(conn, reason) {
    conn.violations++;
    if (conn.violations <= 3 || conn.violations % 10 === 0) this.log('debug', 'protocol violation', { id: conn.id, reason, n: conn.violations });
    if (conn.violations >= NET.VIOLATION_LIMIT && !conn.closed && !conn.kicked) {
      conn.kicked = true;
      this.send(conn, { t: MSG.ERROR, code: 'violations', msg: 'Too many invalid messages.' });
      this.log('warn', 'disconnecting protocol violator', { id: conn.id, ip: conn.ip });
      conn.ws.close(1008, 'protocol violations');
    }
  }

  send(conn, msg) {
    if (conn.closed || conn.ws.readyState !== 1) return;
    conn.ws.send(JSON.stringify(msg));
  }

  onMessage(conn, data, isBinary) {
    if (conn.kicked || conn.closed) return;
    conn.lastSeen = Date.now();
    if (!this.rateLimit(conn)) { this.violation(conn, 'rate limit'); return; }
    if (isBinary) { this.violation(conn, 'binary frame'); return; }
    const parsed = parseMessage(data.toString('utf8'));
    if (!parsed.ok) { this.violation(conn, parsed.error); return; }
    const msg = parsed.value;

    if (!conn.room) {
      if (msg.t !== MSG.HELLO) { this.violation(conn, 'expected hello'); return; }
      const hello = validateHello(msg);
      if (!hello.ok) {
        this.send(conn, { t: MSG.ERROR, code: 'hello', msg: hello.error });
        conn.ws.close(1008, 'bad hello');
        return;
      }
      this.join(conn, hello.value);
      return;
    }
    const r = conn.room.handle(conn.playerId, msg);
    if (!r.ok) this.violation(conn, r.error);
    if (msg.t === MSG.LEAVE) {
      conn.room = null;
      conn.ws.close(1000, 'bye');
    }
  }

  join(conn, hello) {
    let room = null;
    // Reconnection: find the room holding this token.
    if (hello.token) {
      for (const r of this.rooms.values()) if (r.tokens.has(hello.token)) { room = r; break; }
    }
    if (!room) {
      const found = this.resolveRoom(hello);
      if (found.error) {
        this.send(conn, { t: MSG.ERROR, code: 'room', msg: found.error });
        conn.ws.close(1013, 'no room');
        return;
      }
      room = found.room;
    }
    const sink = {
      send: (m) => this.send(conn, m),
      snapshot: (shared, me, getJson) => {
        if (conn.closed || conn.ws.readyState !== 1) return;
        // Backpressure: skip snapshots for clients that cannot keep up.
        if (conn.ws.bufferedAmount > 256 * 1024) return;
        conn.ws.send(`{"t":"s","me":${JSON.stringify(me)},"w":${getJson()}}`);
      },
    };
    const res = room.join(hello, sink);
    if (!res.ok) {
      this.send(conn, { t: MSG.ERROR, code: 'join', msg: res.error });
      conn.ws.close(1013, 'join failed');
      return;
    }
    clearTimeout(conn.helloTimer);
    conn.room = room;
    conn.playerId = res.player.id;
    this.log('info', 'player joined', { room: room.id, mode: room.mode, name: res.player.name, players: room.connectedCount });
  }

  /**
   * Pick the room for a hello.
   *   create  a new room with a fresh code (FFA rooms then appear in the lobby list)
   *   join    the room with this code (required)
   *   quick   FFA only: the busiest joinable room, else a new one
   * Co-op rooms are private: they are only reachable with `create` or a code.
   * @returns {{room?: Room, error?: string}}
   */
  resolveRoom(hello) {
    const { mode, arena, action } = hello;
    const code = hello.room;
    const label = mode === MODES.COOP ? 'co-op' : 'free-for-all';
    if (action === 'join') {
      if (!code) return { error: 'Enter a room code.' };
      const r = this.roomByCode(mode, code);
      if (!r) return { error: `No ${label} room with code ${code}. Check the code with your friend.` };
      if (!r.joinable) return { error: `Room ${code} is full or between matches. Try again shortly.` };
      return { room: r };
    }
    if (action === 'quick') {
      if (mode === MODES.COOP) return { error: 'Co-op needs a room code: create a room, or join one with a code.' };
      let best = null;
      for (const r of this.rooms.values()) {
        if (r.mode === mode && r.joinable && (!best || r.connectedCount > best.connectedCount)) best = r;
      }
      if (best) return { room: best };
    }
    const room = this.createRoom(mode, arena);
    return room ? { room } : { error: 'The server is full right now. Try again shortly.' };
  }

  roomByCode(mode, code) {
    for (const r of this.rooms.values()) if (r.mode === mode && r.code === code) return r;
    return null;
  }

  /** A fresh, unused room code. */
  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      let used = false;
      for (const r of this.rooms.values()) if (r.code === c) { used = true; break; }
      if (!used) return c;
    }
  }

  /**
   * Public lobby: every free-for-all room (co-op rooms are private and never listed).
   * @returns {Array<{code:string, arena:string, players:number, max:number, phase:string, joinable:boolean}>}
   */
  listRooms() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (r.mode !== MODES.FFA || r.disposable) continue;
      out.push({ code: r.code, arena: r.world.arena.id, players: r.connectedCount, max: r.maxPlayers, phase: r.world.rules.phase, joinable: r.joinable });
    }
    out.sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.players - a.players || a.code.localeCompare(b.code));
    return out;
  }

  /** Create a room with a new code, or null when the server is at its room limit. */
  createRoom(mode, arena) {
    if (this.rooms.size >= this.config.maxRooms) return null;
    const code = this.newCode();
    const id = `${mode}-${++this.roomCounter}`;
    const arenaId = mode === MODES.COOP ? 'reactor_null' : (arena || this.config.ffaArenas[this.roomCounter % this.config.ffaArenas.length]);
    const room = new Room({
      id,
      mode,
      code,
      arenaId,
      snapshotRate: SIM.SNAPSHOT_RATE,
      maxPlayers: mode === MODES.FFA ? this.config.ffaMaxPlayers : MATCH.COOP_MAX_PLAYERS,
      matchDuration: this.config.ffaDuration,
    });
    this.rooms.set(id, room);
    this.log('info', 'room created', { id, mode, arena: arenaId, code: code || undefined });
    return room;
  }

  onClose(conn) {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.helloTimer);
    this.connections.delete(conn);
    if (conn.room) {
      conn.room.leave(conn.playerId, false); // keep slot for reconnection
      conn.room = null;
    }
  }

  collectRooms() {
    for (const [id, r] of this.rooms) {
      if (r.disposable) {
        this.rooms.delete(id);
        this.log('info', 'room closed', { id });
      }
    }
  }
}
