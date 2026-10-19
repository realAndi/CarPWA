// Big clock and date in the phone's locale. Redraws on the minute, not every second.

import { setText } from '../lib/util.js';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export function mountClock() {
  let timer = 0;

  function tick() {
    clearTimeout(timer);
    const now = new Date();
    // "9:41 AM" → "9:41" large, "AM" small.
    const parts = timeFormat.formatToParts(now);
    setText('clock-time', parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim());
    setText('clock-period', (parts.find((p) => p.type === 'dayPeriod') || { value: '' }).value);
    setText('clock-date', dateFormat.format(now));
    timer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  tick();
  // Timers are throttled while another CarPlay app is on screen.
  CarPWA.ui.on('foreground', tick);
}
