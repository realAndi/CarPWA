// The head unit: bezel, CarPlay status bar/dock, the app iframe, the home
// screen, banners, alerts, and the hardware controls (knob, touchpad, keys).

import { h, $, icon, clockText, editable } from './dom.js';
import { icons, stockApps } from './icons.js';
import {
  state, bus, view, media, input, setView, updateNav, preset, dockWidth, appearance, safeArea, update, pageAttached,
} from './bridge.js';

let els = {};
let iconURL = '';
let zoom = 'fit';
let alertState = null;   // { actions, buttons, focus, resolve } while an alert is open

export function mountUnit(root) {
  // Same-origin, so the app inherits the shell's permissions without an `allow` list.
  els.frame = h('iframe', { title: 'CarPWA app' });
  els.frame.id = 'app-frame';
  els.safe = h('div.safe-overlay');
  els.home = h('div.home');
  els.other = h('div.other');
  els.banners = h('div.banners');
  els.alertLayer = h('div.alert-layer');
  els.errorLayer = h('div.error-layer');
  els.loading = h('div.loading', h('div.spinner'));
  els.appArea = h('div.app-area', els.frame, els.loading, els.safe, els.home, els.other, els.errorLayer, els.banners, els.alertLayer);

  els.time = h('div.dock-time', clockText());
  els.dockApps = h('div.dock-apps');
  els.dockHome = h('button.dock-home', { title: 'Home (H)', onclick: () => toggleHome() }, icon(icons.home));
  els.dock = h('aside.dock',
    els.time,
    h('div.dock-signal', icon(icons.signal), h('span', '5G')),
    els.dockApps,
    els.dockHome,
  );
  els.disconnected = h('div.disconnected',
    h('div.disc-card',
      icon(icons.car, 'disc-icon'),
      h('h2', 'iPhone disconnected'),
      h('p', 'Your app keeps running in the background. Reconnect to bring CarPlay back.'),
      h('button.disc-btn', { onclick: () => update((s) => { s.connected = true; }) }, 'Reconnect'),
    ),
  );
  els.screen = h('div.screen', els.dock, els.appArea, els.disconnected, h('div.glass'));
  els.bezel = h('div.bezel', els.screen, h('div.bezel-brand', 'CarPWA'));
  els.hardware = buildHardware();
  els.unit = h('div.unit', els.bezel);
  // Head-unit buttons behave like physical keys: they never take keyboard focus.
  for (const root of [els.bezel, els.hardware]) {
    root.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  }
  els.scale = h('div.unit-scale', els.unit);
  els.hwScale = h('div.hw-scale', els.hardware);
  root.append(h('div.unit-wrap', els.scale, els.hwScale));

  view.frame = () => els.frame;
  view.showAlert = showAlert;
  view.showBanner = showBanner;
  view.handleInput = handleOverlayInput;

  setInterval(() => { els.time.textContent = clockText(); }, 1000);
  new ResizeObserver(() => fit()).observe(root);
  els.root = root;
  bus.on('change', render);
  bus.on('media', () => { if (state.view === 'other' && state.otherApp === 'com.apple.Music') renderOther(); });
  bus.on('attach', (win) => attachKeyboard(win));
  attachKeyboard(window);
  els.frame.addEventListener('load', () => els.loading.classList.add('hidden'));
  render();
}

export function setIcon(url) {
  iconURL = url;
  render();
}

export function setZoom(z) {
  zoom = z;
  fit();
}

/**
 * After a file change the server sends dev.reload to the app's own server
 * connection and the SDK reloads the page. A page without the SDK (or one
 * that never attached) is reloaded here instead.
 */
export function reloadIfDetached() {
  if (pageAttached()) return false;
  loadApp('reload');
  return true;
}

export function loadApp(reason) {
  const m = state.manifest;
  if (!m) return;
  els.loading.classList.remove('hidden');
  if (state.view !== 'app') setView('app');
  const src = `/${m.start_url}`;
  if (reason === 'reload' && els.frame.getAttribute('src')) {
    try { els.frame.contentWindow.location.reload(); return; } catch { /* fall through */ }
  }
  els.frame.setAttribute('src', src);
}

