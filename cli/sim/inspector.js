// The inspector panel: car controls, media, navigation and location, storage,
// console, channels and app info.

import { h, icon, fmtTime, preview } from './dom.js';
import { icons } from './icons.js';
import { LIBRARY, SOURCES } from './media.js';
import {
  state, bus, media, update, emit, granted, updateNav, updateCarInfo, navState, locationFix, LOCATIONS, INSETS, FUEL_TYPES,
  setPlace, setCoordinates, setDriving, setLocationAvailable, pushLocation, persist, input as sendInput,
} from './bridge.js';

const PERMISSION_INFO = {
  'media': 'Read now playing and artwork',
  'media.control': 'Play, pause, skip and seek',
  'navigation': 'Navigation state and ownership',
  'location': 'GPS position',
  'network': 'net.fetch to network.allow hosts',
  'apps.launch': 'Open other apps and URLs',
  'vehicle.identity': 'Car serial number',
  'car.raw': 'Raw head-unit commands',
};

let ctx = null;            // { send, request, server }
const syncs = [];          // functions that refresh controls from state
const tabs = {};
let activeTab = 'car';
let unreadErrors = 0;

export function mountInspector(root, context) {
  ctx = context;
  const defs = [
    ['car', 'Car', icons.car, buildCar],
    ['media', 'Media', icons.music, buildMedia],
    ['places', 'Location', icons.pin, buildPlaces],
    ['storage', 'Storage', icons.database, buildStorage],
    ['console', 'Console', icons.terminal, buildConsole],
    ['channels', 'Channels', icons.broadcast, buildChannels],
    ['app', 'App', icons.info, buildApp],
  ];
  const bar = h('nav.tabs', { role: 'tablist' });
  const body = h('div.tab-body');
  for (const [id, label, ic, build] of defs) {
    const btn = h('button.tab', { role: 'tab', onclick: () => select(id), title: label }, icon(ic), h('span', label));
    const badge = h('span.tab-badge');
    btn.append(badge);
    const panel = h('section.panel', { role: 'tabpanel' });
    build(panel);
    tabs[id] = { btn, panel, badge };
    bar.append(btn);
    body.append(panel);
  }
  root.append(bar, body);
  try { activeTab = sessionStorage.getItem('carpwa-sim:tab') || 'car'; } catch { /* default */ }
  select(tabs[activeTab] ? activeTab : 'car');
  bus.on('change', syncAll);
  syncAll();
}

export function select(id) {
  activeTab = id;
  for (const [k, t] of Object.entries(tabs)) {
    t.btn.classList.toggle('active', k === id);
    t.btn.setAttribute('aria-selected', String(k === id));
    t.panel.classList.toggle('active', k === id);
  }
  if (id === 'console') { unreadErrors = 0; tabs.console.badge.textContent = ''; scrollConsole(true); }
  try { sessionStorage.setItem('carpwa-sim:tab', id); } catch { /* ignore */ }
}

export function syncAll() {
  for (const fn of syncs) { try { fn(); } catch (e) { console.error(e); } }
}

// ------------------------------------------------------------ controls

function section(title, ...children) {
  return h('div.section', title ? h('h3.section-title', title) : null, ...children);
}

function row(label, control, hint) {
  return h('div.row', h('div.row-label', h('span', label), hint ? h('small', hint) : null), control);
}

function toggle(label, get, set, hint) {
  const input = h('input', { type: 'checkbox', role: 'switch', onchange: () => set(input.checked) });
  syncs.push(() => { input.checked = !!get(); });
  return row(label, h('label.switch', input, h('span.switch-track')), hint);
}

function segmented(label, options, get, set, hint) {
  const wrap = h('div.segmented');
  const buttons = options.map(([value, text]) => {
    const b = h('button', { onclick: () => set(value) }, text);
    b.dataset.value = value;
    return b;
  });
  wrap.append(...buttons);
  syncs.push(() => { const v = get(); for (const b of buttons) b.classList.toggle('on', b.dataset.value === String(v)); });
  return label ? row(label, wrap, hint) : wrap;
}

