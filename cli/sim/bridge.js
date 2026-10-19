// The mock car. Holds the simulated CarPlay state and exposes
// window.__CARPWA_SIM__, the car bridge the SDK finds from inside the app
// iframe (see findSimulator() / SimCarTransport in carpwa.js). Shapes follow
// carpwa.d.ts; permissions and error codes follow the manifest and protocol docs.

import { MediaPlayer } from './media.js';
import { stockApps } from './icons.js';

export const SIM_VERSION = '1.0.0-sim';

// ------------------------------------------------------------------ bus

const listeners = new Map();
export const bus = {
  on(name, fn) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); return () => listeners.get(name).delete(fn); },
  emit(name, data) { for (const fn of [...(listeners.get(name) || [])]) { try { fn(data); } catch (e) { console.error(e); } } },
};

// ---------------------------------------------------------------- state

export const LOCATIONS = {
  cupertino: { label: 'Cupertino, CA', latitude: 37.3349, longitude: -122.009, altitude: 56 },
  sf: { label: 'San Francisco, CA', latitude: 37.7793, longitude: -122.4193, altitude: 16 },
  berlin: { label: 'Berlin', latitude: 52.5163, longitude: 13.3777, altitude: 34 },
  london: { label: 'London', latitude: 51.5007, longitude: -0.1246, altitude: 11 },
  tokyo: { label: 'Tokyo', latitude: 35.6812, longitude: 139.7671, altitude: 40 },
  sydney: { label: 'Sydney', latitude: -33.8568, longitude: 151.2153, altitude: 5 },
};

export const INSETS = {
  none: { label: 'None', top: 0, left: 0, bottom: 0, right: 0 },
  curved: { label: 'Curved right edge', top: 0, left: 0, bottom: 0, right: 36 },
  bezel: { label: 'Bezel overlap (top & bottom)', top: 14, left: 0, bottom: 14, right: 0 },
  notched: { label: 'Rounded corners', top: 8, left: 8, bottom: 8, right: 8 },
};

export const FUEL_TYPES = ['gasoline', 'diesel', 'electric', 'cng'];

export const state = {
  manifest: null,
  presets: {},
  sdkVersion: '1.0.0',
  enforce: true,
  connected: true,
  nightMode: false,
  appearance: 'dark',          // 'light' | 'dark', or 'auto' (follows night mode)
  limitedUI: false,
  limitedKeyboard: true,       // which elements are limited while limitedUI is on
  limitedLists: true,
  rhd: false,
  preset: 'standard',
  input: 'touch',
  insets: 'none',
  showSafeArea: false,
  car: { name: 'CarPWA Simulator', model: 'Head Unit S1', manufacturer: 'CarPWA', fuelTypes: ['electric'] },
  view: 'app',                 // 'app' | 'home' | 'other'
  otherApp: null,
  bgColor: null,
  nav: { navigating: false, everNavigated: false, apps: ['com.apple.Maps'], owner: null },
  loc: {
    place: 'cupertino', ...LOCATIONS.cupertino,
    available: true, driving: false, kmh: 50, course: 90, limitWhileDriving: true,
  },
  capture: 'native',
  interceptBack: false,
  subs: new Set(),
  serial: 'SIM' + Math.random().toString(36).slice(2, 10).toUpperCase(),
};

export const media = new MediaPlayer((kind, np) => {
  emit('media', 'nowPlaying', np);
  if (kind !== 'seek') emit('media', 'playbackState', { playing: !!(np && np.playing) });
  bus.emit('media', np);
});

// The view layer (unit.js) fills these in.
export const view = {
  showAlert: async () => null,
  showBanner: () => {},
  frame: () => null,
};

// ------------------------------------------------------------- derived

/** Width of the CarPlay status bar drawn next to the app. */
export function dockWidth() { return Math.max(76, Math.min(120, Math.round(preset().height / 6))); }

/** The selected preset: the app's area in CSS px. */
export function preset() {
  return state.presets[state.preset] || { width: 800, height: 480, scale: 1, physical: [170, 87] };
}

