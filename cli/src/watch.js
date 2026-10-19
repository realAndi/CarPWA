// Watches an app folder for changes. Uses recursive fs.watch where the platform
// supports it (macOS, Windows, Linux on Node ≥ 20) and falls back to polling.

import { watch, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IGNORED = /(^|[/\\])(\.[^/\\]*|node_modules)([/\\]|$)/;

/**
 * @param {string} root
 * @param {(files: string[]) => void} onChange relative paths, debounced
 * @returns {() => void} stop
 */
export function watchFolder(root, onChange, { debounce = 80 } = {}) {
  let pending = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const files = [...pending];
    pending = new Set();
    if (files.length) onChange(files);
  };
  const touch = (rel) => {
    if (!rel || IGNORED.test(rel)) return;
    pending.add(rel.split(sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(flush, debounce);
  };

  try {
    const w = watch(root, { recursive: true }, (_event, name) => touch(name ? String(name) : ''));
    w.on('error', () => {});
    return () => { clearTimeout(timer); w.close(); };
  } catch {
    return pollFolder(root, touch);
  }
}

function pollFolder(root, touch) {
  let previous = snapshot(root);
  const timer = setInterval(() => {
    const next = snapshot(root);
    for (const [file, mtime] of next) if (previous.get(file) !== mtime) touch(file);
    for (const file of previous.keys()) if (!next.has(file)) touch(file);
    previous = next;
  }, 700);
  return () => clearInterval(timer);
}

function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { out.set(relative(root, p), statSync(p).mtimeMs); } catch { /* raced with a delete */ }
      }
    }
  };
  walk(root);
  return out;
}
