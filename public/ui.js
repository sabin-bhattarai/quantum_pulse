/**
 * Quantum Pulse — DOM user interface.
 *
 * All DOM writes during gameplay go through small caches (`setText`,
 * `setStyle`, `toggleClass`) so an element is only touched when its value
 * actually changes. The HUD is refreshed at ~20 Hz, not every frame.
 */
import { WEAPONS } from '/shared/weapons.js';
import { ARENA_IDS, arenaName } from '/shared/arenas.js';
import { LIMITS, MOVE_STATE_NAMES } from '/shared/constants.js';
import { upgradeInfo } from '/shared/upgrades.js';
import { DEFAULT_BINDINGS, ACTION_LABELS, codeLabel } from '/input.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const ARENA_TAGLINES = {
  neon_rupture: 'Floating city fragments over the void',
  folded_archive: 'Library stacks & phase barriers',
  reactor_null: 'Reactor core, energy channels, cover',
};

/** Escape text for safe insertion into HTML (names come from other players). */
export function esc(s) {
  return String(s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

export class UI {
  /**
   * @param {object} settings
   * @param {import('./input.js').InputManager} input
   */
  constructor(settings, input) {
    this.settings = settings;
    this.input = input;
    this.handlers = {};
    this.cache = new Map();
    this.screenStack = ['menu'];
    this.arenaChoice = { solo: settings.arena || 'neon_rupture', ffa: null, training: 'neon_rupture' };
    this.killfeedEl = $('#killfeed');
    this.centerTimer = 0;
    this.toastTimer = 0;
    this.upgradeChoices = null;
    this.bindDom();
    this.buildArenaPickers();
    this.buildWeaponList();
    this.renderBindings();
    this.syncSettingsInputs();
    this.menuBg = new MenuBackground($('#menu-bg'));
    this.menuBg.start();
  }

  on(action, cb) { this.handlers[action] = cb; }
  emit(action, data) { if (this.handlers[action]) this.handlers[action](data); }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  bindDom() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      this.emit('click');
      switch (a) {
        case 'open-solo': this.showScreen('solo'); break;
        case 'open-online': this.showScreen('online'); break;
        case 'open-coop': this.showScreen('coop'); break;
        case 'open-training': this.showScreen('training'); break;
        case 'open-settings': this.openSettings(); break;
        case 'open-howto': this.showScreen('howto'); break;
        case 'open-credits': this.showScreen('credits'); break;
        case 'back': this.back(); break;
        case 'close-settings': this.closeSettings(); break;
        case 'reset-bindings':
          this.settings.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
          this.input.rebuildBindings();
          this.renderBindings();
          this.emit('settings');
          break;
        case 'reset-settings': this.emit('reset-settings'); break;
        case 'start-solo': this.emit('start', { mode: 'survival', arena: this.arenaChoice.solo }); break;
        case 'start-ffa': this.emit('start', { mode: 'ffa', arena: this.arenaChoice.ffa, room: $('#input-room-ffa').value.trim() }); break;
        case 'start-coop': this.emit('start', { mode: 'coop', room: $('#input-room-coop').value.trim() }); break;
        case 'start-training': this.emit('start', { mode: 'training', arena: this.arenaChoice.training, tutorial: $('#chk-tutorial').checked }); break;
        default: this.emit(a); break;
      }
    });
    document.addEventListener('mouseover', (e) => {
      if (e.target.closest && e.target.closest('.btn, .ucard, .arena-card')) this.emit('hover');
    });
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('[data-tab-body]').forEach((b) => { b.hidden = b.dataset.tabBody !== t.dataset.tab; });
    }));
    $$('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      const evt = el.type === 'range' ? 'input' : 'change';
      el.addEventListener(evt, () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range') v = Number(el.value);
        else v = el.value;
        this.settings[key] = v;
        this.updateOutputs();
        this.emit('settings', key);
      });
    });
    const nameInput = $('#input-name');
    nameInput.value = this.settings.name || '';
    nameInput.addEventListener('change', () => { this.settings.name = nameInput.value.trim().slice(0, 16); this.emit('settings', 'name'); });
    for (const id of ['#input-room-ffa', '#input-room-coop']) {
      $(id).addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
    }
    $('#upgrade-cards').addEventListener('click', (e) => {
      const card = e.target.closest('.ucard');
      if (card) this.emit('upgrade', Number(card.dataset.index));
    });
  }

  /* ---------------------------------------------------------------- */
  /* screens                                                           */
  /* ---------------------------------------------------------------- */

  showScreen(name) {
    const target = `screen-${name}`;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === target));
    if (this.screenStack[this.screenStack.length - 1] !== name) this.screenStack.push(name);
    if (name === 'menu') this.screenStack = ['menu'];
    const inMenus = !!document.querySelector('.screen.active');
    this.menuBg.setVisible(inMenus && !this.inGame);
    if (name === 'solo') this.refreshBest();
  }

  back() {
    this.screenStack.pop();
    const prev = this.screenStack[this.screenStack.length - 1] || 'menu';
    if (prev === 'game') { this.hideScreens(); this.emit('settings-closed'); return; }
    this.showScreen(prev);
  }

  hideScreens() {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    this.menuBg.setVisible(false);
  }

  openSettings() {
    this.syncSettingsInputs();
    if (this.inGame) {
      this.screenStack = ['game'];
      $('#pause').hidden = true;
    }
    this.showScreen('settings');
  }

  closeSettings() {
    this.emit('settings-saved');
    if (this.inGame) {
      this.hideScreens();
      this.screenStack = ['menu'];
      $('#pause').hidden = false;
      return;
    }
    this.back();
  }

  enterGame() {
    this.inGame = true;
    this.hideScreens();
    $('#hud').hidden = false;
    this.cache.clear();
    this.killfeedEl.textContent = '';
    $('#team-status').textContent = '';
  }

  exitGame() {
    this.inGame = false;
    $('#hud').hidden = true;
    for (const id of ['#pause', '#results', '#upgrade', '#scoreboard', '#downed', '#loading']) $(id).hidden = true;
    $('#phase-overlay').classList.remove('on');
    this.showScreen('menu');
  }

  /* ---------------------------------------------------------------- */
  /* settings UI                                                       */
  /* ---------------------------------------------------------------- */

  syncSettingsInputs() {
    $$('[data-setting]').forEach((el) => {
      const v = this.settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    });
    this.updateOutputs();
    this.applyBodyClasses();
  }

  updateOutputs() {
    const fmt = { sensitivity: (v) => v.toFixed(2), fov: (v) => `${v}°`, renderScale: (v) => `${Math.round(v * 100)}%`, hudScale: (v) => `${Math.round(v * 100)}%`, crosshairSize: (v) => `${Math.round(v * 100)}%` };
    $$('[data-out]').forEach((o) => {
      const k = o.dataset.out;
      const v = this.settings[k];
      o.textContent = fmt[k] ? fmt[k](v) : `${Math.round(v * 100)}%`;
    });
    this.applyBodyClasses();
  }

  applyBodyClasses() {
    const s = this.settings;
    document.body.classList.toggle('cb', !!s.colorblind);
    document.body.classList.toggle('hc', !!s.highContrastHud);
    document.body.classList.toggle('reduced-motion', !!s.reducedFlashes);
    document.documentElement.style.setProperty('--hud-scale', String(s.hudScale || 1));
    $('#crosshair').style.setProperty('--ch-scale', String(s.crosshairSize || 1));
    $('#hud-fps').hidden = !s.showFps;
    $('#debug-overlay').hidden = !s.debug;
    $$('kbd[data-bind]').forEach((k) => { k.textContent = codeLabel((s.bindings[k.dataset.bind] || [])[0]); });
  }

  renderBindings() {
    const root = $('#bindings');
    root.textContent = '';
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      const row = document.createElement('div');
      row.className = 'binding';
      const label = document.createElement('span');
      label.textContent = ACTION_LABELS[action];
      row.appendChild(label);
      const wrap = document.createElement('span');
      for (let slot = 0; slot < 2; slot++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = codeLabel((this.settings.bindings[action] || [])[slot]);
        b.addEventListener('click', () => {
          b.classList.add('listening');
          b.textContent = '…';
          this.input.captureNext((code) => {
            b.classList.remove('listening');
            if (code) {
              // A key may only drive one action: remove it elsewhere first.
              for (const a of Object.keys(this.settings.bindings)) {
                this.settings.bindings[a] = (this.settings.bindings[a] || []).map((c) => (c === code ? null : c));
              }
              const list = this.settings.bindings[action] || [];
              list[slot] = code;
              this.settings.bindings[action] = list;
              this.input.rebuildBindings();
              this.emit('settings', 'bindings');
            }
            this.renderBindings();
          });
        });
        wrap.appendChild(b);
      }
      row.appendChild(wrap);
      root.appendChild(row);
    }
    this.applyBodyClasses();
  }

  buildArenaPickers() {
    $$('.arena-picker').forEach((picker) => {
      const key = picker.dataset.for;
      const options = key === 'ffa' ? [null, ...ARENA_IDS] : ARENA_IDS;
      picker.textContent = '';
      for (const id of options) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'arena-card';
        const b = document.createElement('b');
        b.textContent = id ? arenaName(id) : 'Any arena';
        const sm = document.createElement('small');
        sm.textContent = id ? ARENA_TAGLINES[id] : 'Quick match on the server rotation';
        card.append(b, sm);
        card.classList.toggle('selected', this.arenaChoice[key] === id);
        card.addEventListener('click', () => {
          this.arenaChoice[key] = id;
          if (key === 'solo') { this.settings.arena = id; this.emit('settings', 'arena'); this.refreshBest(); }
          picker.querySelectorAll('.arena-card').forEach((c) => c.classList.toggle('selected', c === card));
        });
        picker.appendChild(card);
      }
    });
  }

  buildWeaponList() {
    const root = $('#weapon-list');
    root.textContent = '';
    for (const w of WEAPONS) {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = `${w.slot}. ${w.name}`;
      d.append(b, document.createTextNode(` — ${w.description}`));
      root.appendChild(d);
    }
  }

  /** Best local scores (localStorage), shown on the menu and solo panel. */
  refreshBest() {
    const best = this.emitQuery('best-scores') || {};
    const lines = [];
    for (const id of ARENA_IDS) {
      const b = best[id];
      if (b) lines.push(`${arenaName(id)}: ${b.score.toLocaleString()} pts · wave ${b.wave}`);
    }
    $('#best-score').textContent = lines.length ? `BEST RUNS\n${lines.join('\n')}` : 'No survival runs yet — enter the rift.';
  }

  emitQuery(name) {
    return this.handlers[name] ? this.handlers[name]() : null;
  }

  setNetStatus(text) {
    $('#net-status').textContent = text;
  }

  setOnlineAvailable(ok, reason) {
    for (const id of ['#btn-online', '#btn-coop']) {
      $(id).disabled = !ok;
      if (!ok) $(id).title = reason;
    }
  }

  /* ---------------------------------------------------------------- */
  /* overlays                                                          */
  /* ---------------------------------------------------------------- */

  toast(msg, isError = false, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  loading(text) {
    $('#loading').hidden = !text;
    if (text) $('#loading-text').textContent = text;
  }

  fatal(html) {
    const f = $('#fatal');
    f.hidden = false;
    f.innerHTML = html; // static, developer-authored strings only
  }

  centerMessage(text, sub = '', ms = 2200) {
    const c = $('#center-msg'), s = $('#sub-msg');
    c.textContent = text;
    s.textContent = sub;
    c.classList.add('show');
    s.classList.toggle('show', !!sub);
    clearTimeout(this.centerTimer);
    this.centerTimer = setTimeout(() => { c.classList.remove('show'); s.classList.remove('show'); }, ms);
  }

  killfeed(killer, victim, weapon, flags, isMe) {
    const el = document.createElement('div');
    el.className = `kf${isMe ? ' me' : ''}`;
    const k = document.createElement('span'); k.className = 'k'; k.textContent = killer || '☄ environment';
    const w = document.createElement('span'); w.className = 'w';
    const tags = [];
    if (flags & 1) tags.push('◎');
    if (flags & 2) tags.push('✈');
    if (flags & 4) tags.push('⟳');
    w.textContent = `[${weapon}${tags.length ? ' ' + tags.join('') : ''}]`;
    const v = document.createElement('span'); v.className = 'v'; v.textContent = victim;
    el.append(k, w, v);
    this.killfeedEl.prepend(el);
    while (this.killfeedEl.children.length > LIMITS.KILLFEED) this.killfeedEl.lastChild.remove();
    setTimeout(() => el.remove(), 6000);
  }

  hitmarker(kind) {
    const h = $('#hitmarker');
    h.className = 'hitmarker';
    void h.offsetWidth; // restart the CSS animation
    h.className = `hitmarker show ${kind || ''}`;
  }

  /** Damage direction arc. `angle` is relative to the camera (0 = in front). */
  damageIndicator(angle) {
    const root = $('#damage-indicators');
    if (root.children.length > 6) root.firstChild.remove();
    const d = document.createElement('div');
    d.className = 'dmg-ind';
    d.style.transform = `rotate(${angle}rad)`;
    root.appendChild(d);
    setTimeout(() => d.remove(), 1000);
  }

  showUpgrade(ids) {
    const key = ids ? ids.join(',') : '';
    if (key === this.upgradeKey) return;
    this.upgradeKey = key;
    const el = $('#upgrade');
    if (!ids) { el.hidden = true; return; }
    const root = $('#upgrade-cards');
    root.textContent = '';
    ids.forEach((id, i) => {
      const info = upgradeInfo(id) || { name: id, desc: '' };
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `ucard${info.weapon !== undefined ? ' weapon' : ''}`;
      card.dataset.index = String(i);
      const k = document.createElement('kbd'); k.textContent = String(i + 1);
      const h = document.createElement('h3'); h.textContent = info.name;
      const p = document.createElement('p'); p.textContent = info.desc;
      card.append(k, h, p);
      root.appendChild(card);
    });
    el.hidden = false;
  }

  get upgradeOpen() {
    return !$('#upgrade').hidden;
  }

  showPause(note) {
    $('#pause-note').textContent = note || '';
    $('#pause').hidden = false;
  }

  hidePause() {
    $('#pause').hidden = true;
  }

  get pauseOpen() {
    return !$('#pause').hidden;
  }

  showScoreboard(rows, title, myId) {
    $('#sb-title').textContent = title;
    const body = $('#sb-body');
    body.textContent = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r[0] === myId) tr.className = 'me';
      if (r[8] >= 2) tr.classList.add('dead');
      const status = r[8] === 1 ? ' (downed)' : r[8] === 3 ? ' (reconnecting)' : '';
      for (const v of [i + 1, r[1] + status, r[2], r[3], r[4], r[5], r[6], `${r[7]}ms`]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    $('#scoreboard').hidden = false;
  }

  hideScoreboard() {
    $('#scoreboard').hidden = true;
  }

  /**
   * Post-match / run results.
   * @param {object} res results from the server rules
   * @param {object} extra {myId, best, isNewBest, canReplay}
   */
  showResults(res, extra) {
    $('#results-title').textContent = res.title || 'Results';
    const sum = $('#results-summary');
    sum.textContent = '';
    const stat = (label, value, best) => {
      const d = document.createElement('div');
      d.className = `stat${best ? ' best' : ''}`;
      const b = document.createElement('b'); b.textContent = String(value);
      const s = document.createElement('small'); s.textContent = label;
      d.append(b, s);
      sum.appendChild(d);
    };
    if (res.score !== undefined) stat(extra.isNewBest ? 'Score · new best!' : 'Score', res.score.toLocaleString(), extra.isNewBest);
    if (res.wave !== undefined) stat('Wave', res.wave);
    if (res.time !== undefined) stat('Time', `${Math.floor(res.time / 60)}:${String(res.time % 60).padStart(2, '0')}`);
    if (res.kills !== undefined) stat('Kills', res.kills);
    if (res.acc !== undefined) stat('Accuracy', `${res.acc}%`);
    if (res.maxPulse !== undefined) stat('Max Pulse', res.maxPulse);
    if (res.headshots !== undefined) stat('Weak-point hits', res.headshots);
    if (res.winner) stat('Winner', res.winner);
    if (extra.best && !extra.isNewBest) stat('Best', extra.best.score.toLocaleString(), true);
    const body = $('#results-body');
    body.textContent = '';
    (res.rows || []).forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.id === extra.myId) tr.className = 'me';
      for (const v of [i + 1, r.name, r.k, r.d, r.a, r.s]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    $('#btn-play-again').hidden = !extra.canReplay;
    $('#results').hidden = false;
  }

  hideResults() {
    $('#results').hidden = true;
  }

  get resultsOpen() {
    return !$('#results').hidden;
  }

  setDowned(title, text) {
    $('#downed').hidden = !title;
    if (title) {
      this.setText('#downed-title', title);
      this.setText('#downed-text', text);
    }
  }

  setPrompt(text, progress = -1) {
    const p = $('#prompt');
    const key = `${text}|${progress >= 0 ? Math.round(progress * 20) : -1}`;
    if (this.cache.get('#prompt') === key) return;
    this.cache.set('#prompt', key);
    p.classList.toggle('show', !!text);
    if (!text) return;
    p.textContent = text;
    if (progress >= 0) {
      const bar = document.createElement('div'); bar.className = 'prog';
      const fill = document.createElement('div'); fill.style.width = `${Math.round(progress * 100)}%`;
      bar.appendChild(fill);
      p.appendChild(bar);
    }
  }

  setPhaseOverlay(on) {
    $('#phase-overlay').classList.toggle('on', on && !this.settings.postFx);
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  setText(sel, text) {
    text = String(text);
    if (this.cache.get(sel) === text) return;
    this.cache.set(sel, text);
    const el = $(sel);
    if (el) el.textContent = text;
  }

  setHtmlSafe(sel, key, build) {
    if (this.cache.get(sel) === key) return;
    this.cache.set(sel, key);
    const el = $(sel);
    if (el) { el.textContent = ''; build(el); }
  }

  setStyle(sel, prop, value) {
    const k = `${sel}::${prop}`;
    if (this.cache.get(k) === value) return;
    this.cache.set(k, value);
    const el = $(sel);
    if (el) el.style.setProperty(prop, value);
  }

  toggleClass(sel, cls, on) {
    const k = `${sel}.${cls}`;
    if (this.cache.get(k) === on) return;
    this.cache.set(k, on);
    const el = $(sel);
    if (el) el.classList.toggle(cls, on);
  }

  /**
   * Refresh the HUD from a plain data object built by GameClient.
   */
  updateHud(h) {
    this.setText('#hud-mode', h.modeLabel);
    this.setText('#hud-timer', h.timer);
    this.setHtmlSafe('#hud-objective', `${h.objective}|${h.reactor ?? ''}|${h.boss ?? ''}`, (el) => {
      if (h.objective) el.appendChild(document.createTextNode(h.objective));
      for (const [frac, color] of [[h.reactor, null], [h.boss, 'boss']]) {
        if (frac === undefined || frac === null) continue;
        const bar = document.createElement('div'); bar.className = 'reactor-bar';
        const f = document.createElement('div'); f.style.width = `${Math.max(0, Math.min(100, frac))}%`;
        if (color) f.style.background = 'linear-gradient(90deg, var(--magenta), var(--violet))';
        bar.appendChild(f);
        el.appendChild(bar);
      }
    });
    // vitals
    this.setStyle('#bar-health', 'width', `${Math.max(0, Math.min(100, (h.hp / h.mhp) * 100))}%`);
    this.setStyle('#bar-shield', 'width', `${Math.max(0, Math.min(100, (h.sh / h.msh) * 100))}%`);
    this.setText('#txt-health', Math.ceil(h.hp));
    this.setText('#txt-shield', Math.ceil(h.sh));
    this.toggleClass('.bar.health', 'low', h.hp / h.mhp < 0.3);
    // pulse
    this.setStyle('#pulse-fill', 'width', `${h.pulse}%`);
    this.setText('#pulse-value', Math.floor(h.pulse));
    this.toggleClass('#pulse-meter', 'full', h.pulse >= 100 && !h.phased);
    this.toggleClass('#pulse-meter', 'active', h.phased);
    this.setText('#move-state', h.moveState >= 0 ? MOVE_STATE_NAMES[h.moveState] : '');
    // weapon
    const w = WEAPONS[h.weapon];
    this.setText('#weapon-name', w ? w.name : '');
    this.setText('#ammo-cur', h.ammo < 0 ? '∞' : h.ammo);
    this.setText('#ammo-max', h.ammo < 0 ? '' : `/ ${h.mag}`);
    this.toggleClass('.ammo', 'empty', h.ammo === 0);
    this.toggleClass('#reload-bar', 'on', h.reload >= 0);
    if (h.reload >= 0) this.setStyle('#reload-bar div', 'width', `${Math.round(h.reload * 100)}%`);
    this.setHtmlSafe('#weapon-slots', `${h.owned}|${h.weapon}`, (el) => {
      for (let i = 0; i < WEAPONS.length; i++) {
        const s = document.createElement('div');
        s.className = `slot${h.owned & (1 << i) ? ' owned' : ''}${i === h.weapon ? ' current' : ''}`;
        s.textContent = String(i + 1);
        s.title = WEAPONS[i].name;
        el.appendChild(s);
      }
    });
    // abilities
    const ab = h.abilities;
    for (const k of ['grapple', 'melee', 'gravity', 'dash']) {
      const frac = ab[k];
      this.setStyle(`.ability[data-ab="${k}"] i`, 'height', `${Math.round(frac * 100)}%`);
      this.toggleClass(`.ability[data-ab="${k}"]`, 'ready', frac <= 0);
    }
    // score / combo
    this.setText('#hud-score', h.score);
    this.setText('#combo', h.combo > 1 ? `×${(1 + h.combo * 0.1).toFixed(1)} COMBO` : '');
    // net / fps
    this.setText('#hud-net', h.net);
    this.toggleClass('#hud-net', 'bad', h.netBad);
    if (this.settings.showFps) this.setText('#hud-fps', `${h.fps} FPS`);
    // crosshair spread
    const gap = Math.round(5 + h.spread * 260);
    this.setStyle('#crosshair', '--gap', `${gap}px`);
    const ring = $('#charge-ring');
    if (h.charge > 0) {
      this.setStyle('#charge-ring', 'opacity', '1');
      this.setStyle('#charge-ring', '--p', String(Math.round(h.charge * 100)));
      this.setStyle('#charge-ring', '--c', h.charge >= 0.99 ? 'var(--amber)' : 'var(--violet)');
    } else if (ring) this.setStyle('#charge-ring', 'opacity', '0');
  }

  updateTeam(mates) {
    const key = mates.map((m) => `${m.id}:${m.name}:${Math.round(m.hp / 5)}:${m.downed}:${m.tethered}`).join('|');
    this.setHtmlSafe('#team-status', key, (el) => {
      for (const m of mates) {
        const d = document.createElement('div');
        d.className = `mate${m.downed ? ' downed' : ''}`;
        const name = document.createElement('span'); name.textContent = m.downed ? `${m.name} — DOWNED` : m.name;
        d.appendChild(name);
        if (m.tethered) { const t = document.createElement('span'); t.className = 'tether'; t.textContent = '⟡ tether'; d.appendChild(t); }
        const bar = document.createElement('div'); bar.className = 'hpb';
        const f = document.createElement('div'); f.style.width = `${Math.max(0, Math.min(100, m.hp))}%`;
        bar.appendChild(f);
        d.appendChild(bar);
        el.appendChild(d);
      }
    });
  }

  updateTraining(lines) {
    const el = $('#training-panel');
    el.hidden = !lines;
    if (!lines) return;
    this.setHtmlSafe('#training-panel', lines.map((l) => l.join(':')).join('|'), (root) => {
      for (const [k, v] of lines) {
        const row = document.createElement('div');
        const b = document.createElement('b'); b.textContent = `${k} `;
        row.append(b, document.createTextNode(v));
        root.appendChild(row);
      }
    });
  }

  updateTutorial(steps, current) {
    const el = $('#tutorial');
    el.hidden = !steps;
    if (!steps) return;
    this.setHtmlSafe('#tutorial', `${current}`, (root) => {
      const h = document.createElement('h4'); h.textContent = `Movement tutorial ${Math.min(current, steps.length)}/${steps.length}`;
      const ul = document.createElement('ul');
      steps.forEach((s, i) => {
        const li = document.createElement('li');
        li.className = i < current ? 'done' : i === current ? 'current' : '';
        li.textContent = s.text;
        ul.appendChild(li);
      });
      root.append(h, ul);
      if (current >= steps.length) { const p = document.createElement('p'); p.textContent = 'Tutorial complete — go break physics.'; root.appendChild(p); }
    });
  }

  updateDebug(text) {
    if (!this.settings.debug) return;
    this.setText('#debug-overlay', text);
  }
}

/* ------------------------------------------------------------------------ */
/* Animated menu background (2D canvas, paused while hidden)                 */
/* ------------------------------------------------------------------------ */
class MenuBackground {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this.t = 0;
    this.strokes = [];
    for (let i = 0; i < 46; i++) this.strokes.push(this.newStroke(true));
    this.raf = 0;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = Math.floor(window.innerWidth * dpr);
    this.c.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  newStroke(init) {
    const colors = ['#5ff6ff', '#ff4fd8', '#9b6bff', '#ffb347'];
    return {
      x: Math.random() * window.innerWidth, y: init ? Math.random() * window.innerHeight : window.innerHeight + 20,
      len: 30 + Math.random() * 160, speed: 10 + Math.random() * 40, a: -Math.PI / 2 + (Math.random() - 0.5) * 0.6,
      color: colors[Math.floor(Math.random() * colors.length)], w: 0.5 + Math.random() * 1.8, wob: Math.random() * 10,
    };
  }

  setVisible(v) {
    this.visible = v;
    this.c.classList.toggle('hidden', !v);
    if (v && !this.raf) this.start();
  }

  start() {
    let last = performance.now();
    const loop = (now) => {
      if (!this.visible) { this.raf = 0; return; }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.draw(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw(dt) {
    const ctx = this.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    this.t += dt;
    ctx.fillStyle = 'rgba(5,6,15,0.22)';
    ctx.fillRect(0, 0, w, h);
    // rotating quantum circles
    const cx = w * 0.72, cy = h * 0.5;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.strokeStyle = ['rgba(155,107,255,0.25)', 'rgba(255,79,216,0.18)', 'rgba(95,246,255,0.2)', 'rgba(255,179,71,0.12)'][i];
      ctx.lineWidth = 1.2;
      ctx.setLineDash(i % 2 ? [8, 10] : []);
      ctx.arc(cx, cy, 90 + i * 70 + Math.sin(this.t * 0.7 + i) * 8, this.t * (0.2 + i * 0.1), this.t * (0.2 + i * 0.1) + Math.PI * 1.6);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // ink strokes drifting upward
    for (let i = 0; i < this.strokes.length; i++) {
      const s = this.strokes[i];
      s.y -= s.speed * dt;
      s.x += Math.sin(this.t + s.wob) * 6 * dt;
      if (s.y + s.len < -20) this.strokes[i] = this.newStroke(false);
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = s.w;
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(s.x + Math.sin(this.t * 2 + s.wob) * 10, s.y + s.len / 2, s.x + Math.cos(s.a) * 4, s.y + s.len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
