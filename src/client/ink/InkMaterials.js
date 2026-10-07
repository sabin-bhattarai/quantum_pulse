/**
 * Quantum Pulse — "Ink Comic" materials.
 *
 * All lit surfaces use Three.js MeshToonMaterial (so they get real lights,
 * shadows, fog and instancing for free) with two additions injected through
 * onBeforeCompile:
 *
 *  1. HALFTONE SHADING. After lighting, `shade = 1 - lum(lit) / lum(albedo)`
 *     measures how much light a fragment lost. Where it is darker than a
 *     threshold, a screen-space Ben-Day dot grid (rotated 45°, dot radius
 *     proportional to shade) darkens the surface, so shadows read as printed
 *     dots instead of smooth gradients. Dots are in screen space on purpose:
 *     printed comics have a fixed dot screen regardless of the drawn object.
 *  2. PANEL LINES (arena only). Thin ink seams every PANEL_SIZE metres on
 *     upward-facing surfaces, computed from world position, give floors scale
 *     and readability without textures.
 *
 * Lighting calibration: with colour management disabled, a light of
 * intensity I contributes albedo · I / π. The scene uses sun = 0.6π and
 * ambient = 0.4π, so a fully lit face shows exactly its authored colour.
 *
 * LIMITS: dot size scales with device pixel ratio and render scale; the
 * halftone is skipped entirely on the Low preset.
 * IF MODIFIED: changing the light calibration shifts every authored colour.
 */
import * as THREE from '/vendor/three/three.module.js';

/** Uniforms shared by every ink material (updated by the renderer). */
export const INK_UNIFORMS = {
  uDotScale: { value: 5.0 },
  uHalftone: { value: 1.0 },
  uInk: { value: new THREE.Color(0x16130f) },
};

export const LIGHT = Object.freeze({ SUN: 0.6 * Math.PI, AMBIENT: 0.4 * Math.PI });

let gradientMap = null;
/** Two-tone toon ramp: shadow side at 35% sun, lit side at 100%. */
export function toonRamp() {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([90, 90, 90, 255, 255, 255, 255, 255]);
  gradientMap = new THREE.DataTexture(data, 2, 1, THREE.RGBAFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

const HALFTONE_GLSL = /* glsl */`
  {
    float qpLit = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
    float qpAlb = max(0.02, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)));
    float qpShade = clamp(1.0 - qpLit / qpAlb, 0.0, 1.0);
    vec2 qpP = gl_FragCoord.xy / uDotScale;
    qpP = vec2(qpP.x + qpP.y, qpP.y - qpP.x) * 0.7071;
    float qpD = length(fract(qpP) - 0.5);
    float qpR = qpShade * 0.62;
    float qpDot = 1.0 - smoothstep(qpR - 0.06, qpR + 0.06, qpD);
    outgoingLight = mix(outgoingLight, outgoingLight * 0.42, qpDot * step(0.18, qpShade) * uHalftone);
  }
`;

const PANEL_GLSL = /* glsl */`
  {
    vec3 qpN = normalize(vQpWorldNormal);
    if (qpN.y > 0.6) {
      vec2 qpG = abs(fract(vQpWorld.xz / QP_PANEL_SIZE) - 0.5);
      float qpLine = 1.0 - smoothstep(0.0, 0.012, 0.5 - max(qpG.x, qpG.y));
      outgoingLight = mix(outgoingLight, uInk * 0.9 + outgoingLight * 0.25, qpLine * 0.55);
    }
  }
`;

/**
 * Create an ink toon material.
 * @param {object} o
 * @param {number|THREE.Color} [o.color]
 * @param {boolean} [o.vertexColors]
 * @param {boolean} [o.panels] draw floor panel seams (arena geometry)
 * @param {number} [o.panelSize]
 * @param {number|THREE.Color} [o.emissive]
 * @param {boolean} [o.transparent]
 * @param {number} [o.opacity]
 */
export function inkMaterial(o = {}) {
  const m = new THREE.MeshToonMaterial({
    color: o.color ?? 0xffffff,
    gradientMap: toonRamp(),
    vertexColors: !!o.vertexColors,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
    emissive: o.emissive ?? 0x000000,
  });
  const panels = !!o.panels;
  const panelSize = (o.panelSize || 4).toFixed(2);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDotScale = INK_UNIFORMS.uDotScale;
    shader.uniforms.uHalftone = INK_UNIFORMS.uHalftone;
    shader.uniforms.uInk = INK_UNIFORMS.uInk;
    if (panels) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vQpWorld;\nvarying vec3 vQpWorldNormal;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvQpWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvQpWorldNormal = mat3(modelMatrix) * objectNormal;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uDotScale;\nuniform float uHalftone;\nuniform vec3 uInk;${panels ? '\nvarying vec3 vQpWorld;\nvarying vec3 vQpWorldNormal;' : ''}`)
      .replace('#include <opaque_fragment>', `${HALFTONE_GLSL}${panels ? PANEL_GLSL.replace('QP_PANEL_SIZE', panelSize) : ''}\n#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `ink-${panels ? `p${panelSize}` : 'n'}`;
  return m;
}

/** Flat unlit colour (glows, eyes, signage) that still respects fog. */
export function flatMaterial(color, o = {}) {
  return new THREE.MeshBasicMaterial({ color, transparent: !!o.transparent, opacity: o.opacity ?? 1, depthWrite: o.depthWrite ?? true, side: o.side ?? THREE.FrontSide, fog: o.fog ?? true });
}

/** Inverted-hull outline (used where the screen-space edge pass is unavailable, e.g. the viewmodel). */
export function hullOutline(width = 0.02, color = 0x16130f) {
  return new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: width }, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */`
      uniform float uWidth;
      void main() {
        vec3 p = position + normal * uWidth;
        #ifdef USE_INSTANCING
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        #else
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        #endif
      }`,
    fragmentShader: /* glsl */`uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
  });
}
