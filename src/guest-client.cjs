'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { decodeInviteCode, validOrigin } = require('./invite-code.cjs');
const { cleanName, MAX_FILE_SIZE, CHUNK_SIZE, AppError } = require('./workspace.cjs');
const { prepareSource, progressReporter, checkDiskSpace } = require('./file-transfer.cjs');

class GuestClient extends EventEmitter {
  constructor({ allowLocal = false, retryDelayMs = 1000, transferIdleMs = 90_000 } = {}) {
    super();
    this.allowLocal = allowLocal;
    this.session = null;
    this.lastState = null;
    this.lastNotice = '';
    this.joining = false;
    this.controller = new AbortController();
    this.retryDelayMs = retryDelayMs;
    this.transferIdleMs = transferIdleMs;
  }

  restore(credentials) {
    if (!credentials || !validOrigin(credentials.origin, this.allowLocal) || !/^[A-Za-z0-9_-]{43}$/.test(credentials.secret)) return false;
    this.session = { origin: credentials.origin, secret: credentials.secret };
    this.controller = new AbortController();
    return true;
  }

  clear(reason = '') {
    this.controller.abort();
    this.controller = new AbortController();
    this.session = null; this.lastState = null; this.lastNotice = reason;
    this.emit('credentials', null);
    this.emit('change');
  }

  async fetch(route, { method = 'GET', input, raw = false, session = this.session, timeout = 120_000, signal, headers = {} } = {}) {
    if (!session) throw new AppError(401, 'Enter an invitation code to join a workstation.');
    let response;
    try {
      response = await fetch(session.origin + route, {
        method, redirect: 'error',
        headers: { 'X-Workstation-Protocol': '1', ...(session.secret ? { Authorization: 'Bearer ' + session.secret } : {}), ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...headers },
        body: input === undefined ? undefined : raw ? input : JSON.stringify(input),
        signal: AbortSignal.any([this.controller.signal, ...(timeout ? [AbortSignal.timeout(timeout)] : []), ...(signal ? [signal] : [])])
      });
    } catch {
      signal?.throwIfAborted();
      if (this.session !== session && session.secret) throw new AppError(401, 'Your visit has ended. Enter a new code to join again.');
      throw new AppError(503, 'Could not reach the host. Check your connection and make sure their Workstation app is open.');
    }
    if (!response.ok) {
      const error = await this.readJSON(response).catch(() => ({}));
      if (response.status === 401 && this.session === session) this.clear('revoked');
      throw new AppError(response.status, error.error || 'The host could not complete that action. Try again.');
    }
    if (session.secret && this.session !== session) { await response.body?.cancel(); throw new AppError(401, 'Your visit has ended.'); }
    return response;
  }