function selectBox(label, options, get, set, hint) {
  const sel = h('select', { onchange: () => set(sel.value) }, options.map(([v, t]) => h('option', { value: v }, t)));
  syncs.push(() => { if (document.activeElement !== sel) sel.value = get(); });
  return row(label, sel, hint);
}

function button(text, onclick, cls = '') {
  return h('button.btn', { class: cls, onclick }, text);
}

// ------------------------------------------------------------------- car

function textField(label, get, set, placeholder = '') {
  const el = h('input', { type: 'text', placeholder });
  el.addEventListener('change', () => set(el.value.trim()));
  syncs.push(() => { if (document.activeElement !== el) el.value = get() ?? ''; });
  return row(label, el);
}

function knobPad() {
  const key = (label, title, fn) => h('button.pad-key', { title, onclick: fn }, label);
  const move = (direction) => () => sendInput('move', { direction });
  return h('div.pad',
    key('↺', 'Rotate counter-clockwise: move "previous"', move('previous')),
    key('↑', 'Nudge up', move('up')),
    key('↻', 'Rotate clockwise: move "next"', move('next')),
    key('←', 'Nudge left', move('left')),
    key('●', 'Select (down, then up)', () => { sendInput('select', { phase: 'down' }); sendInput('select', { phase: 'up' }); }),
    key('→', 'Nudge right', move('right')),
    key('Back', 'Back button', () => sendInput('back')),
    key('↓', 'Nudge down', move('down')),
    h('div.pad-split',
      key('Sel ↓', 'select { phase: "down" } only', () => sendInput('select', { phase: 'down' })),
      key('Sel ↑', 'select { phase: "up" } only', () => sendInput('select', { phase: 'up' })),
    ),
  );
}

