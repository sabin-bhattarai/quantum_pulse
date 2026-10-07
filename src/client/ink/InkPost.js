/**
 * Quantum Pulse — ink post-processing.
 *
 * Pipeline per frame:
 *   1. world colour + depth  -> colorRT (depthTexture attached)
 *   2. world normals         -> normalRT (scene.overrideMaterial = MeshNormalMaterial,
 *                               effects/sky hidden so they never get outlined)
 *   3. composite to screen: ink edges + print effects
 *
 * INK EDGES — what the math does:
 *   - Depth: w = 1 / viewDepth is affine in screen space for planar surfaces,
 *     so its discrete Laplacian (w₊ + w₋ − 2w₀ along x and y) is ~0 across any
 *     flat face, no matter how steep or far away, and spikes at silhouettes and
 *     depth creases. Dividing by w₀ makes the test scale-free.
 *   - Normals: 1 − dot(n₀, nᵢ) against four neighbours catches creases between
 *     faces at similar depth (box edges facing the camera).
 *   Why: geometry-based outlines (line meshes, inverted hulls) are 1 px thin in
 *   WebGL or break on boxes; a screen-space pass gives every object the same
 *   thick, hand-inked line.
 *   Assumptions: perspective camera, depth texture from the same render.
 *   Limits: thickness 1–3 px scaled by resolution; lines fade out with distance
 *   so far geometry does not turn into ink soup; the normal pass is skipped on
 *   the Low preset (depth-only edges).
 *   If modified: using first-order depth differences instead of the Laplacian
 *   draws false lines on floors seen at grazing angles.
 *
 * PRINT EFFECTS: colour-plate misregistration (instead of chromatic
 * aberration), paper grain and vignette, red halftone damage vignette, Phase
 * Break ripple + blue tint, low-health sepia, and radial speed lines.
 */
import * as THREE from '/vendor/three/three.module.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uThickness;
uniform float uUseNormals;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uDamageColor;
uniform vec3 uPhaseColor;
uniform float uTime;
uniform float uMisreg;
uniform float uVignette;
uniform float uGrain;
uniform float uDamage;
uniform float uPhase;
uniform float uLowHealth;
uniform float uPulse;
uniform float uFlash;
uniform float uSpeed;
uniform float uAspect;
varying vec2 vUv;