  async readJSON(response) {
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new AppError(502, 'The host sent more information than this app can read.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError(502, 'The host sent an unreadable response. Please try again.'); }
  }

  async request(route, options) { return this.readJSON(await this.fetch(route, options)); }

  validateState(state) {
    if (!state || state.role !== 'guest' || !Array.isArray(state.files) || state.files.length > 10_000 || !Array.isArray(state.messages) || state.messages.length > 300 || !state.self?.id) throw new AppError(502, 'The host is running an incompatible version of Workstation.');
    return state;
  }

  async join(code, name) {
    if (this.joining || this.session) throw new AppError(409, 'Leave your current workstation before joining another one.');
    const { origin, token } = decodeInviteCode(code, { allowLocal: this.allowLocal });
    if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new AppError(400, 'Enter your name to join.');
    this.joining = true;
    try {
      const reply = await this.request('/api/join', { method: 'POST', input: { token, name: name.trim() }, session: { origin }, timeout: 25_000 });
      if (!/^[A-Za-z0-9_-]{43}$/.test(reply.session)) throw new AppError(502, 'The host could not create your session. Ask for a new code.');
      this.lastState = this.validateState(reply.state);
      this.session = { origin, secret: reply.session };
      this.lastNotice = '';
      this.emit('credentials', { ...this.session });
      this.emit('change');
      return this.lastState;
    } finally { this.joining = false; }
  }

  async state() {
    const session = this.session;
    const state = this.validateState(await this.request('/api/state', { timeout: 10_000 }));
    if (this.session !== session) throw new AppError(401, 'Your visit has ended.');
    this.lastState = state;
    return state;
  }

  async message(text) { return this.request('/api/messages', { method: 'POST', input: { text } }); }

  async leave() {
    try { if (this.session) await this.request('/api/leave', { method: 'POST', input: {}, timeout: 5000 }); }
    finally { this.clear('left'); }
  }

  async uploadFile(source, { signal, onProgress } = {}) {
    const session = this.session;
    if (!session) throw new AppError(401, 'Join a workstation first.');
    signal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    onProgress ||= value => this.emit('progress', value);
    const prepared = await prepareSource(source, { signal, onProgress, maxSize: Math.min(this.lastState?.maxFileSize || MAX_FILE_SIZE, MAX_FILE_SIZE) });
    let upload, stream;
    try {
      const { name, size } = prepared;
      signal.throwIfAborted();
      upload = await this.request('/api/uploads', { method: 'POST', input: { name, size }, session, signal });
      if (!/^[0-9a-f-]{36}$/.test(upload.id) || !Number.isInteger(upload.chunkSize) || upload.chunkSize < 1 || upload.chunkSize > CHUNK_SIZE) throw new AppError(502, 'The host could not prepare this upload.');
      const hash = crypto.createHash('sha256');
      const report = progressReporter(onProgress, { name, total: size, phase: 'uploading', skipped: prepared.skipped });
      report({ bytes: 0 }, true);
      stream = prepared.open();
      const iterator = stream[Symbol.asyncIterator]();
      let pending = Buffer.alloc(0);
      for (let offset = 0; offset < size;) {
        signal.throwIfAborted();
        if (session !== this.session) throw new AppError(401, 'Your visit has ended.');
        const chunk = Buffer.allocUnsafe(Math.min(upload.chunkSize, size - offset));
        let read = 0;
        while (read < chunk.length) {
          if (!pending.length) {
            const result = await iterator.next();
            if (result.done) throw new AppError(409, 'The file changed while uploading. Add it again when editing is finished.');
            pending = result.value;
          }
          const copied = Math.min(pending.length, chunk.length - read);
          pending.copy(chunk, read, 0, copied); read += copied; pending = pending.subarray(copied);
        }
        hash.update(chunk);
        let reply;
        for (let attempt = 0; ; attempt++) {
          try { reply = await this.request(`/api/uploads/${upload.id}/chunks/${offset}`, { method: 'PUT', input: chunk, raw: true, session, signal }); break; }
          catch (error) {
            signal.throwIfAborted();
            if (attempt >= 5 || ![409, 408, 429, 502, 503, 504].includes(error.status)) throw error;
            report({ bytes: offset, phase: 'retrying', attempt: attempt + 1 }, true);
            await delay(this.retryDelayMs * Math.min(2 ** attempt, 8), undefined, { signal });
          }
        }
        offset += chunk.length;
        if (reply.offset !== offset) throw new AppError(409, 'The upload was interrupted. Please add the file again.');
        report({ bytes: offset }, true);
      }
      if (pending.length || !(await iterator.next()).done) throw new AppError(409, 'The file changed while uploading. Add it again when editing is finished.');
      report({ bytes: size, phase: 'finishing' }, true);
      const file = await this.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', input: {}, session, signal });
      if (file.sha256 !== hash.digest('hex')) throw new AppError(502, 'The uploaded file did not pass its integrity check.');
      this.emit('change');
      report({ bytes: size, phase: 'complete' }, true);
      return { ...file, skipped: prepared.skipped };
    } catch (error) {
      if (upload && session === this.session && /^[0-9a-f-]{36}$/.test(upload.id)) await this.request('/api/uploads/' + upload.id, { method: 'DELETE', input: {}, session, timeout: 5000 }).catch(() => {});
      throw error;
    } finally { stream?.destroy(); prepared.close(); }
  }

  async file(id) {
    const state = await this.state();
    const file = state.files.find(f => f.id === id && /^[0-9a-f-]{36}$/.test(f.id));
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE) throw new AppError(404, 'That file is no longer available.');
    return { ...file, name: cleanName(file.name) };
  }

