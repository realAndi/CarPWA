// Inline SVG glyphs for the simulator. Generic shapes; no third-party artwork.

const svg = (body, view = '0 0 24 24') =>
  `<svg viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  play: svg('<path d="M7 4.5v15L20 12z" fill="currentColor"/>'),
  pause: svg('<path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/>'),
  next: svg('<path d="M16 5h2v14h-2zM4 5v14l11-7z" fill="currentColor"/>'),
  prev: svg('<path d="M6 5h2v14H6zM20 5v14L9 12z" fill="currentColor"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  back: svg('<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  home: svg('<g fill="currentColor"><rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/></g>'),
  reload: svg('<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 4v16" stroke="currentColor" stroke-width="2"/>'),
  rotateL: svg('<path d="M5 12a7 7 0 1 0 2.05-4.95M5 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  rotateR: svg('<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  car: svg('<path d="M5 16v2.5M19 16v2.5M4 16h16v-4l-2-5H6l-2 5zM4 12h16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="7.5" cy="14" r="1" fill="currentColor"/><circle cx="16.5" cy="14" r="1" fill="currentColor"/>'),
  music: svg('<path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/>'),
  pin: svg('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/>'),
  database: svg('<ellipse cx="12" cy="6" rx="7" ry="2.8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" fill="none" stroke="currentColor" stroke-width="2"/>'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 9l3 3-3 3M12.5 15H17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  broadcast: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  info: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor"/>'),
  sun: svg('<circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  warning: svg('<path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.3v.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/>'),
  signal: svg('<g fill="currentColor"><rect x="2" y="15" width="3.6" height="5" rx="1"/><rect x="7.4" y="11.5" width="3.6" height="8.5" rx="1"/><rect x="12.8" y="8" width="3.6" height="12" rx="1"/><rect x="18.2" y="4" width="3.6" height="16" rx="1"/></g>'),
};

// Home-screen and dock tiles for the stock apps the simulator pretends to have.
const tile = (glyph) => svg(glyph, '0 0 60 60');
export const stockApps = [
  {
    bundleId: 'com.apple.mobilephone', name: 'Phone', colors: ['#5af07a', '#1fb84a'],
    glyph: tile('<path d="M21 15c2-1 4 0 5 2l2 5c.6 1.6 0 3-1.3 4l-2 1.4c1.6 3.8 4.5 6.8 8.3 8.4l1.4-2c1-1.3 2.5-1.8 4-1.2l5 2c2 1 3 3 2 5l-1 2.4c-1 2.3-3.6 3.6-6 3C25.8 42.6 17.5 34.3 14.9 23.5c-.6-2.4.7-5 3-6z" fill="#fff"/>'),
  },
  {
    bundleId: 'com.apple.Music', name: 'Music', colors: ['#ff6a88', '#fa2d55'],
    glyph: tile('<path d="M24 41V20l18-4v20" fill="none" stroke="#fff" stroke-width="3.6" stroke-linejoin="round"/><circle cx="20" cy="41" r="5" fill="#fff"/><circle cx="38" cy="36" r="5" fill="#fff"/>'),
  },
  {
    bundleId: 'com.apple.Maps', name: 'Maps', colors: ['#7ed6a8', '#3aa76d'],
    glyph: tile('<path d="M0 38L60 18v12L0 50z" fill="#f4d35e"/><path d="M18 0h9l-6 60h-9z" fill="#fff" opacity=".85"/><path d="M38 14l10 22-10-5-10 5z" fill="#2f7cf6"/>'),
  },
  {
    bundleId: 'com.apple.MobileSMS', name: 'Messages', colors: ['#6af08b', '#2cc556'],
    glyph: tile('<path d="M30 15c10.5 0 18 6.4 18 14.3S40.5 43.6 30 43.6c-2 0-4-.2-5.8-.7L16.5 47l2.2-6.7C14.6 37.6 12 33.7 12 29.3 12 21.4 19.5 15 30 15z" fill="#fff"/>'),
  },
  {
    bundleId: 'com.apple.podcasts', name: 'Podcasts', colors: ['#c779ff', '#8a2be2'],
    glyph: tile('<circle cx="30" cy="26" r="5" fill="#fff"/><path d="M27 34h6l-1 12h-4z" fill="#fff"/><path d="M19 35a14 14 0 1 1 22 0M14.5 39a20 20 0 1 1 31 0" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>'),
  },
  {
    bundleId: 'com.apple.iBooks', name: 'Audiobooks', colors: ['#ffb347', '#ff7a00'],
    glyph: tile('<path d="M14 18c6-2 11-1 16 2v24c-5-3-10-4-16-2zM46 18c-6-2-11-1-16 2v24c5-3 10-4 16-2z" fill="#fff"/>'),
  },
  {
    bundleId: 'com.apple.Preferences', name: 'Settings', colors: ['#a7adb7', '#6c727c'],
    glyph: tile('<circle cx="30" cy="30" r="13" fill="none" stroke="#fff" stroke-width="4" stroke-dasharray="5 3.2"/><circle cx="30" cy="30" r="8" fill="none" stroke="#fff" stroke-width="3.4"/><circle cx="30" cy="30" r="2.6" fill="#fff"/>'),
  },
];