export function showErrors(errors) {
  els.errorLayer.replaceChildren();
  if (!errors || !errors.length) { els.errorLayer.classList.remove('visible'); return; }
  els.errorLayer.append(
    h('div.error-card',
      h('div.error-head', icon(icons.warning), h('strong', 'carpwa.json has errors')),
      h('ul', errors.map((e) => h('li', e))),
      h('p.error-note', 'The simulator keeps running with the last valid manifest. Save a fix to continue.'),
      h('button.error-dismiss', { onclick: () => els.errorLayer.classList.remove('visible') }, 'Dismiss'),
    ),
  );
  els.errorLayer.classList.add('visible');
}

// ------------------------------------------------------------------ render

function render() {
  const p = preset();
  const dock = dockWidth();
  const dark = appearance() === 'dark';
  els.screen.style.width = `${p.width + dock}px`;
  els.screen.style.height = `${p.height}px`;
  els.screen.classList.toggle('dark', dark);
  els.screen.classList.toggle('light', !dark);
  els.screen.classList.toggle('rhd', state.rhd);
  els.screen.classList.toggle('night', state.nightMode);
  els.screen.style.setProperty('--dock', `${dock}px`);
  els.appArea.style.width = `${p.width}px`;
  els.appArea.style.height = `${p.height}px`;
  els.appArea.style.background = state.bgColor || (state.manifest && state.manifest.background_color) || '#000';
  els.disconnected.classList.toggle('visible', !state.connected);

  const s = safeArea();
  Object.assign(els.safe.style, {
    borderTopWidth: `${s.top}px`, borderLeftWidth: `${s.left}px`, borderBottomWidth: `${s.bottom}px`, borderRightWidth: `${s.right}px`,
  });
  els.safe.classList.toggle('visible', state.showSafeArea);

  els.home.classList.toggle('visible', state.view === 'home');
  els.other.classList.toggle('visible', state.view === 'other');
  if (state.view === 'home') renderHome();
  if (state.view === 'other') renderOther();
  renderDock();

  els.hardware.dataset.input = state.input;
  fit();
}

function appTile(app, size) {
  const tile = h('span.app-icon', { style: { width: `${size}px`, height: `${size}px` } });
  if (app.own) {
    tile.style.backgroundImage = iconURL ? `url("${iconURL}")` : '';
    tile.classList.add('own');
  } else {
    tile.style.background = `linear-gradient(160deg, ${app.colors[0]}, ${app.colors[1]})`;
    tile.innerHTML = app.glyph;
  }
  return tile;
}

function ownApp() {
  const m = state.manifest || {};
  return { own: true, bundleId: m.id, name: m.short_name || m.name || 'App' };
}

function renderDock() {
  const size = Math.round(dockWidth() * 0.62);
  const apps = [stockApps.find((a) => a.name === 'Maps'), stockApps.find((a) => a.name === 'Music'), ownApp()];
  els.dockApps.replaceChildren(...apps.map((app) => {
    const active = app.own ? state.view === 'app' : state.view === 'other' && state.otherApp === app.bundleId;
    return h('button.dock-app', {
      class: active ? 'active' : '',
      title: app.name,
      onclick: () => (app.own ? setView('app') : setView('other', app.bundleId)),
    }, appTile(app, size));
  }));
  els.dockHome.classList.toggle('active', state.view === 'home');
}

function renderHome() {
  const p = preset();
  const width = p.width;
  const size = p.height <= 480 ? 72 : 96;
  const cols = width > 1100 ? 8 : width > 840 ? 5 : 4;
  const apps = [...stockApps, ownApp()];
  const grid = h('div.home-grid', { style: { '--tile': `${size}px`, gridTemplateColumns: `repeat(${cols}, ${size + 40}px)` } });
  els.home.replaceChildren(grid);
  grid.append(...apps.map((app) =>
    h('button.home-app', {
      onclick: () => (app.own ? setView('app') : setView('other', app.bundleId)),
      'data-own': app.own ? '1' : null,
    }, appTile(app, size), h('span.home-label', app.name)),
  ));
}

