/**
 * Quantum Pulse — transports.
 *
 * Both transports expose the same interface so GameClient never needs to
 * know whether the authoritative simulation is on a server or in-process:
 *
 *   connect(): Promise<welcome>
 *   send(msg)                 — client -> authority
 *   onMessage(cb)             — authority -> client (welcome, s, pong, err)
 *   onStatus(cb)              — 'connected' | 'reconnecting' | 'closed' | 'failed'
 *   tick()                    — LocalTransport only: advance one simulation tick
 *   close()
 *
 * WebSocketTransport is real online play. LocalTransport runs the isomorphic
 * World/Room code in the browser for offline Solo Survival and Training — it
 * is NOT used to fake online play.
 */
import { PROTOCOL_VERSION } from '/shared/constants.js';
import { MSG } from '/shared/protocol.js';

const TOKEN_KEY = 'qp.session';

export class WebSocketTransport {
  /**
   * @param {{name:string, mode:string, room?:string, arena?:string|null}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.isLocal = false;
    this.ws = null;
    this.handlers = [];
    this.statusHandlers = [];
    this.token = null;
    this.rtt = 0;
    this.closedByUser = false;
    this.attempts = 0;
    this.pingTimer = null;
    this.connected = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
      if (saved && saved.mode === opts.mode && (saved.room || '') === (opts.room || '')) this.token = saved.token;
    } catch { /* storage unavailable */ }
  }

  static supported() {
    return typeof WebSocket !== 'undefined';
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  onMessage(cb) { this.handlers.push(cb); }
  onStatus(cb) { this.statusHandlers.push(cb); }
  status(s, info) { for (const cb of this.statusHandlers) cb(s, info); }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url());
      } catch {
        reject(new Error('WebSocket unavailable'));
        return;
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; ws.close(); reject(new Error('Connection timed out')); }
      }, 8000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          t: MSG.HELLO, v: PROTOCOL_VERSION, name: this.opts.name, mode: this.opts.mode,
          room: this.opts.room || '', token: this.token || undefined, arena: this.opts.arena || undefined,
          action: this.opts.action || undefined,
        }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === MSG.WELCOME) {
          this.token = msg.token;
          // Reconnects go back to the room we were given (created or quick-matched).
          if (msg.room) { this.opts.room = msg.room; this.opts.action = 'join'; }
          this.connected = true;
          this.attempts = 0;
          try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: msg.token, mode: this.opts.mode, room: this.opts.room || '' })); } catch { /* ignore */ }
          this.startPing();
          if (!settled) { settled = true; clearTimeout(timeout); resolve(msg); }
          this.status('connected');
        } else if (msg.t === MSG.PONG) {
          const sample = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
        } else if (msg.t === MSG.ERROR && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(msg.msg || 'Server refused the connection'));
          return;
        }
        for (const cb of this.handlers) cb(msg);
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = (ev) => {
        clearTimeout(timeout);
        this.connected = false;
        this.stopPing();
        if (!settled) { settled = true; reject(new Error(ev.reason || 'Could not reach the game server')); return; }
        if (this.closedByUser) { this.status('closed'); return; }
        if (ev.code === 1008) { this.status('failed', ev.reason || 'Disconnected by server'); return; }
        this.reconnect();
      };
    });
  }

  /** Exponential back-off reconnection reusing the session token. */
  reconnect() {
    if (this.closedByUser) return;
    this.attempts++;
    if (this.attempts > 8) { this.status('failed', 'Connection lost'); return; }
    const delay = Math.min(8000, 400 * 2 ** (this.attempts - 1));
    this.status('reconnecting', { attempt: this.attempts, delay });
    setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch(() => this.reconnect());
    }, delay);
  }

  startPing() {
    this.stopPing();
    const ping = () => this.send({ t: MSG.PING, c: performance.now(), r: Math.round(this.rtt) });
    ping();
    this.pingTimer = setInterval(ping, 1000);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  tick() { /* server-driven */ }

  close() {
    this.closedByUser = true;
    this.stopPing();
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    if (this.ws && this.ws.readyState <= 1) {
      try { this.ws.send(JSON.stringify({ t: MSG.LEAVE })); } catch { /* ignore */ }
      this.ws.close(1000, 'leave');
    }
  }
}

export class LocalTransport {
  /**
   * @param {{name:string, mode:string, arena?:string}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.isLocal = true;
    this.handlers = [];
    this.statusHandlers = [];
    this.queue = [];
    this.rtt = 0;
    this.room = null;
    this.playerId = 0;
  }

  onMessage(cb) { this.handlers.push(cb); }
  onStatus(cb) { this.statusHandlers.push(cb); }

  async connect() {
    // Loaded lazily so online players never download the simulation.
    const { Room } = await import('/sim/Room.js');
    this.room = new Room({ id: 'local', mode: this.opts.mode, arenaId: this.opts.arena, snapshotRate: 60, maxPlayers: 1 });
    let welcome = null;
    const sink = {
      send: (m) => { if (m.t === MSG.WELCOME) welcome = m; else this.queue.push(m); },
      snapshot: (shared, me) => this.queue.push({ t: MSG.SNAPSHOT, me, w: shared }),
    };
    const res = this.room.join({ name: this.opts.name, token: null }, sink);
    if (!res.ok) throw new Error(res.error);
    this.playerId = res.player.id;
    for (const cb of this.statusHandlers) cb('connected');
    return welcome;
  }

  /** Messages go through the same validation path the server uses. */
  send(msg) {
    if (!this.room) return;
    if (msg.t === MSG.PING) return;
    // Round-trip through JSON so the local authority never shares object references with the client.
    const clean = JSON.parse(JSON.stringify(msg));
    this.room.handle(this.playerId, clean);
  }

  /** Advance the authoritative simulation by exactly one tick. */
  tick() {
    if (!this.room) return;
    this.room.tick();
    this.flush();
  }

  flush() {
    if (!this.queue.length) return;
    const q = this.queue;
    this.queue = [];
    for (const m of q) for (const cb of this.handlers) cb(m);
  }

  close() {
    this.room = null;
    this.queue.length = 0;
  }
}

