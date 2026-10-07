/**
 * Quantum Pulse — enemy silhouettes for the "Ink Comic" style.
 *
 * Every archetype must be recognisable by shape alone (colour-blind safe):
 *   0 Drift Swarm    — stubby wasp drone with wings and a stinger
 *   1 Anchor Warden  — heavy round hulk with an anchor hook and armour ring
 *   2 Phase Stalker  — tall mantis with blade arms
 *   3 Rift Caster    — hooded robe with a halo and floating hands
 *   4 Shard Runner   — forward-pointing crystal spearhead with fins
 *   5 Mirror Drone   — faceted diamond with a visor band
 *   7 Target Dummy   — straw training dummy with a target face
 * Bodies use vertex colours (light/dark paint) multiplied by the per-instance
 * archetype colour; eyes are a separate unlit layer so they always glow.
 */
import * as THREE from '/vendor/three/three.module.js';

/** Base tints per archetype (multiplied with the body's vertex colours). */
export const ENEMY_TINTS = Object.freeze({
  0: 0x8e5bd1, 1: 0x5f4a8f, 2: 0x3f2d63, 3: 0xb04ab8, 4: 0xd9822b, 5: 0x9fb7c9, 7: 0xd8c39a,
});
export const ELITE_TINT = 0xe9b425;

