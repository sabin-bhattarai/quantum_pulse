/**
 * Headless Quantum Pulse client for network testing.
 *
 * Uses the real client modules (Prediction, Interpolation) and the real wire
 * protocol, so its measurements reflect what a browser player experiences —
 * minus rendering. A `script(bot)` callback supplies each tick's input.
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION, SIM, NET } from '../../src/shared/constants.js';
import { MSG, encodeInput } from '../../src/shared/protocol.js';
import { createArena, ColliderKind } from '../../src/shared/arenas.js';
import { createCollisionEnv } from '../../src/shared/movement.js';
import { Prediction } from '../../src/client/Prediction.js';
import { SnapshotBuffer, ServerClock, interpolateCategory } from '../../src/client/Interpolation.js';

export class NetBot {
  /**
   * @param {{url:string, name:string, mode?:string, room?:string, arena?:string}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.welcome = null;
    this.me = null;
    this.seq = 0;
    this.pending = [];
    this.sendTimer = 0;
    this.buffer = new SnapshotBuffer();
    this.clock = new ServerClock();
    this.remote = new Map();
    this.frame = 0;
    this.rtt = 0;
    this.lastArrival = 0;
    this.stats = {
      ticks: 0, snapshots: 0, extrapolatedFrames: 0, frames: 0,
      corrections: 0, correctionSum: 0, correctionMax: 0,
      arrivalGaps: [],
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      ws.on('open', () => ws.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: this.opts.name, mode: this.opts.mode || 'ffa', room: this.opts.room || '', arena: this.opts.arena })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.t === MSG.WELCOME) {
          this.welcome = msg;
          this.arena = createArena(msg.arena);
          this.env = createCollisionEnv(this.arena);
          this.prediction = new Prediction(this.env);
          resolve(msg);
        } else if (msg.t === MSG.SNAPSHOT) this.onSnapshot(msg.w, msg.me);
        else if (msg.t === MSG.PONG) {
          const s = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.8 + s * 0.2 : s;
        } else if (msg.t === MSG.ERROR) reject(new Error(msg.msg));
      });
      ws.on('error', reject);
    });
  }

  onSnapshot(w, me) {
    const now = performance.now();
    if (this.lastArrival) this.stats.arrivalGaps.push(now - this.lastArrival);
    this.lastArrival = now;
    this.stats.snapshots++;
    this.clock.observe(w.k, now);
    this.buffer.push(w);
    for (const c of this.arena.colliders) if (c.kind === ColliderKind.PROP) c.alive = !w.d.includes(c.id);
    this.env.fractureCount = 0;
    if (!me) return;
    this.me = me;
    const before = this.prediction.corrections;
    this.prediction.reconcile(me.ms, me.a);
    if (this.prediction.corrections > before) {
      const m = this.prediction.lastCorrection;
      if (m < 3.5) { // respawns/teleports snap and are not netcode errors
        this.stats.corrections++;
        this.stats.correctionSum += m;
        this.stats.correctionMax = Math.max(this.stats.correctionMax, m);
      }
    }
  }

  /** Render tick the player would be looking at right now. */
  renderTick(now = performance.now()) {
    return this.clock.now(now) - this.interpDelayTicks(now);
  }

  interpDelayTicks() {
    return (NET.INTERP_DELAY_MS / 1000) * SIM.TICK_RATE;
  }

  /** Run the fixed-tick loop until stop(). */
  start(script) {
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      while (acc >= SIM.DT) {
        acc -= SIM.DT;
        this.tick(script, now);
      }
    }, 4);
    this.pingTimer = setInterval(() => this.send({ t: MSG.PING, c: performance.now(), r: Math.round(this.rtt) }), 1000);
  }

  tick(script, now) {
    this.stats.ticks++;
    // What this player sees of everyone else (same code path as GameClient).
    this.frame++;
    const rt = this.renderTick(now);
    interpolateCategory(this.buffer, rt, '_p', 1, 4, this.remote, this.frame);
    const br = this.buffer.bracket(rt, {});
    if (br.b) {
      this.stats.frames++;
      if (br.extrapolate > 0) this.stats.extrapolatedFrames++;
    }
    if (!this.prediction || !this.prediction.initialized) return;
    const input = script(this);
    const cmd = { seq: this.seq++, mx: input.mx || 0, mz: input.mz || 0, yaw: input.yaw || 0, pitch: input.pitch || 0, buttons: input.buttons || 0, weapon: input.weapon || 0, viewTick: Math.max(0, Math.floor(rt)) };
    this.prediction.apply(cmd);
    this.pending.push(encodeInput(cmd));
    this.sendTimer += SIM.DT;
    if (this.sendTimer >= 1 / NET.INPUT_SEND_RATE || this.pending.length >= 4) {
      this.sendTimer = 0;
      while (this.pending.length) this.send({ t: MSG.INPUT, i: this.pending.splice(0, NET.MAX_INPUTS_PER_PACKET) });
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }
}
