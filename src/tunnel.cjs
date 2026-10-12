'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class Tunnel {
  constructor({ binary, localUrl, root, probeId, onState }) {
    this.binary = binary;
    this.localUrl = localUrl;
    this.root = root;
    this.probeId = probeId;
    this.onState = onState;
    this.child = null;
    this.starting = null;
    this.generation = 0;
  }

  start() {
    if (this.starting) return this.starting;
    if (this.child && this.url) return Promise.resolve(this.url);
    if (!fs.existsSync(this.binary)) return Promise.reject(new Error('The internet sharing helper is missing. Run the setup script, then reopen Workstation.'));
    const generation = ++this.generation;
    this.onState('connecting', '', '');
    // Isolate this temporary tunnel from any unrelated cloudflared account configuration.
    const config = path.join(this.root, 'relay-config.yml');
    fs.writeFileSync(config, '# Workstation temporary tunnel\n', { mode: 0o600 });
    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      let candidate = '';
      let connected = false;
      let checking = false;
      let output = '';
      const child = spawn(this.binary, [
        'tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2',
        '--url', this.localUrl, '--loglevel', 'info'
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (generation === this.generation) this.starting = null;
        if (error) reject(error); else resolve(candidate);
      };
      const timer = setTimeout(() => {
        if (generation !== this.generation) return;
        finish(new Error('The public address is not available yet. Check your connection and try again.'));
        this.stop();
        this.onState('error', '', 'The public address could not be reached. Check your internet connection and try again.');
      }, 150_000);
      const checkPublicAddress = async () => {
        if (checking) return;
        checking = true;
        // Allow this hostname at the origin while DNS and the relay finish becoming ready.
        this.onState('connecting', candidate, '');
        while (generation === this.generation && !settled) {
          try {
            const response = await fetch(candidate + '/', { signal: AbortSignal.timeout(5000), redirect: 'error' });
            const ready = response.ok && response.headers.get('x-workstation-server') === this.probeId;
            await response.body?.cancel();
            if (ready && generation === this.generation && !settled) {
              this.url = candidate;
              this.onState('online', candidate, '');
              finish();
              return;
            }
          } catch { /* Temporary hostnames may need a little time to resolve. */ }
          if (generation === this.generation && !settled) await new Promise(resolve => setTimeout(resolve, 2000));
        }
      };
      const handle = bytes => {
        output = (output + bytes.toString()).slice(-16_000);
        candidate ||= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] || '';
        connected ||= /Registered tunnel connection/.test(output);
        if (generation === this.generation && candidate && connected && !settled) {
          void checkPublicAddress();
        }
      };
      child.stdout.on('data', handle);
      child.stderr.on('data', handle);
      child.once('error', error => {
        finish(new Error('The internet sharing helper could not start: ' + error.message));
        if (generation === this.generation) { this.child = null; this.url = ''; this.onState('error', '', 'Could not start the sharing helper.'); }
      });
      child.once('exit', () => {
        finish(new Error('The sharing connection closed. Check your internet connection and try again.'));
        if (generation === this.generation) {
          this.child = null; this.url = '';
          this.onState('error', '', 'The sharing connection stopped. Turn sharing on again to reconnect.');
        }
      });
    });
    return this.starting;
  }

  stop() {
    this.generation++;
    const child = this.child;
    this.child = null; this.url = ''; this.starting = null;
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2500);
      timer.unref();
    }
  }
}

module.exports = { Tunnel };
