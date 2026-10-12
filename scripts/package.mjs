import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules/electron/dist');
const target = path.join(root, 'dist/Workstation');
if (!fs.existsSync(path.join(electron, 'electron'))) throw new Error('Install Electron first: npx install-electron');
if (!fs.existsSync(path.join(root, 'bin/cloudflared'))) throw new Error('Install the sharing helper first: npm run relay:install');
if (!fs.existsSync(path.join(root, 'ui/icon.png'))) throw new Error('Run npm run test:browser to generate the application icon and verify the UI.');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(electron, target, { recursive: true });
fs.renameSync(path.join(target, 'electron'), path.join(target, 'workstation-bin'));
fs.rmSync(path.join(target, 'resources/default_app.asar'), { force: true });
const appDir = path.join(target, 'resources/app');
fs.mkdirSync(appDir, { recursive: true });
for (const directory of ['src', 'ui']) fs.cpSync(path.join(root, directory), path.join(appDir, directory), { recursive: true });
for (const dependency of ['yazl', 'buffer-crc32']) fs.cpSync(path.join(root, 'node_modules', dependency), path.join(appDir, 'node_modules', dependency), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'Workstation', version: pkg.version, main: pkg.main, private: true, description: pkg.description }));
fs.mkdirSync(path.join(target, 'resources/bin'), { recursive: true });
fs.copyFileSync(path.join(root, 'bin/cloudflared'), path.join(target, 'resources/bin/cloudflared'));
fs.chmodSync(path.join(target, 'resources/bin/cloudflared'), 0o755);
const guestDownload = path.join(root, 'dist/Workstation-Guest-Windows-x64.zip');
if (!fs.existsSync(guestDownload)) throw new Error('Build the Windows guest download first: npm run build:windows');
fs.mkdirSync(path.join(target, 'resources/downloads'), { recursive: true });
fs.copyFileSync(guestDownload, path.join(target, 'resources/downloads/Workstation-Guest-Windows-x64.zip'));
fs.writeFileSync(path.join(target, 'Workstation'), [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'WORKSTATION_BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
  'export WORKSTATION_DATA_DIR="${WORKSTATION_DATA_DIR:-$WORKSTATION_BUNDLE_DIR/workspace-data}"',
  'unset ELECTRON_RUN_AS_NODE',
  'exec "$WORKSTATION_BUNDLE_DIR/workstation-bin" "$@"',
  ''
].join('\n'), { mode: 0o755 });
fs.copyFileSync(path.join(root, 'ui/icon.png'), path.join(target, 'workstation.png'));
if (fs.existsSync(path.join(root, 'README.md'))) fs.copyFileSync(path.join(root, 'README.md'), path.join(target, 'README.md'));
const desktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=Workstation
Comment=A private shared workspace for files and conversation
Exec="${path.join(root, 'Workstation')}"
Icon=${path.join(root, 'ui/icon.png')}
Terminal=false
Categories=Office;
StartupWMClass=workstation-desktop
`;
fs.writeFileSync(path.join(root, 'Workstation.desktop'), desktopEntry, { mode: 0o755 });
fs.chmodSync(path.join(root, 'Workstation'), 0o755);
if (process.argv.includes('--archive')) {
  execFileSync('tar', ['--exclude=Workstation/workspace-data', '-czf', path.join(root, 'dist/Workstation-linux-x64.tar.gz'), '-C', path.join(root, 'dist'), 'Workstation']);
}
console.log('Built desktop app: ' + path.join(target, 'Workstation'));
console.log('Open it using: ' + path.join(root, 'Workstation'));
