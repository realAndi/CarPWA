// The set of files that make up an app on the phone: everything in the folder
// except dot-files, node_modules, build leftovers and `.carpwaignore` matches.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_IGNORES = ['node_modules/', '*.deb', 'Thumbs.db', 'npm-debug.log*'];

/**
 * Compiles gitignore-style patterns: `*`, `**`, `?`, trailing `/` for
 * folders, leading `/` to anchor at the app root, `!` to re-include.
 */
export function compileIgnore(lines) {
  const rules = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    let re = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '*' && line[i + 1] === '*') {
        re += line[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += line[i + 2] === '/' ? 2 : 1;
      } else if (ch === '*') re += '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    rules.push({ re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`), negate, dirOnly });
  }
  return (rel, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  };
}

export function loadIgnore(dir) {
  const file = join(dir, '.carpwaignore');
  const extra = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  return compileIgnore([...DEFAULT_IGNORES, ...extra]);
}

/**
 * @returns {Array<{ rel: string, abs: string, size: number, mtime: number }>} sorted by path
 */
export function listAppFiles(dir) {
  const ignored = loadIgnore(dir);
  const out = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = statSync(childAbs); } catch { continue; }   // dangling symlink
      if (st.isDirectory()) {
        if (!ignored(childRel, true)) walk(childAbs, childRel);
      } else if (st.isFile() && !ignored(childRel, false)) {
        out.push({ rel: childRel, abs: childAbs, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const hashCache = new Map();

export function sha1File(abs, mtime) {
  const cached = hashCache.get(abs);
  if (cached && cached.mtime === mtime) return cached.sha1;
  const sha1 = createHash('sha1').update(readFileSync(abs)).digest('hex');
  hashCache.set(abs, { mtime, sha1 });
  return sha1;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
