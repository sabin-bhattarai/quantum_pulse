/**
 * Quantum Pulse — on-screen touch controls.
 *
 * A thin input source: every control maps onto InputManager actions (the same
 * ones the keyboard drives), so gameplay code does not know touch exists.
 *
 * Layout (landscape):
 *   - left ~42% of the screen: floating movement stick (appears under the thumb)
 *   - everywhere else: drag to look; FIRE also aims while held, like a trigger
 *   - right-thumb cluster: fire, jump, slide, dash, grapple, aim toggle, reload, swap
 *   - row under the vitals: Phase Break, gravity well, melee, use; pause in the corner
 *
 * Each finger is tracked by pointerId so moving, looking and firing work at the
 * same time. The stick snaps to 8 directions because the input protocol carries
 * whole steps (-1, 0, 1); full tilt forward sprints. Sideways deflection also
 * turns the view continuously (setting "stickTurn"), like steering.
 */

/** Touch pixels -> mouse pixels for look (phones need more turn per pixel than a mouse). */
const LOOK_SCALE = 1.6;
const STICK_RADIUS = 58; // px at --k = 1
const STICK_ZONE = 0.42; // fraction of the screen width that starts the stick
const DEAD = 0.25; // stick dead zone (fraction of radius)
const AXIS = 0.38; // per-axis threshold for 8-way snapping
const SPRINT_AT = 0.92;
const TURN_DEAD = 0.15; // sideways deflection before the stick starts steering the view
const TURN_CURVE = 1.6; // >1: gentle near the centre, fast at full tilt

/** [action, label, kind, diameter, centre-from-right, centre-from-bottom, variant] */
const CLUSTER = [
  ['fire', 'Fire', 'hold', 92, 74, 84, 'primary'],
  ['jump', 'Jump', 'hold', 66, 172, 50],
  ['slide', 'Slide', 'hold', 54, 160, 132],
  ['sprint', 'Dash', 'hold', 54, 252, 56],
  ['alt', 'Aim', 'toggle', 54, 62, 186],
  ['grapple', 'Hook', 'hold', 58, 142, 210],
  ['reload', 'Reload', 'hold', 46, 40, 262],
  ['swap', 'Swap', 'tap', 46, 100, 268],
];
/** Occasional abilities, in a row under the vitals. */
const ROW = [
  ['pulse', 'Phase', 'hold', 'accent'],
  ['gravity', 'Well', 'hold'],
  ['melee', 'Melee', 'hold'],
  ['interact', 'Use', 'hold'],
];

export class TouchControls {
  /**
   * @param {import('./input.js').InputManager} input
   * @param {HTMLElement} root container (#touch-ui)
   */
  constructor(input, root) {
    this.input = input;
    this.root = root;
    this.fingers = new Map();
    this.k = 1;
    this.build();
    this.bind();
    input.on('lockchange', (locked) => { if (!locked) this.reset(); });
  }

  build() {
    const r = this.root;
    r.textContent = '';
    const button = (action, label, kind, variant) => {
      const b = document.createElement('div');
      b.className = `tc-btn${variant ? ` ${variant}` : ''}`;
      b.dataset.touch = action;
      b.dataset.kind = kind;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', label);
      b.textContent = label;
      if (label.length > 5) b.classList.add('long');
      return b;
    };
    for (const [action, label, kind, d, cr, cb, variant] of CLUSTER) {
      const b = button(action, label, kind, variant);
      b.style.setProperty('--d', d);
      b.style.setProperty('--r', cr);
      b.style.setProperty('--b', cb);
      r.appendChild(b);
    }
    const row = document.createElement('div');
    row.className = 'tc-row';
    for (const [action, label, kind, variant] of ROW) row.appendChild(button(action, label, kind, variant));
    r.appendChild(row);
    const pause = button('pause', 'Pause', 'tap', 'pause');
    pause.textContent = '';
    pause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    r.appendChild(pause);
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'tc-stick';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'tc-knob';
    this.stickBase.appendChild(this.stickKnob);
    r.appendChild(this.stickBase);
  }

  bind() {
    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.down(e));
    r.addEventListener('pointermove', (e) => this.move(e));
    r.addEventListener('pointerup', (e) => this.up(e));
    r.addEventListener('pointercancel', (e) => this.up(e));
    r.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Current control scale (--k from CSS, which tracks screen height). */
  scale() {
    return parseFloat(getComputedStyle(this.root).getPropertyValue('--k')) || 1;
  }