function renderOther() {
  const app = stockApps.find((a) => a.bundleId === state.otherApp);
  if (!app) return;
  const back = h('button.other-back', { onclick: () => setView('app') }, icon(icons.back), `Back to ${ownApp().name}`);
  let body;
  if (app.name === 'Music') {
    const np = media.nowPlaying();
    body = h('div.other-music',
      np ? h('img.other-art', { src: media.artwork(320), alt: '' }) : appTile(app, 140),
      h('div.other-music-text',
        h('div.other-title', np ? np.title : 'Not Playing'),
        h('div.other-sub', np ? `${np.artist} — ${np.album}` : 'Pick something in the inspector’s Media tab'),
        h('div.other-controls',
          h('button', { onclick: () => media.track && media.previous(), title: 'Previous' }, icon(icons.prev)),
          h('button.main', { onclick: () => media.toggle(), title: 'Play/Pause' }, icon(np && np.playing ? icons.pause : icons.play)),
          h('button', { onclick: () => media.next(), title: 'Next' }, icon(icons.next)),
        ),
      ),
    );
  } else if (app.name === 'Maps') {
    const nav = state.nav.navigating;
    body = h('div.other-maps',
      h('div.map-bg'),
      h('div.map-puck'),
      nav ? h('div.map-guidance', h('strong', '0.4 mi'), h('span', 'Turn right onto Infinite Loop')) : null,
      h('button.map-btn', { onclick: () => updateNav((n) => { n.navigating = !n.navigating; }) }, nav ? 'End Route' : 'Start Navigation'),
    );
  } else {
    body = h('div.other-generic', appTile(app, 120), h('div.other-title', app.name), h('div.other-sub', 'Simulated CarPlay app'));
  }
  els.other.replaceChildren(body, back);
}

function toggleHome() {
  setView(state.view === 'home' ? 'app' : 'home');
}

// ----------------------------------------------------------- zoom / fit

// The bezel scales with the zoom; the hardware row keeps a usable size and
// only shrinks when the scaled screen is narrower than its minimum width.
const HW_MIN_WIDTH = 640;
const HW_GAP = 14;

function fit() {
  if (!els.root) return;
  const natW = els.unit.offsetWidth;
  const natH = els.unit.offsetHeight;
  const hwH = els.hardware.offsetHeight;
  const pad = 48;
  const availW = els.root.clientWidth - pad;
  const availH = els.root.clientHeight - pad - hwH - HW_GAP;
  let s = zoom === 'fit' ? Math.min(availW / natW, availH / natH, 1.5) : Number(zoom);
  if (!isFinite(s) || s <= 0) s = 1;
  els.unit.style.transform = `scale(${s})`;
  els.scale.style.width = `${natW * s}px`;
  els.scale.style.height = `${natH * s}px`;

  const width = natW * s;
  const hs = Math.min(1, width / HW_MIN_WIDTH);
  els.hardware.style.width = `${width / hs}px`;
  els.hardware.style.transform = `scale(${hs})`;
  els.hwScale.style.width = `${width}px`;
  els.hwScale.style.height = `${hwH * hs}px`;
}

// --------------------------------------------------------------- banners

function showBanner({ title, subtitle = '', duration, system = false }) {
  const secs = duration == null ? 4 : duration > 100 ? duration / 1000 : duration;
  const ttl = Math.max(1, Math.min(30, secs)) * 1000;
  const node = h('div.banner',
    system ? h('span.banner-icon.sys', 'SIM') : appTile(ownApp(), 34),
    h('div.banner-text', h('div.banner-title', title), subtitle ? h('div.banner-sub', subtitle) : null),
  );
  node.addEventListener('click', () => dismiss());
  els.banners.append(node);
  requestAnimationFrame(() => node.classList.add('in'));
  const timer = setTimeout(() => dismiss(), ttl);
  function dismiss() {
    clearTimeout(timer);
    node.classList.remove('in');
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }
  while (els.banners.children.length > 3) els.banners.firstChild.remove();
}