function buildCar(panel) {
  const presets = Object.entries(state.presets).map(([k, v]) => [k, v.label || k]);
  const fuel = h('div.checks', FUEL_TYPES.map((type) => {
    const box = h('input', { type: 'checkbox', onchange: () => updateCarInfo((car) => {
      car.fuelTypes = FUEL_TYPES.filter((t) => (t === type ? box.checked : car.fuelTypes.includes(t)));
    }) });
    syncs.push(() => { box.checked = state.car.fuelTypes.includes(type); });
    return h('label.check', box, type);
  }));
  const limitedSubs = h('div.subrows',
    toggle('Keyboard limited', () => state.limitedKeyboard, (v) => update((s) => { s.limitedKeyboard = v; }), 'limitedUIElements.keyboard'),
    toggle('Lists limited', () => state.limitedLists, (v) => update((s) => { s.limitedLists = v; }), 'limitedUIElements.lists'),
  );
  syncs.push(() => { limitedSubs.classList.toggle('off', !state.limitedUI); });
  const remoteName = h('input', { type: 'text', value: 'ButtonPressed', placeholder: 'event name' });
  const remotePayload = h('input', { type: 'text', value: '{"button":"star"}', placeholder: 'JSON payload' });
  const openURL = h('input', { type: 'text', value: 'https://example.com', placeholder: 'URL' });
  const rawNote = h('p.note');
  syncs.push(() => {
    rawNote.textContent = granted('car.raw') ? '' : 'The app does not have "car.raw"; these events are withheld, as on a real car.';
  });

  panel.append(
    section('Connection',
      toggle('iPhone connected', () => state.connected, (v) => update((s) => { s.connected = v; }), 'car.connect / car.disconnect'),
      toggle('Enforce permissions', () => state.enforce, (v) => { state.enforce = v; bus.emit('change'); persist(); }, 'EPERM for anything carpwa.json does not grant'),
      toggle('Right-hand drive', () => state.rhd, (v) => update((s) => { s.rhd = v; }), 'moves the status bar to the right'),
    ),
    section('Appearance',
      segmented('Appearance', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']], () => state.appearance, (v) => update((s) => { s.appearance = v; }), 'Auto follows night mode'),
      toggle('Night mode', () => state.nightMode, (v) => update((s) => { s.nightMode = v; }), 'headlights on'),
      toggle('Limited UI', () => state.limitedUI, (v) => update((s) => { s.limitedUI = v; }), 'the car asks apps to reduce UI while driving'),
      limitedSubs,
    ),
    section('Screen',
      selectBox('Preset', presets, () => state.preset, (v) => update((s) => { s.preset = v; }), "the app's size in CSS px"),
      segmented('Interaction', [['touch', 'Touch'], ['knob', 'Knob'], ['touchpad', 'Touchpad']], () => state.input, (v) => update((s) => { s.input = v; })),
      selectBox('Safe area', Object.entries(INSETS).map(([k, v]) => [k, v.label]), () => state.insets, (v) => update((s) => { s.insets = v; })),
      toggle('Show safe area', () => state.showSafeArea, (v) => { state.showSafeArea = v; bus.emit('change'); persist(); }),
    ),
    section('Knob pad',
      knobPad(),
      h('div.kv', kvRow('Capture mode', () => state.capture), kvRow('Back intercepted', () => (state.interceptBack ? 'yes' : 'no'))),
      h('p.note', 'Keyboard: [ ] rotate, arrows nudge, Enter selects, Esc is Back, H toggles Home.'),
    ),
    section('Car info',
      textField('Name', () => state.car.name, (v) => updateCarInfo((car) => { car.name = v; })),
      textField('Model', () => state.car.model, (v) => updateCarInfo((car) => { car.model = v; })),
      textField('Manufacturer', () => state.car.manufacturer, (v) => updateCarInfo((car) => { car.manufacturer = v; })),
      row('Fuel types', fuel),
      h('p.note', 'Returned by car.getInfo(). serialNumber only appears with "vehicle.identity".'),
    ),
    section('Raw car events (car.raw)',
      h('div.inline', remoteName, remotePayload, button('Send', () => {
        let payload = null;
        try { payload = remotePayload.value.trim() ? JSON.parse(remotePayload.value) : null; } catch { payload = remotePayload.value; }
        emit('car', 'remoteEvent', { event: remoteName.value, payload });
      })),
      h('div.inline', openURL, button('Send openURL', () => emit('car', 'openURL', { url: openURL.value }))),
      rawNote,
    ),
  );
}

function kvRow(label, get) {
  const v = h('span.kv-v');
  syncs.push(() => { v.textContent = get(); });
  return h('div.kv-row', h('span.kv-k', label), v);
}

// ----------------------------------------------------------------- media

function buildMedia(panel) {
  const art = h('img.np-art', { alt: '' });
  const placeholder = h('div.np-art.placeholder', icon(icons.music));
  const title = h('div.np-title');
  const sub = h('div.np-sub');
  const seek = h('input.np-seek', { type: 'range', min: 0, max: 100, step: 1, value: 0 });
  const elapsed = h('span');
  const remaining = h('span');
  const playBtn = h('button.np-btn.main', { title: 'Play/Pause', onclick: () => media.toggle() });
  let seeking = false;
  seek.addEventListener('input', () => { seeking = true; elapsed.textContent = fmtTime(Number(seek.value)); });
  seek.addEventListener('change', () => { seeking = false; media.seek(Number(seek.value)); });

  const list = h('div.tracks');
  const perm = h('p.note');
  const editTitle = h('input', { type: 'text', placeholder: 'Title' });
  const editArtist = h('input', { type: 'text', placeholder: 'Artist' });
  const editAlbum = h('input', { type: 'text', placeholder: 'Album' });
  const editDuration = h('input', { type: 'number', min: 1, step: 1, placeholder: 'Duration (s)' });
  const editing = () => [editTitle, editArtist, editAlbum, editDuration].includes(document.activeElement);
  const applyEdit = () => media.edit({
    title: editTitle.value, artist: editArtist.value, album: editAlbum.value, duration: Number(editDuration.value),
  });
  for (const el of [editTitle, editArtist, editAlbum, editDuration]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyEdit(); });

  const renderNP = () => {
    const np = media.nowPlaying();
    const url = np ? media.artwork(160) : null;
    art.hidden = !url;
    placeholder.hidden = !!url;
    if (url && art.getAttribute('src') !== url) art.src = url;
    title.textContent = np ? np.title : 'Nothing playing';
    sub.textContent = np ? `${np.artist} — ${np.album}` : 'Press play or pick a track below';
    playBtn.replaceChildren(icon(np && np.playing ? icons.pause : icons.play));
    seek.disabled = !np;
    seek.max = np ? np.duration : 100;
    for (const [i, el] of [...list.children].entries()) {
      el.classList.toggle('current', i === media.index);
      el.querySelector('.track-title').textContent = LIBRARY[i].title;
      el.querySelector('.track-artist').textContent = `${LIBRARY[i].artist} · ${LIBRARY[i].genre}`;
      el.querySelector('.track-dur').textContent = fmtTime(LIBRARY[i].duration);
    }
    if (!editing()) {
      editTitle.value = np ? np.title : '';
      editArtist.value = np ? np.artist : '';
      editAlbum.value = np ? np.album : '';
      editDuration.value = np ? np.duration : '';
    }
    tickNP();
    const notes = [];
    if (!granted('media')) notes.push('"media" is not granted: the app gets EPERM for now playing.');
    if (!granted('media.control')) notes.push('"media.control" is not granted: transport calls from the app fail with EPERM.');
    perm.textContent = notes.join(' ');
  };
  const tickNP = () => {
    const np = media.track;
    const pos = media.position();
    if (!seeking) {
      seek.value = np ? pos : 0;
      elapsed.textContent = fmtTime(np ? pos : 0);
    }
    remaining.textContent = `–${fmtTime(np ? np.duration - pos : 0)}`;
  };

  LIBRARY.forEach((t, i) => {
    list.append(h('button.track', { onclick: () => media.load(i, true) },
      h('span.track-n', String(i + 1)),
      h('span.track-text', h('span.track-title', t.title), h('span.track-artist', `${t.artist} · ${t.genre}`)),
      h('span.track-dur', fmtTime(t.duration)),
    ));
  });

  panel.append(
    section('Now playing',
      h('div.np', h('div.np-art-wrap', art, placeholder), h('div.np-text', title, sub)),
      seek,
      h('div.np-times', elapsed, remaining),
      h('div.np-controls',
        h('button.np-btn', { title: 'Previous', onclick: () => media.track && media.previous() }, icon(icons.prev)),
        playBtn,
        h('button.np-btn', { title: 'Next', onclick: () => (media.track ? media.next() : media.play()) }, icon(icons.next)),
        h('button.np-btn', { title: 'Stop (nothing playing)', onclick: () => media.stop() }, icon(icons.stop)),
      ),
      selectBox('Source app', Object.entries(SOURCES), () => media.source, (v) => media.setSource(v)),
      perm,
    ),
    section('Edit now playing',
      h('div.edit-grid', editTitle, editArtist, editAlbum, editDuration),
      h('div.inline.end', button('Apply', applyEdit, 'primary')),
      h('p.note', 'Changes the current track and sends media.nowPlaying, as a new track would.'),
    ),
    section('Library', list),
  );
  bus.on('media', renderNP);
  syncs.push(renderNP);
  setInterval(tickNP, 500);
}

