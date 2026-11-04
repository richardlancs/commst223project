import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, newRoom, joinPlayers, advance, setupGame, employeesOf, rid } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const employerOf = (g) => Object.values(g.byLabel).filter((p) => p.role === 'employer');
const emp = (g, label) => g.byLabel[label];
const groupOf = (g, employerLabel) => employeesOf(g.hostState).filter((m) => m.group === employerLabel);
const notGroupOf = (g, employerLabel) => employeesOf(g.hostState).filter((m) => m.group !== employerLabel);

async function toNetworking(g) { assert.equal((await advance(g.host, g.code)).status, 200); }
async function sendAllReferrals(g) {
  for (const e of ['A', 'B', 'C']) {
    const mine = groupOf(g, e).slice(0, g.H);
    for (const m of mine) {
      const to = e === 'A' ? 'B' : 'A';
      const r = await emp(g, e).act(g.code, 'referral', { employee: m.label, to });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  }
}
async function toHiring(g) { await toNetworking(g); await sendAllReferrals(g); assert.equal((await advance(g.host, g.code)).status, 200); }

// ---------------------------------------------------------------- joining

test('room creation, join link, QR code and lobby setup', async () => {
  const { host, code } = await newRoom(srv.base);
  assert.match(code, /^[A-Z]{4}$/);
  const hs = await host.hostState(code);
  assert.equal(hs.status, 200);
  assert.equal(hs.body.viewer, 'host');
  assert.match(hs.body.host.joinUrl, new RegExp(`/join/${code}$`));
  assert.match(hs.body.host.hostUrl, new RegExp(`/host/${code}#key=`));
  const qr = await host.get(`/api/rooms/${code}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(String(qr.body), /<svg/);

  await joinPlayers(srv.base, code, 5);
  let s = (await host.hostState(code)).body;
  assert.equal(s.setup.players, 5);
  assert.equal(s.setup.ready, false);
  const blocked = await advance(host, code);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'need_players');

  await joinPlayers(srv.base, code, 4, 'Q');
  s = (await host.hostState(code)).body;
  assert.deepEqual([s.setup.players, s.setup.employees, s.setup.hires], [9, 6, 1]);
  assert.deepEqual(s.setup.groupSizes, [2, 2, 2]);
  // host does not occupy a player slot
  assert.equal(s.host.members.length, 9);
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

test('attendance counts 6–30: assignments, uneven groups and dynamic limits', async () => {
  for (const n of [6, 7, 8, 9, 10, 14, 15, 17, 18, 24, 30]) {
    const g = await setupGame(srv.base, n);
    const E = n - 3;
    assert.equal(g.H, Math.max(1, Math.floor(E / 5)), `H for ${n}`);
    const sizes = ['A', 'B', 'C'].map((e) => groupOf(g, e).length).sort((a, b) => b - a);
    const base = Math.floor(E / 3);
    assert.ok(sizes.every((x) => x === base || x === base + 1), `groups ${sizes} for ${n}`);
    assert.equal(sizes.reduce((a, b) => a + b, 0), E);
    assert.equal(employerOf(g).length, 3);
    // public setup matches
    const pub = (await g.players[0].state(g.code)).body;
    assert.equal(pub.setup.hires, g.H);
    assert.deepEqual(pub.setup.groupSizes, sizes);
  }
  // spec example: 14 employees => 5,5,4
  const g17 = await setupGame(srv.base, 17);
  assert.deepEqual(g17.hostState.setup.groupSizes, [5, 5, 4]);
});

test('late arrivals become spectators with public information only; reset promotes them', async () => {
  const g = await setupGame(srv.base, 9);
  const late = new Client(srv.base);
  const j = await late.post(`/api/rooms/${g.code}/join`, { name: 'Late' });
  assert.equal(j.status, 201);
  assert.equal(j.body.spectator, true);
  const s = (await late.state(g.code)).body;
  assert.equal(s.viewer, 'spectator');
  assert.equal(s.employer, undefined);
  assert.equal(s.employee, undefined);
  assert.doesNotMatch(JSON.stringify(s), /"score"|"group"/);
  const r = await late.act(g.code, 'offer', { employee: 'E1' });
  assert.equal(r.status, 403);
  // roster locked: host cannot remove a real player, but can remove spectator
  const hs = (await g.host.hostState(g.code)).body;
  const player = hs.host.members.find((m) => !m.spectator);
  assert.equal((await g.host.hostAct(g.code, 'remove', { playerId: player.id })).status, 409);
  // reset promotes spectator
  assert.equal((await g.host.hostAct(g.code, 'reset', { confirm: true })).status, 200);
  const after = (await late.state(g.code)).body;
  assert.equal(after.viewer, 'player');
  assert.equal(after.phase, 'lobby');
  assert.equal(after.setup.players, 10);
});

// ---------------------------------------------------------------- privacy

test('private information: each viewer receives only what they may see', async () => {
  const g = await setupGame(srv.base, 15);
  const scoreOf = Object.fromEntries(employeesOf(g.hostState).map((m) => [m.label, m.score]));

  // Collect every (label, score) pair a viewer received.
  const pairs = (obj, out = []) => {
    if (Array.isArray(obj)) obj.forEach((x) => pairs(x, out));
    else if (obj && typeof obj === 'object') {
      if (typeof obj.label === 'string' && /^E\d+$/.test(obj.label)) {
        for (const k of ['score', 'knownScore']) if (obj[k] != null) out.push([obj.label, obj[k]]);
      }
      Object.values(obj).forEach((x) => pairs(x, out));
    }
    return out;
  };

  for (const p of g.players) {
    const s = (await p.state(g.code)).body;
    const raw = JSON.stringify(s);
    assert.equal(s.host, undefined);
    assert.doesNotMatch(raw, /token|host_key|hostKey|claim/i);
    if (p.role === 'employee') {
      assert.equal(s.employee.score, null, 'employee must not see own score before results');
      assert.deepEqual(pairs(s), []);
      assert.doesNotMatch(raw, /"score":\d/);
    } else {
      const allowed = new Set(groupOf(g, p.label).map((m) => m.label));
      const seen = pairs(s);
      assert.equal(seen.length, allowed.size);
      for (const [label, score] of seen) {
        assert.ok(allowed.has(label), `${p.label} saw score of ${label}`);
        assert.equal(score, scoreOf[label]);
      }
      // no other employer's group membership leaks anywhere
      assert.doesNotMatch(raw, /"group(_of)?":"[ABC]"/);
    }
  }
  // the HTML shell and script contain no game data
  const page = await new Client(srv.base).get(`/room/${g.code}`);
  assert.doesNotMatch(String(page.body), new RegExp(g.code));
  assert.doesNotMatch(String(page.body), /score/i);
});

test('players cannot reach host data or host actions', async () => {
  const g = await setupGame(srv.base, 9);
  const p = g.players[0];
  assert.equal((await p.hostState(g.code)).status, 403);
  assert.equal((await p.hostAct(g.code, 'advance', { from: 'reveal' })).status, 403);
  assert.equal((await p.hostAct(g.code, 'reset', { confirm: true })).status, 403);
  assert.equal((await p.hostAct(g.code, 'rejoin_code', { playerId: g.hostState.host.members[0].id })).status, 403);
  // a stranger with only the room code
  const stranger = new Client(srv.base);
  assert.equal((await stranger.hostState(g.code)).status, 403);
  const s = (await stranger.state(g.code)).body;
  assert.equal(s.viewer, 'none');
  assert.doesNotMatch(JSON.stringify(s), /score/);
  // forging a host cookie value
  stranger.cookies.set(`rrh_${g.code}`, 'forged');
  assert.equal((await stranger.hostState(g.code)).status, 403);
  // wrong host key
  assert.equal((await stranger.post(`/api/rooms/${g.code}/host/claim`, { key: 'nope' })).status, 403);
  // right host key (from the host's private link) works
  const key = new URL(g.hostState.host.hostUrl).hash.slice(5);
  const second = new Client(srv.base);
  assert.equal((await second.post(`/api/rooms/${g.code}/host/claim`, { key })).status, 200);
  assert.equal((await second.hostState(g.code)).status, 200);
});

test('cross-room isolation: sessions do not carry between rooms', async () => {
  const g1 = await setupGame(srv.base, 9);
  const g2 = await setupGame(srv.base, 9);
  const p1 = g1.players.find((p) => p.role === 'employer');
  // copy room-1 cookie under room-2's cookie name
  const forger = new Client(srv.base);
  forger.cookies.set(`rrp_${g2.code}`, p1.cookies.get(`rrp_${g1.code}`));
  forger.cookies.set(`rrh_${g2.code}`, g1.host.cookies.get(`rrh_${g1.code}`));
  assert.equal((await forger.state(g2.code)).body.viewer, 'none');
  assert.equal((await forger.act(g2.code, 'referral', { employee: 'E1', to: 'B' })).status, 401);
  assert.equal((await forger.hostState(g2.code)).status, 403);
  assert.equal((await forger.hostAct(g2.code, 'advance', { from: 'reveal' })).status, 403);
  // host of room 1 cannot touch room 2
  assert.equal((await g1.host.hostAct(g2.code, 'reset', { confirm: true })).status, 403);
  // an offer id from another room is not found
  await toHiring(g1);
  const a1 = emp(g1, 'A');
  const target = notGroupOf(g1, 'A')[0];
  assert.equal((await a1.act(g1.code, 'offer', { employee: target.label })).status, 200);
  const offerId = (await target && (await g1.byLabel[target.label].state(g1.code))).body.employee.offers[0].id;
  await toHiring(g2);
  const anyEmployee2 = g2.players.find((p) => p.role === 'employee');
  assert.equal((await anyEmployee2.act(g2.code, 'accept', { offerId })).status, 404);
});

test('forged identities, roles and scores in request bodies are ignored', async () => {
  const g = await setupGame(srv.base, 9);
  await toNetworking(g);
  const employee = g.players.find((p) => p.role === 'employee');
  const A = emp(g, 'A');
  const target = groupOf(g, 'A')[0];
  // employee claims to be employer A
  const r1 = await employee.act(g.code, 'referral', { employee: target.label, to: 'B', role: 'employer', label: 'A', playerId: 'x', sender: 'A' });
  assert.equal(r1.status, 403);
  // employer sends a fake score
  const r2 = await A.act(g.code, 'referral', { employee: target.label, to: 'B', score: 10 });
  assert.equal(r2.status, 200);
  const B = emp(g, 'B');
  const received = (await B.state(g.code)).body.employer.referralsReceived;
  assert.equal(received.length, 1);
  assert.equal(received[0].score, target.score, 'score must come from the backend');
  // employer refers someone outside their group
  const outsider = notGroupOf(g, 'C')[0];
  const C = emp(g, 'C');
  assert.equal((await C.act(g.code, 'referral', { employee: outsider.label, to: 'A' })).status, 403);
  // refer to self / unknown employer
  const cMember = groupOf(g, 'C')[0];
  assert.equal((await C.act(g.code, 'referral', { employee: cMember.label, to: 'C' })).status, 400);
  assert.equal((await C.act(g.code, 'referral', { employee: cMember.label, to: 'D' })).status, 400);
  // missing / malformed request id
  assert.equal((await C.post(`/api/rooms/${g.code}/action`, { type: 'referral', employee: cMember.label, to: 'A' })).status, 400);
  // CSRF: no custom header
  assert.equal((await C.post(`/api/rooms/${g.code}/action`, { type: 'referral', requestId: rid(), employee: cMember.label, to: 'A' }, { csrf: false })).status, 403);
});

// ---------------------------------------------------------------- referrals

test('referral rules: phase, limit, uniqueness, visibility, no undo', async () => {
  const g = await setupGame(srv.base, 18); // 15 employees, H = 3, groups of 5
  assert.equal(g.H, 3);
  const A = emp(g, 'A');
  const groupA = groupOf(g, 'A');
  // not allowed during role reveal
  assert.equal((await A.act(g.code, 'referral', { employee: groupA[0].label, to: 'B' })).status, 409);
  await toNetworking(g);
  assert.equal((await A.act(g.code, 'referral', { employee: groupA[0].label, to: 'B' })).status, 200);
  // same employee twice, even to the other employer
  const dup = await A.act(g.code, 'referral', { employee: groupA[0].label, to: 'C' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'duplicate_referral');
  assert.equal((await A.act(g.code, 'referral', { employee: groupA[1].label, to: 'C' })).status, 200);
  assert.equal((await A.act(g.code, 'referral', { employee: groupA[2].label, to: 'B' })).status, 200);
  // limit H
  const over = await A.act(g.code, 'referral', { employee: groupA[3].label, to: 'B' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'referral_limit');
  // there is no edit or withdraw action
  assert.equal((await A.act(g.code, 'withdraw_referral', {})).status, 400);

  // visibility: sender, recipient, host only
  const sA = (await A.state(g.code)).body.employer;
  assert.equal(sA.referralsSent.length, 3);
  const sB = (await emp(g, 'B').state(g.code)).body.employer;
  assert.deepEqual(sB.referralsReceived.map((r) => r.label).sort(), [groupA[0].label, groupA[2].label].sort());
  const sC = (await emp(g, 'C').state(g.code)).body.employer;
  assert.deepEqual(sC.referralsReceived.map((r) => r.label), [groupA[1].label]);
  assert.ok(!JSON.stringify(sC).includes(`"${groupA[0].label}"`) || !sC.referralsReceived.some((r) => r.label === groupA[0].label));
  // the referred employee sees that they were referred and to whom, without score
  const e0 = (await emp(g, groupA[0].label).state(g.code)).body.employee;
  assert.deepEqual(e0.referrals, [{ from: 'A', to: 'B' }]);
  assert.equal(e0.score, null);
  // an unrelated employee sees nothing
  const unrelated = groupOf(g, 'B')[0];
  assert.deepEqual((await emp(g, unrelated.label).state(g.code)).body.employee.referrals, []);
  // host sees all
  const hs = (await g.host.hostState(g.code)).body;
  assert.equal(hs.host.referrals.length, 3);

  // missing referrals: warning before advancing, then explicit continue
  const warn = await advance(g.host, g.code);
  assert.equal(warn.status, 409);
  assert.equal(warn.body.code, 'needs_confirm');
  assert.ok(warn.body.warnings.some((w) => /Employer B has sent 0 of 3/.test(w)));
  assert.equal((await g.host.hostState(g.code)).body.phase, 'networking');
  assert.equal((await advance(g.host, g.code, true)).status, 200);
  // referrals closed during hiring
  assert.equal((await emp(g, 'B').act(g.code, 'referral', { employee: groupOf(g, 'B')[0].label, to: 'A' })).status, 409);
});

// ---------------------------------------------------------------- hiring

test('hiring rules: phase, own group, capacity, withdraw, decline, hired', async () => {
  const g = await setupGame(srv.base, 15); // 12 employees, H = 2
  assert.equal(g.H, 2);
  const A = emp(g, 'A');
  const cands = notGroupOf(g, 'A');
  await toNetworking(g);
  assert.equal((await A.act(g.code, 'offer', { employee: cands[0].label })).status, 409, 'no offers in networking');
  await sendAllReferrals(g);
  await advance(g.host, g.code);
  // own group
  assert.equal((await A.act(g.code, 'offer', { employee: groupOf(g, 'A')[0].label })).status, 403);
  // employee cannot make offers
  assert.equal((await emp(g, cands[0].label).act(g.code, 'offer', { employee: cands[1].label })).status, 403);
  // capacity: pending offers reserve slots
  assert.equal((await A.act(g.code, 'offer', { employee: cands[0].label })).status, 200);
  assert.equal((await A.act(g.code, 'offer', { employee: cands[0].label })).body.code, 'duplicate_offer');
  assert.equal((await A.act(g.code, 'offer', { employee: cands[1].label })).status, 200);
  const full = await A.act(g.code, 'offer', { employee: cands[2].label });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'no_slots');
  // decline releases a slot
  const e1 = emp(g, cands[1].label);
  const off1 = (await e1.state(g.code)).body.employee.offers[0];
  assert.equal((await e1.act(g.code, 'decline', { offerId: off1.id })).status, 200);
  assert.equal((await e1.act(g.code, 'accept', { offerId: off1.id })).status, 409, 'cannot accept a declined offer');
  assert.equal((await A.act(g.code, 'offer', { employee: cands[2].label })).status, 200);
  // withdraw releases a slot; only the owner can withdraw
  const aState = (await A.state(g.code)).body.employer;
  const pendingTo2 = aState.offers.find((o) => o.label === cands[2].label && o.status === 'pending');
  const B = emp(g, 'B');
  assert.equal((await B.act(g.code, 'withdraw', { offerId: pendingTo2.id })).status, 404);
  assert.equal((await A.act(g.code, 'withdraw', { offerId: pendingTo2.id })).status, 200);
  // another employee cannot accept someone else's offer
  const e0 = emp(g, cands[0].label);
  const off0 = (await e0.state(g.code)).body.employee.offers.find((o) => o.status === 'pending');
  assert.equal((await e1.act(g.code, 'accept', { offerId: off0.id })).status, 404);
  // accept
  assert.equal((await e0.act(g.code, 'accept', { offerId: off0.id })).status, 200);
  assert.equal((await e0.state(g.code)).body.employee.job, 'A');
  // no offers to an already-hired employee
  const otherEmployer = cands[0].group === 'B' ? emp(g, 'C') : emp(g, 'B');
  const hiredOffer = await otherEmployer.act(g.code, 'offer', { employee: cands[0].label });
  assert.equal(hiredOffer.status, 409);
  assert.equal(hiredOffer.body.code, 'already_hired');
  // accepted hires are final: cannot withdraw
  const accepted = (await A.state(g.code)).body.employer;
  assert.equal(accepted.hired.length, 1);
  assert.equal((await A.act(g.code, 'withdraw', { offerId: off0.id })).status, 409);
  // employer sees hire score only if known through a referral, otherwise "awaiting reveal" (null)
  const viaReferral = accepted.referralsReceived.some((r) => r.label === cands[0].label);
  assert.equal(accepted.hired[0].score == null, !viaReferral);
  assert.equal(accepted.myTotal, undefined, 'no totals before results');
});

test('accepting one offer closes the others; simultaneous acceptances yield one job', async () => {
  const g = await setupGame(srv.base, 15);
  await toHiring(g);
  // find an employee in C's group so A and B can both offer
  const target = groupOf(g, 'C')[0];
  const A = emp(g, 'A'); const B = emp(g, 'B');
  assert.equal((await A.act(g.code, 'offer', { employee: target.label })).status, 200);
  assert.equal((await B.act(g.code, 'offer', { employee: target.label })).status, 200);
  const e = emp(g, target.label);
  const offers = (await e.state(g.code)).body.employee.offers.filter((o) => o.status === 'pending');
  assert.equal(offers.length, 2);
  // fire both accepts at once, several times each
  const results = await Promise.all([
    ...offers.map((o) => e.act(g.code, 'accept', { offerId: o.id })),
    ...offers.map((o) => e.act(g.code, 'accept', { offerId: o.id })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  const st = (await e.state(g.code)).body.employee;
  assert.ok(['A', 'B'].includes(st.job));
  assert.ok(st.offers.every((o) => o.status === 'closed'));
  const hs = (await g.host.hostState(g.code)).body;
  assert.equal(hs.host.offers.filter((o) => o.status === 'accepted' && o.label === target.label).length, 1);
});

test('concurrent offers cannot exceed capacity; concurrent offers to one employee by one employer dedupe', async () => {
  const g = await setupGame(srv.base, 24); // 21 employees, H = 4
  assert.equal(g.H, 4);
  await toHiring(g);
  const A = emp(g, 'A');
  const cands = notGroupOf(g, 'A');
  const rs = await Promise.all(cands.map((c) => A.act(g.code, 'offer', { employee: c.label })));
  assert.equal(rs.filter((r) => r.status === 200).length, 4);
  const B = emp(g, 'B');
  const t = notGroupOf(g, 'B')[0];
  const dup = await Promise.all(Array.from({ length: 6 }, () => B.act(g.code, 'offer', { employee: t.label })));
  assert.equal(dup.filter((r) => r.status === 200).length, 1);
});

test('replayed requests are not applied twice', async () => {
  const g = await setupGame(srv.base, 18);
  await toNetworking(g);
  const A = emp(g, 'A');
  const m = groupOf(g, 'A')[0];
  const id = rid();
  const first = await A.act(g.code, 'referral', { employee: m.label, to: 'B' }, id);
  const again = await A.act(g.code, 'referral', { employee: m.label, to: 'B' }, id);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal((await A.state(g.code)).body.employer.referralsSent.length, 1);
  // host phase change replay: one advance only
  const hid = rid();
  const s = (await g.host.hostState(g.code)).body;
  const h1 = await g.host.hostAct(g.code, 'advance', { from: s.phase, confirm: true }, hid);
  const h2 = await g.host.hostAct(g.code, 'advance', { from: s.phase, confirm: true }, hid);
  assert.equal(h1.status, 200);
  assert.equal(h2.body.replayed, true);
  assert.equal((await g.host.hostState(g.code)).body.phase, 'hiring');
  // stale double-click with a new id is rejected rather than skipping a phase
  const h3 = await g.host.hostAct(g.code, 'advance', { from: 'networking', confirm: true });
  assert.equal(h3.status, 409);
  assert.equal(h3.body.code, 'stale_phase');
  assert.equal((await g.host.hostState(g.code)).body.phase, 'hiring');
});

test('actions racing a phase change: acceptance after close fails, results stay consistent', async () => {
  for (let round = 0; round < 5; round++) {
    const g = await setupGame(srv.base, 9);
    await toHiring(g);
    const target = groupOf(g, 'C')[0];
    const A = emp(g, 'A');
    assert.equal((await A.act(g.code, 'offer', { employee: target.label })).status, 200);
    const e = emp(g, target.label);
    const offer = (await e.state(g.code)).body.employee.offers[0];
    const [close, accept] = await Promise.all([
      advance(g.host, g.code, true),
      e.act(g.code, 'accept', { offerId: offer.id }),
    ]);
    assert.equal(close.status, 200);
    const hs = (await g.host.hostState(g.code)).body;
    assert.equal(hs.phase, 'results');
    const status = hs.host.offers.find((o) => o.id === offer.id).status;
    if (accept.status === 200) assert.equal(status, 'accepted');
    else { assert.equal(accept.status, 409); assert.equal(status, 'expired'); }
    assert.equal(hs.host.offers.filter((o) => o.status === 'pending').length, 0);
  }
  // deterministic version: stale screen accepts after close
  const g = await setupGame(srv.base, 9);
  await toHiring(g);
  const target = groupOf(g, 'B')[0];
  await emp(g, 'A').act(g.code, 'offer', { employee: target.label });
  const e = emp(g, target.label);
  const offer = (await e.state(g.code)).body.employee.offers[0];
  const warn = await advance(g.host, g.code);
  assert.equal(warn.status, 409, 'closing with pending offers needs confirmation');
  assert.ok(warn.body.warnings.some((w) => /pending offer/.test(w)));
  assert.equal((await advance(g.host, g.code, true)).status, 200);
  const late = await e.act(g.code, 'accept', { offerId: offer.id });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'wrong_phase');
  assert.equal((await e.state(g.code)).body.employee.offers[0].status, 'expired');
});

// ---------------------------------------------------------------- results

test('scoring, reveal rules and ties', async () => {
  const g = await setupGame(srv.base, 15); // H = 2
  // Make the scores deterministic for this test by writing them directly in the DB.
  const db = srv.app.db;
  const fixed = {};
  const all = employeesOf(g.hostState);
  for (const m of all) {
    const s = 5;
    fixed[m.label] = s;
    db.prepare('UPDATE players SET score = ? WHERE id = ?').run(s, m.id);
  }
  // pick hires: A takes two from B's group, B takes two from C's group, C takes one from A's group
  const pickA = groupOf(g, 'B').slice(0, 2);
  const pickB = groupOf(g, 'C').slice(0, 2);
  const pickC = groupOf(g, 'A').slice(0, 1);
  db.prepare('UPDATE players SET score = 9 WHERE room_code = ? AND label = ?').run(g.code, pickA[0].label);
  db.prepare('UPDATE players SET score = 1 WHERE room_code = ? AND label = ?').run(g.code, pickA[1].label);
  db.prepare('UPDATE players SET score = 4 WHERE room_code = ? AND label = ?').run(g.code, pickB[0].label);
  db.prepare('UPDATE players SET score = 6 WHERE room_code = ? AND label = ?').run(g.code, pickB[1].label);
  db.prepare('UPDATE players SET score = 7 WHERE room_code = ? AND label = ?').run(g.code, pickC[0].label);
  await toHiring(g);
  const hire = async (employer, list) => {
    for (const m of list) {
      assert.equal((await emp(g, employer).act(g.code, 'offer', { employee: m.label })).status, 200);
      const e = emp(g, m.label);
      const o = (await e.state(g.code)).body.employee.offers.find((x) => x.status === 'pending' && x.from === employer);
      assert.equal((await e.act(g.code, 'accept', { offerId: o.id })).status, 200);
    }
  };
  await hire('A', pickA); await hire('B', pickB); await hire('C', pickC);

  // before reveal
  const emp0 = emp(g, pickA[0].label);
  assert.equal((await emp0.state(g.code)).body.employee.score, null);
  assert.equal((await emp(g, 'A').state(g.code)).body.employer.myTotal, undefined);
  assert.equal((await emp0.state(g.code)).body.results, undefined);
  // host can preview privately
  const preview = (await g.host.hostState(g.code)).body.host.preview;
  assert.deepEqual(preview.totals.map((t) => t.total), [10, 10, 7]);

  const close = await advance(g.host, g.code);
  assert.equal(close.status, 409);
  assert.ok(close.body.warnings.some((w) => /Employer C has filled 1 of 2/.test(w)));
  assert.equal((await advance(g.host, g.code, true)).status, 200);

  // after reveal
  const pub = (await emp0.state(g.code)).body;
  assert.deepEqual(pub.results.totals.map((t) => [t.employer, t.total, t.filled]), [['A', 10, 2], ['B', 10, 2], ['C', 7, 1]]);
  assert.deepEqual(pub.results.winners, ['A', 'B'], 'ties share the win');
  assert.equal(pub.employee.score, 9);
  assert.equal(pub.employee.job, 'A');
  const aView = (await emp(g, 'A').state(g.code)).body.employer;
  assert.equal(aView.myTotal, 10);
  assert.deepEqual(aView.hired.map((h) => h.score).sort(), [1, 9]);
  // an unhired employee sees own score and outcome
  const unhired = all.find((m) => ![...pickA, ...pickB, ...pickC].some((p) => p.label === m.label));
  const u = (await emp(g, unhired.label).state(g.code)).body.employee;
  assert.equal(u.job, null);
  assert.equal(u.score, 5);
  // individual scores are not published to everyone
  const spectatorish = (await new Client(srv.base).state(g.code)).body;
  assert.doesNotMatch(JSON.stringify(spectatorish), /"score"/);
  assert.doesNotMatch(JSON.stringify(u), /"label":"E\d+","name":"[^"]+","score"/);
  // nothing can change after results
  assert.equal((await emp(g, 'C').act(g.code, 'offer', { employee: unhired.label })).status, 409);
  // discussion, then no further phase
  assert.equal((await advance(g.host, g.code)).status, 200);
  assert.equal((await g.host.hostState(g.code)).body.phase, 'discussion');
  assert.equal((await advance(g.host, g.code)).status, 409);
});

test('single winner is reported alone', async () => {
  const g = await setupGame(srv.base, 9);
  await toHiring(g);
  const t = groupOf(g, 'B')[0];
  await emp(g, 'A').act(g.code, 'offer', { employee: t.label });
  const e = emp(g, t.label);
  const o = (await e.state(g.code)).body.employee.offers[0];
  await e.act(g.code, 'accept', { offerId: o.id });
  await advance(g.host, g.code, true);
  const r = (await e.state(g.code)).body.results;
  assert.deepEqual(r.winners, ['A']);
  assert.equal(r.totals.find((x) => x.employer === 'A').total, t.score);
});

// ---------------------------------------------------------------- sessions

test('refresh keeps identity; rejoin code moves a player to a new phone', async () => {
  const g = await setupGame(srv.base, 9);
  const p = g.players[3];
  const before = (await p.state(g.code)).body.me;
  // "refresh": brand-new request with the same cookie jar
  const again = new Client(srv.base);
  again.cookies = new Map(p.cookies);
  assert.deepEqual((await again.state(g.code)).body.me, before);
  // new phone without cookie
  const phone = new Client(srv.base);
  assert.equal((await phone.state(g.code)).body.viewer, 'none');
  const member = g.hostState.host.members.find((m) => m.id === before.id);
  const code = (await g.host.hostAct(g.code, 'rejoin_code', { playerId: member.id })).body.claimCode;
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal((await phone.post(`/api/rooms/${g.code}/reclaim`, { claimCode: 'AAAAAA' })).status, 403);
  assert.equal((await phone.post(`/api/rooms/${g.code}/reclaim`, { claimCode: code })).status, 200);
  assert.deepEqual((await phone.state(g.code)).body.me, before);
  // single use
  assert.equal((await new Client(srv.base).post(`/api/rooms/${g.code}/reclaim`, { claimCode: code })).status, 403);
  // the old phone's session is revoked
  assert.equal((await p.state(g.code)).body.viewer, 'none');
});

test('live updates stream carries only a version number and requires a session', async () => {
  const g = await setupGame(srv.base, 9);
  const anon = await fetch(`${srv.base}/api/rooms/${g.code}/events`);
  assert.equal(anon.status, 401);
  const p = g.players[0];
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/rooms/${g.code}/events`, { headers: { cookie: [...p.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^retry: 3000\ndata: \d+\n\n$/);
  await advance(g.host, g.code);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /^data: \d+\n\n$/);
  ctrl.abort();
});

test('static pages and security headers', async () => {
  const c = new Client(srv.base);
  for (const path of ['/', '/join/ABCD', '/room/ABCD', '/host/ABCD', '/rules']) {
    const r = await c.get(path);
    assert.equal(r.status, 200, path);
    assert.match(String(r.body), /<title>The Referral Rush<\/title>/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  }
  assert.equal((await c.get('/app.js')).status, 200);
  assert.equal((await c.get('/../server/game.js')).status, 404);
  assert.equal((await c.get('/%2e%2e/server/game.js')).status, 404);
  const created = await new Client(srv.base).post('/api/rooms', {});
  assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
});

test('rate limiting on join attempts', async () => {
  const limited = await startServer({ rateLimits: true });
  try {
    const { code } = await newRoom(limited.base);
    let last;
    for (let i = 0; i < 45; i++) last = await new Client(limited.base).post(`/api/rooms/${code}/join`, { name: `N${i}` });
    assert.equal(last.status, 429);
  } finally { await limited.close(); }
});

test('reset requires confirmation and clears the round', async () => {
  const g = await setupGame(srv.base, 9);
  await toHiring(g);
  assert.equal((await g.host.hostAct(g.code, 'reset', {})).status, 400);
  assert.equal((await g.host.hostAct(g.code, 'reset', { confirm: true })).status, 200);
  const hs = (await g.host.hostState(g.code)).body;
  assert.equal(hs.phase, 'lobby');
  assert.ok(hs.host.members.every((m) => m.role === null && m.score === null));
  assert.equal(hs.round, 2);
  const again = await advance(g.host, g.code);
  assert.equal(again.status, 200);
});

test('database triggers enforce the rules even if app code is bypassed', async () => {
  const g = await setupGame(srv.base, 9);
  const db = srv.app.db;
  const ins = db.prepare("INSERT INTO offers (id, room_code, employer, employee_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', 0)");
  const other = groupOf(g, 'B')[0];
  // wrong phase (role reveal)
  assert.throws(() => ins.run('x1', g.code, 'A', other.id), /RR:wrong_phase/);
  await toHiring(g);
  // own group
  assert.throws(() => ins.run('x2', g.code, 'B', other.id), /RR:not_eligible/);
  ins.run('x3', g.code, 'A', other.id);
  // capacity (H = 1)
  assert.throws(() => ins.run('x4', g.code, 'A', groupOf(g, 'C')[0].id), /RR:no_slots/);
  // double hire
  ins.run('x5', g.code, 'C', other.id);
  db.prepare("UPDATE offers SET status = 'accepted' WHERE id = 'x3'").run();
  assert.throws(() => db.prepare("UPDATE offers SET status = 'accepted' WHERE id = 'x5'").run(), /UNIQUE|offers_one_job/);
  // accepted is final
  assert.throws(() => db.prepare("UPDATE offers SET status = 'withdrawn' WHERE id = 'x3'").run(), /RR:offer_closed/);
  // referral with a fake score / wrong phase
  assert.throws(() => db.prepare("INSERT INTO referrals (id, room_code, sender, recipient, employee_id, score, created_at) VALUES ('r', ?, 'B', 'A', ?, 10, 0)").run(g.code, other.id), /RR:/);
  // phases cannot skip or go backwards (except a reset to lobby)
  assert.throws(() => db.prepare("UPDATE rooms SET phase = 'discussion' WHERE code = ?").run(g.code), /RR:bad_transition/);
  assert.throws(() => db.prepare("UPDATE rooms SET phase = 'networking' WHERE code = ?").run(g.code), /RR:bad_transition/);
});
