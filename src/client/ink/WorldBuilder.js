/**
 * Quantum Pulse — "Ink Comic" arena construction.
 *
 * Turns a shared arena definition (gameplay boxes) into a cel-shaded scene:
 * merged, vertex-coloured box geometry, comic sky, sun with hard shadows,
 * decorative floating-island rock, a distant skyline, painted decals for
 * pads/heal zones/hazards, and comic signage. Decoration never affects
 * gameplay; collision always comes from the shared arena data.
 *
 * Procedural generation: every random choice uses a seeded RNG derived from
 * `arena.decorSeed`, so all players see the same decoration.
 */
import * as THREE from '/vendor/three/three.module.js';
import { ColliderKind } from '/shared/arenas.js';
import { mulberry32 } from '/shared/math.js';
import { inkMaterial, flatMaterial, LIGHT, INK_UNIFORMS } from '/client/ink/InkMaterials.js';

/** Per-arena art direction. Colours are authored in display sRGB. */
export const THEMES = {
  neon_rupture: {
    sky: [0x3f6fc7, 0x8fb6e8, 0xf6d9a8], sun: 0xfff2cf, sunDir: [0.55, 0.75, 0.35], fog: 0xd9cfba, fogNear: 70, fogFar: 230,
    hemiSky: 0xcfe0ff, hemiGround: 0x8c7f6a, base: 0xc9c1b1, top: 0xe6ddcb, rock: 0x7d6a58, skyline: 0x6f7fa8, clouds: 1,
    // a drowned city far below the floating islands
    skylineRadius: [120, 240], skylineTop: [-70, -14],
    paints: [0xc9c1b1, 0x2f6fd0, 0xe0473a, 0x2a9d8f, 0xf2c230],
  },
  folded_archive: {
    sky: [0x231d45, 0x5a3f73, 0xd9876b], sun: 0xffd9a8, sunDir: [-0.45, 0.7, 0.55], fog: 0x6e5568, fogNear: 50, fogFar: 170,
    hemiSky: 0xc9b5e6, hemiGround: 0x6b4f3a, base: 0xc7a77e, top: 0xe2cfa9, rock: 0x6b4f3a, skyline: 0x3b3160, clouds: 0,
    skylineRadius: [150, 300], skylineTop: [24, 70],
    paints: [0xc7a77e, 0x3a6fbf, 0xc8473c, 0x7b4fc9, 0xe8b23a],
  },
  reactor_null: {
    sky: [0x4f8a8b, 0x9cc5bf, 0xf1e6c8], sun: 0xfff4d6, sunDir: [0.4, 0.8, -0.45], fog: 0xcfd8cc, fogNear: 60, fogFar: 200,
    hemiSky: 0xdff1ea, hemiGround: 0x7d7a68, base: 0xb7bcb0, top: 0xd8dccf, rock: 0x6f6c5e, skyline: 0x6f8a88, clouds: 1,
    skylineRadius: [150, 300], skylineTop: [22, 60],
    paints: [0xb7bcb0, 0x2f6fd0, 0xe0473a, 0x2a9d8f, 0xf2c230],
  },
};

