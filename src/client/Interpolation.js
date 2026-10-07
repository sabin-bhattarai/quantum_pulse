/**
 * Quantum Pulse — entity interpolation and server clock estimation.
 *
 * WHAT: remote players, enemies and projectiles are rendered slightly in the
 * past (renderTick = estimatedServerTick - delay), between the two snapshots
 * that bracket that moment. Positions are linearly interpolated and angles
 * use the shortest arc.
 *
 * WHY: snapshots arrive at 20 Hz with network jitter; drawing the newest
 * snapshot directly would make everything stutter. Rendering slightly more
 * than one snapshot interval plus the measured jitter behind (see ServerClock)
 * means there is almost always a "next" snapshot.
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

/**
 * Clock sync and adaptive interpolation delay.
 *
 * CLOCK: maps local time to an estimated server tick. Each snapshot gives a
 * sample `tick - localTime`; the offset converges quickly toward early
 * arrivals and slowly toward late ones, approximating the minimum-latency path.
 *
 * ADAPTIVE DELAY: how late each snapshot arrives relative to that baseline is
 * its "lateness". The render delay targets
 *     snapshotInterval + p90(lateness) + INTERP_SAFETY_TICKS
 * so a stable link renders barely one snapshot behind (lower latency, smaller
 * lag-compensation rewinds), while a jittery link buffers enough to keep
 * interpolating instead of extrapolating.
 *
 * LIMITS: delay is clamped to [interval + 0.5 tick, INTERP_DELAY_MAX_MS] and
 * slews at most +6 / -1.5 ticks per second, so remote motion never visibly
 * speeds up or jumps when the delay changes.
 * Rare TCP stalls (beyond p90) are covered by short, capped extrapolation
 * instead of a permanently deeper buffer: every extra tick of delay is also
 * an extra tick of lag-compensation rewind.
 * IF MODIFIED: faster slewing makes remote players visibly speed up/slow down;
 * a higher percentile lets loss stalls inflate the delay and push shots past
 * NET.LAG_COMP_MAX_MS.
 */
export class ServerClock {
  /** @param {number} [snapshotIntervalTicks] ticks between snapshots (3 online at 20 Hz, 1 offline) */
  constructor(snapshotIntervalTicks = SIM.TICK_RATE / SIM.SNAPSHOT_RATE) {
    this.offset = 0;
    this.ready = false;
    this.rate = SIM.TICK_RATE / 1000;
    this.interval = snapshotIntervalTicks;
    this.minDelay = snapshotIntervalTicks + 0.5;
    this.maxDelay = Math.max(this.minDelay, (NET.INTERP_DELAY_MAX_MS / 1000) * SIM.TICK_RATE);
    this.delayTicks = Math.min(this.maxDelay, Math.max(this.minDelay, (NET.INTERP_DELAY_MS / 1000) * SIM.TICK_RATE));
    this.lateness = new Float64Array(NET.INTERP_JITTER_WINDOW);
    this.samples = 0;
    this.jitterTicks = 0;
  }

  /** Feed the tick of a freshly received snapshot. */
  observe(tick, nowMs) {
    const sample = tick - nowMs * this.rate;
    if (!this.ready) { this.offset = sample; this.ready = true; return; }
    const diff = sample - this.offset;
    if (Math.abs(diff) > 30) this.offset = sample; // large jump (tab was hidden)
    else this.offset += diff * (diff > 0 ? 0.15 : 0.02);
    this.lateness[this.samples % this.lateness.length] = Math.max(0, this.offset - sample);
    this.samples++;
    if (this.samples % 10 === 0) {
      const n = Math.min(this.samples, this.lateness.length);
      const sorted = Array.from(this.lateness.subarray(0, n)).sort((a, b) => a - b);
      this.jitterTicks = sorted[Math.floor(n * 0.9)];
    }
  }

  /** Target render delay in ticks for the current jitter estimate. */
  targetDelay() {
    return Math.min(this.maxDelay, Math.max(this.minDelay, this.interval + this.jitterTicks + NET.INTERP_SAFETY_TICKS));
  }

  /** Slew the render delay toward its target (call once per frame). */
  update(dt) {
    const d = this.targetDelay() - this.delayTicks;
    this.delayTicks += d > 0 ? Math.min(d, 6 * dt) : Math.max(d, -1.5 * dt);
  }

  /** Estimated current server tick (fractional). */
  now(nowMs) {
    return nowMs * this.rate + this.offset;
  }

  /** Tick that remote entities should be rendered at right now. */
  renderTick(nowMs) {
    return this.now(nowMs) - this.delayTicks;
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