// -------------------------------------------------------------- location

function buildPlaces(panel) {
  const lat = h('input', { type: 'number', step: '0.0001' });
  const lon = h('input', { type: 'number', step: '0.0001' });
  const speed = h('input', { type: 'range', min: 5, max: 130, step: 5 });
  const speedOut = h('span.range-out');
  const course = h('input', { type: 'number', min: 0, max: 359, step: 5 });
  course.addEventListener('change', () => {
    const v = Number(course.value);
    if (Number.isFinite(v)) { state.loc.course = ((v % 360) + 360) % 360; persist(); pushLocation(); }
  });
  const fix = h('pre.fix');
  const navOut = h('div.kv');

  const apply = () => {
    const a = Number(lat.value);
    const b = Number(lon.value);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) setCoordinates(a, b);
  };
  lat.addEventListener('change', apply);
  lon.addEventListener('change', apply);
  speed.addEventListener('input', () => { state.loc.kmh = Number(speed.value); speedOut.textContent = `${speed.value} km/h`; persist(); });

  const renderFix = () => {
    if (document.activeElement !== lat) lat.value = state.loc.latitude.toFixed(5);
    if (document.activeElement !== lon) lon.value = state.loc.longitude.toFixed(5);
    speed.value = state.loc.kmh;
    speedOut.textContent = `${state.loc.kmh} km/h`;
    if (document.activeElement !== course) course.value = state.loc.course;
    const f = locationFix();
    fix.textContent = state.loc.available
      ? `lat ${f.latitude.toFixed(5)}  lon ${f.longitude.toFixed(5)}\nspeed ${f.speed} m/s  course ${f.course == null ? '–' : f.course + '°'}  ±${f.horizontalAccuracy} m`
      : 'Location services off: getCurrent() fails with EUNAVAILABLE';
    const n = navState();
    navOut.replaceChildren(...[
      ['navigating', String(n.navigating)],
      ['apps', n.apps.length ? n.apps.join(', ') : '[]'],
      ['mostRecent', n.mostRecent || 'null'],
      ['owner', n.owner == null ? 'null' : String(n.owner)],
    ].map(([k, v]) => h('div.kv-row', h('span.kv-k', k), h('span.kv-v', v))));
  };
  bus.on('location', renderFix);
  syncs.push(renderFix);

  const navNote = h('p.note');
  const locNote = h('p.note');
  syncs.push(() => {
    navNote.textContent = granted('navigation') ? '' : 'The app lacks "navigation": nav calls fail with EPERM.';
    locNote.textContent = granted('location') ? '' : 'The app lacks "location": location calls fail with EPERM.';
  });

  panel.append(
    section('Navigation',
      toggle('Navigating', () => state.nav.navigating, (v) => updateNav((n) => { n.navigating = v; }), 'sends nav.change'),
      textField('Navigation apps', () => state.nav.apps.join(', '), (v) => updateNav((n) => {
        n.apps = v.split(/[\s,]+/).filter(Boolean);
      }), 'com.apple.Maps, com.google.Maps'),
      navOut,
      navNote,
    ),
    section('Location',
      selectBox('Place', [...Object.entries(LOCATIONS).map(([k, v]) => [k, v.label]), ['custom', 'Custom']], () => state.loc.place, (v) => { if (v !== 'custom') setPlace(v); }),
      h('div.inline.coords', h('label', 'Lat', lat), h('label', 'Lon', lon)),
      toggle('Simulate drive', () => state.loc.driving, (v) => setDriving(v), 'moves the point every second'),
      row('Speed', h('div.range', speed, speedOut)),
      row('Course', h('div.range', course, h('span.range-out', '° from north'))),
      toggle('Driving limits UI', () => state.loc.limitWhileDriving, (v) => { state.loc.limitWhileDriving = v; persist(); }, 'sets limitedUI while moving'),
      toggle('Location available', () => state.loc.available, (v) => setLocationAvailable(v), 'off sends location.error'),
      fix,
      h('div.inline', button('Send update now', () => pushLocation())),
      locNote,
    ),
  );
}

