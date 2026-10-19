// Terminal: a CarPlay home screen in the shape of a terminal. It launches
// CarPWA and CarPlay apps ("apps.launch") and shows what is playing
// ("media", "media.control"), who is navigating ("navigation") and how fast
// and where the car is heading ("location").
//
// The app list never scrolls: it shows as many rows as fit and pages with a
// "-- more --" row, like `more`. Every action is echoed on the prompt line,
// and so is every rejected call.

const $ = (id) => document.getElementById(id);

const ERRORS = {
  ENOTCAR: 'not on carplay',
  EPERM: 'permission denied',
  EUNAVAILABLE: 'unavailable',
  ENOTFOUND: 'not found',
  ETIMEOUT: 'timed out',
};
const why = (e) => ERRORS[e && e.code] || (e && e.message) || 'failed';
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'car';

// ---------------------------------------------------------------- prompt

const IDLE = 'ls apps/';
let promptTimer = 0;

function echo(text, error = false) {
  const cmd = $('cmd');
  cmd.textContent = text;
  cmd.classList.toggle('err', error);
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    cmd.textContent = IDLE;
    cmd.classList.remove('err');
  }, error ? 8000 : 4000);
}

const fail = (what) => (e) => echo(`${what}: ${why(e)}`, true);

// ------------------------------------------------------------------ apps

let apps = [];             // { id, name, kind: 'pwa' | 'car' }, CarPWA apps first
let page = 0;
let knobFirst = false;     // the car's main input is a knob or touchpad
const names = new Map();   // app id or bundle id → name, for the nav line

async function loadApps() {
  try {
    const { carpwa, carplay } = await CarPWA.apps.list();
    const byName = (a, b) => a.name.localeCompare(b.name);
    apps = [
      ...carpwa.filter((a) => a.id !== CarPWA.env.appId)
        .map((a) => ({ id: a.id, name: a.name, kind: 'pwa' })).sort(byName),
      ...carplay.map((a) => ({ id: a.bundleId, name: a.name || a.bundleId, kind: 'car' })).sort(byName),
    ];
    for (const a of apps) names.set(a.id, a.name);
  } catch (e) {
    fail('ls apps')(e);
  }
  renderApps({ focus: knobFirst && !CarPWA.focus.current });
}

// While driving, the car may ask apps to keep lists short.
const limitedLists = () => {
  const s = CarPWA.car.state;
  return !!(s && s.limitedUI && s.limitedUIElements && s.limitedUIElements.lists);
};

function rowsThatFit() {
  const row = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 52;
  return Math.max(2, Math.floor($('apps').clientHeight / row));
}

function entry(label, kind, action) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.className = kind === 'more' ? 'entry more' : 'entry';
  if (kind !== 'more') {
    const tag = document.createElement('span');
    tag.className = `tag ${kind}`;
    tag.textContent = kind;
    button.append(tag);
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  button.append(name);
  button.addEventListener('click', action);
  li.append(button);
  return li;
}

function renderApps({ focus = false } = {}) {
  const list = $('apps');
  const hadFocus = focus || list.contains(CarPWA.focus.current);
  const shown = limitedLists() ? apps.slice(0, 6) : apps;
  const rows = rowsThatFit();
  const perPage = shown.length > rows ? rows - 1 : rows;
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  page = Math.min(page, pages - 1);

  list.replaceChildren();
  for (const app of shown.slice(page * perPage, (page + 1) * perPage)) {
    list.append(entry(app.name, app.kind, () => open(app)));
  }
  if (pages > 1) {
    list.append(entry(`-- more (${page + 1}/${pages}) --`, 'more', () => {
      page = (page + 1) % pages;
      renderApps({ focus: true });
    }));
  }
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no apps';
    list.append(li);
  }
  $('page').textContent = pages > 1 ? `${page + 1}/${pages}` : '';
  if (hadFocus) CarPWA.focus.set(list.querySelector('.entry'));
}

async function open(app) {
  echo(`open ${slug(app.name)}`);
  try {
    await CarPWA.apps.open(app.id);
  } catch (e) {
    fail(`open ${slug(app.name)}`)(e);
  }
}

// ----------------------------------------------------------------- media

let np = null;      // NowPlaying on screen
let tick = 0;

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// `elapsed` was sampled at `elapsedAt`; extrapolate at the playback rate.
function position(n) {
  if (!n || n.elapsed == null) return 0;
  let pos = n.elapsed;
  if (n.playing && n.elapsedAt) pos += ((Date.now() - n.elapsedAt) / 1000) * (n.rate || 1);
  return Math.max(0, n.duration ? Math.min(pos, n.duration) : pos);
}

function drawProgress() {
  const dur = (np && np.duration) || 0;
  const pos = position(np);
  const width = innerHeight <= 320 ? 10 : 14;
  const filled = dur ? Math.round(Math.min(1, pos / dur) * width) : 0;
  $('np-bar').textContent = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
  $('np-time').textContent = dur ? `${fmt(pos)}/${fmt(dur)}` : '';
}

