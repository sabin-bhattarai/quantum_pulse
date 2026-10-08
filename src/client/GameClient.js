/**
 * Quantum Pulse — in-match client session.
 *
 * Owns one match from the player's point of view:
 *   - samples input at the fixed simulation rate and predicts local movement,
 *   - sends compact input commands (never damage, hits or positions),
 *   - reconciles against authoritative snapshots,
 *   - interpolates remote entities and turns snapshot events into effects,
 *   - drives the renderer, audio and HUD.
 *
 * The authority (server or offline Room) decides every gameplay outcome; the
 * effects spawned here on firing are purely cosmetic previews.
 */
import { SIM, NET, MODES, BTN, PLAYER, PULSE, MoveState } from '../shared/constants.js';
import { createArena, ColliderKind, arenaName } from '../shared/arenas.js';
import { createCollisionEnv, MoveEvent, raycastArena } from '../shared/movement.js';
import { encodeInput, MSG, EV, PF } from '../shared/protocol.js';
import { WEAPONS, WeaponType, computeSpread } from '../shared/weapons.js';
import { clamp, dirFromYawPitch } from '../shared/math.js';
import { Prediction } from './Prediction.js';
import { SnapshotBuffer, ServerClock, interpolateCategory } from './Interpolation.js';

const BASE_SENSITIVITY = 0.0022; // radians per pixel at sensitivity 1.0

/** FOV in degrees after zooming: scales tan(FOV/2), which is true optical magnification. */
function zoomFov(fovDeg, zoom) {
  if (zoom >= 0.999) return fovDeg;
  return (2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * zoom) * 180) / Math.PI;
}
const MODE_LABELS = { survival: 'Solo Survival', ffa: 'Free-for-All', coop: 'Rift Defense', training: 'Training Range' };

const TUTORIAL = [
  { id: 'move', text: 'Move with W A S D' },
  { id: 'sprint', text: 'Run forward: you sprint automatically' },
  { id: 'jump', text: 'Press Space to jump' },
  { id: 'slide', text: 'While sprinting, press C to slide' },
  { id: 'slidejump', text: 'Jump out of a slide to keep momentum' },
  { id: 'dash', text: 'Double-tap Space for a long jump' },
  { id: 'zoom', text: 'Tap Shift to zoom, tap again to zoom out' },
  { id: 'walljump', text: 'Jump into a wall, then jump again to wall-jump' },
  { id: 'grapple', text: 'Aim at geometry and press Q to grapple' },
  { id: 'launch', text: 'While grappling, press Space to launch' },
  { id: 'ring', text: 'Fly through a quantum ring' },
  { id: 'gravity', text: 'Press G to open a gravity well' },
  { id: 'pulse', text: 'At 100 Pulse, press X for Phase Break' },
];

const _dir = { x: 0, y: 0, z: 0 };
const _pos = { x: 0, y: 0, z: 0 };

export class GameClient {
  /**
   * @param {object} o
   * @param {object} o.transport WebSocketTransport | LocalTransport
   * @param {object} o.welcome welcome message
   * @param {import('../../public/renderer.js').Renderer} o.renderer
   * @param {import('../../public/input.js').InputManager} o.input
   * @param {import('../../public/audio.js').AudioEngine} o.audio
   * @param {import('../../public/ui.js').UI} o.ui
   * @param {object} o.settings
   * @param {{tutorial?:boolean}} o.options
   * @param {{onExit:Function, saveBest:Function, getBest:Function}} o.hooks
   */
  constructor(o) {
    Object.assign(this, { transport: o.transport, renderer: o.renderer, input: o.input, audio: o.audio, ui: o.ui, settings: o.settings, hooks: o.hooks });
    this.options = o.options || {};
    this.welcome = o.welcome;
    this.mode = o.welcome.mode;
    this.myId = o.welcome.id;
    this.isLocal = !!o.transport.isLocal;

    this.arena = createArena(o.welcome.arena);
    this.env = createCollisionEnv(this.arena);
    this.prediction = new Prediction(this.env);
    this.buffer = new SnapshotBuffer();
    this.snapshotInterval = SIM.TICK_RATE / (o.welcome.snapshotRate || SIM.SNAPSHOT_RATE);
    this.clock = new ServerClock(this.snapshotInterval);

    this.seq = 0;
    this.acc = 0;
    this.time = 0;
    this.frameNo = 0;
    this.pendingInputs = [];
    this.sendTimer = 0;
    this.yaw = this.arena.spawns[0].yaw;
    this.pitch = 0;
    this.weapon = 0;
    this.me = null;
    this.match = { md: this.mode, ph: '', t: 0 };
    this.scoreboard = [];
    this.names = new Map();
    this.rPlayers = new Map();
    this.rEnemies = new Map();
    this.hitFlash = new Map();
    this.sweeps = [];
    this.lastSnapshot = null;
    this.paused = false;
    this.ended = false;
    this.resultsShown = false;
    this.resultsKey = '';
    this.fractureCache = [];

    // cosmetic weapon state
    this.cw = { cooldown: 0, charge: 0, charging: false, lastSwing: -10, switchAnim: 0, recoil: 0, muzzle: 0, swing: 0, prevFire: false };
    this.pendingShots = [];
    this.vm = { weapon: 0, bob: 0, bobAmp: 0, sway: { x: 0, y: 0 }, recoil: 0, reload: 0, switch: 0, swing: 0, charge: 0, visible: true, muzzle: 0, muzzleColor: null, ads: 0 };
    this.zoom = 1; // current aim-down-sights scale of tan(FOV/2); 1 = hip fire

    // feedback state
    this.post = { damage: 0, phase: 0, lowHealth: 0, pulse: 0, flash: 0, reactor: 1, speed: 0 };
    this.eyeHeight = PLAYER.EYE_HEIGHT;
    this.prevGrappleHeld = false;
    this.lastVel = { x: 0, y: 0, z: 0 };
    this.accel = 0;
    this.hudTimer = 0;
    this.fps = 60;
    this.frameMs = 16;
    this.damageLog = []; // [time, amount] for training DPS
    this.tutorialStep = this.options.tutorial && this.mode === MODES.TRAINING ? 0 : -1;
    this.tutorialDist = 0;
    this.lastSlideTime = -10;
    this.lastMusic = '';

    this.transport.onMessage((m) => this.onMessage(m));
    this.transport.onStatus((s, info) => this.onStatus(s, info));

    this.renderer.clearTransient();
    this.renderer.buildArena(this.arena);
    this.ui.enterGame();
    this.ui.setDowned(null);
    this.audio.setMusic('calm');
  }

  /* ---------------------------------------------------------------- */
  /* network                                                           */
  /* ---------------------------------------------------------------- */

  onStatus(s, info) {
    if (s === 'reconnecting') {
      this.ui.loading(`Connection lost — reconnecting (attempt ${info.attempt})…`);
    } else if (s === 'connected' && !this.isLocal) {
      this.ui.loading(null);
      // Fresh start after reconnect: drop stale prediction/interpolation data.
      this.prediction.reset();
      this.buffer.clear();
      this.clock = new ServerClock(this.snapshotInterval);
      this.pendingShots.length = 0;
    } else if (s === 'failed') {
      this.ui.loading(null);
      this.hooks.onExit(info || 'Disconnected from server');
    }
  }

  onMessage(msg) {
    if (msg.t === MSG.SNAPSHOT) this.onSnapshot(msg.w, msg.me);
    else if (msg.t === MSG.WELCOME) {
      this.myId = msg.id;
    } else if (msg.t === MSG.ERROR) {
      this.ui.toast(msg.msg || 'Server error', true);
    }
  }

