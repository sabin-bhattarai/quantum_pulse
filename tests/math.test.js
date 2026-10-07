import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, lerp, wrapAngle, lerpAngle, quantize, rayAABB, raySphere, pointSegmentDistSq,
  dirFromYawPitch, mulberry32, clampLength3, hashString,
} from '../src/shared/math.js';
import { makeFracture, accumulateFractureDeltaV, FractureMode, fractureEnvelope } from '../src/shared/gravity.js';
import { FRACTURE } from '../src/shared/constants.js';
import { SpatialHash } from '../src/server/SpatialHash.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('clamp / lerp / quantize', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.equal(quantize(1.23456, 2), 1.23);
  assert.equal(quantize(-1.235, 1), -1.2);
});

test('wrapAngle keeps angles in (-PI, PI]', () => {
  for (const a of [0, 1, -1, 4, -4, 10, -10, Math.PI * 7]) {
    const w = wrapAngle(a);
    assert.ok(w > -Math.PI - 1e-9 && w <= Math.PI + 1e-9, `wrap(${a}) = ${w}`);
    assert.ok(near(Math.sin(w), Math.sin(a), 1e-9) && near(Math.cos(w), Math.cos(a), 1e-9));
  }
});

test('lerpAngle takes the shortest arc', () => {
  const r = lerpAngle(3.0, -3.0, 0.5); // crossing PI
  assert.ok(Math.abs(Math.abs(wrapAngle(r)) - Math.PI) < 0.2);
});

test('dirFromYawPitch matches the camera convention', () => {
  const out = { x: 0, y: 0, z: 0 };
  dirFromYawPitch(0, 0, out);
  assert.ok(near(out.x, 0) && near(out.y, 0) && near(out.z, -1));
  dirFromYawPitch(Math.PI / 2, 0, out);
  assert.ok(near(out.x, -1) && near(out.z, 0, 1e-9));
  dirFromYawPitch(0, Math.PI / 2 - 1e-9, out);
  assert.ok(near(out.y, 1, 1e-6));
});

test('rayAABB: hits, misses, inside, behind', () => {
  const box = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
  assert.ok(near(rayAABB(-5, 0, 0, 1, 0, 0, box, 100), 4));
  assert.equal(rayAABB(-5, 3, 0, 1, 0, 0, box, 100), -1);
  assert.equal(rayAABB(-5, 0, 0, -1, 0, 0, box, 100), -1); // pointing away
  assert.equal(rayAABB(-5, 0, 0, 1, 0, 0, box, 2), -1); // beyond max distance
  assert.equal(rayAABB(0, 0, 0, 1, 0, 0, box, 100), 0); // origin inside
  // axis-parallel ray with zero components must not produce NaN
  assert.ok(near(rayAABB(0, 5, 0, 0, -1, 0, box, 100), 4));
});

test('raySphere and pointSegmentDistSq', () => {
  assert.ok(near(raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 1, 100), 9));
  assert.equal(raySphere(0, 0, 0, 0, 0, -1, 5, 0, -10, 1, 100), -1);
  assert.ok(near(pointSegmentDistSq(0, 1, 0, -1, 0, 0, 1, 0, 0), 1));
  assert.ok(near(pointSegmentDistSq(3, 0, 0, -1, 0, 0, 1, 0, 0), 4)); // clamps to endpoint
});

test('clampLength3 bounds vectors', () => {
  const v = clampLength3({ x: 0, y: 0, z: 0 }, { x: 30, y: 40, z: 0 }, 5);
  assert.ok(near(Math.hypot(v.x, v.y, v.z), 5));
});

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(hashString('a'), hashString('b'));
});

test('gravity fracture: falloff reaches zero at the radius and points the right way', () => {
  const f = makeFracture(1, 0, 0, 0, 10, 30, 5, FractureMode.ATTRACT);
  f.age = 1;
  const out = { x: 0, y: 0, z: 0 };
  accumulateFractureDeltaV([f], 1, 10.01, 0, 0, 1, 1 / 60, out);
  assert.equal(out.x, 0);
  accumulateFractureDeltaV([f], 1, 5, 0, 0, 1, 1 / 60, out);
  assert.ok(out.x < 0, 'attract pulls toward the core');
  f.mode = FractureMode.REPEL;
  accumulateFractureDeltaV([f], 1, 5, 0, 0, 1, 1 / 60, out);
  assert.ok(out.x > 0, 'repel pushes away');
  f.mode = FractureMode.ORBIT;
  accumulateFractureDeltaV([f], 1, 5, 0, 0, 1, 1 / 60, out);
  assert.ok(Math.abs(out.z) > 0, 'orbit is tangential');
});

test('gravity fracture: parameters are clamped and stacked forces are capped per tick', () => {
  const f = makeFracture(1, 0, 0, 0, 999, 999, 999, FractureMode.ATTRACT);
  assert.equal(f.radius, FRACTURE.MAX_RADIUS);
  assert.equal(f.strength, FRACTURE.MAX_STRENGTH);
  assert.equal(f.duration, FRACTURE.MAX_DURATION);
  f.age = 1;
  const many = Array.from({ length: 24 }, () => f);
  const out = { x: 0, y: 0, z: 0 };
  accumulateFractureDeltaV(many, many.length, 3, 0, 0, 1, 1 / 60, out);
  assert.ok(Math.hypot(out.x, out.y, out.z) <= FRACTURE.MAX_DELTA_V_PER_TICK + 1e-9);
  // envelope fades in and out
  f.age = 0;
  assert.equal(fractureEnvelope(f), 0);
  f.age = f.duration;
  assert.equal(fractureEnvelope(f), 0);
});

test('SpatialHash returns exactly the brute-force neighbour set', () => {
  const rng = mulberry32(7);
  const hash = new SpatialHash(6);
  const pts = Array.from({ length: 300 }, () => ({ x: rng() * 80 - 40, y: rng() * 20, z: rng() * 80 - 40 }));
  for (const p of pts) hash.insert(p);
  const out = [];
  for (let k = 0; k < 40; k++) {
    const q = pts[k];
    hash.query(q.x, q.y, q.z, 7, out, q);
    const brute = pts.filter((p) => p !== q && Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) <= 7);
    assert.equal(out.length, brute.length);
    for (const b of brute) assert.ok(out.includes(b));
  }
  hash.clear();
  hash.query(0, 0, 0, 100, out);
  assert.equal(out.length, 0);
});
