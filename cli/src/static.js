// Serves an app folder the way carpwad does: files as-is, `spa` fallback to the
// start page, and nothing outside the folder.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, sep, basename } from 'node:path';
import { mimeType } from './mime.js';

/**
 * Resolves a URL pathname to a file inside root, or null. Rejects encoded
 * traversal, NUL bytes and dot-files (.git, .env, .carpwa …).
 */
export function resolveAppPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null;
  const file = join(root, ...parts);
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

function fileFor(root, pathname) {
  const file = resolveAppPath(root, pathname);
  if (!file || !existsSync(file)) return null;
  let st = statSync(file);
  if (st.isDirectory()) {
    const index = join(file, 'index.html');
    if (!existsSync(index)) return null;
    return { file: index, st: statSync(index), dirRedirect: !pathname.endsWith('/') };
  }
  return st.isFile() ? { file, st } : null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root absolute app folder
 * @param {{ spa: boolean, startPath: string }} manifest
 * @param {{ headers?: Record<string,string>, notFound?: (res) => void }} [options]
 */
export function serveStatic(req, res, root, manifest, options = {}) {
  const url = new URL(req.url, 'http://x');
  let pathname = url.pathname;
  let found = fileFor(root, pathname);

  if (found && found.dirRedirect) {
    res.writeHead(301, { Location: pathname + '/' + url.search, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (!found && pathname === '/') found = fileFor(root, '/' + manifest.startPath);
  if (!found && manifest.spa && wantsDocument(req, pathname)) found = fileFor(root, '/' + manifest.startPath);
  if (!found) {
    if (options.notFound) return options.notFound(res, pathname);
    return sendText(res, 404, `Not found: ${pathname}`);
  }

  const { file, st } = found;
  const headers = {
    'Content-Type': mimeType(file),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    ...(options.headers || {}),
  };

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && st.size > 0) {
    if (range[1] === '') {
      start = Math.max(0, st.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;

  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) { res.end(); return; }
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

// SPA fallback is for navigations and extension-less paths, never for a
// missing script or image (which should 404 loudly).
function wantsDocument(req, pathname) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') || !basename(pathname).includes('.');
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

export function sendJSON(res, status, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendBuffer(res, buf, type, headers = {}) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