export function appArea() {
  const p = preset();
  return { x: state.rhd ? 0 : dockWidth(), y: 0, width: p.width, height: p.height };
}

export function safeArea() {
  const i = INSETS[state.insets] || INSETS.none;
  return { top: i.top, left: i.left, bottom: i.bottom, right: i.right };
}

export function appearance() {
  if (state.appearance === 'auto') return state.nightMode ? 'dark' : 'light';
  return state.appearance;
}

export function granted(permission) {
  return !state.enforce || !permission || (state.manifest && state.manifest.permissions.includes(permission));
}

export function carInfo() {
  const p = preset();
  const info = {
    connected: state.connected,
    name: state.car.name || null,
    model: state.car.model || null,
    manufacturer: state.car.manufacturer || null,
    firmwareVersion: '3.2.1',
    hardwareVersion: 'HU-2026',
    fuelTypes: [...state.car.fuelTypes],
    rightHandDrive: state.rhd,
    transport: 'wireless',
    supportsACBack: true,
    supportsNightMode: true,
    supportsElectronicTollCollection: false,
    supportsDestinationSharing: true,
    displays: [{
      id: 'sim-main',
      pixelSize: { width: (p.width + dockWidth()) * p.scale, height: p.height * p.scale },
      physicalSize: p.physical ? { width: p.physical[0], height: p.physical[1] } : null,
      carPlay: true,
      instrumentCluster: false,
    }],
  };
  if (granted('vehicle.identity')) info.serialNumber = state.serial;
  return info;
}

export function limitedUIElements() {
  if (!state.limitedUI) return { keyboard: false, lists: false, raw: 0 };
  const keyboard = !!state.limitedKeyboard;
  const lists = !!state.limitedLists;
  return { keyboard, lists, raw: (keyboard ? 1 : 0) | (lists ? 2 : 0) };
}

export function carState() {
  return {
    connected: state.connected,
    nightMode: state.nightMode,
    appearance: appearance(),
    limitedUI: state.limitedUI,
    limitedUIElements: limitedUIElements(),
    viewArea: state.connected ? appArea() : null,
    safeArea: safeArea(),
    carOwnsScreen: false,
    carOwnsMainAudio: false,
    visible: state.connected && state.view === 'app',
  };
}

const INPUT_BITS = { touch: 1, knob: 2, touchpad: 4 };

export function screenInfo() {
  const p = preset();
  const primary = state.input;
  return {
    id: 'sim-main',
    width: p.width,
    height: p.height,
    scale: p.scale,
    pixelWidth: p.width * p.scale,
    pixelHeight: p.height * p.scale,
    physicalWidthMM: p.physical ? p.physical[0] : null,
    physicalHeightMM: p.physical ? p.physical[1] : null,
    maxFPS: 60,
    safeArea: safeArea(),
    interaction: {
      primary,
      touch: primary === 'touch',
      knob: primary === 'knob',
      touchpad: primary === 'touchpad',
      highFidelityTouch: primary === 'touch',
      raw: { available: INPUT_BITS[primary], primary: INPUT_BITS[primary] },
    },
  };
}

export function navState() {
  const apps = state.nav.navigating ? [...state.nav.apps] : [];
  return {
    navigating: state.nav.navigating,
    apps,
    mostRecent: state.nav.everNavigated ? state.nav.apps[0] || null : null,
    owner: state.nav.owner,
  };
}

export function locationFix() {
  const l = state.loc;
  return {
    latitude: round(l.latitude, 7),
    longitude: round(l.longitude, 7),
    altitude: l.altitude,
    horizontalAccuracy: l.driving ? 8 : 5,
    verticalAccuracy: 4,
    speed: l.driving ? round(l.kmh / 3.6, 2) : 0,
    course: l.driving ? round(l.course, 1) : null,
    timestamp: Date.now(),
  };
}

function round(v, digits) { const f = 10 ** digits; return Math.round(v * f) / f; }

