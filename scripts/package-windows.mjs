import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { extract } from '@electron-internal/extract-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'));
const filename = `electron-v${runtime.version}-win32-x64.zip`;
const archive = process.argv[2] || path.join(root, 'bin', filename);
const checksums = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/checksums.json'), 'utf8'));
if (!fs.existsSync(archive)) {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  console.log('Downloading the official Windows desktop runtime…');
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${runtime.version}/${filename}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== checksums[filename]) throw new Error('Windows runtime checksum did not match the official Electron release.');
const folder = path.join(root, 'dist', 'Workstation Guest');
fs.mkdirSync(folder, { recursive: true });
await extract(archive, { dir: folder });
fs.renameSync(path.join(folder, 'electron.exe'), path.join(folder, 'Workstation.exe'));
fs.rmSync(path.join(folder, 'resources/default_app.asar'), { force: true });
const appDir = path.join(folder, 'resources/app');
fs.mkdirSync(appDir, { recursive: true });
for (const dir of ['src', 'ui']) fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true });
for (const dependency of ['yazl', 'buffer-crc32']) fs.cpSync(path.join(root, 'node_modules', dependency), path.join(appDir, 'node_modules', dependency), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'workstation-guest', productName: 'Workstation Guest', version: pkg.version, main: 'src/guest-main.cjs', private: true }));
// The Windows download contains the client only: no host listener, relay, or owner controls.
for (const filename of ['main.cjs', 'guest-server.cjs', 'tunnel.cjs']) fs.rmSync(path.join(appDir, 'src', filename), { force: true });
fs.writeFileSync(path.join(folder, 'START HERE.txt'), [
  'WORKSTATION GUEST', '',
  '1. Extract the entire ZIP file (right-click it and choose Extract All).',
  '2. Open Workstation.exe inside the extracted Workstation Guest folder.',
  '3. Paste the workstation code your host sent you, enter your name, and click Join workstation.',
  '',
  'The app connects to the host\'s running desktop app. Use Add files and the save buttons to exchange files, and Conversation to chat.',
  'The invitation code can be claimed once. Your files stay with the host after you leave.',
  'The host must keep their computer online and Workstation open.',
  '',
  'Keep all files in this folder together; Workstation.exe needs its included runtime files.',
  'This build is unsigned. Windows may display an unknown-publisher warning.',
  ''
].join('\r\n'));
const destination = path.join(root, 'dist', 'Workstation-Guest-Windows-x64.zip');
const temporary = destination + '.building.zip';
fs.rmSync(temporary, { force: true });
console.log('Packaging the Windows guest download…');
const zip = new yazl.ZipFile();
function addDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) addDirectory(filename);
    else if (entry.isFile()) zip.addFile(filename, path.relative(path.join(root, 'dist'), filename).split(path.sep).join('/'));
  }
}
addDirectory(folder);
const writing = pipeline(zip.outputStream, fs.createWriteStream(temporary));
zip.on('error', error => zip.outputStream.destroy(error));
zip.end();
await writing;
fs.renameSync(temporary, destination);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
fs.writeFileSync(destination + '.sha256', `${sha256}  ${path.basename(destination)}\n`);
console.log('Windows download: ' + destination);
console.log('SHA-256: ' + sha256);
