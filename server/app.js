import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb } from './db.js';
import { createGame, GameError, normalizeCode, isRoomCode } from './game.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_MAX_AGE = 60 * 60 * 48;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function createApp({ dbFile = ':memory:', publicUrl = process.env.PUBLIC_URL || '', trustProxy = process.env.TRUST_PROXY === '1', log = true, rateLimits = true } = {}) {
  const db = openDb(dbFile);
  const subscribers = new Map(); // room code -> Set<res>
  const game = createGame(db, { onChange: notify });
  const buckets = new Map();

  function notify(code) {
    const subs = subscribers.get(code);
    if (!subs) return;
    const v = game.versionOf(code);
    for (const res of subs) res.write(`data: ${v ?? 0}\n\n`);
  }

  function rateLimit(req, key, limit, windowMs) {
    if (!rateLimits) return;
    const ip = clientIp(req);
    const k = `${key}:${ip}`;
    const t = Date.now();
    let b = buckets.get(k);
    if (!b || t - b.start > windowMs) { b = { start: t, n: 0 }; buckets.set(k, b); }
    b.n += 1;
    if (b.n > limit) throw new GameError(429, 'slow_down', 'Too many attempts. Wait a minute and try again.');
  }

  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const isHttps = (req) => req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function origin(req) {
    if (publicUrl) return publicUrl.replace(/\/$/, '');
    const host = String(req.headers.host || 'localhost');
    const proto = isHttps(req) ? 'https' : 'http';
    const [hostname, port] = host.split(':');
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      const lan = lanAddresses()[0];
      if (lan) return `${proto}://${lan}${port ? `:${port}` : ''}`;
    }
    return `${proto}://${host}`;
  }

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      // Another site on the same host can set a cookie with bad %-encoding; skip it instead of failing the request.
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
    return out;
  }
  const playerCookie = (code) => `rrp_${code}`;
  const hostCookie = (code) => `rrh_${code}`;
  function setCookie(req, res, name, value) {
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_MAX_AGE}`];
    if (isHttps(req)) parts.push('Secure');
    const prev = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [...prev, parts.join('; ')]);
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    // Custom header + JSON content type: cross-site forms cannot send these without a CORS preflight we never approve.
    if (req.headers['x-rr'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new GameError(403, 'bad_origin', 'Request blocked.');
    }
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 8 * 1024) throw new GameError(413, 'too_large', 'Request too large.');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new GameError(400, 'bad_json', 'Invalid request.'); }
  }

  function sessionFor(req, code) {
    const cookies = parseCookies(req);
    return game.viewerFor(code, { hostToken: cookies[hostCookie(code)], playerToken: cookies[playerCookie(code)] });
  }

  function serveStatic(req, res, pathname) {
    const spa = pathname === '/' || /^\/(join|room|host|display)\/[A-Za-z]{4}\/?$/.test(pathname) || pathname === '/rules';
    const rel = spa ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function openEvents(req, res, code, session) {
    if (!session.isHost && !session.player) return send(res, 401, { error: 'Join the game first.' });
    let subs = subscribers.get(code);
    if (!subs) { subs = new Set(); subscribers.set(code, subs); }
    if (subs.size > 250) return send(res, 503, { error: 'Too many connections.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', ...SECURITY_HEADERS,
    });
    // The stream only ever carries a version number; each client then fetches its own authorized view.
    res.write(`retry: 3000\ndata: ${game.versionOf(code) ?? 0}\n\n`);
    subs.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      subs.delete(res);
      if (!subs.size) subscribers.delete(code);
    });
  }

  async function handleApi(req, res, parts) {
    // parts: ['api', 'rooms', CODE?, sub?, sub2?]
    if (parts[1] !== 'rooms') throw new GameError(404, 'not_found', 'Not found.');
    if (parts.length === 2) {
      if (req.method !== 'POST') throw new GameError(405, 'method', 'Method not allowed.');
      await readJson(req);
      rateLimit(req, 'create', 30, 60 * 60 * 1000);
      const { code, hostToken } = game.createRoom();
      setCookie(req, res, hostCookie(code), hostToken);
      return send(res, 201, { code });
    }
    const code = normalizeCode(parts[2]);
    if (!isRoomCode(code)) throw new GameError(404, 'no_room', 'No game with that room code.');
    const sub = parts.slice(3).join('/');

    if (req.method === 'GET') {
      if (sub === 'state' || sub === 'host/state') {
        rateLimit(req, 'state', 600, 60 * 1000);
        const session = sessionFor(req, code);
        if (!session.room) throw new GameError(404, 'no_room', 'No game with that room code.');
        const state = game.stateFor(code, session, sub === 'host/state' ? 'host' : 'player');
        if (state.viewer === 'host') {
          const base = origin(req);
          state.host.joinUrl = `${base}/join/${code}`;
          state.host.hostUrl = `${base}/host/${code}#key=${state.host.hostKey}`;
          delete state.host.hostKey;
        }
        return send(res, 200, state);
      }
      if (sub === 'events') {
        const session = sessionFor(req, code);
        if (!session.room) throw new GameError(404, 'no_room', 'No game with that room code.');
        return openEvents(req, res, code, session);
      }
      if (sub === 'qr.svg') {
        if (!sessionFor(req, code).room) throw new GameError(404, 'no_room', 'No game with that room code.');
        const svg = await QRCode.toString(`${origin(req)}/join/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#25382F', light: '#FBF6EA' } });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(svg);
      }
      throw new GameError(404, 'not_found', 'Not found.');
    }

    if (req.method !== 'POST') throw new GameError(405, 'method', 'Method not allowed.');
    const body = await readJson(req);
    if (sub === 'join') {
      rateLimit(req, 'join', 40, 60 * 1000);
      const out = game.join(code, body.name);
      setCookie(req, res, playerCookie(code), out.playerToken);
      return send(res, 201, { ok: true, spectator: out.spectator });
    }
    if (sub === 'reclaim') {
      rateLimit(req, 'reclaim', 10, 60 * 1000);
      const out = game.reclaim(code, body.claimCode);
      setCookie(req, res, playerCookie(code), out.playerToken);
      return send(res, 200, { ok: true });
    }
    if (sub === 'host/claim') {
      rateLimit(req, 'hostclaim', 10, 60 * 1000);
      const out = game.claimHost(code, body.key);
      setCookie(req, res, hostCookie(code), out.hostToken);
      return send(res, 200, { ok: true });
    }
    if (sub === 'action') {
      rateLimit(req, 'action', 240, 60 * 1000);
      const session = sessionFor(req, code);
      if (!session.room) throw new GameError(404, 'no_room', 'No game with that room code.');
      return send(res, 200, game.playerAction(code, session.player, body));
    }
    if (sub === 'host/action') {
      const session = sessionFor(req, code);
      if (!session.room) throw new GameError(404, 'no_room', 'No game with that room code.');
      return send(res, 200, game.hostAction(code, session.isHost, body));
    }
    throw new GameError(404, 'not_found', 'Not found.');
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
      // Log only method, path and status: never bodies, cookies or game data.
      if (log && pathname.startsWith('/api') && !pathname.endsWith('/events')) {
        res.on('finish', () => console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
      }
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') await handleApi(req, res, parts);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
      else send(res, 405, { error: 'Method not allowed.' });
    } catch (err) {
      if (err instanceof GameError) {
        send(res, err.status, { error: err.message, code: err.code, ...err.extra });
      } else {
        console.error('Unexpected error', err?.stack || err);
        send(res, 500, { error: 'Something went wrong on the server. Try again.' });
      }
    }
  });

  const sweep = setInterval(() => {
    game.cleanup();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, b] of buckets) if (b.start < cutoff) buckets.delete(k);
  }, 60 * 60 * 1000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); db.close(); });

  return { server, game, db, lanAddresses };
}
