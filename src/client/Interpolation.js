/**
 * Quantum Pulse — entity interpolation and server clock estimation.
 *
 * WHAT: remote players, enemies and projectiles are rendered slightly in the
 * past (renderTick = estimatedServerTick - delay), between the two snapshots
 * that bracket that moment. Positions are linearly interpolated and angles
 * use the shortest arc.
 *
 * WHY: snapshots arrive at 20 Hz with network jitter; drawing the newest
 * snapshot directly would make everything stutter. Rendering ~2 snapshot
 * intervals behind guarantees there is almost always a "next" snapshot.
 *
 * EXTRAPOLATION: if snapshots stop arriving, entities continue along their
 * last observed velocity for at most NET.EXTRAPOLATE_MAX_MS, then freeze.
 * This hides short hiccups without letting entities drift far away.
 *
 * LAG COMPENSATION: the client sends `viewTick` (= floor(renderTick)) with each
 * input so the server can rewind targets to what this client was seeing.
 *
 * IF MODIFIED: an interpolation delay shorter than one snapshot interval causes
 * constant extrapolation (visible snapping); a much longer one increases the
 * perceived latency of every remote action.
 */
import { SIM, NET } from '../shared/constants.js';
import { lerpAngle } from '../shared/math.js';

/** Clock sync: maps local time to an estimated server tick. */
export class ServerClock {
  constructor() {
    this.offset = 0;
    this.ready = false;
    this.rate = SIM.TICK_RATE / 1000;
  }

  /** Feed the tick of a freshly received snapshot. */
  observe(tick, nowMs) {
    const sample = tick - nowMs * this.rate;
    if (!this.ready) { this.offset = sample; this.ready = true; return; }
    // Converge quickly toward earlier-than-expected arrivals (less queuing
    // delay), slowly toward late ones (jitter), which approximates the
    // minimum-latency path.
    const diff = sample - this.offset;
    if (Math.abs(diff) > 30) this.offset = sample; // large jump (tab was hidden)
    else this.offset += diff * (diff > 0 ? 0.15 : 0.02);
  }

  /** Estimated current server tick (fractional). */
  now(nowMs) {
    return nowMs * this.rate + this.offset;
  }
}

/**
 * Ring buffer of snapshots with per-snapshot id -> array lookups.
 */
export class SnapshotBuffer {
  constructor(capacity = NET.SNAPSHOT_BUFFER) {
    this.capacity = capacity;
    this.snaps = [];
  }

  clear() {
    this.snaps.length = 0;
  }

  push(snap) {
    const last = this.snaps[this.snaps.length - 1];
    if (last && snap.k <= last.k) return; // stale / duplicate
    snap._p = indexById(snap.p);
    snap._e = indexById(snap.e);
    snap._pr = indexById(snap.pr);
    this.snaps.push(snap);
    if (this.snaps.length > this.capacity) this.snaps.shift();
  }

  get newest() {
    return this.snaps[this.snaps.length - 1] || null;
  }

  /** Find bracketing snapshots for a render tick. */
  bracket(renderTick, out) {
    const s = this.snaps;
    out.a = null; out.b = null; out.t = 0; out.extrapolate = 0;
    if (!s.length) return out;
    if (renderTick <= s[0].k) { out.a = out.b = s[0]; return out; }
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].k <= renderTick) {
        if (renderTick <= s[i].k) {
          out.a = s[i - 1]; out.b = s[i];
          out.t = (renderTick - s[i - 1].k) / Math.max(1, s[i].k - s[i - 1].k);
          return out;
        }
        break;
      }
    }
    // Past the newest snapshot: extrapolate from the last two (capped).
    const n = s.length;
    out.a = n > 1 ? s[n - 2] : s[n - 1];
    out.b = s[n - 1];
    const maxTicks = (NET.EXTRAPOLATE_MAX_MS / 1000) * SIM.TICK_RATE;
    out.extrapolate = Math.min(renderTick - out.b.k, maxTicks);
    out.t = 1;
    return out;
  }
}

function indexById(arr) {
  const m = new Map();
  if (arr) for (const e of arr) m.set(e[0], e);
  return m;
}

const _br = { a: null, b: null, t: 0, extrapolate: 0 };

/**
 * Interpolate one entity category into `out` (Map id -> render object).
 * @param {SnapshotBuffer} buf
 * @param {number} renderTick
 * @param {'_p'|'_e'|'_pr'} key category map
 * @param {number} xi index of x in the entity array (y = xi+1, z = xi+2)
 * @param {number} yawIdx index of yaw or -1
 * @param {Map<number, object>} out reused render objects
 * @param {number} frame frame counter used to evict stale objects
 */
export function interpolateCategory(buf, renderTick, key, xi, yawIdx, out, frame) {
  const br = buf.bracket(renderTick, _br);
  if (!br.b) return out;
  const mapA = br.a[key], mapB = br.b[key];
  const dtTicks = Math.max(1, br.b.k - br.a.k);
  for (const [id, eb] of mapB) {
    const ea = mapA.get(id);
    let o = out.get(id);
    if (!o) { o = { id, x: eb[xi], y: eb[xi + 1], z: eb[xi + 2], yaw: 0, raw: eb, seen: 0, born: frame }; out.set(id, o); }
    o.raw = eb;
    o.seen = frame;
    if (ea && ea !== eb) {
      if (br.extrapolate > 0) {
        const vx = (eb[xi] - ea[xi]) / dtTicks, vy = (eb[xi + 1] - ea[xi + 1]) / dtTicks, vz = (eb[xi + 2] - ea[xi + 2]) / dtTicks;
        o.x = eb[xi] + vx * br.extrapolate;
        o.y = eb[xi + 1] + vy * br.extrapolate;
        o.z = eb[xi + 2] + vz * br.extrapolate;
      } else {
        const t = br.t;
        o.x = ea[xi] + (eb[xi] - ea[xi]) * t;
        o.y = ea[xi + 1] + (eb[xi + 1] - ea[xi + 1]) * t;
        o.z = ea[xi + 2] + (eb[xi + 2] - ea[xi + 2]) * t;
      }
      if (yawIdx >= 0) o.yaw = lerpAngle(ea[yawIdx], eb[yawIdx], br.t);
      o.rawA = ea;
      o.t = br.t;
    } else {
      o.x = eb[xi]; o.y = eb[xi + 1]; o.z = eb[xi + 2];
      if (yawIdx >= 0) o.yaw = eb[yawIdx];
      o.rawA = eb;
      o.t = 1;
    }
  }
  for (const [id, o] of out) if (o.seen !== frame) out.delete(id);
  return out;
}
