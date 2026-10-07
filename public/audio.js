/**
 * Quantum Pulse — procedural audio.
 *
 * Every sound is synthesised at runtime with the Web Audio API, so the game
 * needs no audio files. The engine is built around named "hooks" (weapon sfx
 * ids, UI events, enemy warnings…). To use recorded assets later, register an
 * AudioBuffer under the same hook name with `registerBuffer` and it will be
 * preferred over the synthesised fallback.
 *
 * Mixing: master <- [music, sfx, ui] buses, with a gentle compressor on the
 * master to avoid clipping when many sounds overlap. Audio never blocks
 * gameplay: if the context cannot start, every call is a no-op.
 */

const MAX_VOICES = 48;
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.voices = 0;
    this.lastPlayed = new Map();
    this.buffers = new Map();
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.musicState = 'off';
    this.musicTimer = null;
    this.nextNoteTime = 0;
    this.step = 0;
    this.lowHealthOn = false;
    this.heartTimer = 0;
    this.chargeOsc = null;
  }

  /** Create the AudioContext (must be called from a user gesture). */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch {
      return false;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 4;
    this.master.connect(this.comp).connect(c.destination);
    this.musicBus = c.createGain();
    this.sfxBus = c.createGain();
    this.uiBus = c.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.uiBus.connect(this.master);
    // 1 s of white noise reused by every noisy sound
    this.noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applySettings();
    return true;
  }

  applySettings() {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.mute ? 0 : s.master, t, 0.02);
    this.musicBus.gain.setTargetAtTime(s.music * 0.55, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.02);
    this.uiBus.gain.setTargetAtTime(s.ui * 0.8, t, 0.02);
  }

  registerBuffer(name, buffer) {
    this.buffers.set(name, buffer);
  }

  setListener(x, y, z, yaw) {
    const l = this.listener;
    l.x = x; l.y = y; l.z = z; l.yaw = yaw;
  }

  /* ---------------------------------------------------------------- */
  /* primitives                                                        */
  /* ---------------------------------------------------------------- */

  /** Output node for a sound: positional (pan + distance) or plain. */
  out(bus, opts) {
    const c = this.ctx;
    const g = c.createGain();
    let vol = opts.vol ?? 1;
    if (opts.x !== undefined) {
      const l = this.listener;
      const dx = opts.x - l.x, dy = (opts.y ?? l.y) - l.y, dz = opts.z - l.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 90) return null;
      vol *= 1 / (1 + d * 0.07);
      const rx = Math.cos(l.yaw), rz = -Math.sin(l.yaw);
      const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.85 : 0;
      if (c.createStereoPanner) {
        const p = c.createStereoPanner();
        p.pan.value = pan;
        g.connect(p).connect(bus);
      } else g.connect(bus);
    } else g.connect(bus);
    g.gain.value = vol;
    return g;
  }

  voice(dur) {
    this.voices++;
    setTimeout(() => { this.voices--; }, Math.min(5000, dur * 1000 + 60));
  }

  tone(dest, type, freq, t, dur, vol, slideTo, attack = 0.004) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dest, t, dur, vol, filterType = 'bandpass', freq = 2000, q = 1, slideTo = 0) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = dur > 0.9;
    const f = c.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Play a named sound hook.
   * @param {string} name
   * @param {{x?:number,y?:number,z?:number,vol?:number,ui?:boolean,throttle?:number}} [opts]
   */
  play(name, opts = {}) {
    if (!this.ctx || this.settings.mute) return;
    if (this.voices > MAX_VOICES) return;
    const now = this.ctx.currentTime;
    const throttle = opts.throttle ?? 0.025;
    const last = this.lastPlayed.get(name) || 0;
    if (now - last < throttle) return;
    this.lastPlayed.set(name, now);
    const dest = this.out(opts.ui ? this.uiBus : this.sfxBus, opts);
    if (!dest) return;
    const buf = this.buffers.get(name);
    if (buf) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(dest);
      s.start(now);
      this.voice(buf.duration);
      return;
    }
    const fn = SYNTHS[name] || SYNTHS.blip;
    const dur = fn(this, dest, now + 0.002) || 0.3;
    this.voice(dur);
  }

  /** Lance charge hum: level in [0, 1]; pass a negative number to stop. */
  chargeTone(level) {
    if (!this.ctx) return;
    if (level < 0) {
      if (this.chargeOsc) {
        const { o, g } = this.chargeOsc;
        g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
        o.stop(this.ctx.currentTime + 0.15);
        this.chargeOsc = null;
      }
      return;
    }
    if (!this.chargeOsc) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      g.gain.value = 0.0001;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200;
      o.connect(f).connect(g).connect(this.sfxBus);
      o.start();
      this.chargeOsc = { o, g };
    }
    const t = this.ctx.currentTime;
    this.chargeOsc.o.frequency.setTargetAtTime(110 + level * 330, t, 0.03);
    this.chargeOsc.g.gain.setTargetAtTime(0.05 + level * 0.07, t, 0.03);
  }

  setLowHealth(on) {
    this.lowHealthOn = on;
  }

  /** Per-frame update (heartbeat while low on health). */
  update(dt) {
    if (!this.ctx) return;
    if (this.lowHealthOn) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        this.heartTimer = 0.85;
        this.play('heartbeat', { ui: true, throttle: 0.5 });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* music                                                             */
  /* ---------------------------------------------------------------- */

  /** Switch the procedural music state: 'menu' | 'calm' | 'combat' | 'boss' | 'off'. */
  setMusic(state) {
    if (!this.ctx || state === this.musicState) return;
    this.musicState = state;
    if (state === 'off') {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
      return;
    }
    if (!this.musicTimer) {
      this.nextNoteTime = this.ctx.currentTime + 0.1;
      this.step = 0;
      this.musicTimer = setInterval(() => this.scheduleMusic(), 30);
    }
  }

  scheduleMusic() {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const st = this.musicState;
    const bpm = st === 'boss' ? 148 : st === 'combat' ? 128 : st === 'calm' ? 96 : 84;
    const stepDur = 60 / bpm / 4; // 16th notes
    const root = 50; // D3
    const prog = st === 'boss' ? [0, 1, -2, -4] : [0, -4, 3, -2];
    const scale = [0, 3, 5, 7, 10, 12, 15];
    while (this.nextNoteTime < c.currentTime + 0.15) {
      const t = this.nextNoteTime;
      const s = this.step;
      const bar = Math.floor(s / 16) % 4;
      const chordRoot = root + prog[bar];
      const bus = this.musicBus;
      if (st === 'menu' || st === 'calm') {
        if (s % 16 === 0) {
          for (const iv of [0, 7, 15]) this.tone(bus, 'triangle', NOTE(chordRoot + iv + 12), t, stepDur * 15, 0.035, 0, 0.6);
          this.tone(bus, 'sine', NOTE(chordRoot - 12), t, stepDur * 15, 0.06, 0, 0.3);
        }
        if (s % 4 === 2) this.tone(bus, 'sine', NOTE(chordRoot + 24 + scale[(s * 3) % scale.length]), t, stepDur * 2, 0.018);
      } else {
        // kick
        if (s % 4 === 0) this.tone(bus, 'sine', 140, t, 0.18, 0.22, 42);
        // hats
        if (s % 2 === 1) this.noise(bus, t, 0.04, 0.03, 'highpass', 8000, 0.7);
        // snare-ish
        if (s % 8 === 4) this.noise(bus, t, 0.12, 0.07, 'bandpass', 1800, 0.8);
        // bass
        if (s % 2 === 0) this.tone(bus, st === 'boss' ? 'sawtooth' : 'square', NOTE(chordRoot - 12 + (s % 8 === 6 ? 12 : 0)), t, stepDur * 1.6, 0.05);
        // arpeggio
        const arp = scale[(s * (st === 'boss' ? 5 : 3)) % scale.length];
        this.tone(bus, 'triangle', NOTE(chordRoot + 12 + arp), t, stepDur * 0.9, st === 'boss' ? 0.03 : 0.022);
        if (st === 'boss' && s % 16 === 0) this.tone(bus, 'sawtooth', NOTE(chordRoot - 24), t, stepDur * 14, 0.05, 0, 0.1);
      }
      this.nextNoteTime += stepDur;
      this.step++;
    }
  }
}

