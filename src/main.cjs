'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, Menu, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Workspace } = require('./workspace.cjs');
const { startGuestServer } = require('./guest-server.cjs');
const { Tunnel } = require('./tunnel.cjs');
const { copyVerified } = require('./file-transfer.cjs');
const { DesktopTransfers } = require('./desktop-transfers.cjs');

const root = process.env.WORKSTATION_DATA_DIR || path.join(app.getPath('userData'), 'workspace');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(root, '.desktop'));
app.setName('Workstation');
if (process.platform === 'linux') app.setDesktopName('workstation-desktop.desktop');
const pagePath = path.join(__dirname, '..', 'ui', 'index.html');
const pageUrl = pathToFileURL(pagePath).href;
let window, workspace, guestServer, tunnel, transfers, shutdown = false, sleepBlocker;

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    workspace = new Workspace(root, { allowLocalCodes: process.env.WORKSTATION_TEST_LOCAL === '1' });
    guestServer = await startGuestServer(workspace, { onError: error => console.error('Guest request:', error.message) });
    const binary = process.env.WORKSTATION_RELAY_BINARY || (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'cloudflared') : path.join(__dirname, '..', 'bin', 'cloudflared'));
    tunnel = new Tunnel({ binary, localUrl: guestServer.localUrl, probeId: guestServer.probeId, root, onState(status, url, error) {
      if (shutdown) return;
      if (status === 'error') { workspace.stopSharing(); guestServer.setPublicUrl(''); }
      if (url) guestServer.setPublicUrl(url);
      workspace.setSharing(status, url, error);
      if (status === 'online' && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
      if (status !== 'online' && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
    } });

    window = new BrowserWindow({
      width: 1380, height: 900, minWidth: 1000, minHeight: 680,
      title: 'Workstation', backgroundColor: '#f6f7f9',
      icon: path.join(__dirname, '..', 'ui', 'icon.png'), show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true,
        spellcheck: true, devTools: !app.isPackaged
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    transfers = new DesktopTransfers(window, powerSaveBlocker);
    workspace.on('change', () => { if (window && !window.isDestroyed()) window.webContents.send('workstation:changed'); });
    ipcMain.handle('workstation:action', async (event, action, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
        return { ok: false, error: 'This action is only available in the desktop app.' };
      }
      try {
        let result;
        switch (action) {
          case 'state': result = { ...workspace.snapshot(), transfer: transfers.progress }; break;
          case 'cancelTransfer': transfers.cancel(); result = true; break;
          case 'startSharing':
            if (process.env.WORKSTATION_TEST_LOCAL === '1') {
              workspace.setSharing('online', guestServer.localUrl);
              result = guestServer.localUrl;
            } else result = await tunnel.start();
            break;
          case 'stopSharing':
            workspace.stopSharing(); tunnel.stop(); guestServer.setPublicUrl('');
            if (sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
            result = true; break;
          case 'createInvite': result = workspace.createInvite(); break;
          case 'cancelInvite': workspace.cancelInvite(input?.id); result = true; break;
          case 'removeGuest': workspace.revoke(input?.id); result = true; break;
          case 'sendMessage': result = workspace.chat(null, input?.text); break;
          case 'settings': workspace.updateSettings(input || {}); result = true; break;
          case 'copyInvite': {
            const invite = workspace.snapshot().invites.find(i => i.id === input?.id && i.status === 'pending');
            if (!invite) throw new Error('This invitation is no longer available.');
            clipboard.writeText(invite.code); result = true; break;
          }
          case 'saveGuestApp': {
            const filename = 'Workstation-Guest-Windows-x64.zip';
            const source = app.isPackaged ? path.join(process.resourcesPath, 'downloads', filename) : path.join(__dirname, '..', 'dist', filename);
            if (!fs.existsSync(source)) throw new Error('The Windows guest download is missing. Build the Windows guest app first.');
            const selected = await dialog.showSaveDialog(window, { title: 'Save the Windows guest app to send to your guest', defaultPath: path.join(app.getPath('downloads'), filename), buttonLabel: 'Save Windows app' });
            if (!selected.canceled && selected.filePath && path.resolve(selected.filePath) !== path.resolve(source)) await fs.promises.copyFile(source, selected.filePath);
            result = !selected.canceled; break;
          }
          case 'importFiles':
          case 'importFolder': {
            const selected = await dialog.showOpenDialog(window, { title: action === 'importFolder' ? 'Add a folder as a ZIP file' : 'Add files to your workspace', properties: [action === 'importFolder' ? 'openDirectory' : 'openFile', 'multiSelections'] });
            result = [];
            if (!selected.canceled) await transfers.run(async options => {
              for (const filename of selected.filePaths) result.push(await workspace.importFile(filename, options));
            });
            break;
          }
          case 'importDropped': {
            if (!Array.isArray(input) || input.length > 100 || input.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Please drop up to 100 files or folders at a time.');
            result = [];
            await transfers.run(async options => {
              for (const filename of input) result.push(await workspace.importFile(filename, options));
            });
            break;
          }
          case 'saveFile': {
            const { file, location } = workspace.resolveFile(input?.id);
            const selected = await dialog.showSaveDialog(window, { title: 'Save a copy', defaultPath: file.name, buttonLabel: 'Save copy' });
            if (!selected.canceled && selected.filePath) {
              if (path.resolve(selected.filePath) === path.resolve(location)) throw new Error('Choose a location outside the workspace for your copy.');
              await transfers.run(options => copyVerified(location, selected.filePath, file, options));
            }
            result = !selected.canceled; break;
          }
          case 'removeFile': workspace.removeFile(input?.id); result = true; break;
          case 'openFolder': {
            const error = await shell.openPath(workspace.filesDir);
            if (error) throw new Error(error);
            result = true; break;
          }
          default: throw new Error('Unknown action.');
        }
        return { ok: true, data: result };
      } catch (error) { return { ok: false, error: error.message, status: error.status }; }
    });
    await window.loadFile(pagePath);
  }).catch(error => {
    dialog.showErrorBox('Workstation could not open', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdown) return;
  shutdown = true;
  event.preventDefault();
  tunnel?.stop();
  transfers?.cancel();
  try { workspace?.close(); } catch (error) { console.error(error.message); }
  if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker);
  Promise.resolve(guestServer?.close()).finally(() => app.quit());
});
