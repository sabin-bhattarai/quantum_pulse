/**
 * Quantum Pulse — pooled visual effects.
 *
 *  - RibbonPool: camera-facing energy ribbons (tracers, beams, grapple ropes,
 *    tethers, telegraph lines, motion streaks). One draw call.
 *  - RingPool: flat or billboarded rings (shockwaves, portals, telegraphs,
 *    fracture boundaries, pad/landing pulses). One instanced draw call.
 *  - FractureFx: distortion spheres for Gravity Fractures. One draw call.
 *  - Screen shake using a trauma model.
 *
 * Every pool has a fixed capacity; requests beyond it are dropped. Quality
 * settings scale the number of cosmetic segments, never gameplay.
 */
import * as THREE from '/vendor/three/three.module.js';

/* ======================================================================== */
/* Ribbons                                                                   */
/* ======================================================================== */

const RIBBON_VERT = /* glsl */`
attribute vec3 aB;
attribute vec2 aCorner;
attribute vec4 aColor;
attribute float aWidth;
varying vec4 vColor;
varying vec2 vCorner;
void main() {
  vec3 a = position;
  vec3 p = mix(a, aB, aCorner.x);
  vec3 dir = aB - a;
  float len = length(dir);
  dir = len > 1e-5 ? dir / len : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(dir, toCam);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
  p += side * aCorner.y * aWidth;
  vColor = aColor;
  vCorner = aCorner;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const RIBBON_FRAG = /* glsl */`
