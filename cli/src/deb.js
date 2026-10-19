// Debian packages in pure Node: ustar/pax tar archives, gzip, and the `ar`
// container dpkg expects (debian-binary, control.tar.gz, data.tar.gz).

import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function writeString(buf, offset, length, value) {
  const b = Buffer.from(value, 'utf8');
  if (b.length > length) throw new Error(`tar: "${value}" does not fit in ${length} bytes`);
  b.copy(buf, offset);
}

function writeOctal(buf, offset, length, value) {
  const s = Math.floor(value).toString(8).padStart(length - 1, '0');
  if (s.length > length - 1) throw new Error(`tar: ${value} does not fit in ${length} bytes`);
  buf.write(s + '\0', offset, 'ascii');
}

function header({ name, prefix = '', mode, size, mtime, type }) {
  const h = Buffer.alloc(BLOCK, 0);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);          // uid
  writeOctal(h, 116, 8, 0);          // gid
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);            // checksum is computed with spaces here
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  writeString(h, 265, 32, 'root');
  writeString(h, 297, 32, 'wheel');
  writeOctal(h, 329, 8, 0);
  writeOctal(h, 337, 8, 0);
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function pad(size) {
  const rest = size % BLOCK;
  return rest ? Buffer.alloc(BLOCK - rest, 0) : Buffer.alloc(0);
}

// Splits a long path into ustar prefix/name, or returns null when it cannot.
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/**
 * @param {Array<{ path: string, data?: Buffer, mode?: number, dir?: boolean }>} entries
 *   paths like "./var/jb/Library/…"; directories end with "/"
 */
export function tar(entries, mtime = defaultMtime()) {
  const parts = [];
  for (const e of entries) {
    const data = e.dir ? Buffer.alloc(0) : e.data;
    const type = e.dir ? '5' : '0';
    const mode = e.mode ?? (e.dir ? 0o755 : 0o644);
    let split = splitPath(e.path);
    if (!split) {
      const record = Buffer.from(paxRecord('path', e.path), 'utf8');
      parts.push(header({ name: 'PaxHeader', mode: 0o644, size: record.length, mtime, type: 'x' }), record, pad(record.length));
      split = { name: e.path.slice(0, 99), prefix: '' };
    }
    parts.push(header({ ...split, mode, size: data.length, mtime, type }), data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** @param {Array<{ name: string, data: Buffer }>} members */
export function ar(members, mtime = defaultMtime()) {
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  for (const m of members) {
    const h = Buffer.alloc(60, 0x20);
    h.write(m.name, 0, 'ascii');
    h.write(String(mtime), 16, 'ascii');
    h.write('0', 28, 'ascii');
    h.write('0', 34, 'ascii');
    h.write('100644', 40, 'ascii');
    h.write(String(m.data.length), 48, 'ascii');
    h.write('`\n', 58, 'ascii');
    parts.push(h, m.data);
    if (m.data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

export function defaultMtime() {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : Math.floor(Date.now() / 1000);
}

/** Adds "./a/", "./a/b/" … for every parent of the given file paths. */
export function withParentDirs(files) {
  const dirs = new Set(['./']);
  for (const f of files) {
    const segs = f.path.replace(/^\.\//, '').split('/').slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(`./${segs.slice(0, i).join('/')}/`);
  }
  return [...[...dirs].sort().map((path) => ({ path, dir: true })), ...files];
}

/**
 * @param {{ control: string, scripts?: Record<string,string>, files: Array<{ path: string, data: Buffer, mode?: number }> }} pkg
 */
export function buildDeb({ control, scripts = {}, files }) {
  const mtime = defaultMtime();
  const controlEntries = [
    { path: './', dir: true },
    { path: './control', data: Buffer.from(control.endsWith('\n') ? control : control + '\n') },
    ...Object.entries(scripts).map(([name, body]) => ({ path: `./${name}`, data: Buffer.from(body), mode: 0o755 })),
  ];
  const controlTar = gzipSync(tar(controlEntries, mtime), { level: 9 });
  const dataTar = gzipSync(tar(withParentDirs(files), mtime), { level: 9 });
  return ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: controlTar },
    { name: 'data.tar.gz', data: dataTar },
  ], mtime);
}
