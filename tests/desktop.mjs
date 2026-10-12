import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-desktops-'));
const artifacts = path.join(root, 'artifacts');
const internet = process.argv.includes('--internet');
const packaged = process.argv.includes('--packaged');
fs.mkdirSync(artifacts, { recursive: true });
const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;
if (!internet) baseEnv.WORKSTATION_TEST_LOCAL = '1'; else delete baseEnv.WORKSTATION_TEST_LOCAL;
const errors = [];
const rendererNetwork = [];
let hostApp, host, guestApp, guest, otherApp;

async function openApp(mode, profile) {
  const hostMode = mode === 'host';
  const executable = hostMode && packaged ? path.join(root, 'dist/Workstation/workstation-bin') : path.join(root, 'node_modules/electron/dist/electron');
  const appPath = hostMode ? root : packaged ? path.join(root, 'dist/Workstation Guest/resources/app') : path.join(root, 'src/guest-main.cjs');
  const args = hostMode && packaged ? ['--ozone-platform=x11', '--disable-gpu'] : [appPath, '--ozone-platform=x11', '--disable-gpu'];
  const app = await electron.launch({ executablePath: executable, args, env: { ...baseEnv, WORKSTATION_DATA_DIR: path.join(temporary, 'host'), WORKSTATION_GUEST_DATA_DIR: path.join(temporary, profile || 'guest') }, timeout: 30_000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) rendererNetwork.push(request.url()); });
  await expect(page.locator(hostMode ? '#app' : '#join-screen')).toBeVisible({ timeout: 15_000 });
  assert.match(page.url(), /^file:\/\//);
  assert.equal(await page.evaluate(() => window.workstation.mode), mode);
  await page.waitForTimeout(400);
  return { app, page };
}

async function createCode() {
  await host.locator('#invite-button').click();
  await expect(host.locator('#invite-ready')).toBeVisible({ timeout: internet ? 170_000 : 10_000 });
  const code = await host.locator('#invite-code').inputValue();
  assert.ok(code.startsWith(internet ? 'WS1-' : 'WST-'));
  assert.ok(!code.includes('http') && !code.includes('.com'));
  await host.getByRole('button', { name: 'Close invitation', exact: true }).click();
  return code;
}

async function join(page, code, name) {
  await page.locator('#join-code').fill(code);
  await page.locator('#guest-name').fill(name);
  await page.locator('#join-button').click();
}

async function pickFile(app, page, filename) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename);
  await page.locator('#upload-button').click();
  await expect(page.locator('#file-list')).toContainText(path.basename(filename), { timeout: 45_000 });
}

async function saveCopy(app, page, filename, destination) {
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
  await page.getByRole('button', { name: 'Save a copy of ' + filename, exact: true }).click();
  // A prior download can leave the same success toast visible. The destination
  // appears only after this transfer has completed and passed integrity checks.
  await expect.poll(() => fs.existsSync(destination), { timeout: 45_000 }).toBe(true);
  await expect(page.locator('#toast')).toHaveText('Copy saved to your computer.', { timeout: 45_000 });
  return fs.readFileSync(destination);
}

