'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { Workspace, CHUNK_SIZE, MAX_FILE_SIZE } = require('../src/workspace.cjs');
const { GuestClient } = require('../src/guest-client.cjs');
const { startGuestServer } = require('../src/guest-server.cjs');
const { copyVerified, prepareSource } = require('../src/file-transfer.cjs');

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-transfer-'));
  const workspace = new Workspace(path.join(root, 'host'), { allowLocalCodes: true });
  const server = await startGuestServer(workspace);
  workspace.setSharing('online', server.localUrl);
  const guest = new GuestClient({ allowLocal: true, retryDelayMs: 1, transferIdleMs: 1000 });
  await guest.join(workspace.createInvite().code, 'Guest');
  t.after(async () => { guest.clear(); await server.close(); workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, server, guest };
}

test('nested and empty folders import as readable ZIP64 archives on host and guest', async t => {
  const { root, workspace, guest } = await setup(t);
  const source = path.join(root, 'My folder');
  fs.mkdirSync(path.join(source, 'nested', 'empty'), { recursive: true });
  const payload = crypto.randomBytes(CHUNK_SIZE + 37);
  fs.writeFileSync(path.join(source, 'nested', 'large.bin'), payload);
  fs.writeFileSync(path.join(source, 'Résumé.txt'), 'A Unicode filename');
  fs.symlinkSync(source, path.join(source, 'loop'));
  const { extract } = await import('@electron-internal/extract-zip');
  for (const [index, upload] of [workspace.importFile.bind(workspace), guest.uploadFile.bind(guest)].entries()) {
    const progress = [];
    const file = await upload(source, { onProgress: value => progress.push(value) });
    assert.equal(file.skipped, 1);
    assert.match(file.name, /^My folder(?: \(2\))?\.zip$/);
    assert.equal(progress[0].phase, 'scanning');
    assert.equal(progress.at(-1).percent, 100);
    assert.ok(progress.some(value => value.total > CHUNK_SIZE));
    const destination = path.join(root, `extracted-${index}`);
    await extract(workspace.resolveFile(file.id).location, { dir: destination });
    assert.deepEqual(fs.readFileSync(path.join(destination, 'My folder/nested/large.bin')), payload);
    assert.equal(fs.readFileSync(path.join(destination, 'My folder/Résumé.txt'), 'utf8'), 'A Unicode filename');
    assert.ok(fs.statSync(path.join(destination, 'My folder/nested/empty')).isDirectory());
    assert.equal(fs.existsSync(path.join(destination, 'My folder/loop')), false);
  }
});

