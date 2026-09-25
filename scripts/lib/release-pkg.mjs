// Deterministic, dependency-free release packaging for the session-cost skills.
//
// Reproducibility rules:
//   * entries are sorted by archive path, so file-system order never leaks in
//   * every entry uses STORE (no compression), so no zlib version can change bytes
//   * every entry carries a fixed DOS timestamp, so the build clock never leaks in
// Together these make two builds of the same commit byte-identical on any OS.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 1980-01-01 00:00:00 is the earliest timestamp the DOS format can represent.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION_MADE_BY = 0x031e; // UNIX, ZIP 3.0
const VERSION_NEEDED = 20;
const METHOD_STORE = 0;
const MODE_FILE = 0o100644;
const MODE_EXECUTABLE = 0o100755;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// Path patterns that must never reach a customer archive, matched case-insensitively
// against the POSIX-style archive path.
export const FORBIDDEN_PACKAGE_PATTERNS = Object.freeze([
  { rule: 'credential-file', pattern: /(^|\/)(?:secrets?\.json|providers\.json|\.env(?:\..*)?)$/i },
  { rule: 'session-database', pattern: /\.(?:db|sqlite|sqlite3|sqlite-shm|sqlite-wal)$/i },
  { rule: 'transcript', pattern: /(^|\/)messages?\.jsonl$|(^|\/)(?:transcript|conversation|prompt)s?\.(?:jsonl|txt|log)$/i },
  { rule: 'generated-report', pattern: /(^|\/)reports?\//i },
  { rule: 'generated-dashboard', pattern: /dashboard.*\.html$/i },
  { rule: 'runtime-state', pattern: /(^|\/)(?:v2\/sqlite|node_modules|dist)\// },
  { rule: 'local-config', pattern: /(^|\/)\.session-cost\// },
]);

export function forbiddenPackageReason(archivePath) {
  return FORBIDDEN_PACKAGE_PATTERNS.find((rule) => rule.pattern.test(archivePath))?.rule ?? null;
}

export function isExecutable(archivePath) {
  return archivePath.endsWith('.mjs') || archivePath.endsWith('.sh');
}

function dosDateTime(date) {
  if (!date) return { time: DOS_TIME, date: DOS_DATE };
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: DOS_TIME, date: DOS_DATE };
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * Build a deterministic ZIP archive from an explicit entry list.
 * @param {{path: string, data: Buffer}[]} entries
 * @param {{modified?: Date}} [options]
 */
export function buildDeterministicZip(entries, options = {}) {
  const { time, date } = dosDateTime(options.modified);
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const seen = new Set();
  for (const entry of sorted) {
    if (seen.has(entry.path)) throw new Error(`duplicate archive entry: ${entry.path}`);
    seen.add(entry.path);
    if (path.posix.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
      throw new Error(`unsafe archive entry path: ${entry.path}`);
    }
    const reason = forbiddenPackageReason(entry.path);
    if (reason) throw new Error(`refusing to package ${entry.path}: matched ${reason}`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const mode = isExecutable(entry.path) ? MODE_EXECUTABLE : MODE_FILE;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

export function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

/**
 * Read a ZIP produced by buildDeterministicZip. Only STORE entries are supported,
 * which is all the builder ever emits. Returns entries sorted by path.
 */
export function readDeterministicZip(buffer) {
  const endIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endIndex < 0) throw new Error('not a ZIP archive: end-of-central-directory record is missing');
  const count = buffer.readUInt16LE(endIndex + 10);
  let cursor = buffer.readUInt32LE(endIndex + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    if (buffer.readUInt16LE(cursor + 10) !== METHOD_STORE) throw new Error('unsupported ZIP compression method');
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt ZIP local header for ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (crc32(data) !== buffer.readUInt32LE(localOffset + 14)) throw new Error(`ZIP entry failed its CRC check: ${name}`);
    entries.push({ path: name, data: Buffer.from(data) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : 1));
}

export function collectFiles(directory, { exclude = () => false } = {}) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile() && !exclude(relative)) files.push(relative);
    }
  };
  walk(directory, '');
  return files;
}
