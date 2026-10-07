/**
 * Quantum Pulse — uniform 3D spatial hash for neighbour queries.
 *
 * WHAT: entities are bucketed by the integer cell containing their position.
 * A radius query only visits the cells overlapping the query sphere.
 *
 * WHY: boids, projectile hits and splash damage all need "who is near me?".
 * Testing every entity against every other is O(n²): 90 swarm enemies would
 * need ~8,000 distance checks per tick. With cells roughly the size of the
 * neighbourhood radius each query touches a handful of cells holding a handful
 * of entities, so total cost is ~O(n · k) where k is the local density.
 *
 * ASSUMPTIONS: entities expose numeric x/y/z. The hash is rebuilt every tick
 * (clear + insert), which is cheaper than tracking moves for fast enemies.
 *
 * LIMITS: bucket arrays are reused between ticks (no per-tick allocation once
 * warmed up). Hash collisions between distant cells are possible but harmless:
 * queries always re-check the true distance.
 *
 * IF MODIFIED: a cell size much smaller than the query radius makes each query
 * visit many empty cells; much larger makes buckets crowded. Keep it close to
 * the typical query radius (SPATIAL_CELL).
 */
import { SPATIAL_CELL } from '../shared/constants.js';

export class SpatialHash {
  /** @param {number} [cellSize] */
  constructor(cellSize = SPATIAL_CELL) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    /** @type {Map<number, object[]>} */
    this.buckets = new Map();
    /** buckets touched since the last clear */
    this.used = [];
  }

  /** Hash integer cell coordinates into a 32-bit key. */
  key(ix, iy, iz) {
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  }

  /** Empty all buckets while keeping their arrays for reuse. */
  clear() {
    for (let i = 0; i < this.used.length; i++) this.used[i].length = 0;
    this.used.length = 0;
  }

  /** @param {{x:number,y:number,z:number}} e */
  insert(e) {
    const k = this.key(Math.floor(e.x * this.inv), Math.floor(e.y * this.inv), Math.floor(e.z * this.inv));
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    if (b.length === 0) this.used.push(b);
    b.push(e);
  }

  /**
   * Collect entities within `radius` of (x, y, z) into `out` (cleared first).
   * @param {object[]} out reusable result array
   * @param {object} [exclude] entity to skip (usually the querier)
   * @returns {object[]} out
   */
  query(x, y, z, radius, out, exclude = null) {
    out.length = 0;
    const r2 = radius * radius;
    const inv = this.inv;
    const x0 = Math.floor((x - radius) * inv), x1 = Math.floor((x + radius) * inv);
    const y0 = Math.floor((y - radius) * inv), y1 = Math.floor((y + radius) * inv);
    const z0 = Math.floor((z - radius) * inv), z1 = Math.floor((z + radius) * inv);
    const visited = this._visited || (this._visited = []);
    visited.length = 0;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const b = this.buckets.get(this.key(ix, iy, iz));
          // Two cells can hash to the same bucket; visit each bucket once so
          // entities are never reported twice.
          if (!b || b.length === 0 || visited.includes(b)) continue;
          visited.push(b);
          for (let i = 0; i < b.length; i++) {
            const e = b[i];
            if (e === exclude) continue;
            const dx = e.x - x, dy = e.y - y, dz = e.z - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
          }
        }
      }
    }
    return out;
  }
}
