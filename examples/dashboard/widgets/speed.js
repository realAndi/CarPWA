// Speed from the phone's GPS (location.watch). The km/h ↔ mph button saves
// the choice in the settings, which also switch the weather to °F.

import { $, setText, explain } from '../lib/util.js';
import { onLocation } from '../lib/location.js';

const STALE_MS = 10000; // a fix older than this no longer says how fast we go
const ERRORS = { EPERM: 'Location not allowed', EUNAVAILABLE: 'No GPS right now' };

export function mountSpeed({ settings }) {
  let fix = null;
  let error = null;
  let unsaved = false; // the unit toggle worked but could not be stored

  function render() {
    const imperial = settings.imperial();
    setText('speed-unit', imperial ? 'mph' : 'km/h');
    $('speed-unit').setAttribute('aria-label', `Speed unit: ${imperial ? 'miles' : 'kilometres'} per hour. Switch`);
    const fresh = fix && Date.now() - fix.timestamp < STALE_MS;
    const mps = fresh && fix.speed != null && fix.speed >= 0 ? fix.speed : null;
    setText('speed-value', mps == null ? '–' : String(Math.round(mps * (imperial ? 2.236936 : 3.6))));
    if (error && !fresh) setText('speed-note', explain(error, ERRORS));
    else if (!fresh) setText('speed-note', 'Waiting for GPS…');
    else if (mps == null) setText('speed-note', 'No speed reading');
    else setText('speed-note', unsaved ? 'Unit not saved' : '');
  }

  $('speed-unit').addEventListener('click', async () => {
    unsaved = !!(await settings.update({ units: settings.imperial() ? 'metric' : 'imperial' }));
    render();
  });

  onLocation((s) => {
    fix = s.fix;
    error = s.error;
    render();
  });
  settings.onChange(render);
  setInterval(render, 2000); // notice when fixes stop coming
}