float invDepth(vec2 uv) {
  float vz = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
  return 1.0 / max(vz, 1e-3);
}
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0));
  // Phase Break / pulse ripple
  uv += c * uPhase * 0.016 * sin(uTime * 9.0 + r2 * 40.0);
  uv += c * uPulse * 0.035 * sin(r2 * 30.0 - uTime * 20.0);

  // Colour-plate misregistration: magenta and cyan plates slip slightly.
  vec2 mis = vec2(0.0011, -0.0007) * (uMisreg + uPulse * 3.0 + uPhase * 2.0);
  vec3 col;
  col.r = texture2D(tColor, uv + mis).r;
  col.g = texture2D(tColor, uv).g;
  col.b = texture2D(tColor, uv - mis).b;

  // ---- ink edges ----
  float w0 = invDepth(uv);
  float vz0 = 1.0 / w0;
  // a gentle per-pixel wobble so lines look hand-drawn rather than ruled
  float wob = 0.85 + 0.3 * hash(floor(uv * vec2(160.0, 90.0)));
  float thick = uThickness * wob * mix(1.0, 0.55, smoothstep(25.0, 90.0, vz0));
  vec2 ox = vec2(uTexel.x * thick, 0.0), oy = vec2(0.0, uTexel.y * thick);
  float wl = invDepth(uv - ox), wr = invDepth(uv + ox), wd = invDepth(uv - oy), wu = invDepth(uv + oy);
  float lap = (abs(wl + wr - 2.0 * w0) + abs(wd + wu - 2.0 * w0)) / w0;
  float edge = smoothstep(0.035, 0.09, lap);
  if (uUseNormals > 0.5) {
    vec3 n0 = nrm(uv);
    float nd = max(max(1.0 - dot(n0, nrm(uv - ox)), 1.0 - dot(n0, nrm(uv + ox))), max(1.0 - dot(n0, nrm(uv - oy)), 1.0 - dot(n0, nrm(uv + oy))));
    edge = max(edge, smoothstep(0.22, 0.45, nd));
  }
  edge *= 1.0 - smoothstep(70.0, 160.0, vz0) * 0.75;
  col = mix(col, uInk, clamp(edge, 0.0, 1.0));

  // ---- print effects ----
  // Low health: drift toward sepia newsprint.
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l) * vec3(1.05, 0.92, 0.78), uLowHealth * 0.55);
  // Phase Break: cool blue print tint
  col = mix(col, col * 0.65 + uPhaseColor * 0.35, uPhase * 0.5);
  // Damage: red halftone dots crowding in from the edges
  vec2 dp = gl_FragCoord.xy / 7.0;
  dp = vec2(dp.x + dp.y, dp.y - dp.x) * 0.7071;
  float dotR = smoothstep(0.12, 0.42, r2) * uDamage * 0.75;
  float dmgDot = 1.0 - smoothstep(dotR - 0.05, dotR + 0.05, length(fract(dp) - 0.5));
  col = mix(col, uDamageColor, dmgDot * step(0.02, dotR));
  // Speed lines
  if (uSpeed > 0.01) {
    float ang = atan(c.y, c.x * uAspect);
    float id = floor(ang * 34.0);
    float lineOn = step(0.62, hash(vec2(id, floor(uTime * 12.0))));
    float band = abs(fract(ang * 34.0) - 0.5);
    float lineMask = lineOn * (1.0 - smoothstep(0.05, 0.12, band)) * smoothstep(0.12, 0.3, r2);
    col = mix(col, uInk, lineMask * uSpeed * 0.55);
  }
  col += uPaper * uFlash * 0.25;
  // Paper: grain + ink vignette
  col *= 1.0 - (hash(gl_FragCoord.xy + fract(uTime) * 61.0) * uGrain);
  col = mix(col, uInk, smoothstep(0.22, 0.75, r2) * uVignette);
  gl_FragColor = vec4(col, 1.0);
}`;

export class InkPost {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    const depthTexture = new THREE.DepthTexture(4, 4);
    depthTexture.type = THREE.UnsignedIntType;
    this.colorRT = new THREE.WebGLRenderTarget(4, 4, { depthTexture, depthBuffer: true });
    this.normalRT = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
    this.normalMat = new THREE.MeshNormalMaterial();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tColor: { value: this.colorRT.texture }, tDepth: { value: depthTexture }, tNormal: { value: this.normalRT.texture },
        uTexel: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 600 }, uThickness: { value: 1.6 },
        uUseNormals: { value: 1 }, uInk: { value: new THREE.Color(0x16130f) }, uPaper: { value: new THREE.Color(0xefe6d2) },
        uDamageColor: { value: new THREE.Color(0xe63b2e) }, uPhaseColor: { value: new THREE.Color(0x2457c5) },
        uTime: { value: 0 }, uMisreg: { value: 1 }, uVignette: { value: 0.35 }, uGrain: { value: 0.05 }, uDamage: { value: 0 },
        uPhase: { value: 0 }, uLowHealth: { value: 0 }, uPulse: { value: 0 }, uFlash: { value: 0 }, uSpeed: { value: 0 }, uAspect: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.clearNormal = new THREE.Color(0.5, 0.5, 1.0);
    this.tmpColor = new THREE.Color();
  }

  setSize(w, h, aspect) {
    this.colorRT.setSize(w, h);
    this.normalRT.setSize(w, h);
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.material.uniforms.uAspect.value = aspect;
    // Lines ~2.2 px at 720p, ~3.2 px at 1440p.
    this.material.uniforms.uThickness.value = Math.max(1.2, Math.min(3.2, h / 330));
  }

  /**
   * Render the world into the colour/depth and normal targets.
   * @param {THREE.Object3D[]} noEdge objects hidden during the normal pass
   */
  renderWorld(scene, camera, noEdge, useNormals) {
    const r = this.renderer;
    r.getClearColor(this.tmpColor);
    const alpha = r.getClearAlpha();
    r.setRenderTarget(this.colorRT);
    r.clear(true, true, false);
    r.render(scene, camera);
    if (useNormals) {
      for (const o of noEdge) o.userData.wasVisible = o.visible, o.visible = false;
      const fog = scene.fog;
      scene.fog = null;
      scene.overrideMaterial = this.normalMat;
      r.setRenderTarget(this.normalRT);
      r.setClearColor(this.clearNormal, 1);
      r.clear(true, true, false);
      r.render(scene, camera);
      scene.overrideMaterial = null;
      scene.fog = fog;
      r.setClearColor(this.tmpColor, alpha);
      for (const o of noEdge) o.visible = o.userData.wasVisible;
    }
    const u = this.material.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uUseNormals.value = useNormals ? 1 : 0;
  }

  /** Composite to the screen (or the current target). */
  composite() {
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
