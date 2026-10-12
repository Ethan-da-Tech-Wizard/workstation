'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { Workspace, cleanName, CHUNK_SIZE } = require('../src/workspace.cjs');
const { startGuestServer } = require('../src/guest-server.cjs');
const { decodeInviteCode } = require('../src/invite-code.cjs');
const tokenFor = code => decodeInviteCode(code, { allowLocal: true }).token;

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-unit-'));
  const workspace = new Workspace(root, { allowLocalCodes: true, ...options });
  workspace.setSharing('online', 'https://test.trycloudflare.com');
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return workspace;
}
function invite(workspace, name = 'Taylor') {
  const link = workspace.createInvite();
  return workspace.join(tokenFor(link.code), name);
}
function addFile(workspace, author = null, name = 'hello.txt', contents = Buffer.from('Hello from the workspace')) {
  const upload = workspace.beginUpload(author, name, contents.length);
  for (let offset = 0; offset < contents.length; offset += CHUNK_SIZE) workspace.appendChunk(author, upload.id, offset, contents.subarray(offset, offset + CHUNK_SIZE));
  return workspace.finishUpload(author, upload.id);
}
async function serverSetup(t) {
  const workspace = setup(t);
  const server = await startGuestServer(workspace);
  workspace.setSharing('online', server.localUrl);
  t.after(() => server.close());
  async function request(route, { method = 'GET', input, token = '', raw = false, origin, extra = {} } = {}) {
    const headers = { 'X-Workstation-Protocol': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}), ...extra };
    if (method !== 'GET') headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
    return fetch(server.localUrl + route, { method, headers, body: input === undefined ? undefined : raw ? input : JSON.stringify(input) });
  }
  async function claim(name = 'Taylor') {
    const link = workspace.createInvite();
    const res = await request('/api/join', { method: 'POST', input: { token: tokenFor(link.code), name } });
    assert.equal(res.status, 200);
    const reply = await res.json();
    return { token: reply.session, state: reply.state, link };
  }
  return { workspace, server, request, claim };
}

test('single-use invite admits exactly one guest and rejects replay, expiry, cancellation', t => {
  const w = setup(t);
  const token = tokenFor(w.createInvite().code);
  const first = w.join(token, 'Taylor');
  assert.equal(w.authenticate(first.secret).name, 'Taylor');
  assert.throws(() => w.join(token, 'Other person'), { status: 410 });
  const pending = w.createInvite(); w.cancelInvite(pending.id);
  assert.throws(() => w.join(tokenFor(pending.code), 'Other person'), { status: 410 });
  const expiring = w.createInvite();
  [...w.invites.values()].find(i => i.id === expiring.id).expiresAt = Date.now() - 1;
  assert.throws(() => w.join(tokenFor(expiring.code), 'Other person'), { status: 410 });
});

test('removing a guest revokes their session, aborts transfers, and keeps their completed files', t => {
  const w = setup(t); const guest = invite(w);
  const file = addFile(w, guest.session);
  const partial = w.beginUpload(guest.session, 'unfinished.txt', 12);
  w.appendChunk(guest.session, partial.id, 0, Buffer.from('part'));
  let aborted = false; w.trackTransfer(guest.session.id, () => { aborted = true; });
  w.revoke(guest.session.id);
  assert.equal(aborted, true);
  assert.throws(() => w.authenticate(guest.secret), { status: 401 });
  assert.throws(() => w.chat(guest.session, 'blocked'), { status: 401 });
  assert.throws(() => w.finishUpload(guest.session, partial.id), { status: 401 });
  assert.equal(fs.readFileSync(w.resolveFile(file.id).location, 'utf8'), 'Hello from the workspace');
  assert.equal(w.uploads.size, 0);
  assert.equal(fs.readdirSync(w.incomingDir).length, 0);
});

