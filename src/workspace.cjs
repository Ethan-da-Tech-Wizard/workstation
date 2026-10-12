'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { encodeInviteCode } = require('./invite-code.cjs');
const { AppError, cleanName, MAX_FILE_SIZE, DISK_RESERVE, prepareSource, progressReporter } = require('./file-transfer.cjs');

const MiB = 1024 * 1024;
const CHUNK_SIZE = 8 * MiB;
const SESSION_MS = 24 * 60 * 60 * 1000;
const INVITE_MS = 30 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

class Workspace extends EventEmitter {
  constructor(root, options = {}) {
    super();
    this.root = path.resolve(root);
    this.filesDir = path.join(this.root, 'files');
    this.incomingDir = path.join(this.root, '.incoming');
    this.trashDir = path.join(this.root, '.trash');
    for (const dir of [this.root, this.filesDir, this.incomingDir, this.trashDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.indexPath = path.join(this.root, 'workspace.json');
    this.data = fs.existsSync(this.indexPath) ? JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) : {
      version: 1, settings: { name: 'Workstation', hostName: 'Host' }, files: [], messages: [], activity: []
    };
    if (this.data.version !== 1 || !Array.isArray(this.data.files) || !Array.isArray(this.data.messages) || !Array.isArray(this.data.activity)) {
      throw new Error('The workspace index is unreadable. Your files have been left in place.');
    }
    // Only partial, unpublished transfers are discarded after an interrupted app session.
    for (const file of fs.readdirSync(this.incomingDir)) {
      if (/^[0-9a-f-]{36}\.part$/.test(file)) fs.rmSync(path.join(this.incomingDir, file), { force: true });
    }
    this.sessions = new Map();
    this.invites = new Map();
    this.uploads = new Map();
    this.transfers = new Map();
    this.sharing = { status: 'offline', url: '', error: '' };
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
    this.storageLimit = options.storageLimit ?? null;
    this.allowLocalCodes = Boolean(options.allowLocalCodes);
    this.revision = 0;
    this.save();
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  save() {
    const temporary = this.indexPath + '.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.indexPath);
  }

  changed() { this.revision++; this.emit('change'); }

  activity(text) {
    this.data.activity.push({ id: crypto.randomUUID(), text, at: Date.now() });
    this.data.activity = this.data.activity.slice(-100);
  }

  publicFile(file) {
    const { diskName, ...safe } = file;
    return safe;
  }

  snapshot(session = null) {
    const now = Date.now();
    const participants = [...this.sessions.values()].filter(s => !s.revoked && s.expiresAt > now).map(s => ({
      id: s.id, name: s.name, joinedAt: s.joinedAt, online: now - s.lastSeen < 15_000
    }));
    const state = {
      role: session ? 'guest' : 'host',
      self: session ? { id: session.id, name: session.name } : { id: 'host', name: this.data.settings.hostName },
      name: this.data.settings.name, hostName: this.data.settings.hostName,
      files: this.data.files.map(f => this.publicFile(f)), messages: this.data.messages.slice(-300),
      activity: this.data.activity.slice(-12).reverse(), participants,
      usedBytes: this.data.files.reduce((sum, f) => sum + f.size, 0),
      maxFileSize: this.maxFileSize, chunkSize: CHUNK_SIZE, revision: this.revision
    };
    if (!session) Object.assign(state, {
      sharing: { ...this.sharing }, storagePath: this.filesDir,
      storageLimit: this.storageLimit ?? state.usedBytes + this.availableSpace(), storageAvailable: this.availableSpace(),
      invites: [...this.invites.values()].map(i => ({
        id: i.id, code: i.code, expiresAt: i.expiresAt, usedBy: i.usedBy,
        status: i.usedBy ? 'used' : i.revoked ? 'revoked' : i.expiresAt <= now ? 'expired' : 'pending'
      })).slice(-12).reverse()
    });
    return state;
  }

  setSharing(status, url = '', error = '') {
    this.sharing = { status, url, error };
    this.changed();
  }

  createInvite() {
    this.sweep();
    if (this.sharing.status !== 'online' || !this.sharing.url) throw new AppError(409, 'Turn on sharing before creating an invitation.');
    if ([...this.invites.values()].filter(i => !i.usedBy && !i.revoked && i.expiresAt > Date.now()).length >= 10) {
      throw new AppError(409, 'You already have 10 unused invitations. Cancel one first.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const invite = {
      id: crypto.randomUUID(), code: encodeInviteCode(this.sharing.url, token, { allowLocal: this.allowLocalCodes }),
      expiresAt: Date.now() + INVITE_MS, usedBy: null, revoked: false
    };
    this.invites.set(digest(token), invite);
    if (this.invites.size > 100) {
      for (const [key, item] of this.invites) if (item.usedBy || item.revoked || item.expiresAt < Date.now()) this.invites.delete(key);
    }
    this.changed();
    return { id: invite.id, code: invite.code, expiresAt: invite.expiresAt };
  }

  cancelInvite(id) {
    const invite = [...this.invites.values()].find(i => i.id === id);
    if (invite) { invite.revoked = true; this.changed(); }
  }

  join(token, name) {
    if (this.sharing.status !== 'online') throw new AppError(503, 'The host has turned sharing off.');
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new AppError(410, 'This invitation is invalid, expired, or already used. Ask the host for a new code.');
    const invite = this.invites.get(digest(token));
    if (!invite || invite.usedBy || invite.revoked || invite.expiresAt <= Date.now()) {
      throw new AppError(410, 'This invitation is invalid, expired, or already used. Ask the host for a new code.');
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new AppError(400, 'Enter a name between 1 and 60 characters.');
    }
    if ([...this.sessions.values()].filter(s => !s.revoked && s.expiresAt > Date.now()).length >= 20) throw new AppError(409, 'This workspace is full. Ask the host to remove a guest.');
    const secret = crypto.randomBytes(32).toString('base64url');
    const session = {
      id: crypto.randomUUID(), name: name.trim(), joinedAt: Date.now(), lastSeen: Date.now(),
      expiresAt: Date.now() + SESSION_MS, revoked: false
    };
    // No await between consuming the invite and issuing the session: concurrent claims have one winner.
    invite.usedBy = session.name;
    this.sessions.set(digest(secret), session);
    this.activity(`${session.name} joined the workspace`);
    this.save(); this.changed();
    return { secret, session };
  }

  authenticate(secret) {
    if (typeof secret !== 'string' || secret.length !== 43) throw new AppError(401, 'Your access has ended. Ask the host for a new invitation.');
    const session = this.sessions.get(digest(secret));
    this.assertSession(session);
    session.lastSeen = Date.now();
    return session;
  }

  assertSession(session) {
    if (!session || session.revoked || session.expiresAt <= Date.now() || this.sharing.status !== 'online') {
      throw new AppError(401, 'Your access has ended. Ask the host for a new invitation.');
    }
  }

  trackTransfer(sessionId, stop) {
    if (!this.transfers.has(sessionId)) this.transfers.set(sessionId, new Set());
    this.transfers.get(sessionId).add(stop);
    return () => {
      const set = this.transfers.get(sessionId);
      if (set) { set.delete(stop); if (!set.size) this.transfers.delete(sessionId); }
    };
  }

  revoke(id, reason = 'removed') {
    const session = [...this.sessions.values()].find(s => s.id === id);
    if (!session || session.revoked) return;
    session.revoked = true;
    for (const stop of this.transfers.get(id) || []) stop();
    this.transfers.delete(id);
    for (const upload of [...this.uploads.values()]) if (upload.ownerId === id) this.cancelUpload(upload.id);
    this.activity(`${session.name} ${reason === 'left' ? 'left' : 'was removed from'} the workspace`);
    this.save(); this.changed();
  }

  stopSharing() {
    for (const session of this.sessions.values()) if (!session.revoked) this.revoke(session.id);
    for (const invite of this.invites.values()) invite.revoked = true;
    this.setSharing('offline');
  }

  chat(author, value) {
    if (author) this.assertSession(author);
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 4000) throw new AppError(400, 'Messages must contain 1–4,000 characters.');
    const message = {
      id: crypto.randomUUID(), authorId: author ? author.id : 'host',
      author: author ? author.name : this.data.settings.hostName, text: value.trim(), at: Date.now()
    };
    this.data.messages.push(message);
    this.data.messages = this.data.messages.slice(-5000);
    this.save(); this.changed();
    return message;
  }

  updateSettings({ name, hostName }) {
    for (const value of [name, hostName]) if (typeof value !== 'string' || !value.trim() || value.length > 60) throw new AppError(400, 'Names must contain 1–60 characters.');
    this.data.settings = { name: name.trim(), hostName: hostName.trim() };
    this.save(); this.changed();
  }

  reserveSpace(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxFileSize) throw new AppError(413, `Files can be up to ${this.maxFileSize / (1024 ** 3)} GB.`);
    const used = this.data.files.reduce((sum, f) => sum + f.size, 0);
    const reserved = [...this.uploads.values()].reduce((sum, u) => sum + u.size, 0);
    if (this.storageLimit !== null && used + reserved + size > this.storageLimit) throw new AppError(413, 'The workspace storage limit has been reached. Ask the host to make room.');
    const available = this.availableSpace();
    if (size > available) throw new AppError(507, `Not enough free disk space on the host. This transfer needs ${(size / 1024 ** 3).toFixed(1)} GB; ${(available / 1024 ** 3).toFixed(1)} GB is available. Free some space and try again.`);
  }

  availableSpace() {
    const stats = fs.statfsSync(this.root);
    // Already-written bytes are reflected in statfs; reserve only what remains.
    const remaining = [...this.uploads.values()].reduce((sum, upload) => sum + upload.size - upload.offset, 0);
    return Math.max(0, stats.bavail * stats.bsize - remaining - DISK_RESERVE);
  }

  beginUpload(author, name, size) {
    if (author) this.assertSession(author);
    const ownerId = author ? author.id : 'host';
    if ([...this.uploads.values()].filter(u => u.ownerId === ownerId).length >= 3) throw new AppError(429, 'Finish your current uploads before adding more.');
    if (this.data.files.length >= 10_000) throw new AppError(413, 'The workspace has reached its file limit.');
    this.reserveSpace(size);
    const upload = {
      id: crypto.randomUUID(), ownerId, author: author ? author.name : this.data.settings.hostName,
      name: cleanName(name), size, offset: 0, lastSeen: Date.now(), busy: false, hash: crypto.createHash('sha256')
    };
    upload.path = path.join(this.incomingDir, upload.id + '.part');
    fs.closeSync(fs.openSync(upload.path, 'wx', 0o600));
    this.uploads.set(upload.id, upload);
    return { id: upload.id, chunkSize: CHUNK_SIZE };
  }

  getUpload(author, id) {
    if (author) this.assertSession(author);
    const upload = this.uploads.get(id);
    if (!upload || upload.ownerId !== (author ? author.id : 'host')) throw new AppError(404, 'This upload is no longer available. Please add the file again.');
    return upload;
  }

  appendChunk(author, id, offset, buffer) {
    const upload = this.getUpload(author, id);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > CHUNK_SIZE) throw new AppError(413, 'Invalid upload chunk size.');
    if (upload.lastChunk && offset === upload.lastChunk.offset && buffer.length === upload.lastChunk.size && digest(buffer) === upload.lastChunk.hash) return { offset: upload.offset };
    if (!Number.isSafeInteger(offset) || offset !== upload.offset) throw new AppError(409, 'Upload offset changed. Please add the file again.');
    if (upload.offset + buffer.length > upload.size) throw new AppError(413, 'Invalid upload chunk size.');
    fs.appendFileSync(upload.path, buffer);
    upload.hash.update(buffer);
    upload.offset += buffer.length;
    upload.lastSeen = Date.now();
    upload.lastChunk = { offset, size: buffer.length, hash: digest(buffer) };
    return { offset: upload.offset };
  }

