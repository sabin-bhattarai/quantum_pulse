/**
 * Quantum Pulse — input layer.
 *
 * Physical devices (keyboard + mouse today) are mapped to ACTIONS through a
 * rebindable binding table. Game code only ever asks about actions, so adding
 * a gamepad or touch source later means writing another source that sets the
 * same action states — nothing in the gameplay code changes.
 *
 * Pointer lock is used for aiming; mouse deltas are accumulated between frames.
 * Touch devices have no pointer lock, so there `locked` is a virtual state that
 * the on-screen controls (public/touch.js) toggle, and they feed actions, look
 * deltas and a movement stick through the same API.
 */
import { BTN } from '/shared/constants.js';

/** Action ids and their default bindings (KeyboardEvent.code or Mouse<button>). */
export const DEFAULT_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], // double-tap for a long jump (air dash)
  sprint: [], // sprint is automatic (setting); bind a key here to sprint manually or air-dash
  slide: ['KeyC', 'ControlLeft'],
  grapple: ['KeyQ'],
  interact: ['KeyE'],
  melee: ['KeyF'],
  reload: ['KeyR'],
  gravity: ['KeyG'],
  pulse: ['KeyX'],
  fire: ['Mouse0'],
  alt: ['Mouse2'],
  zoom: ['ShiftLeft', 'ShiftRight'],
  scoreboard: ['Tab'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  weapon5: ['Digit5'],
  weapon6: ['Digit6'],
});

export const ACTION_LABELS = Object.freeze({
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right', jump: 'Jump / wall-jump / launch (double-tap: long jump)',
  sprint: 'Sprint / air dash (optional)', slide: 'Slide', grapple: 'Grapple', interact: 'Interact / revive', melee: 'Melee pulse',
  reload: 'Reload', gravity: 'Gravity well', pulse: 'Phase Break', fire: 'Fire', alt: 'Aim (hold to zoom) / deflect', zoom: 'Zoom (tap to toggle)', scoreboard: 'Scoreboard',
  weapon1: 'Weapon 1', weapon2: 'Weapon 2', weapon3: 'Weapon 3', weapon4: 'Weapon 4', weapon5: 'Weapon 5', weapon6: 'Weapon 6',
});

/** Human readable label for a binding code. */
export function codeLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][Number(code.slice(5))] || code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return { Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', Tab: 'Tab', AltLeft: 'L-Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] || code;
}

/**
 * Phones and tablets get on-screen controls. `?touch=1` / `?touch=0` in the
 * URL forces the choice (useful on hybrid laptops and for testing).
 */
export function detectTouch() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1' || forced === '0') return forced === '1';
  return !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
}

/** Two jump presses closer than this make a long jump (an air dash). */
const DOUBLE_TAP_MS = 300;

/** Touch steering: mouse-pixels per second of look at full sideways stick (~125 deg/s at sensitivity 1). */
const STICK_TURN_RATE = 1000;

/** Edge-triggered actions that map to "pressed" bits in the input command. */
const PRESS_BITS = {
  jump: BTN.JUMP_P, slide: BTN.SLIDE_P, grapple: BTN.GRAPPLE_P, sprint: BTN.DASH_P, melee: BTN.MELEE_P,
  reload: BTN.RELOAD_P, gravity: BTN.GRAVITY_P, pulse: BTN.PULSE_P, interact: BTN.INTERACT_P,
};
const HOLD_BITS = {
  jump: BTN.JUMP, sprint: BTN.SPRINT, slide: BTN.SLIDE, grapple: BTN.GRAPPLE, fire: BTN.FIRE, alt: BTN.ALT, interact: BTN.INTERACT,
};