  onSnapshot(w, me) {
    const now = performance.now();
    this.clock.observe(w.k, now);
    this.buffer.push(w);
    this.lastSnapshot = w;
    this.match = w.m;

    // Mirror authoritative world state into the prediction environment.
    for (const c of this.arena.colliders) if (c.kind === ColliderKind.PROP) c.alive = !w.d.includes(c.id);
    this.renderer.setDestroyedProps(w.d);
    let n = 0;
    for (const f of w.f) {
      let o = this.fractureCache[n];
      if (!o) { o = {}; this.fractureCache[n] = o; }
      o.id = f[0]; o.x = f[1]; o.y = f[2]; o.z = f[3]; o.radius = f[4]; o.strength = f[5]; o.mode = f[6]; o.age = f[7]; o.duration = f[8];
      this.env.fractures[n] = o;
      n++;
    }
    this.env.fractures.length = n;
    this.env.fractureCount = n;

    if (me) {
      const firstState = !this.prediction.initialized;
      const respawned = this.me && !this.me.al && me.al;
      this.me = me;
      this.prediction.reconcile(me.ms, me.a);
      // The client owns its view angles, but adopts the server's facing on
      // the first snapshot and after every respawn.
      if (firstState || respawned) { this.yaw = me.ms[6]; this.pitch = 0; }
      while (this.pendingShots.length && this.pendingShots[0] <= me.a) this.pendingShots.shift();
      if (!(me.ow & (1 << this.weapon))) this.weapon = me.w;
    }
    if (w.sb) {
      this.scoreboard = w.sb;
      for (const r of w.sb) this.names.set(r[0], r[1]);
    }
    for (const e of w.ev) this.handleEvent(e);
    this.updateMatchFlow();
  }

  /* ---------------------------------------------------------------- */
  /* events -> effects                                                 */
  /* ---------------------------------------------------------------- */

