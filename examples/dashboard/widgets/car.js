// The car's name and night mode. Neither needs a permission.

import { setText, explain } from '../lib/util.js';

export function mountCar() {
  function showInfo(info) {
    setText('car-name', info.name || [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Your car');
  }

  function showState(state) {
    setText('car-mode', state.nightMode ? 'Night mode' : 'Day mode');
  }

  function fail(e) {
    setText('car-name', 'No car');
    setText('car-mode', explain(e));
  }

  CarPWA.car.getInfo().then(showInfo, fail);
  CarPWA.car.getState().then(showState, () => {}); // getInfo() already shows why
  CarPWA.car.on('connect', showInfo);
  CarPWA.car.on('state', ({ state }) => showState(state));
}