export class InputManager {
  /** @param {object} settings live settings object (bindings, sensitivity, invertY) */
  constructor(settings) {
    this.settings = settings;
    this.codeToActions = new Map();
    this.held = new Set();
    this.pressedActions = new Set();
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = false;
    this.canvas = null;
    this.listeners = { lockchange: [], action: [] };
    this.captureCb = null;
    this.extraPressBits = 0;
    this.touch = detectTouch();
    this.stick = { mx: 0, mz: 0, sprint: false, turn: 0 };
    this.zoomToggled = false; // tap Zoom (Shift) to toggle; RMB zooms while held
    this.lastJumpAt = 0;
    this.lastLookAt = performance.now();
    this.rebuildBindings();
    this.bind();
  }

  rebuildBindings() {
    this.codeToActions.clear();
    const b = this.settings.bindings;
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      for (const code of b[action] || []) {
        if (!code) continue;
        if (!this.codeToActions.has(code)) this.codeToActions.set(code, []);
        this.codeToActions.get(code).push(action);
      }
    }
  }

  on(evt, cb) { this.listeners[evt].push(cb); }
  emit(evt, ...args) { for (const cb of this.listeners[evt]) cb(...args); }

  attach(canvas) {
    this.canvas = canvas;
  }

  requestLock() {
    if (this.touch) { this.setTouchLock(true); return; }
    if (!this.canvas || document.pointerLockElement === this.canvas) return;
    try {
      const r = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof r.catch === 'function') r.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignored */ } });
    } catch {
      try { this.canvas.requestPointerLock(); } catch { /* unsupported */ }
    }
  }

  exitLock() {
    if (this.touch) { this.setTouchLock(false); return; }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Touch devices: enter or leave play without pointer lock. Emits the same lockchange event. */
  setTouchLock(on) {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) {
      this.releaseAll();
      this.setStick(0, 0, false, 0);
    }
    this.emit('lockchange', on);
  }

  /** Capture the next key / mouse button (used by the rebinding UI). */
  captureNext(cb) {
    this.captureCb = cb;
  }

  bind() {
    window.addEventListener('keydown', (e) => this.onDown(e.code, e), { capture: true });
    window.addEventListener('keyup', (e) => this.onUp(e.code));
    window.addEventListener('mousedown', (e) => {
      if (this.captureCb) { this.finishCapture(`Mouse${e.button}`); e.preventDefault(); return; }
      // Taps on touch devices also fire compatibility mouse events; the on-screen controls handle those.
      if (!this.locked || this.touch) return;
      this.onDown(`Mouse${e.button}`, e);
    });
    window.addEventListener('mouseup', (e) => this.onUp(`Mouse${e.button}`));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || this.touch) return;
      // Ignore absurd spikes some browsers report when pointer lock engages.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.locked || this.touch) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.locked || this.enabled) e.preventDefault(); });
    window.addEventListener('blur', () => { this.releaseAll(); if (this.touch) this.setTouchLock(false); });
    // Pointer lock ends by itself when the tab is hidden; the virtual touch lock has to be released here.
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.touch) this.setTouchLock(false); });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas && !!this.canvas;
      if (!this.locked) this.releaseAll();
      this.emit('lockchange', this.locked);
    });
  }

  finishCapture(code) {
    const cb = this.captureCb;
    this.captureCb = null;
    cb(code);
  }

  onDown(code, e) {
    if (this.captureCb) {
      e.preventDefault();
      e.stopPropagation();
      this.finishCapture(code === 'Escape' ? null : code);
      return;
    }
    const tag = e && e.target && e.target.tagName;
    if (!this.locked && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) return;
    const actions = this.codeToActions.get(code);
    if (!actions) return;
    // While playing, game keys must not reach the page: Tab would move focus and
    // Space would "click" whichever menu button last had focus.
    if ((this.locked || this.enabled) && e && code !== 'Escape') e.preventDefault();
    for (const a of actions) {
      if (!this.held.has(a)) { this.pressedActions.add(a); this.onPress(a); }
      this.held.add(a);
      this.emit('action', a, true);
    }
  }

  /**
   * A fresh press of an action. Zoom toggles; a second jump within
   * DOUBLE_TAP_MS adds an air-dash press, which is the long jump.
   */
  onPress(a) {
    if (!this.locked && !this.enabled) return;
    if (a === 'zoom') {
      this.zoomToggled = !this.zoomToggled;
    } else if (a === 'jump') {
      const now = performance.now();
      if (now - this.lastJumpAt < DOUBLE_TAP_MS) { this.extraPressBits |= BTN.DASH_P; this.lastJumpAt = 0; }
      else this.lastJumpAt = now;
    }
  }

  onUp(code) {
    const actions = this.codeToActions.get(code);
    if (!actions) return;
    for (const a of actions) {
      this.held.delete(a);
      this.emit('action', a, false);
    }
  }

  /* ---- touch controls feed actions through these (same semantics as a key) ---- */

  pressAction(action) {
    if (!this.held.has(action)) { this.pressedActions.add(action); this.onPress(action); }
    this.held.add(action);
    this.emit('action', action, true);
  }

  releaseAction(action) {
    if (this.held.delete(action)) this.emit('action', action, false);
  }

  /** Look delta in mouse-pixel units (already scaled for touch). */
  addLook(dx, dy) {
    this.lookX += dx;
    this.lookY += dy;
  }

  /**
   * Movement stick: mx / mz in {-1, 0, 1} (the protocol carries whole steps); sprint at full tilt.
   * `turn` in [-1, 1] steers the view while the stick is held sideways.
   */
  setStick(mx, mz, sprint, turn = 0) {
    this.stick.mx = mx;
    this.stick.mz = mz;
    this.stick.sprint = sprint;
    this.stick.turn = turn;
  }

  cycleWeapon(dir) {
    this.wheel += dir;
  }

  releaseAll() {
    for (const a of this.held) this.emit('action', a, false);
    this.held.clear();
    this.zoomToggled = false;
  }

  isHeld(action) {
    return this.held.has(action);
  }

  /** Mouse delta since last call, in pixels (plus touch steering, which turns continuously while held). */
  consumeLook() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastLookAt) / 1000);
    this.lastLookAt = now;
    if (this.stick.turn && this.settings.stickTurn !== false) this.lookX += this.stick.turn * STICK_TURN_RATE * dt;
    const x = this.lookX, y = this.lookY;
    this.lookX = 0;
    this.lookY = 0;
    return { x, y };
  }

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Inject an edge bit into the next sample (e.g. hold-to-grapple release). */
  injectPress(bits) {
    this.extraPressBits |= bits;
  }

  /**
   * Build the movement axes and button bitmask for one simulation step.
   * Pressed (edge) bits are cleared after being sampled once.
   */
  sample() {
    let buttons = this.extraPressBits;
    this.extraPressBits = 0;
    if (this.locked || this.enabled) {
      for (const a of this.held) if (HOLD_BITS[a]) buttons |= HOLD_BITS[a];
      for (const a of this.pressedActions) if (PRESS_BITS[a]) buttons |= PRESS_BITS[a];
    }
    const active = this.locked || this.enabled;
    let weaponSelect = -1;
    if (active) for (let i = 1; i <= 6; i++) if (this.pressedActions.has(`weapon${i}`)) weaponSelect = i - 1;
    this.pressedActions.clear();
    if (!active) return { mx: 0, mz: 0, buttons, weaponSelect };
    let mz = (this.held.has('forward') ? 1 : 0) - (this.held.has('back') ? 1 : 0);
    let mx = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    if (!mx && !mz) {
      mx = this.stick.mx;
      mz = this.stick.mz;
      if (this.stick.sprint) buttons |= BTN.SPRINT;
    }
    // Sprint is automatic when running forward (setting "Always sprint").
    if (mz > 0 && this.settings.autoSprint !== false) buttons |= BTN.SPRINT;
    return { mx, mz, buttons, weaponSelect };
  }
}
