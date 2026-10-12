'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');

const MiB = 1024 ** 2;
const MAX_FILE_SIZE = 1024 ** 4;
const DISK_RESERVE = 256 * MiB;

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanName(value) {
  let name = String(value || 'Untitled').split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (!name) name = 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  while (Buffer.byteLength(name) > 180) name = Array.from(name).slice(0, -1).join('');
  return name;
}

function progressReporter(onProgress = () => {}, initial = {}) {
  let started = Date.now(), baseline = 0, phase;
  let last = 0;
  return (value, force = false) => {
    const now = Date.now();
    if (!force && now - last < 150) return;
    last = now;
    const state = { ...initial, ...value };
    if (phase !== state.phase) { phase = state.phase; started = now; baseline = state.bytes || 0; }
    const rate = Math.max(0, (state.bytes || 0) - baseline) / Math.max(1, (now - started) / 1000);
    onProgress({ ...state, percent: state.total === undefined ? null : state.total ? Math.min(100, Math.floor((state.bytes || 0) / state.total * 100)) : 100,
      bytesPerSecond: rate, secondsRemaining: state.total && rate ? Math.max(0, (state.total - (state.bytes || 0)) / rate) : null });
  };
}

async function checkDiskSpace(directory, bytes) {
  const stats = await fs.promises.statfs(directory);
  const available = stats.bavail * stats.bsize;
  if (available - bytes < DISK_RESERVE) throw new AppError(507,
    `Not enough free disk space. This transfer needs ${(bytes / 1024 ** 3).toFixed(1)} GB; ${(available / 1024 ** 3).toFixed(1)} GB is available. Free some space or choose another drive.`);
}

// Collect only metadata. File contents are opened one at a time when the ZIP is read.
// Stored ZIP entries avoid a second temporary archive and expensive recompression.
async function prepareSource(source, { signal, onProgress, maxSize = MAX_FILE_SIZE, exclude = [] } = {}) {
  signal?.throwIfAborted();
  source = path.resolve(source);
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new AppError(400, 'Choose the original file or folder instead of a symbolic link.');
  const report = progressReporter(onProgress, { name: path.basename(source), phase: 'scanning' });
  if (stat.isFile()) {
    if (stat.size > maxSize) throw new AppError(413, 'This file exceeds the workspace’s file size limit.');
    return { name: path.basename(source), size: stat.size, skipped: 0,
      open: () => fs.createReadStream(source, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, highWaterMark: MiB, signal }), close() {} };
  }
  if (!stat.isDirectory()) throw new AppError(400, 'Choose a regular file or folder.');
  const excluded = await Promise.all(exclude.map(p => fs.promises.realpath(p).catch(() => path.resolve(p))));
  const realSource = await fs.promises.realpath(source);
  if (excluded.some(p => realSource === p || realSource.startsWith(p + path.sep))) throw new AppError(400, 'Choose a folder outside the workspace’s storage folder.');
  source = realSource;
  const entries = [];
  let bytes = 0, skipped = 0;
  const rootName = cleanName(path.basename(source));
  const pending = [{ source, name: rootName, stat }];
  report({ files: 0, bytes: 0 }, true);
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    entries.push({ ...directory, directory: true });
    const names = new Set();
    const handle = await fs.promises.opendir(directory.source);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      const location = path.join(directory.source, entry.name);
      if (excluded.some(p => location === p || location.startsWith(p + path.sep)) || entry.isSymbolicLink()) { skipped++; continue; }
      if (!entry.isFile() && !entry.isDirectory()) { skipped++; continue; }
      const info = await fs.promises.lstat(location);
      if (!info.isFile() && !info.isDirectory()) { skipped++; continue; }
      let name = cleanName(entry.name);
      const extension = path.extname(name), base = name.slice(0, name.length - extension.length);
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} (${n})${extension}`;
      names.add(name.toLowerCase());
      const item = { source: location, name: directory.name + '/' + name, stat: info };
      if (info.isDirectory()) pending.push(item);
      else { entries.push(item); bytes += info.size; }
      if (bytes > maxSize) throw new AppError(413, 'This folder exceeds the workspace’s file size limit.');
      if (entries.length + pending.length > 100_000) throw new AppError(413, 'This folder contains more than 100,000 items. Add its subfolders separately.');
      report({ files: entries.length, bytes, skipped });
    }
  }
  signal?.throwIfAborted();
  const zip = new ZipFile();
  let current, closed = false, opened = false;
  const stop = () => { closed = true; current?.destroy(); zip.outputStream.destroy(); };
  signal?.addEventListener('abort', stop, { once: true });
  zip.on('error', error => zip.outputStream.destroy(error));
  // The stream can fail during preparation, before a consumer attaches.
  zip.outputStream.on('error', () => {});
  try {
    for (const entry of entries) {
      if (entry.directory) zip.addEmptyDirectory(entry.name, { mtime: entry.stat.mtime });
      else zip.addReadStreamLazy(entry.name, { size: entry.stat.size, mtime: entry.stat.mtime, mode: entry.stat.mode, compress: false }, callback => {
        if (closed || signal?.aborted) return callback(new AppError(499, 'Transfer canceled.'));
        current = fs.createReadStream(entry.source, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, highWaterMark: MiB, signal });
        current.on('error', error => zip.outputStream.destroy(error));
        callback(null, current);
      });
    }
    // Force ZIP64 also makes calculated lengths exact across the 4 GB / 65,535 entry boundaries.
    const size = await new Promise(resolve => zip.end({ forceZip64Format: true }, resolve));
    if (!Number.isSafeInteger(size) || size < 0 || size > maxSize) throw new AppError(413, 'The folder archive exceeds the workspace’s file size limit.');
    signal?.throwIfAborted();
    return { name: rootName + '.zip', size, skipped, entries: entries.length,
      open() { if (opened) throw new Error('This folder stream has already been opened.'); opened = true; return zip.outputStream; },
      close() { signal?.removeEventListener('abort', stop); stop(); } };
  } catch (error) { signal?.removeEventListener('abort', stop); stop(); throw error; }
}

async function copyVerified(source, destination, file, { signal, onProgress } = {}) {
  if (path.resolve(source) === path.resolve(destination)) throw new AppError(400, 'Choose a different location for your copy.');
  await checkDiskSpace(path.dirname(destination), file.size);
  const temporary = path.join(path.dirname(destination), '.workstation-' + crypto.randomUUID() + '.part');
  const report = progressReporter(onProgress, { name: file.name, phase: 'copying', total: file.size });
  let size = 0;
  const hash = crypto.createHash('sha256');
  report({ bytes: 0 }, true);
  try {
    await pipeline(fs.createReadStream(source, { highWaterMark: MiB }), new Transform({ transform(chunk, _, callback) {
      size += chunk.length;
      if (size > file.size) return callback(new AppError(409, 'The shared file changed while copying.'));
      hash.update(chunk); report({ bytes: size }); callback(null, chunk);
    } }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== file.size || (file.sha256 && hash.digest('hex') !== file.sha256)) throw new AppError(502, 'The copy did not pass its integrity check. Your existing copy was kept.');
    report({ bytes: size, phase: 'finishing' }, true);
    const handle = await fs.promises.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, destination);
    report({ bytes: size, phase: 'complete' }, true);
    return true;
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

module.exports = { AppError, cleanName, prepareSource, progressReporter, copyVerified, checkDiskSpace, MAX_FILE_SIZE, MiB, DISK_RESERVE };