varying vec4 vColor;
varying vec2 vCorner;
void main() {
  float edge = 1.0 - abs(vCorner.y);
  float a = vColor.a * pow(edge, 1.3);
  gl_FragColor = vec4(vColor.rgb * (0.65 + edge * 0.9), a);
}`;

export class RibbonPool {
  constructor(scene, capacity = 1024) {
    this.capacity = capacity;
    const n = capacity * 4;
    this.aA = new Float32Array(n * 3);
    this.aB = new Float32Array(n * 3);
    this.aColor = new Float32Array(n * 4);
    this.aWidth = new Float32Array(n);
    const corner = new Float32Array(n * 2);
    const index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
      index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    this.attrA = new THREE.BufferAttribute(this.aA, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrB = new THREE.BufferAttribute(this.aB, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrC = new THREE.BufferAttribute(this.aColor, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrW = new THREE.BufferAttribute(this.aWidth, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attrA);
    g.setAttribute('aB', this.attrB);
    g.setAttribute('aColor', this.attrC);
    g.setAttribute('aWidth', this.attrW);
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    // persistent segments (with lifetime)
    this.persist = [];
    for (let i = 0; i < capacity; i++) this.persist.push({ active: false });
    this.persistCount = 0;
    this.count = 0; // segments written this frame
  }

  /** Add a fading segment. */
  add(ax, ay, az, bx, by, bz, color, width, life, alpha = 1, shrink = true) {
    const s = this.persist.find((p) => !p.active);
    if (!s) return;
    s.active = true;
    s.ax = ax; s.ay = ay; s.az = az; s.bx = bx; s.by = by; s.bz = bz;
    s.r = color.r; s.g = color.g; s.b = color.b; s.alpha = alpha;
    s.width = width; s.life = life; s.maxLife = life; s.shrink = shrink;
    this.persistCount++;
  }

  /** Add a segment that is drawn for the current frame only. */
  transient(ax, ay, az, bx, by, bz, r, g, b, alpha, width) {
    if (this.count >= this.capacity) return;
    this.write(this.count++, ax, ay, az, bx, by, bz, r, g, b, alpha, width);
  }

  write(i, ax, ay, az, bx, by, bz, r, g, b, alpha, width) {
    for (let v = 0; v < 4; v++) {
      const k = i * 4 + v;
      this.aA[k * 3] = ax; this.aA[k * 3 + 1] = ay; this.aA[k * 3 + 2] = az;
      this.aB[k * 3] = bx; this.aB[k * 3 + 1] = by; this.aB[k * 3 + 2] = bz;
      this.aColor[k * 4] = r; this.aColor[k * 4 + 1] = g; this.aColor[k * 4 + 2] = b; this.aColor[k * 4 + 3] = alpha;
      this.aWidth[k] = width;
    }
  }

  /** Start a frame: age persistent segments and write them first. */
  begin(dt) {
    this.count = 0;
    if (this.persistCount === 0) return;
    for (const s of this.persist) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { s.active = false; this.persistCount--; continue; }
      const f = s.life / s.maxLife;
      if (this.count >= this.capacity) continue;
      this.write(this.count++, s.ax, s.ay, s.az, s.bx, s.by, s.bz, s.r, s.g, s.b, s.alpha * f, s.shrink ? s.width * (0.4 + 0.6 * f) : s.width);
    }
  }

  /** Upload this frame's segments. */
  end() {
    const n = this.count * 4;
    this.mesh.geometry.setDrawRange(0, this.count * 6);
    if (n === 0) return;
    for (const [attr, size] of [[this.attrA, 3], [this.attrB, 3], [this.attrC, 4], [this.attrW, 1]]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }

  clear() {
    for (const s of this.persist) s.active = false;
    this.persistCount = 0;
    this.count = 0;
  }
}

/* ======================================================================== */
/* Rings                                                                     */
/* ======================================================================== */

const RING_VERT = /* glsl */`
attribute vec4 aColor;
attribute vec4 aParams;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vParams;
void main() {
  vUv = uv;
  vColor = aColor;
  vParams = aParams;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vParams; // thickness, fill, style, seed
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float th = vParams.x;
  float ring = smoothstep(1.0 - th - 0.04, 1.0 - th, d) * (1.0 - smoothstep(0.96, 1.0, d));
  float style = vParams.z;
  float ang = atan(p.y, p.x);
  float a = ring;
  if (style > 0.5 && style < 1.5) {
    // telegraph: outer ring + filling disc, readable progress
    float fill = vParams.y;
    a = max(ring, step(d, fill) * 0.18 + (1.0 - smoothstep(0.0, 0.025, abs(d - fill))) * 0.9);
    a *= 0.8 + 0.2 * sin(ang * 14.0 + uTime * 6.0);
  } else if (style > 1.5 && style < 2.5) {
    // portal ripple
    a = ring + 0.45 * (1.0 - smoothstep(0.0, 0.08, abs(fract(d * 3.0 - uTime * 1.6) - 0.5))) * (1.0 - d);
  } else if (style > 2.5) {
    // dashed, rotating (gravity / warning)
    a = ring * step(0.0, sin(ang * 10.0 + uTime * 3.0 + vParams.w));
  }
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

export const RingStyle = Object.freeze({ PLAIN: 0, TELEGRAPH: 1, PORTAL: 2, DASHED: 3 });

const _dummy = new THREE.Object3D();

export class RingPool {
  constructor(scene, capacity = 96) {
    this.capacity = capacity;
    const geo = new THREE.PlaneGeometry(2, 2);
    this.colors = new Float32Array(capacity * 4);
    this.params = new Float32Array(capacity * 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aParams', this.paramAttr);
    this.material = new THREE.ShaderMaterial({
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: { uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.rings = [];
    for (let i = 0; i < capacity; i++) this.rings.push({ active: false });
    this.transientList = [];
  }

  /**
   * @param {object} o {x,y,z,r0,r1,life,color,alpha,thickness,style,face:'up'|'camera'|'normal',nx,ny,nz,fill}
   */
  add(o) {
    const r = this.rings.find((x) => !x.active);
    if (!r) return null;
    r.active = true;
    r.x = o.x; r.y = o.y; r.z = o.z;
    r.r0 = o.r0 ?? 0.2; r.r1 = o.r1 ?? o.r0 ?? 1;
    r.life = o.life ?? 0.5; r.maxLife = r.life;
    r.color = o.color; r.alpha = o.alpha ?? 1;
    r.thickness = o.thickness ?? 0.12;
    r.style = o.style ?? RingStyle.PLAIN;
    r.face = o.face || 'up';
    r.nx = o.nx || 0; r.ny = o.ny ?? 1; r.nz = o.nz || 0;
    r.fillMode = !!o.fill;
    r.fade = o.fade ?? true;
    r.seed = Math.random() * 6.28;
    return r;
  }

  /** Ring drawn for this frame only (e.g. fracture boundaries). */
  transient(o) {
    this.transientList.push(o);
  }

  update(dt, time, camera) {
    this.material.uniforms.uTime.value = time;
    let n = 0;
    const draw = (x, y, z, radius, color, alpha, thickness, style, fill, face, nx, ny, nz, seed) => {
      if (n >= this.capacity) return;
      _dummy.position.set(x, y, z);
      if (face === 'camera') _dummy.quaternion.copy(camera.quaternion);
      else if (face === 'normal') _dummy.quaternion.setFromUnitVectors(_zAxis, _tmpN.set(nx, ny, nz).normalize());
      else _dummy.quaternion.setFromAxisAngle(_xAxis, -Math.PI / 2);
      _dummy.scale.setScalar(Math.max(0.01, radius));
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(n, _dummy.matrix);
      this.colors[n * 4] = color.r; this.colors[n * 4 + 1] = color.g; this.colors[n * 4 + 2] = color.b; this.colors[n * 4 + 3] = alpha;
      this.params[n * 4] = thickness; this.params[n * 4 + 1] = fill; this.params[n * 4 + 2] = style; this.params[n * 4 + 3] = seed;
      n++;
    };
    for (const r of this.rings) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) { r.active = false; continue; }
      const t = 1 - r.life / r.maxLife;
      const radius = r.fillMode ? r.r1 : r.r0 + (r.r1 - r.r0) * (1 - (1 - t) * (1 - t));
      const alpha = r.fade && !r.fillMode ? r.alpha * (1 - t) : r.alpha;
      draw(r.x, r.y, r.z, radius, r.color, alpha, r.thickness, r.style, r.fillMode ? t : 0, r.face, r.nx, r.ny, r.nz, r.seed);
    }
    for (const o of this.transientList) {
      draw(o.x, o.y, o.z, o.r, o.color, o.alpha ?? 1, o.thickness ?? 0.05, o.style ?? RingStyle.DASHED, o.fill ?? 0, o.face || 'camera', 0, 1, 0, o.seed ?? 0);
    }
    this.transientList.length = 0;
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
    }
  }

  clear() {
    for (const r of this.rings) r.active = false;
    this.transientList.length = 0;
    this.mesh.count = 0;
  }
}
const _tmpN = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

/* ======================================================================== */
/* Gravity fracture visuals                                                   */
/* ======================================================================== */

const FRACTURE_VERT = /* glsl */`
attribute vec4 aColor;
attribute float aSeed;
varying vec3 vN;
varying vec3 vView;
varying vec4 vColor;
varying float vSeed;
varying vec3 vLocal;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  vColor = aColor;
  vSeed = aSeed;
  vLocal = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRACTURE_FRAG = /* glsl */`
uniform float uTime;
varying vec3 vN;
varying vec3 vView;
varying vec4 vColor;
varying float vSeed;
varying vec3 vLocal;
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), vView)), 2.2);
  float ang = atan(vLocal.z, vLocal.x);
  float swirl = 0.5 + 0.5 * sin(ang * 6.0 + vLocal.y * 8.0 - uTime * 5.0 * (vColor.a > 0.0 ? 1.0 : -1.0) + vSeed);
  float a = abs(vColor.a) * (fres * 0.9 + swirl * 0.25 * fres + 0.05);
  gl_FragColor = vec4(vColor.rgb * (0.8 + swirl * 0.6), a);
}`;

export class FractureFx {
  constructor(scene, capacity = 24) {
    const geo = new THREE.IcosahedronGeometry(1, 3);
    this.colors = new Float32Array(capacity * 4);
    this.seeds = new Float32Array(capacity);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.seedAttr = new THREE.InstancedBufferAttribute(this.seeds, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aSeed', this.seedAttr);
    this.material = new THREE.ShaderMaterial({
      vertexShader: FRACTURE_VERT, fragmentShader: FRACTURE_FRAG, uniforms: { uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 3;
    this.capacity = capacity;
    scene.add(this.mesh);
  }

  /** @param {Array} fractures snapshot rows [id,x,y,z,r,strength,mode,age,dur] */
  update(fractures, time, palette, rings) {
    this.material.uniforms.uTime.value = time;
    let n = 0;
    for (const f of fractures) {
      if (n >= this.capacity) break;
      const [id, x, y, z, r, , mode, age, dur] = f;
      const env = Math.min(1, age / 0.2) * Math.min(1, (dur - age) / 0.4);
      const c = mode === 0 ? palette.violet : mode === 1 ? palette.amber : palette.cyan;
      const pulse = 1 + Math.sin(time * 8 + id) * 0.05;
      _dummy.position.set(x, y, z);
      _dummy.quaternion.identity();
      _dummy.scale.setScalar(r * 0.32 * pulse * (0.4 + 0.6 * env));
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(n, _dummy.matrix);
      this.colors[n * 4] = c.r; this.colors[n * 4 + 1] = c.g; this.colors[n * 4 + 2] = c.b;
      this.colors[n * 4 + 3] = (mode === 1 ? -1 : 1) * 0.9 * env;
      this.seeds[n] = id % 17;
      n++;
      // readable boundary: the radius where the force fades to zero
      rings.transient({ x, y, z, r: r * (0.98 + 0.02 * Math.sin(time * 3 + id)), color: c, alpha: 0.55 * env, thickness: 0.025, style: RingStyle.DASHED, face: 'camera', seed: id });
      rings.transient({ x, y: y - 0.02, z, r: r * 0.6 * (1 - ((time * (mode === 1 ? -0.8 : 0.8)) % 1 + 1) % 1), color: c, alpha: 0.35 * env, thickness: 0.06, style: RingStyle.PLAIN, face: 'up' });
    }
    this.mesh.count = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.seedAttr.needsUpdate = true;
    }
  }
}

/* ======================================================================== */
/* Screen shake (trauma model)                                               */
/* ======================================================================== */

/**
 * Shake offset = trauma² · maxOffset · smooth noise. Squaring trauma keeps
 * small hits subtle while big impacts feel strong; trauma decays linearly.
 */
export class ScreenShake {
  constructor() {
    this.trauma = 0;
    this.t = 0;
    this.enabled = true;
    this.out = { x: 0, y: 0, roll: 0 };
  }

  add(amount) {
    if (!this.enabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const k = this.trauma * this.trauma;
    const t = this.t * 28;
    this.out.x = k * 0.06 * (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.7) * 0.5);
    this.out.y = k * 0.05 * (Math.sin(t * 1.3 + 0.5) + Math.sin(t * 2.9 + 2.1) * 0.5);
    this.out.roll = k * 0.04 * Math.sin(t * 0.9 + 3.1);
    return this.out;
  }
}
