/**
 * Quantum Pulse — allocation-free math helpers shared by server and client.
 *
 * Vectors are plain `{x, y, z}` objects. Functions that produce a vector take an
 * `out` parameter so hot loops can reuse scratch objects instead of allocating.
 *
 * Coordinate convention (matches Three.js): +Y is up, a yaw of 0 looks down -Z,
 * positive pitch looks up.
 * @module shared/math
 */

export const TAU = Math.PI * 2;
export const EPS = 1e-6;

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @param {number} a @param {number} b @param {number} t */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Hermite smoothstep on [e0, e1]. */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/** Round to a fixed number of decimals (used for snapshot quantisation). */
export function quantize(v, decimals = 2) {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

/** Returns true when `v` is a finite number. */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @returns {{x:number,y:number,z:number}} */
export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function copy3(out, a) {
  out.x = a.x; out.y = a.y; out.z = a.z;
  return out;
}

export function set3(out, x, y, z) {
  out.x = x; out.y = y; out.z = z;
  return out;
}

export function add3(out, a, b) {
  out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
  return out;
}

export function sub3(out, a, b) {
  out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
  return out;
}

export function scale3(out, a, s) {
  out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
  return out;
}

export function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function len3(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distSq3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function dist3(a, b) {
  return Math.sqrt(distSq3(a, b));
}

/** Normalise in place-safe manner; zero vectors stay zero. */
export function normalize3(out, a) {
  const l = len3(a);
  if (l < EPS) return set3(out, 0, 0, 0);
  return scale3(out, a, 1 / l);
}

/**
 * Clamp the length of a vector. Used everywhere a force or velocity must be
 * bounded so a bad parameter can never launch an entity out of the map.
 */
export function clampLength3(out, a, maxLen) {
  const l2 = a.x * a.x + a.y * a.y + a.z * a.z;
  if (l2 <= maxLen * maxLen) return copy3(out, a);
  return scale3(out, a, maxLen / Math.sqrt(l2));
}

/**
 * View direction from yaw/pitch.
 *
 * Math: a unit vector on the sphere. Yaw rotates around +Y, pitch tilts toward
 * +Y. With yaw = pitch = 0 the result is (0, 0, -1) — the Three.js camera
 * default — so the client camera and the server raycasts agree exactly.
 * Assumes pitch is clamped to (-PI/2, PI/2) so cos(pitch) > 0.
 */
export function dirFromYawPitch(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Deterministic seeded PRNG (mulberry32). Returns a function producing [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ray vs axis-aligned box using the slab method.
 *
 * What it does: intersects the ray origin + t*dir against the three pairs of
 * parallel planes ("slabs") and keeps the overlapping t interval.
 * Why: arena geometry is made of AABBs, so this is the exact and cheapest test
 * for hitscan weapons, grapple targeting and line-of-sight.
 * Assumptions: `dir` need not be normalised; t is measured in units of |dir|.
 * Division by a zero component yields ±Infinity which the comparisons handle.
 * Limits: only hits with 0 <= t <= maxT are reported.
 * If modified: forgetting the `tmin > tmax` early-out makes rays pass through corners.
 *
 * @returns {number} entry distance t, or -1 when there is no hit.
 */
export function rayAABB(ox, oy, oz, dx, dy, dz, box, maxT) {
  let tmin = 0;
  let tmax = maxT;
  // X slab
  let inv = 1 / dx;
  let t1 = (box.minX - ox) * inv;
  let t2 = (box.maxX - ox) * inv;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  // Y slab
  inv = 1 / dy;
  t1 = (box.minY - oy) * inv;
  t2 = (box.maxY - oy) * inv;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  // Z slab
  inv = 1 / dz;
  t1 = (box.minZ - oz) * inv;
  t2 = (box.maxZ - oz) * inv;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  // NaN guard (0 * Infinity when the origin lies exactly on a slab plane)
  if (tmin !== tmin) return -1;
  return tmin;
}

/**
 * Ray vs sphere. `dir` must be normalised.
 * @returns {number} entry distance or -1.
 */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  let t = tca - thc;
  if (t < 0) t = tca + thc;
  if (t < 0 || t > maxT) return -1;
  return t;
}

/** Overlap test between two AABBs given as {minX..maxZ}. */
export function aabbOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX &&
    a.minY < b.maxY && a.maxY > b.minY &&
    a.minZ < b.maxZ && a.maxZ > b.minZ;
}

/** Squared distance from point p to segment a-b (all {x,y,z}). */
export function pointSegmentDistSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > EPS ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t - px, cy = ay + aby * t - py, cz = az + abz * t - pz;
  return cx * cx + cy * cy + cz * cz;
}

/** Closest point on an AABB to a point, written into out. */
export function closestPointAABB(px, py, pz, box, out) {
  out.x = clamp(px, box.minX, box.maxX);
  out.y = clamp(py, box.minY, box.maxY);
  out.z = clamp(pz, box.minZ, box.maxZ);
  return out;
}

/** Simple string hash used for seeding procedural content. */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