// ------------------------------------------------------------ the page

let page = null;   // { win, onEvent }

/** True while the iframe's current document has the SDK attached. */
export function pageAttached() {
  if (!page) return false;
  try {
    const frame = view.frame();
    return !!frame && frame.contentWindow === page.win && !page.win.closed;
  } catch { return false; }
}

// Values cross into the iframe's realm so `instanceof Object`/`Array` hold there.
function toPage(value) {
  if (value === undefined) value = null;
  try { return page.win.JSON.parse(JSON.stringify(value)); } catch { return value; }
}

// Permissions per manifest.md. vehicle.identity only hides serialNumber.
const METHOD_PERMISSION = {
  'media.getNowPlaying': 'media',
  'media.getArtwork': 'media',
  'media.play': 'media.control',
  'media.pause': 'media.control',
  'media.togglePlayPause': 'media.control',
  'media.stop': 'media.control',
  'media.next': 'media.control',
  'media.previous': 'media.control',
  'media.seek': 'media.control',
  'media.skip': 'media.control',
  'nav.getState': 'navigation',
  'nav.requestOwnership': 'navigation',
  'nav.releaseOwnership': 'navigation',
  'location.getCurrent': 'location',
  'apps.open': 'apps.launch',
  'apps.openURL': 'apps.launch',
  'car.sendCommand': 'car.raw',
  'car.requestCarUI': 'car.raw',
};

const EVENT_PERMISSION = {
  'media.nowPlaying': 'media',
  'media.playbackState': 'media',
  'nav.change': 'navigation',
  'location.update': 'location',
  'location.error': 'location',
  'car.remoteEvent': 'car.raw',
  'car.openURL': 'car.raw',
};

function eventPermission(module, event) {
  return EVENT_PERMISSION[`${module}.${event}`] || null;
}

export function subscribed(module, event) {
  return state.subs.has(`${module}.${event}`) || state.subs.has(`${module}.*`);
}

/** Sends an event to the page if it subscribed and holds the permission. */
export function emit(module, event, data) {
  if (!pageAttached() || !subscribed(module, event) || !granted(eventPermission(module, event))) return false;
  const evt = { type: 'event', module, event, data: data === undefined ? null : data };
  bus.emit('log', { kind: 'event', module, event, data: evt.data, ts: Date.now() });
  try { page.onEvent(toPage(evt)); } catch (e) { console.error('[sim] page event handler threw', e); }
  return true;
}

// ----------------------------------------------------------- mutations

/**
 * Applies a change and sends the events a real head unit would: car.state
 * with the changed keys, then the narrow car events, then screen.change.
 */
export function update(mutate) {
  const carBefore = carState();
  const screenBefore = JSON.stringify(screenInfo());
  const wasConnected = state.connected;
  const wasVisible = carBefore.visible;
  mutate(state);
  const after = carState();
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(carBefore[k]));

  if (wasConnected && !state.connected) emit('car', 'disconnect', {});
  if (!wasConnected && state.connected) emit('car', 'connect', carInfo());
  if (changed.length) {
    emit('car', 'state', { state: after, changed });
    if (changed.includes('nightMode')) emit('car', 'nightMode', { nightMode: after.nightMode });
    if (changed.includes('appearance')) emit('car', 'appearance', { appearance: after.appearance });
    if (changed.includes('limitedUI') || changed.includes('limitedUIElements')) {
      emit('car', 'limitedUI', { limitedUI: after.limitedUI, limitedUIElements: after.limitedUIElements });
    }
    if (changed.includes('viewArea') || changed.includes('safeArea')) emit('car', 'viewArea', { viewArea: after.viewArea, safeArea: after.safeArea });
  }
  const screenAfter = screenInfo();
  if (JSON.stringify(screenAfter) !== screenBefore) emit('screen', 'change', screenAfter);
  if (wasVisible !== after.visible) emit('ui', after.visible ? 'foreground' : 'background', {});
  bus.emit('change');
  persist();
}