test('folder scans are cancellable and do not publish incomplete files', async t => {
  const { root, workspace } = await setup(t);
  const folder = path.join(root, 'folder'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'file'), 'contents');
  const controller = new AbortController();
  await assert.rejects(workspace.importFile(folder, { signal: controller.signal, onProgress() { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(workspace.snapshot().files.length, 0);
  assert.deepEqual(fs.readdirSync(workspace.incomingDir), []);
});

test('folder copies cancel during streaming and disk shortages fail before opening a large copy', async t => {
  const { root, workspace } = await setup(t);
  const source = path.join(root, 'large.bin');
  fs.writeFileSync(source, Buffer.alloc(5 * 1024 ** 2, 17));
  const controller = new AbortController();
  await assert.rejects(workspace.importFile(source, { signal: controller.signal,
    onProgress(value) { if (value.bytes > 0) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(workspace.uploads.size, 0);
  assert.deepEqual(fs.readdirSync(workspace.incomingDir), []);
  const statfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
  try { await assert.rejects(workspace.importFile(source), /Not enough free disk space/); }
  finally { fs.statfsSync = statfs; }
  assert.equal(workspace.uploads.size, 0);
  assert.equal(workspace.snapshot().files.length, 0);
});

test('local save preserves the existing destination after cancellation or corruption', async t => {
  const { root, workspace } = await setup(t);
  const source = path.join(root, 'source.bin'); fs.writeFileSync(source, Buffer.alloc(1024 ** 2, 11));
  const file = await workspace.importFile(source);
  const destination = path.join(root, 'saved.bin'); fs.writeFileSync(destination, 'Keep my copy');
  const controller = new AbortController();
  await assert.rejects(copyVerified(source, destination, file, { signal: controller.signal,
    onProgress(value) { if (value.bytes > 0) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'Keep my copy');
  await assert.rejects(copyVerified(source, destination, { ...file, sha256: '0'.repeat(64) }), /integrity/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'Keep my copy');
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);
});

test('the file cap permits 1 TB, quotas remain enforceable, and reservations count only unwritten bytes', async t => {
  const { workspace } = await setup(t);
  const statfs = fs.statfsSync;
  const available = MAX_FILE_SIZE + 1024 ** 3;
  fs.statfsSync = () => ({ bavail: available, bsize: 1 });
  try {
    assert.equal(MAX_FILE_SIZE, 1024 ** 4);
    const upload = workspace.beginUpload(null, 'huge.bin', MAX_FILE_SIZE);
    const before = workspace.availableSpace();
    workspace.uploads.get(upload.id).offset = 12 * 1024 ** 3;
    assert.equal(workspace.availableSpace() - before, 12 * 1024 ** 3);
    assert.throws(() => workspace.beginUpload(null, 'too-big.bin', MAX_FILE_SIZE + 1), { status: 413 });
    workspace.cancelUpload(upload.id);
  } finally { fs.statfsSync = statfs; }
});

test('range downloads support offsets beyond 4 GB and reject invalid ranges and changed validators', async t => {
  const { workspace, guest } = await setup(t);
  const largeOffset = 4 * 1024 ** 3 + 19;
  const id = crypto.randomUUID();
  const location = path.join(workspace.filesDir, 'sparse.bin');
  const fd = fs.openSync(location, 'w');
  fs.writeSync(fd, Buffer.from('last bytes'), 0, 10, largeOffset); fs.closeSync(fd);
  const checksum = 'a'.repeat(64);
  workspace.data.files.push({ id, name: 'sparse.bin', diskName: 'sparse.bin', size: largeOffset + 10, sha256: checksum });
  const route = `/api/files/${id}/download`;
  const response = await guest.fetch(route, { headers: { Range: `bytes=${largeOffset}-`, 'If-Match': '"' + checksum + '"' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes ${largeOffset}-${largeOffset + 9}/${largeOffset + 10}`);
  assert.equal(await response.text(), 'last bytes');
  for (const range of ['bytes=999999999999-', 'bytes=20-10', 'bytes=0-1,3-4', 'bytes=-1', 'nonsense']) await assert.rejects(guest.fetch(route, { headers: { Range: range } }), { status: 416 });
  await assert.rejects(guest.fetch(route, { headers: { 'If-Match': '"changed"' } }), { status: 412 });
});

// A real TCP disconnect after delivering part of a response exercises disk offsets,
// retries and server range handling together (not just a mocked request error).
async function disconnectProxy(t, target) {
  const ranges = [];
  let faults = 1, stall = false;
  const proxy = http.createServer((req, res) => {
    const download = req.url.endsWith('/download');
    if (download) ranges.push(req.headers.range || null);
    const upstream = http.request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      if (download && faults > 0) {
        faults--;
        response.once('data', data => {
          res.write(data); response.destroy();
          if (!stall) setTimeout(() => res.destroy(), 15);
        });
      } else response.pipe(res);
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  return { origin: `http://127.0.0.1:${proxy.address().port}`, ranges, setFaults(value, shouldStall = false) { faults = value; stall = shouldStall; } };
}

test('broken downloads automatically resume from written bytes with a matching checksum', async t => {
  const { root, workspace, server, guest } = await setup(t);
  const source = path.join(root, 'payload.bin'); const payload = crypto.randomBytes(2 * 1024 ** 2);
  fs.writeFileSync(source, payload); const file = await workspace.importFile(source);
  const proxy = await disconnectProxy(t, server.localUrl);
  guest.session.origin = proxy.origin;
  const progress = [];
  const destination = path.join(root, 'saved.bin');
  await guest.download(file.id, destination, { onProgress: value => progress.push(value) });
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.equal(proxy.ranges[0], null);
  assert.match(proxy.ranges[1], /^bytes=[1-9][0-9]*-$/);
  assert.ok(progress.some(value => value.phase === 'retrying'));
  assert.equal(progress.at(-1).phase, 'complete');
});

test('a stalled response times out and resumes instead of keeping the spinner running', async t => {
  const { root, workspace, server, guest } = await setup(t);
  guest.transferIdleMs = 100;
  const source = path.join(root, 'payload.bin'); const payload = crypto.randomBytes(512 * 1024);
  fs.writeFileSync(source, payload); const file = await workspace.importFile(source);
  const proxy = await disconnectProxy(t, server.localUrl);
  proxy.setFaults(1, true); guest.session.origin = proxy.origin;
  const progress = [];
  const destination = path.join(root, 'saved.bin');
  await guest.download(file.id, destination, { onProgress: value => progress.push(value) });
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.ok(progress.some(value => value.phase === 'retrying'));
  assert.match(proxy.ranges[1], /^bytes=[1-9][0-9]*-$/);
});

test('a later Save a copy resumes a retained partial; cancellation removes it and keeps the old destination', async t => {
  const { root, workspace, guest } = await setup(t);
  const source = path.join(root, 'payload.bin'); const payload = crypto.randomBytes(2 * 1024 ** 2);
  fs.writeFileSync(source, payload); const file = await workspace.importFile(source);
  const destination = path.join(root, 'saved.bin'); fs.writeFileSync(destination, 'Keep my copy');
  const originalFetch = guest.fetch.bind(guest);
  let requests = 0;
  guest.fetch = async (route, options) => {
    if (!route.endsWith('/download')) return originalFetch(route, options);
    if (requests++ > 0) throw Object.assign(new Error('Offline'), { status: 503 });
    const response = await originalFetch(route, options);
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(controller) {
        if (this.sent) { await reader.cancel(); controller.error(new TypeError('Connection dropped')); return; }
        this.sent = true; const { value } = await reader.read(); controller.enqueue(value);
      }
    }), { status: 200, headers: response.headers });
  };
  await assert.rejects(guest.download(file.id, destination), /progress is saved/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'Keep my copy');
  assert.ok(fs.readdirSync(root).some(name => name.endsWith('.part')));
  guest.fetch = originalFetch;
  const statfs = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bavail: 0, bsize: 4096 });
  try { await assert.rejects(guest.download(file.id, destination), /progress is saved/); }
  finally { fs.promises.statfs = statfs; }
  assert.ok(fs.readdirSync(root).some(name => name.endsWith('.part')), 'A full drive must not discard a previously saved partial download');
  const progress = [];
  await guest.download(file.id, destination, { onProgress: value => progress.push(value) });
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.ok(progress.some(value => value.phase === 'checking'));
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);
  fs.writeFileSync(destination, 'Keep my copy');
  const controller = new AbortController();
  await assert.rejects(guest.download(file.id, destination, { signal: controller.signal, onProgress(value) { if (value.bytes > 0) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'Keep my copy');
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);
});

test('duplicate upload chunks are acknowledged exactly once after a lost reply', async t => {
  const { workspace } = await setup(t);
  const chunk = Buffer.from('test content');
  const upload = workspace.beginUpload(null, 'file.txt', chunk.length);
  const first = workspace.appendChunk(null, upload.id, 0, chunk);
  assert.deepEqual(workspace.appendChunk(null, upload.id, 0, chunk), first);
  assert.throws(() => workspace.appendChunk(null, upload.id, 0, Buffer.alloc(chunk.length)), { status: 409 });
  const file = workspace.finishUpload(null, upload.id);
  assert.deepEqual(fs.readFileSync(workspace.resolveFile(file.id).location), chunk);
});

test('a host drive filling during a guest upload reports a disk-space error and cleans up', async t => {
  const { root, workspace, guest } = await setup(t);
  const source = path.join(root, 'file.txt'); fs.writeFileSync(source, 'Keep the original');
  const append = workspace.appendChunk;
  workspace.appendChunk = () => { throw Object.assign(new Error('No space left'), { code: 'ENOSPC' }); };
  try { await assert.rejects(guest.uploadFile(source), { status: 507, message: /free disk space/ }); }
  finally { workspace.appendChunk = append; }
  assert.equal(workspace.uploads.size, 0);
  assert.deepEqual(fs.readdirSync(workspace.incomingDir), []);
  assert.equal(fs.readFileSync(source, 'utf8'), 'Keep the original');
});

test('an empty folder is a valid archive and importing workspace storage is rejected', async t => {
  const { root, workspace } = await setup(t);
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
  const prepared = await prepareSource(empty);
  let size = 0; for await (const chunk of prepared.open()) size += chunk.length;
  assert.equal(size, prepared.size); prepared.close();
  await assert.rejects(workspace.importFile(workspace.root), /outside the workspace/);
});
