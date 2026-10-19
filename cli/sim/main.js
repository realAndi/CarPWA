// Simulator shell bootstrap: talks to `carpwa sim` over /__carpwa_sim/ws,
// installs the car bridge, and wires the head unit and the inspector together.

import { $, h, icon } from './dom.js';
import { icons } from './icons.js';
import { installBridge, restore, state, bus, update, media } from './bridge.js';
import { mountUnit, loadApp, reloadIfDetached, setIcon, setZoom, showErrors } from './unit.js';
import { mountInspector, setAppInfo, note, serverUpdate, syncAll, select as showTab } from './inspector.js';

let ws = null;
let booted = false;
let server = null;
let rid = 0;
const pending = new Map();
let lastIconStamp = null;
let appId = null;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__carpwa_sim/ws`);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    receive(msg);
  };
  ws.onopen = () => $('#offline').classList.remove('visible');
  ws.onclose = () => {
    if (booted) $('#offline').classList.add('visible');
    for (const p of pending.values()) p.reject(new Error('simulator server disconnected'));
    pending.clear();
    setTimeout(connect, 1000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function request(msg) {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    pending.set(id, { resolve, reject });
    send({ ...msg, rid: id });
    setTimeout(() => { if (pending.delete(id)) reject(new Error('no reply from the simulator server')); }, 10000);
  });
}

function receive(msg) {
  switch (msg.type) {
    case 'hello': return hello(msg);
    case 'reply': {
      const p = pending.get(msg.rid);
      if (!p) return;
      pending.delete(msg.rid);
      if (msg.ok) p.resolve(msg); else p.reject(Object.assign(new Error(msg.error.message), msg.error));
      return;
    }
    case 'manifest': return manifestChanged(msg.app);
    case 'reload':
      note(`${msg.files.join(', ')} changed · dev.reload sent to ${msg.pages} page${msg.pages === 1 ? '' : 's'}`);
      if (reloadIfDetached()) note('the page has no SDK attached; reloaded it from the simulator');
      return;
    case 'log': return bus.emit('server:log', msg.entry);
    case 'server-call': return bus.emit('server:call', { ...msg.entry, ts: Date.now() });
    case 'storage': server.storage = msg.data; return bus.emit('server:storage', msg.data);
    case 'channel': return bus.emit('server:channel', msg.message);
    case 'clients': return serverUpdate('clients', msg.count);
  }
}

function hello(msg) {
  if (booted) {
    // The CLI restarted. A different app means a different simulator: start over.
    if (msg.app.manifest.id !== appId) { location.reload(); return; }
    Object.assign(server, msg);
    manifestChanged(msg.app);
    bus.emit('server:storage', msg.storage);
    serverUpdate('clients', msg.clients);
    note('reconnected to carpwa sim');
    loadApp('reload');
    return;
  }
  server = msg;
  booted = true;
  appId = msg.app.manifest.id;
  state.presets = msg.presets;
  state.sdkVersion = msg.sdkVersion;
  state.manifest = msg.app.manifest;
  restore(appId, { preset: msg.options.preset, input: msg.options.input });
  installBridge();

  const ctx = { send, request, server };
  mountUnit($('#stage'));
  mountInspector($('#inspector'), ctx);
  buildToolbar();
  manifestChanged(msg.app);
  loadApp('initial');
  note(`simulating ${msg.app.manifest.name} on a ${state.preset} (${state.presets[state.preset].width}×${state.presets[state.preset].height}) ${state.input} head unit`);
  bus.on('change', renderChips);
  renderChips();
}

function manifestChanged(app) {
  state.manifest = app.manifest;
  setAppInfo(app);
  showErrors(app.errors);
  const stamp = app.iconInfo ? app.iconInfo.mtime : 0;
  if (stamp !== lastIconStamp) {
    lastIconStamp = stamp;
    const url = `/__carpwa_sim/app-icon?v=${stamp}`;
    setIcon(url);
    $('#app-icon').src = url;
  }
  const m = app.manifest;
  $('#app-name').textContent = m.name;
  $('#app-id').textContent = `${m.id} · ${m.version}`;
  document.title = `${m.name} · CarPWA Simulator`;
  const status = $('#app-status');
  status.className = 'pill ' + (app.errors.length ? 'err' : app.warnings.length ? 'warn' : 'ok');
  status.textContent = app.errors.length ? `${app.errors.length} error${app.errors.length > 1 ? 's' : ''}`
    : app.warnings.length ? `${app.warnings.length} warning${app.warnings.length > 1 ? 's' : ''}` : 'valid';
  status.title = [...app.errors, ...app.warnings].join('\n') || 'carpwa.json is valid';
  $('#open-btn').href = `/${m.start_url}`;
  if (app.errors.length) note(`carpwa.json: ${app.errors.join('; ')}`, 'error');
  bus.emit('change');
}

// --------------------------------------------------------------- toolbar

function buildToolbar() {
  const screenSel = $('#screen-select');
  screenSel.replaceChildren(...Object.entries(state.presets).map(([k, p]) => h('option', { value: k }, `${k} · ${p.width}×${p.height}`)));
  screenSel.addEventListener('change', () => update((s) => { s.preset = screenSel.value; }));
  bus.on('change', () => { screenSel.value = state.preset; });
  screenSel.value = state.preset;

  const zoomSel = $('#zoom-select');
  let zoom = 'fit';
  try { zoom = sessionStorage.getItem('carpwa-sim:zoom') || 'fit'; } catch { /* default */ }
  zoomSel.value = zoom;
  setZoom(zoom);
  zoomSel.addEventListener('change', () => {
    setZoom(zoomSel.value);
    try { sessionStorage.setItem('carpwa-sim:zoom', zoomSel.value); } catch { /* ignore */ }
  });

  $('#app-chip').addEventListener('click', () => {
    $('#layout').classList.remove('no-inspector');
    $('#panel-btn').classList.add('on');
    showTab('app');
  });

  $('#reload-btn').append(icon(icons.reload));
  $('#reload-btn').addEventListener('click', () => { note('reload · manual'); loadApp('reload'); });
  $('#open-btn').append(icon(icons.external));
  const panelBtn = $('#panel-btn');
  panelBtn.append(icon(icons.panel));
  const togglePanel = () => {
    const hidden = $('#layout').classList.toggle('no-inspector');
    panelBtn.classList.toggle('on', !hidden);
  };
  panelBtn.addEventListener('click', togglePanel);

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'r' || e.key === 'R') { note('reload · manual'); loadApp('reload'); }
    if (e.key === 'i' || e.key === 'I') togglePanel();
  });
}

function renderChips() {
  const chips = [];
  const chip = (text, cls = '', ic = null) => chips.push(h('span.status-chip', { class: cls }, ic ? icon(ic) : null, text));
  if (!state.connected) chip('Disconnected', 'red');
  chip(state.nightMode ? 'Night' : 'Day', state.nightMode ? 'blue' : '', state.nightMode ? icons.moon : icons.sun);
  if (state.limitedUI) chip('Limited UI', 'amber', icons.car);
  if (state.input !== 'touch') chip(state.input === 'knob' ? 'Knob' : 'Touchpad', 'amber');
  if (state.capture === 'app') chip('Input captured');
  if (state.rhd) chip('RHD');
  if (state.view !== 'app' && state.connected) chip(state.view === 'home' ? 'Home screen' : 'Other app');
  if (media.playing) chip('Playing', '', icons.music);
  if (state.nav.navigating) chip('Navigating', '', icons.pin);
  if (state.loc.driving) chip(`${state.loc.kmh} km/h`, '', icons.car);
  if (!state.enforce) chip('Permissions off', 'red', icons.lock);
  $('#status-chips').replaceChildren(...chips);
}

bus.on('media', () => { if (booted) { renderChips(); syncAll(); } });
connect();
