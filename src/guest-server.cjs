'use strict';

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { AppError, CHUNK_SIZE } = require('./workspace.cjs');

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

function json(res, status, value, headers = {}) {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(value));
  }
}

async function body(req, limit) {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new AppError(413, 'The request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJSON(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'Send JSON for this request.');
  try {
    const value = JSON.parse((await body(req, 12_000)).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'The request could not be read.');
  }
}

async function startGuestServer(workspace, options = {}) {
  const allowedOrigins = new Set();
  const probeId = crypto.randomBytes(16).toString('hex');
  const rateLimits = new Map();
  let closed = false;

  function rate(key, maximum, windowMs = 60_000) {
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now > entry.until) { entry = { count: 0, until: now + windowMs }; rateLimits.set(key, entry); }
    if (++entry.count > maximum) throw new AppError(429, 'Please wait a moment before trying again.');
    if (rateLimits.size > 2000) for (const [k, value] of rateLimits) if (value.until < now) rateLimits.delete(k);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Workstation-Server', probeId);
    let untrack = () => {};
    try {
      if (closed) throw new AppError(503, 'The workspace has closed.');
      const host = req.headers.host;
      const origin = [...allowedOrigins].find(o => new URL(o).host === host);
      if (!origin) throw new AppError(421, 'Unknown workspace address.');
      const secure = origin.startsWith('https:');
      if (secure) res.setHeader('Strict-Transport-Security', 'max-age=86400');
      const url = new URL(req.url, origin);
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new AppError(403, 'Join using the Workstation desktop app.');
      if (url.pathname === '/' && req.method === 'GET') {
        json(res, 200, { app: 'Workstation', protocol: 1, message: 'Enter your invitation code in the Workstation desktop app.' });
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new AppError(404, 'Use the Workstation desktop app.');
      if (req.headers['x-workstation-protocol'] !== '1') throw new AppError(403, 'Use an up-to-date Workstation desktop app.');
      if (url.pathname === '/api/join' && req.method === 'POST') {
        rate('join:global', 120);
        rate('join:' + (req.headers['cf-connecting-ip'] || req.socket.remoteAddress), 30);
        const input = await readJSON(req);
        const { secret, session } = workspace.join(input.token, input.name);
        json(res, 200, { session: secret, state: workspace.snapshot(session) });
        return;
      }
      const session = workspace.authenticate(req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]);
      if (url.pathname === '/api/state' && req.method === 'GET') {
        json(res, 200, workspace.snapshot(session)); return;
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        rate('chat:' + session.id, 45);
        const input = await readJSON(req);
        json(res, 201, workspace.chat(session, input.text)); return;
      }
      if (url.pathname === '/api/leave' && req.method === 'POST') {
        workspace.revoke(session.id, 'left');
        json(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        rate('uploads:' + session.id, 120);
        const input = await readJSON(req);
        json(res, 201, workspace.beginUpload(session, input.name, input.size)); return;
      }
      const chunkRoute = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/);
      if (chunkRoute && req.method === 'PUT') {
        const upload = workspace.getUpload(session, chunkRoute[1]);
        if (upload.busy) throw new AppError(409, 'A chunk is already being uploaded.');
        if (Number(chunkRoute[2]) !== upload.offset) throw new AppError(409, 'Upload offset changed.');
        upload.busy = true;
        untrack = workspace.trackTransfer(session.id, () => { req.destroy(); res.destroy(); });
        try { json(res, 200, workspace.appendChunk(session, upload.id, Number(chunkRoute[2]), await body(req, CHUNK_SIZE))); }
        finally { upload.busy = false; }
        return;
      }
      const finishRoute = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/complete$/);
      if (finishRoute && req.method === 'POST') {
        const upload = workspace.getUpload(session, finishRoute[1]);
        if (upload.busy || upload.offset !== upload.size) throw new AppError(409, 'The file is still uploading.');
        upload.busy = true;
        try {
          const handle = await fs.promises.open(upload.path, 'r+');
          try { await handle.sync(); } finally { await handle.close(); }
        } finally { upload.busy = false; }
        json(res, 201, workspace.finishUpload(session, finishRoute[1])); return;
      }
      const uploadRoute = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/);
      if (uploadRoute && req.method === 'DELETE') {
        workspace.getUpload(session, uploadRoute[1]);
        workspace.cancelUpload(uploadRoute[1]); json(res, 200, { ok: true }); return;
      }
      const downloadRoute = url.pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/download$/);
      if (downloadRoute && req.method === 'GET') {
        const { file, location, size } = workspace.resolveFile(downloadRoute[1]);
        const etag = '"' + file.sha256 + '"';
        if (req.headers['if-match'] && req.headers['if-match'] !== etag) throw new AppError(412, 'The shared file changed. Start a new download.');
        let start = 0, end = size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (match) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
          if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
            res.setHeader('Content-Range', `bytes */${size}`);
            throw new AppError(416, 'The requested download range is unavailable.');
          }
        }
        const input = fs.createReadStream(location, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, ...(size ? { start, end } : {}) });
        untrack = workspace.trackTransfer(session.id, () => { input.destroy(); res.destroy(); });
        // Even HTML, SVG, and executables are attachments, never pages on the workspace origin.
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1),
          'Accept-Ranges': 'bytes', ETag: etag,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
          'Content-Disposition': `attachment; filename="${file.name.replace(/[^a-zA-Z0-9 ._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
          'Content-Security-Policy': "default-src 'none'; sandbox"
        });
        await pipeline(input, res);
        return;
      }
      throw new AppError(404, 'Action not found.');
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (error.code === 'ENOSPC') json(res, 507, { error: 'The host drive ran out of free disk space. Ask the host to make room, then try again.' });
      else json(res, error.status || 500, { error: error.status ? error.message : 'The workspace could not complete that action. Please try again.' });
      if (!error.status && error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && error.code !== 'ECONNRESET') options.onError?.(error);
    } finally { untrack(); }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 60;
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  const localUrl = `http://127.0.0.1:${server.address().port}`;
  allowedOrigins.add(localUrl);
  return {
    server, localUrl, probeId,
    setPublicUrl(url) {
      for (const value of allowedOrigins) if (value !== localUrl) allowedOrigins.delete(value);
      if (url) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('An HTTPS origin is required.');
        allowedOrigins.add(parsed.origin);
      }
    },
    async close() {
      closed = true;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

module.exports = { startGuestServer };