function renderMedia(next) {
  np = next || null;
  $('np-title').textContent = np ? np.title || 'untitled' : 'nothing playing';
  $('np-sub').textContent = np
    ? [np.artist, np.app && np.app.name].filter(Boolean).join(' · ')
    : 'start something on the phone';
  $('toggle').textContent = np && np.playing ? '||' : '>';
  drawProgress();
  clearInterval(tick);
  if (np && np.playing && np.duration) tick = setInterval(drawProgress, 1000);
}

function control(name, call) {
  return () => {
    echo(`media ${name}`);
    call().catch(fail(`media ${name}`));
  };
}

// ---------------------------------------------------------------- status

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const IMPERIAL = ['US', 'GB', 'LR', 'MM'];
let units = 'km/h';
let transport = '';

function renderNav(state) {
  const nav = $('nav');
  if (state && state.navigating) {
    nav.textContent = state.apps.map((id) => names.get(id) || id).join(', ');
    nav.classList.add('hot');
  } else {
    const last = state && state.mostRecent;
    nav.textContent = last ? `idle, last ${names.get(last) || last}` : 'idle';
    nav.classList.remove('hot');
  }
}

function renderFix(fix) {
  const mps = fix.speed;
  $('speed').textContent = mps == null ? '--' : `${Math.round(units === 'mph' ? mps * 2.23694 : mps * 3.6)} ${units}`;
  $('heading').textContent = fix.course == null
    ? '--'
    : `${COMPASS[Math.round(fix.course / 45) % 8]} ${String(Math.round(fix.course)).padStart(3, '0')}°`;
}

function renderCar(info) {
  $('who').textContent = `carpwa@${slug(info.name || info.model || 'car')}`;
  $('car').textContent = [info.manufacturer, info.model].filter(Boolean).join(' ') || info.name || 'unknown';
  transport = { wired: 'usb', wireless: 'wifi' }[info.transport] || '';
  renderFlags();
}

function renderScreen(screen) {
  if (!screen) return;
  $('screen').textContent = `${screen.width}x${screen.height}@${screen.scale} ${screen.interaction.primary}`;
}

let lastLimited = null;
function renderFlags() {
  const s = CarPWA.car.state || {};
  $('flags').textContent = [transport, s.nightMode && 'night', s.limitedUI && 'limited'].filter(Boolean).join(' · ');
  if (lastLimited !== null && lastLimited !== limitedLists()) renderApps();
  lastLimited = limitedLists();
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ----------------------------------------------------------------- start

tickClock();
setInterval(tickClock, 5000);
await CarPWA.ready();
knobFirst = ['knob', 'touchpad'].includes(CarPWA.screen.info && CarPWA.screen.info.interaction.primary);

loadApps();
CarPWA.ui.on('foreground', loadApps);   // something may have been installed meanwhile
CarPWA.screen.on('change', (screen) => { renderScreen(screen); renderApps(); });
addEventListener('resize', () => renderApps());

CarPWA.car.getInfo().then(renderCar, (e) => { $('car').textContent = why(e); });
CarPWA.car.on('state', renderFlags);
CarPWA.car.on('connect', renderCar);
renderScreen(CarPWA.screen.info);
renderFlags();

CarPWA.media.getNowPlaying().then(renderMedia, (e) => {
  $('np-title').textContent = 'media unavailable';
  $('np-sub').textContent = why(e);
});
CarPWA.media.on('nowPlaying', renderMedia);
CarPWA.media.on('playbackState', ({ playing }) => {
  if (np) renderMedia({ ...np, elapsed: position(np), elapsedAt: Date.now(), playing });
});
$('prev').addEventListener('click', control('previous', () => CarPWA.media.previous()));
$('toggle').addEventListener('click', control('toggle', () => CarPWA.media.togglePlayPause()));
$('next').addEventListener('click', control('next', () => CarPWA.media.next()));

CarPWA.nav.getState().then(renderNav, (e) => { $('nav').textContent = why(e); });
CarPWA.nav.on('change', renderNav);

CarPWA.system.info().then(({ locale }) => {
  if (IMPERIAL.includes(String(locale).split(/[_-]/)[1])) units = 'mph';
}, () => {});
CarPWA.location.on('error', (e) => { $('speed').textContent = why(e); });
CarPWA.location.watch(renderFix);

// Knob and touchpad cars: inverse video on the selected row while the knob
// drives the page; touching the screen hides it again.
if (knobFirst) document.documentElement.dataset.knob = '';
CarPWA.input.on('move', () => { document.documentElement.dataset.knob = ''; });
addEventListener('pointerdown', () => { delete document.documentElement.dataset.knob; });
CarPWA.focus.enable({ selector: '.entry, .key', initial: knobFirst ? '.entry' : false });