  finishUpload(author, id) {
    const upload = this.getUpload(author, id);
    if (upload.busy || upload.offset !== upload.size) throw new AppError(409, 'The file is still uploading.');
    let diskName = upload.name;
    const extension = path.extname(diskName);
    const base = diskName.slice(0, diskName.length - extension.length);
    for (let n = 2; fs.existsSync(path.join(this.filesDir, diskName)); n++) diskName = `${base} (${n})${extension}`;
    const destination = path.join(this.filesDir, diskName);
    const fd = fs.openSync(upload.path, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Hard-link with exclusive creation; never overwrite another user's file.
    fs.linkSync(upload.path, destination);
    const file = {
      id: crypto.randomUUID(), name: diskName, diskName, size: upload.size, addedAt: Date.now(),
      addedBy: upload.author, authorId: upload.ownerId, sha256: upload.hash.digest('hex')
    };
    this.data.files.push(file);
    this.activity(`${upload.author} added ${diskName}`);
    try { this.save(); }
    catch (error) { this.data.files.pop(); fs.rmSync(destination, { force: true }); throw error; }
    fs.rmSync(upload.path, { force: true });
    this.uploads.delete(id);
    this.changed();
    return this.publicFile(file);
  }

  cancelUpload(id) {
    const upload = this.uploads.get(id);
    if (upload) {
      this.uploads.delete(id);
      fs.rmSync(upload.path, { force: true });
    }
  }

  async importFile(source, { signal, onProgress } = {}) {
    const prepared = await prepareSource(source, { signal, onProgress, maxSize: this.maxFileSize, exclude: [this.root] });
    let id;
    try {
      signal?.throwIfAborted();
      ({ id } = this.beginUpload(null, prepared.name, prepared.size));
      const upload = this.uploads.get(id);
      upload.busy = true;
      const report = progressReporter(onProgress, { name: prepared.name, total: prepared.size, phase: 'copying', skipped: prepared.skipped });
      report({ bytes: 0 }, true);
      await pipeline(prepared.open(), new Transform({ transform(chunk, encoding, callback) {
        upload.offset += chunk.length;
        if (upload.offset > upload.size) return callback(new AppError(409, 'The source file changed while it was being copied.'));
        upload.lastSeen = Date.now(); upload.hash.update(chunk); report({ bytes: upload.offset }); callback(null, chunk);
      } }), fs.createWriteStream(upload.path, { flags: 'w', mode: 0o600 }), { signal });
      report({ bytes: upload.offset, phase: 'finishing' }, true);
      const handle = await fs.promises.open(upload.path, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      signal?.throwIfAborted();
      upload.busy = false;
      const file = this.finishUpload(null, id);
      report({ bytes: upload.offset, phase: 'complete' }, true);
      return { ...file, skipped: prepared.skipped };
    } catch (error) { if (id) this.cancelUpload(id); throw error; }
    finally { prepared.close(); }
  }

  resolveFile(id) {
    const file = this.data.files.find(f => f.id === id);
    if (!file || typeof file.diskName !== 'string' || path.basename(file.diskName) !== file.diskName || /[\\/]/.test(file.diskName)) throw new AppError(404, 'File not found.');
    const location = path.join(this.filesDir, file.diskName);
    let stat;
    try { stat = fs.lstatSync(location); } catch { throw new AppError(404, 'This file is no longer in the workspace folder.'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError(404, 'File not found.');
    return { file, location, size: stat.size };
  }

  removeFile(id) {
    const { file, location } = this.resolveFile(id);
    const destination = path.join(this.trashDir, `${file.id}--${file.diskName}`);
    fs.renameSync(location, destination);
    const index = this.data.files.indexOf(file);
    this.data.files.splice(index, 1);
    this.activity(`${this.data.settings.hostName} removed ${file.name}`);
    try { this.save(); }
    catch (error) { this.data.files.splice(index, 0, file); fs.renameSync(destination, location); throw error; }
    this.changed();
  }

  sweep() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now && !session.revoked) this.revoke(session.id);
      if (session.revoked) this.sessions.delete(key);
    }
    for (const upload of [...this.uploads.values()]) if (!upload.busy && now - upload.lastSeen > 10 * 60_000) this.cancelUpload(upload.id);
  }

  close() {
    clearInterval(this.sweeper);
    this.stopSharing();
    for (const upload of [...this.uploads.values()]) this.cancelUpload(upload.id);
    this.save();
  }
}

module.exports = { Workspace, AppError, cleanName, CHUNK_SIZE, MAX_FILE_SIZE };