/* ------------------------------------------------------------------------ */
/* Canvas textures (procedural decals and signs)                             */
/* ------------------------------------------------------------------------ */

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Comic sign: paper card, ink border, Anton lettering. */
export function signTexture(text, bg = '#efe6d2', fg = '#16130f') {
  const font = '"Anton", Impact, sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `120px ${font}`;
  const w = Math.ceil(probe.measureText(text).width) + 90, h = 190;
  const tex = canvasTexture(w, h, (g) => {
    g.fillStyle = '#16130f';
    g.fillRect(14, 14, w - 14, h - 14); // offset shadow
    g.fillStyle = bg;
    g.fillRect(0, 0, w - 14, h - 14);
    g.lineWidth = 10;
    g.strokeStyle = '#16130f';
    g.strokeRect(5, 5, w - 24, h - 24);
    g.fillStyle = fg;
    g.font = `120px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, (w - 14) / 2, (h - 14) / 2 + 6);
  });
  return { tex, aspect: w / h };
}

function chevronTexture(color) {
  const t = canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#16130f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    for (let y = -64; y < h + 64; y += 64) {
      g.beginPath();
      g.moveTo(14, y + 44); g.lineTo(w / 2, y + 8); g.lineTo(w - 14, y + 44); g.lineTo(w - 14, y + 66); g.lineTo(w / 2, y + 30); g.lineTo(14, y + 66);
      g.closePath();
      g.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function hazardTexture() {
  const t = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#f2c230';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#16130f';
    for (let i = -2; i < 4; i++) {
      g.beginPath();
      g.moveTo(i * 64, 0); g.lineTo(i * 64 + 32, 0); g.lineTo(i * 64 + 32 + h, h); g.lineTo(i * 64 + h, h);
      g.closePath();
      g.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function healTexture(color) {
  return canvasTexture(256, 256, (g, w) => {
    g.fillStyle = color;
    g.strokeStyle = '#16130f';
    g.lineWidth = 14;
    g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 12, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#efe6d2';
    g.fillRect(w / 2 - 22, 60, 44, w - 120);
    g.fillRect(60, w / 2 - 22, w - 120, 44);
    g.strokeRect(w / 2 - 22, 60, 44, w - 120);
    g.strokeRect(60, w / 2 - 22, w - 120, 44);
    g.fillRect(w / 2 - 18, w / 2 - 18, 36, 36);
  });
}

/* ------------------------------------------------------------------------ */
/* Sky                                                                       */
/* ------------------------------------------------------------------------ */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

/**
 * Comic sky: posterised three-colour gradient, flat inked clouds (thresholded
 * value noise with an ink rim), and a halftone sun.
 */
const SKY_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uInk;
uniform float uTime;
uniform float uClouds;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return noise(p) * 0.55 + noise(p * 2.1) * 0.3 + noise(p * 4.3) * 0.15; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // posterised bands
  vec3 col = h > 0.32 ? uTop : (h > 0.08 ? uMid : uHorizon);
  if (h < -0.02) col = mix(uHorizon, uTop * 0.55, smoothstep(-0.02, -0.4, h));
  // sun disc + ink ring + halftone halo
  float s = dot(d, normalize(uSunDir));
  col = mix(col, uSun, smoothstep(0.9975, 0.998, s));
  col = mix(col, uInk, smoothstep(0.9968, 0.9972, s) * (1.0 - smoothstep(0.9975, 0.9979, s)));
  vec2 dp = gl_FragCoord.xy / 6.0;
  dp = vec2(dp.x + dp.y, dp.y - dp.x) * 0.7071;
  float halo = smoothstep(0.96, 0.995, s) * 0.42;
  col = mix(col, uSun, (1.0 - step(halo, length(fract(dp) - 0.5))) * step(0.01, halo));
  // flat comic clouds drifting along a band above the horizon
  if (uClouds > 0.5 && h > 0.03 && h < 0.42) {
    // a band of flat cumulus just above the horizon
    vec2 cp = vec2(atan(d.z, d.x) * 2.2 + uTime * 0.004, h * 7.0);
    float n = fbm(cp * vec2(1.0, 1.6)) * smoothstep(0.03, 0.12, h) * (1.0 - smoothstep(0.2, 0.42, h));
    float cloud = step(0.43, n);
    float rim = step(0.4, n) - cloud;
    float shade = step(0.43, n) * (1.0 - step(0.47, n));
    col = mix(col, vec3(0.98, 0.96, 0.92), cloud);
    col = mix(col, mix(uHorizon, vec3(0.98, 0.96, 0.92), 0.4), shade * 0.8);
    col = mix(col, uInk, rim * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------------ */
/* Geometry                                                                  */
/* ------------------------------------------------------------------------ */

const FACES = [
  [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
  [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
  [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
];

/** Merge boxes into one indexed geometry with per-face vertex colours. */
function boxesGeometry(cols, colorOf) {
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color();
  for (const b of cols) {
    const sx = b.maxX - b.minX, sy = b.maxY - b.minY, sz = b.maxZ - b.minZ;
    for (const [n, verts] of FACES) {
      colorOf(b, n, c);
      const base = pos.length / 3;
      for (const [vx, vy, vz] of verts) {
        pos.push(b.minX + vx * sx, b.minY + vy * sy, b.minZ + vz * sz);
        nor.push(n[0], n[1], n[2]);
        col.push(c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Build the visual world for an arena.
 * @param {object} arena shared arena definition
 * @param {{quality:string, shadows:boolean}} opts
 * @returns {{group:THREE.Group, sun:THREE.DirectionalLight, noEdge:THREE.Object3D[], propMeshes:Map, update:Function, fog:THREE.Fog, theme:object}}
 */
export function buildWorld(arena, opts) {
  const theme = THEMES[arena.id] || THEMES.neon_rupture;
  const rng = mulberry32(arena.decorSeed);
  const group = new THREE.Group();
  const noEdge = [];
  const animated = [];
  const paint = new THREE.Color(), top = new THREE.Color(theme.top), base = new THREE.Color(theme.base);

  /** Colour per box face: concrete base, zone paint on walls, lighter tops, solid landmarks. */
  const colorOf = (b, n, out) => {
    paint.setHex(theme.paints[b.zone || 0] ?? theme.base);
    if (b.landmark) { out.copy(paint); if (n[1] > 0) out.lerp(top, 0.25); return out; }
    if (n[1] > 0) { out.copy(top); if (b.zone) out.lerp(paint, 0.18); return out; }
    out.copy(base);
    if (b.zone) out.lerp(paint, 0.5);
    if (n[1] < 0) out.multiplyScalar(0.8);
    return out;
  };

  // ---- solid geometry ----
  const solid = arena.colliders.filter((c) => !c.invisible && c.kind === ColliderKind.SOLID);
  const worldMat = inkMaterial({ vertexColors: true, panels: true, panelSize: 4 });
  const solidMesh = new THREE.Mesh(boxesGeometry(solid, colorOf), worldMat);
  solidMesh.castShadow = opts.shadows;
  solidMesh.receiveShadow = opts.shadows;
  group.add(solidMesh);

  // ---- destructible props (crates with hazard paint) ----
  const propMeshes = new Map();
  const propMat = inkMaterial({ vertexColors: true });
  for (const c of arena.colliders) {
    if (c.kind !== ColliderKind.PROP) continue;
    const m = new THREE.Mesh(boxesGeometry([c], (b, n, out) => out.setHex(n[1] > 0 ? 0xf2c230 : 0xd9a520)), propMat);
    m.castShadow = opts.shadows;
    m.receiveShadow = opts.shadows;
    group.add(m);
    propMeshes.set(c.id, m);
  }

  // ---- phase barriers: translucent blue with moving hatch lines ----
  const phaseMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uColor: { value: new THREE.Color(0x2457c5) }, uInk: INK_UNIFORMS.uInk },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uOpen; uniform vec3 uColor; uniform vec3 uInk; varying vec3 vW;
      void main() {
        float hatch = step(0.72, fract((vW.x + vW.y + vW.z) * 1.4 - uTime * 0.8));
        float a = mix(0.5, 0.15, uOpen);
        gl_FragColor = vec4(mix(uColor, uInk, hatch * 0.6), a + hatch * 0.25);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const c of arena.colliders) {
    if (c.kind !== ColliderKind.PHASE) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.maxX - c.minX, c.maxY - c.minY, c.maxZ - c.minZ), phaseMat);
    m.position.set((c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2, (c.minZ + c.maxZ) / 2);
    group.add(m);
    noEdge.push(m);
  }

  // ---- floating-island rock undersides (decorative) ----
  const rockMat = inkMaterial({ color: theme.rock });
  const supported = (c) => solid.some((o) => o !== c && o.maxY <= c.minY + 0.01 && o.maxY > c.minY - 14 &&
    o.minX < (c.minX + c.maxX) / 2 && o.maxX > (c.minX + c.maxX) / 2 && o.minZ < (c.minZ + c.maxZ) / 2 && o.maxZ > (c.minZ + c.maxZ) / 2);
  for (const c of solid) {
    const w = c.maxX - c.minX, d = c.maxZ - c.minZ;
    // only islands floating over the void get a rock underside
    const floating = arena.id === 'neon_rupture' && w * d > 30 && c.minY > arena.killY + 5 && !supported(c);
    if (!floating) continue;
    const r = Math.min(w, d) * 0.55;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, r * (1.4 + rng() * 0.8), 7, 1), rockMat);
    cone.geometry = cone.geometry.toNonIndexed();
    cone.geometry.computeVertexNormals();
    cone.rotation.set(Math.PI, rng() * Math.PI, 0);
    cone.position.set((c.minX + c.maxX) / 2, c.minY - (r * 0.7) + 0.1, (c.minZ + c.maxZ) / 2);
    cone.scale.set(w / (2 * r) * 0.95, 1, d / (2 * r) * 0.95);
    cone.castShadow = opts.shadows;
    group.add(cone);
  }

  // ---- distant skyline + drifting debris (instanced) ----
  const lowQ = opts.quality === 'low';
  const nTowers = lowQ ? 40 : 110;
  const towerMat = inkMaterial({ color: theme.skyline });
  const towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), towerMat, nTowers);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const [r0, r1] = theme.skylineRadius, [t0, t1] = theme.skylineTop;
  for (let i = 0; i < nTowers; i++) {
    const a = rng() * Math.PI * 2, rad = r0 + rng() * (r1 - r0);
    const topY = t0 + rng() * (t1 - t0), hgt = 40 + rng() * 60, wd = 10 + rng() * 18;
    m4.compose(v.set(Math.cos(a) * rad, topY - hgt / 2, Math.sin(a) * rad), q.identity(), s.set(wd, hgt, wd * (0.6 + rng() * 0.8)));
    towers.setMatrixAt(i, m4);
  }
  group.add(towers);
  const nDebris = lowQ ? 20 : 60;
  const debris = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, nDebris);
  const debrisData = [];
  for (let i = 0; i < nDebris; i++) {
    const a = rng() * Math.PI * 2, rad = arena.half + 10 + rng() * 50;
    debrisData.push({ x: Math.cos(a) * rad, y: -6 + rng() * 40, z: Math.sin(a) * rad, s: 0.6 + rng() * 2.6, p: rng() * 6.28, sp: 0.1 + rng() * 0.3 });
  }
  group.add(debris);
  animated.push((t) => {
    for (let i = 0; i < nDebris; i++) {
      const d = debrisData[i];
      q.setFromAxisAngle(v.set(0.3, 1, 0.2).normalize(), t * d.sp + d.p);
      m4.compose(v.set(d.x, d.y + Math.sin(t * 0.5 + d.p) * 0.8, d.z), q, s.set(d.s, d.s * 0.7, d.s));
      debris.setMatrixAt(i, m4);
    }
    debris.instanceMatrix.needsUpdate = true;
  });

  // ---- quantum rings (grapple anchors) ----
  const ringMat = inkMaterial({ color: 0xf2c230 });
  const ringGlow = flatMaterial(0xfff1b8, { transparent: true, opacity: 0.85 });
  const rings = [];
  for (const r of arena.rings) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r.r, 0.22, 10, 40), ringMat);
    ring.position.set(r.x, r.y, r.z);
    ring.lookAt(0, r.y, 0);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(r.r * 0.78, 0.06, 6, 32), ringGlow);
    ring.add(inner);
    noEdge.push(inner);
    group.add(ring);
    rings.push(ring);
  }
  animated.push((t) => { for (const r of rings) r.rotation.z = t * 0.7; });

  // ---- decals: launch pads, heal zones, hazards ----
  const decal = (geo, mat, x, y, z, rotZ = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rotZ);
    m.position.set(x, y + 0.03, z);
    m.receiveShadow = false;
    group.add(m);
    noEdge.push(m);
    return m;
  };
  const chevron = chevronTexture('#f2c230');
  const padMat = new THREE.MeshBasicMaterial({ map: chevron, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const p of arena.pads) {
    const ang = Math.atan2(p.tx - p.x, p.tz - p.z);
    decal(new THREE.CircleGeometry(p.r, 28), padMat, p.x, p.y, p.z, ang + Math.PI);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r, 0.12, 6, 28), inkMaterial({ color: 0x16130f }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(p.x, p.y + 0.06, p.z);
    group.add(rim);
  }
  animated.push((t) => { chevron.offset.y = -t * 1.2; });
  const healMat = new THREE.MeshBasicMaterial({ map: healTexture('#2a9d8f'), transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const z of arena.healZones) decal(new THREE.PlaneGeometry(z.r * 2, z.r * 2), healMat, z.x, z.y, z.z);
  const hz = hazardTexture();
  for (const h of arena.hazards) {
    const w = h.maxX - h.minX, d = h.maxZ - h.minZ;
    const t = hz.clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, w / 2), Math.max(1, d / 2));
    decal(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2 }), (h.minX + h.maxX) / 2, 0, (h.minZ + h.maxZ) / 2);
    animated.push((time) => { t.offset.x = time * 0.4; });
  }

  // ---- reactor ----
  let reactor = null;
  if (arena.reactor) {
    const r = arena.reactor;
    reactor = new THREE.Group();
    reactor.position.set(r.x, 0, r.z);
    const coreMat = flatMaterial(0xf2c230);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, r.height + 4, 16, 1, true), coreMat);
    core.position.y = r.height / 2 + 2;
    reactor.add(core);
    const bands = [];
    for (let i = 0; i < 3; i++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(4.8 + i * 0.5, 0.28, 8, 40), inkMaterial({ color: [0xe0473a, 0x2f6fd0, 0x16130f][i] }));
      band.position.y = 2.2 + i * 3;
      band.castShadow = opts.shadows;
      reactor.add(band);
      bands.push(band);
    }
    group.add(reactor);
    reactor.userData = { core, coreMat, bands };
    animated.push((t) => bands.forEach((b, i) => { b.rotation.x = Math.PI / 2 + Math.sin(t * 0.7 + i) * 0.2; b.rotation.z = t * (0.5 + i * 0.2); }));
  }

  // ---- signage ----
  for (const l of arena.landmarks) {
    const paintHex = `#${(theme.paints[l.zone] ?? 0xefe6d2).toString(16).padStart(6, '0')}`;
    const dark = l.zone === 4 || l.zone === 0;
    const { tex, aspect } = signTexture(l.label, paintHex, dark ? '#16130f' : '#efe6d2');
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    const h = l.label.length > 4 ? 2.2 : 2.8;
    sp.scale.set(h * aspect, h, 1);
    sp.position.set(l.x, l.y + 2.4, l.z);
    group.add(sp);
    noEdge.push(sp);
  }

  // ---- sky ----
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    uniforms: {
      uTop: { value: new THREE.Color(theme.sky[0]) }, uMid: { value: new THREE.Color(theme.sky[1]) }, uHorizon: { value: new THREE.Color(theme.sky[2]) },
      uSun: { value: new THREE.Color(theme.sun) }, uSunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() }, uInk: INK_UNIFORMS.uInk,
      uTime: { value: 0 }, uClouds: { value: theme.clouds },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  group.add(sky);
  noEdge.push(sky);

  // ---- lights ----
  const sunDir = new THREE.Vector3(...theme.sunDir).normalize();
  const sun = new THREE.DirectionalLight(theme.sun, LIGHT.SUN);
  sun.position.copy(sunDir).multiplyScalar(arena.half * 1.6);
  sun.target.position.set(0, 0, 0);
  if (opts.shadows) {
    sun.castShadow = true;
    const ext = arena.half + 8;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: arena.half * 4 });
    sun.shadow.mapSize.set(opts.quality === 'high' ? 2048 : 1024, opts.quality === 'high' ? 2048 : 1024);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.updateProjectionMatrix();
  }
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, LIGHT.AMBIENT);
  group.add(sun, sun.target, hemi);

  const fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);

  return {
    group, sun, noEdge, propMeshes, fog, theme, reactor, phaseMat,
    update(t, phaseOpen) {
      skyMat.uniforms.uTime.value = t;
      phaseMat.uniforms.uTime.value = t;
      phaseMat.uniforms.uOpen.value = phaseOpen;
      for (const f of animated) f(t);
    },
  };
}