function xf(geo, { px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return geo.applyMatrix4(m);
}

/** Merge parts into one non-indexed geometry with a per-part grey value. */
function merge(parts) {
  let total = 0;
  const geos = parts.map(([g, shade]) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    total += ng.attributes.position.count;
    return [ng, shade];
  });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const [g, shade] of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < g.attributes.position.count; i++) col.set([shade, shade, shade], (o + i) * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const eye = (r, x, y, z) => xf(new THREE.SphereGeometry(r, 8, 6), { px: x, py: y, pz: z });

/** @returns {{body: THREE.BufferGeometry, eyes: THREE.BufferGeometry}} */
export function enemyModel(type) {
  switch (type) {
    case 0: return {
      body: merge([
        [xf(new THREE.SphereGeometry(0.42, 12, 8), { sx: 0.9, sy: 0.8, sz: 1.3 }), 1],
        [xf(new THREE.SphereGeometry(0.3, 10, 8), { pz: 0.48, sx: 0.8, sy: 0.75, sz: 1 }), 0.55],
        [xf(new THREE.ConeGeometry(0.12, 0.45, 6), { pz: 0.85, rx: Math.PI / 2 }), 0.35],
        [xf(new THREE.BoxGeometry(0.9, 0.03, 0.34), { px: 0.5, py: 0.28, rz: 0.35 }), 1.25],
        [xf(new THREE.BoxGeometry(0.9, 0.03, 0.34), { px: -0.5, py: 0.28, rz: -0.35 }), 1.25],
      ]),
      eyes: mergePlain([eye(0.09, 0.15, 0.1, -0.48), eye(0.09, -0.15, 0.1, -0.48)]),
    };
    case 1: return {
      body: merge([
        [new THREE.SphereGeometry(1.3, 16, 12), 1],
        [xf(new THREE.TorusGeometry(1.5, 0.2, 8, 28), { rx: Math.PI / 2, py: 0.1 }), 0.5],
        [xf(new THREE.TorusGeometry(0.6, 0.16, 8, 20, Math.PI), { py: -1.55, rz: Math.PI }), 0.4],
        [xf(new THREE.CylinderGeometry(0.14, 0.14, 0.9, 8), { py: -1.15 }), 0.4],
        [xf(new THREE.BoxGeometry(0.5, 1.0, 0.5), { px: 1.45, py: -0.2, rz: 0.3 }), 0.7],
        [xf(new THREE.BoxGeometry(0.5, 1.0, 0.5), { px: -1.45, py: -0.2, rz: -0.3 }), 0.7],
      ]),
      eyes: mergePlain([xf(new THREE.BoxGeometry(1.1, 0.22, 0.2), { py: 0.3, pz: -1.2 })]),
    };
    case 2: return {
      body: merge([
        [xf(new THREE.ConeGeometry(0.34, 1.5, 6), { py: -0.25, rx: Math.PI }), 1],
        [xf(new THREE.ConeGeometry(0.22, 0.5, 4), { py: 0.7, rx: -0.4, pz: -0.1 }), 0.6],
        [xf(new THREE.BoxGeometry(0.06, 1.2, 0.14), { px: 0.42, py: 0.1, pz: -0.35, rx: 0.9 }), 1.3],
        [xf(new THREE.BoxGeometry(0.06, 1.2, 0.14), { px: -0.42, py: 0.1, pz: -0.35, rx: 0.9 }), 1.3],
      ]),
      eyes: mergePlain([xf(new THREE.BoxGeometry(0.08, 0.04, 0.05), { px: 0.07, py: 0.72, pz: -0.28 }), xf(new THREE.BoxGeometry(0.08, 0.04, 0.05), { px: -0.07, py: 0.72, pz: -0.28 })]),
    };
    case 3: return {
      body: merge([
        [xf(new THREE.ConeGeometry(0.7, 1.6, 8), { py: -0.35 }), 1],
        [xf(new THREE.SphereGeometry(0.36, 12, 10), { py: 0.6 }), 0.5],
        [xf(new THREE.ConeGeometry(0.42, 0.55, 8, 1, true), { py: 0.85 }), 0.8],
        [xf(new THREE.TorusGeometry(0.55, 0.05, 6, 24), { py: 1.25, rx: Math.PI / 2 }), 1.4],
        [xf(new THREE.SphereGeometry(0.16, 8, 6), { px: 0.85, py: 0.1, pz: -0.2 }), 1.3],
        [xf(new THREE.SphereGeometry(0.16, 8, 6), { px: -0.85, py: 0.1, pz: -0.2 }), 1.3],
      ]),
      eyes: mergePlain([eye(0.06, 0, 0.66, -0.33), eye(0.06, 0.13, 0.6, -0.31), eye(0.06, -0.13, 0.6, -0.31)]),
    };
    case 4: return {
      body: merge([
        [xf(new THREE.ConeGeometry(0.55, 1.8, 4), { rx: -Math.PI / 2 }), 1],
        [xf(new THREE.BoxGeometry(1.2, 0.06, 0.5), { pz: 0.4 }), 0.55],
        [xf(new THREE.BoxGeometry(0.06, 0.8, 0.5), { pz: 0.45, py: 0.25 }), 0.55],
      ]),
      eyes: mergePlain([xf(new THREE.BoxGeometry(0.34, 0.08, 0.1), { pz: -0.35, py: 0.18 })]),
    };
    case 5: return {
      body: merge([
        [xf(new THREE.OctahedronGeometry(0.8, 0), { sy: 0.65 }), 1.25],
        [xf(new THREE.TorusGeometry(1.0, 0.07, 4, 6), { rx: Math.PI / 2 }), 0.45],
      ]),
      eyes: mergePlain([xf(new THREE.BoxGeometry(0.7, 0.1, 0.12), { pz: -0.42, py: 0.06 })]),
    };
    case 7: return {
      body: merge([
        [xf(new THREE.CylinderGeometry(0.42, 0.5, 1.2, 12), { py: -0.25 }), 1],
        [xf(new THREE.SphereGeometry(0.32, 12, 10), { py: 0.6 }), 1.05],
        [xf(new THREE.BoxGeometry(1.5, 0.12, 0.12), { py: 0.15 }), 0.6],
        [xf(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6), { py: -1.0 }), 0.5],
        [xf(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 12), { py: -1.42 }), 0.5],
      ]),
      eyes: mergePlain([xf(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 16), { py: -0.1, pz: -0.45, rx: Math.PI / 2 })]),
    };
    default: return { body: merge([[new THREE.IcosahedronGeometry(1, 0), 1]]), eyes: mergePlain([eye(0.1, 0, 0, -1)]) };
  }
}

function mergePlain(geos) {
  let total = 0;
  const parts = geos.map((g) => { const ng = g.index ? g.toNonIndexed() : g; total += ng.attributes.position.count; return ng; });
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeBoundingSphere();
  return out;
}
