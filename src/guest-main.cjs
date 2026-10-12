'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, session, safeStorage, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GuestClient } = require('./guest-client.cjs');
const { DesktopTransfers } = require('./desktop-transfers.cjs');

app.setName('Workstation Guest');
app.setAppUserModelId('Workstation.Guest');
const profile = process.env.WORKSTATION_GUEST_DATA_DIR || path.join(app.getPath('appData'), 'Workstation Guest');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
const pagePath = path.join(__dirname, '..', 'ui', 'index.html');
const pageUrl = pathToFileURL(pagePath).href;
const savedSession = path.join(profile, 'session.encrypted');
let window, client, transfers;
let displayName = '';

function secureStorageAvailable() {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    client = new GuestClient({ allowLocal: process.env.WORKSTATION_TEST_LOCAL === '1' });
    try { displayName = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8')).name || ''; } catch {}
    try {
      if (secureStorageAvailable() && fs.existsSync(savedSession)) client.restore(JSON.parse(safeStorage.decryptString(fs.readFileSync(savedSession))));
    } catch { fs.rmSync(savedSession, { force: true }); }
    client.on('credentials', credentials => {
      try {
        if (!credentials) fs.rmSync(savedSession, { force: true });
        else if (secureStorageAvailable()) {
          fs.writeFileSync(savedSession + '.tmp', safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
          fs.renameSync(savedSession + '.tmp', savedSession);
        }
      } catch { console.warn('This session could not be remembered on this computer.'); }
    });

    window = new BrowserWindow({
      width: 1240, height: 860, minWidth: 820, minHeight: 680,
      title: 'Workstation', backgroundColor: '#f6f7f3', icon: path.join(__dirname, '..', 'ui', 'icon.png'), show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
        sandbox: true, webSecurity: true, spellcheck: true, devTools: !app.isPackaged,
        additionalArguments: ['--workstation-guest']
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    transfers = new DesktopTransfers(window, powerSaveBlocker);
    client.on('change', () => { if (!window.isDestroyed()) window.webContents.send('workstation:changed'); });
    client.on('progress', value => { if (!window.isDestroyed()) window.webContents.send('workstation:progress', value); });

    ipcMain.handle('workstation:action', async (event, action, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) return { ok: false, error: 'Use the Workstation app to perform this action.' };
      try {
        let result;
        switch (action) {
          case 'state': {
            if (!client.session) result = { role: 'lobby', name: displayName, notice: client.lastNotice };
            else {
              try { result = await client.state(); }
              catch (error) {
                if (!client.session) result = { role: 'lobby', name: displayName, notice: client.lastNotice };
                else if (client.lastState) result = { ...client.lastState, connectionError: error.message };
                else result = { role: 'lobby', name: displayName, resumeAvailable: true, connectionError: error.message };
              }
            }
            result.transfer = transfers.progress;
            break;
          }
          case 'join':
            result = await client.join(input?.code, input?.name);
            displayName = result.self.name;
            try { fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ name: displayName }), { mode: 0o600 }); }
            catch { console.warn('Your display name could not be saved for next time.'); }
            break;
          case 'leave': await client.leave(); result = true; break;
          case 'forgetSession': client.clear(); result = true; break;
          case 'cancelTransfer': transfers.cancel(); result = true; break;
          case 'sendMessage': result = await client.message(input?.text); break;
          case 'importFiles':
          case 'importFolder': {
            if (!client.session) throw new Error('Join a workstation first.');
            const selected = await dialog.showOpenDialog(window, { title: action === 'importFolder' ? 'Add a folder as a ZIP file' : 'Add files to the shared workstation', properties: [action === 'importFolder' ? 'openDirectory' : 'openFile', 'multiSelections'] });
            result = [];
            if (!selected.canceled) await transfers.run(async options => {
              for (const file of selected.filePaths) result.push(await client.uploadFile(file, options));
            });
            break;
          }
          case 'importDropped': {
            if (!Array.isArray(input) || input.length > 100 || input.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Please drop up to 100 files or folders at a time.');
            result = [];
            await transfers.run(async options => {
              for (const file of input) result.push(await client.uploadFile(file, options));
            });
            break;
          }
          case 'saveFile': {
            const file = await client.file(input?.id);
            const selected = await dialog.showSaveDialog(window, { title: 'Save a copy to your computer', defaultPath: path.join(app.getPath('downloads'), file.name), buttonLabel: 'Save copy' });
            result = selected.canceled ? false : await transfers.run(options => client.download(file.id, selected.filePath, options));
            break;
          }
          default: throw new Error('This action is only available to the workspace owner.');
        }
        return { ok: true, data: result };
      } catch (error) { return { ok: false, error: error.message, status: error.status }; }
    });
    await window.loadFile(pagePath);
  }).catch(error => { dialog.showErrorBox('Workstation could not open', error.message); app.quit(); });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { transfers?.cancel(); client?.controller.abort(); });
