'use strict';

const crypto = require('node:crypto');

function codeError() { return Object.assign(new Error('That code could not be read. Copy the complete invitation code from your host.'), { status: 400 }); }
function checksum(data) { return crypto.createHash('sha256').update(data).digest().subarray(0, 5); }

function validOrigin(origin, allowLocal = false) {
  if (typeof origin !== 'string') return false;
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(origin) ||
    (allowLocal && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) && Number(origin.split(':').pop()) < 65536);
}

function encodeInviteCode(origin, token, { allowLocal = false } = {}) {
  if (!validOrigin(origin, allowLocal) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw codeError();
  const local = origin.startsWith('http:');
  const address = local ? origin.split(':').pop() : new URL(origin).hostname.replace('.trycloudflare.com', '');
  const name = Buffer.from(address, 'ascii');
  const data = Buffer.concat([Buffer.from([name.length]), name, Buffer.from(token, 'base64url')]);
  return (local ? 'WST-' : 'WS1-') + Buffer.concat([data, checksum(data)]).toString('base64url');
}

function decodeInviteCode(value, { allowLocal = false } = {}) {
  if (typeof value !== 'string' || value.length > 512) throw codeError();
  const code = value.replace(/\s/g, '');
  const match = code.match(/^(WS1|WST)-([A-Za-z0-9_-]{52,150})$/);
  if (!match || (match[1] === 'WST' && !allowLocal)) throw codeError();
  const packet = Buffer.from(match[2], 'base64url');
  if (packet.toString('base64url') !== match[2] || packet.length !== 1 + packet[0] + 32 + 5) throw codeError();
  const data = packet.subarray(0, -5);
  if (!crypto.timingSafeEqual(packet.subarray(-5), checksum(data))) throw codeError();
  const address = data.subarray(1, 1 + data[0]).toString('ascii');
  const origin = match[1] === 'WST' ? `http://127.0.0.1:${address}` : `https://${address}.trycloudflare.com`;
  if (!validOrigin(origin, allowLocal)) throw codeError();
  return { origin, token: data.subarray(1 + data[0]).toString('base64url') };
}

module.exports = { encodeInviteCode, decodeInviteCode, validOrigin };