// --------------------------------------------------------------- storage

let storageData = {};

function buildStorage(panel) {
  const table = h('div.store');
  const empty = h('p.empty', 'Nothing stored yet. Values written with CarPWA.storage.set() appear here.');
  const keyIn = h('input', { type: 'text', placeholder: 'key' });
  const valIn = h('input', { type: 'text', placeholder: 'JSON value, e.g. true or {"a":1}' });
  const err = h('p.note.err');
  const path = h('p.note.mono');

  const parse = (text) => {
    const t = text.trim();
    if (t === '') return null;
    try { return JSON.parse(t); } catch { return t; }   // bare words are stored as strings
  };

  const render = () => {
    table.replaceChildren();
    const keys = Object.keys(storageData);
    empty.hidden = keys.length > 0;
    for (const key of keys) {
      const value = h('textarea.store-v', { rows: 1, spellcheck: false });
      value.value = JSON.stringify(storageData[key]);
      value.addEventListener('change', () => ctx.request({ type: 'storage.set', key, value: parse(value.value) }).catch((e) => { err.textContent = e.message; }));
      table.append(h('div.store-row',
        h('div.store-k', { title: key }, key),
        value,
        h('button.icon-btn', { title: `Remove ${key}`, onclick: () => ctx.request({ type: 'storage.remove', key }) }, icon(icons.trash)),
      ));
    }
    const bytes = new Blob([JSON.stringify(storageData)]).size;
    const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    path.textContent = `${ctx.server.storageFile}  ·  ${size} of 5 MB`;
  };

  panel.append(
    section('App storage', table, empty,
      h('div.inline', keyIn, valIn, button('Set', () => {
        if (!keyIn.value) { err.textContent = 'Key is required.'; return; }
        err.textContent = '';
        ctx.request({ type: 'storage.set', key: keyIn.value, value: parse(valIn.value) })
          .then(() => { keyIn.value = ''; valIn.value = ''; })
          .catch((e) => { err.textContent = e.message; });
      })),
      err,
      h('div.inline.end', button('Clear all', () => { if (confirm('Clear all storage for this app?')) ctx.request({ type: 'storage.clear' }); }, 'danger')),
      path,
      h('p.note', 'Edits here reach open pages as storage.changed events, like writes from another page of the same app.'),
    ),
  );
  storageData = ctx.server.storage || {};
  render();
  bus.on('server:storage', (data) => { storageData = data; render(); });
}