// ---------------------------------------------------------------- alerts

function showAlert({ title, message, actions }) {
  return new Promise((resolve) => {
    if (alertState) closeAlert(null);
    const buttons = actions.map((a, i) => h('button.alert-btn', {
      class: a.style || 'default',
      onclick: () => closeAlert(a.id),
      'data-i': i,
    }, a.title));
    const card = h('div.alert-card', { role: 'alertdialog' },
      title ? h('div.alert-title', title) : null,
      message ? h('div.alert-msg', message) : null,
      h('div.alert-actions', { class: actions.length === 2 ? 'pair' : '' }, buttons),
    );
    els.alertLayer.replaceChildren(card);
    els.alertLayer.classList.add('visible');
    alertState = { actions, buttons, focus: -1, resolve };
    if (state.input !== 'touch') focusAlert(0);
  });
}

function focusAlert(i) {
  if (!alertState) return;
  const n = alertState.buttons.length;
  alertState.focus = ((i % n) + n) % n;
  alertState.buttons.forEach((b, j) => b.classList.toggle('focused', j === alertState.focus));
}

function closeAlert(id) {
  if (!alertState) return;
  const { resolve } = alertState;
  alertState = null;
  els.alertLayer.classList.remove('visible');
  els.alertLayer.replaceChildren();
  resolve(id);
}

/** Overlays get input first: an open alert, the home screen, another app. */
function handleOverlayInput(kind, data) {
  if (alertState) {
    if (kind === 'move') focusAlert(alertState.focus + (['next', 'down', 'right'].includes(data.direction) ? 1 : -1));
    else if (kind === 'select' && data.phase === 'up' && alertState.focus >= 0) closeAlert(alertState.actions[alertState.focus].id);
    else if (kind === 'back') {
      const cancel = alertState.actions.find((a) => a.style === 'cancel');
      closeAlert(cancel ? cancel.id : null);
    }
    return true;
  }
  if (!state.connected) return true;
  if (state.view === 'home' || state.view === 'other') {
    if (kind === 'back' && state.view === 'other') setView('home');
    else if (kind === 'select' && data.phase === 'up') setView('app');
    return true;
  }
  return false;
}

// -------------------------------------------------------------- hardware

let knobAngle = 0;

