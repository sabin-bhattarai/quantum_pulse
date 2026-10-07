/**
 * Quantum Pulse — renderer ("Quantum Ink / Neon Paper" art direction).
 *
 * Everything is procedural: arenas are merged box geometry shaded with a
 * hatched "paper" shader and outlined with wobbling ink lines; enemies are
 * instanced primitive silhouettes with glowing rims; post-processing adds
 * chromatic separation, vignette, paper grain, damage flashes and the Phase
 * Break overlay. No image assets are required.
 *
 * Performance rules followed here:
 *  - one merged mesh + two line meshes for static arena geometry,
 *  - instanced meshes per enemy archetype, projectiles, pickups, decorations,
 *  - pooled effects (see client/Effects.js, client/Particles.js),
 *  - no per-frame allocations in the draw path,
 *  - configurable render scale, post-processing and particle budget.
 */
import * as THREE from '/vendor/three/three.module.js';
import { ParticleSystem } from '/client/Particles.js';
import { RibbonPool, RingPool, FractureFx, ScreenShake, RingStyle } from '/client/Effects.js';
import { ColliderKind } from '/shared/arenas.js';
import { mulberry32 } from '/shared/math.js';
import { WEAPONS } from '/shared/weapons.js';
import { PF, EF, PK, PICKUP } from '/shared/protocol.js';

// Our shaders output display-ready colours, so colour management is disabled
// and hex colours are used exactly as authored.
THREE.ColorManagement.enabled = false;

export const PALETTES = Object.freeze({
  normal: { neutral: 0xb9f6ff, cyan: 0x5ff6ff, magenta: 0xff4fd8, violet: 0x9b6bff, amber: 0xffb347, mint: 0x7dffb0, danger: 0xff3b6b, enemy: 0xff4f8b, white: 0xffffff },
  colorblind: { neutral: 0xe0e8ff, cyan: 0x4da3ff, magenta: 0xff8c1a, violet: 0xffe14d, amber: 0xf2f2f2, mint: 0x4da3ff, danger: 0xff8c1a, enemy: 0xff8c1a, white: 0xffffff },
});

/** Distinct runner colours (by player slot). */
const SLOT_COLORS = [0x5ff6ff, 0xff4fd8, 0xffb347, 0x9b6bff, 0x7dffb0, 0xff6b6b, 0x6bb5ff, 0xfff36b, 0xff9be0, 0x9bffea, 0xc29bff, 0xffc29b];

const QUALITY = {
  high: { pixelRatio: 2, decor: 220, sketchPass: true, glyphs: 26 },
  medium: { pixelRatio: 1.25, decor: 120, sketchPass: true, glyphs: 14 },
  low: { pixelRatio: 1, decor: 40, sketchPass: false, glyphs: 6 },
};

/* ------------------------------------------------------------------------ */
/* Shaders                                                                   */
/* ------------------------------------------------------------------------ */

const ARENA_VERT = /* glsl */`
attribute float aZone;
attribute float aGlow;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vZone;
varying float vGlow;
varying float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vZone = aZone;
  vGlow = aGlow;
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const ARENA_FRAG = /* glsl */`
uniform vec3 uZone[5];
uniform vec3 uFill;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vZone;
varying float vGlow;
varying float vDepth;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(vNormal);
  vec3 L = normalize(vec3(0.45, 0.85, 0.3));
  float lit = 0.4 + 0.6 * max(dot(n, L), 0.0);
  int zi = int(vZone + 0.5);
  vec3 zc = uZone[0];
  if (zi == 1) zc = uZone[1]; else if (zi == 2) zc = uZone[2]; else if (zi == 3) zc = uZone[3]; else if (zi == 4) zc = uZone[4];
  vec2 uv = abs(n.y) > 0.5 ? vWorld.xz : (abs(n.x) > 0.5 ? vWorld.zy : vWorld.xy);
  // Procedural sketch hatching: denser in shadow, jittered per 2 m cell.
  float jitter = hash(floor(uv * 0.5));
  float hatch = sin((uv.x + uv.y) * 7.0 + jitter * 6.2831);
  float hatchMask = smoothstep(0.55, 0.9, hatch) * (1.0 - lit) * 1.4;
  // Floor grid for spatial readability.
  vec2 g = abs(fract(uv * 0.5) - 0.5);
  float grid = n.y > 0.5 ? smoothstep(0.47, 0.5, max(g.x, g.y)) : 0.0;
  // Paper grain.
  float grain = (hash(floor(uv * 18.0)) - 0.5) * 0.035;
  vec3 col = uFill * (0.65 + lit * 0.7) + zc * 0.07;
  col = mix(col, col * 0.45, clamp(hatchMask, 0.0, 1.0));
  col += zc * grid * 0.28;
  if (n.y > 0.5) col *= 1.18;
  // Landmarks glow with animated bands so they read from across the map.
  float band = 0.5 + 0.5 * sin(vWorld.y * 1.6 - uTime * 2.0);
  col = mix(col, zc * (0.35 + band * 0.45), vGlow * 0.55);
  col += grain * (1.0 - vGlow * 0.7);
  float f = smoothstep(uFogNear, uFogFar, vDepth);
  gl_FragColor = vec4(mix(col, uFog, f), 1.0);
}`;

const EDGE_VERT = /* glsl */`
attribute vec3 aColor;
attribute float aSeed;
uniform float uTime;
uniform float uWobble;
varying vec3 vColor;
varying float vDepth;
void main() {
  vec3 p = position;
  // Animated ink: each vertex drifts on its own phase, giving hand-drawn wobble.
  p += vec3(sin(uTime * 1.7 + aSeed * 13.0), sin(uTime * 1.3 + aSeed * 7.0), cos(uTime * 1.9 + aSeed * 5.0)) * uWobble;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const EDGE_FRAG = /* glsl */`
uniform float uOpacity;
uniform vec3 uFog;
uniform float uFogFar;
varying vec3 vColor;
varying float vDepth;
void main() {
  float f = smoothstep(uFogFar * 0.35, uFogFar, vDepth);
  gl_FragColor = vec4(mix(vColor, uFog, f), uOpacity * (1.0 - f * 0.7));
}`;

const ENTITY_VERT = /* glsl */`
uniform vec3 uColor;
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = uColor;
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const ENTITY_FRAG = /* glsl */`
uniform float uOpacity;
uniform float uEmissive;
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
void main() {
  vec3 n = normalize(vN);
  float ndl = max(dot(n, normalize(vec3(0.4, 0.85, 0.3))), 0.0);
  float rim = pow(1.0 - max(dot(n, vView), 0.0), 2.0);
  vec3 base = vColor * (0.16 + 0.34 * ndl);
  float hatch = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) * 0.22)) * (1.0 - ndl);
  base *= 1.0 - hatch * 0.4;
  vec3 col = base + vColor * rim * 1.35 + vColor * uEmissive;
  gl_FragColor = vec4(col, uOpacity);
}`;

const OUTLINE_VERT = /* glsl */`
uniform float uWidth;
uniform vec3 uColor;
varying vec3 vColor;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec3 p = position + normal * uWidth;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = uColor;
  #endif
  gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0);
}`;

const OUTLINE_FRAG = /* glsl */`
uniform float uOpacity;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor * 1.25, uOpacity); }`;

const GLOW_FRAG = /* glsl */`
uniform float uOpacity;
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), vView)), 1.5);
  gl_FragColor = vec4(vColor * (0.9 + rim), uOpacity * (0.55 + rim * 0.45));
}`;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uBottom;
uniform vec3 uTop;
uniform vec3 uAccentA;
uniform vec3 uAccentB;
uniform float uTime;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y * 0.5 + 0.5;
  vec3 col = mix(uBottom, uTop, smoothstep(0.2, 0.95, h));
  // Ink stars: sparse quantised points.
  vec3 cell = floor(d * 140.0);
  float s = hash(cell);
  col += step(0.9965, s) * (0.6 + 0.4 * sin(uTime * 2.0 + s * 50.0)) * vec3(0.8, 0.85, 1.0);
  // Aurora ribbons of quantum energy.
  float band = sin(d.x * 6.0 + uTime * 0.15) * 0.08 + 0.32;
  float aur = exp(-pow((d.y - band) * 14.0, 2.0)) * (0.5 + 0.5 * sin(d.z * 9.0 + uTime * 0.3));
  col += uAccentA * aur * 0.22;
  float band2 = cos(d.z * 5.0 - uTime * 0.11) * 0.07 + 0.55;
  col += uAccentB * exp(-pow((d.y - band2) * 18.0, 2.0)) * 0.12;
  // Giant faint glyph circles.
  float ring = abs(length(d.xz / max(0.2, d.y + 1.2)) - 0.62);
  col += uAccentB * (1.0 - smoothstep(0.0, 0.004, ring)) * 0.18 * step(0.0, d.y);
  gl_FragColor = vec4(col, 1.0);
}`;

