/**
 * Quantum Pulse — client-side prediction and server reconciliation.
 *
 * WHAT: the local player is simulated immediately with the same deterministic
 * `stepMovement` the server runs, so controls respond with zero latency.
 *
 * HOW (input sequence numbers):
 *   1. Every fixed tick the client builds an input command with an increasing
 *      `seq`, applies it locally, stores it in a ring buffer and sends it.
 *   2. Each snapshot carries the authoritative movement state plus the last
 *      `seq` the server processed ("ack").
 *   3. On receipt we REWIND: start from the server state, then REPLAY every
 *      stored command with seq > ack. The result is the corrected present.
 *   4. The visual difference between the old prediction and the corrected one
 *      is kept as an offset that decays over ~100 ms, so small corrections are
 *      invisible instead of snapping the camera.
 *
 * ASSUMPTIONS: client and server run identical movement code and fixed DT;
 * the collision env mirrors server props/fractures as of the last snapshot.
 * LIMITS: history holds 256 commands (~4 s at 60 Hz); errors larger than
 * SNAP_DISTANCE (respawn, teleport) snap immediately.
 * IF MODIFIED: replaying with a different DT or skipping commands makes every
 * snapshot produce a correction — the camera will visibly jitter.
 */
import { SIM } from '../shared/constants.js';
import { createMoveState, copyMoveState, stepMovement } from '../shared/movement.js';
import { decodeMoveState } from '../shared/protocol.js';

const HISTORY = 256;
const SNAP_DISTANCE = 3.5;
const ERROR_DECAY_PER_SEC = 12;

export class Prediction {
  /** @param {object} env collision env (shared/movement.js createCollisionEnv) */
  constructor(env) {
    this.env = env;
    this.state = createMoveState();
    this.prev = createMoveState();
    this.scratch = createMoveState();
    this.history = [];
    for (let i = 0; i < HISTORY; i++) {
      this.history.push({ seq: -1, input: { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0, viewTick: 0 } });
    }
    this.latestSeq = -1;
    this.initialized = false;
    this.errX = 0; this.errY = 0; this.errZ = 0;
    this.corrections = 0;
    this.lastCorrection = 0;
  }

  /**
   * Predict one input command.
   * @returns {number} movement event flags (for cosmetic effects only)
   */
  apply(cmd) {
    copyMoveState(this.prev, this.state);
    const slot = this.history[cmd.seq % HISTORY];
    slot.seq = cmd.seq;
    const s = slot.input;
    s.seq = cmd.seq; s.mx = cmd.mx; s.mz = cmd.mz; s.yaw = cmd.yaw; s.pitch = cmd.pitch;
    s.buttons = cmd.buttons; s.weapon = cmd.weapon; s.viewTick = cmd.viewTick;
    this.latestSeq = cmd.seq;
    if (!this.initialized) return 0;
    return stepMovement(this.state, cmd, this.env, SIM.DT);
  }

  /**
   * Rewind to the authoritative state and replay unacknowledged inputs.
   * @param {number[]} msArray encoded movement state from the snapshot
   * @param {number} ackSeq last input seq the server processed
   */
  reconcile(msArray, ackSeq) {
    const s = decodeMoveState(msArray, this.scratch);
    if (!this.initialized) {
      copyMoveState(this.state, s);
      copyMoveState(this.prev, s);
      this.initialized = true;
      return;
    }
    // Replay every stored command newer than the ack.
    for (let seq = ackSeq + 1; seq <= this.latestSeq; seq++) {
      const slot = this.history[seq % HISTORY];
      if (slot.seq !== seq) break; // fell out of the ring buffer
      stepMovement(s, slot.input, this.env, SIM.DT);
    }
    const dx = this.state.x - s.x, dy = this.state.y - s.y, dz = this.state.z - s.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 1e-6) {
      this.corrections++;
      this.lastCorrection = Math.sqrt(d2);
    }
    if (d2 > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.errX = this.errY = this.errZ = 0;
      copyMoveState(this.prev, s);
    } else {
      // Keep the rendered position continuous: carry the error and decay it.
      this.errX += dx; this.errY += dy; this.errZ += dz;
      this.prev.x -= dx; this.prev.y -= dy; this.prev.z -= dz;
    }
    // Look direction is client-owned (the server echoes what we sent), so keep ours.
    const yaw = this.state.yaw, pitch = this.state.pitch;
    copyMoveState(this.state, s);
    this.state.yaw = yaw;
    this.state.pitch = pitch;
  }

  /** Decay the visual correction offset. */
  decay(dt) {
    const k = Math.exp(-ERROR_DECAY_PER_SEC * dt);
    this.errX *= k; this.errY *= k; this.errZ *= k;
  }

  /** Smoothed render position: interpolate between the last two predicted ticks plus the correction offset. */
  renderPosition(alpha, out) {
    out.x = this.prev.x + (this.state.x - this.prev.x) * alpha + this.errX;
    out.y = this.prev.y + (this.state.y - this.prev.y) * alpha + this.errY;
    out.z = this.prev.z + (this.state.z - this.prev.z) * alpha + this.errZ;
    return out;
  }

  /** Forget history (used after a reconnect). */
  reset() {
    this.initialized = false;
    for (const h of this.history) h.seq = -1;
    this.errX = this.errY = this.errZ = 0;
  }
}
