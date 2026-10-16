const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');

const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL = 60 * 60 * 1000;
const MAX_FILE = 100 * 1024 * 1024;
const MAX_ROOM = 500 * 1024 * 1024;
const MAX_FILES = 20;
const RATE_WINDOW = 15 * 60 * 1000;
const MAX_ROOM_CREATES = 10;
const MAX_BAD_CODES = 5;
const MAX_UPLOADS = 20;
const DATA_DIR = path.join(os.tmpdir(), 'pocketdrop-transfers');
const rooms = new Map();
const createAttempts = new Map();
const badCodeAttempts = new Map();
const uploadAttempts = new Map();

// Room metadata only lives in memory, so files left by a previous server run
// can no longer be accessed. Remove that stale temporary data on startup.
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function roomCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  } while (rooms.has(code));
  return code;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowRequest(map, key, limit) {
  const now = Date.now();
  if (map.size > 1000) {
    for (const [oldKey, times] of map) {
      if (!times.some(time => now - time < RATE_WINDOW)) map.delete(oldKey);
    }
  }
  const recent = (map.get(key) || []).filter(time => now - time < RATE_WINDOW);
  if (recent.length >= limit) { map.set(key, recent); return false; }
  recent.push(now);
  map.set(key, recent);
  return true;
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function securityHeaders(res, req) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

function cleanName(name) {
  const parts = String(name || 'file').replace(/\\/g, '/').split('/');
  const clean = parts.filter(part => part && part !== '.' && part !== '..').map(part => part.replace(/[\0]/g, '_').trim()).filter(Boolean);
  return (clean.join('/') || 'file').slice(0, 240);
}

function validCode(value) {
  return /^\d{4}$/.test(value || '');
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  clearTimeout(room.timer);
  fs.rm(path.join(DATA_DIR, code), { recursive: true, force: true }, () => {});
}

function createRoom() {
  if (rooms.size >= 9000) throw new Error('Too many active rooms. Try again later.');
  const code = roomCode();
  const room = { files: [], bytes: 0, pendingBytes: 0, pendingFiles: 0, key: crypto.randomBytes(32), expiresAt: Date.now() + ROOM_TTL };
  room.timer = setTimeout(() => destroyRoom(code), ROOM_TTL);
  room.timer.unref();
  rooms.set(code, room);
  fs.mkdirSync(path.join(DATA_DIR, code), { recursive: true });
  return code;
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const server = http.createServer((req, res) => {
  securityHeaders(res, req);
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-site requests are not allowed.' });
    if (!allowRequest(createAttempts, clientIp(req), MAX_ROOM_CREATES)) return json(res, 429, { error: 'Too many rooms created from this connection. Try again later.' });
    try {
      const code = createRoom();
      return json(res, 201, { code, expiresIn: ROOM_TTL / 1000 });
    } catch (error) {
      return json(res, 503, { error: error.message });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && validCode(parts[2])) {
    const code = parts[2];
    const room = rooms.get(code);
    if (!room) {
      if (req.method === 'GET' && parts.length === 3) {
        const ip = clientIp(req);
        if (!allowRequest(badCodeAttempts, ip, MAX_BAD_CODES)) return json(res, 429, { error: 'Too many incorrect room codes. Try again later.' });
      }
      return json(res, 404, { error: 'That room is unavailable or has expired. Create a new room.' });
    }

    if (req.method === 'GET' && parts.length === 3) {
      return json(res, 200, { files: room.files.map(({ id, name, size, kind, uploadedAt }) => ({ id, name, size, kind, uploadedAt })), expiresAt: room.expiresAt });
    }

    if (req.method === 'POST' && parts[3] === 'files' && parts.length === 4) {
      if (!sameOrigin(req)) { req.resume(); return json(res, 403, { error: 'Cross-site requests are not allowed.' }); }
      if (!allowRequest(uploadAttempts, clientIp(req), MAX_UPLOADS)) { req.resume(); return json(res, 429, { error: 'Too many uploads from this connection. Try again later.' }); }
      const name = cleanName(url.searchParams.get('name'));
      const kind = url.searchParams.get('kind') === 'text' ? 'text' : 'file';
      const declaredSize = Number(req.headers['content-length'] || 0);
      if (declaredSize > MAX_FILE) { req.resume(); return json(res, 413, { error: 'Files must be 100 MB or smaller.' }); }
      if (room.files.length + room.pendingFiles >= MAX_FILES) { req.resume(); return json(res, 413, { error: 'This room has reached its 20-file limit.' }); }
      if (room.bytes + room.pendingBytes + declaredSize > MAX_ROOM) { req.resume(); return json(res, 413, { error: 'This room has reached its 500 MB total limit.' }); }

      const id = crypto.randomUUID();
      const target = path.join(DATA_DIR, code, id);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', room.key, iv);
      let received = 0;
      room.pendingBytes += declaredSize;
      room.pendingFiles += 1;
      const sink = fs.createWriteStream(target, { flags: 'wx' });
      req.on('data', chunk => {
        received += chunk.length;
        if (received > declaredSize || received > MAX_FILE) req.destroy(new Error('Transfer limit exceeded'));
      });
      pipeline(req, cipher, sink, error => {
        room.pendingBytes -= declaredSize;
        room.pendingFiles -= 1;
        if (error) {
          fs.rm(target, { force: true }, () => {});
          if (!res.headersSent && !res.destroyed) json(res, 413, { error: 'Upload exceeded the room limit or was interrupted.' });
          return;
        }
        if (received !== declaredSize) {
          fs.rm(target, { force: true }, () => {});
          return json(res, 400, { error: 'Upload size did not match the request.' });
        }
        room.files.push({ id, name, size: received, kind, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), uploadedAt: Date.now() });
        room.bytes += received;
        json(res, 201, { id, name, size: received });
      });
      return;
    }

    if (req.method === 'GET' && parts[3] === 'files' && parts[4] && parts.length === 5) {
      const file = room.files.find(item => item.id === parts[4]);
      if (!file) return json(res, 404, { error: 'File not found.' });
      const decipher = crypto.createDecipheriv('aes-256-gcm', room.key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.size,
        'content-disposition': contentDisposition(file.name),
        'cache-control': 'no-store',
      });
      return pipeline(fs.createReadStream(path.join(DATA_DIR, code, file.id)), decipher, res, error => {
        if (error && !res.destroyed) res.destroy(error);
      });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  json(res, 404, { error: 'Not found.' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`PocketDrop is ready on port ${PORT}`));
