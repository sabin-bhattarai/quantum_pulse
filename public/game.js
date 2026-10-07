/**
 * Quantum Pulse — browser entry point.
 *
 * Boots the app: feature detection (WebGL / WebSocket), settings, renderer,
 * input, audio and UI; starts and ends matches; owns the
 * requestAnimationFrame loop. Gameplay itself lives in /client/GameClient.js
 * (presentation) and the authoritative simulation (server or offline Room).
 */
import { Renderer } from './renderer.js';
import { InputManager, DEFAULT_BINDINGS } from './input.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { WebSocketTransport, LocalTransport } from './network.js';
import { GameClient } from '/client/GameClient.js';
import { MODES, PROTOCOL_VERSION } from '/shared/constants.js';
import { ARENA_IDS } from '/shared/arenas.js';

const SETTINGS_KEY = 'qp.settings.v1';
const BEST_KEY = 'qp.best.v1';

/** Defaults and validation schema for persisted settings. */
const SCHEMA = {
  name: { def: '', type: 'string' },
  arena: { def: 'neon_rupture', enum: ARENA_IDS },
  sensitivity: { def: 1, min: 0.1, max: 4 },
  fov: { def: 95, min: 70, max: 120 },
  invertY: { def: false },
  showFps: { def: false },
  debug: { def: false },
  quality: { def: 'high', enum: ['high', 'medium', 'low'] },
  particles: { def: 'high', enum: ['high', 'medium', 'low', 'off'] },
  renderScale: { def: 1, min: 0.5, max: 1 },
  postFx: { def: true },
  chromatic: { def: true },
  screenShake: { def: true },
  master: { def: 0.8, min: 0, max: 1 },
  music: { def: 0.5, min: 0, max: 1 },
  sfx: { def: 0.8, min: 0, max: 1 },
  ui: { def: 0.7, min: 0, max: 1 },
  mute: { def: false },
  colorblind: { def: false },
  reducedFlashes: { def: false },
  highContrastHud: { def: false },
  hudScale: { def: 1, min: 0.75, max: 1.4 },
  crosshairSize: { def: 1, min: 0.6, max: 2 },
  holdToGrapple: { def: false },
};

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

/** Load settings, discarding anything malformed. */
function loadSettings() {
  const raw = storageGet(SETTINGS_KEY) || {};
  const s = {};
  for (const [k, spec] of Object.entries(SCHEMA)) {
    const v = raw[k];
    if (spec.enum) s[k] = spec.enum.includes(v) ? v : spec.def;
    else if (typeof spec.def === 'boolean') s[k] = typeof v === 'boolean' ? v : spec.def;
    else if (typeof spec.def === 'number') s[k] = typeof v === 'number' && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.def;
    else s[k] = typeof v === 'string' ? v.slice(0, 16) : spec.def;
  }
  // Bindings: keep only known actions with string codes.
  s.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  if (raw.bindings && typeof raw.bindings === 'object') {
    for (const a of Object.keys(DEFAULT_BINDINGS)) {
      const list = raw.bindings[a];
      if (Array.isArray(list)) s.bindings[a] = list.slice(0, 2).map((c) => (typeof c === 'string' && c.length < 32 ? c : null));
    }
  }
  // First run: honour the OS reduced-motion preference (shake, bob, flashes).
  if (typeof raw.reducedFlashes !== 'boolean' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    s.reducedFlashes = true;
  }
  // Lower defaults automatically on small / low-power devices.
  if (!storageGet(SETTINGS_KEY) && (navigator.hardwareConcurrency || 8) <= 4) {
    s.quality = 'medium';
    s.particles = 'medium';
  }
  return s;
}

function defaultSettings() {
  const s = {};
  for (const [k, spec] of Object.entries(SCHEMA)) s[k] = spec.def;
  s.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  return s;
}

class App {
  constructor() {
    this.settings = loadSettings();
    this.client = null;
    this.last = performance.now();
    this.lastStart = null;
    this.starting = false;
  }

