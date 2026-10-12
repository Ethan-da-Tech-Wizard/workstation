'use strict';

// Optional disk-backed check: a complete ZIP64 import and HTTP download above 4 GB.
// Uses ~8.1 GB temporarily, then removes only its own generated fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Workspace } = require('../src/workspace.cjs');
const { GuestClient } = require('../src/guest-client.cjs');
const { startGuestServer } = require('../src/guest-server.cjs');

(async () => {
  const parent = process.env.WORKSTATION_LARGE_TEST_DIR || path.resolve(__dirname, '..');
  const free = fs.statfsSync(parent);
  if (free.bavail * free.bsize < 10 * 1024 ** 3) throw new Error('This optional test needs at least 10 GB free on its test drive.');
  const root = fs.mkdtempSync(path.join(parent, '.workstation-large-test-'));
  const workspace = new Workspace(path.join(root, 'host'), { allowLocalCodes: true });
  let server, guest;
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const started = Date.now();
  let lastLog = 0;
  const progress = value => {
    if (Date.now() - lastLog > 3000 || value.phase === 'complete') {
      lastLog = Date.now(); console.log(`${value.phase}: ${value.percent ?? 0}% (${((value.bytes || 0) / 1024 ** 3).toFixed(2)} GiB)`);
    }
  };
  try {
    const folder = path.join(root, 'Large folder'); fs.mkdirSync(folder);
    const source = path.join(folder, 'payload.bin');
    const fd = fs.openSync(source, 'w');
    fs.ftruncateSync(fd, 4 * 1024 ** 3 + 12345);
    fs.writeSync(fd, Buffer.from('large-file-end'), 0, 14, 4 * 1024 ** 3 + 12345 - 14); fs.closeSync(fd);
    fs.mkdirSync(path.join(folder, 'empty'));
    const file = await workspace.importFile(folder, { onProgress: progress });
    assert.ok(file.size > 4 * 1024 ** 3);
    // Independently parse ZIP64 metadata without extracting another 4 GB copy.
    execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); i=z.getinfo("Large folder/payload.bin"); assert i.file_size == 4*1024**3+12345; assert z.getinfo("Large folder/empty/").is_dir()', workspace.resolveFile(file.id).location]);
    server = await startGuestServer(workspace);
    workspace.setSharing('online', server.localUrl);
    guest = new GuestClient({ allowLocal: true });
    await guest.join(workspace.createInvite().code, 'Large transfer test');
    const destination = path.join(root, 'download.zip');
    await guest.download(file.id, destination, { onProgress: progress });
    assert.equal(fs.statSync(destination).size, file.size);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
    assert.equal(hash.digest('hex'), file.sha256);
    assert.ok(peakRss < 512 * 1024 ** 2, `Transfers used too much memory: ${peakRss}`);
    const result = { bytes: file.size, seconds: Math.round((Date.now() - started) / 1000), peakRssMiB: Math.round(peakRss / 1024 ** 2), passed: true };
    console.log(JSON.stringify(result));
    fs.writeFileSync(path.resolve(__dirname, '../artifacts/large-transfer-result.json'), JSON.stringify(result, null, 2) + os.EOL);
  } finally {
    clearInterval(sample); guest?.clear(); if (server) await server.close(); workspace.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
