// Tiny DOM helpers for the simulator shell.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * h('button.cp.primary', { onclick, title: 'x' }, 'label', child)
 * Attributes starting with "on" become listeners; `html` sets innerHTML;
 * `dataset`/`style` objects are merged; false/null attributes are skipped.
 */
export function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(svgString, cls = 'ic') {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = svgString;
  return span;
}

export function clockText(date = new Date()) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}

export function fmtTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Short one-line rendering of any JSON value for logs and tables. */
export function preview(value, max = 160) {
  let s;
  if (value === undefined) s = 'undefined';
  else if (typeof value === 'string') s = JSON.stringify(value);
  else { try { s = JSON.stringify(value); } catch { s = String(value); } }
  if (s && s.startsWith('"data:image/')) s = `"${s.slice(1, 24)}…" (${Math.round(s.length / 1024)} KB)`;
  return s && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function editable(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes((target.type || '').toLowerCase());
  return !!target.isContentEditable;
}
