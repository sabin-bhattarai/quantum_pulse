/**
 * Quantum Pulse — renderer ("Ink Comic" art direction).
 *
 * Orchestrates the cel-shaded world (client/ink/WorldBuilder.js), the
 * screen-space ink outline + print post pass (client/ink/InkPost.js),
 * procedural characters (client/ink/Characters.js), enemy silhouettes
 * (client/ink/EnemyModels.js) and pooled effects (client/Effects.js,
 * client/Particles.js). Everything is procedural; fonts are the only assets.
 *
 * Performance rules: instanced enemies/projectiles/pickups, pooled effects,
 * no per-frame allocation in draw paths, quality presets that scale pixel
 * ratio, shadows, the normal (crease) pass and halftone shading.
 */
import * as THREE from '/vendor/three/three.module.js';
import { ParticleSystem } from '/client/Particles.js';
import { RibbonPool, RingPool, FractureFx, ScreenShake, RingStyle } from '/client/Effects.js';
import { WEAPONS } from '/shared/weapons.js';
import { PF, EF, PK, PICKUP } from '/shared/protocol.js';
import { ROGUE, rogueName, MoveState } from '/shared/constants.js';
import { inkMaterial, flatMaterial, hullOutline, INK_UNIFORMS, LIGHT } from '/client/ink/InkMaterials.js';
import { InkPost } from '/client/ink/InkPost.js';
import { buildWorld, signTexture } from '/client/ink/WorldBuilder.js';
import { RunnerRig } from '/client/ink/Characters.js';
import { enemyModel, ENEMY_TINTS, ELITE_TINT } from '/client/ink/EnemyModels.js';

// Shaders output display-ready colours; hex values are used exactly as authored.
THREE.ColorManagement.enabled = false;

/** Effect palette. Keys are semantic (historical names kept for callers). */
export const PALETTES = Object.freeze({
  normal: { neutral: 0xefe6d2, cyan: 0x2f6fd0, magenta: 0xe0473a, violet: 0x2457c5, amber: 0xf2c230, mint: 0x2a9d8f, danger: 0xe63b2e, enemy: 0x8e5bd1, white: 0xfffaf0, ink: 0x16130f },
  colorblind: { neutral: 0xefe6d2, cyan: 0x0072b2, magenta: 0xd55e00, violet: 0x0072b2, amber: 0xf0e442, mint: 0x009e73, danger: 0xd55e00, enemy: 0xcc79a7, white: 0xfffaf0, ink: 0x16130f },
});

/** Team / slot colours: bold print inks that read against concrete and sky. */
/** Rogue Runner tag colour (red = hostile); armour comes from ENEMY_TINTS[8]. */
const ROGUE_TAG = 0xe63b2e;
const SLOT_COLORS = [0xe0473a, 0x2f6fd0, 0xf2c230, 0x2a9d8f, 0xf07f2a, 0x7b4fc9, 0xe86fae, 0x8cc63f, 0x3ec7d6, 0x9a6a43, 0xf4efe1, 0x5b6170];

const QUALITY = {
  high: { pixelRatio: 2, shadows: true, shadowEvery: 1, normals: true, halftone: 1 },
  medium: { pixelRatio: 1.25, shadows: true, shadowEvery: 2, normals: true, halftone: 1 },
  low: { pixelRatio: 1, shadows: false, shadowEvery: 0, normals: false, halftone: 0 },
};

const ONOMATOPOEIA = ['POW!', 'KRAK!', 'ZAP!', 'BOOM!', 'WHAM!', 'SKREE!'];

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