export function setView(next, otherApp = null) {
  update((s) => { s.view = next; s.otherApp = next === 'other' ? otherApp : null; });
}

export function updateNav(mutate) {
  mutate(state.nav);
  if (state.nav.navigating) state.nav.everNavigated = true;
  emit('nav', 'change', navState());
  bus.emit('change');
  persist();
}

export function updateCarInfo(mutate) {
  mutate(state.car);
  bus.emit('change');
  persist();
}

// ------------------------------------------------------------ location

export function setPlace(key) {
  const p = LOCATIONS[key];
  if (!p) return;
  Object.assign(state.loc, { place: key, latitude: p.latitude, longitude: p.longitude, altitude: p.altitude });
  pushLocation();
}

export function setCoordinates(latitude, longitude) {
  Object.assign(state.loc, { place: 'custom', latitude, longitude });
  pushLocation();
}

export function setDriving(on) {
  state.loc.driving = on;
  if (state.loc.limitWhileDriving) update((s) => { s.limitedUI = on; });
  pushLocation();
}

export function setLocationAvailable(on) {
  state.loc.available = on;
  if (!on) emit('location', 'error', { code: 'EUNAVAILABLE', message: 'Location services are off' });
  else pushLocation();
  bus.emit('change');
}

export function pushLocation() {
  if (state.loc.available) emit('location', 'update', locationFix());
  bus.emit('location');
  persist();
}

// The simulated drive: one fix per second, `speed` metres along `course`
// (degrees clockwise from north).
setInterval(() => {
  const l = state.loc;
  if (!l.driving) return;
  const metres = l.kmh / 3.6;
  const rad = (l.course * Math.PI) / 180;
  const north = Math.cos(rad) * metres;
  const east = Math.sin(rad) * metres;
  l.latitude = Math.max(-89.9, Math.min(89.9, l.latitude + north / 111320));
  l.longitude = ((l.longitude + east / (111320 * Math.cos((l.latitude * Math.PI) / 180)) + 540) % 360) - 180;
  l.place = 'custom';
  pushLocation();
}, 1000);

// --------------------------------------------------------------- input

