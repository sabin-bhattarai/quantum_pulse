/**
 * Quantum Pulse — procedural Pulse Runner characters.
 *
 * Each runner is a small hierarchy of primitives (≈14 meshes) built in code:
 * armoured torso and helmet in the player's team colour, a dark flight suit,
 * a glowing backpack core, two arms holding a carbine and two jointed legs.
 * Animation is procedural and driven only by networked state (position
 * deltas, movement state, aim pitch), so it costs nothing on the wire.
 *
 * Animation model:
 *   - run cycle: phase advances with horizontal speed (stride ≈ 1.9 m per
 *     cycle); thighs swing ±amp, knees bend only on the back-swing, the body
 *     bobs twice per cycle. amp scales with speed and is capped.
 *   - air: legs tuck, arms lift. slide: hips drop, torso leans back, lead
 *     leg extends. grapple: off-hand reaches up. downed: lies on the back.
 * All poses are blended with exponential smoothing so state changes never pop.
 */
import * as THREE from '/vendor/three/three.module.js';
import { MoveState, PLAYER } from '/shared/constants.js';
import { inkMaterial, flatMaterial } from '/client/ink/InkMaterials.js';

const SUIT = 0x2b2f3a;
const TRIM = 0xefe6d2;
const STRIDE = 1.9;

const caps = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);

function part(geo, mat, x = 0, y = 0, z = 0, parent = null, shadows = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadows;
  if (parent) parent.add(m);
  return m;
}