test('files and chat survive reopening, while all invitations and sessions expire', t => {
  const w = setup(t); const guest = invite(w);
  const file = addFile(w, guest.session);
  w.chat(guest.session, 'Saved conversation');
  const token = tokenFor(w.createInvite().code);
  w.close();
  const reopened = new Workspace(w.root);
  reopened.setSharing('online', 'https://test.trycloudflare.com');
  assert.equal(reopened.snapshot().files[0].id, file.id);
  assert.equal(reopened.snapshot().messages[0].text, 'Saved conversation');
  assert.throws(() => reopened.authenticate(guest.secret), { status: 401 });
  assert.throws(() => reopened.join(token, 'Taylor'), { status: 410 });
  reopened.close();
});

test('uploads handle binary data, multiple chunks, duplicate filenames, empty files and safe names', t => {
  const w = setup(t); const guest = invite(w);
  const payload = crypto.randomBytes(CHUNK_SIZE + 131);
  const file = addFile(w, guest.session, '../../report.bin', payload);
  assert.equal(file.name, 'report.bin');
  assert.deepEqual(fs.readFileSync(w.resolveFile(file.id).location), payload);
  assert.equal(file.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  const duplicate = addFile(w, null, 'report.bin', Buffer.alloc(0));
  assert.equal(duplicate.name, 'report (2).bin');
  assert.equal(fs.statSync(w.resolveFile(duplicate.id).location).size, 0);
  assert.equal(cleanName('C:\\secret\\report.txt'), 'report.txt');
  assert.equal(cleanName('NUL.txt'), '_NUL.txt');
  assert.equal(cleanName('..'), 'Untitled');
  assert.ok(Buffer.byteLength(cleanName('🌸'.repeat(500))) <= 180);
});

test('upload ownership, size reservations and chunk ordering are enforced', t => {
  const w = setup(t, { maxFileSize: 100, storageLimit: 120 });
  const a = invite(w, 'A').session, b = invite(w, 'B').session;
  const upload = w.beginUpload(a, 'a.bin', 80);
  assert.throws(() => w.beginUpload(b, 'too-big.bin', 101), { status: 413 });
  assert.throws(() => w.beginUpload(b, 'quota.bin', 50), { status: 413 });
  assert.throws(() => w.getUpload(b, upload.id), { status: 404 });
  assert.throws(() => w.appendChunk(a, upload.id, 1, Buffer.from('x')), { status: 409 });
  assert.throws(() => w.finishUpload(a, upload.id), { status: 409 });
  w.cancelUpload(upload.id);
  assert.doesNotThrow(() => w.beginUpload(b, 'available.bin', 50));
});

test('stopping sharing disconnects everyone and invalidates pending invites', t => {
  const w = setup(t); const guest = invite(w); const token = tokenFor(w.createInvite().code);
  w.stopSharing();
  assert.throws(() => w.authenticate(guest.secret), { status: 401 });
  w.setSharing('online', 'https://new.trycloudflare.com');
  assert.throws(() => w.join(token, 'Second'), { status: 410 });
  assert.equal(w.snapshot().participants.length, 0);
});

test('guest state never exposes invitation secrets or host storage paths', t => {
  const w = setup(t); const guest = invite(w); addFile(w);
  w.createInvite();
  const state = w.snapshot(guest.session);
  for (const key of ['invites', 'sharing', 'storagePath']) assert.equal(state[key], undefined);
  assert.equal(state.files[0].diskName, undefined);
  assert.ok(!JSON.stringify(state).includes(w.root));
});

test('host imports are independent copies and removed files stay recoverable', async t => {
  const w = setup(t);
  const source = path.join(w.root, 'original.txt'); fs.writeFileSync(source, 'Keep me');
  const file = await w.importFile(source);
  fs.writeFileSync(source, 'Changed original');
  assert.equal(fs.readFileSync(w.resolveFile(file.id).location, 'utf8'), 'Keep me');
  w.removeFile(file.id);
  assert.equal(w.snapshot().files.length, 0);
  assert.equal(fs.readFileSync(path.join(w.trashDir, fs.readdirSync(w.trashDir)[0]), 'utf8'), 'Keep me');
});

test('desktop-only endpoint rejects web joins and concurrent code claims have one winner', async t => {
  const { workspace, request } = await serverSetup(t);
  const link = workspace.createInvite(); const token = tokenFor(link.code);
  assert.equal((await request('/join')).status, 404);
  assert.equal((await request('/')).headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await request('/api/state')).status, 401);
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => request('/api/join', { method: 'POST', input: { token, name: 'Guest ' + index } })));
  assert.equal(claims.filter(r => r.status === 200).length, 1);
  assert.equal(claims.filter(r => r.status === 410).length, 7);
  const winning = claims.find(r => r.status === 200);
  assert.equal(winning.headers.get('set-cookie'), null);
  assert.match((await winning.json()).session, /^[A-Za-z0-9_-]{43}$/);
});