/* -------------------------------------------------------------------- */
/* Synth recipes. Each returns its duration in seconds.                  */
/* -------------------------------------------------------------------- */
const SYNTHS = {
  blip(a, d, t) { a.tone(d, 'sine', 880, t, 0.08, 0.15); return 0.1; },
  carbine(a, d, t) { a.noise(d, t, 0.06, 0.32, 'bandpass', 3200, 1.2); a.tone(d, 'square', 520, t, 0.05, 0.08, 180); return 0.08; },
  scatter(a, d, t) { a.noise(d, t, 0.22, 0.5, 'lowpass', 2400, 0.8, 300); a.tone(d, 'sawtooth', 160, t, 0.18, 0.12, 60); return 0.25; },
  lance(a, d, t) { a.tone(d, 'sawtooth', 1400, t, 0.35, 0.18, 120); a.noise(d, t, 0.3, 0.2, 'highpass', 4000, 0.5); return 0.4; },
  singularity(a, d, t) { a.tone(d, 'sine', 300, t, 0.6, 0.3, 50); a.tone(d, 'triangle', 600, t, 0.4, 0.08, 90); return 0.65; },
  blades(a, d, t) { a.noise(d, t, 0.16, 0.3, 'bandpass', 1200, 2, 6000); return 0.2; },
  blades_beat(a, d, t) { a.noise(d, t, 0.16, 0.3, 'bandpass', 1200, 2, 6000); a.tone(d, 'triangle', 1320, t, 0.12, 0.1); return 0.2; },
  echo(a, d, t) { a.tone(d, 'square', 700, t, 0.07, 0.1, 350); a.noise(d, t, 0.05, 0.18, 'bandpass', 2600, 1.5); return 0.1; },
  echo_repeat(a, d, t) { a.tone(d, 'sine', 1040, t, 0.12, 0.08, 520); return 0.14; },
  reload(a, d, t) { a.noise(d, t, 0.04, 0.2, 'bandpass', 3000, 4); a.noise(d, t + 0.18, 0.05, 0.22, 'bandpass', 2200, 4); a.tone(d, 'sine', 300, t + 0.3, 0.06, 0.06, 600); return 0.4; },
  empty(a, d, t) { a.noise(d, t, 0.03, 0.15, 'highpass', 5000, 1); return 0.05; },
  hit(a, d, t) { a.tone(d, 'square', 1800, t, 0.04, 0.07); return 0.05; },
  headshot(a, d, t) { a.tone(d, 'triangle', 1500, t, 0.06, 0.12); a.tone(d, 'triangle', 2250, t + 0.05, 0.08, 0.1); return 0.15; },
  kill(a, d, t) { a.tone(d, 'triangle', 880, t, 0.12, 0.14); a.tone(d, 'triangle', 1320, t + 0.06, 0.16, 0.12); return 0.24; },
  hurt(a, d, t) { a.tone(d, 'sine', 160, t, 0.18, 0.35, 70); a.noise(d, t, 0.1, 0.12, 'lowpass', 800, 1); return 0.2; },
  jump(a, d, t) { a.noise(d, t, 0.1, 0.06, 'bandpass', 900, 1, 2200); return 0.12; },
  land(a, d, t) { a.tone(d, 'sine', 110, t, 0.1, 0.12, 50); return 0.12; },
  hard_land(a, d, t) { a.tone(d, 'sine', 90, t, 0.4, 0.4, 30); a.noise(d, t, 0.35, 0.3, 'lowpass', 600, 1, 80); return 0.45; },
  dash(a, d, t) { a.noise(d, t, 0.22, 0.2, 'bandpass', 600, 1.2, 4000); return 0.25; },
  slide(a, d, t) { a.noise(d, t, 0.45, 0.08, 'lowpass', 1500, 0.7, 400); return 0.5; },
  grapple(a, d, t) { a.tone(d, 'sawtooth', 300, t, 0.15, 0.08, 1400); a.noise(d, t, 0.12, 0.08, 'highpass', 3000, 1); return 0.2; },
  grapple_fail(a, d, t) { a.tone(d, 'square', 240, t, 0.08, 0.06, 140); return 0.1; },
  pulse(a, d, t) { a.tone(d, 'sawtooth', 80, t, 1.0, 0.25, 900); a.tone(d, 'sine', 55, t, 1.0, 0.35, 30); a.noise(d, t, 0.8, 0.15, 'bandpass', 400, 0.6, 5000); return 1.05; },
  fracture(a, d, t) { a.tone(d, 'sine', 70, t, 1.2, 0.3, 140); a.tone(d, 'triangle', 220, t, 0.9, 0.06, 90); return 1.25; },
  explosion(a, d, t) { a.noise(d, t, 0.6, 0.55, 'lowpass', 1800, 0.8, 120); a.tone(d, 'sine', 120, t, 0.5, 0.35, 35); return 0.65; },
  enemy_shot(a, d, t) { a.tone(d, 'square', 420, t, 0.09, 0.06, 900); return 0.1; },
  enemy_warn(a, d, t) { a.tone(d, 'square', 660, t, 0.1, 0.1); a.tone(d, 'square', 520, t + 0.12, 0.12, 0.1); return 0.26; },
  stalker(a, d, t) { a.tone(d, 'sine', 1400, t, 0.8, 0.12, 300); a.tone(d, 'triangle', 1410, t, 0.8, 0.05, 290); return 0.85; },
  charge_warn(a, d, t) { a.tone(d, 'sawtooth', 200, t, 0.9, 0.1, 700); return 0.9; },
  boss(a, d, t) { a.tone(d, 'sawtooth', 73, t, 1.6, 0.3, 65); a.tone(d, 'sawtooth', 110, t, 1.6, 0.18, 98); return 1.7; },
  wave(a, d, t) { [0, 4, 7, 12].forEach((n, i) => a.tone(d, 'triangle', NOTE(62 + n), t + i * 0.08, 0.3, 0.1)); return 0.6; },
  enemy_die(a, d, t) { a.noise(d, t, 0.2, 0.18, 'bandpass', 2500, 2, 400); a.tone(d, 'square', 900, t, 0.12, 0.05, 200); return 0.22; },
  pickup(a, d, t) { a.tone(d, 'sine', 990, t, 0.1, 0.1); a.tone(d, 'sine', 1480, t + 0.07, 0.12, 0.1); return 0.2; },
  near_miss(a, d, t) { a.noise(d, t, 0.18, 0.12, 'bandpass', 3000, 3, 900); return 0.2; },
  ring(a, d, t) { a.tone(d, 'sine', 1320, t, 0.3, 0.12); a.tone(d, 'sine', 1980, t + 0.05, 0.3, 0.08); return 0.36; },
  heartbeat(a, d, t) { a.tone(d, 'sine', 60, t, 0.12, 0.35, 40); a.tone(d, 'sine', 55, t + 0.18, 0.12, 0.25, 38); return 0.32; },
  deflect(a, d, t) { a.tone(d, 'triangle', 2400, t, 0.15, 0.15, 1200); a.noise(d, t, 0.08, 0.2, 'highpass', 6000, 1); return 0.18; },
  revive(a, d, t) { [0, 5, 9, 12].forEach((n, i) => a.tone(d, 'sine', NOTE(72 + n), t + i * 0.06, 0.25, 0.08)); return 0.5; },
  downed(a, d, t) { a.tone(d, 'sawtooth', 300, t, 0.8, 0.15, 60); return 0.8; },
  arena_pulse(a, d, t) { a.tone(d, 'sine', 50, t, 1.4, 0.4, 25); a.noise(d, t, 1.2, 0.2, 'lowpass', 400, 1, 60); return 1.4; },
  ui_click(a, d, t) { a.tone(d, 'triangle', 1100, t, 0.05, 0.08); return 0.06; },
  ui_hover(a, d, t) { a.tone(d, 'sine', 1600, t, 0.03, 0.03); return 0.04; },
  streak(a, d, t) { [0, 7, 12, 19].forEach((n, i) => a.tone(d, 'square', NOTE(67 + n), t + i * 0.05, 0.12, 0.05)); return 0.35; },
  melee(a, d, t) { a.noise(d, t, 0.18, 0.3, 'lowpass', 900, 1, 200); a.tone(d, 'sine', 140, t, 0.2, 0.25, 60); return 0.22; },
};