const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class RunnerRig {
  /**
   * @param {number} teamColor hex
   * @param {{shadows?:boolean}} [opts]
   */
  constructor(teamColor, opts = {}) {
    const sh = opts.shadows !== false;
    this.suit = inkMaterial({ color: SUIT });
    this.armor = inkMaterial({ color: teamColor });
    this.trim = inkMaterial({ color: TRIM });
    this.visor = flatMaterial(0x16130f);
    this.glow = flatMaterial(0xf2c230);
    this.materials = [this.suit, this.armor, this.trim];

    // root: position + facing (name tag lives here); body: takes poses such as lying downed
    const root = new THREE.Group();
    // Modelled ~2.1 m tall; scaled so the helmet sits on the server's head hitbox (PLAYER.HEAD_CENTER).
    root.scale.setScalar(PLAYER.RIG_SCALE);
    this.root = root;
    const body = new THREE.Group();
    root.add(body);
    this.body = body;
    const hips = new THREE.Group();
    hips.position.y = 0.95;
    body.add(hips);
    this.hips = hips;

    // torso
    const torso = new THREE.Group();
    torso.position.y = 0.12;
    hips.add(torso);
    this.torso = torso;
    part(caps(0.25, 0.32), this.suit, 0, 0.28, 0, torso, sh);
    const chest = part(new THREE.BoxGeometry(0.56, 0.36, 0.34), this.armor, 0, 0.42, -0.04, torso, sh);
    chest.geometry.translate(0, 0, 0);
    part(new THREE.BoxGeometry(0.58, 0.07, 0.36), this.trim, 0, 0.28, -0.04, torso, sh); // belt
    const pack = part(new THREE.BoxGeometry(0.38, 0.42, 0.18), this.suit, 0, 0.42, 0.24, torso, sh);
    part(new THREE.CylinderGeometry(0.08, 0.08, 0.3, 10), this.glow, 0, 0, 0.1, pack, false).rotation.x = 0;

    // head
    const head = new THREE.Group();
    head.position.y = 0.78;
    torso.add(head);
    this.head = head;
    const helmet = part(new THREE.SphereGeometry(0.22, 16, 12), this.armor, 0, 0.06, 0, head, sh);
    helmet.scale.set(1, 1.05, 1.1);
    part(new THREE.BoxGeometry(0.34, 0.12, 0.08), this.visor, 0, 0.06, -0.2, head, false);
    part(new THREE.BoxGeometry(0.06, 0.18, 0.06), this.trim, 0.17, 0.2, 0.04, head, sh).rotation.z = -0.3; // antenna fin

    // arms (right holds the gun, left supports it)
    const makeArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.36 * side, 0.55, -0.02);
      torso.add(shoulder);
      part(new THREE.SphereGeometry(0.13, 10, 8), this.armor, 0, 0, 0, shoulder, sh);
      part(caps(0.08, 0.22), this.suit, 0, -0.18, 0, shoulder, sh);
      const elbow = new THREE.Group();
      elbow.position.y = -0.34;
      shoulder.add(elbow);
      part(caps(0.075, 0.2), this.suit, 0, -0.15, 0, elbow, sh);
      part(new THREE.BoxGeometry(0.13, 0.12, 0.13), this.trim, 0, -0.32, 0, elbow, sh); // glove
      return { shoulder, elbow };
    };
    this.armR = makeArm(1);
    this.armL = makeArm(-1);
    // carbine held in the right hand
    const gun = new THREE.Group();
    gun.position.set(0, -0.36, -0.04);
    gun.rotation.x = -Math.PI / 2; // barrel (-Z) along the forearm (-Y)
    this.armR.elbow.add(gun);
    part(new THREE.BoxGeometry(0.1, 0.14, 0.62), this.suit, 0, 0, -0.18, gun, sh);
    part(new THREE.BoxGeometry(0.11, 0.05, 0.4), this.armor, 0, 0.09, -0.16, gun, sh);
    part(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), this.trim, 0, 0.01, -0.58, gun, sh).rotation.x = Math.PI / 2;
    this.gun = gun;

    // legs
    const makeLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(0.15 * side, 0, 0);
      hips.add(hip);
      part(caps(0.1, 0.3), this.suit, 0, -0.22, 0, hip, sh);
      part(new THREE.BoxGeometry(0.2, 0.2, 0.22), this.armor, 0, -0.16, -0.02, hip, sh); // thigh plate
      const knee = new THREE.Group();
      knee.position.y = -0.45;
      hip.add(knee);
      part(caps(0.09, 0.28), this.suit, 0, -0.2, 0, knee, sh);
      part(new THREE.BoxGeometry(0.17, 0.12, 0.3), this.trim, 0, -0.44, -0.05, knee, sh); // boot
      return { hip, knee };
    };
    this.legR = makeLeg(1);
    this.legL = makeLeg(-1);

    this.phase = 0;
    this.pose = { lean: 0, crouch: 0, tuck: 0, slide: 0, down: 0, grapple: 0 };
    this.opacity = 1;
  }

  setTeamColor(hex) {
    this.armor.color.setHex(hex);
  }

  setOpacity(a) {
    if (Math.abs(a - this.opacity) < 0.01) return;
    this.opacity = a;
    for (const m of this.materials) {
      m.transparent = a < 0.999;
      m.opacity = a;
      m.depthWrite = a > 0.6;
    }
  }

  /**
   * Advance the procedural animation.
   * @param {number} dt
   * @param {{speed:number, vy:number, state:number, pitch:number, downed:boolean, grappling:boolean, sliding:boolean, forward:number}} s
   */
  animate(dt, s) {
    const P = this.pose;
    const st = s.state;
    const air = st === MoveState.JUMPING || st === MoveState.FALLING || st === MoveState.DASHING || st === MoveState.GRAPPLING || st === MoveState.WALLRUN;
    const amp = Math.min(1, s.speed / 9) * 0.85;
    this.phase += (s.speed * dt / STRIDE) * Math.PI * 2 * (s.forward >= 0 ? 1 : -1);
    P.tuck = damp(P.tuck, air && !s.grappling ? 1 : 0, 10, dt);
    P.slide = damp(P.slide, s.sliding ? 1 : 0, 12, dt);
    P.down = damp(P.down, s.downed ? 1 : 0, 6, dt);
    P.grapple = damp(P.grapple, s.grappling ? 1 : 0, 10, dt);
    P.lean = damp(P.lean, Math.max(-0.35, Math.min(0.35, s.forward * 0.03)), 8, dt);

    const run = (1 - P.tuck) * (1 - P.slide);
    const sw = Math.sin(this.phase) * amp * run;
    // Characters face -Z, so a positive X rotation swings a limb forward.
    // legs: swing + knee bend on the back-swing, tuck in air, lead leg out on slides
    this.legR.hip.rotation.x = sw + P.tuck * 0.9 + P.slide * 1.35;
    this.legL.hip.rotation.x = -sw + P.tuck * 0.5 + P.slide * 0.2;
    this.legR.knee.rotation.x = -(Math.max(0, -Math.sin(this.phase)) * amp * 1.3 * run + P.tuck * 1.3 + P.slide * 0.05);
    this.legL.knee.rotation.x = -(Math.max(0, Math.sin(this.phase)) * amp * 1.3 * run + P.tuck * 1.0 + P.slide * 1.5);
    // body
    const bob = Math.abs(Math.sin(this.phase)) * 0.06 * amp * run;
    this.hips.position.y = 0.95 + bob - P.slide * 0.45 - P.down * 0.55;
    this.body.position.y = P.down * 0.3;
    this.torso.rotation.x = -P.lean + P.slide * 0.55;
    this.torso.rotation.y = Math.sin(this.phase) * 0.12 * amp * run;
    this.body.rotation.x = P.down * Math.PI / 2; // downed: lying on the back
    // aim: head and arms follow pitch
    const pitch = Math.max(-1, Math.min(1, s.pitch));
    this.head.rotation.x = pitch * 0.6;
    this.armR.shoulder.rotation.x = 1.35 + pitch * 0.8 - P.down * 1.2;
    this.armR.elbow.rotation.x = 0.3;
    this.armL.shoulder.rotation.x = (1.25 + pitch * 0.8) * (1 - P.grapple) + 2.9 * P.grapple;
    this.armL.shoulder.rotation.z = 0.55 * (1 - P.grapple);
    this.armL.elbow.rotation.x = 0.6 * (1 - P.grapple);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of [...this.materials, this.visor, this.glow]) m.dispose();
  }
}
