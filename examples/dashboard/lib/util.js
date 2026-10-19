// Small helpers shared by the widgets.

export const $ = (id) => document.getElementById(id);

/** Sets text only when it changed, so screen readers and layout stay calm. */
export function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

const MESSAGES = {
  ENOTCAR: 'Not on CarPlay',
  EPERM: 'Permission not granted',
  EUNAVAILABLE: 'Not available right now',
  ETIMEOUT: 'No answer, will retry',
  EINVAL: 'Unexpected request',
};

/**
 * A short, calm line for a widget's status: CarPWAError codes become plain
 * words. `overrides` maps codes to widget-specific wording; `fallback` is
 * used for anything without a code (a parse error, a bad HTTP status).
 */
export function explain(e, overrides = {}, fallback = 'Something went wrong') {
  const code = e && e.code;
  return overrides[code] || MESSAGES[code] || fallback;
}

/**
 * Server modules (storage, channel, net) need carpwad, or `carpwa sim`. In a
 * plain web server the SDK would queue those calls until they time out, so
 * fail fast instead.
 */
export function requireServer() {
  if (!CarPWA.env.server) throw new CarPWA.Error('EUNAVAILABLE', 'No CarPWA server');
}

/** "just now", "5 min ago", "2 h ago". */
export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** True when the element takes up space (not display:none, not inside a hidden widget). */
export const isShown = (el) => !!el && el.getClientRects().length > 0;