const DECOR_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
varying float vPhase;
varying vec3 vN;
void main() {
  float a = uTime * (0.2 + fract(aPhase) * 0.5) + aPhase * 6.2831;
  float c = cos(a), s = sin(a);
  vec3 p = vec3(c * position.x + s * position.z, position.y, -s * position.x + c * position.z);
  p.y += sin(uTime * 0.6 + aPhase * 10.0) * 0.4;
  vPhase = aPhase;
  vN = normal;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
}`;

const DECOR_FRAG = /* glsl */`
uniform vec3 uA;
uniform vec3 uB;
varying float vPhase;
varying vec3 vN;
void main() {
  vec3 col = mix(uA, uB, step(0.5, fract(vPhase * 3.7)));
  gl_FragColor = vec4(col * (0.35 + 0.4 * abs(vN.y)), 0.55);
}`;

const PROJ_FRAG = /* glsl */`
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

const FLOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uSpeed;
varying vec2 vUv;
void main() {
  float stripes = step(0.5, fract(vUv.y * 6.0 - uTime * uSpeed));
  float edge = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
  gl_FragColor = vec4(uColor * (0.5 + stripes * 0.8), (0.35 + stripes * 0.35) * edge);
}`;

const UV_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime;
uniform float uCA;
uniform float uVignette;
uniform float uGrain;
uniform float uDamage;
uniform float uPhase;
uniform float uLowHealth;
uniform float uPulse;
uniform float uFlash;
uniform vec3 uPhaseColor;
uniform vec3 uDamageColor;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  // Phase Break: the view ripples as if seen from a parallel layer.
  uv += c * uPhase * 0.018 * sin(uTime * 9.0 + r2 * 40.0);
  uv += c * uPulse * 0.04 * sin(r2 * 30.0 - uTime * 20.0);
  // Chromatic separation grows toward the edges and during impacts.
  float ca = uCA * (0.0015 + r2 * 0.012) + uPhase * 0.004 + uPulse * 0.012;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + c * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - c * ca).b;
  col = mix(col, col * uPhaseColor * 1.3 + uPhaseColor * 0.06, uPhase * 0.4);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l) * vec3(1.0, 0.72, 0.78), uLowHealth * 0.5);
  col += uDamageColor * uDamage * smoothstep(0.08, 0.45, r2);
  col += vec3(0.9, 0.85, 1.0) * uFlash * 0.22;
  col *= 1.0 - uVignette * smoothstep(0.12, 0.62, r2);
  col += (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------------ */
/* Geometry helpers                                                          */
/* ------------------------------------------------------------------------ */

/** Merge simple geometries (converted to non-indexed) into one. */
function mergeSimple(geos) {
  let total = 0;
  const parts = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    total += ng.attributes.position.count;
    return ng;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

function xf(geo, { px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}

/** Enemy silhouettes — each archetype is instantly recognisable by shape. */
function enemyGeometry(type) {
  switch (type) {
    case 0: return xf(new THREE.OctahedronGeometry(0.55, 0), { sz: 1.7 }); // Drift Swarm: dart
    case 1: return mergeSimple([new THREE.IcosahedronGeometry(1.4, 0), xf(new THREE.TorusGeometry(1.9, 0.12, 6, 24), { rx: Math.PI / 2 }), xf(new THREE.ConeGeometry(0.5, 1.4, 5), { py: -1.6, rx: Math.PI })]); // Anchor Warden
    case 2: return mergeSimple([new THREE.ConeGeometry(0.42, 1.9, 4), xf(new THREE.BoxGeometry(1.4, 0.08, 0.2), { py: -0.1 })]); // Phase Stalker: blade
    case 3: return mergeSimple([new THREE.DodecahedronGeometry(0.75, 0), xf(new THREE.TorusGeometry(1.15, 0.06, 4, 24), { rx: 1.1 }), xf(new THREE.TorusGeometry(1.15, 0.06, 4, 24), { rx: -1.1 })]); // Rift Caster
    case 4: return xf(new THREE.ConeGeometry(0.62, 1.9, 3), { rx: -Math.PI / 2 }); // Shard Runner: forward shard
    case 5: return mergeSimple([xf(new THREE.OctahedronGeometry(0.8, 0), { sy: 0.55 }), xf(new THREE.TorusGeometry(1.05, 0.05, 4, 6), { rx: Math.PI / 2 })]); // Mirror Drone
    case 7: return mergeSimple([xf(new THREE.CylinderGeometry(0.42, 0.55, 1.3, 10), { py: -0.2 }), xf(new THREE.SphereGeometry(0.32, 12, 8), { py: 0.95 }), xf(new THREE.TorusGeometry(0.5, 0.05, 6, 20), { py: 0.2 })]); // Dummy
    default: return new THREE.IcosahedronGeometry(1, 0);
  }
}

function makeLabelTexture(text, color, opts = {}) {
  const c = document.createElement('canvas');
  const fontSize = opts.fontSize || 64;
  const ctx = c.getContext('2d');
  ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = Math.max(64, w);
  c.height = fontSize + 32;
  ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = opts.blur ?? 18;
  ctx.lineWidth = opts.stroke ?? 3;
  ctx.strokeStyle = color;
  ctx.fillStyle = opts.fill || 'rgba(5,6,15,0.85)';
  ctx.fillText(text, c.width / 2, c.height / 2);
  ctx.strokeText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return { tex, aspect: c.width / c.height };
}

function hexStr(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------------ */
/* Renderer                                                                  */
/* ------------------------------------------------------------------------ */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _c = new THREE.Color();

export class Renderer {
  /** True if a WebGL context can be created. */
  static supported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'high', powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false; // several passes per frame; reset manually in beginFrame
    this.renderer.setClearColor(0x05060f, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(68, 1, 0.01, 10);

    this.palette = {};
    this.time = 0;
    this.arenaGroup = null;
    this.arena = null;

    this.particles = new ParticleSystem(this.scene, settings.particles);
    this.ribbons = new RibbonPool(this.scene, 1024);
    this.rings = new RingPool(this.scene, 128);
    this.fractureFx = new FractureFx(this.scene, 24);
    this.shake = new ScreenShake();

    this.entityMaterials = [];
    this.buildEnemyMeshes();
    this.buildProjectileMeshes();
    this.buildPlayerPool();
    this.buildViewmodels();
    this.buildPost();

    this.postState = { damage: 0, phase: 0, lowHealth: 0, pulse: 0, flash: 0 };
    this.applySettings();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------------------------------------------------------------- */
  /* settings                                                          */
  /* ---------------------------------------------------------------- */

  applySettings() {
    const s = this.settings;
    const pal = s.colorblind ? PALETTES.colorblind : PALETTES.normal;
    for (const k of Object.keys(pal)) {
      if (!this.palette[k]) this.palette[k] = new THREE.Color();
      this.palette[k].setHex(pal[k]);
    }
    this.q = QUALITY[s.quality] || QUALITY.medium;
    this.shake.enabled = s.screenShake && !s.reducedFlashes;
    this.particles.setQuality(s.particles);
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    if (this.arena) this.buildArena(this.arena); // rebuild for palette / decor density
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, (QUALITY[this.settings.quality] || QUALITY.medium).pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    const scale = Math.max(0.5, Math.min(1, this.settings.renderScale || 1)) * (this.settings.quality === 'low' ? 0.85 : 1);
    const rw = Math.max(1, Math.floor(w * pr * scale)), rh = Math.max(1, Math.floor(h * pr * scale));
    if (this.rt) this.rt.setSize(rw, rh);
    if (this.postMat) this.postMat.uniforms.uRes.value.set(rw, rh);
    this.particles.setViewportHeight(h * pr);
  }

  /* ---------------------------------------------------------------- */
  /* materials                                                         */
  /* ---------------------------------------------------------------- */

  entityMaterial(color = 0xffffff, opts = {}) {
    const m = new THREE.ShaderMaterial({
      vertexShader: ENTITY_VERT,
      fragmentShader: opts.glow ? GLOW_FRAG : ENTITY_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opts.opacity ?? 1 }, uEmissive: { value: opts.emissive ?? 0.05 } },
      transparent: !!opts.transparent || !!opts.glow,
      depthWrite: !opts.glow,
      blending: opts.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.entityMaterials.push(m);
    return m;
  }

  outlineMaterial(color = 0xffffff, width = 0.06, opacity = 1) {
    return new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uWidth: { value: width }, uOpacity: { value: opacity } },
      side: THREE.BackSide,
      transparent: opacity < 1,
    });
  }

  /* ---------------------------------------------------------------- */
  /* arena                                                             */
  /* ---------------------------------------------------------------- */

  disposeArena() {
    if (!this.arenaGroup) return;
    this.scene.remove(this.arenaGroup);
    this.arenaGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
    });
    this.arenaGroup = null;
  }

  /**
   * Build all static arena visuals.
   * @param {object} arena shared/arenas.js definition (the client's own copy)
   */
  buildArena(arena) {
    this.disposeArena();
    this.arena = arena;
    const P = this.palette;
    const g = new THREE.Group();
    this.arenaGroup = g;
    const zoneColors = [P.neutral, P.cyan, P.magenta, P.violet, P.amber];
    const pal = arena.palette;
    const fogColor = new THREE.Color(pal.fog);
    const fogFar = arena.half * 2.6;

    // ---- fill geometry (merged) --------------------------------------
    const solid = [];
    const phase = [];
    this.propMeshes = new Map();
    for (const c of arena.colliders) {
      if (c.invisible) continue;
      if (c.kind === ColliderKind.PHASE) phase.push(c);
      else if (c.kind === ColliderKind.PROP) continue;
      else solid.push(c);
    }
    this.arenaFillMat = new THREE.ShaderMaterial({
      vertexShader: ARENA_VERT, fragmentShader: ARENA_FRAG,
      uniforms: {
        uZone: { value: zoneColors.map((c) => c.clone()) },
        uFill: { value: new THREE.Color(pal.fill) },
        uFog: { value: fogColor },
        uFogNear: { value: arena.half * 0.6 },
        uFogFar: { value: fogFar },
        uTime: { value: 0 },
      },
    });
    g.add(new THREE.Mesh(this.boxesGeometry(solid), this.arenaFillMat));

    // ---- ink outlines --------------------------------------------------
    this.edgeMats = [];
    const edgeGeo = this.edgesGeometry(solid, zoneColors, arena.decorSeed, 0.12);
    const edgeMat = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG,
      uniforms: { uTime: { value: 0 }, uWobble: { value: 0.025 }, uOpacity: { value: 0.95 }, uFog: { value: fogColor }, uFogFar: { value: fogFar } },
      transparent: true, depthWrite: false,
    });
    this.edgeMats.push(edgeMat);
    g.add(new THREE.LineSegments(edgeGeo, edgeMat));
    if (this.q.sketchPass) {
      const sketchMat = edgeMat.clone();
      sketchMat.uniforms = THREE.UniformsUtils.clone(edgeMat.uniforms);
      sketchMat.uniforms.uWobble.value = 0.07;
      sketchMat.uniforms.uOpacity.value = 0.35;
      this.edgeMats.push(sketchMat);
      g.add(new THREE.LineSegments(this.edgesGeometry(solid, zoneColors, arena.decorSeed + 99, 0.35), sketchMat));
    }

    // ---- destructible props ----------------------------------------------
    for (const c of arena.colliders) {
      if (c.kind !== ColliderKind.PROP) continue;
      const pg = new THREE.Group();
      pg.add(new THREE.Mesh(this.boxesGeometry([c]), this.arenaFillMat));
      pg.add(new THREE.LineSegments(this.edgesGeometry([c], [P.amber, P.amber, P.amber, P.amber, P.amber], c.id, 0.05), edgeMat));
      g.add(pg);
      this.propMeshes.set(c.id, pg);
    }

    // ---- phase barriers --------------------------------------------------
    if (phase.length) {
      this.phaseMat = new THREE.ShaderMaterial({
        vertexShader: UV_VERT,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; uniform float uTime; uniform float uOpen; varying vec2 vUv;
          void main() {
            float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 4.0);
            float hex = step(0.92, fract(vUv.x * 12.0 + sin(vUv.y * 20.0 + uTime) * 0.1));
            float a = mix(0.42, 0.12, uOpen) * (0.6 + 0.4 * scan) + hex * 0.3;
            gl_FragColor = vec4(uColor * (0.8 + scan * 0.6), a);
          }`,
        uniforms: { uColor: { value: P.violet.clone() }, uTime: { value: 0 }, uOpen: { value: 0 } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      for (const c of phase) {
        const w = c.maxX - c.minX, h = c.maxY - c.minY, d = c.maxZ - c.minZ;
        const geo = new THREE.BoxGeometry(w, h, d);
        const m = new THREE.Mesh(geo, this.phaseMat);
        m.position.set((c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2, (c.minZ + c.maxZ) / 2);
        g.add(m);
      }
      g.add(new THREE.LineSegments(this.edgesGeometry(phase, zoneColors, 5, 0.02), edgeMat));
    }

    // ---- interactive markers ---------------------------------------------
    this.ringMeshes = [];
    for (const r of arena.rings) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r.r, 0.13, 8, 48), this.entityMaterial(P.amber.getHex(), { glow: true }));
      ring.position.set(r.x, r.y, r.z);
      ring.lookAt(0, r.y, 0);
      g.add(ring);
      const inner = new THREE.Mesh(new THREE.TorusGeometry(r.r * 0.75, 0.04, 6, 32), this.entityMaterial(P.cyan.getHex(), { glow: true, opacity: 0.6 }));
      ring.add(inner);
      this.ringMeshes.push(ring);
    }
    this.flowMats = [];
    const flowMat = (color, speed) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: UV_VERT, fragmentShader: FLOW_FRAG,
        uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uSpeed: { value: speed } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.flowMats.push(m);
      return m;
    };
    for (const p of arena.pads) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), flowMat(P.cyan, 1.5));
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(p.x, p.y + 0.03, p.z);
      g.add(disc);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.9, p.r, 3, 16, 1, true), flowMat(P.cyan, -2));
      beam.position.set(p.x, p.y + 1.5, p.z);
      g.add(beam);
    }
    for (const z of arena.healZones) {
      const disc = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.8, z.r, 32), flowMat(P.mint, 0.6));
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(z.x, z.y + 0.03, z.z);
      g.add(disc);
      const plus = new THREE.Mesh(mergeSimple([new THREE.BoxGeometry(0.3, 0.02, 1.2), new THREE.BoxGeometry(1.2, 0.02, 0.3)]), this.entityMaterial(P.mint.getHex(), { glow: true }));
      plus.position.set(z.x, z.y + 0.05, z.z);
      g.add(plus);
    }
    for (const h of arena.hazards) {
      const w = h.maxX - h.minX, d = h.maxZ - h.minZ;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), flowMat(P.danger, 0.8));
      plane.rotation.x = -Math.PI / 2;
      if (w > d) plane.rotation.z = Math.PI / 2;
      plane.position.set((h.minX + h.maxX) / 2, 0.04, (h.minZ + h.maxZ) / 2);
      g.add(plane);
    }

    // ---- reactor ---------------------------------------------------------------
    this.reactorGroup = null;
    if (arena.reactor) {
      const r = arena.reactor;
      const rg = new THREE.Group();
      rg.position.set(r.x, 0, r.z);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, r.height + 3, 20, 1, true), this.entityMaterial(P.amber.getHex(), { glow: true }));
      core.position.y = r.height / 2 + 1.5;
      rg.add(core);
      this.reactorRings = [];
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(4.6 + i * 0.5, 0.1, 6, 40), this.entityMaterial([P.amber, P.cyan, P.magenta][i].getHex(), { glow: true }));
        ring.position.y = 2 + i * 3;
        rg.add(ring);
        this.reactorRings.push(ring);
      }
      this.reactorCore = core;
      g.add(rg);
      this.reactorGroup = rg;
    }

    // ---- landmark labels -------------------------------------------------------
    for (const l of arena.landmarks) {
      const color = zoneColors[l.zone] || P.neutral;
      const { tex, aspect } = makeLabelTexture(l.label, hexStr(color.getHex()));
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      const h = l.label.length > 3 ? 2.2 : 3;
      sp.scale.set(h * aspect, h, 1);
      sp.position.set(l.x, l.y + 2.2, l.z);
      g.add(sp);
    }

    // ---- sky -----------------------------------------------------------------------
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      uniforms: {
        uBottom: { value: new THREE.Color(pal.sky[0]) }, uTop: { value: new THREE.Color(pal.sky[1]) },
        uAccentA: { value: P.cyan.clone() }, uAccentB: { value: P.magenta.clone() }, uTime: { value: 0 },
      },
      side: THREE.BackSide, depthWrite: false,
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.skyMat = sky.material;
    g.add(sky);

    // ---- procedural decoration: floating shards + quantum glyphs ------------------
    const rng = mulberry32(arena.decorSeed);
    const n = this.q.decor;
    const decor = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.ShaderMaterial({
      vertexShader: DECOR_VERT, fragmentShader: DECOR_FRAG,
      uniforms: { uTime: { value: 0 }, uA: { value: P.violet.clone() }, uB: { value: P.cyan.clone() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }), n);
    const phases = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const rad = arena.half + 8 + rng() * 70;
      const y = -18 + rng() * 60;
      const s = 0.3 + rng() * 2.4;
      _m4.compose(_v.set(Math.cos(a) * rad, y, Math.sin(a) * rad), _q.setFromEuler(_e.set(rng() * 6, rng() * 6, 0)), _s.set(s, s * (0.6 + rng()), s));
      decor.setMatrixAt(i, _m4);
      phases[i] = rng() * 10;
    }
    decor.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    decor.frustumCulled = false;
    this.decorMat = decor.material;
    g.add(decor);

    const glyphChars = ['Ψ', 'Δ', '∞', 'λ', 'Ω', 'φ', '⌬', '∴'];
    for (let i = 0; i < this.q.glyphs; i++) {
      const ch = glyphChars[i % glyphChars.length];
      const col = [P.cyan, P.magenta, P.violet, P.amber][i % 4];
      const { tex, aspect } = makeLabelTexture(ch, hexStr(col.getHex()), { fill: 'rgba(0,0,0,0)', blur: 24, stroke: 2 });
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, blending: THREE.AdditiveBlending }));
      const a = rng() * Math.PI * 2, rad = arena.half + 20 + rng() * 60;
      const s = 4 + rng() * 8;
      sp.scale.set(s * aspect, s, 1);
      sp.position.set(Math.cos(a) * rad, 8 + rng() * 40, Math.sin(a) * rad);
      g.add(sp);
    }

    this.scene.add(g);
    this.fogColor = fogColor;
  }

  /** Merge collider boxes into one indexed geometry with zone/glow attributes. */
  boxesGeometry(cols) {
    const pos = [], nor = [], zone = [], glow = [], idx = [];
    const faces = [
      [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
      [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
      [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
      [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
      [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
      [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
    ];
    for (const c of cols) {
      const sx = c.maxX - c.minX, sy = c.maxY - c.minY, sz = c.maxZ - c.minZ;
      for (const [n, verts] of faces) {
        const base = pos.length / 3;
        for (const [vx, vy, vz] of verts) {
          pos.push(c.minX + vx * sx, c.minY + vy * sy, c.minZ + vz * sz);
          nor.push(n[0], n[1], n[2]);
          zone.push(c.zone || 0);
          glow.push(c.landmark ? 1 : 0);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aZone', new THREE.Float32BufferAttribute(zone, 1));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Sketchy box outlines: each edge overshoots its corners and is jittered by
   * a seeded RNG so the outlines look hand-drawn but stay stable frame to frame.
   */
  edgesGeometry(cols, zoneColors, seed, jitter) {
    const rng = mulberry32(seed);
    const pos = [], col = [], seeds = [];
    for (const c of cols) {
      const xs = [c.minX, c.maxX], ys = [c.minY, c.maxY], zs = [c.minZ, c.maxZ];
      const color = zoneColors[c.zone] || zoneColors[0];
      const bright = c.landmark ? 1.2 : 0.85;
      const edges = [];
      for (const y of ys) for (const z of zs) edges.push([[xs[0], y, z], [xs[1], y, z]]);
      for (const x of xs) for (const z of zs) edges.push([[x, ys[0], z], [x, ys[1], z]]);
      for (const x of xs) for (const y of ys) edges.push([[x, y, zs[0]], [x, y, zs[1]]]);
      for (const [a, b] of edges) {
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const over = Math.min(0.35, len * 0.06) * (0.5 + rng());
        const ox = (dx / len) * over, oy = (dy / len) * over, oz = (dz / len) * over;
        const j = () => (rng() - 0.5) * jitter;
        pos.push(a[0] - ox + j(), a[1] - oy + j(), a[2] - oz + j(), b[0] + ox + j(), b[1] + oy + j(), b[2] + oz + j());
        for (let k = 0; k < 2; k++) {
          col.push(color.r * bright, color.g * bright, color.b * bright);
          seeds.push(rng());
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /** Show/hide destructible props according to the snapshot's destroyed list. */
  setDestroyedProps(destroyedIds) {
    if (!this.propMeshes) return;
    for (const [id, m] of this.propMeshes) m.visible = !destroyedIds.includes(id);
  }

  /* ---------------------------------------------------------------- */
  /* entities                                                          */
  /* ---------------------------------------------------------------- */

  buildEnemyMeshes() {
    const caps = [96, 24, 24, 24, 32, 24, 0, 12];
    this.enemyMeshes = [];
    for (let type = 0; type < caps.length; type++) {
      if (!caps[type]) { this.enemyMeshes.push(null); continue; }
      const geo = enemyGeometry(type);
      const mat = this.entityMaterial(0xffffff, { emissive: 0.08 });
      const mesh = new THREE.InstancedMesh(geo, mat, caps[type]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, _c.setRGB(1, 1, 1));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      const outline = new THREE.InstancedMesh(geo, this.outlineMaterial(0xffffff, type === 0 ? 0.05 : 0.07), caps[type]);
      outline.instanceMatrix = mesh.instanceMatrix;
      outline.instanceColor = mesh.instanceColor;
      outline.count = 0;
      outline.frustumCulled = false;
      this.scene.add(mesh, outline);
      this.enemyMeshes.push({ mesh, outline, cap: caps[type] });
    }
    // Singularity Titan: a dedicated multi-part boss model.
    const titan = new THREE.Group();
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 1), this.entityMaterial(0x9b6bff, { emissive: 0.05 }));
    body.add(new THREE.Mesh(body.geometry, this.outlineMaterial(0xff4fd8, 0.12)));
    titan.add(body);
    this.titanRings = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(4.6 + i * 0.9, 0.16, 6, 48), this.entityMaterial([0xff4fd8, 0x9b6bff, 0x5ff6ff][i], { glow: true }));
      titan.add(r);
      this.titanRings.push(r);
    }
    this.titanCore = new THREE.Mesh(new THREE.SphereGeometry(1.25, 20, 14), this.entityMaterial(0xffb347, { glow: true }));
    this.titanCore.position.set(0, 0, -3.1);
    titan.add(this.titanCore);
    titan.visible = false;
    this.titanBody = body;
    this.titan = titan;
    this.scene.add(titan);
    // Shield bubbles (Rift Caster support)
    this.shieldMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.entityMaterial(0x6bb5ff, { glow: true, opacity: 0.35 }), 48);
    this.shieldMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shieldMesh.count = 0;
    this.shieldMesh.frustumCulled = false;
    this.scene.add(this.shieldMesh);
  }

  buildProjectileMeshes() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: ENTITY_VERT, fragmentShader: PROJ_FRAG,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 1 }, uEmissive: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.projMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, 1024);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.projMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.count = 0;
    this.projMesh.frustumCulled = false;
    this.scene.add(this.projMesh);

    this.pickupMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.38, 0), this.entityMaterial(0xffffff, { emissive: 0.5 }), 64);
    this.pickupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pickupMesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.pickupMesh.count = 0;
    this.pickupMesh.frustumCulled = false;
    this.scene.add(this.pickupMesh);
  }

  buildPlayerPool() {
    this.playerVisuals = [];
    const bodyGeo = new THREE.CapsuleGeometry(0.36, 0.72, 4, 12);
    const headGeo = new THREE.SphereGeometry(0.27, 14, 10);
    const visorGeo = new THREE.BoxGeometry(0.38, 0.09, 0.1);
    const gunGeo = new THREE.BoxGeometry(0.12, 0.14, 0.7);
    for (let i = 0; i < 12; i++) {
      const color = SLOT_COLORS[i];
      const grp = new THREE.Group();
      const bodyMat = this.entityMaterial(color, { emissive: 0.04, transparent: true });
      const outMat = this.outlineMaterial(color, 0.05);
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.82;
      body.add(new THREE.Mesh(bodyGeo, outMat));
      const head = new THREE.Mesh(headGeo, bodyMat);
      head.position.y = 1.58;
      head.add(new THREE.Mesh(headGeo, outMat));
      const visor = new THREE.Mesh(visorGeo, this.entityMaterial(0xffffff, { glow: true }));
      visor.position.set(0, 0.03, -0.24);
      head.add(visor);
      const gun = new THREE.Mesh(gunGeo, this.entityMaterial(color, { emissive: 0.3 }));
      gun.position.set(0.3, 1.12, -0.35);
      grp.add(body, head, gun);
      grp.visible = false;
      this.scene.add(grp);
      this.playerVisuals.push({ grp, body, head, gun, bodyMat, outMat, nameSprite: null, name: '', id: 0, lastX: 0, lastZ: 0 });
    }
  }

  /** Name tag sprite (created once per name). */
  setPlayerName(v, name, color) {
    if (v.name === name && v.nameSprite) return;
    if (v.nameSprite) { v.grp.remove(v.nameSprite); v.nameSprite.material.map.dispose(); v.nameSprite.material.dispose(); }
    const { tex, aspect } = makeLabelTexture(name, hexStr(color), { fontSize: 44, blur: 8, stroke: 2, fill: '#e9e6ff' });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(0.5 * aspect, 0.5, 1);
    sp.position.y = 2.25;
    v.grp.add(sp);
    v.nameSprite = sp;
    v.name = name;
  }

  /**
   * Draw remote players.
   * @param {Map<number, object>} players interpolated render objects (raw = snapshot row)
   * @param {number} localId
   * @param {Map<number,string>} names
   */
  drawPlayers(players, localId, names, camPos) {
    let i = 0;
    for (const [id, o] of players) {
      if (id === localId) continue;
      if (i >= this.playerVisuals.length) break;
      const v = this.playerVisuals[i++];
      const r = o.raw;
      const flags = r[7];
      const slot = r[14] % 12;
      const color = SLOT_COLORS[slot];
      v.grp.visible = !(flags & PF.DEAD);
      if (!v.grp.visible) continue;
      v.grp.position.set(o.x, o.y, o.z);
      v.grp.rotation.set(0, o.yaw, 0);
      v.head.rotation.x = r[5] * 0.6;
      // procedural lean from horizontal velocity
      const vx = (o.x - v.lastX) * 60, vz = (o.z - v.lastZ) * 60;
      v.lastX = o.x; v.lastZ = o.z;
      const sliding = flags & PF.SLIDING;
      const downed = flags & PF.DOWNED;
      v.body.rotation.x = downed ? Math.PI / 2 : sliding ? -0.9 : Math.max(-0.25, Math.min(0.25, -(vx * Math.sin(o.yaw) + vz * Math.cos(o.yaw)) * 0.012));
      v.body.position.y = downed ? 0.35 : sliding ? 0.5 : 0.82;
      v.head.position.y = downed ? 0.35 : sliding ? 0.95 : 1.58;
      v.head.position.z = downed ? -0.95 : 0;
      const phased = flags & PF.PHASED;
      const prot = flags & PF.PROTECTED;
      v.bodyMat.uniforms.uOpacity.value = phased ? 0.35 + Math.sin(this.time * 30) * 0.1 : prot ? 0.55 + Math.sin(this.time * 20) * 0.3 : 1;
      v.bodyMat.uniforms.uColor.value.setHex(color);
      v.outMat.uniforms.uColor.value.setHex(flags & PF.REVEALED ? this.palette.danger.getHex() : color);
      // Anti-stall reveal: outline visible through walls.
      v.outMat.depthTest = !(flags & PF.REVEALED);
      v.outMat.uniforms.uWidth.value = flags & PF.REVEALED ? 0.09 : 0.05;
      const dist = camPos ? Math.hypot(o.x - camPos.x, o.z - camPos.z) : 0;
      this.setPlayerName(v, names.get(id) || 'Runner', color);
      v.nameSprite.visible = dist < 55; // LOD: hide name tags far away
      // grapple rope
      if (flags & PF.GRAPPLING) this.rope(o.x, o.y + 1.2, o.z, r[10], r[11], r[12], _c.setHex(color), 0.035);
    }
    for (; i < this.playerVisuals.length; i++) this.playerVisuals[i].grp.visible = false;
  }

  /** Multi-segment animated rope / tether ribbon. */
  rope(ax, ay, az, bx, by, bz, color, width, wave = 0.15, alpha = 0.9) {
    const segs = 10;
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= segs; k++) {
      const t = k / segs;
      const w = Math.sin(t * Math.PI) * Math.sin(this.time * 18 + t * 9) * wave;
      const x = ax + (bx - ax) * t + w, y = ay + (by - ay) * t + w * 0.6, z = az + (bz - az) * t - w;
      this.ribbons.transient(px, py, pz, x, y, z, color.r, color.g, color.b, alpha, width);
      px = x; py = y; pz = z;
    }
  }

  /**
   * Draw enemies (instanced per archetype).
   * @param {Map<number,object>} enemies interpolated render objects
   * @param {Map<number,number>} hitFlash id -> time of last hit (for white flash)
   */
  drawEnemies(enemies, hitFlash) {
    const P = this.palette;
    const counts = [0, 0, 0, 0, 0, 0, 0, 0];
    let shields = 0;
    let titanSeen = false;
    for (const [id, o] of enemies) {
      const r = o.raw;
      const type = r[1];
      const flags = r[8];
      if (type === 6) {
        titanSeen = true;
        this.titan.visible = true;
        this.titan.position.set(o.x, o.y, o.z);
        this.titan.rotation.y = o.yaw;
        const open = flags & EF.WEAKPOINT_OPEN;
        this.titanCore.scale.setScalar(open ? 1.3 + Math.sin(this.time * 12) * 0.15 : 1);
        this.titanCore.material.uniforms.uColor.value.copy(open ? P.white : P.amber);
        this.titanRings.forEach((ring, k) => {
          ring.rotation.set(this.time * (0.5 + k * 0.3), this.time * (0.7 - k * 0.2), k);
        });
        const flash = this.time - (hitFlash.get(id) || -10) < 0.08;
        this.titanBody.material.uniforms.uColor.value.copy(flash ? P.white : (flags & EF.TELEGRAPH ? P.danger : P.violet));
        continue;
      }
      const em = this.enemyMeshes[type];
      if (!em) continue;
      const n = counts[type];
      if (n >= em.cap) continue;
      const cloaked = flags & EF.CLOAKED;
      let scale = flags & EF.ELITE ? 1.25 : 1;
      if (cloaked) scale = 0.0001; // invisible while cloaked (the warning shimmer reveals it)
      const telegraph = flags & EF.TELEGRAPH;
      const spin = type === 3 || type === 5 ? this.time * 2 : 0;
      _e.set(type === 4 && (flags & EF.CHARGING) ? 0 : 0, o.yaw + spin, type === 0 ? Math.sin(this.time * 10 + id) * 0.3 : 0);
      _q.setFromEuler(_e);
      _m4.compose(_v.set(o.x, o.y, o.z), _q, _s.set(scale, scale, scale));
      em.mesh.setMatrixAt(n, _m4);
      // colour: archetype base, elite amber, telegraph pulse, hit flash white
      const base = type === 7 ? P.neutral : type === 2 ? P.violet : type === 5 ? P.cyan : type === 1 ? P.amber : P.enemy;
      _c.copy(base);
      if (flags & EF.ELITE) _c.lerp(P.amber, 0.6);
      if (telegraph) _c.lerp(P.danger, 0.5 + 0.5 * Math.sin(this.time * 25));
      if (flags & EF.STUNNED) _c.lerp(P.white, 0.3 + 0.3 * Math.sin(this.time * 40));
      if (this.time - (hitFlash.get(id) || -10) < 0.07) _c.setRGB(2.2, 2.2, 2.2);
      em.mesh.setColorAt(n, _c);
      counts[type] = n + 1;
      if ((flags & EF.SHIELDED) && shields < 48) {
        const sr = (r[1] === 1 ? 2.2 : 1.3) * scale;
        _m4.compose(_v.set(o.x, o.y, o.z), _q.identity(), _s.set(sr, sr, sr));
        this.shieldMesh.setMatrixAt(shields++, _m4);
      }
      // Phase Stalker warning shimmer (it is materialising)
      if (type === 2 && telegraph) this.particles.spawn(o.x + (Math.random() - 0.5), o.y + (Math.random() - 0.5) * 2, o.z + (Math.random() - 0.5), 0, 1, 0, P.violet, 4, 0.4);
    }
    if (!titanSeen) this.titan.visible = false;
    for (let t = 0; t < this.enemyMeshes.length; t++) {
      const em = this.enemyMeshes[t];
      if (!em) continue;
      em.mesh.count = counts[t];
      em.outline.count = counts[t];
      if (counts[t]) {
        em.mesh.instanceMatrix.needsUpdate = true;
        em.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.shieldMesh.count = shields;
    if (shields) this.shieldMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Projectiles. While the local player is phase-shifted, hostile projectiles
   * are drawn with delayed afterimages along their path (Phase Break telegraph).
   */
  drawProjectiles(projectiles, localPhased) {
    const P = this.palette;
    let n = 0;
    const cap = 1024;
    for (const [, o] of projectiles) {
      const r = o.raw;
      const kind = r[1];
      const hostile = kind === PK.ENEMY_BOLT || kind === PK.HEAVY_ORB || kind === PK.TITAN_ORB;
      const size = kind === PK.PELLET ? 0.09 : kind === PK.ORB ? 0.5 : kind === PK.HEAVY_ORB ? 0.5 : kind === PK.TITAN_ORB ? 0.6 : kind === PK.DEFLECTED ? 0.3 : 0.28;
      const color = kind === PK.PELLET ? P.magenta : kind === PK.ORB ? P.amber : kind === PK.DEFLECTED ? P.mint : hostile ? P.danger : P.cyan;
      const ghosts = hostile && localPhased ? 4 : 1;
      for (let g = 0; g < ghosts && n < cap; g++) {
        const lag = g * 0.09;
        const x = o.x - r[5] * lag, y = o.y - r[6] * lag, z = o.z - r[7] * lag;
        const s = size * (1 - g * 0.18) * (kind === PK.ORB ? 1 + Math.sin(this.time * 14) * 0.15 : 1);
        _m4.compose(_v.set(x, y, z), _q.identity(), _s.set(s, s, s));
        this.projMesh.setMatrixAt(n, _m4);
        _c.copy(color).multiplyScalar(g === 0 ? 1.4 : 0.6 - g * 0.1);
        this.projMesh.setColorAt(n, _c);
        n++;
      }
      // short motion streak behind every projectile
      const sp = Math.hypot(r[5], r[6], r[7]);
      if (sp > 1) {
        const k = Math.min(0.06, 1.2 / sp);
        this.ribbons.transient(o.x - r[5] * k, o.y - r[6] * k, o.z - r[7] * k, o.x, o.y, o.z, color.r, color.g, color.b, 0.7, size * 0.8);
      }
    }
    this.projMesh.count = n;
    if (n) {
      this.projMesh.instanceMatrix.needsUpdate = true;
      this.projMesh.instanceColor.needsUpdate = true;
    }
  }

  drawPickups(pickups) {
    const P = this.palette;
    let n = 0;
    for (const p of pickups) {
      if (n >= 64) break;
      const [id, kind, x, y, z] = p;
      _e.set(0, this.time * 2 + id, 0);
      _q.setFromEuler(_e);
      _m4.compose(_v.set(x, y + 0.3 + Math.sin(this.time * 3 + id) * 0.15, z), _q, _s.set(1, 1, 1));
      this.pickupMesh.setMatrixAt(n, _m4);
      this.pickupMesh.setColorAt(n, kind === PICKUP.HEALTH ? P.mint : kind === PICKUP.PULSE ? P.violet : P.amber);
      n++;
    }
    this.pickupMesh.count = n;
    if (n) {
      this.pickupMesh.instanceMatrix.needsUpdate = true;
      this.pickupMesh.instanceColor.needsUpdate = true;
    }
  }

  drawHazards(hazards) {
    for (const h of hazards) {
      const [, x, y, z, r, life] = h;
      this.rings.transient({ x, y: y + 0.05, z, r, color: this.palette.danger, alpha: 0.5 * life, thickness: 1, style: RingStyle.PLAIN, face: 'up' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* viewmodel                                                         */
  /* ---------------------------------------------------------------- */

  buildViewmodels() {
    this.vmRoot = new THREE.Group();
    this.vmRoot.scale.setScalar(0.8);
    this.vmScene.add(this.vmRoot);
    this.viewmodels = WEAPONS.map((w, i) => {
      const grp = new THREE.Group();
      const body = this.entityMaterial(0x1c2040, { emissive: 0.0 });
      const accent = this.entityMaterial(w.color, { glow: true, opacity: 0.55 });
      const outline = this.outlineMaterial(w.color, 0.006, 0.8);
      const add = (geo, mat, o) => { const m = new THREE.Mesh(xf(geo, o), mat); grp.add(m); if (mat === body) m.add(new THREE.Mesh(m.geometry, outline)); return m; };
      switch (i) {
        case 0: // Pulse Carbine
          add(new THREE.BoxGeometry(0.09, 0.12, 0.55), body, { pz: -0.1 });
          add(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), body, { rx: Math.PI / 2, pz: -0.5, py: 0.02 });
          add(new THREE.BoxGeometry(0.1, 0.02, 0.4), accent, { py: 0.07, pz: -0.1 });
          add(new THREE.BoxGeometry(0.06, 0.15, 0.08), body, { py: -0.12, pz: 0.05 });
          break;
        case 1: // Arc Scatter
          add(new THREE.BoxGeometry(0.16, 0.14, 0.45), body, { pz: -0.05 });
          for (let k = -1; k <= 1; k++) add(new THREE.CylinderGeometry(0.03, 0.035, 0.22, 8), accent, { rx: Math.PI / 2, pz: -0.38, px: k * 0.05, py: 0.02 });
          break;
        case 2: // Vector Lance
          add(new THREE.BoxGeometry(0.06, 0.08, 0.8), body, { pz: -0.2 });
          for (let k = 0; k < 3; k++) add(new THREE.TorusGeometry(0.06, 0.012, 6, 16), accent, { pz: -0.3 - k * 0.15 });
          break;
        case 3: // Singularity Launcher
          add(new THREE.BoxGeometry(0.2, 0.2, 0.45), body, {});
          add(new THREE.SphereGeometry(0.09, 12, 10), accent, { pz: -0.32 });
          add(new THREE.TorusGeometry(0.13, 0.02, 6, 20), accent, { pz: -0.28 });
          break;
        case 4: // Phase Blades
          add(new THREE.BoxGeometry(0.02, 0.06, 0.6), accent, { pz: -0.25, rz: 0.2 });
          add(new THREE.BoxGeometry(0.04, 0.05, 0.12), body, { pz: 0.08 });
          break;
        case 5: // Echo Repeater
          add(new THREE.BoxGeometry(0.11, 0.12, 0.5), body, { pz: -0.08 });
          add(new THREE.TorusGeometry(0.05, 0.012, 6, 16), accent, { pz: -0.38 });
          add(new THREE.TorusGeometry(0.035, 0.01, 6, 16), accent, { pz: -0.45 });
          break;
        default: break;
      }
      grp.visible = false;
      this.vmRoot.add(grp);
      return { grp, accent };
    });
    // second blade for dual Phase Blades
    const left = this.viewmodels[4].grp.clone();
    left.position.x = -0.5;
    left.scale.x = -1;
    this.viewmodels[4].grp.add(left);
    this.viewmodels[4].left = left;
    this.muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    this.muzzle.scale.set(0.25, 0.25, 1);
    this.vmScene.add(this.muzzle);
  }

  /**
   * Animate and show the first-person weapon.
   * @param {object} vm {weapon, bob, sway, recoil, reload, switch, swing, charge, visible, muzzle}
   */
  drawViewmodel(vm) {
    for (let i = 0; i < this.viewmodels.length; i++) this.viewmodels[i].grp.visible = vm.visible && i === vm.weapon;
    const cur = this.viewmodels[vm.weapon];
    if (!cur) return;
    const g = this.vmRoot;
    const lower = vm.reload * 0.35 + vm.switch * 0.5;
    g.position.set(0.27 + vm.sway.x + Math.cos(vm.bob * 2) * 0.008 * vm.bobAmp, -0.27 - lower * 0.4 + Math.abs(Math.sin(vm.bob)) * 0.012 * vm.bobAmp + vm.sway.y, -0.66 + vm.recoil * 0.1);
    g.rotation.set(vm.recoil * 0.35 + lower * 0.9, 0.07 + vm.sway.x * 2, vm.reload * 0.5);
    if (vm.weapon === 4) {
      cur.grp.rotation.set(-vm.swing * 1.2, vm.swing * 0.8, -vm.swing * 0.6);
      if (cur.left) cur.left.rotation.set(vm.swing * 0.4, 0, 0);
    } else cur.grp.rotation.set(0, 0, 0);
    // Vector Lance charge colour: violet -> magenta -> amber at full power
    if (vm.weapon === 2) {
      const c = vm.charge;
      _c.copy(this.palette.violet).lerp(c < 0.99 ? this.palette.magenta : this.palette.amber, c < 0.99 ? c : 1);
      cur.accent.uniforms.uColor.value.copy(_c).multiplyScalar(1 + c);
    }
    const mz = this.muzzle;
    mz.material.opacity = vm.muzzle;
    mz.material.color.copy(vm.muzzleColor || this.palette.cyan);
    mz.position.set(g.position.x, g.position.y + 0.03, g.position.z - 0.55);
    mz.scale.setScalar(0.18 + vm.muzzle * 0.25);
  }

  /* ---------------------------------------------------------------- */
  /* post-processing                                                   */
  /* ---------------------------------------------------------------- */

  buildPost() {
    this.rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true, type: THREE.UnsignedByteType });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT, fragmentShader: POST_FRAG,
      uniforms: {
        tDiffuse: { value: this.rt.texture }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uCA: { value: 1 }, uVignette: { value: 0.5 }, uGrain: { value: 0.05 }, uDamage: { value: 0 }, uPhase: { value: 0 },
        uLowHealth: { value: 0 }, uPulse: { value: 0 }, uFlash: { value: 0 },
        uPhaseColor: { value: new THREE.Color(0x9b6bff) }, uDamageColor: { value: new THREE.Color(0xff3b6b) },
      },
      depthTest: false, depthWrite: false,
    });
    this.postQuad = new THREE.Mesh(geo, this.postMat);
    this.postQuad.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(this.postQuad);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /* ---------------------------------------------------------------- */
  /* effect helpers                                                    */
  /* ---------------------------------------------------------------- */

  tracer(ax, ay, az, bx, by, bz, color, width = 0.04, life = 0.12) {
    this.ribbons.add(ax, ay, az, bx, by, bz, color, width, life);
  }

  impact(x, y, z, color, count = 10, speed = 6) {
    this.particles.burst(x, y, z, count, speed, color, 3.5, 0.35, { gravity: 8, drag: 3 });
  }

  explosion(x, y, z, radius, color) {
    this.particles.burst(x, y, z, Math.round(18 + radius * 8), radius * 4, color, 7, 0.7, { gravity: 4, drag: 2, up: 1 });
    this.rings.add({ x, y, z, r0: 0.3, r1: radius * 1.2, life: 0.45, color, thickness: 0.18, face: 'camera' });
    this.rings.add({ x, y: y - 0.2, z, r0: 0.3, r1: radius * 1.5, life: 0.6, color, thickness: 0.08, face: 'up' });
  }

  /** Enemy death: fractured geometric shards in the archetype colour. */
  shatter(x, y, z, type, elite) {
    const P = this.palette;
    const color = elite ? P.amber : type === 2 ? P.violet : type === 5 ? P.cyan : type === 1 ? P.amber : P.enemy;
    const big = type === 6 ? 4 : type === 1 ? 2 : 1;
    this.particles.burst(x, y, z, 26 * big, 9 * Math.sqrt(big), color, 8, 0.9, { gravity: 10, drag: 1.2, up: 2 });
    this.particles.burst(x, y, z, 8 * big, 4, P.white, 5, 0.4, { gravity: 0, drag: 4 });
    this.rings.add({ x, y, z, r0: 0.2, r1: 2.5 * big, life: 0.4, color, thickness: 0.1, face: 'camera' });
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  beginFrame(dt, time) {
    this.time = time;
    this.renderer.info.reset();
    this.ribbons.begin(dt);
  }

  setCamera(x, y, z, yaw, pitch, fov) {
    const sh = this.shake.out;
    this.camera.position.set(x + sh.x * Math.cos(yaw), y + sh.y, z - sh.x * Math.sin(yaw));
    this.camera.rotation.set(pitch + sh.y * 0.3, yaw + sh.x * 0.3, sh.roll);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Update animated materials and pools, then draw. */
  render(dt, post) {
    const t = this.time;
    this.shake.update(dt);
    this.particles.update(dt);
    this.rings.update(dt, t, this.camera);
    this.ribbons.end();
    if (this.arenaFillMat) this.arenaFillMat.uniforms.uTime.value = t;
    if (this.edgeMats) for (const m of this.edgeMats) m.uniforms.uTime.value = t;
    if (this.skyMat) this.skyMat.uniforms.uTime.value = t;
    if (this.decorMat) this.decorMat.uniforms.uTime.value = t;
    if (this.flowMats) for (const m of this.flowMats) m.uniforms.uTime.value = t;
    if (this.phaseMat) { this.phaseMat.uniforms.uTime.value = t; this.phaseMat.uniforms.uOpen.value = post.phase; }
    if (this.ringMeshes) for (const r of this.ringMeshes) r.rotation.z = t * 0.8;
    if (this.reactorRings) this.reactorRings.forEach((r, i) => { r.rotation.x = Math.PI / 2 + Math.sin(t * 0.7 + i) * 0.25; r.rotation.z = t * (0.6 + i * 0.25); });
    if (this.reactorCore) this.reactorCore.material.uniforms.uColor.value.copy(this.palette.amber).lerp(this.palette.danger, 1 - (post.reactor ?? 1));

    const r = this.renderer;
    const usePost = this.settings.postFx;
    if (usePost) {
      const u = this.postMat.uniforms;
      const reduce = this.settings.reducedFlashes ? 0.35 : 1;
      u.uTime.value = t;
      u.uCA.value = this.settings.chromatic ? 1 : 0;
      u.uDamage.value = post.damage * reduce;
      u.uPhase.value = post.phase;
      u.uLowHealth.value = post.lowHealth;
      u.uPulse.value = this.settings.chromatic ? post.pulse * reduce : 0;
      u.uFlash.value = post.flash * reduce;
      u.uGrain.value = this.settings.quality === 'low' ? 0.03 : 0.055;
      u.uPhaseColor.value.copy(this.palette.violet);
      u.uDamageColor.value.copy(this.palette.danger);
      r.setRenderTarget(this.rt);
    } else {
      r.setRenderTarget(null);
    }
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.vmScene, this.vmCamera);
    if (usePost) {
      r.setRenderTarget(null);
      r.render(this.postScene, this.postCam);
    }
  }

  /** Draw-call and memory statistics for the debug overlay. */
  stats() {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, particles: this.particles.count };
  }

  /** Reset per-match transient state. */
  clearTransient() {
    this.particles.clear();
    this.ribbons.clear();
    this.rings.clear();
    for (const v of this.playerVisuals) v.grp.visible = false;
    for (const em of this.enemyMeshes) if (em) { em.mesh.count = 0; em.outline.count = 0; }
    this.projMesh.count = 0;
    this.pickupMesh.count = 0;
    this.titan.visible = false;
  }
}

export { SLOT_COLORS };