function xf(geo, { px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
  return geo;
}

/** Comic starburst texture, optionally with lettering. */
function burstTexture(text, fill = '#f2c230', size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const R = size / 2;
  g.translate(R, R);
  g.beginPath();
  const spikes = 13;
  for (let i = 0; i < spikes * 2; i++) {
    const r = (i % 2 ? 0.55 : 0.95) * (R - 10) * (0.9 + ((i * 37) % 7) / 40);
    const a = (i / (spikes * 2)) * Math.PI * 2;
    if (i) g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = size / 28;
  g.strokeStyle = '#16130f';
  g.stroke();
  if (text) {
    g.rotate(-0.12);
    g.font = `${Math.round(size * 0.26)}px "Anton", Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = size / 22;
    g.strokeStyle = '#16130f';
    g.strokeText(text, 0, 4);
    g.fillStyle = '#e63b2e';
    g.fillText(text, 0, 4);
  }
  return new THREE.CanvasTexture(c);
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _c = new THREE.Color();
const _tint = new THREE.Color();

/* ------------------------------------------------------------------------ */
/* Renderer                                                                  */
/* ------------------------------------------------------------------------ */

export class Renderer {
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false; // several passes per frame
    this.renderer.setClearColor(0x16130f, 1);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.05, 700);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight(0xfff4dc, 0x6b5a48, LIGHT.AMBIENT * 1.1));
    const vmSun = new THREE.DirectionalLight(0xfff2cf, LIGHT.SUN);
    vmSun.position.set(0.6, 1, 0.4);
    this.vmScene.add(vmSun);

    this.post = new InkPost(this.renderer);
    this.palette = {};
    this.time = 0;
    this.frame = 0;
    this.world = null;
    this.arena = null;
    this.noEdge = [];

    this.particles = new ParticleSystem(this.scene, settings.particles);
    this.ribbons = new RibbonPool(this.scene, 1024);
    this.rings = new RingPool(this.scene, 128);
    this.fractureFx = new FractureFx(this.scene, 24);
    this.shake = new ScreenShake();

    this.buildEnemyMeshes();
    this.buildProjectileMeshes();
    this.buildBursts();
    this.rigs = [];
    this.rogueRigs = [];
    this.buildViewmodels();

    this.applySettings();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Objects excluded from the ink normal pass (effects, glows, sprites). */
  effectObjects() {
    const list = [this.ribbons.mesh, this.rings.mesh, this.fractureFx.mesh, this.projMesh, this.shieldMesh, ...this.burstSprites];
    if (this.particles.points) list.push(this.particles.points);
    for (const em of this.enemyMeshes) if (em) list.push(em.eyes);
    return list;
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
    this.renderer.shadowMap.enabled = this.q.shadows;
    INK_UNIFORMS.uHalftone.value = this.q.halftone;
    this.shake.enabled = s.screenShake && !s.reducedFlashes;
    this.particles.setQuality(s.particles);
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    if (this.arena) this.buildArena(this.arena);
    else this.noEdge = this.effectObjects();
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
    this.post.setSize(rw, rh, w / h);
    INK_UNIFORMS.uDotScale.value = Math.max(3, 4.6 * pr * scale);
    this.particles.setViewportHeight(h * pr);
  }

  /* ---------------------------------------------------------------- */
  /* arena                                                             */
  /* ---------------------------------------------------------------- */

  disposeArena() {
    if (!this.world) return;
    this.scene.remove(this.world.group);
    this.world.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
    });
    this.world = null;
  }

  /** Build all static arena visuals for the client's copy of the arena. */
  buildArena(arena) {
    this.disposeArena();
    this.arena = arena;
    this.world = buildWorld(arena, { quality: this.settings.quality, shadows: this.q.shadows });
    this.scene.add(this.world.group);
    this.scene.fog = this.world.fog;
    this.noEdge = [...this.world.noEdge, ...this.effectObjects()];
    for (const r of this.rigs) if (r && r.tag) this.noEdge.push(r.tag);
    this.renderer.shadowMap.needsUpdate = true;
  }

  setDestroyedProps(destroyedIds) {
    if (!this.world) return;
    let changed = false;
    for (const [id, m] of this.world.propMeshes) {
      const vis = !destroyedIds.includes(id);
      if (m.visible !== vis) { m.visible = vis; changed = true; }
    }
    if (changed) this.renderer.shadowMap.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- */
  /* players                                                           */
  /* ---------------------------------------------------------------- */

  rigFor(i) {
    let r = this.rigs[i];
    if (!r) {
      r = new RunnerRig(SLOT_COLORS[i % SLOT_COLORS.length], { shadows: this.q.shadows });
      Object.assign(r, { lastX: 0, lastY: 0, lastZ: 0, speed: 0, forward: 0, name: '', tag: null, slot: -1 });
      r.root.visible = false;
      this.scene.add(r.root);
      this.rigs[i] = r;
    }
    return r;
  }

  setNameTag(r, name, color) {
    if (r.name === name && r.tag) return;
    if (r.tag) {
      r.root.remove(r.tag);
      r.tag.material.map.dispose();
      r.tag.material.dispose();
      this.noEdge = this.noEdge.filter((o) => o !== r.tag);
    }
    const light = color === 0xf2c230 || color === 0xf4efe1 || color === 0x8cc63f || color === 0x3ec7d6;
    const { tex, aspect } = signTexture(name, `#${color.toString(16).padStart(6, '0')}`, light ? '#16130f' : '#efe6d2');
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(0.42 * aspect, 0.42, 1);
    sp.position.y = 2.35;
    r.root.add(sp);
    r.tag = sp;
    r.name = name;
    this.noEdge.push(sp);
  }

  /**
   * Draw remote players as animated runner rigs.
   * @param {Map<number, object>} players interpolated render objects (raw = snapshot row)
   */
  drawPlayers(players, localId, names, camPos) {
    const dt = Math.max(1e-3, this.frameDt || 1 / 60);
    let i = 0;
    for (const [id, o] of players) {
      if (id === localId) continue;
      const r = this.rigFor(i++);
      const raw = o.raw;
      const flags = raw[7];
      const slot = raw[14] % SLOT_COLORS.length;
      if (r.slot !== slot) { r.setTeamColor(SLOT_COLORS[slot]); r.slot = slot; r.name = ''; }
      r.root.visible = !(flags & PF.DEAD);
      if (!r.root.visible) continue;
      // velocity estimate from interpolated motion (smoothed)
      const dx = o.x - r.lastX, dz = o.z - r.lastZ;
      const teleport = Math.hypot(dx, dz) > 3;
      r.lastX = o.x; r.lastY = o.y; r.lastZ = o.z;
      if (!teleport) {
        const k = Math.min(1, dt * 12);
        r.speed += (Math.min(16, Math.hypot(dx, dz) / dt) - r.speed) * k;
        r.forward += (-(dx * Math.sin(o.yaw) + dz * Math.cos(o.yaw)) / dt - r.forward) * k;
      }
      r.root.position.set(o.x, o.y, o.z);
      r.root.rotation.y = o.yaw;
      r.animate(dt, {
        speed: r.speed, forward: r.forward, state: raw[6], pitch: raw[5],
        downed: !!(flags & PF.DOWNED), grappling: !!(flags & PF.GRAPPLING), sliding: !!(flags & PF.SLIDING),
      });
      const phased = flags & PF.PHASED, prot = flags & PF.PROTECTED;
      r.setOpacity(phased ? 0.4 + Math.sin(this.time * 30) * 0.1 : prot ? (Math.sin(this.time * 22) > 0 ? 1 : 0.55) : 1);
      this.setNameTag(r, names.get(id) || 'Runner', SLOT_COLORS[slot]);
      const dist = camPos ? Math.hypot(o.x - camPos.x, o.z - camPos.z) : 0;
      r.tag.visible = dist < 55; // LOD: name tags only up close
      r.tag.material.depthTest = !(flags & PF.REVEALED); // anti-stall reveal: visible through walls
      if (flags & PF.GRAPPLING) this.rope(o.x, o.y + 1.5, o.z, raw[10], raw[11], raw[12], this.palette.ink, 0.05);
    }
    for (; i < this.rigs.length; i++) if (this.rigs[i]) this.rigs[i].root.visible = false;
  }

  /**
   * Rogue Runners use the same rig as multiplayer runners, in rift violet
   * (gold when elite), with a red callsign tag. Animation comes from the
   * movement state and aim pitch carried in their snapshot row.
   */
  drawRogue(i, id, o, flags, hitFlash) {
    let r = this.rogueRigs[i];
    if (!r) {
      r = new RunnerRig(ENEMY_TINTS[8], { shadows: this.q.shadows });
      Object.assign(r, { id: -1, lastX: 0, lastZ: 0, speed: 0, forward: 0, name: '', tag: null, tint: -1 });
      this.scene.add(r.root);
      this.rogueRigs[i] = r;
    }
    const raw = o.raw;
    const dt = Math.max(1e-3, this.frameDt || 1 / 60);
    if (r.id !== id) { r.id = id; r.lastX = o.x; r.lastZ = o.z; r.speed = 0; r.forward = 0; }
    r.root.visible = true;
    const dx = o.x - r.lastX, dz = o.z - r.lastZ;
    r.lastX = o.x; r.lastZ = o.z;
    if (Math.hypot(dx, dz) < 3) {
      const k = Math.min(1, dt * 12);
      r.speed += (Math.min(16, Math.hypot(dx, dz) / dt) - r.speed) * k;
      r.forward += (-(dx * Math.sin(o.yaw) + dz * Math.cos(o.yaw)) / dt - r.forward) * k;
    }
    r.root.position.set(o.x, o.y - ROGUE.CENTER, o.z);
    r.root.rotation.y = o.yaw;
    const flash = this.time - (hitFlash.get(id) || -10) < 0.07;
    const tint = flash ? 0xffffff : flags & EF.ELITE ? ELITE_TINT : ENEMY_TINTS[8];
    if (r.tint !== tint) { r.setTeamColor(tint); r.tint = tint; }
    const state = flags & EF.STUNNED ? MoveState.STUNNED : raw[9] ?? MoveState.GROUNDED;
    r.animate(dt, { speed: r.speed, forward: r.forward, state, pitch: raw[10] ?? 0, downed: false, grappling: false, sliding: state === MoveState.SLIDING });
    this.setNameTag(r, rogueName(id), ROGUE_TAG);
    r.tag.visible = Math.hypot(o.x - this.camera.position.x, o.z - this.camera.position.z) < 45;
  }

  /** Multi-segment animated rope / tether ribbon (ink-outlined). */
  rope(ax, ay, az, bx, by, bz, color, width, wave = 0.15, alpha = 1) {
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

  /* ---------------------------------------------------------------- */
  /* enemies                                                           */
  /* ---------------------------------------------------------------- */

  buildEnemyMeshes() {
    const caps = { 0: 96, 1: 24, 2: 24, 3: 24, 4: 32, 5: 24, 7: 12 };
    this.enemyMeshes = [];
    const bodyMat = inkMaterial({ vertexColors: true });
    const eyeMat = flatMaterial(0xf2c230, { fog: false });
    for (let type = 0; type < 8; type++) {
      const cap = caps[type];
      if (!cap) { this.enemyMeshes.push(null); continue; }
      const { body, eyes } = enemyModel(type);
      const mesh = new THREE.InstancedMesh(body, bodyMat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, _c.setRGB(1, 1, 1));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      const eyeMesh = new THREE.InstancedMesh(eyes, type === 7 ? flatMaterial(0xe63b2e) : eyeMat, cap);
      eyeMesh.instanceMatrix = mesh.instanceMatrix;
      eyeMesh.count = 0;
      eyeMesh.frustumCulled = false;
      this.scene.add(mesh, eyeMesh);
      this.enemyMeshes.push({ mesh, eyes: eyeMesh, cap });
    }
    // Singularity Titan: dedicated multi-part boss.
    const titan = new THREE.Group();
    this.titanBodyMat = inkMaterial({ color: 0x4b3a78 });
    const plate = inkMaterial({ color: 0x2b2148 });
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 1), this.titanBodyMat);
    body.castShadow = true;
    titan.add(body);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 5), plate);
      spike.position.set(Math.cos(a) * 3.1, Math.sin(a * 2) * 0.6, Math.sin(a) * 3.1);
      spike.lookAt(spike.position.clone().multiplyScalar(2));
      spike.rotateX(Math.PI / 2);
      spike.castShadow = true;
      titan.add(spike);
    }
    this.titanRings = [];
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.8 + i * 1.1, 0.25, 8, 48), inkMaterial({ color: i ? 0xe0473a : 0xf2c230 }));
      ring.castShadow = true;
      titan.add(ring);
      this.titanRings.push(ring);
    }
    this.titanCoreMat = flatMaterial(0xf2c230, { fog: false });
    this.titanCore = new THREE.Mesh(new THREE.SphereGeometry(1.25, 20, 14), this.titanCoreMat);
    this.titanCore.position.set(0, 0, -3.1);
    titan.add(this.titanCore);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), flatMaterial(0x16130f));
    pupil.position.set(0, 0, -0.95);
    this.titanCore.add(pupil);
    titan.visible = false;
    this.titan = titan;
    this.scene.add(titan);
    // Rift Caster shield bubbles
    this.shieldMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), flatMaterial(0x2f6fd0, { transparent: true, opacity: 0.28, depthWrite: false }), 48);
    this.shieldMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shieldMesh.count = 0;
    this.shieldMesh.frustumCulled = false;
    this.scene.add(this.shieldMesh);
  }

  drawEnemies(enemies, hitFlash) {
    const P = this.palette;
    const counts = [0, 0, 0, 0, 0, 0, 0, 0];
    let shields = 0;
    let titanSeen = false;
    let rogues = 0;
    for (const [id, o] of enemies) {
      const r = o.raw;
      const type = r[1];
      const flags = r[8];
      if (type === 8) { this.drawRogue(rogues++, id, o, flags, hitFlash); continue; }
      if (type === 6) {
        titanSeen = true;
        this.titan.visible = true;
        this.titan.position.set(o.x, o.y, o.z);
        this.titan.rotation.y = o.yaw;
        const open = flags & EF.WEAKPOINT_OPEN;
        this.titanCore.scale.setScalar(open ? 1.3 + Math.sin(this.time * 12) * 0.15 : 1);
        this.titanCoreMat.color.copy(open ? P.white : P.amber);
        this.titanRings.forEach((ring, k) => ring.rotation.set(this.time * (0.5 + k * 0.3), this.time * (0.7 - k * 0.2), k));
        const flash = this.time - (hitFlash.get(id) || -10) < 0.08;
        this.titanBodyMat.color.setHex(flash ? 0xffffff : flags & EF.TELEGRAPH && Math.sin(this.time * 25) > 0 ? 0xe63b2e : 0x4b3a78);
        continue;
      }
      const em = this.enemyMeshes[type];
      if (!em) continue;
      const n = counts[type];
      if (n >= em.cap) continue;
      let scale = flags & EF.ELITE ? 1.25 : 1;
      if (flags & EF.CLOAKED) scale = 0.0001;
      const telegraph = flags & EF.TELEGRAPH;
      const spin = type === 3 || type === 5 ? this.time * 1.5 : 0;
      _e.set(type === 0 ? Math.sin(this.time * 9 + id) * 0.15 : 0, o.yaw + spin, type === 0 ? Math.sin(this.time * 10 + id) * 0.25 : 0);
      _q.setFromEuler(_e);
      const bob = type === 3 ? Math.sin(this.time * 2 + id) * 0.15 : 0;
      _m4.compose(_v.set(o.x, o.y + bob, o.z), _q, _s.set(scale, scale, scale));
      em.mesh.setMatrixAt(n, _m4);
      _tint.setHex(ENEMY_TINTS[type] ?? 0x8e5bd1);
      if (flags & EF.ELITE) _tint.lerp(_c.setHex(ELITE_TINT), 0.65);
      if (telegraph && Math.sin(this.time * 25) > 0) _tint.setHex(0xe63b2e);
      if (flags & EF.STUNNED) _tint.lerp(P.white, 0.35 + 0.25 * Math.sin(this.time * 40));
      if (this.time - (hitFlash.get(id) || -10) < 0.07) _tint.setRGB(1.6, 1.6, 1.6);
      em.mesh.setColorAt(n, _tint);
      counts[type] = n + 1;
      if ((flags & EF.SHIELDED) && shields < 48) {
        const sr = (type === 1 ? 2.3 : 1.3) * scale;
        _m4.compose(_v.set(o.x, o.y, o.z), _q.identity(), _s.set(sr, sr, sr));
        this.shieldMesh.setMatrixAt(shields++, _m4);
      }
      if (type === 2 && telegraph) this.particles.spawn(o.x + (Math.random() - 0.5), o.y + (Math.random() - 0.5) * 2, o.z + (Math.random() - 0.5), 0, 1, 0, P.violet, 4, 0.4);
    }
    if (!titanSeen) this.titan.visible = false;
    for (let i = rogues; i < this.rogueRigs.length; i++) this.rogueRigs[i].root.visible = false;
    for (let t = 0; t < this.enemyMeshes.length; t++) {
      const em = this.enemyMeshes[t];
      if (!em) continue;
      em.mesh.count = counts[t];
      em.eyes.count = counts[t];
      if (counts[t]) {
        em.mesh.instanceMatrix.needsUpdate = true;
        em.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.shieldMesh.count = shields;
    if (shields) this.shieldMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- */
  /* projectiles, pickups, hazards                                     */
  /* ---------------------------------------------------------------- */

  buildProjectileMeshes() {
    this.projMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), flatMaterial(0xffffff, { fog: false }), 1024);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.projMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.count = 0;
    this.projMesh.frustumCulled = false;
    this.scene.add(this.projMesh);

    this.pickupMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.38, 0), inkMaterial({ color: 0xffffff }), 64);
    this.pickupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pickupMesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.pickupMesh.count = 0;
    this.pickupMesh.frustumCulled = false;
    this.scene.add(this.pickupMesh);
  }

  /**
   * Projectiles. While the local player is phase-shifted, hostile projectiles
   * are drawn with delayed afterimages along their path (Phase Break telegraph).
   */
  drawProjectiles(projectiles, localPhased) {
    const P = this.palette;
    let n = 0;
    for (const [, o] of projectiles) {
      const r = o.raw;
      const kind = r[1];
      const hostile = kind === PK.ENEMY_BOLT || kind === PK.HEAVY_ORB || kind === PK.TITAN_ORB;
      const size = kind === PK.PELLET ? 0.1 : kind === PK.ORB ? 0.5 : kind === PK.HEAVY_ORB ? 0.5 : kind === PK.TITAN_ORB ? 0.6 : kind === PK.DEFLECTED ? 0.3 : 0.28;
      const color = kind === PK.PELLET ? P.magenta : kind === PK.ORB ? P.mint : kind === PK.DEFLECTED ? P.amber : hostile ? P.enemy : P.cyan;
      const ghosts = hostile && localPhased ? 4 : 1;
      for (let g = 0; g < ghosts && n < 1024; g++) {
        const lag = g * 0.09;
        const s = size * (1 - g * 0.18) * (kind === PK.ORB ? 1 + Math.sin(this.time * 14) * 0.15 : 1);
        _m4.compose(_v.set(o.x - r[5] * lag, o.y - r[6] * lag, o.z - r[7] * lag), _q.identity(), _s.set(s, s, s));
        this.projMesh.setMatrixAt(n, _m4);
        _c.copy(color);
        if (g > 0) _c.lerp(P.white, 0.5);
        this.projMesh.setColorAt(n, _c);
        n++;
      }
      const sp = Math.hypot(r[5], r[6], r[7]);
      if (sp > 1) {
        const k = Math.min(0.07, 1.4 / sp);
        this.ribbons.transient(o.x - r[5] * k, o.y - r[6] * k, o.z - r[7] * k, o.x, o.y, o.z, color.r, color.g, color.b, 1, size * 0.9);
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
      this.pickupMesh.setColorAt(n, kind === PICKUP.HEALTH ? P.mint : kind === PICKUP.PULSE ? P.amber : P.cyan);
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
      this.rings.transient({ x, y: y + 0.05, z, r, color: this.palette.danger, alpha: 0.85 * life, thickness: 1, style: RingStyle.PLAIN, face: 'up' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* comic onomatopoeia bursts                                          */
  /* ---------------------------------------------------------------- */

  buildBursts() {
    this.burstTextures = [burstTexture(''), burstTexture('', '#efe6d2'), ...ONOMATOPOEIA.map((w) => burstTexture(w)), burstTexture('HEADSHOT!', '#e63b2e')];
    this.headshotKind = this.burstTextures.length - 1;
    this.burstSprites = [];
    this.bursts = [];
    for (let i = 0; i < 24; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.burstTextures[0], transparent: true, depthWrite: false, fog: false }));
      sp.visible = false;
      sp.renderOrder = 8;
      this.scene.add(sp);
      this.burstSprites.push(sp);
      this.bursts.push({ sp, life: 0, max: 0, size: 1 });
    }
    this.burstCursor = 0;
  }

  /**
   * Pop a comic burst in the world.
   * @param {number} kind 0 = yellow star, 1 = paper star, 2+ = lettered word
   */
  burst(x, y, z, kind, size, life = 0.45) {
    if (this.settings.reducedFlashes && kind < 2) return;
    const b = this.bursts[this.burstCursor];
    this.burstCursor = (this.burstCursor + 1) % this.bursts.length;
    b.sp.material.map = this.burstTextures[Math.min(kind, this.burstTextures.length - 1)];
    b.sp.material.rotation = (Math.random() - 0.5) * 0.5;
    b.sp.position.set(x, y, z);
    b.sp.visible = true;
    b.life = life;
    b.max = life;
    b.size = size;
  }

  updateBursts(dt) {
    for (const b of this.bursts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.sp.visible = false; continue; }
      const t = 1 - b.life / b.max;
      const pop = t < 0.18 ? (t / 0.18) * 1.15 : 1.15 - (t - 0.18) * 0.25;
      b.sp.scale.setScalar(b.size * pop);
      b.sp.material.opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    }
  }

  /* ---------------------------------------------------------------- */
  /* viewmodel                                                         */
  /* ---------------------------------------------------------------- */

  buildViewmodels() {
    this.vmRoot = new THREE.Group();
    this.vmRoot.scale.setScalar(0.8);
    this.vmScene.add(this.vmRoot);
    const ink = hullOutline(0.012);
    const metal = inkMaterial({ color: 0x3a3f4d });
    const glove = inkMaterial({ color: 0xefe6d2 });
    const sleeve = inkMaterial({ color: 0x2b2f3a });
    const add = (grp, geo, mat, o) => {
      const m = new THREE.Mesh(xf(geo, o), mat);
      m.add(new THREE.Mesh(m.geometry, ink));
      grp.add(m);
      return m;
    };
    // gloved right hand + sleeve shared by every weapon
    const hand = new THREE.Group();
    add(hand, new THREE.BoxGeometry(0.11, 0.12, 0.14), glove, { py: -0.1, pz: 0.08 });
    add(hand, new THREE.CylinderGeometry(0.07, 0.08, 0.5, 10), sleeve, { py: -0.2, pz: 0.32, rx: 1.2 });
    this.vmRoot.add(hand);
    this.vmHand = hand;
    this.viewmodels = WEAPONS.map((w, i) => {
      const grp = new THREE.Group();
      const accent = inkMaterial({ color: w.color });
      const glow = flatMaterial(w.color, { fog: false });
      switch (i) {
        case 0: // Pulse Carbine
          add(grp, new THREE.BoxGeometry(0.1, 0.13, 0.58), metal, { pz: -0.1 });
          add(grp, new THREE.CylinderGeometry(0.03, 0.03, 0.4, 10), metal, { rx: Math.PI / 2, pz: -0.52, py: 0.02 });
          add(grp, new THREE.BoxGeometry(0.11, 0.04, 0.42), accent, { py: 0.085, pz: -0.12 });
          add(grp, new THREE.BoxGeometry(0.07, 0.17, 0.1), metal, { py: -0.13, pz: 0.04 });
          break;
        case 1: // Arc Scatter
          add(grp, new THREE.BoxGeometry(0.18, 0.15, 0.46), accent, { pz: -0.05 });
          for (let k = -1; k <= 1; k++) add(grp, new THREE.CylinderGeometry(0.035, 0.04, 0.24, 8), metal, { rx: Math.PI / 2, pz: -0.4, px: k * 0.055, py: 0.02 });
          break;
        case 2: // Vector Lance
          add(grp, new THREE.BoxGeometry(0.07, 0.09, 0.85), metal, { pz: -0.2 });
          for (let k = 0; k < 3; k++) add(grp, new THREE.TorusGeometry(0.07, 0.02, 6, 16), accent, { pz: -0.32 - k * 0.15 });
          break;
        case 3: // Singularity Launcher
          add(grp, new THREE.BoxGeometry(0.22, 0.22, 0.46), metal, {});
          add(grp, new THREE.TorusGeometry(0.14, 0.03, 8, 20), accent, { pz: -0.28 });
          grp.add(new THREE.Mesh(xf(new THREE.SphereGeometry(0.09, 12, 10), { pz: -0.32 }), glow));
          break;
        case 4: // Phase Blades
          add(grp, new THREE.BoxGeometry(0.03, 0.08, 0.62), accent, { pz: -0.26, rz: 0.2 });
          add(grp, new THREE.BoxGeometry(0.05, 0.06, 0.14), metal, { pz: 0.08 });
          break;
        case 5: // Echo Repeater
          add(grp, new THREE.BoxGeometry(0.12, 0.13, 0.52), metal, { pz: -0.08 });
          add(grp, new THREE.TorusGeometry(0.06, 0.016, 6, 16), accent, { pz: -0.39 });
          add(grp, new THREE.TorusGeometry(0.042, 0.014, 6, 16), accent, { pz: -0.46 });
          break;
        default: break;
      }
      grp.visible = false;
      this.vmRoot.add(grp);
      return { grp, accent };
    });
    const left = this.viewmodels[4].grp.clone();
    left.position.x = -0.5;
    left.scale.x = -1;
    this.viewmodels[4].grp.add(left);
    this.viewmodels[4].left = left;
    this.muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTexture('', '#fff3b0', 128), transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
    this.muzzle.scale.set(0.25, 0.25, 1);
    this.vmScene.add(this.muzzle);
  }

  drawViewmodel(vm) {
    for (let i = 0; i < this.viewmodels.length; i++) this.viewmodels[i].grp.visible = vm.visible && i === vm.weapon;
    this.vmHand.visible = vm.visible;
    const cur = this.viewmodels[vm.weapon];
    if (!cur) return;
    const g = this.vmRoot;
    const lower = vm.reload * 0.35 + vm.switch * 0.5;
    g.position.set(0.27 + vm.sway.x + Math.cos(vm.bob * 2) * 0.008 * vm.bobAmp, -0.27 - lower * 0.4 + Math.abs(Math.sin(vm.bob)) * 0.012 * vm.bobAmp + vm.sway.y, -0.62 + vm.recoil * 0.1);
    g.rotation.set(vm.recoil * 0.35 + lower * 0.9, 0.07 + vm.sway.x * 2, vm.reload * 0.5);
    if (vm.weapon === 4) {
      cur.grp.rotation.set(-vm.swing * 1.2, vm.swing * 0.8, -vm.swing * 0.6);
      if (cur.left) cur.left.rotation.set(vm.swing * 0.4, 0, 0);
    } else cur.grp.rotation.set(0, 0, 0);
    if (vm.weapon === 2) {
      // Vector Lance charge colour: blue -> red -> yellow at full power
      const c = vm.charge;
      _c.copy(this.palette.cyan).lerp(c < 0.99 ? this.palette.magenta : this.palette.amber, c < 0.99 ? c : 1);
      cur.accent.color.copy(_c);
    }
    const mz = this.muzzle;
    mz.material.opacity = vm.muzzle > 0.05 ? 1 : 0;
    mz.material.rotation = this.time * 7;
    mz.position.set(g.position.x * 0.8, g.position.y * 0.8 + 0.03, g.position.z - 0.5);
    mz.scale.setScalar(0.16 + vm.muzzle * 0.22);
  }

  /* ---------------------------------------------------------------- */
  /* effect helpers                                                    */
  /* ---------------------------------------------------------------- */

  tracer(ax, ay, az, bx, by, bz, color, width = 0.04, life = 0.12) {
    this.ribbons.add(ax, ay, az, bx, by, bz, color, width * 1.4, life);
  }

  impact(x, y, z, color, count = 10, speed = 6) {
    this.particles.burst(x, y, z, count, speed, color, 4.5, 0.35, { gravity: 8, drag: 3 });
    if (count >= 12) this.burst(x, y, z, 0, 0.9, 0.22);
  }

  explosion(x, y, z, radius, color) {
    this.particles.burst(x, y, z, Math.round(18 + radius * 8), radius * 4, color, 8, 0.7, { gravity: 4, drag: 2, up: 1 });
    this.rings.add({ x, y, z, r0: 0.3, r1: radius * 1.2, life: 0.45, color, thickness: 0.22, face: 'camera' });
    this.rings.add({ x, y: y - 0.2, z, r0: 0.3, r1: radius * 1.5, life: 0.6, color, thickness: 0.12, face: 'up' });
    this.burst(x, y + 0.5, z, radius > 3 ? 5 : 0, Math.min(5, 1.4 + radius * 0.6), 0.5);
  }

  /** Headshot feedback for the shooter: a red lettered burst at the impact. */
  headshot(x, y, z) {
    this.burst(x, y + 0.35, z, this.headshotKind, 1.05, 0.55);
  }

  /** Enemy death: inked shards + a lettered comic burst. */
  shatter(x, y, z, type, elite) {
    _c.setHex(elite ? ELITE_TINT : ENEMY_TINTS[type] ?? 0x8e5bd1);
    const big = type === 6 ? 4 : type === 1 ? 2 : 1;
    this.particles.burst(x, y, z, 24 * big, 9 * Math.sqrt(big), _c, 9, 0.9, { gravity: 10, drag: 1.2, up: 2 });
    this.particles.burst(x, y, z, 6 * big, 4, this.palette.white, 6, 0.4, { gravity: 0, drag: 4 });
    const word = 2 + (Math.abs(Math.floor(x * 7 + z * 13)) % ONOMATOPOEIA.length);
    this.burst(x, y + 0.6, z, word, 1.6 * Math.sqrt(big), 0.6);
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  beginFrame(dt, time) {
    this.time = time;
    this.frameDt = dt;
    this.frame++;
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

  render(dt, post) {
    const t = this.time;
    this.shake.update(dt);
    this.particles.update(dt);
    this.rings.update(dt, t, this.camera);
    this.ribbons.end();
    this.updateBursts(dt);
    if (this.world) {
      this.world.update(t, post.phase);
      const re = this.world.reactor;
      if (re) re.userData.coreMat.color.copy(this.palette.amber).lerp(this.palette.danger, 1 - (post.reactor ?? 1));
    }
    // Shadows: every frame on High, every other frame on Medium.
    if (this.q.shadows) {
      this.renderer.shadowMap.autoUpdate = false;
      if (this.frame % this.q.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    }

    const r = this.renderer;
    const fx = this.settings.postFx;
    const reduce = this.settings.reducedFlashes ? 0.35 : 1;
    const u = this.post.material.uniforms;
    u.uTime.value = t;
    u.uMisreg.value = fx && this.settings.chromatic ? 1 : 0;
    u.uVignette.value = fx ? 0.32 : 0;
    u.uGrain.value = fx ? (this.settings.quality === 'low' ? 0.03 : 0.05) : 0;
    u.uDamage.value = post.damage * reduce;
    u.uPhase.value = post.phase;
    u.uLowHealth.value = post.lowHealth;
    u.uPulse.value = fx && this.settings.chromatic ? post.pulse * reduce : 0;
    u.uFlash.value = post.flash * reduce;
    u.uSpeed.value = fx && !this.settings.reducedFlashes ? post.speed || 0 : 0;
    u.uInk.value.copy(this.palette.ink);
    u.uPaper.value.copy(this.palette.neutral);
    u.uDamageColor.value.copy(this.palette.danger);
    u.uPhaseColor.value.copy(this.palette.violet);

    this.post.renderWorld(this.scene, this.camera, this.noEdge, this.q.normals);
    this.post.composite();
    r.clearDepth();
    r.render(this.vmScene, this.vmCamera);
  }

  stats() {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, particles: this.particles.count };
  }

  clearTransient() {
    this.particles.clear();
    this.ribbons.clear();
    this.rings.clear();
    for (const r of this.rigs) if (r) r.root.visible = false;
    for (const em of this.enemyMeshes) if (em) { em.mesh.count = 0; em.eyes.count = 0; }
    for (const b of this.bursts) { b.life = 0; b.sp.visible = false; }
    this.projMesh.count = 0;
    this.pickupMesh.count = 0;
    this.titan.visible = false;
  }
}

export { SLOT_COLORS };