  handleEvent(e) {
    const R = this.renderer, A = this.audio, P = R.palette, me = this.myId;
    switch (e[0]) {
      case EV.HIT: {
        const [, shooter, target, dmg, head, x, y, z, isEnemy] = e;
        this.hitFlash.set(target, this.time);
        // Never burst sparks on yourself: the hit point is inside your own camera and would blind you.
        // Being hit is shown by the red halftone edges and the damage direction arrow instead.
        if (target !== me) R.impact(x, y, z, head ? P.amber : P.white, head ? 14 : 7, 6);
        if (shooter === me) {
          this.ui.hitmarker(head ? 'head' : '');
          A.play(head ? 'headshot' : 'hit', { ui: true, throttle: 0.04 });
          if (head) R.headshot(x, y, z);
          if (this.mode === MODES.TRAINING) this.damageLog.push([this.time, dmg]);
        } else if (!isEnemy && target === me) {
          // damage taken handled by DAMAGED
        }
        break;
      }
      case EV.KILL: {
        const [, killerId, killerName, victimId, victimName, weapon, flags] = e;
        const wname = weapon >= 0 ? WEAPONS[weapon].name : 'ability';
        this.ui.killfeed(killerName, victimName, wname, flags, killerId === me || victimId === me);
        if (killerId === me) {
          this.ui.hitmarker('kill');
          A.play('kill', { ui: true });
          if (flags & 2) this.ui.centerMessage('AIRBORNE KILL', '+ pulse', 900);
          else if (flags & 4) this.ui.centerMessage('ENVIRONMENTAL KILL', '+ pulse', 900);
        }
        if (victimId === me && this.mode === MODES.FFA) this.ui.centerMessage('ELIMINATED', killerName ? `by ${killerName}` : 'by the void', 2000);
        break;
      }
      case EV.FIRE: {
        const [, shooter, wi, ox, oy, oz, ex, ey, ez, charge] = e;
        const def = WEAPONS[wi];
        if (shooter === me && charge !== -1) break; // own shots were previewed locally
        if (!def) break;
        const color = _color(R, def.color);
        if (def.type === WeaponType.HITSCAN || def.type === WeaponType.ECHO || def.type === WeaponType.CHARGE) {
          R.tracer(ox, oy - 0.15, oz, ex, ey, ez, color, def.type === WeaponType.CHARGE ? 0.08 + charge * 0.1 : 0.035, def.type === WeaponType.CHARGE ? 0.3 : 0.12);
          R.impact(ex, ey, ez, color, 5, 4);
        }
        if (charge === -1) A.play('echo_repeat', { x: ox, y: oy, z: oz });
        else A.play(def.sfx, { x: ox, y: oy, z: oz });
        break;
      }
      case EV.EXPLODE: {
        const [, x, y, z, r, ci] = e;
        const color = [P.magenta, P.amber, P.danger, P.cyan, P.amber][ci] || P.amber;
        R.explosion(x, y, z, r, color);
        A.play('explosion', { x, y, z, throttle: 0.05 });
        this.shakeAt(x, y, z, 0.35 * Math.min(2, r / 3));
        break;
      }
      case EV.DEATH_FX: {
        const [, type, x, y, z, elite] = e;
        R.shatter(x, y, z, type, elite);
        A.play('enemy_die', { x, y, z });
        if (type === 6) { this.shakeAt(x, y, z, 1); this.ui.centerMessage('TITAN COLLAPSED', 'Bonus upgrade earned', 2600); }
        break;
      }
      case EV.DAMAGED: {
        const [, victim, dmg, fx, , fz] = e;
        if (victim !== me) break;
        const m = this.prediction.state;
        this.post.damage = Math.min(1, this.post.damage + 0.25 + dmg / 60);
        this.renderer.shake.add(Math.min(0.5, 0.12 + dmg / 80));
        A.play('hurt', { ui: true, throttle: 0.12 });
        const dx = fx - m.x, dz = fz - m.z;
        if (dx * dx + dz * dz > 0.25) {
          const world = Math.atan2(-dx, -dz);
          this.ui.damageIndicator(this.yaw - world);
        }
        break;
      }
      case EV.PULSE: {
        const pid = e[1];
        if (pid === me) {
          A.play('pulse', { ui: true });
          this.post.pulse = 1;
          this.renderer.shake.add(0.35);
          this.ui.centerMessage('PHASE BREAK', 'enemy fire passes through you', 1400);
          if (this.tutorialStep >= 0) this.tutorialHit('pulse');
        } else {
          const o = this.rPlayers.get(pid);
          if (o) { R.rings.add({ x: o.x, y: o.y + 1, z: o.z, r0: 0.5, r1: 6, life: 0.6, color: P.violet, face: 'camera', thickness: 0.15 }); A.play('pulse', { x: o.x, y: o.y, z: o.z }); }
        }
        break;
      }
      case EV.RING: {
        if (e[1] === me) {
          A.play('ring', { ui: true });
          this.post.flash = 0.5;
          if (this.tutorialStep >= 0) this.tutorialHit('ring');
        }
        const r = this.arena.rings[e[2]];
        if (r) R.rings.add({ x: r.x, y: r.y, z: r.z, r0: r.r, r1: r.r * 2.2, life: 0.5, color: P.amber, face: 'camera', thickness: 0.1 });
        break;
      }
      case EV.WAVE: {
        const [, n, boss, elite] = e;
        this.ui.centerMessage(`WAVE ${n}`, boss ? 'Singularity Titan approaching' : elite ? 'Elite signatures detected' : 'Rifts opening', 2600);
        A.play('wave', { ui: true });
        break;
      }
      case EV.BOSS: {
        const [, , phase] = e;
        if (phase === 1) this.ui.centerMessage('SINGULARITY TITAN', 'Shoot the glowing core', 3000);
        else this.ui.centerMessage(`TITAN PHASE ${phase}`, 'Core exposed — strike now!', 2400);
        A.play('boss', { ui: true });
        this.renderer.shake.add(0.5);
        break;
      }
      case EV.PROP_BREAK: {
        const id = e[1];
        if (id < 0) break; // restored
        const c = this.arena.colliders[id];
        if (c) {
          const x = (c.minX + c.maxX) / 2, y = (c.minY + c.maxY) / 2, z = (c.minZ + c.maxZ) / 2;
          R.particles.burst(x, y, z, 30, 7, P.amber, 7, 0.9, { gravity: 14, drag: 1, up: 3 });
          A.play('explosion', { x, y, z });
        }
        break;
      }
      case EV.DEFLECT: {
        const [, pid, x, y, z] = e;
        R.impact(x, y, z, P.mint, 16, 8);
        A.play('deflect', pid === me ? { ui: true } : { x, y, z });
        break;
      }
      case EV.ECHO_MARK: {
        const [, owner, ox, oy, oz, dx, dy, dz, delay] = e;
        // Visible indicator: the trajectory the echo will repeat along.
        R.ribbons.add(ox, oy - 0.1, oz, ox + dx * 40, oy + dy * 40, oz + dz * 40, P.mint, 0.02, delay, owner === me ? 0.45 : 0.3, false);
        break;
      }
      case EV.REVIVE: {
        const [, reviver, target] = e;
        A.play('revive', { ui: true });
        if (target === me) this.ui.centerMessage('REVIVED', `by ${this.names.get(reviver) || 'a teammate'}`, 1500);
        break;
      }
      case EV.DOWNED: {
        A.play('downed', e[1] === me ? { ui: true } : { ui: true, vol: 0.5 });
        if (e[1] !== me) this.ui.toast(`${this.names.get(e[1]) || 'A teammate'} is down — hold E near them to revive`);
        break;
      }
      case EV.NEAR_MISS: {
        if (e[1] === me) { A.play('near_miss', { ui: true }); this.post.flash = Math.max(this.post.flash, 0.25); }
        break;
      }
      case EV.SHOCKWAVE: {
        const [, x, y, z, r] = e;
        R.rings.add({ x, y: y + 0.1, z, r0: 0.5, r1: r * 1.2, life: 0.5, color: P.danger, face: 'up', thickness: 0.25 });
        R.particles.burst(x, y + 0.3, z, 40, r * 2, P.danger, 6, 0.6, { gravity: 6, drag: 2, up: 2 });
        this.shakeAt(x, y, z, 0.7);
        A.play('hard_land', { x, y, z });
        break;
      }
      case EV.PLAYER_SHOCKWAVE: {
        const [, pid, x, y, z] = e;
        R.rings.add({ x, y: y + 0.1, z, r0: 0.3, r1: PLAYER.SHOCKWAVE_RADIUS, life: 0.45, color: P.cyan, face: 'up', thickness: 0.3 });
        R.particles.burst(x, y + 0.2, z, 24, 8, P.cyan, 5, 0.5, { gravity: 10, drag: 2, up: 3 });
        if (pid === me) this.renderer.shake.add(0.4);
        A.play('hard_land', pid === me ? { ui: true } : { x, y, z });
        break;
      }
      case EV.STALKER_WARN: {
        const [, x, y, z] = e;
        A.play('stalker', { x, y, z, vol: 1.6 });
        R.rings.add({ x, y, z, r0: 2.5, r1: 0.4, life: 0.85, color: P.violet, face: 'camera', thickness: 0.12, style: 3 });
        break;
      }
      case EV.TETHER_ARC: {
        const [, x, y, z] = e;
        R.impact(x, y, z, P.violet, 20, 9);
        A.play('deflect', { x, y, z });
        break;
      }
      case EV.STREAK: {
        const [, pid, n] = e;
        if (pid === me) { this.ui.centerMessage(`${n} STREAK`, 'unstoppable', 1500); A.play('streak', { ui: true }); }
        else this.ui.toast(`${this.names.get(pid) || 'Someone'} is on a ${n} streak`);
        break;
      }
      case EV.TELEGRAPH: this.handleTelegraph(e); break;
      case EV.RIFT: {
        const [, x, y, z] = e;
        R.rings.add({ x, y, z, r0: 2.6, r1: 2.6, life: 1.0, color: P.magenta, face: 'camera', thickness: 0.2, style: 2 });
        R.particles.burst(x, y, z, 18, 5, P.magenta, 5, 0.8, { gravity: -2, drag: 2 });
        A.play('enemy_shot', { x, y, z, throttle: 0.15 });
        break;
      }
      case EV.RELOAD: {
        const [, pid] = e;
        if (pid === me) A.play('reload', { ui: true });
        else { const o = this.rPlayers.get(pid); if (o) A.play('reload', { x: o.x, y: o.y, z: o.z, vol: 0.6 }); }
        break;
      }
      case EV.MELEE: {
        const [, pid, x, y, z] = e;
        R.rings.add({ x, y, z, r0: 0.3, r1: PULSE.MELEE_RANGE, life: 0.25, color: P.cyan, face: 'camera', thickness: 0.2 });
        A.play('melee', pid === me ? { ui: true } : { x, y, z });
        break;
      }
      case EV.GRAPPLE: {
        if (e[1] !== me) { const o = this.rPlayers.get(e[1]); if (o) A.play('grapple', { x: o.x, y: o.y, z: o.z }); }
        break;
      }
      case EV.DASH: {
        if (e[1] !== me) {
          const o = this.rPlayers.get(e[1]);
          if (o) for (let k = 0; k < 4; k++) R.ribbons.add(o.x, o.y + 0.2 + k * 0.4, o.z, o.x, o.y + 0.5 + k * 0.4, o.z, P.cyan, 0.3, 0.35, 0.5);
        }
        break;
      }
      case EV.PICKUP: {
        if (e[1] === me) A.play('pickup', { ui: true });
        break;
      }
      case EV.REACTOR_HIT: {
        if (this.time - (this.lastReactorWarn || -10) > 6) {
          this.lastReactorWarn = this.time;
          this.ui.toast('The reactor is under attack!');
        }
        break;
      }
      case EV.ARENA_PULSE: {
        if (e[1] === 0) {
          this.ui.centerMessage('REACTOR PULSE', 'get airborne or climb above the catwalks', 2400);
          A.play('enemy_warn', { ui: true });
          const r = this.arena.reactor || { x: 0, z: 0 };
          R.rings.add({ x: r.x, y: 0.2, z: r.z, r0: this.arena.half, r1: this.arena.half, life: 2.5, color: P.danger, face: 'up', thickness: 0.02, style: 1, fill: true });
        } else {
          A.play('arena_pulse', { ui: true });
          this.renderer.shake.add(0.6);
          this.post.flash = 0.8;
          const r = this.arena.reactor || { x: 0, z: 0 };
          R.rings.add({ x: r.x, y: 0.3, z: r.z, r0: 2, r1: this.arena.half * 1.4, life: 0.9, color: P.amber, face: 'up', thickness: 0.06 });
        }
        break;
      }
      case EV.RIFT_SURGE: {
        const [, x, y, z] = e;
        R.explosion(x, y, z, 10, P.violet);
        this.ui.centerMessage('RIFT SURGE', 'synchronised Phase Break', 1800);
        A.play('pulse', { x, y, z });
        break;
      }
      case EV.TRANSFER: {
        const [, from, to] = e;
        if (to === me) this.ui.toast(`${this.names.get(from) || 'Teammate'} shared Pulse Charge with you`);
        else if (from === me) this.ui.toast('Pulse Charge transferred');
        break;
      }
      case EV.ANNOUNCE: {
        if (e[1] === 'match_start') { this.ui.centerMessage('FIGHT', 'match started', 1600); A.play('wave', { ui: true }); }
        break;
      }
      default: break;
    }
  }

