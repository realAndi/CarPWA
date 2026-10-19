// Navigation status: which app, if any, is giving directions right now.
// Needs the "navigation" permission.

import { $, setText, explain } from '../lib/util.js';

// Used until apps.list() answers, and for apps it does not name.
const KNOWN = {
  'com.apple.Maps': 'Maps',
  'com.google.Maps': 'Google Maps',
  'com.waze.iphone': 'Waze',
};

export function mountNav() {
  const widget = $('nav');
  const names = new Map(Object.entries(KNOWN));
  let state = null;

  function appName(bundleId) {
    if (!bundleId) return 'another app';
    return names.get(bundleId) || bundleId.split('.').pop();
  }

  function render() {
    const navigating = !!(state && state.navigating);
    widget.dataset.state = navigating ? 'navigating' : 'idle';
    if (navigating) {
      setText('nav-title', `Navigating with ${appName(state.mostRecent || state.apps[0])}`);
      setText('nav-line', state.apps.length > 1 ? `${state.apps.length} apps have routes` : 'Route in progress');
    } else {
      setText('nav-title', 'Not navigating');
      setText('nav-line', 'Start a route in a maps app');
    }
  }

  function fail(e) {
    widget.dataset.state = 'idle';
    setText('nav-title', 'Navigation unavailable');
    setText('nav-line', explain(e, { EPERM: 'Needs the navigation permission' }));
  }

  function set(next) {
    state = next;
    render();
  }

  // Friendly names for bundle ids; the CarPlay app list needs no permission.
  CarPWA.apps.list().then(({ carplay }) => {
    for (const app of carplay) if (app.name) names.set(app.bundleId, app.name);
    if (state) render();
  }, () => {}); // keep the built-in names

  CarPWA.nav.getState().then(set, fail);
  CarPWA.nav.on('change', set);
}
