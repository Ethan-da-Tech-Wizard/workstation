import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '2026.10.0';
const checksum = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This distribution is for Linux x64. Download the matching cloudflared binary for your platform.');
const bin = path.join(root, 'bin'); fs.mkdirSync(bin, { recursive: true });
const destination = path.join(bin, 'cloudflared');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
if (fs.existsSync(destination) && hash(fs.readFileSync(destination)) === checksum) {
  console.log('The verified internet sharing helper is already installed.');
} else {
  console.log(`Downloading cloudflared ${version} from Cloudflare’s official GitHub release…`);
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-amd64`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const contents = Buffer.from(await response.arrayBuffer());
  if (hash(contents) !== checksum) throw new Error('Checksum verification failed. The helper was not installed.');
  fs.writeFileSync(destination + '.tmp', contents, { mode: 0o755 });
  fs.renameSync(destination + '.tmp', destination);
  console.log('Internet sharing helper installed and checksum verified.');
}