try {
  if (!internet) execFileSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=spec', 'tests/workspace.test.cjs', 'tests/guest-client.test.cjs'], { cwd: root, stdio: 'inherit' });
  ({ app: hostApp, page: host } = await openApp('host'));
  await host.locator('#settings-button').click();
  await host.locator('#setting-host').fill('Ethan');
  await host.locator('#settings-form').getByRole('button', { name: 'Save changes' }).click();
  const hostFile = path.join(temporary, 'Project notes.txt');
  fs.writeFileSync(hostFile, 'Notes shared from the Linux desktop app.\n');
  await pickFile(hostApp, host, hostFile);
  const hostFolder = path.join(temporary, 'Project folder');
  fs.mkdirSync(path.join(hostFolder, 'nested', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(hostFolder, 'nested', 'notes.txt'), 'Folder contents are preserved.');
  await hostApp.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async (_, options) => {
      if (!options.properties.includes('openDirectory')) throw new Error('The folder button must use a directory picker.');
      return { canceled: false, filePaths: [folder] };
    };
  }, hostFolder);
  await host.locator('#folder-button').click();
  await expect(host.locator('#file-list')).toContainText('Project folder.zip');
  await expect(host.locator('#upload-progress')).toBeHidden();
  await expect(host.locator('#folder-button')).toBeEnabled();
  // A failed import leaves an actionable message in the panel, even after the toast expires.
  await hostApp.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(temporary, 'missing-file'));
  await host.locator('#upload-button').click();
  await expect(host.locator('#transfer-error')).toBeVisible();
  await expect(host.locator('#upload-progress')).toBeHidden();
  await expect(host.locator('#upload-button')).toBeEnabled();
  console.log(internet ? 'Preparing a real internet connection between two desktop apps…' : 'Testing two desktop apps with single-use codes…');
  const code = await createCode();
  console.log('Host invitation code is ready.');

  ({ app: guestApp, page: guest } = await openApp('guest'));
  await expect(guest.locator('#join-title')).toHaveText('Join a workstation.');
  await guest.screenshot({ path: path.join(artifacts, 'guest-app-join.png') });
  await join(guest, 'WS1-invalid', 'Taylor');
  await expect(guest.locator('#join-error')).toContainText('could not be read');
  await join(guest, code, 'Taylor');
  await expect(guest.locator('#app')).toBeVisible({ timeout: 35_000 });
  await expect(host.locator('#people')).toContainText('Taylor');
  await expect(guest.locator('#file-list')).toContainText('Project notes.txt');
  assert.equal((await guest.evaluate(() => window.workstation.request('createInvite'))).ok, false);

  const other = await openApp('guest', 'second-guest'); otherApp = other.app;
  await join(other.page, code, 'Second guest');
  await expect(other.page.locator('#join-error')).toContainText('already used', { timeout: 20_000 });
  await expect(other.page.locator('#app')).toBeHidden();
  await otherApp.close(); otherApp = null;

  const payload = crypto.randomBytes((internet ? 1024 : 8 * 1024) * 1024 + 117);
  const guestFile = path.join(temporary, 'Guest design.bin'); fs.writeFileSync(guestFile, payload);
  await pickFile(guestApp, guest, guestFile);
  await expect(host.locator('#file-list')).toContainText('Guest design.bin');
  assert.deepEqual(await saveCopy(guestApp, guest, 'Guest design.bin', path.join(temporary, 'Guest downloaded copy.bin')), payload);
  assert.deepEqual(await saveCopy(hostApp, host, 'Guest design.bin', path.join(temporary, 'Host downloaded copy.bin')), payload);
  assert.deepEqual(await saveCopy(guestApp, guest, 'Project notes.txt', path.join(temporary, 'Notes for guest.txt')), fs.readFileSync(hostFile));
  const archive = await saveCopy(guestApp, guest, 'Project folder.zip', path.join(temporary, 'Downloaded folder.zip'));
  assert.deepEqual(archive, fs.readFileSync(path.join(temporary, 'host/files/Project folder.zip')));
  const guestFolder = path.join(temporary, 'Guest folder'); fs.mkdirSync(guestFolder);
  fs.writeFileSync(path.join(guestFolder, 'guest.txt'), 'Guest folder contents');
  const folderReply = await guest.evaluate(source => window.workstation.request('importDropped', [source]), guestFolder);
  assert.equal(folderReply.ok, true);
  await expect(guest.locator('#file-list')).toContainText('Guest folder.zip');
  await expect(host.locator('#file-list')).toContainText('Guest folder.zip');

  await guest.locator('#message-input').fill('Hello from my desktop app. I’ve shared the files!');
  await guest.locator('#message-input').press('Enter');
  await expect(host.locator('#messages')).toContainText('Hello from my desktop app.', { timeout: 15_000 });
  await host.locator('#message-input').fill('Got them. Let’s get started.');
  await host.locator('#message-input').press('Enter');
  await expect(guest.locator('#messages')).toContainText('Got them. Let’s get started.', { timeout: 15_000 });
  await guest.reload();
  await expect(guest.locator('#app')).toBeVisible();
  assert.match(guest.url(), /^file:\/\//);
  await host.screenshot({ path: path.join(artifacts, 'host-desktop-codes.png') });
  await guest.screenshot({ path: path.join(artifacts, 'guest-desktop-connected.png') });

  if (!internet) {
    await guest.locator('#message-input').fill('<img src=x onerror="window.pwned=true">');
    await guest.locator('#message-input').press('Enter');
    await expect(host.locator('#messages')).toContainText('<img src=x');
    assert.equal(await host.evaluate(() => window.pwned), undefined);
    assert.equal(await guest.evaluate(() => window.pwned), undefined);
    const nextCode = await createCode();
    await host.locator('#invite-button').click();
    await expect(host.locator('#invite-ready')).toBeVisible();
    await host.screenshot({ path: path.join(artifacts, 'host-invitation-code.png') });
    const savePath = path.join(temporary, 'Windows app to send.zip');
    await hostApp.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, savePath);
    await host.locator('#save-guest-app').click();
    await expect(host.locator('#toast')).toContainText('Windows app saved', { timeout: 15_000 });
    assert.equal(fs.statSync(savePath).size, fs.statSync(path.join(root, 'dist/Workstation-Guest-Windows-x64.zip')).size);
    await host.getByRole('button', { name: 'Close invitation', exact: true }).click();
    await host.locator('[data-view="invites"]').click();
    await host.getByRole('button', { name: 'Cancel invitation', exact: true }).first().click();
    await guest.locator('#leave-button').click();
    await expect(guest.locator('#join-title')).toHaveText('You’ve left the workspace.');
    await join(guest, nextCode, 'Taylor');
    await expect(guest.locator('#app')).toBeVisible();
    await host.locator('[data-view="files"]').click();
  }

  await host.getByRole('button', { name: 'Remove Taylor', exact: true }).click();
  await expect(guest.locator('#join-title')).toHaveText('Your visit has ended.', { timeout: 15_000 });
  await expect(guest.locator('#join-form')).toBeVisible();
  await expect(host.locator('#file-list')).toContainText('Guest design.bin');
  const freshCode = await createCode();
  await join(guest, freshCode, 'Taylor again');
  await expect(guest.locator('#app')).toBeVisible({ timeout: 20_000 });
  await host.locator('#stop-sharing').click();
  await expect(guest.locator('#join-title')).toHaveText('Your visit has ended.', { timeout: 15_000 });
  await hostApp.close(); hostApp = null;
  ({ app: hostApp, page: host } = await openApp('host'));
  await expect(host.locator('#file-list')).toContainText('Guest design.bin');
  await expect(host.locator('#connection-label')).toHaveText('Sharing off');
  await expect(host.locator('#messages')).toContainText('Got them. Let’s get started.');
  // A delayed state response must not put the app back into its completed transfer.
  await hostApp.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('workstation:progress', { phase: 'copying', name: 'Completed transfer', bytes: 1, total: 2, percent: 50, sequence: 1000 });
    contents.send('workstation:progress', { phase: 'idle', sequence: 1001 });
    contents.send('workstation:progress', { phase: 'copying', name: 'Completed transfer', bytes: 1, total: 2, percent: 50, sequence: 1000 });
  });
  await host.waitForTimeout(100);
  await expect(host.locator('#upload-progress')).toBeHidden();
  await expect(host.locator('#folder-button')).toBeEnabled();
  assert.deepEqual(rendererNetwork, [], 'Desktop windows must never load or fetch a remote web page');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${internet ? 'public internet' : 'local'} desktop-to-desktop code join, single-use enforcement, native file dialogs, uploads/downloads, chat, removal, rejoining, and persistent host files.`);
} finally {
  await otherApp?.close().catch(() => {});
  await guestApp?.close().catch(() => {});
  await hostApp?.close().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