test('HTTP guests can upload and download, and revoked app credentials cannot read or write', async t => {
  const { workspace, request, claim } = await serverSetup(t);
  const guest = await claim();
  const res = await request('/api/uploads', { method: 'POST', token: guest.token, input: { name: 'guest.html', size: 9 } });
  assert.equal(res.status, 201); const upload = await res.json();
  assert.equal((await request(`/api/uploads/${upload.id}/chunks/0`, { method: 'PUT', token: guest.token, raw: true, input: Buffer.from('<b>Hi</b>') })).status, 200);
  const finished = await request(`/api/uploads/${upload.id}/complete`, { method: 'POST', token: guest.token, input: {} });
  assert.equal(finished.status, 201); const file = await finished.json();
  const downloaded = await request(`/api/files/${file.id}/download`, { token: guest.token });
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
  assert.equal(await downloaded.text(), '<b>Hi</b>');
  assert.equal((await request('/api/messages', { method: 'POST', token: guest.token, input: { text: 'Hello!' } })).status, 201);
  workspace.revoke(guest.state.self.id);
  for (const route of ['/api/state', `/api/files/${file.id}/download`]) assert.equal((await request(route, { token: guest.token })).status, 401);
  assert.equal((await request('/api/messages', { method: 'POST', token: guest.token, input: { text: 'Blocked' } })).status, 401);
  assert.equal(workspace.snapshot().files.length, 1);
});

test('public service rejects cross-site requests, bad hosts, traversal and host actions', async t => {
  const { server, request, claim } = await serverSetup(t);
  const { token } = await claim();
  assert.equal((await request('/api/messages', { method: 'POST', token, input: { text: 'CSRF' }, origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/messages', { method: 'POST', token, input: { text: 'CSRF' }, extra: { 'X-Workstation-Protocol': '' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(server.localUrl + '/api/state', { headers: { Host: 'attacker.invalid', Authorization: 'Bearer ' + token, 'X-Workstation-Protocol': '1' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 421);
  assert.equal((await request('/api/state', { token, extra: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const route of ['/src/main.cjs', '/workspace.json', '/.incoming', '/%2e%2e%2fworkspace.json', '/api/admin', '/api/invites', '/api/files/../../../etc/passwd/download']) assert.ok([404, 401].includes((await request(route, { token })).status));
  const page = await request('/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store, max-age=0');
});

test('removing a guest terminates an in-flight HTTP upload before it can publish', async t => {
  const { workspace, server, request, claim } = await serverSetup(t);
  const guest = await claim();
  const upload = await (await request('/api/uploads', { method: 'POST', token: guest.token, input: { name: 'partial.bin', size: 1000 } })).json();
  const result = new Promise(resolve => {
    const req = http.request(server.localUrl + `/api/uploads/${upload.id}/chunks/0`, { method: 'PUT', headers: { Authorization: 'Bearer ' + guest.token, 'X-Workstation-Protocol': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': 1000 } });
    req.on('error', error => resolve(error.code)); req.on('response', res => resolve(res.statusCode));
    req.write(Buffer.alloc(100));
    setTimeout(() => workspace.revoke(guest.state.self.id), 30);
  });
  assert.equal(await result, 'ECONNRESET');
  assert.equal(workspace.uploads.size, 0);
  assert.equal(workspace.snapshot().files.length, 0);
});