/** Input from the simulated knob/touchpad/steering wheel or the keyboard. */
export function input(kind, data = {}) {
  bus.emit('input', { kind, ...data });
  if (view.handleInput && view.handleInput(kind, data)) return;   // alert, home screen
  if (!state.connected || state.view !== 'app') return;

  if (kind === 'back') {
    if (state.interceptBack && emit('input', 'back', {})) return;
    setView('home');
    return;
  }
  if (state.capture === 'app') {
    if (kind === 'move') emit('input', 'move', { direction: data.direction });
    else if (kind === 'select') emit('input', 'select', { phase: data.phase });
    return;
  }
  // Native capture: WebKit moves DOM focus and activates the focused element.
  nativeFocus(kind, data);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function nativeFocus(kind, data) {
  const frame = view.frame();
  let doc;
  try { doc = frame && frame.contentDocument; } catch { return; }
  if (!doc) return;
  const list = [...doc.querySelectorAll(FOCUSABLE)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!list.length) return;
  const active = doc.activeElement;
  if (kind === 'select') {
    if (data.phase === 'up' && active && active !== doc.body) active.click();
    return;
  }
  const idx = list.indexOf(active);
  const forward = ['next', 'down', 'right'].includes(data.direction);
  const next = idx < 0 ? list[0] : list[(idx + (forward ? 1 : -1) + list.length) % list.length];
  try { next.focus({ focusVisible: true }); } catch { next.focus(); }
}

// -------------------------------------------------------------- bridge

class BridgeError {
  constructor(code, message) { this.code = code; this.message = message; this.name = 'CarPWAError'; }
}
const fail = (code, message) => { throw new BridgeError(code, message); };
const needPlaying = () => { if (!media.track) fail('EUNAVAILABLE', 'nothing is playing'); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function log(text) {
  bus.emit('log', { kind: 'notice', text, ts: Date.now() });
}

const MODULES = {
  car: {
    permission: null,
    events: ['state', 'nightMode', 'appearance', 'limitedUI', 'viewArea', 'connect', 'disconnect', 'remoteEvent', 'openURL'],
    methods: {
      getInfo: () => carInfo(),
      getState: () => carState(),
      sendCommand: (p) => {
        if (typeof p.command !== 'string' || !p.command) fail('EINVAL', 'command must be a non-empty string');
        view.showBanner({ title: 'car.sendCommand', subtitle: p.command, system: true });
        return true;
      },
      requestCarUI: (p) => {
        view.showBanner({ title: 'Car UI requested', subtitle: p.url || 'the head unit would show its own screen', system: true });
        return true;
      },
    },
  },
  screen: {
    permission: null,
    events: ['change'],
    methods: { getInfo: () => screenInfo() },
  },
  media: {
    permission: 'media',
    events: ['nowPlaying', 'playbackState'],
    methods: {
      getNowPlaying: () => media.nowPlaying(),
      getArtwork: (p) => media.artwork(isNum(p.size) ? p.size : 512),
      play: () => { media.play(); return true; },
      pause: () => { needPlaying(); media.pause(); return true; },
      togglePlayPause: () => { media.toggle(); return true; },
      stop: () => { media.stop(); return true; },
      next: () => { needPlaying(); media.next(); return true; },
      previous: () => { needPlaying(); media.previous(); return true; },
      seek: (p) => {
        if (!isNum(p.position)) fail('EINVAL', 'position must be a number of seconds');
        needPlaying();
        media.seek(p.position);
        return true;
      },
      skip: (p) => {
        if (!isNum(p.seconds)) fail('EINVAL', 'seconds must be a number');
        needPlaying();
        media.seek(media.position() + p.seconds);
        return true;
      },
    },
  },
  nav: {
    permission: 'navigation',
    events: ['change'],
    methods: {
      getState: () => navState(),
      requestOwnership: () => { updateNav((n) => { n.owner = state.manifest.id; }); return true; },
      releaseOwnership: () => { updateNav((n) => { if (n.owner === state.manifest.id) n.owner = null; }); return true; },
    },
  },
  location: {
    permission: 'location',
    events: ['update', 'error'],
    methods: {
      getCurrent: () => {
        if (!state.loc.available) fail('EUNAVAILABLE', 'Location services are off');
        return locationFix();
      },
    },
  },
  input: {
    permission: null,
    events: ['move', 'select', 'back'],
    methods: {
      setCaptureMode: (p) => {
        if (p.mode !== 'app' && p.mode !== 'native') fail('EINVAL', 'mode must be "app" or "native"');
        state.capture = p.mode;
        bus.emit('change');
        return true;
      },
      interceptBack: (p) => {
        state.interceptBack = p.enabled !== false;
        bus.emit('change');
        return true;
      },
    },
  },
  ui: {
    permission: null,
    events: ['foreground', 'background'],
    methods: {
      close: () => { setView('home'); return true; },
      alert: (p) => {
        if (p.title != null && typeof p.title !== 'string') fail('EINVAL', 'title must be a string');
        if (p.message != null && typeof p.message !== 'string') fail('EINVAL', 'message must be a string');
        let actions = p.actions == null ? [] : p.actions;
        if (!Array.isArray(actions)) fail('EINVAL', 'actions must be an array');
        for (const a of actions) {
          if (!a || typeof a.id !== 'string' || typeof a.title !== 'string') fail('EINVAL', 'each action needs a string id and title');
          if (a.style != null && !['default', 'cancel', 'destructive'].includes(a.style)) fail('EINVAL', `unknown action style "${a.style}"`);
        }
        if (!p.title && !p.message) fail('EINVAL', 'alert needs a title or a message');
        if (!actions.length) actions = [{ id: 'ok', title: 'OK', style: 'default' }];
        return view.showAlert({ title: p.title || '', message: p.message || '', actions });
      },
      banner: (p) => {
        if (typeof p.title !== 'string' || !p.title) fail('EINVAL', 'banner needs a title');
        if (p.subtitle != null && typeof p.subtitle !== 'string') fail('EINVAL', 'subtitle must be a string');
        if (p.duration != null && !isNum(p.duration)) fail('EINVAL', 'duration must be a number of seconds');
        view.showBanner({ title: p.title, subtitle: p.subtitle || '', duration: p.duration });
        return true;
      },
      setBackgroundColor: (p) => {
        if (typeof p.color !== 'string' || !CSS.supports('color', p.color)) fail('EINVAL', 'color must be a CSS color');
        state.bgColor = p.color;
        bus.emit('change');
        return true;
      },
    },
  },
  apps: {
    permission: null,
    events: [],
    methods: {
      list: () => ({
        carpwa: [appEntry()],
        carplay: stockApps.map(({ bundleId, name }) => ({ bundleId, name })),
      }),
      open: (p) => {
        if (typeof p.id !== 'string' || !p.id) fail('EINVAL', 'id must be a string');
        if (p.id === state.manifest.id) { setView('app'); return true; }
        const app = stockApps.find((a) => a.bundleId === p.id);
        if (app) setView('other', app.bundleId);
        else log(`apps.open("${p.id}"): would open that app on a real car`);
        return true;
      },
      openURL: (p) => {
        let url;
        try { url = new URL(p.url); } catch { fail('EINVAL', 'url must be an absolute URL'); }
        const target = /^(maps:|https?:\/\/maps\.apple\.com)/.test(url.href) ? 'com.apple.Maps'
          : url.protocol === 'tel:' ? 'com.apple.mobilephone'
            : url.protocol === 'sms:' ? 'com.apple.MobileSMS'
              : url.protocol === 'music:' ? 'com.apple.Music' : null;
        if (target) setView('other', target);
        else view.showBanner({ title: 'Opening URL', subtitle: url.href, system: true });
        log(`apps.openURL("${url.href}")`);
        return true;
      },
    },
  },
  system: {
    permission: null,
    events: [],
    methods: {
      info: () => {
        let timeZone = 'UTC';
        try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* default */ }
        return {
          carpwaVersion: SIM_VERSION,
          iosVersion: '17.5',
          device: 'iPhone15,2',
          locale: navigator.language || 'en-US',
          timeZone,
          devMode: true,
          plugins: [],
        };
      },
      log: (p) => {
        const level = ['debug', 'info', 'error', 'fault'].includes(p.level) ? p.level : 'info';
        bus.emit('system-log', { level, message: String(p.message) });
        return true;
      },
    },
  },
};

export function appEntry() {
  const m = state.manifest;
  const port = Number(location.port) || 80;
  return { id: m.id, name: m.name, version: m.version, port, url: `http://127.0.0.1:${port}/${m.start_url}` };
}

const DISCONNECTED_OK = new Set(['car.getInfo', 'car.getState', 'screen.getInfo', 'system.info', 'system.log', 'apps.list']);

function dispatch(module, method, params) {
  if (module === '$registry') {
    if (method !== 'modules') fail('ENOTFOUND', `no such method $registry.${method}`);
    return Object.entries(MODULES).map(([name, m]) => ({
      name, methods: Object.keys(m.methods), events: m.events, permission: m.permission,
    }));
  }
  const mod = MODULES[module];
  if (!mod) fail('ENOTFOUND', `no such module ${module}`);

  if (method === '$subscribe' || method === '$unsubscribe') {
    const event = params.event;
    if (typeof event !== 'string' || !event) fail('EINVAL', 'event must be a string');
    if (event !== '*' && !mod.events.includes(event)) fail('ENOTFOUND', `no such event ${module}.${event}`);
    const key = `${module}.${event}`;
    if (method === '$subscribe') {
      const perm = event === '*' ? null : eventPermission(module, event);
      if (perm && !granted(perm)) fail('EPERM', `${key} events need the "${perm}" permission in carpwa.json`);
      state.subs.add(key);
    } else {
      state.subs.delete(key);
    }
    bus.emit('change');
    return true;
  }

  const fn = mod.methods[method];
  if (!fn) fail('ENOTFOUND', `no such method ${module}.${method}`);
  const perm = METHOD_PERMISSION[`${module}.${method}`];
  if (perm && !granted(perm)) fail('EPERM', `${module}.${method} needs the "${perm}" permission in carpwa.json`);
  if (!state.connected && !DISCONNECTED_OK.has(`${module}.${method}`)) fail('EUNAVAILABLE', 'no CarPlay session (the car is disconnected)');
  return fn(params);
}

function call(module, method, params) {
  const started = performance.now();
  const entry = { kind: 'call', module, method, params: plain(params), ts: Date.now() };
  const done = (ok, value) => {
    entry.ms = Math.round(performance.now() - started);
    entry.ok = ok;
    if (ok) entry.result = value; else entry.error = { code: value.code || 'EINTERNAL', message: value.message || String(value) };
    bus.emit('log', entry);
  };
  let result;
  try {
    result = dispatch(module, method, plain(params) || {});
  } catch (e) {
    const err = e instanceof BridgeError ? e : new BridgeError('EINTERNAL', (e && e.message) || String(e));
    done(false, err);
    throw { code: err.code, message: err.message };
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { done(true, v); return toPage(v); },
      (e) => { done(false, e); throw { code: e.code || 'EINTERNAL', message: e.message || String(e) }; },
    );
  }
  done(true, result);
  return toPage(result);
}

