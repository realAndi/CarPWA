// carpwa.json loading and validation (docs/guides/manifest.md). Every command
// that touches an app folder goes through validateApp() first.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { readPNGInfo } from './png.js';
import { sdkVersion } from './sdk.js';
import { c, CliError, ok, warn as printWarn, error as printError } from './log.js';

export const MANIFEST = 'carpwa.json';
export const ID_RE = /^[A-Za-z0-9.-]{1,128}$/;

/** Permission → what it unlocks. Mirrors the table in manifest.md. */
export const PERMISSIONS = {
  'media': 'media.getNowPlaying, media.getArtwork, media events',
  'media.control': 'media.play/pause/togglePlayPause/stop/next/previous/seek/skip',
  'navigation': 'nav.getState, nav events, nav.requestOwnership/releaseOwnership',
  'location': 'location.getCurrent, location.watch',
  'network': 'net.fetch (plus each host in network.allow)',
  'apps.launch': 'apps.open, apps.openURL',
  'vehicle.identity': 'serialNumber in car.getInfo',
  'car.raw': 'car.sendCommand, car.requestCarUI, car events remoteEvent and openURL',
};

const FIELDS = ['id', 'name', 'short_name', 'version', 'start_url', 'icon', 'background_color', 'spa', 'permissions', 'network', 'min_carpwa'];
const SHORT_NAME_MAX = 12;
const MIN_ICON = 180;
const HOST_RE = /^(\*\.)?([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/;
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const VERSION_RE = /^\d+(\.\d+)*$/;

/**
 * Validates an app folder.
 * @returns {{ dir: string, manifest: object|null, raw: object|null, errors: string[], warnings: string[] }}
 */
export function validateApp(dir = '.') {
  dir = resolve(dir);
  const errors = [];
  const warnings = [];
  const result = { dir, manifest: null, raw: null, errors, warnings };

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    errors.push(`${dir} is not a folder`);
    return result;
  }
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) {
    errors.push(`no ${MANIFEST} in ${dir}. Create one with \`carpwa create\`, or see docs/guides/manifest.md`);
    return result;
  }

  let raw;
  const text = readFileSync(file, 'utf8');
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    errors.push(`not valid JSON: ${describeJSONError(e, text)}`);
    return result;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${MANIFEST} must contain a JSON object`);
    return result;
  }
  result.raw = raw;

  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);
  const isStr = (v) => typeof v === 'string';

  // ---- id
  if (raw.id === undefined) err('"id" is required (reverse-DNS, e.g. "com.you.app")');
  else if (!isStr(raw.id)) err('"id" must be a string');
  else if (!ID_RE.test(raw.id)) {
    err(`"id" "${raw.id}" may only use letters, digits, "." and "-", 1–128 characters`);
  } else if (/^\.+$/.test(raw.id)) {
    err(`"id" "${raw.id}" is not a usable folder name`);
  } else {
    if (raw.id.startsWith('.') || raw.id.endsWith('.') || raw.id.includes('..')) {
      warn(`"id" "${raw.id}" has an empty segment; use reverse-DNS like "com.you.app"`);
    } else if (!raw.id.includes('.')) {
      warn(`"id" "${raw.id}" is not reverse-DNS; something like "com.you.${raw.id.toLowerCase()}" avoids collisions`);
    }
  }

  // ---- name / short_name
  if (raw.name === undefined) err('"name" is required');
  else if (!isStr(raw.name) || !raw.name.trim()) err('"name" must be a non-empty string');

  if (raw.short_name !== undefined) {
    if (!isStr(raw.short_name) || !raw.short_name.trim()) err('"short_name" must be a non-empty string');
    else if ([...raw.short_name].length > SHORT_NAME_MAX) {
      warn(`"short_name" "${raw.short_name}" is ${[...raw.short_name].length} characters; CarPlay truncates icon labels past ~${SHORT_NAME_MAX}`);
    }
  } else if (isStr(raw.name) && [...raw.name].length > SHORT_NAME_MAX) {
    warn(`"name" "${raw.name}" is used as the CarPlay icon label and is longer than ~${SHORT_NAME_MAX} characters; add a "short_name"`);
  }

  // ---- version
  if (raw.version !== undefined && !isStr(raw.version)) err('"version" must be a string, e.g. "1.0.0"');

  // ---- start_url
  let startPath = 'index.html';
  if (raw.start_url !== undefined) {
    if (!isStr(raw.start_url) || !raw.start_url.trim()) err('"start_url" must be a non-empty string');
    else if (/^[a-z][a-z0-9+.-]*:/i.test(raw.start_url) || raw.start_url.startsWith('//')) {
      err(`"start_url" "${raw.start_url}" must be a path relative to the app folder, not a URL`);
    } else {
      startPath = raw.start_url.split(/[?#]/)[0].replace(/^\.?\//, '') || 'index.html';
    }
  }
  if (!errors.some((e) => e.startsWith('"start_url"'))) {
    const p = safeJoin(dir, startPath);
    if (!p) err(`"start_url" "${raw.start_url}" points outside the app folder`);
    else if (!existsSync(p)) err(`start page ${startPath} does not exist${raw.start_url === undefined ? ' (start_url defaults to "index.html")' : ''}`);
    else if (statSync(p).isDirectory()) {
      if (!existsSync(join(p, 'index.html'))) err(`start_url "${raw.start_url}" is a folder without an index.html`);
    }
  }

  // ---- icon
  const iconPath = raw.icon === undefined ? 'icon.png' : raw.icon;
  if (!isStr(iconPath) || !iconPath.trim()) err('"icon" must be a path to a PNG');
  else {
    const p = safeJoin(dir, iconPath.replace(/^\.?\//, ''));
    if (!p) err(`"icon" "${iconPath}" points outside the app folder`);
    else if (!existsSync(p)) err(`icon ${iconPath} does not exist${raw.icon === undefined ? ' ("icon" defaults to "icon.png")' : ''}`);
    else {
      const info = readPNGInfo(readFileSync(p));
      if (!info) err(`icon ${iconPath} is not a PNG file`);
      else {
        if (info.width !== info.height) err(`icon ${iconPath} must be square, it is ${info.width}×${info.height}`);
        if (Math.min(info.width, info.height) < MIN_ICON) err(`icon ${iconPath} is ${info.width}×${info.height}; it must be at least ${MIN_ICON}×${MIN_ICON}`);
      }
    }
  }

  // ---- background_color
  if (raw.background_color !== undefined) {
    if (!isStr(raw.background_color)) err('"background_color" must be a string like "#000000"');
    else if (!HEX_COLOR_RE.test(raw.background_color.trim())) {
      warn(`"background_color" "${raw.background_color}" is not a hex color (#RGB, #RRGGBB or #RRGGBBAA); CarPWA may fall back to black`);
    }
  }

  // ---- spa
  if (raw.spa !== undefined && typeof raw.spa !== 'boolean') err('"spa" must be true or false');

  // ---- permissions
  let permissions = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) err('"permissions" must be an array of strings');
    else {
      const seen = new Set();
      for (const p of raw.permissions) {
        if (!isStr(p)) { err(`"permissions" contains a non-string value ${JSON.stringify(p)}`); continue; }
        if (!PERMISSIONS[p]) {
          const hint = closest(p, Object.keys(PERMISSIONS));
          err(`unknown permission "${p}"${hint ? ` (did you mean "${hint}"?)` : ''}. Known: ${Object.keys(PERMISSIONS).join(', ')}`);
          continue;
        }
        if (seen.has(p)) { warn(`permission "${p}" is listed twice`); continue; }
        seen.add(p);
        permissions.push(p);
      }
      if (seen.has('media.control') && !seen.has('media')) {
        warn('"media.control" without "media": the app can press play but cannot read what is playing');
      }
      if (seen.has('car.raw')) {
        warn('"car.raw" talks to the head unit directly and can put some cars in odd states; keep it only if you need it');
      }
    }
  }

  // ---- network
  let allow = [];
  if (raw.network !== undefined) {
    if (!raw.network || typeof raw.network !== 'object' || Array.isArray(raw.network)) err('"network" must be an object like { "allow": ["api.example.com"] }');
    else if (raw.network.allow !== undefined) {
      if (!Array.isArray(raw.network.allow)) err('"network.allow" must be an array of host names');
      else {
        for (const h of raw.network.allow) {
          if (!isStr(h)) { err(`"network.allow" contains a non-string value ${JSON.stringify(h)}`); continue; }
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h) || h.includes('/')) { err(`"network.allow" entry "${h}" must be a bare host like "api.example.com", without scheme or path`); continue; }
          if (h === '*' || h === '*.') { err('"network.allow" cannot allow every host; list the hosts you need'); continue; }
          if (!HOST_RE.test(h)) { err(`"network.allow" entry "${h}" is not a host name (use "example.com" or "*.example.com")`); continue; }
          allow.push(h.toLowerCase());
        }
      }
    }
  }
  if (allow.length && !permissions.includes('network')) {
    err('"network.allow" lists hosts but "permissions" lacks "network"');
  }
  if (permissions.includes('network') && !allow.length && !errors.some((e) => e.includes('network.allow'))) {
    warn('"network" permission without "network.allow" hosts: every net.fetch call will be refused');
  }

  // ---- min_carpwa
  if (raw.min_carpwa !== undefined) {
    if (!isStr(raw.min_carpwa) || !VERSION_RE.test(raw.min_carpwa)) err('"min_carpwa" must be a version string like "1.0"');
    else {
      let current = null;
      try { current = sdkVersion(); } catch { /* SDK missing: skip the comparison */ }
      if (current && compareVersions(raw.min_carpwa, current) > 0) {
        warn(`"min_carpwa" ${raw.min_carpwa} is newer than this SDK (${current}); older installs will hide the app`);
      }
    }
  }

  // ---- likely typos of known fields (unknown fields are otherwise ignored)
  const norm = (k) => k.toLowerCase().replace(/[-_\s]/g, '');
  for (const key of Object.keys(raw)) {
    if (FIELDS.includes(key)) continue;
    const match = FIELDS.find((f) => norm(f) === norm(key) || (norm(key).length > 3 && norm(f) === norm(key).replace(/s$/, '')));
    if (match && !(match in raw)) warn(`unknown field "${key}" is ignored; did you mean "${match}"?`);
  }

  if (!errors.length) {
    result.manifest = {
      id: raw.id,
      name: raw.name.trim(),
      short_name: (raw.short_name || raw.name).trim(),
      version: raw.version || '0.0.0',
      start_url: (raw.start_url || 'index.html').replace(/^\.?\//, ''),
      startPath,
      icon: iconPath.replace(/^\.?\//, ''),
      background_color: raw.background_color || '#000000',
      spa: raw.spa === true,
      permissions,
      network: { allow },
      min_carpwa: raw.min_carpwa || null,
    };
  }
  return result;
}

/** Validates, prints problems, and throws when the manifest has errors. */
export function loadApp(dir = '.', { quiet = false } = {}) {
  const result = validateApp(dir);
  // No readable manifest at all: that is the whole story, in one line.
  if (result.errors.length === 1 && !result.raw) throw new CliError(result.errors[0]);
  if (result.errors.length) {
    printReport(result);
    throw new CliError(`${MANIFEST} has ${plural(result.errors.length, 'error')}; fix ${result.errors.length === 1 ? 'it' : 'them'} and try again`);
  }
  if (!quiet) for (const w of result.warnings) printWarn(w);
  return result;
}

export function printReport(result, { verbose = false } = {}) {
  const where = relative(process.cwd(), join(result.dir, MANIFEST)) || MANIFEST;
  for (const e of result.errors) printError(`${c.dim(where + ':')} ${e}`);
  for (const w of result.warnings) printWarn(`${c.dim(where + ':')} ${w}`);
  if (!result.errors.length && result.manifest) {
    const m = result.manifest;
    const tail = result.warnings.length ? c.yellow(` (${plural(result.warnings.length, 'warning')})`) : '';
    ok(`${c.bold(m.name)} ${c.dim(m.id)} ${m.version} is valid${tail}`);
    if (verbose) {
      const row = (k, v) => console.log(`  ${c.dim(k.padEnd(12))} ${v}`);
      row('label', m.short_name);
      row('start', m.start_url + (m.spa ? c.dim('  (spa)') : ''));
      row('icon', m.icon);
      row('background', m.background_color);
      row('permissions', m.permissions.length ? m.permissions.join(', ') : c.dim('none'));
      if (m.network.allow.length) row('network', m.network.allow.join(', '));
      if (m.min_carpwa) row('min_carpwa', m.min_carpwa);
    }
  }
}

/** Joins a relative path onto root and refuses anything that escapes it. */
export function safeJoin(root, rel) {
  if (rel.includes('\0')) return null;
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return p;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** True when `host` is allowed by a network.allow list (exact host, or *.domain for subdomains). */
export function hostAllowed(host, allow) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  return allow.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return host.endsWith('.' + base) && host.length > base.length + 1;
    }
    return host === pattern;
  });
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeJSONError(e, text) {
  const m = /position (\d+)/.exec(e.message);
  if (!m) return e.message;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  return `${e.message.replace(/ in JSON at position \d+.*$/, '')} at line ${line}, column ${col}`;
}

function closest(word, options) {
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = editDistance(word.toLowerCase(), o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