  down(e) {
    if (!this.input.locked) return;
    e.preventDefault();
    try { this.root.setPointerCapture(e.pointerId); } catch { /* finger already gone */ }
    const btn = e.target.closest('[data-touch]');
    if (btn) {
      this.fingers.set(e.pointerId, { kind: 'btn', el: btn, action: btn.dataset.touch, x: e.clientX, y: e.clientY });
      this.press(btn);
      return;
    }
    if (e.clientX < window.innerWidth * STICK_ZONE) {
      this.k = this.scale();
      const rad = STICK_RADIUS * this.k;
      // the stick base appears under the thumb, kept fully on screen
      const bx = Math.max(rad + 8, e.clientX);
      const by = Math.min(window.innerHeight - rad - 8, Math.max(rad + 8, e.clientY));
      this.fingers.set(e.pointerId, { kind: 'stick', bx, by });
      this.stickBase.classList.add('on');
      this.stickBase.style.left = `${bx}px`;
      this.stickBase.style.top = `${by}px`;
      this.updateStick(e.clientX, e.clientY, bx, by);
      return;
    }
    this.fingers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
  }

  move(e) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    if (f.kind === 'stick') { this.updateStick(e.clientX, e.clientY, f.bx, f.by); return; }
    // look: free drags, and FIRE doubles as a trigger you can aim with
    if (f.kind === 'look' || (f.kind === 'btn' && f.action === 'fire')) {
      this.input.addLook((e.clientX - f.x) * LOOK_SCALE, (e.clientY - f.y) * LOOK_SCALE);
      f.x = e.clientX;
      f.y = e.clientY;
    }
  }

  up(e) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    if (f.kind === 'stick') this.releaseStick();
    else if (f.kind === 'btn') this.release(f.el);
  }

  press(btn) {
    const { touch: action, kind } = btn.dataset;
    navigator.vibrate?.(8);
    if (kind === 'tap') {
      btn.classList.add('on');
      setTimeout(() => btn.classList.remove('on'), 120);
      if (action === 'swap') this.input.cycleWeapon(1);
      else if (action === 'pause') this.input.exitLock();
      return;
    }
    if (kind === 'toggle') {
      const on = !btn.classList.contains('on');
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      if (on) this.input.pressAction(action);
      else this.input.releaseAction(action);
      return;
    }
    btn.classList.add('on');
    this.input.pressAction(action);
  }

  release(btn) {
    if (btn.dataset.kind !== 'hold') return;
    btn.classList.remove('on');
    this.input.releaseAction(btn.dataset.touch);
  }

  updateStick(x, y, bx, by) {
    const rad = STICK_RADIUS * this.k;
    const dx = x - bx, dy = y - by;
    const len = Math.hypot(dx, dy);
    const m = Math.min(1, len / rad);
    const kx = len > 0 ? (dx / len) * m * rad : 0;
    const ky = len > 0 ? (dy / len) * m * rad : 0;
    this.stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    let mx = 0, mz = 0;
    if (m > DEAD) {
      const nx = dx / len, ny = dy / len;
      if (Math.abs(nx) > AXIS) mx = Math.sign(nx);
      if (Math.abs(ny) > AXIS) mz = -Math.sign(ny);
    }
    // steering: sideways deflection turns the view, so the world swings round as you move
    const hx = Math.max(-1, Math.min(1, dx / rad));
    const t = Math.max(0, (Math.abs(hx) - TURN_DEAD) / (1 - TURN_DEAD));
    this.input.setStick(mx, mz, m > SPRINT_AT && mz > 0 && mx === 0, Math.sign(hx) * t ** TURN_CURVE);
  }

  releaseStick() {
    this.input.setStick(0, 0, false, 0);
    this.stickBase.classList.remove('on');
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    this.stickKnob.style.transform = '';
  }

  /** Lock lost (pause, upgrade, results): drop every finger and visual state. */
  reset() {
    this.fingers.clear();
    this.releaseStick();
    for (const b of this.root.querySelectorAll('.tc-btn.on')) {
      b.classList.remove('on');
      if (b.dataset.kind === 'toggle') b.setAttribute('aria-pressed', 'false');
    }
  }
}
