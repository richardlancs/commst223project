import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, newRoom, joinPlayers, advance, setupGame, groupOf, notGroupOf, rid } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const toNetworking = async (g) => assert.equal((await advance(g.host, g.code)).status, 200);
const toHiring = async (g) => { await toNetworking(g); assert.equal((await advance(g.host, g.code)).status, 200); };
const refreshHost = async (g) => { g.hostState = (await g.host.hostState(g.code)).body; return g.hostState; };

// Collect every candidate (label, score) pair a viewer received anywhere in its state.
function scorePairs(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach((x) => scorePairs(x, out));
  else if (obj && typeof obj === 'object') {
    if (typeof obj.label === 'string' && /^E\d+$/.test(obj.label)) {
      for (const k of ['score', 'knownScore']) if (obj[k] != null) out.push([obj.label, obj[k]]);
    }
    Object.values(obj).forEach((x) => scorePairs(x, out));
  }
  return out;
}

// ---------------------------------------------------------------- joining

test('room creation, join link, QR code and lobby setup (minimum 3 players)', async () => {
  const { host, code } = await newRoom(srv.base);
  assert.match(code, /^[A-Z]{4}$/);
  const hs = await host.hostState(code);
  assert.equal(hs.status, 200);
  assert.match(hs.body.host.joinUrl, new RegExp(`/join/${code}$`));
  assert.match(hs.body.host.hostUrl, new RegExp(`/host/${code}#key=`));
  const qr = await host.get(`/api/rooms/${code}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(String(qr.body), /<svg/);

  await joinPlayers(srv.base, code, 2);
  const blocked = await advance(host, code);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'need_players');

  await joinPlayers(srv.base, code, 8, 'Q');
  const s = (await host.hostState(code)).body;
  assert.deepEqual([s.setup.players, s.setup.employers, s.setup.bank, s.setup.hires, s.setup.groupSize], [10, 10, 40, 2, 4]);
  assert.equal(s.host.members.length, 10, 'the host does not occupy a player slot');
});

test('duplicate names rejected; bad names rejected; unknown room 404', async () => {
  const { code } = await newRoom(srv.base);
  const a = new Client(srv.base);
  assert.equal((await a.post(`/api/rooms/${code}/join`, { name: 'Sam' })).status, 201);
  const b = new Client(srv.base);
  assert.equal((await b.post(`/api/rooms/${code}/join`, { name: ' sam ' })).status, 409);
  assert.equal((await b.post(`/api/rooms/${code}/join`, { name: '' })).status, 400);
  assert.equal((await b.post(`/api/rooms/${code}/join`, { name: { $gt: '' } })).status, 400);
  assert.equal((await b.post('/api/rooms/ZZZZ/join', { name: 'X' })).status, 404);
});

test('attendance counts 3–30: everyone is an employer, bank scales at 4 per player', async () => {
  for (const n of [3, 4, 6, 9, 15, 27, 30]) {
    const g = await setupGame(srv.base, n);
    assert.equal(g.labels.length, n, 'every player has an employer label');
    assert.equal(g.hostState.host.bank.length, n * 4);
    for (const l of g.labels) assert.equal(groupOf(g, l).length, 4, `group ${l}`);
    assert.equal(g.H, 2);
    if (n >= 27) assert.ok(g.labels.includes('AA'), 'labels continue past Z');
    const pub = (await g.players[0].state(g.code)).body;
    assert.equal(pub.employers.length, n);
    assert.equal(pub.setup.bank, n * 4);
    assert.equal(pub.setup.hires, 2);
  }
});

test('late arrivals become observers with public information only; reset promotes them', async () => {
  const g = await setupGame(srv.base, 4);
  const late = new Client(srv.base);
  const j = await late.post(`/api/rooms/${g.code}/join`, { name: 'Late' });
  assert.equal(j.status, 201);
  assert.equal(j.body.spectator, true);
  const s = (await late.state(g.code)).body;
  assert.equal(s.viewer, 'spectator');
  assert.equal(s.employer, undefined);
  assert.deepEqual(scorePairs(s), []);
  assert.equal((await late.act(g.code, 'hire', { candidate: 'E1' })).status, 403);
  const player = g.hostState.host.members.find((m) => !m.spectator);
  assert.equal((await g.host.hostAct(g.code, 'remove', { playerId: player.id })).status, 409, 'roster locked after assignment');
  assert.equal((await g.host.hostAct(g.code, 'reset', { confirm: true })).status, 200);
  const after = (await late.state(g.code)).body;
  assert.equal(after.viewer, 'player');
  assert.equal(after.setup.players, 5);
});

// ---------------------------------------------------------------- privacy

test('private information: each employer sees only their own file plus referrals they received', async () => {
  const g = await setupGame(srv.base, 6);
  const truth = Object.fromEntries(g.hostState.host.bank.map((c) => [c.label, c.score]));
  await toNetworking(g);
  // A refers two of its candidates to B only.
  const aGroup = groupOf(g, 'A');
  for (const c of aGroup.slice(0, 2)) assert.equal((await g.byLabel.A.act(g.code, 'referral', { candidate: c.label, to: 'B' })).status, 200);

  for (const label of g.labels) {
    const s = (await g.byLabel[label].state(g.code)).body;
    const raw = JSON.stringify(s);
    assert.equal(s.host, undefined);
    assert.doesNotMatch(raw, /token|host_key|hostKey|claim|"group":"|group_of|hired_by|hiredBy/i);
    const allowed = new Set(groupOf(g, label).map((c) => c.label));
    if (label === 'B') aGroup.slice(0, 2).forEach((c) => allowed.add(c.label));
    const seen = scorePairs(s);
    for (const [l, score] of seen) {
      assert.ok(allowed.has(l), `${label} saw the score of ${l}`);
      assert.equal(score, truth[l], 'scores shown are true');
    }
    assert.equal(new Set(seen.map(([l]) => l)).size, allowed.size);
  }
  const stranger = (await new Client(srv.base).state(g.code)).body;
  assert.equal(stranger.viewer, 'none');
  assert.deepEqual(scorePairs(stranger), []);
  const page = await new Client(srv.base).get(`/room/${g.code}`);
  assert.doesNotMatch(String(page.body), /score/i);
});

test('players cannot reach host data or host actions', async () => {
  const g = await setupGame(srv.base, 3);
  const p = g.players[0];
  assert.equal((await p.hostState(g.code)).status, 403);
  assert.equal((await p.hostAct(g.code, 'advance', { from: 'reveal' })).status, 403);
  assert.equal((await p.hostAct(g.code, 'reset', { confirm: true })).status, 403);
  assert.equal((await p.hostAct(g.code, 'rejoin_code', { playerId: g.hostState.host.members[0].id })).status, 403);
  const stranger = new Client(srv.base);
  stranger.cookies.set(`rrh_${g.code}`, 'forged');
  assert.equal((await stranger.hostState(g.code)).status, 403);
  assert.equal((await stranger.post(`/api/rooms/${g.code}/host/claim`, { key: 'nope' })).status, 403);
  const key = new URL(g.hostState.host.hostUrl).hash.slice(5);
  const second = new Client(srv.base);
  assert.equal((await second.post(`/api/rooms/${g.code}/host/claim`, { key })).status, 200);
  assert.equal((await second.hostState(g.code)).status, 200);
});

test('cross-room isolation: sessions and candidate IDs do not carry between rooms', async () => {
  const g1 = await setupGame(srv.base, 3);
  const g2 = await setupGame(srv.base, 3);
  const forger = new Client(srv.base);
  forger.cookies.set(`rrp_${g2.code}`, g1.players[0].cookies.get(`rrp_${g1.code}`));
  forger.cookies.set(`rrh_${g2.code}`, g1.host.cookies.get(`rrh_${g1.code}`));
  assert.equal((await forger.state(g2.code)).body.viewer, 'none');
  assert.equal((await forger.act(g2.code, 'hire', { candidate: 'E1' })).status, 401);
  assert.equal((await forger.hostAct(g2.code, 'advance', { from: 'reveal' })).status, 403);
  assert.equal((await g1.host.hostAct(g2.code, 'reset', { confirm: true })).status, 403);
  // A room-1 employer acting on room 2 has no session there.
  assert.equal((await g1.byLabel.A.act(g2.code, 'referral', { candidate: 'E1', to: 'B' })).status, 401);
});

test('forged identities, labels and scores in request bodies are ignored', async () => {
  const g = await setupGame(srv.base, 4);
  await toNetworking(g);
  const mine = groupOf(g, 'A')[0];
  const r = await g.byLabel.A.act(g.code, 'referral', { candidate: mine.label, to: 'B', score: 10, sender: 'C', label: 'C', playerId: 'x' });
  assert.equal(r.status, 200);
  const got = (await g.byLabel.B.state(g.code)).body.employer.referralsReceived;
  assert.deepEqual(got.map((x) => [x.label, x.from, x.score]), [[mine.label, 'A', mine.score]], 'sender and score come from the backend');
  // refer a candidate outside your own file
  assert.equal((await g.byLabel.A.act(g.code, 'referral', { candidate: groupOf(g, 'C')[0].label, to: 'B' })).status, 403);
  // refer to yourself / to a label that is not an employer here
  assert.equal((await g.byLabel.A.act(g.code, 'referral', { candidate: mine.label, to: 'A' })).status, 400);
  assert.equal((await g.byLabel.A.act(g.code, 'referral', { candidate: mine.label, to: 'Z' })).status, 400);
  // missing request id; missing CSRF header
  assert.equal((await g.byLabel.A.post(`/api/rooms/${g.code}/action`, { type: 'referral', candidate: mine.label, to: 'C' })).status, 400);
  assert.equal((await g.byLabel.A.post(`/api/rooms/${g.code}/action`, { type: 'referral', requestId: rid(), candidate: mine.label, to: 'C' }, { csrf: false })).status, 403);
  // old employee-era actions no longer exist
  assert.equal((await g.byLabel.A.act(g.code, 'offer', { employee: 'E1' })).status, 400);
});

// ---------------------------------------------------------------- referrals

test('referrals: unlimited, to any other employer, truthful, no duplicates, networking only', async () => {
  const g = await setupGame(srv.base, 5);
  const A = g.byLabel.A;
  const file = groupOf(g, 'A');
  assert.equal((await A.act(g.code, 'referral', { candidate: file[0].label, to: 'B' })).status, 409, 'not during role reveal');
  await toNetworking(g);
  // every candidate in the file to every other employer: 4 × 4 = 16 referrals
  let ok = 0;
  for (const c of file) for (const to of g.labels.filter((l) => l !== 'A')) {
    const r = await A.act(g.code, 'referral', { candidate: c.label, to });
    if (r.status === 200) ok += 1;
  }
  assert.equal(ok, 16);
  const dup = await A.act(g.code, 'referral', { candidate: file[0].label, to: 'B' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'duplicate_referral');
  assert.equal((await A.state(g.code)).body.employer.referralsSent.length, 16);
  // each recipient got exactly A's four, with true scores
  for (const to of g.labels.filter((l) => l !== 'A')) {
    const got = (await g.byLabel[to].state(g.code)).body.employer.referralsReceived;
    assert.deepEqual(got.map((x) => x.label).sort(), file.map((c) => c.label).sort());
    for (const x of got) assert.equal(x.score, file.find((c) => c.label === x.label).score);
  }
  // A received nothing; host sees everything
  assert.equal((await A.state(g.code)).body.employer.referralsReceived.length, 0);
  assert.equal((await refreshHost(g)).host.referrals.length, 16);
  // referrals are optional: no warning before hiring
  assert.deepEqual(g.hostState.host.warnings, []);
  assert.equal((await advance(g.host, g.code)).status, 200);
  assert.equal((await g.byLabel.B.act(g.code, 'referral', { candidate: groupOf(g, 'B')[0].label, to: 'A' })).status, 409, 'closed during hiring');
});

// ---------------------------------------------------------------- hiring

test('hiring: instant, outside your own file, 2 positions, final, first come first served', async () => {
  const g = await setupGame(srv.base, 4);
  const A = g.byLabel.A; const B = g.byLabel.B;
  const target = groupOf(g, 'C')[0];
  await toNetworking(g);
  assert.equal((await A.act(g.code, 'hire', { candidate: target.label })).status, 409, 'not during networking');
  await advance(g.host, g.code);
  assert.equal((await A.act(g.code, 'hire', { candidate: groupOf(g, 'A')[0].label })).status, 403, 'own file');
  const first = await A.act(g.code, 'hire', { candidate: target.label });
  assert.equal(first.status, 200);
  assert.equal(first.body.candidate, target.label);
  const taken = await B.act(g.code, 'hire', { candidate: target.label });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'already_hired');
  assert.equal((await A.act(g.code, 'hire', { candidate: groupOf(g, 'D')[0].label })).status, 200);
  const third = await A.act(g.code, 'hire', { candidate: groupOf(g, 'B')[0].label });
  assert.equal(third.status, 409);
  assert.equal(third.body.code, 'no_slots');
  assert.equal((await A.act(g.code, 'unhire', { candidate: target.label })).status, 400, 'no way to undo a hire');

  const view = (await A.state(g.code)).body.employer;
  assert.equal(view.hired.length, 2);
  assert.ok(view.hired.every((h) => h.score === null), 'hire scores stay hidden without a referral');
  assert.equal(view.myTotal, undefined, 'no totals before results');
  const cand = view.candidates.find((c) => c.label === target.label);
  assert.deepEqual([cand.taken, cand.takenByMe], [true, true]);
  assert.equal((await B.state(g.code)).body.employer.candidates.find((c) => c.label === target.label).taken, true);
});

test('a referral tells the recipient the hire score before results', async () => {
  const g = await setupGame(srv.base, 3);
  await toNetworking(g);
  const c = groupOf(g, 'B')[0];
  await g.byLabel.B.act(g.code, 'referral', { candidate: c.label, to: 'A' });
  await advance(g.host, g.code);
  await g.byLabel.A.act(g.code, 'hire', { candidate: c.label });
  const v = (await g.byLabel.A.state(g.code)).body.employer;
  assert.deepEqual(v.hired.map((h) => [h.label, h.score]), [[c.label, c.score]]);
  const cand = v.candidates.find((x) => x.label === c.label);
  assert.deepEqual([cand.knownScore, cand.referredBy], [c.score, 'B']);
});

test('simultaneous hires: one winner per candidate, never more than 2 per employer', async () => {
  const g = await setupGame(srv.base, 8);
  await toHiring(g);
  const target = groupOf(g, 'A')[0];
  const rivals = g.labels.filter((l) => l !== 'A');
  const rs = await Promise.all(rivals.flatMap((l) => [g.byLabel[l].act(g.code, 'hire', { candidate: target.label }), g.byLabel[l].act(g.code, 'hire', { candidate: target.label })]));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  const winner = (await refreshHost(g)).host.bank.find((c) => c.label === target.label).hiredBy;
  assert.ok(rivals.includes(winner));
  // one employer firing at many candidates at once gets exactly its 2 (or fewer, if it already had one)
  const B = g.labels.find((l) => l !== 'A' && l !== winner);
  const pool = notGroupOf(g, B).filter((c) => c.label !== target.label).slice(0, 10);
  const burst = await Promise.all(pool.map((c) => g.byLabel[B].act(g.code, 'hire', { candidate: c.label })));
  assert.equal(burst.filter((r) => r.status === 200).length, 2);
  assert.equal((await refreshHost(g)).host.bank.filter((c) => c.hiredBy === B).length, 2);
});

test('replayed requests are not applied twice', async () => {
  const g = await setupGame(srv.base, 3);
  await toNetworking(g);
  const c = groupOf(g, 'A')[0];
  const id = rid();
  assert.equal((await g.byLabel.A.act(g.code, 'referral', { candidate: c.label, to: 'B' }, id)).status, 200);
  const again = await g.byLabel.A.act(g.code, 'referral', { candidate: c.label, to: 'B' }, id);
  assert.equal(again.body.replayed, true);
  assert.equal((await g.byLabel.A.state(g.code)).body.employer.referralsSent.length, 1);
  await advance(g.host, g.code);
  const hid = rid();
  const h1 = await g.byLabel.A.act(g.code, 'hire', { candidate: groupOf(g, 'B')[0].label }, hid);
  const h2 = await g.byLabel.A.act(g.code, 'hire', { candidate: groupOf(g, 'B')[0].label }, hid);
  assert.equal(h1.status, 200);
  assert.equal(h2.body.replayed, true);
  assert.equal((await refreshHost(g)).host.bank.filter((x) => x.hiredBy === 'A').length, 1);
  // host: a stale double-click is rejected rather than skipping a phase
  const s = await g.host.hostAct(g.code, 'advance', { from: 'networking', confirm: true });
  assert.equal(s.body.code, 'stale_phase');
});

test('a hire racing "close hiring" either lands before results or fails; never after', async () => {
  for (let round = 0; round < 5; round++) {
    const g = await setupGame(srv.base, 3);
    await toHiring(g);
    const c = groupOf(g, 'B')[0];
    const [close, hire] = await Promise.all([advance(g.host, g.code, true), g.byLabel.A.act(g.code, 'hire', { candidate: c.label })]);
    assert.equal(close.status, 200);
    const hs = await refreshHost(g);
    assert.equal(hs.phase, 'results');
    const by = hs.host.bank.find((x) => x.label === c.label).hiredBy;
    if (hire.status === 200) assert.equal(by, 'A'); else { assert.equal(hire.body.code, 'wrong_phase'); assert.equal(by, null); }
  }
  const g = await setupGame(srv.base, 3);
  await toHiring(g);
  const warn = await advance(g.host, g.code);
  assert.equal(warn.status, 409, 'unfilled positions need confirmation');
  assert.equal(warn.body.warnings.length, 3);
  assert.equal((await advance(g.host, g.code, true)).status, 200);
  const late = await g.byLabel.A.act(g.code, 'hire', { candidate: groupOf(g, 'B')[0].label });
  assert.equal(late.body.code, 'wrong_phase');
});

// ---------------------------------------------------------------- results

test('scoring: sum of hires, highest wins, ties share; private scores stay private', async () => {
  const g = await setupGame(srv.base, 4);
  const db = srv.app.db;
  const set = (label, score) => db.prepare('UPDATE candidates SET score = ? WHERE room_code = ? AND label = ?').run(score, g.code, label);
  for (const c of g.hostState.host.bank) set(c.label, 5);
  // A: 9 + 1 = 10, B: 4 + 6 = 10, C: 7, D: nothing
  const [a1, a2] = groupOf(g, 'B').slice(0, 2); set(a1.label, 9); set(a2.label, 1);
  const [b1, b2] = groupOf(g, 'C').slice(0, 2); set(b1.label, 4); set(b2.label, 6);
  const [c1] = groupOf(g, 'D'); set(c1.label, 7);
  await toHiring(g);
  for (const [who, list] of [['A', [a1, a2]], ['B', [b1, b2]], ['C', [c1]]]) {
    for (const c of list) assert.equal((await g.byLabel[who].act(g.code, 'hire', { candidate: c.label })).status, 200);
  }
  const preview = (await refreshHost(g)).host.preview;
  assert.deepEqual(preview.winners, ['A', 'B']);
  assert.equal((await g.byLabel.A.state(g.code)).body.results, undefined, 'nothing public before results');
  const warn = await advance(g.host, g.code);
  assert.ok(warn.body.warnings.some((w) => /Employer C has filled 1 of 2/.test(w)));
  assert.ok(warn.body.warnings.some((w) => /Employer D has filled 0 of 2/.test(w)));
  assert.equal((await advance(g.host, g.code, true)).status, 200);

  const pub = (await g.byLabel.D.state(g.code)).body;
  assert.deepEqual(pub.results.totals.map((t) => [t.employer, t.total, t.filled]), [['A', 10, 2], ['B', 10, 2], ['C', 7, 1], ['D', 0, 0]]);
  assert.deepEqual(pub.results.winners, ['A', 'B']);
  const a = (await g.byLabel.A.state(g.code)).body.employer;
  assert.equal(a.myTotal, 10);
  assert.deepEqual(a.hired.map((h) => h.score).sort(), [1, 9]);
  assert.equal(pub.employer.myTotal, 0);
  // D still sees only its own file's scores: no hire scores of other employers
  const seen = scorePairs(pub).map(([l]) => l);
  assert.ok(seen.every((l) => groupOf(g, 'D').some((c) => c.label === l)));
  const projector = (await new Client(srv.base).state(g.code)).body;
  assert.deepEqual(scorePairs(projector), [], 'the projector screen gets no candidate scores');
  assert.deepEqual(projector.results.winners, ['A', 'B']);
  assert.deepEqual(projector.results.totals.map((t) => t.total), [10, 10, 7, 0]);
  assert.equal((await advance(g.host, g.code)).status, 200);
  assert.equal((await advance(g.host, g.code)).status, 409, 'nothing after discussion');
});

// ---------------------------------------------------------------- sessions & plumbing

test('refresh keeps identity; a rejoin code moves an employer to a new phone', async () => {
  const g = await setupGame(srv.base, 3);
  const p = g.byLabel.B;
  const before = (await p.state(g.code)).body.me;
  const again = new Client(srv.base);
  again.cookies = new Map(p.cookies);
  assert.deepEqual((await again.state(g.code)).body.me, before);
  const member = g.hostState.host.members.find((m) => m.id === before.id);
  const code = (await g.host.hostAct(g.code, 'rejoin_code', { playerId: member.id })).body.claimCode;
  const phone = new Client(srv.base);
  assert.equal((await phone.post(`/api/rooms/${g.code}/reclaim`, { claimCode: 'AAAAAA' })).status, 403);
  assert.equal((await phone.post(`/api/rooms/${g.code}/reclaim`, { claimCode: code })).status, 200);
  assert.deepEqual((await phone.state(g.code)).body.me, before);
  assert.equal((await new Client(srv.base).post(`/api/rooms/${g.code}/reclaim`, { claimCode: code })).status, 403, 'single use');
  assert.equal((await p.state(g.code)).body.viewer, 'none', 'old phone revoked');
});

test('live updates carry only a version number and require a session', async () => {
  const g = await setupGame(srv.base, 3);
  assert.equal((await fetch(`${srv.base}/api/rooms/${g.code}/events`)).status, 401);
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/rooms/${g.code}/events`, { headers: { cookie: [...g.players[0].cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ctrl.signal });
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^retry: 3000\ndata: \d+\n\n$/);
  await advance(g.host, g.code);
  assert.match(new TextDecoder().decode((await reader.read()).value), /^data: \d+\n\n$/);
  ctrl.abort();
});

test('static pages, security headers, rate limiting and reset', async () => {
  const c = new Client(srv.base);
  for (const path of ['/', '/join/ABCD', '/room/ABCD', '/host/ABCD', '/display/ABCD', '/rules']) {
    const r = await c.get(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  }
  assert.equal((await c.get('/%2e%2e/server/game.js')).status, 404);
  const room = await newRoom(srv.base);
  const jar = [...room.host.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const badCookie = await fetch(`${srv.base}/api/rooms/${room.code}/host/state`, { headers: { cookie: `other=%E0%A4%A; ${jar}` } });
  assert.equal(badCookie.status, 200, 'a malformed unrelated cookie must not break the request');
  assert.equal((await badCookie.json()).viewer, 'host');
  const limited = await startServer({ rateLimits: true });
  try {
    const { code } = await newRoom(limited.base);
    let last;
    for (let i = 0; i < 45; i++) last = await new Client(limited.base).post(`/api/rooms/${code}/join`, { name: `N${i}` });
    assert.equal(last.status, 429);
  } finally { await limited.close(); }
  const g = await setupGame(srv.base, 3);
  await toHiring(g);
  assert.equal((await g.host.hostAct(g.code, 'reset', {})).status, 400);
  assert.equal((await g.host.hostAct(g.code, 'reset', { confirm: true })).status, 200);
  const hs = await refreshHost(g);
  assert.equal(hs.phase, 'lobby');
  assert.ok(hs.host.members.every((m) => m.label === null));
  assert.equal(hs.host.bank, undefined);
  assert.equal(srv.app.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE room_code = ?').get(g.code).n, 0);
});

test('database triggers enforce the rules even if app code is bypassed', async () => {
  const g = await setupGame(srv.base, 3);
  const db = srv.app.db;
  const id = (label) => db.prepare('SELECT id FROM candidates WHERE room_code = ? AND label = ?').get(g.code, label).id;
  const hireSql = db.prepare('UPDATE candidates SET hired_by = ? WHERE id = ?');
  const b0 = groupOf(g, 'B')[0];
  assert.throws(() => hireSql.run('A', id(b0.label)), /RR:wrong_phase/);
  await toNetworking(g);
  const refSql = db.prepare('INSERT INTO referrals (id, room_code, sender, recipient, candidate_id, score, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)');
  assert.throws(() => refSql.run('r1', g.code, 'A', 'B', id(b0.label), b0.score), /RR:not_in_group/, 'referring outside your file');
  const a0 = groupOf(g, 'A')[0];
  assert.throws(() => refSql.run('r2', g.code, 'A', 'B', id(a0.label), a0.score === 10 ? 9 : 10), /RR:not_in_group/, 'untruthful score');
  assert.throws(() => refSql.run('r3', g.code, 'A', 'ZZ', id(a0.label), a0.score), /RR:bad_recipient/);
  await advance(g.host, g.code);
  assert.throws(() => hireSql.run('A', id(a0.label)), /RR:own_group/);
  assert.throws(() => hireSql.run('Q', id(b0.label)), /RR:not_employer/);
  hireSql.run('A', id(b0.label));
  assert.throws(() => hireSql.run('C', id(b0.label)), /RR:already_hired/);
  hireSql.run('A', id(groupOf(g, 'C')[0].label));
  assert.throws(() => hireSql.run('A', id(groupOf(g, 'C')[1].label)), /RR:no_slots/);
  assert.throws(() => db.prepare("UPDATE rooms SET phase = 'discussion' WHERE code = ?").run(g.code), /RR:bad_transition/);
});