  handleTelegraph(e) {
    const [, , kind, x, y, z, dur, a, b, c] = e;
    const R = this.renderer, P = R.palette, A = this.audio;
    switch (kind) {
      case 0: // flash (generic wind-up)
        R.rings.add({ x, y, z, r0: 1.8, r1: 0.4, life: dur, color: P.danger, face: 'camera', thickness: 0.15 });
        A.play('enemy_warn', { x, y, z, throttle: 0.2 });
        break;
      case 1: // ground ring (titan slam)
        R.rings.add({ x, y: y + 0.08, z, r0: a, r1: a, life: dur, color: P.danger, face: 'up', thickness: 0.05, style: 1, fill: true });
        A.play('enemy_warn', { x, y, z });
        break;
      case 2: { // runner charge line
        const len = 26;
        R.ribbons.add(x, y - 0.5, z, x + a * len, y - 0.5, z + c * len, P.danger, 0.35, dur, 0.8, false);
        A.play('charge_warn', { x, y, z, throttle: 0.1 });
        break;
      }
      case 3: // fracture warning
        R.rings.add({ x, y, z, r0: a, r1: a, life: dur, color: P.violet, face: 'camera', thickness: 0.04, style: 3 });
        R.rings.add({ x, y: y - 1.4, z, r0: a, r1: a, life: dur, color: P.violet, face: 'up', thickness: 0.04, style: 1, fill: true });
        A.play('fracture', { x, y, z, throttle: 0.2 });
        break;
      case 4: // titan arena pulse
        this.ui.centerMessage('ARENA PULSE', 'jump! grounded runners take damage', 2400);
        A.play('enemy_warn', { ui: true });
        R.rings.add({ x, y: 0.2, z, r0: 40, r1: 40, life: dur, color: P.danger, face: 'up', thickness: 0.02, style: 1, fill: true });
        break;
      case 5: // titan beam sweep: telegraph then active sweep
        this.sweeps.push({ x, y, z, angle: a, sweep: b, active: c, tele: dur, t: 0 });
        A.play('charge_warn', { x, y, z });
        break;
      case 6: // caster shield
        R.rings.add({ x, y, z, r0: 1, r1: a, life: dur, color: P.cyan, face: 'camera', thickness: 0.05 });
        break;
      case 7: // portal
        R.rings.add({ x, y, z, r0: 4, r1: 4, life: dur, color: P.magenta, face: 'camera', thickness: 0.2, style: 2 });
        break;
      default: break;
    }
  }

  shakeAt(x, y, z, amount) {
    const m = this.prediction.state;
    const d = Math.hypot(x - m.x, y - m.y, z - m.z);
    this.renderer.shake.add(amount * clamp(1 - d / 30, 0, 1));
  }

  /* ---------------------------------------------------------------- */
  /* match flow (results, death overlays, music)                        */
  /* ---------------------------------------------------------------- */

  updateMatchFlow() {
    const m = this.match;
    const me = this.me;
    if (m.res && !this.resultsShown) {
      this.resultsShown = true;
      let best = this.hooks.getBest(this.arena.id);
      let isNewBest = false;
      if (this.mode === MODES.SURVIVAL && m.res.score !== undefined) {
        isNewBest = this.hooks.saveBest(this.arena.id, { score: m.res.score, wave: m.res.wave, time: m.res.time });
        best = this.hooks.getBest(this.arena.id);
      }
      this.ui.showResults(m.res, { myId: this.myId, best, isNewBest, canReplay: this.isLocal });
      this.input.exitLock();
      this.audio.setMusic('calm');
    } else if (!m.res && this.resultsShown) {
      this.resultsShown = false;
      this.ui.hideResults();
      if (!this.isLocal) this.ui.showPause('A new match is starting — press Resume to jump in.');
    }
    if (!me) return;
    if (this.mode === MODES.COOP && me.dn > 0) this.ui.setDowned('DOWNED', `Bleeding out in ${Math.ceil(me.dn)}s — a teammate can revive you with E`);
    else if (!me.al && this.mode === MODES.FFA) this.ui.setDowned('ELIMINATED', `Respawning in ${Math.max(0, me.rs).toFixed(1)}s`);
    else if (!me.al && this.mode === MODES.COOP && !m.res) this.ui.setDowned('FALLEN', 'You will rejoin when the wave ends');
    else this.ui.setDowned(null);

    if (me.up && !this.ui.upgradeOpen && !m.res) {
      this.ui.showUpgrade(me.up);
      if (this.isLocal) this.input.exitLock();
    } else if (!me.up && this.ui.upgradeOpen) {
      this.ui.showUpgrade(null);
    }
    // music
    let music = 'calm';
    if (m.ph === 'wave' || m.ph === 'active') music = 'combat';
    for (const [, o] of this.rEnemies) if (o.raw[1] === 6) music = 'boss';
    if (music !== this.lastMusic) { this.lastMusic = music; this.audio.setMusic(music); }
  }

  chooseUpgrade(index) {
    if (!this.me || !this.me.up || index >= this.me.up.length) return;
    this.transport.send({ t: MSG.UPGRADE, c: index });
    this.audio.play('ui_click', { ui: true });
    this.ui.showUpgrade(null);
    this.me.up = null;
    this.input.requestLock();
  }

  /* ---------------------------------------------------------------- */
  /* fixed tick: input + prediction + cosmetic weapon preview          */
  /* ---------------------------------------------------------------- */

  /** True when gameplay input should be read (pointer locked, no blocking overlay). */
  get acceptingInput() {
    return this.input.locked && !this.ui.upgradeOpen && !this.ui.resultsOpen;
  }

  tick() {
    const s = this.input.sample();
    const accepting = this.acceptingInput;
    const me = this.me;
    let buttons = accepting ? s.buttons : 0;
    // tap-to-zoom aims exactly like holding RMB (tighter spread)
    if (accepting && this.input.zoomToggled && WEAPONS[this.weapon].zoom < 1) buttons |= BTN.ALT;
    let mx = accepting ? s.mx : 0, mz = accepting ? s.mz : 0;

    // Number keys pick upgrades while the upgrade overlay is open.
    if (this.ui.upgradeOpen && s.weaponSelect >= 0) {
      this.chooseUpgrade(s.weaponSelect);
    } else if (accepting && s.weaponSelect >= 0 && me && (me.ow & (1 << s.weaponSelect)) && s.weaponSelect !== this.weapon) {
      this.selectWeapon(s.weaponSelect);
    }

    // Optional hold-to-grapple: releasing Q detaches.
    const grappleHeld = (buttons & BTN.GRAPPLE) !== 0;
    if (this.settings.holdToGrapple && this.prevGrappleHeld && !grappleHeld && this.prediction.state.grappling) buttons |= BTN.GRAPPLE_P;
    this.prevGrappleHeld = grappleHeld;

    const renderTick = this.clock.renderTick(performance.now());
    const cmd = {
      seq: this.seq++, mx, mz, yaw: this.yaw, pitch: this.pitch, buttons, weapon: this.weapon,
      viewTick: Math.max(0, Math.floor(renderTick)),
    };
    const ev = this.prediction.apply(cmd);
    this.onLocalMoveEvents(ev, cmd);
    this.previewWeapon(cmd);
    if (this.tutorialStep >= 0) this.tutorialTick(cmd, ev);

    this.pendingInputs.push(encodeInput(cmd));
    if (this.isLocal) {
      this.transport.send({ t: MSG.INPUT, i: this.pendingInputs });
      this.pendingInputs = [];
      this.transport.tick();
    }
  }

  flushInputs(dt) {
    if (this.isLocal) return;
    this.sendTimer += dt;
    if (this.sendTimer < 1 / NET.INPUT_SEND_RATE && this.pendingInputs.length < 4) return;
    this.sendTimer = 0;
    while (this.pendingInputs.length) {
      const chunk = this.pendingInputs.splice(0, NET.MAX_INPUTS_PER_PACKET);
      this.transport.send({ t: MSG.INPUT, i: chunk });
    }
  }