  init() {
    const canvas = document.getElementById('game-canvas');
    if (location.protocol === 'file:') {
      this.fatalScreen('Quantum Pulse must be served over HTTP.<br>Run <code>npm install</code> then <code>npm start</code> and open <code>http://localhost:3000</code>.');
      return;
    }
    if (!Renderer.supported()) {
      this.fatalScreen('Your browser or GPU does not support WebGL, which Quantum Pulse needs.<br>Try a current Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
      return;
    }
    this.input = new InputManager(this.settings);
    this.input.attach(canvas);
    this.audio = new AudioEngine(this.settings);
    try {
      this.renderer = new Renderer(canvas, this.settings);
    } catch (err) {
      console.error(err);
      this.fatalScreen('Failed to start the WebGL renderer. Enable hardware acceleration or try another browser.');
      return;
    }
    this.ui = new UI(this.settings, this.input);
    document.getElementById('build-info').textContent = `protocol ${PROTOCOL_VERSION}`;
    this.wireUi();
    this.wireInput();
    this.checkServer();
    // Unlock audio on the first interaction anywhere.
    const unlock = () => {
      if (this.audio.ensure()) this.audio.setMusic(this.client ? 'calm' : 'menu');
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.client && this.client.isLocal) this.pause();
    });
    requestAnimationFrame((t) => this.loop(t));
  }

  fatalScreen(html) {
    const f = document.getElementById('fatal');
    f.hidden = false;
    f.innerHTML = html; // static developer-authored message
  }

  /** Probe the server for online availability. */
  async checkServer() {
    if (!WebSocketTransport.supported()) {
      this.ui.setOnlineAvailable(false, 'WebSockets are not supported by this browser');
      this.ui.setNetStatus('Online play unavailable: no WebSocket support.', 'offline');
      return;
    }
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      const info = await res.json();
      if (info.protocol !== PROTOCOL_VERSION) {
        this.ui.setOnlineAvailable(false, 'Client and server versions differ — reload the page');
        this.ui.setNetStatus('Server version mismatch: reload the page.', 'offline');
        return;
      }
      this.ui.setOnlineAvailable(true);
      this.ui.setNetStatus(`Online · ${info.players} runner${info.players === 1 ? '' : 's'} in ${info.rooms} room${info.rooms === 1 ? '' : 's'}`, 'online');
    } catch {
      this.ui.setOnlineAvailable(false, 'Game server unreachable');
      this.ui.setNetStatus('Server unreachable. Offline modes still work.', 'offline');
    }
  }

  wireUi() {
    const ui = this.ui;
    ui.on('click', () => { this.audio.ensure(); this.audio.play('ui_click', { ui: true }); });
    ui.on('hover', () => this.audio.play('ui_hover', { ui: true, throttle: 0.06 }));
    ui.on('settings', (key) => this.onSettingsChanged(key));
    ui.on('settings-saved', () => this.saveSettings());
    ui.on('reset-settings', () => {
      const name = this.settings.name;
      Object.assign(this.settings, defaultSettings(), { name });
      this.input.rebuildBindings();
      ui.syncSettingsInputs();
      ui.renderBindings();
      this.onSettingsChanged('all');
    });
    ui.on('best-scores', () => storageGet(BEST_KEY) || {});
    ui.on('start', (opts) => this.startMatch(opts));
    ui.on('resume', () => this.resume());
    ui.on('leave', () => this.leaveMatch());
    ui.on('play-again', () => { const opts = this.lastStart; this.leaveMatch(); if (opts) this.startMatch(opts); });
    ui.on('upgrade', (i) => { if (this.client) this.client.chooseUpgrade(i); });
    ui.refreshBest();
  }

  wireInput() {
    this.input.on('lockchange', (locked) => {
      if (!this.client) return;
      if (locked) {
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        this.ui.hidePause();
        this.client.setPaused(false);
      } else if (!this.ui.upgradeOpen && !this.ui.resultsOpen && !document.querySelector('#screen-settings.active')) {
        this.pause();
      }
    });
    this.input.on('action', (action, down) => {
      if (!this.client) return;
      if (action === 'scoreboard') this.client.showScoreboard(down && this.input.locked);
    });
    document.getElementById('game-canvas').addEventListener('click', () => {
      if (this.client && !this.input.locked && !this.ui.upgradeOpen && !this.ui.resultsOpen) this.resume();
    });
  }

  onSettingsChanged(key) {
    if (['quality', 'particles', 'renderScale', 'colorblind', 'fov', 'screenShake', 'reducedFlashes', 'all'].includes(key)) this.renderer.applySettings();
    if (['master', 'music', 'sfx', 'ui', 'mute', 'all'].includes(key)) this.audio.applySettings();
    this.ui.applyBodyClasses();
    this.saveSettings();
  }

  saveSettings() {
    storageSet(SETTINGS_KEY, this.settings);
  }

  /* ---------------------------------------------------------------- */
  /* best scores (localStorage)                                        */
  /* ---------------------------------------------------------------- */

  getBest(arenaId) {
    const all = storageGet(BEST_KEY) || {};
    return all[arenaId] || null;
  }

  /** Save if better. Returns true when a new best was recorded. */
  saveBest(arenaId, run) {
    const all = storageGet(BEST_KEY) || {};
    const prev = all[arenaId];
    if (prev && prev.score >= run.score) return false;
    all[arenaId] = { score: run.score, wave: run.wave, time: run.time, date: new Date().toISOString() };
    storageSet(BEST_KEY, all);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* match lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  async startMatch(opts) {
    if (this.starting || this.client) return;
    this.starting = true;
    this.lastStart = opts;
    this.audio.ensure();
    const name = (this.settings.name || '').trim() || 'Pulse Runner';
    const online = opts.mode === MODES.FFA || opts.mode === MODES.COOP;
    const transport = online
      ? new WebSocketTransport({ name, mode: opts.mode, room: opts.room || '', arena: opts.arena || null })
      : new LocalTransport({ name, mode: opts.mode, arena: opts.arena || 'neon_rupture' });
    this.ui.loading(online ? 'Connecting to the rift…' : 'Folding reality…');
    try {
      const welcome = await transport.connect();
      this.client = new GameClient({
        transport, welcome, renderer: this.renderer, input: this.input, audio: this.audio, ui: this.ui, settings: this.settings,
        options: { tutorial: !!opts.tutorial },
        hooks: {
          onExit: (reason) => { this.leaveMatch(); if (reason) this.ui.toast(reason, true, 5000); },
          saveBest: (a, r) => this.saveBest(a, r),
          getBest: (a) => this.getBest(a),
        },
      });
      this.ui.loading(null);
      this.input.requestLock();
      if (!this.input.locked) this.ui.showPause('Click Resume (or the game view) to capture the mouse.');
    } catch (err) {
      console.error(err);
      transport.close();
      this.ui.loading(null);
      this.ui.toast(err && err.message ? err.message : 'Could not start the match', true, 5000);
      this.checkServer();
    } finally {
      this.starting = false;
    }
  }

  pause() {
    if (!this.client) return;
    this.client.setPaused(true);
    this.client.showScoreboard(false);
    this.ui.showPause(this.client.isLocal ? 'The simulation is paused.' : 'Online matches keep running while paused.');
  }

  resume() {
    if (!this.client) return;
    this.input.requestLock();
  }

  leaveMatch() {
    if (!this.client) return;
    this.client.dispose();
    this.client = null;
    this.input.exitLock();
    this.ui.exitGame();
    this.ui.refreshBest();
    this.audio.setMusic('menu');
    this.checkServer();
  }

  loop(now) {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (this.client) {
      try {
        this.client.frame(dt);
      } catch (err) {
        console.error(err);
        this.leaveMatch();
        this.ui.toast('Unexpected error — returned to menu. See console for details.', true, 6000);
      }
    }
    requestAnimationFrame((t) => this.loop(t));
  }
}

const app = new App();
app.init();
// Test hook for automated browser checks: only exposed with ?debug in the URL.
if (new URLSearchParams(location.search).has('debug')) window.__qp = app;
