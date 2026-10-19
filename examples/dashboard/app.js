// Dashboard: a multi-widget CarPlay home screen. Each widget in widgets/ talks
// to the SDK on its own; this file starts them, owns the settings sheet and
// keeps knob focus on something visible.

import { $, setText, explain, isShown } from './lib/util.js';
import { settings, CITIES } from './lib/settings.js';
import { startLocation } from './lib/location.js';
import { mountClock } from './widgets/clock.js';
import { mountWeather } from './widgets/weather.js';
import { mountMedia } from './widgets/media.js';
import { mountNav } from './widgets/nav.js';
import { mountSpeed } from './widgets/speed.js';
import { mountCar } from './widgets/car.js';
import { mountChannel } from './widgets/channel.js';

mountClock();

// Storage, channels and net.fetch go through carpwad; ready() says whether it is there.
await CarPWA.ready();
let loadError = await settings.load();
CarPWA.app.on('serverConnected', async () => { loadError = await settings.load(); });

mountWeather({ settings });
mountMedia();
mountNav();
mountSpeed({ settings });
mountCar();
mountChannel();
startLocation();

// ------------------------------------------------------- settings sheet

const sheet = $('settings');
const board = $('board');
let stopBack = null;

$('cities').append(...CITIES.map((city) => {
  const button = document.createElement('button');
  button.dataset.city = city.id;
  button.textContent = city.name;
  return button;
}));

function renderSettings() {
  const { units, city } = settings.get();
  for (const b of $('units').children) b.setAttribute('aria-pressed', String(b.dataset.units === units));
  for (const b of $('cities').children) b.setAttribute('aria-pressed', String(b.dataset.city === city));
}

function openSettings() {
  renderSettings();
  setText('settings-note', loadError ? `Settings can’t be saved here (${explain(loadError).toLowerCase()}).` : '');
  sheet.hidden = false;
  // Keep the knob inside the sheet, and let the car's back button close it.
  board.setAttribute('data-carpwa-nofocus', '');
  CarPWA.focus.set(sheet.querySelector('[aria-pressed="true"]'));
  stopBack = CarPWA.input.on('back', closeSettings);
}

function closeSettings() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  board.removeAttribute('data-carpwa-nofocus');
  if (stopBack) {
    stopBack();
    stopBack = null;
    CarPWA.input.interceptBack(false).catch(() => {}); // only matters on CarPlay
  }
  CarPWA.focus.set($('open-settings'));
}

async function choose(patch) {
  const failed = await settings.update(patch);
  setText('settings-note', failed ? `Not saved (${explain(failed).toLowerCase()}); applies until the app reloads.` : 'Saved');
}

$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSettings(); });
$('units').addEventListener('click', (e) => {
  const button = e.target.closest('[data-units]');
  if (button) choose({ units: button.dataset.units });
});
$('cities').addEventListener('click', (e) => {
  const button = e.target.closest('[data-city]');
  if (button) choose({ city: button.dataset.city });
});
settings.onChange(renderSettings);

// ----------------------------------------------------------- knob focus

// Start with a highlighted control only where the knob is the main input.
const knobFirst = ['knob', 'touchpad'].includes(CarPWA.screen.info?.interaction.primary);
CarPWA.focus.enable({ initial: knobFirst ? '#media-toggle' : false });

// When the car limits the UI some widgets disappear; move focus off them.
// The SDK updates <html data-carpwa-limited> before car "state" listeners run.
CarPWA.car.on('state', () => {
  const current = CarPWA.focus.current;
  if (current && !isShown(current)) CarPWA.focus.move('next');
});
