// Settings kept in CarPWA.storage: a JSON object per app on the phone, so
// they survive reloads, app updates and phone restarts.

import { requireServer } from './util.js';

const KEY = 'settings';
const DEFAULTS = { units: 'metric', city: 'cupertino' };

export const CITIES = [
  { id: 'cupertino', name: 'Cupertino', lat: 37.32, lon: -122.03 },
  { id: 'new-york', name: 'New York', lat: 40.71, lon: -74.01 },
  { id: 'london', name: 'London', lat: 51.51, lon: -0.13 },
  { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.41 },
  { id: 'tokyo', name: 'Tokyo', lat: 35.68, lon: 139.65 },
  { id: 'sydney', name: 'Sydney', lat: -33.87, lon: 151.21 },
];

let current = { ...DEFAULTS };
const listeners = new Set();

function apply(value) {
  current = { ...DEFAULTS, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  listeners.forEach((fn) => fn(current));
}

export const settings = {
  get: () => current,
  imperial: () => current.units === 'imperial',
  city: () => CITIES.find((c) => c.id === current.city) || CITIES[0],

  /** Loads saved settings. Resolves with null, or the error (defaults stay in use). */
  async load() {
    try {
      requireServer();
      apply(await CarPWA.storage.get(KEY));
      return null;
    } catch (e) {
      return e;
    }
  },

  /** Applies a change at once and saves it. Resolves with null, or the save error. */
  async update(patch) {
    apply({ ...current, ...patch });
    try {
      requireServer();
      await CarPWA.storage.set(KEY, current);
      return null;
    } catch (e) {
      return e;
    }
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Another page of this app (or the simulator's storage inspector) changed them.
CarPWA.storage.onChange(({ key, value }) => {
  if (key === KEY) apply(value);
  else if (key === null) apply(null); // storage.clear()
});