// --------------------------------------------------------------- console

const MAX_LOG = 1500;
let logList = null;
let logFilter = 'all';
let stick = true;

function buildConsole(panel) {
  logList = h('div.log');
  logList.addEventListener('scroll', () => { stick = logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 8; });
  const filters = segmented(null, [['all', 'All'], ['console', 'Console'], ['calls', 'Calls'], ['events', 'Events'], ['errors', 'Errors']], () => logFilter, (v) => {
    logFilter = v;
    for (const el of logList.children) el.hidden = !matches(el.dataset);
    syncAll();
    scrollConsole(true);
  });
  panel.classList.add('console-panel');
  panel.append(
    h('div.console-bar', filters, h('button.icon-btn', { title: 'Clear', onclick: () => logList.replaceChildren() }, icon(icons.trash))),
    logList,
  );
  bus.on('log', (e) => {
    if (e.kind === 'call') addCall(e, 'car');
    else if (e.kind === 'notice') addLine({ cat: 'notice', tag: 'sim', text: e.text, ts: e.ts });
    else addEvent(e);
  });
  bus.on('system-log', (e) => {
    addLine({ cat: 'console', level: e.level === 'error' || e.level === 'fault' ? 'error' : 'info', tag: 'system', text: e.message });
    ctx.send({ type: 'log', level: e.level === 'fault' ? 'error' : e.level, message: `[system.log] ${e.message}` });
  });
  bus.on('server:log', (entry) => {
    addLine({ cat: 'console', level: entry.level, tag: entry.level === 'log' ? '' : entry.level, text: entry.args.map((a) => (typeof a === 'string' ? a : preview(a, 2000))).join(' '), ts: entry.ts });
  });
  bus.on('server:call', (e) => addCall(e, 'server'));
}

export function note(text, level = 'info') {
  addLine({ cat: 'notice', level, tag: 'sim', text });
}