function buildHardware() {
  const press = (direction) => () => input('move', { direction });
  const selectBtn = (node) => {
    node.addEventListener('pointerdown', (e) => { e.preventDefault(); node.classList.add('pressed'); input('select', { phase: 'down' }); });
    const up = () => { if (!node.classList.contains('pressed')) return; node.classList.remove('pressed'); input('select', { phase: 'up' }); };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointerleave', up);
    return node;
  };

  const knob = selectBtn(h('button.knob', { title: 'Knob: scroll to rotate, click to select (Enter)' }, h('span.knob-cap'), h('span.knob-mark')));
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    rotate(e.deltaY > 0 || e.deltaX > 0 ? 'next' : 'previous');
  }, { passive: false });

  const knobCluster = h('div.knob-cluster',
    h('button.nudge.up', { title: 'Nudge up (↑)', onclick: press('up') }, icon(icons.chevron)),
    h('button.nudge.down', { title: 'Nudge down (↓)', onclick: press('down') }, icon(icons.chevron)),
    h('button.nudge.left', { title: 'Nudge left (←)', onclick: press('left') }, icon(icons.chevron)),
    h('button.nudge.right', { title: 'Nudge right (→)', onclick: press('right') }, icon(icons.chevron)),
    knob,
  );

  const pad = h('div.touchpad', { title: 'Touchpad: swipe to move, click to select' }, h('span.touchpad-hint', 'swipe · click'));
  let start = null;
  pad.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; pad.setPointerCapture(e.pointerId); pad.classList.add('pressed'); });
  pad.addEventListener('pointerup', (e) => {
    pad.classList.remove('pressed');
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.hypot(dx, dy) < 12) { input('select', { phase: 'down' }); input('select', { phase: 'up' }); return; }
    input('move', { direction: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up') });
  });

  const playKey = h('button.hw-key', { title: 'Play/Pause', onclick: () => media.toggle() }, icon(icons.play));
  bus.on('media', () => playKey.replaceChildren(icon(media.playing ? icons.pause : icons.play)));

  return h('div.hardware',
    h('div.hw-group',
      h('button.hw-key', { title: 'Back (Esc)', onclick: () => input('back') }, icon(icons.back), h('span', 'Back')),
      h('button.hw-key', { title: 'Home (H)', onclick: () => toggleHome() }, icon(icons.home), h('span', 'Home')),
    ),
    h('div.hw-input',
      h('button.hw-rot', { title: 'Rotate counter-clockwise ([)', onclick: () => rotate('previous') }, icon(icons.rotateL)),
      knobCluster,
      pad,
      h('button.hw-rot', { title: 'Rotate clockwise (])', onclick: () => rotate('next') }, icon(icons.rotateR)),
    ),
    h('div.hw-group',
      h('button.hw-key', { title: 'Previous track', onclick: () => media.previous() }, icon(icons.prev)),
      playKey,
      h('button.hw-key', { title: 'Next track', onclick: () => (media.track ? media.next() : media.play()) }, icon(icons.next)),
    ),
  );

  function rotate(direction) {
    knobAngle += direction === 'next' ? 18 : -18;
    knob.style.setProperty('--angle', `${knobAngle}deg`);
    input('move', { direction });
  }
}

// -------------------------------------------------------------- keyboard

// Enter on a control reached with Tab activates it; after a mouse click it is
// the knob's select, so you can click a setting and keep driving with keys.
let tabbing = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbing = true; }, true);
document.addEventListener('pointerdown', () => { tabbing = false; }, true);

function keyboardFocusedControl(target) {
  return tabbing && !!(target && target.closest && target.closest('button, a, summary, [role="switch"]'));
}

const KEYS = {
  ArrowUp: ['move', 'up'], ArrowDown: ['move', 'down'], ArrowLeft: ['move', 'left'], ArrowRight: ['move', 'right'],
  '[': ['move', 'previous'], ']': ['move', 'next'], ',': ['move', 'previous'], '.': ['move', 'next'],
};

/**
 * Keyboard shortcuts for the hardware controls. In the shell they always work
 * (outside text fields). Inside the app frame they only apply in knob and
 * touchpad mode, so a touch app keeps normal keyboard behaviour.
 */
function attachKeyboard(win) {
  const inFrame = win !== window;
  const doc = win.document;
  const active = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return false;
    if (inFrame && state.input === 'touch') return false;
    return true;
  };
  doc.addEventListener('keydown', (e) => {
    if (!active(e)) return;
    if (KEYS[e.key]) {
      e.preventDefault();
      const [kind, direction] = KEYS[e.key];
      if (direction === 'next' || direction === 'previous') {
        knobAngle += direction === 'next' ? 18 : -18;
        $('.knob', els.hardware)?.style.setProperty('--angle', `${knobAngle}deg`);
      }
      input(kind, { direction });
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!inFrame && keyboardFocusedControl(e.target)) return;
      e.preventDefault();
      if (!e.repeat) input('select', { phase: 'down' });
    } else if (e.key === 'Escape' || (e.key === 'Backspace' && inFrame)) {
      e.preventDefault();
      input('back');
    } else if (!inFrame && (e.key === 'h' || e.key === 'H')) {
      toggleHome();
    }
  }, true);
  doc.addEventListener('keyup', (e) => {
    if (!active(e)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (!inFrame && keyboardFocusedControl(e.target)) return;
      e.preventDefault();
      input('select', { phase: 'up' });
    }
  }, true);
}