  selectWeapon(i) {
    this.weapon = i;
    this.cw.switchAnim = 1;
    this.cw.charging = false;
    this.cw.charge = 0;
    this.cw.cooldown = Math.max(this.cw.cooldown, 0.22);
    this.audio.chargeTone(-1);
    this.audio.play('ui_hover', { ui: true });
  }

  cycleWeapon(dir) {
    if (!this.me) return;
    for (let k = 1; k <= WEAPONS.length; k++) {
      const i = (this.weapon + dir * k + WEAPONS.length * 2) % WEAPONS.length;
      if (this.me.ow & (1 << i)) { this.selectWeapon(i); return; }
    }
  }

  onLocalMoveEvents(ev, cmd) {
    if (!ev) return;
    const A = this.audio, R = this.renderer, P = R.palette;
    const m = this.prediction.state;
    if (ev & MoveEvent.JUMP) A.play('jump', { ui: true });
    if (ev & MoveEvent.WALLJUMP) { A.play('jump', { ui: true }); R.particles.burst(m.x, m.y + 1, m.z, 10, 4, P.cyan, 4, 0.3); }
    if (ev & MoveEvent.LAND && m.landSpeed > 6) A.play('land', { ui: true, vol: Math.min(1, m.landSpeed / 15) });
    if (ev & MoveEvent.HARD_LAND) this.renderer.shake.add(0.3);
    if (ev & MoveEvent.DASH) {
      A.play('dash', { ui: true });
      this.post.pulse = Math.max(this.post.pulse, 0.25);
      for (let k = 0; k < 10; k++) R.particles.spawn(m.x + (Math.random() - 0.5), m.y + Math.random() * 1.8, m.z + (Math.random() - 0.5), -m.vx * 0.3, 0, -m.vz * 0.3, P.cyan, 5, 0.35);
    }
    if (ev & MoveEvent.SLIDE) { A.play('slide', { ui: true }); this.lastSlideTime = this.time; }
    if (ev & MoveEvent.GRAPPLE_ATTACH) A.play('grapple', { ui: true });
    if (ev & MoveEvent.GRAPPLE_FAIL) A.play('grapple_fail', { ui: true });
    if (ev & MoveEvent.GRAPPLE_LAUNCH) { A.play('dash', { ui: true }); this.post.pulse = Math.max(this.post.pulse, 0.3); }
    if (ev & MoveEvent.PAD) { A.play('dash', { ui: true }); R.rings.add({ x: m.x, y: m.y, z: m.z, r0: 0.5, r1: 3, life: 0.4, color: P.cyan, face: 'up' }); }
    void cmd;
  }

  /** Cosmetic, client-side mirror of weapon timing for instant feedback. */
  previewWeapon(cmd) {
    const cw = this.cw, me = this.me, dt = SIM.DT;
    cw.cooldown = Math.max(0, cw.cooldown - dt);
    const def = WEAPONS[this.weapon];
    const fireHeld = (cmd.buttons & BTN.FIRE) !== 0;
    const pressed = fireHeld && !cw.prevFire;
    cw.prevFire = fireHeld;
    if (!me || !me.al || me.dn > 0 || this.ui.upgradeOpen) { cw.charging = false; return; }
    const reloading = me.rl >= 0 || me.w !== this.weapon;
    const ammo = def.magazine > 0 ? me.am[this.weapon] - this.pendingShots.length : 1;
    if (reloading) { cw.charging = false; this.audio.chargeTone(-1); return; }
    if ((cmd.buttons & BTN.RELOAD_P) && def.magazine > 0) return;
    if (def.type === WeaponType.CHARGE) {
      if (fireHeld && cw.cooldown <= 0 && ammo > 0) {
        cw.charging = true;
        cw.charge = Math.min(1, cw.charge + dt / def.chargeTime);
        this.audio.chargeTone(cw.charge);
      } else if (!fireHeld && cw.charging) {
        this.fireFx(def, cw.charge, cmd);
        cw.charging = false;
        cw.charge = 0;
        this.audio.chargeTone(-1);
      }
      return;
    }
    if (!fireHeld || cw.cooldown > 0) return;
    if (!def.auto && !pressed) return;
    if (ammo <= 0) { if (pressed) this.audio.play('empty', { ui: true }); return; }
    this.fireFx(def, 0, cmd);
  }

  fireFx(def, charge, cmd) {
    const cw = this.cw, R = this.renderer, P = R.palette, m = this.prediction.state;
    cw.cooldown = def.fireInterval;
    if (def.magazine > 0) this.pendingShots.push(cmd.seq);
    cw.recoil = Math.min(1, cw.recoil + (def.recoil || 0.02) * 6);
    cw.muzzle = 1;
    this.vm.muzzleColor = _color(R, def.color);
    const eyeYv = m.y + this.eyeHeight;
    const d = dirFromYawPitch(this.yaw, this.pitch, _dir);
    if (def.type === WeaponType.MELEE) {
      const since = this.time - cw.lastSwing;
      const onBeat = since >= def.timingWindowStart && since <= def.timingWindowEnd;
      cw.lastSwing = this.time;
      cw.swing = 1;
      this.audio.play(onBeat ? 'blades_beat' : 'blades', { ui: true });
      R.rings.add({ x: m.x + d.x * 1.6, y: eyeYv - 0.3 + d.y * 1.6, z: m.z + d.z * 1.6, r0: 0.4, r1: 1.8, life: 0.18, color: onBeat ? P.amber : P.mint, face: 'camera', thickness: 0.12 });
      return;
    }
    this.audio.play(def.sfx, { ui: true });
    // Visual recoil kick on the camera (does not change the authoritative aim).
    this.recoilKick = (def.recoil || 0.01) * (this.settings.reducedFlashes ? 0.5 : 1);
    if (def.type === WeaponType.PROJECTILE) return; // the server orb appears in the next snapshot
    const color = _color(R, def.color);
    // muzzle origin approximated in world space
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const ox = m.x + d.x * 0.6 + rx * 0.22, oy = eyeYv - 0.18 + d.y * 0.6, oz = m.z + d.z * 0.6 + rz * 0.22;
    if (def.type === WeaponType.PELLETS) {
      for (let i = 0; i < 6; i++) {
        const sx = d.x + (Math.random() - 0.5) * def.spreadBase * 2, sy = d.y + (Math.random() - 0.5) * def.spreadBase * 2, sz = d.z + (Math.random() - 0.5) * def.spreadBase * 2;
        R.tracer(ox, oy, oz, ox + sx * 6, oy + sy * 6, oz + sz * 6, color, 0.03, 0.08);
      }
      return;
    }
    const hit = raycastArena(this.env, m.x, eyeYv, m.z, d.x, d.y, d.z, def.range, m.phaseTimer > 0, false);
    const t = hit.t >= 0 ? hit.t : def.range;
    const ex = m.x + d.x * t, ey = eyeYv + d.y * t, ez = m.z + d.z * t;
    const width = def.type === WeaponType.CHARGE ? 0.06 + charge * 0.12 : 0.03;
    const beamColor = def.type === WeaponType.CHARGE ? (charge >= 0.99 ? P.amber : charge > 0.5 ? P.magenta : P.violet) : color;
    R.tracer(ox, oy, oz, ex, ey, ez, beamColor, width, def.type === WeaponType.CHARGE ? 0.35 : 0.09);
    if (hit.t >= 0) R.impact(ex, ey, ez, beamColor, def.type === WeaponType.CHARGE ? 18 : 5, 5);
    if (def.type === WeaponType.CHARGE) this.renderer.shake.add(0.1 + charge * 0.2);
  }

  /* ---------------------------------------------------------------- */
  /* training: tutorial + telemetry                                     */
  /* ---------------------------------------------------------------- */

