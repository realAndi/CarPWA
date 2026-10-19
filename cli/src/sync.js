// Incremental upload of an app folder to carpwad (protocol.md, "A sync is"):
// POST sync with every file's SHA-1 → PUT each path in `need` → POST commit
// with the paths to `remove`.

import { readFileSync } from 'node:fs';
import { listAppFiles, sha1File, formatBytes } from './files.js';
import { CliError, warn } from './log.js';

const BIG_APP = 50 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

export function appPath(id, ...rest) {
  return ['/_carpwa/dev/apps', encodeURIComponent(id), ...rest].join('/');
}

/** "img/a b.png" → "img/a%20b.png": each segment encoded, slashes kept. */
export function encodeRelPath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** The app's files (after ignore rules) and their SHA-1s, as sent in `sync`. */
export function hashTree(dir) {
  const files = listAppFiles(dir);
  const hashes = {};
  for (const f of files) hashes[f.rel] = sha1File(f.abs, f.mtime);
  return { files, hashes };
}

/**
 * What the phone should end up with, given what it has: the files to upload
 * and the files to delete. This is carpwad's side of `sync`; the CLI uses it
 * to check replies and the tests use it as the reference.
 * @param {Record<string,string>} local path → sha1
 * @param {Record<string,string>} remote path → sha1
 */
export function diffTrees(local, remote) {
  const need = Object.keys(local).filter((p) => remote[p] !== local[p]).sort();
  const remove = Object.keys(remote).filter((p) => !(p in local)).sort();
  return { need, remove };
}

/**
 * Checks a `sync` reply against the local tree: every `need` must be a local
 * file, and a `remove` never deletes a file we still have.
 */
export function planSync(hashes, reply) {
  const need = Array.isArray(reply && reply.need) ? reply.need : [];
  const remove = Array.isArray(reply && reply.remove) ? reply.remove : [];
  for (const rel of need) {
    if (typeof rel !== 'string' || !(rel in hashes)) throw new CliError(`carpwad asked for ${rel}, which is not part of the app`);
  }
  return { need: [...new Set(need)], remove: remove.filter((rel) => typeof rel === 'string' && !(rel in hashes)) };
}

/**
 * @param {import('./device.js').Device} device
 * @returns {Promise<{ total: number, uploaded: string[], bytes: number, removed: string[], entry: object }>}
 */
export async function syncApp(device, dir, manifest) {
  const { files, hashes } = hashTree(dir);
  const byPath = new Map(files.map((f) => [f.rel, f]));
  const size = files.reduce((n, f) => n + f.size, 0);
  if (size > BIG_APP) warn(`this app is ${formatBytes(size)}; large apps take a while to push over Wi-Fi`);

  const reply = await device.call('POST', appPath(manifest.id, 'sync'), { files: hashes });
  const { need, remove } = planSync(hashes, reply);

  let bytes = 0;
  const queue = [...need];
  const worker = async () => {
    while (queue.length) {
      const rel = queue.shift();
      const body = readFileSync(byPath.get(rel).abs);
      await device.call('PUT', appPath(manifest.id, 'files', encodeRelPath(rel)), body, { timeout: 300000 });
      bytes += body.length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));

  const entry = await device.call('POST', appPath(manifest.id, 'commit'), { remove });
  return { total: files.length, uploaded: need, bytes, removed: remove, entry: entry || {} };
}

/** POST reload; resolves with the number of pages that got `dev.reload`. */
export async function reloadApp(device, id) {
  const r = await device.call('POST', appPath(id, 'reload'));
  return r && typeof r.clients === 'number' ? r.clients : 0;
}