function matches(d) {
  switch (logFilter) {
    case 'console': return d.cat === 'console';
    case 'calls': return d.cat === 'call';
    case 'events': return d.cat === 'event';
    case 'errors': return d.level === 'error' || d.level === 'warn';
    default: return true;
  }
}

function addLine({ cat, level = 'info', tag, text, ts = Date.now(), detail }) {
  if (!logList) return;
  const time = new Date(ts);
  const stamp = [time.getHours(), time.getMinutes(), time.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const el = h('div.log-line', { class: `lv-${level}` },
    h('span.log-time', stamp),
    tag ? h('span.log-tag', tag) : null,
    h('span.log-text', text),
  );
  el.dataset.cat = cat;
  el.dataset.level = level;
  if (detail) {
    el.classList.add('expandable');
    el.addEventListener('click', () => {
      const open = el.querySelector('.log-detail');
      if (open) open.remove();
      else el.append(h('pre.log-detail', detail));
    });
  }
  el.hidden = !matches(el.dataset);
  logList.append(el);
  while (logList.children.length > MAX_LOG) logList.firstChild.remove();
  if ((level === 'error') && activeTab !== 'console' && tabs.console) {
    unreadErrors++;
    tabs.console.badge.textContent = unreadErrors > 99 ? '99+' : String(unreadErrors);
  }
  scrollConsole();
}

function addCall(e, where) {
  const name = `${e.module}.${e.method}`;
  const params = e.params && Object.keys(e.params).length ? preview(e.params, 80) : '';
  const out = e.ok ? `→ ${preview(e.result, 90)}` : `✕ ${e.error.code} ${e.error.message}`;
  const detail = JSON.stringify({ params: e.params, ...(e.ok ? { result: e.result } : { error: e.error }), ms: e.ms }, null, 2);
  addLine({
    cat: 'call', level: e.ok ? 'info' : 'error', tag: where === 'server' ? 'server' : 'car',
    text: `${name}(${params}) ${out}${e.ms > 1 ? `  ${e.ms} ms` : ''}`, ts: e.ts, detail: detail.length > 20000 ? detail.slice(0, 20000) + '…' : detail,
  });
}

function addEvent(e) {
  addLine({ cat: 'event', level: 'info', tag: 'event', text: `${e.module}.${e.event} ${preview(e.data, 120)}`, ts: e.ts, detail: JSON.stringify(e.data, null, 2) });
}

function scrollConsole(force) {
  if (!logList) return;
  if (force || stick) requestAnimationFrame(() => { logList.scrollTop = logList.scrollHeight; });
}

// -------------------------------------------------------------- channels

function buildChannels(panel) {
  const joined = new Set();
  const chips = h('div.chips');
  const joinIn = h('input', { type: 'text', placeholder: 'channel name' });
  const chanIn = h('input', { type: 'text', placeholder: 'channel' });
  const dataIn = h('textarea', { rows: 3, placeholder: 'JSON data, e.g. {"hello":"car"}', spellcheck: false });
  const fromSel = h('select', h('option', { value: 'dev' }, 'from: dev'), h('option', { value: 'native' }, 'from: native'));
  const result = h('p.note');
  const log = h('div.log.small');

  const renderChips = () => chips.replaceChildren(...[...joined].map((c) => h('span.chip', c,
    h('button', { title: `Leave ${c}`, onclick: () => { joined.delete(c); ctx.send({ type: 'channel.leave', channel: c }); renderChips(); } }, '×'))));

  const join = () => {
    const c = joinIn.value.trim();
    if (!c || joined.has(c)) return;
    joined.add(c);
    ctx.send({ type: 'channel.join', channel: c });
    joinIn.value = '';
    renderChips();
  };
  joinIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  panel.append(
    section('Monitor',
      h('p.note', 'Every channel.publish from the app shows up here. Join a channel to also count as a receiver, like another app listening.'),
      h('div.inline', joinIn, button('Join', join)),
      chips,
      log,
    ),
    section('Publish',
      h('div.inline', chanIn, fromSel),
      dataIn,
      h('div.inline.end', button('Publish', () => {
        const channel = chanIn.value.trim();
        if (!channel) { result.textContent = 'Channel is required.'; return; }
        let data = null;
        const raw = dataIn.value.trim();
        if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
        ctx.request({ type: 'channel.publish', channel, data, from: fromSel.value })
          .then((r) => { result.textContent = `Delivered to ${r.result} page${r.result === 1 ? '' : 's'}.`; })
          .catch((e) => { result.textContent = e.message; });
      }, 'primary')),
      result,
    ),
  );
  bus.on('server:channel', (m) => {
    const line = h('div.log-line', h('span.log-time', new Date().toLocaleTimeString([], { hour12: false })),
      h('span.log-tag', m.channel), h('span.log-text', `${m.from}: ${preview(m.data, 300)}`));
    if (joined.has(m.channel)) line.classList.add('lv-info');
    log.append(line);
    while (log.children.length > 300) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  });
}

// -------------------------------------------------------------------- app

let appInfo = { errors: [], warnings: [] };

export function setAppInfo(info) {
  appInfo = info;
  syncAll();
}

function buildApp(panel) {
  const head = h('div.app-head');
  const perms = h('div.perms');
  const net = h('div.kv');
  const problems = h('div.problems');
  const subs = h('div.chips');
  const meta = h('div.kv');

  syncs.push(() => {
    const m = state.manifest;
    if (!m) return;
    head.replaceChildren(
      h('img.app-head-icon', { src: `/__carpwa_sim/app-icon?v=${(appInfo.iconInfo && appInfo.iconInfo.mtime) || 0}`, alt: '' }),
      h('div', h('div.app-head-name', m.name), h('div.app-head-id', `${m.id} · ${m.version}`)),
    );
    perms.replaceChildren(...Object.entries(PERMISSION_INFO).map(([p, desc]) => {
      const has = m.permissions.includes(p);
      return h('div.perm', { class: has ? 'on' : '' }, icon(has ? icons.check : icons.lock), h('div', h('code', p), h('small', desc)));
    }));
    net.replaceChildren(
      h('div.kv-row', h('span.kv-k', 'network.allow'), h('span.kv-v', m.network.allow.length ? m.network.allow.join(', ') : '–')),
    );
    problems.replaceChildren(
      ...appInfo.errors.map((e) => h('div.problem.err', icon(icons.warning), e)),
      ...appInfo.warnings.map((w) => h('div.problem.warn', icon(icons.warning), w)),
    );
    if (!appInfo.errors.length && !appInfo.warnings.length) problems.append(h('div.problem.ok', icon(icons.check), 'carpwa.json is valid'));
    subs.replaceChildren(...[...state.subs].sort().map((s) => h('span.chip.mono', s)));
    if (!state.subs.size) subs.append(h('span.note', 'none yet'));
    meta.replaceChildren(
      ...[
        ['start_url', m.start_url + (m.spa ? '  (spa)' : '')],
        ['background', m.background_color],
        ['icon', `${m.icon}${appInfo.iconInfo ? ` · ${appInfo.iconInfo.width}×${appInfo.iconInfo.height}` : ''}`],
        ['min_carpwa', m.min_carpwa || '–'],
        ['server pages', String(ctx.server.clients ?? 0)],
        ['SDK', ctx.server.sdkVersion],
        ['folder', ctx.server.dir],
      ].map(([k, v]) => h('div.kv-row', h('span.kv-k', k), h('span.kv-v', v))),
    );
  });

  panel.append(
    section(null, head, problems),
    section('Permissions',
      toggle('Enforce permissions', () => state.enforce, (v) => { state.enforce = v; bus.emit('change'); persist(); }, 'off: allow everything, for quick experiments'),
      perms, net,
    ),
    section('Active subscriptions', subs),
    section('Manifest', meta),
  );
}

export function serverUpdate(kind, data) {
  if (kind === 'clients') { ctx.server.clients = data; syncAll(); }
}