  tutorialHit(id) {
    if (this.tutorialStep < 0 || this.tutorialStep >= TUTORIAL.length) return;
    if (TUTORIAL[this.tutorialStep].id === id) {
      this.tutorialStep++;
      this.audio.play('pickup', { ui: true });
    }
  }

  tutorialTick(cmd, ev) {
    const m = this.prediction.state;
    const hs = Math.hypot(m.vx, m.vz);
    if (cmd.mx || cmd.mz) this.tutorialDist += hs * SIM.DT;
    if (this.tutorialDist > 6) this.tutorialHit('move');
    if ((cmd.buttons & BTN.SPRINT) && hs > 11) this.tutorialHit('sprint');
    if (ev & MoveEvent.JUMP) {
      this.tutorialHit('jump');
      if (this.time - this.lastSlideTime < 0.9) this.tutorialHit('slidejump');
    }
    if (ev & MoveEvent.SLIDE) this.tutorialHit('slide');
    if (ev & MoveEvent.DASH) this.tutorialHit('dash');
    if (ev & MoveEvent.WALLJUMP) this.tutorialHit('walljump');
    if (ev & MoveEvent.GRAPPLE_ATTACH) this.tutorialHit('grapple');
    if (ev & MoveEvent.GRAPPLE_LAUNCH) this.tutorialHit('launch');
    if (cmd.buttons & BTN.GRAVITY_P) this.tutorialHit('gravity');
  }

  /* ---------------------------------------------------------------- */
  /* per-frame                                                          */
  /* ---------------------------------------------------------------- */

  /** Called when the pointer lock state changes or the player pauses. */
  setPaused(p) {
    this.paused = p;
    if (p) this.audio.chargeTone(-1);
  }

