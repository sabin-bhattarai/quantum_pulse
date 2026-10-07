/**
 * Quantum Pulse — pooled GPU particle system.
 *
 * One THREE.Points draw call renders every particle. Particles live in
 * preallocated typed arrays; dead particles are removed by swap-with-last so
 * the live set stays packed in [0, count) and the draw range shrinks with it.
 * No objects are allocated while playing. Capacity depends on the particle
 * quality setting and spawns beyond capacity are silently dropped.
 */
import * as THREE from '/vendor/three/three.module.js';

export const PARTICLE_CAPS = Object.freeze({ high: 3200, medium: 1600, low: 500, off: 0 });

const VERT = /* glsl */`
attribute vec4 aColor;
attribute float aSize;
varying vec4 vColor;
varying float vSpin;
uniform float uScale;
void main() {
  vColor = aColor;
  vSpin = position.x * 3.7 + position.z * 1.3;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 64.0);
  gl_Position = projectionMatrix * mv;
}`;

// Fractured geometric shards: a rotated diamond with a bright core.
const FRAG = /* glsl */`
varying vec4 vColor;
varying float vSpin;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float c = cos(vSpin), s = sin(vSpin);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  float d = abs(p.x) * 1.3 + abs(p.y);
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.6, d);
  gl_FragColor = vec4(vColor.rgb * (0.6 + core), vColor.a * (1.0 - d * 0.6));
}`;

export class ParticleSystem {
  constructor(scene, quality = 'high') {
    this.scene = scene;
    this.points = null;
    this.setQuality(quality);
  }

  setQuality(quality) {
    const cap = PARTICLE_CAPS[quality] ?? PARTICLE_CAPS.medium;
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }
    this.capacity = cap;
    this.count = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.baseAlpha = new Float32Array(cap);
    if (cap === 0) return;
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aColor', this.colAttr);
    g.setAttribute('aSize', this.sizeAttr);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); // particles span the arena; skip per-frame bounds
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 300 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
  }

  setViewportHeight(h) {
    if (this.points) this.points.material.uniforms.uScale.value = h * 0.5;
  }

  /** Spawn one particle. Returns false when the pool is full. */
  spawn(x, y, z, vx, vy, vz, color, size, life, gravity = 0, drag = 0, alpha = 1) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = color.r; this.col[i * 4 + 1] = color.g; this.col[i * 4 + 2] = color.b; this.col[i * 4 + 3] = alpha;
    this.baseAlpha[i] = alpha;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    return true;
  }

  /** Radial burst helper. `rng` defaults to Math.random (cosmetic only). */
  burst(x, y, z, count, speed, color, size, life, opts = {}) {
    const n = Math.min(count, this.capacity - this.count);
    const up = opts.up ?? 0;
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.35 + Math.random() * 0.65);
      this.spawn(x, y, z, Math.cos(a) * r * s, u * s + up, Math.sin(a) * r * s, color, size * (0.6 + Math.random() * 0.8),
        life * (0.6 + Math.random() * 0.6), opts.gravity ?? 6, opts.drag ?? 1.5, opts.alpha ?? 1);
    }
  }

  update(dt) {
    if (!this.points) return;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove with the last live particle
        const last = --this.count;
        if (i !== last) this.copy(last, i);
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      const i3 = i * 3;
      this.vel[i3] *= d; this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt; this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.col[i * 4 + 3] = this.baseAlpha[i] * f;
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    if (this.count > 0) {
      this.posAttr.clearUpdateRanges(); this.posAttr.addUpdateRange(0, this.count * 3); this.posAttr.needsUpdate = true;
      this.colAttr.clearUpdateRanges(); this.colAttr.addUpdateRange(0, this.count * 4); this.colAttr.needsUpdate = true;
      this.sizeAttr.clearUpdateRanges(); this.sizeAttr.addUpdateRange(0, this.count); this.sizeAttr.needsUpdate = true;
    }
  }

  copy(from, to) {
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.size[to] = this.size[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.baseAlpha[to] = this.baseAlpha[from];
  }

  clear() {
    this.count = 0;
    if (this.points) this.points.geometry.setDrawRange(0, 0);
  }
}
