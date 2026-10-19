// Current weather from Open-Meteo through CarPWA.net.fetch (no CORS, and only
// the hosts in carpwa.json's network.allow). Uses the car's location when it
// has one, the default city from the settings otherwise, and keeps the last
// reading in storage so an offline car still shows something.

import { $, setText, explain, requireServer, ago } from '../lib/util.js';
import { onLocation } from '../lib/location.js';

const REFRESH_MS = 15 * 60 * 1000;
const WAIT_FOR_FIX_MS = 4000;
const CACHE_KEY = 'weather';

// WMO weather codes → [label, day icon, night icon].
const CONDITIONS = [
  [[0], 'Clear', 'sun', 'moon'],
  [[1], 'Mostly clear', 'sun', 'moon'],
  [[2], 'Partly cloudy', 'partly', 'partly-night'],
  [[3], 'Cloudy', 'cloud', 'cloud'],
  [[45, 48], 'Fog', 'fog', 'fog'],
  [[51, 53, 55, 56, 57], 'Drizzle', 'rain', 'rain'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Rain', 'rain', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'Snow', 'snow', 'snow'],
  [[95, 96, 99], 'Thunderstorms', 'storm', 'storm'],
];

const ERRORS = {
  EPERM: 'Weather needs the network permission',
  EUNAVAILABLE: 'Offline',
  ETIMEOUT: 'Weather service is slow',
};

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * rad * Math.cos(((a.latitude + b.latitude) / 2) * rad);
  const y = (b.latitude - a.latitude) * rad;
  return Math.hypot(x, y) * 6371;
}

export function mountWeather({ settings }) {
  let here = null;     // last live fix used for weather
  let reading = null;  // { temp (°C), code, day, place, at }
  let timer = 0;
  let started = false;

  function render() {
    if (!reading) return;
    const temp = settings.imperial() ? (reading.temp * 9) / 5 + 32 : reading.temp;
    const [, label, dayIcon, nightIcon] = CONDITIONS.find(([codes]) => codes.includes(reading.code)) || [[], 'Unknown', 'cloud', 'cloud'];
    setText('weather-temp', `${Math.round(temp)}°`);
    setText('weather-desc', label);
    setText('weather-place', reading.place);
    $('weather-icon').setAttribute('href', `#i-${reading.day ? dayIcon : nightIcon}`);
  }

  function note(text) {
    setText('weather-note', text);
  }

  function place() {
    if (here) return { lat: here.latitude, lon: here.longitude, name: 'Current location' };
    const city = settings.city();
    return { lat: city.lat, lon: city.lon, name: city.name };
  }

  async function update() {
    started = true;
    clearTimeout(timer);
    timer = setTimeout(update, REFRESH_MS);
    const p = place();
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${p.lat.toFixed(2)}&longitude=${p.lon.toFixed(2)}&current=temperature_2m,weather_code,is_day`;
    try {
      requireServer();
      const res = await CarPWA.net.fetch(url, { timeout: 15 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { current } = await res.json();
      reading = { temp: current.temperature_2m, code: current.weather_code, day: current.is_day !== 0, place: p.name, at: Date.now() };
      render();
      note('');
      // Only a cache for offline starts; if saving fails the screen is already right.
      if (CarPWA.env.server) CarPWA.storage.set(CACHE_KEY, reading).catch(() => {});
    } catch (e) {
      const why = explain(e, ERRORS, 'Weather unavailable');
      note(reading ? `${why} · updated ${ago(reading.at)}` : why);
      if (!reading) setText('weather-desc', 'No weather');
    }
  }

  // Show the last reading straight away, then fetch a fresh one.
  if (CarPWA.env.server) {
    CarPWA.storage.get(CACHE_KEY).then((cached) => {
      if (cached && typeof cached.temp === 'number' && !reading) {
        reading = cached;
        render();
        note(`Updated ${ago(cached.at)}`);
      }
    }, () => {}); // no cache is the normal first run
  }

  // A live fix wins; refetch when the car has moved a few kilometres.
  onLocation(({ fix, error }) => {
    if (fix && (!here || distanceKm(here, fix) > 5)) {
      here = fix;
      update();
    } else if (error && !started) {
      update(); // no location: use the default city now rather than waiting
    }
  });
  setTimeout(() => { if (!started) update(); }, WAIT_FOR_FIX_MS);

  settings.onChange(() => {
    render(); // units
    if (!here && started && (!reading || reading.place !== settings.city().name)) update(); // default city
  });

  CarPWA.app.on('serverConnected', () => { if (started) update(); });
  CarPWA.ui.on('foreground', () => {
    if (!reading || Date.now() - reading.at > REFRESH_MS) update();
  });
}