  frame(rawDt) {
    const dt = Math.min(rawDt, 0.1);
    this.time += dt;
    this.frameNo++;
    this.fps = this.fps * 0.95 + (1 / Math.max(rawDt, 1e-3)) * 0.05;
    this.frameMs = this.frameMs * 0.9 + rawDt * 1000 * 0.1;

    // ---- look (client-owned, applied every frame for smoothness) ----
    const look = this.input.consumeLook();
    const wheel = this.input.consumeWheel();
    if (this.acceptingInput) {
      // zoomed in: turn slower in proportion, so the target stays under the same hand movement
      const sens = BASE_SENSITIVITY * this.settings.sensitivity * (this.settings.fov / 95) * this.zoom;
      this.yaw -= look.x * sens;
      this.pitch -= look.y * sens * (this.settings.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -1.5, 1.5);
      if (wheel) this.cycleWeapon(wheel > 0 ? 1 : -1);
    }
    if (this.recoilKick) {
      this.pitch = clamp(this.pitch + this.recoilKick * 0.6, -1.5, 1.5);
      this.recoilKick = 0;
    }

    // ---- fixed simulation ticks ----
    // Local matches pause while the pause menu is open; online matches keep
    // running (the player idles) because the server never stops.
    const simulate = !(this.isLocal && this.paused);
    if (simulate) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= SIM.DT && n < 6) {
        this.tick();
        this.acc -= SIM.DT;
        n++;
      }
      if (n === 6) this.acc = 0;
    }
    this.flushInputs(dt);
    this.prediction.decay(dt);

    this.render(dt);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.05;
      this.updateHud();
    }
  }

  render(dt) {
    const R = this.renderer, P = R.palette, m = this.prediction.state;
    const now = performance.now();
    this.clock.update(dt);
    const renderTick = this.clock.renderTick(now);
    interpolateCategory(this.buffer, renderTick, '_p', 1, 4, this.rPlayers, this.frameNo);
    interpolateCategory(this.buffer, renderTick, '_e', 2, 5, this.rEnemies, this.frameNo);

    const alpha = this.isLocal && this.paused ? 1 : clamp(this.acc / SIM.DT, 0, 1);
    const pos = this.prediction.renderPosition(alpha, _pos);
    const targetEye = m.slideTimer > 0 ? PLAYER.SLIDE_EYE_HEIGHT : (m.dead ? 0.4 : PLAYER.EYE_HEIGHT);
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 14);
    const hs = Math.hypot(m.vx, m.vz);
    const grounded = m.onGround && !m.slideTimer;
    // ---- zoom: hold Aim (right mouse / touch Aim) to look down the sights ----
    const zdef = WEAPONS[this.weapon];
    const meNow = this.me;
    const wantZoom = zdef.zoom < 1 && this.acceptingInput && (this.input.isHeld('alt') || this.input.zoomToggled) && !!(meNow && meNow.al && !(meNow.dn > 0) && !(meNow.rl >= 0));
    this.zoom += ((wantZoom ? zdef.zoom : 1) - this.zoom) * Math.min(1, dt * 14);
    const ads = zdef.zoom < 1 ? clamp((1 - this.zoom) / (1 - zdef.zoom), 0, 1) : 0;
    const scoped = zdef.zoom < 0.5 && ads > 0.85;
    if (ads > 0.6) this.tutorialHit('zoom');
    this.ui.setScope(scoped);
    const bobAmp = (this.settings.reducedFlashes ? 0 : grounded ? clamp(hs / 13, 0, 1) : 0) * (1 - ads);
    this.vm.bob += dt * hs * 0.9;
    const bob = Math.sin(this.vm.bob * 2) * 0.035 * bobAmp;

    R.beginFrame(dt, this.time);
    const fovKick = clamp((hs - 12) / 18, 0, 1) * 8 + (m.phaseTimer > 0 ? 4 : 0);
    const roll = m.state === MoveState.WALLRUN ? 0.08 * Math.sign(m.wallNx * Math.cos(this.yaw) - m.wallNz * Math.sin(this.yaw)) : 0;
    const dc = this.debugCamera; // optional fixed camera for automated screenshots (debug builds only)
    if (dc) R.setCamera(dc.x, dc.y, dc.z, dc.yaw, dc.pitch, this.settings.fov);
    else R.setCamera(pos.x, pos.y + this.eyeHeight + bob, pos.z, this.yaw, this.pitch, zoomFov(this.settings.fov + fovKick, this.zoom));
    R.camera.rotation.z += dc ? 0 : roll;

    // ---- world entities ----
    R.drawPlayers(this.rPlayers, this.myId, this.names, pos);
    R.drawEnemies(this.rEnemies, this.hitFlash);
    this.drawProjectiles();
    const w = this.lastSnapshot;
    if (w) {
      R.drawPickups(w.pk);
      R.drawHazards(w.hz);
      R.fractureFx.update(w.f, this.time, P, R.rings);
    }
    // local grapple rope
    if (m.grappling) R.rope(pos.x + Math.cos(this.yaw) * 0.3, pos.y + this.eyeHeight - 0.35, pos.z - Math.sin(this.yaw) * 0.3, m.gx, m.gy, m.gz, P.cyan, 0.03, 0.12, 0.95);
    this.drawTethers(pos);
    this.drawSweeps(dt);
    // speed lines (momentum readability)
    if (hs > 17 && R.particles.capacity > 0 && Math.random() < (hs - 17) / 10) {
      const d = dirFromYawPitch(this.yaw, this.pitch, _dir);
      const a = Math.random() * Math.PI * 2;
      R.particles.spawn(pos.x + d.x * 6 + Math.cos(a) * 2.5, pos.y + this.eyeHeight + Math.sin(a) * 1.8, pos.z + d.z * 6 - Math.sin(a) * 2.5, -m.vx * 1.5, -m.vy, -m.vz * 1.5, P.cyan, 3, 0.25, 0, 0, 0.5);
    }

    // ---- viewmodel ----
    const cw = this.cw;
    cw.recoil = Math.max(0, cw.recoil - dt * 6);
    cw.muzzle = Math.max(0, cw.muzzle - dt * 18);
    cw.swing = Math.max(0, cw.swing - dt * 4);
    cw.switchAnim = Math.max(0, cw.switchAnim - dt * 5);
    const me = this.me;
    const vm = this.vm;
    vm.weapon = this.weapon;
    vm.bobAmp = bobAmp;
    vm.sway.x += ((-(this.lastYaw ?? this.yaw) + this.yaw) * -0.8 - vm.sway.x) * Math.min(1, dt * 10);
    vm.sway.y += ((-(this.lastPitch ?? this.pitch) + this.pitch) * -0.5 - vm.sway.y) * Math.min(1, dt * 10);
    vm.sway.x = clamp(vm.sway.x, -0.06, 0.06);
    vm.sway.y = clamp(vm.sway.y, -0.05, 0.05);
    this.lastYaw = this.yaw;
    this.lastPitch = this.pitch;
    vm.recoil = cw.recoil;
    vm.reload = me && me.rl >= 0 ? Math.sin(me.rl * Math.PI) : 0;
    vm.switch = cw.switchAnim;
    vm.swing = Math.sin(cw.swing * Math.PI);
    vm.charge = cw.charge;
    vm.muzzle = cw.muzzle;
    vm.ads = ads;
    vm.visible = !!(me && me.al && !(me.dn > 0)) && !scoped;
    R.drawViewmodel(vm);

    // ---- post-processing state ----
    const post = this.post;
    post.damage = Math.max(0, post.damage - dt * 2.2);
    post.pulse = Math.max(0, post.pulse - dt * 1.6);
    post.flash = Math.max(0, post.flash - dt * 3);
    post.phase += ((m.phaseTimer > 0 ? 1 : 0) - post.phase) * Math.min(1, dt * 8);
    const hpFrac = me ? me.hp / Math.max(1, me.mhp) : 1;
    post.lowHealth = me && me.al ? clamp((0.35 - hpFrac) / 0.35, 0, 1) : 0;
    post.reactor = w && w.rc !== undefined ? w.rc / 100 : 1;
    post.speed = clamp((hs - 15) / 12, 0, 1); // comic speed lines at high velocity
    this.ui.setPhaseOverlay(m.phaseTimer > 0);
    this.audio.setLowHealth(post.lowHealth > 0.3);
    R.render(dt, post);

    this.audio.setListener(pos.x, pos.y + this.eyeHeight, pos.z, this.yaw);
    this.audio.update(dt);
  }

  /** Projectiles are extrapolated to the present from the newest snapshot so dodging is accurate. */
  drawProjectiles() {
    const w = this.buffer.newest;
    const map = this.projMap || (this.projMap = new Map());
    map.clear();
    if (!w) { this.renderer.drawProjectiles(map, false); return; }
    const ahead = clamp((this.clock.now(performance.now()) - w.k) / SIM.TICK_RATE, 0, 0.25);
    const pool = this.projPool || (this.projPool = []);
    let i = 0;
    for (const r of w.pr) {
      let o = pool[i];
      if (!o) { o = { raw: null, x: 0, y: 0, z: 0 }; pool[i] = o; }
      o.raw = r;
      o.x = r[2] + r[5] * ahead; o.y = r[3] + r[6] * ahead; o.z = r[4] + r[7] * ahead;
      map.set(r[0], o);
      i++;
    }
    this.renderer.drawProjectiles(map, this.prediction.state.phaseTimer > 0);
  }

  /** Co-op Quantum Tether lines; colour shows stress (cyan -> amber -> red). */
  drawTethers(myPos) {
    if (this.mode !== MODES.COOP) return;
    const R = this.renderer, P = R.palette;
    const pos = (id) => (id === this.myId ? myPos : this.rPlayers.get(id));
    const c = this.tetherColor || (this.tetherColor = P.cyan.clone());
    for (const [id, o] of this.rPlayers) {
      const partner = o.raw[13];
      if (!partner || id > partner) continue;
      const a = pos(id), b = pos(partner);
      if (!a || !b) continue;
      const stress = o.raw[15] / 100;
      if (stress < 0.5) c.copy(P.cyan).lerp(P.amber, stress * 2);
      else c.copy(P.amber).lerp(P.danger, (stress - 0.5) * 2);
      R.rope(a.x, a.y + 1.1, a.z, b.x, b.y + 1.1, b.z, c, 0.05 + stress * 0.03, 0.2 + stress * 0.6, 0.7);
    }
  }

  /** Titan beam sweeps: telegraph line, then the rotating active beam. */
  drawSweeps(dt) {
    const R = this.renderer, P = R.palette;
    for (let i = this.sweeps.length - 1; i >= 0; i--) {
      const s = this.sweeps[i];
      s.t += dt;
      if (s.t > s.tele + s.active) { this.sweeps.splice(i, 1); continue; }
      const len = 48;
      if (s.t < s.tele) {
        const a = s.angle;
        R.ribbons.transient(s.x, s.y, s.z, s.x + Math.cos(a) * len, s.y, s.z + Math.sin(a) * len, P.danger.r, P.danger.g, P.danger.b, 0.35 + 0.3 * Math.sin(this.time * 30), 0.1);
        const end = s.angle + s.sweep;
        R.ribbons.transient(s.x, s.y, s.z, s.x + Math.cos(end) * len * 0.3, s.y, s.z + Math.sin(end) * len * 0.3, P.danger.r, P.danger.g, P.danger.b, 0.25, 0.06);
      } else {
        const a = s.angle + s.sweep * clamp((s.t - s.tele) / s.active, 0, 1);
        R.ribbons.transient(s.x, s.y, s.z, s.x + Math.cos(a) * len, s.y, s.z + Math.sin(a) * len, P.magenta.r, P.magenta.g, P.magenta.b, 1, 0.45);
        R.ribbons.transient(s.x, s.y, s.z, s.x + Math.cos(a) * len, s.y, s.z + Math.sin(a) * len, 1, 1, 1, 0.8, 0.12);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                                */
  /* ---------------------------------------------------------------- */

  updateHud() {
    const me = this.me, m = this.match, ms = this.prediction.state;
    if (!me) return;
    const def = WEAPONS[this.weapon];
    const timer = this.formatTimer(m);
    let objective = '';
    let boss = null;
    for (const [, o] of this.rEnemies) if (o.raw[1] === 6) boss = o.raw[6];
    if (this.mode === MODES.SURVIVAL) objective = m.ph === 'wave' ? `${m.el} hostiles remain` : m.ph === 'upgrade' ? 'Choose an upgrade' : m.ph === 'over' ? '' : 'Rifts stabilising…';
    else if (this.mode === MODES.COOP) objective = m.ph === 'wave' ? `Defend the reactor · ${m.el} hostiles` : m.ph === 'intermission' ? 'Regroup — upgrades available' : m.ph === 'countdown' ? 'Waiting for the rift to open' : '';
    else if (this.mode === MODES.FFA) objective = m.ph === 'warmup' ? `Warm-up · waiting for players (${m.np}/${m.mn})` : m.ph === 'countdown' ? 'Match starting' : m.ph === 'active' ? 'Most points wins' : '';
    else if (this.mode === MODES.TRAINING) objective = 'Press E to summon a practice squad';

    const hs = Math.hypot(ms.vx, ms.vz);
    const lastInput = this.prediction.history[Math.max(0, this.seq - 1) % this.prediction.history.length].input;
    const spread = def ? computeSpread(def, hs, !ms.onGround, (lastInput.buttons & BTN.ALT) !== 0) : 0;
    const ammo = def.magazine > 0 ? Math.max(0, me.am[this.weapon] - this.pendingShots.length) : -1;
    const rtt = Math.round(this.transport.rtt || 0);
    const score = this.mode === MODES.FFA ? `${me.st.k} K · ${me.st.d} D · ${me.st.s} pts` : this.mode === MODES.TRAINING ? `${me.st.dmg} dmg dealt` : `${(m.sc ?? me.st.s).toLocaleString()} pts`;
    this.ui.updateHud({
      modeLabel: `${MODE_LABELS[this.mode]} · ${arenaName(this.arena.id)}${this.isLocal || !this.welcome.room ? '' : ` · Room ${this.welcome.room}`}`,
      timer,
      objective,
      reactor: this.mode === MODES.COOP && this.lastSnapshot ? this.lastSnapshot.rc : undefined,
      boss,
      hp: me.hp, mhp: me.mhp, sh: me.sh, msh: me.msh,
      pulse: me.pc, phased: ms.phaseTimer > 0,
      moveState: ms.state,
      weapon: this.weapon, ammo, mag: me.mg[this.weapon], reload: me.w === this.weapon ? me.rl : -1, owned: me.ow,
      abilities: {
        grapple: ms.grappleCooldown / PLAYER.GRAPPLE_COOLDOWN,
        melee: me.cd[1] / PULSE.MELEE_COOLDOWN,
        gravity: me.cd[0] / (this.mode === MODES.TRAINING ? 2 : PULSE.GRAVITY_ABILITY_COOLDOWN),
        dash: ms.dashCharges > 0 ? ms.dashCooldown / PLAYER.DASH_COOLDOWN : 1,
      },
      score,
      combo: me.cb,
      net: this.isLocal ? 'OFFLINE' : `${rtt} ms`,
      netBad: !this.isLocal && rtt > 150,
      fps: Math.round(this.fps),
      spread,
      charge: this.cw.charging ? this.cw.charge : 0,
    });

    // teammates (co-op)
    if (this.mode === MODES.COOP) {
      const mates = [];
      for (const [id, o] of this.rPlayers) {
        if (id === this.myId) continue;
        mates.push({ id, name: this.names.get(id) || 'Runner', hp: o.raw[8], downed: !!(o.raw[7] & PF.DOWNED), tethered: o.raw[13] === this.myId });
      }
      this.ui.updateTeam(mates);
      // revive prompt
      let near = null;
      for (const [id, o] of this.rPlayers) {
        if (id === this.myId || !(o.raw[7] & PF.DOWNED)) continue;
        if (Math.hypot(o.x - ms.x, o.y - ms.y, o.z - ms.z) < 2.8) near = id;
      }
      if (near) this.ui.setPrompt(`Hold ${'E'} to revive ${this.names.get(near) || 'teammate'}`, me.rv);
      else this.ui.setPrompt('');
    }

    // training telemetry
    if (this.mode === MODES.TRAINING) {
      const v = Math.hypot(ms.vx, ms.vy, ms.vz);
      const dv = Math.hypot(ms.vx - this.lastVel.x, ms.vy - this.lastVel.y, ms.vz - this.lastVel.z) / 0.05;
      this.accel = this.accel * 0.7 + dv * 0.3;
      this.lastVel.x = ms.vx; this.lastVel.y = ms.vy; this.lastVel.z = ms.vz;
      while (this.damageLog.length && this.time - this.damageLog[0][0] > 3) this.damageLog.shift();
      const dps = this.damageLog.reduce((a, d) => a + d[1], 0) / 3;
      this.ui.updateTraining([
        ['FPS', `${Math.round(this.fps)}`],
        ['Latency', this.isLocal ? '0 ms (offline)' : `${rtt} ms`],
        ['Speed', `${hs.toFixed(1)} m/s (3D ${v.toFixed(1)})`],
        ['Vertical', `${ms.vy.toFixed(1)} m/s`],
        ['Accel', `${this.accel.toFixed(0)} m/s²`],
        ['State', ['Grounded', 'Falling', 'Jumping', 'Sliding', 'Wall-run', 'Grappling', 'Dashing', 'Phased', 'Stunned', 'Dead'][ms.state]],
        ['DPS (3s)', dps.toFixed(0)],
        ['Damage', `${me.st.dmg}`],
        ['Accuracy', `${me.st.acc}%`],
        ['Weak-pt hits', `${me.st.hs}`],
        ['Sensitivity', this.settings.sensitivity.toFixed(2)],
      ]);
      if (this.tutorialStep >= 0) this.ui.updateTutorial(TUTORIAL, this.tutorialStep);
    }

    // debug overlay
    if (this.settings.debug) {
      const st = this.renderer.stats();
      const w = this.lastSnapshot;
      let mem = '';
      if (performance.memory) {
        const used = performance.memory.usedJSHeapSize / 1048576, lim = performance.memory.jsHeapSizeLimit / 1048576;
        mem = `\nheap      ${used.toFixed(0)} / ${lim.toFixed(0)} MB${used / lim > 0.8 ? '  ⚠ HIGH' : ''}`;
      } else mem = '\nheap      n/a (browser does not expose memory)';
      this.ui.updateDebug(
        `fps       ${this.fps.toFixed(0)}\nframe     ${this.frameMs.toFixed(2)} ms\nsrv tick  ${w ? w.st : 0} ms\nping      ${this.isLocal ? 'local' : rtt + ' ms'}\n` +
        `entities  ${this.rPlayers.size}p ${this.rEnemies.size}e ${w ? w.pr.length : 0}proj ${w ? w.f.length : 0}frac\n` +
        `draws     ${st.calls}  tris ${st.triangles}\nparticles ${st.particles}\nsnapbuf   ${this.buffer.snaps.length}  corr ${this.prediction.corrections} (${this.prediction.lastCorrection.toFixed(3)} m)\n` +
        `interp    ${Math.round(this.clock.delayTicks * 1000 / SIM.TICK_RATE)} ms  jitter ${Math.round(this.clock.jitterTicks * 1000 / SIM.TICK_RATE)} ms\n` +
        `srv input buffer ${me.nb ? `${me.nb[1]}/${me.nb[0]}` : '-'} ticks\n` +
        `seq ${this.seq} ack ${me.a}  state ${ms.state}${mem}`,
      );
    }
  }

  formatTimer(m) {
    if (this.mode === MODES.SURVIVAL || this.mode === MODES.COOP) {
      if (m.ph === 'countdown' || m.ph === 'intermission') return `${m.w ? `WAVE ${m.w + 1}` : 'WAVE 1'} IN ${Math.ceil(m.t)}`;
      const t = m.tt ?? 0;
      return `WAVE ${m.w || 1}${m.wt ? `/${m.wt}` : ''}${this.mode === MODES.SURVIVAL ? ` · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : ''}`;
    }
    if (this.mode === MODES.FFA) {
      if (m.ph === 'warmup') return 'WARM-UP';
      const t = Math.ceil(m.t);
      return `${m.ph === 'countdown' ? 'STARTS IN ' : ''}${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }
    return 'TRAINING';
  }

  showScoreboard(show) {
    if (!show) { this.ui.hideScoreboard(); return; }
    let rows = this.scoreboard;
    if (!rows.length && this.me) rows = [[this.myId, this.names.get(this.myId) || 'You', this.me.st.k, this.me.st.d, this.me.st.a, this.me.st.s, this.me.st.sk, 0, 0]];
    this.ui.showScoreboard(rows, `${MODE_LABELS[this.mode]} — ${arenaName(this.arena.id)}`, this.myId);
  }

  dispose() {
    this.audio.chargeTone(-1);
    this.audio.setLowHealth(false);
    this.transport.close();
    this.renderer.clearTransient();
  }
}

/** Cached THREE.Color lookup for weapon colours (avoids per-shot allocation). */
const _colorCache = new Map();
function _color(R, hex) {
  let c = _colorCache.get(hex);
  if (!c) { c = R.palette.white.clone().setHex(hex); _colorCache.set(hex, c); }
  return c;
}

