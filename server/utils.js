const crypto = require('crypto');
const path = require('path');

function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}${Date.now().toString(36)}`;
}
function now() { return Date.now(); }

function normalizeUsername(username) { return String(username || '').trim().toLowerCase(); }
function validUsername(username) { return /^[a-zA-Z0-9_]{3,24}$/.test(String(username || '').trim()); }
function sanitizeDisplayName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
function sanitizeText(text, max = 4000) { return String(text || '').replace(/\r\n/g, '\n').trim().slice(0, max); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  cookies.push(parts.join('; '));
  res.setHeader('Set-Cookie', cookies);
}
function clearCookie(res, name) { setCookie(res, name, '', { maxAge: 0 }); }

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers, 'Content-Length': buf.length });
  res.end(buf);
}
function sendJSON(res, status, data, headers = {}) { send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers }); }
function sendText(res, status, text, headers = {}) { send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }); }

function safeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f]/g, '').trim();
  return base || 'file';
}
function contentDisposition(filename, inline) {
  const safe = safeFilename(filename).replace(/"/g, '');
  const encoded = encodeURIComponent(safe);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`;
}
function isImageMime(type, name) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(String(name || ''));
}
function isAllowedAvatar(type, name) {
  const t = String(type || '').toLowerCase();
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(t)) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(String(name || ''));
}

async function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req, limitBytes = 1024 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function getForwardedFor(req) {
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return [];
  return String(xff).split(',').map(s => s.trim()).filter(Boolean);
}
function isLoopback(ip) { return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'; }
function getClientIP(req) {
  const remote = req.socket.remoteAddress || '';
  const chain = getForwardedFor(req);
  if (chain.length && isLoopback(remote)) return chain[0];
  return remote;
}

module.exports = {
  uid, now, normalizeUsername, validUsername, sanitizeDisplayName, sanitizeText,
  hashPassword, verifyPassword, parseCookies, setCookie, clearCookie,
  send, sendJSON, sendText, safeFilename, contentDisposition, isImageMime, isAllowedAvatar,
  readBody, readJSON, getClientIP
};
