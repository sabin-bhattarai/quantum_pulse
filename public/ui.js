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
/** Results ignore clicks this long after opening so a held trigger cannot skip them. */
const RESULTS_INPUT_GUARD_MS = 350;

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
    this.resultsShownAt = 0;
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
      // Swallow clicks still in flight from the fight that just ended.
      if (btn.closest('#results') && performance.now() - this.resultsShownAt < RESULTS_INPUT_GUARD_MS) return;
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
        case 'toggle-mute':
          this.settings.mute = !this.settings.mute;
          this.syncSettingsInputs();
          this.emit('settings', 'mute');
          break;
        case 'start-solo': this.emit('start', { mode: 'survival', arena: this.arenaChoice.solo }); break;
        case 'create-ffa': this.emit('start', { mode: 'ffa', action: 'create', arena: this.arenaChoice.ffa }); break;
        case 'quick-ffa': this.emit('start', { mode: 'ffa', action: 'quick', arena: this.arenaChoice.ffa }); break;
        case 'join-ffa-code': this.joinByCode('ffa', '#input-room-ffa'); break;
        case 'join-room': this.emit('start', { mode: 'ffa', action: 'join', room: btn.dataset.code }); break;
        case 'refresh-rooms': this.refreshRooms(); break;
        case 'create-coop': this.emit('start', { mode: 'coop', action: 'create' }); break;
        case 'join-coop': this.joinByCode('coop', '#input-room-coop'); break;
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
    for (const [id, mode] of [['#input-room-ffa', 'ffa'], ['#input-room-coop', 'coop']]) {
      $(id).addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinByCode(mode, id); });
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
    this.pollRooms(name === 'online');
    const target = `screen-${name}`;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === target));
    if (this.screenStack[this.screenStack.length - 1] !== name) this.screenStack.push(name);
    if (name === 'menu') this.screenStack = ['menu'];
    const inMenus = !!document.querySelector('.screen.active');
    this.menuBg.setVisible(inMenus && !this.inGame);
    if (name === 'solo') this.refreshBest();
  }

  /** Join a room by its code; the code is required. */
  joinByCode(mode, inputSel) {
    const code = $(inputSel).value.trim();
    if (!code) {
      this.toast('Enter the room code first.', true, 3000);
      $(inputSel).focus();
      return;
    }
    this.emit('start', { mode, action: 'join', room: code });
  }

  /** Keep the free-for-all lobby fresh while its screen is open. */
  pollRooms(on) {
    clearInterval(this.roomPoll);
    this.roomPoll = 0;
    if (!on) return;
    this.refreshRooms();
    this.roomPoll = setInterval(() => this.refreshRooms(), 3000);
  }

  async refreshRooms() {
    const list = $('#room-list');
    let rooms;
    try {
      const res = await fetch('/rooms', { cache: 'no-store' });
      rooms = (await res.json()).rooms;
      if (!Array.isArray(rooms)) throw new Error('bad list');
    } catch {
      list.textContent = '';
      const p = document.createElement('p');
      p.className = 'room-empty';
      p.textContent = 'Room list unavailable. You can still join with a code.';
      list.appendChild(p);
      return;
    }
    list.textContent = '';
    if (!rooms.length) {
      const p = document.createElement('p');
      p.className = 'room-empty';
      p.textContent = 'No open rooms yet. Create one and your friends will see it here.';
      list.appendChild(p);
      return;
    }
    const phase = { warmup: 'Waiting for players', active: 'In match', ended: 'Results' };
    for (const r of rooms.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = `room-row${r.joinable ? '' : ' full'}`;
      const code = document.createElement('b'); code.className = 'code'; code.textContent = String(r.code);
      const arena = document.createElement('span'); arena.textContent = arenaName(String(r.arena));
      const count = document.createElement('span'); count.className = 'count'; count.textContent = `${r.players | 0}/${r.max | 0}`;
      const ph = document.createElement('span'); ph.className = 'phase'; ph.textContent = phase[r.phase] || '';
      const join = document.createElement('button');
      join.className = 'btn tiny';
      join.dataset.action = 'join-room';
      join.dataset.code = String(r.code);
      join.textContent = r.joinable ? 'Join' : 'Full';
      join.disabled = !r.joinable;
      row.append(code, arena, count, ph, join);
      list.appendChild(row);
    }
  }

  back() {
    this.screenStack.pop();
    const prev = this.screenStack[this.screenStack.length - 1] || 'menu';
    if (prev === 'game') { this.hideScreens(); this.emit('settings-closed'); return; }
    this.showScreen(prev);
  }

  hideScreens() {
    this.pollRooms(false);
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
    document.documentElement.style.setProperty('--hud-user', String(s.hudScale || 1));
    $('#crosshair').style.setProperty('--ch-scale', String(s.crosshairSize || 1));
    $('#hud-fps').hidden = !s.showFps;
    $('#debug-overlay').hidden = !s.debug;
    const mute = $('#btn-mute');
    mute.setAttribute('aria-pressed', String(!!s.mute));
    mute.setAttribute('aria-label', s.mute ? 'Unmute audio' : 'Mute audio');
    mute.title = mute.getAttribute('aria-label');
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
        sm.textContent = id ? ARENA_TAGLINES[id] : 'The server picks from its rotation';
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
    $('#best-score').textContent = lines.length ? lines.join('\n') : 'No survival runs yet. Enter the rift!';
  }

  emitQuery(name) {
    return this.handlers[name] ? this.handlers[name]() : null;
  }

  /** @param {string} text @param {'online'|'offline'|''} [state] */
  setNetStatus(text, state = '') {
    const el = $('#net-status');
    el.textContent = text;
    el.classList.toggle('online', state === 'online');
    el.classList.toggle('offline', state === 'offline');
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
    // Clear call-outs so they don't sit behind the cards.
    clearTimeout(this.centerTimer);
    $('#center-msg').classList.remove('show');
    $('#sub-msg').classList.remove('show');
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
    this.resultsShownAt = performance.now();
    // Enter / Space restarts (or returns to the menu online) without the mouse.
    (extra.canReplay ? $('#btn-play-again') : $('#results [data-action="leave"]')).focus({ preventScroll: true });
  }

  /** Sniper scope overlay (Vector Lance zoom); cheap to call every frame. */
  setScope(on) {
    if (this.scoped === on) return;
    this.scoped = on;
    $('#scope').hidden = !on;
    document.body.classList.toggle('scoped', on);
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
/* Animated menu background: comic-cover sunburst (paused while hidden)      */
/* ------------------------------------------------------------------------ */
class MenuBackground {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this.t = 0;
    this.raf = 0;
    this.halftone = document.createElement('canvas');
    this.sparks = Array.from({ length: 14 }, () => this.newSpark(true));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Read palette tokens from CSS so canvas and DOM share one source of truth. */
  readTokens() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.col = { ink: v('--ink') || '#16130f', red: v('--signal') || '#e63b2e', deep: v('--signal-deep') || '#a3231a', paper: v('--paper') || '#efe6d2', yellow: v('--yellow') || '#f2c230' };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.c.width = Math.floor(window.innerWidth * dpr);
    this.c.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.readTokens();
    this.bakeHalftone();
  }

  /** Ben-Day dots that grow toward the edges, baked once per resize. */
  bakeHalftone() {
    const w = window.innerWidth, h = window.innerHeight;
    const hc = this.halftone;
    hc.width = Math.floor(w * this.dpr);
    hc.height = Math.floor(h * this.dpr);
    const g = hc.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = this.col.ink;
    const step = 13, fx = w * 0.32, fy = h * 0.24, maxD = Math.hypot(w, h) * 0.75;
    for (let y = 0; y < h + step; y += step) {
      for (let x = (y / step) % 2 ? step / 2 : 0; x < w + step; x += step) {
        const d = Math.hypot(x - fx, y - fy) / maxD;
        const r = Math.max(0, (d - 0.18) * 7.2);
        if (r < 0.4) continue;
        g.beginPath();
        g.arc(x, y, Math.min(r, step * 0.62), 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  newSpark(init) {
    return {
      x: Math.random() * window.innerWidth, y: init ? Math.random() * window.innerHeight : window.innerHeight + 30,
      s: 6 + Math.random() * 14, v: 12 + Math.random() * 26, r: Math.random() * 6.28, spin: (Math.random() - 0.5) * 1.5, kind: Math.random() < 0.5 ? 0 : 1,
    };
  }

  setVisible(v) {
    this.visible = v;
    this.c.classList.toggle('hidden', !v);
    if (v) { this.readTokens(); this.bakeHalftone(); }
    if (v && !this.raf) this.start();
  }

  start() {
    let last = performance.now();
    let acc = 0;
    const loop = (now) => {
      if (!this.visible) { this.raf = 0; return; }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;
      if (acc >= 1 / 30) { this.draw(acc); acc = 0; } // 30 fps is plenty for a backdrop
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw(dt) {
    const ctx = this.ctx, C = this.col;
    const w = window.innerWidth, h = window.innerHeight;
    const reduce = document.body.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.t += reduce ? 0 : dt;
    const fx = w * 0.32, fy = h * 0.24, R = Math.hypot(w, h);
    ctx.fillStyle = C.deep;
    ctx.fillRect(0, 0, w, h);
    // sunburst wedges
    const n = 28, rot = this.t * 0.035;
    ctx.fillStyle = C.red;
    for (let i = 0; i < n; i += 2) {
      const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + Math.cos(a0) * R, fy + Math.sin(a0) * R);
      ctx.lineTo(fx + Math.cos(a1) * R, fy + Math.sin(a1) * R);
      ctx.closePath();
      ctx.fill();
    }
    // halftone vignette
    ctx.drawImage(this.halftone, 0, 0, w, h);
    // drifting ink sparks (four-point stars and plus marks)
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.ink;
    for (let i = 0; i < this.sparks.length; i++) {
      const p = this.sparks[i];
      p.y -= p.v * dt;
      p.r += p.spin * dt;
      if (p.y < -40) this.sparks[i] = this.newSpark(false);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.kind ? C.yellow : C.paper;
      ctx.beginPath();
      if (p.kind) {
        for (let k = 0; k < 8; k++) {
          const rr = k % 2 ? p.s * 0.32 : p.s;
          const a = (k / 8) * Math.PI * 2;
          k ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(rr, 0);
        }
        ctx.closePath();
      } else {
        const a = p.s * 0.22, b = p.s * 0.75;
        ctx.rect(-a, -b, a * 2, b * 2);
        ctx.rect(-b, -a, b * 2, a * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