function plain(v) {
  try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch { return v; }
}

export function installBridge() {
  window.__CARPWA_SIM__ = {
    // Read by the SDK right after attach(); a getter so it is always current.
    get native() {
      return toPage({
        appId: state.manifest.id,
        version: SIM_VERSION,
        devMode: true,
        sessionKey: null,
        initialState: { car: carState(), screen: screenInfo() },
      });
    },
    attach(win, onEvent) {
      page = { win, onEvent };
      state.subs = new Set();
      state.capture = 'native';
      state.interceptBack = false;
      state.bgColor = null;
      bus.emit('attach', win);
      bus.emit('change');
    },
    call,
  };
}

// --------------------------------------------------------- persistence

const SAVED = ['enforce', 'connected', 'nightMode', 'appearance', 'limitedUI', 'limitedKeyboard', 'limitedLists',
  'rhd', 'preset', 'input', 'insets', 'showSafeArea', 'car'];
let storageKey = null;
let cliDefaults = null;

export function restore(appId, defaults) {
  storageKey = `carpwa-sim:${appId}`;
  Object.assign(state, defaults);
  cliDefaults = { preset: defaults.preset, input: defaults.input };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved) {
      for (const k of SAVED) if (k in saved) state[k] = saved[k];
      // New command-line flags win over what this tab remembered.
      if (saved.cli && saved.cli.preset !== defaults.preset) state.preset = defaults.preset;
      if (saved.cli && saved.cli.input !== defaults.input) state.input = defaults.input;
      if (saved.loc) Object.assign(state.loc, saved.loc, { driving: false });
      if (saved.nav) Object.assign(state.nav, saved.nav);
      if (!state.presets[state.preset]) state.preset = defaults.preset;
    }
  } catch { /* private mode */ }
  state.view = 'app';
}

let persistTimer = null;
export function persist() {
  if (!storageKey) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const out = {};
      for (const k of SAVED) out[k] = state[k];
      const { place, latitude, longitude, altitude, kmh, course, limitWhileDriving, available } = state.loc;
      out.loc = { place, latitude, longitude, altitude, kmh, course, limitWhileDriving, available };
      out.nav = { apps: state.nav.apps };
      out.cli = cliDefaults;
      sessionStorage.setItem(storageKey, JSON.stringify(out));
    } catch { /* ignore */ }
  }, 200);
}
