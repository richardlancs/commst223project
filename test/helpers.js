import crypto from 'node:crypto';
import { createApp } from '../server/app.js';

export const rid = () => crypto.randomBytes(12).toString('hex');

export async function startServer(opts = {}) {
  const app = createApp({ log: false, rateLimits: false, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    close: () => new Promise((r) => { app.server.closeAllConnections(); app.server.close(r); }),
  };
}

// A minimal "phone": its own cookie jar, talks to the real HTTP API.
export class Client {
  constructor(base, name) { this.base = base; this.name = name; this.cookies = new Map(); }
  async req(method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) { h['content-type'] = 'application/json'; if (csrf) h['x-rr'] = '1'; }
    const res = await fetch(this.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(path) { return this.req('GET', path); }
  post(path, body = {}, opts) { return this.req('POST', path, body, opts); }
  state(code) { return this.get(`/api/rooms/${code}/state`); }
  hostState(code) { return this.get(`/api/rooms/${code}/host/state`); }
  act(code, type, payload = {}, requestId = rid()) { return this.post(`/api/rooms/${code}/action`, { type, requestId, ...payload }); }
  hostAct(code, type, payload = {}, requestId = rid()) { return this.post(`/api/rooms/${code}/host/action`, { type, requestId, ...payload }); }
}

export async function newRoom(base) {
  const host = new Client(base, 'host');
  const r = await host.post('/api/rooms', {});
  if (r.status !== 201) throw new Error(`create failed ${r.status}`);
  return { host, code: r.body.code };
}

export async function joinPlayers(base, code, n, prefix = 'P') {
  const players = [];
  for (let i = 1; i <= n; i++) {
    const c = new Client(base, `${prefix}${i}`);
    const r = await c.post(`/api/rooms/${code}/join`, { name: `${prefix}${i}` });
    if (r.status !== 201) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
    players.push(c);
  }
  return players;
}

export async function advance(host, code, confirm = false) {
  const s = await host.hostState(code);
  return host.hostAct(code, 'advance', { from: s.body.phase, confirm });
}

// Builds a room with roles assigned and returns players keyed by their employer label.
export async function setupGame(base, n) {
  const { host, code } = await newRoom(base);
  const players = await joinPlayers(base, code, n);
  const r = await advance(host, code);
  if (r.status !== 200) throw new Error(`assign failed ${JSON.stringify(r.body)}`);
  const byLabel = {};
  for (const p of players) {
    const s = await p.state(code);
    p.label = s.body.me.label;
    byLabel[p.label] = p;
  }
  const hs = (await host.hostState(code)).body;
  return { host, code, players, byLabel, hostState: hs, H: hs.setup.hires, labels: Object.keys(byLabel).sort((a, b) => a.length - b.length || a.localeCompare(b)) };
}

export const bankOf = (hostState) => hostState.host.bank;
export const groupOf = (g, label) => g.hostState.host.bank.filter((c) => c.group === label);
export const notGroupOf = (g, label) => g.hostState.host.bank.filter((c) => c.group !== label);