  async download(id, destination, { signal, onProgress } = {}) {
    const session = this.session;
    signal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const file = await this.file(id);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new AppError(502, 'The host did not provide a valid file checksum.');
    const key = crypto.createHash('sha256').update(file.id + file.sha256 + path.resolve(destination)).digest('hex').slice(0, 32);
    const temporary = path.join(path.dirname(destination), '.workstation-' + key + '.part');
    let handle, offset = 0, keepPartial = false, ownsPartial = false;
    const hash = crypto.createHash('sha256');
    const report = progressReporter(onProgress || (value => this.emit('progress', value)), { name: file.name, total: file.size, phase: 'downloading' });
    const retryable = error => [408, 429, 502, 503, 504].includes(error.status) || ['TypeError', 'TimeoutError'].includes(error.name) || ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT'].includes(error.code || error.cause?.code);
    try {
      signal.throwIfAborted();
      try { handle = await fs.promises.open(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.promises.lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AppError(400, 'Choose another save location. The temporary download path is unavailable.');
        handle = await fs.promises.open(temporary, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      }
      ownsPartial = true;
      offset = (await handle.stat()).size;
      if (offset > file.size) { await handle.truncate(0); offset = 0; }
      await checkDiskSpace(path.dirname(destination), file.size - offset);
      if (offset) {
        report({ bytes: 0, phase: 'checking' }, true);
        let checked = 0;
        const buffer = Buffer.alloc(1024 ** 2);
        while (checked < offset) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset - checked), checked);
          if (!bytesRead) throw new AppError(409, 'The saved partial download changed. Try again.');
          hash.update(buffer.subarray(0, bytesRead)); checked += bytesRead;
          report({ bytes: checked, phase: 'checking' });
        }
      }
      let attempts = 0;
      while (offset < file.size || file.size === 0 && attempts === 0) {
        signal.throwIfAborted();
        const idle = new AbortController();
        let timer;
        const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new AppError(408, 'The download stalled.')), this.transferIdleMs); timer.unref(); };
        const start = offset;
        let response;
        try {
          touch();
          report({ bytes: offset, phase: 'downloading' }, true);
          response = await this.fetch(`/api/files/${file.id}/download`, { session, timeout: 0, signal: AbortSignal.any([signal, idle.signal]),
            headers: { 'If-Match': '"' + file.sha256 + '"', ...(offset ? { Range: `bytes=${offset}-` } : {}) } });
          const contentRange = response.headers.get('content-range');
          if ((offset && (response.status !== 206 || contentRange !== `bytes ${offset}-${file.size - 1}/${file.size}`)) ||
              Number(response.headers.get('content-length')) !== file.size - offset ||
              (response.headers.has('etag') && response.headers.get('etag') !== '"' + file.sha256 + '"')) {
            throw new AppError(409, 'The host sent an incompatible download. Update both apps and try again.');
          }
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            if (offset + chunk.length > file.size) throw new AppError(409, 'The file changed during the download. Try again.');
            let written = 0;
            while (written < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, offset + written);
              if (!bytesWritten) throw new AppError(507, 'Could not write the download. Check free disk space.');
              written += bytesWritten;
            }
            hash.update(chunk); offset += chunk.length;
            touch(); report({ bytes: offset });
          }
          if (offset !== file.size) throw new AppError(503, 'The connection closed before the download finished.');
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (session !== this.session) throw new AppError(401, 'Your visit has ended.');
          if (idle.signal.aborted) error = idle.signal.reason;
          if (!retryable(error)) throw error;
          if (offset === file.size && file.size !== 0) break;
          if (offset > start) attempts = 0;
          if (++attempts > 5) {
            keepPartial = true;
            throw new AppError(503, 'Download interrupted. Your progress is saved. Choose Save a copy again with the same destination to resume.');
          }
          report({ bytes: offset, phase: 'retrying', attempt: attempts }, true);
        } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
        await delay(this.retryDelayMs * Math.min(2 ** (attempts - 1), 8), undefined, { signal });
      }
      if (session !== this.session) throw new AppError(401, 'Your visit has ended.');
      if (offset !== file.size || hash.digest('hex') !== file.sha256) throw new AppError(502, 'The downloaded file did not pass its integrity check. Try again.');
      report({ bytes: offset, phase: 'finishing' }, true);
      await handle.sync(); await handle.close(); handle = null;
      signal.throwIfAborted();
      await fs.promises.rename(temporary, destination);
      report({ bytes: offset, phase: 'complete' }, true);
      return true;
    } catch (error) {
      if (ownsPartial && (error.status === 507 || error.code === 'ENOSPC')) {
        keepPartial = (await fs.promises.stat(temporary).catch(() => ({ size: 0 }))).size > 0;
        if (keepPartial) throw new AppError(507, 'Not enough free disk space. Your download progress is saved. Free some space, then choose Save a copy with the same destination to resume.');
      }
      throw error;
    } finally {
      await handle?.close();
      if (ownsPartial && !keepPartial) await fs.promises.rm(temporary, { force: true });
    }
  }
}

module.exports = { GuestClient };
