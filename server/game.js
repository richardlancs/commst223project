import crypto from 'node:crypto';

export const PHASES = ['lobby', 'reveal', 'networking', 'hiring', 'results', 'discussion'];
export const EMPLOYERS = ['A', 'B', 'C'];
export const MIN_PLAYERS = 6;
export const MAX_MEMBERS = 80; // players + spectators per room
export const NEXT_ACTION = {
  lobby: 'Assign roles',
  reveal: 'Open networking',
  networking: 'Open hiring',
  hiring: 'Close hiring and reveal results',
  results: 'Open discussion',
};
const PHASE_NAMES = {
  lobby: 'Lobby', reveal: 'Role reveal', networking: 'Networking',
  hiring: 'Hiring', results: 'Results', discussion: 'Discussion',
};
const rank = (p) => PHASES.indexOf(p);
const ROOM_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no accidental words, no 0/O or 1/I
const CLAIM_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const CLAIM_TTL_MS = 15 * 60 * 1000;

export class GameError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TRIGGER_MESSAGES = {
  wrong_phase: 'That is not allowed in the current phase.',
  referral_limit: 'You have already sent all your referrals.',
  not_in_group: 'You can only refer employees from your own group.',
  not_eligible: 'You cannot hire that employee.',
  already_hired: 'That employee has already been hired.',
  no_slots: 'All your job slots are filled or reserved by pending offers.',
  offer_closed: 'That offer is no longer open.',
  bad_transition: 'That phase change is not allowed.',
  bad_status: 'Invalid offer.',
};

// ---------- pure helpers ----------

export const hiresFor = (employees) => Math.max(1, Math.floor(employees / 5));

export function groupSizes(employees) {
  const base = Math.floor(employees / 3);
  const extra = employees % 3;
  return [base + (extra > 0 ? 1 : 0), base + (extra > 1 ? 1 : 0), base];
}

export function setupFor(playerCount) {
  if (playerCount < MIN_PLAYERS) return { players: playerCount, ready: false, needed: MIN_PLAYERS - playerCount };
  const employees = playerCount - 3;
  return { players: playerCount, ready: true, employers: 3, employees, hires: hiresFor(employees), groupSizes: groupSizes(employees) };
}

export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const unit = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;

// Stratified scores: one draw from each of E equal slices of the 1–10 range,
// so every game has a spread of weak, middling and strong candidates.
export function makeScores(employees) {
  const scores = [];
  for (let i = 0; i < employees; i++) {
    scores.push(Math.min(10, 1 + Math.floor(((i + unit()) / employees) * 10)));
  }
  return scores;
}

export function assignRoles(playerIds) {
  if (playerIds.length < MIN_PLAYERS) throw new GameError(409, 'need_players', `At least ${MIN_PLAYERS} players are needed.`);
  const order = shuffle(playerIds);
  const employers = order.slice(0, 3).map((id, i) => ({ id, label: EMPLOYERS[i] }));
  const employeeIds = order.slice(3);
  const E = employeeIds.length;

  // IDs (E1…En) and group membership come from two independent shuffles.
  const labelled = shuffle(employeeIds).map((id, i) => ({ id, label: `E${i + 1}` }));
  const members = shuffle(labelled);
  const sizes = groupSizes(E);
  const groups = { A: [], B: [], C: [] };
  let cursor = 0;
  shuffle(EMPLOYERS).forEach((g, k) => {
    groups[g] = members.slice(cursor, cursor + sizes[k]);
    cursor += sizes[k];
  });

  // Snake-deal the sorted scores so group totals come out roughly equal.
  const sorted = makeScores(E).sort((a, b) => b - a);
  const pools = { A: [], B: [], C: [] };
  let seq = shuffle(EMPLOYERS);
  let i = 0;
  while (i < sorted.length) {
    for (const g of seq) {
      if (i < sorted.length && pools[g].length < groups[g].length) pools[g].push(sorted[i++]);
    }
    seq = [...seq].reverse();
  }

  const employees = [];
  for (const g of EMPLOYERS) {
    const scores = shuffle(pools[g]);
    groups[g].forEach((m, k) => employees.push({ ...m, group: g, score: scores[k] }));
  }
  return { employers, employees, hires: hiresFor(E) };
}

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || [...name].length > 20) return null;
  return name;
}

const randomCode = (alphabet, length) =>
  Array.from({ length }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomUUID();
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
export const normalizeCode = (c) => (typeof c === 'string' ? c.trim().toUpperCase() : '');
export const isRoomCode = (c) => /^[A-Z]{4}$/.test(c);

// ---------- database-backed game ----------

export function createGame(db, { onChange = () => {} } = {}) {
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const now = () => Date.now();

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw translate(err);
    }
  }

  function translate(err) {
    if (err instanceof GameError) return err;
    const m = /RR:([a-z_]+)/.exec(err?.message || '');
    if (m) return new GameError(409, m[1], TRIGGER_MESSAGES[m[1]] || 'That action is not allowed.');
    if (/UNIQUE constraint failed: referrals/.test(err?.message)) return new GameError(409, 'duplicate_referral', 'You already referred that employee.');
    if (/UNIQUE constraint failed: index 'offers_one_job'|offers_one_job/.test(err?.message)) return new GameError(409, 'already_hired', 'That employee has already been hired.');
    if (/offers_one_pending_pair/.test(err?.message)) return new GameError(409, 'duplicate_offer', 'You already have a pending offer to that employee.');
    return err;
  }

  const getRoom = (code) => q('SELECT * FROM rooms WHERE code = ?').get(code);
  function requireRoom(code) {
    const room = getRoom(code);
    if (!room) throw new GameError(404, 'no_room', 'No game with that room code.');
    return room;
  }
  const bump = (code) => q('UPDATE rooms SET version = version + 1, updated_at = ? WHERE code = ?').run(now(), code);
  const membersOf = (code) => q('SELECT * FROM players WHERE room_code = ? ORDER BY joined_at, id').all(code);

  // ----- rooms & sessions -----

  function createRoom() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = randomCode(ROOM_ALPHABET, 4);
      if (getRoom(code)) continue;
      const token = newToken();
      tx(() => {
        q('INSERT INTO rooms (code, host_key, created_at, updated_at) VALUES (?, ?, ?, ?)').run(code, newToken(), now(), now());
        q('INSERT INTO host_sessions (token_hash, room_code, created_at) VALUES (?, ?, ?)').run(hashToken(token), code, now());
      });
      return { code, hostToken: token };
    }
    throw new GameError(503, 'busy', 'Could not create a room. Try again.');
  }

  function claimHost(code, key) {
    const room = requireRoom(code);
    if (typeof key !== 'string' || !safeEqual(key, room.host_key)) throw new GameError(403, 'bad_host_key', 'That host link is not valid.');
    const token = newToken();
    q('INSERT INTO host_sessions (token_hash, room_code, created_at) VALUES (?, ?, ?)').run(hashToken(token), code, now());
    return { hostToken: token };
  }

  function viewerFor(code, { hostToken, playerToken } = {}) {
    const room = getRoom(code);
    if (!room) return { kind: 'none', room: null };
    const isHost = !!hostToken && !!q('SELECT 1 AS ok FROM host_sessions WHERE room_code = ? AND token_hash = ?').get(code, hashToken(hostToken));
    const player = playerToken ? q('SELECT * FROM players WHERE room_code = ? AND token_hash = ?').get(code, hashToken(playerToken)) : null;
    return { room, isHost, player: player || null };
  }

  function join(code, rawName) {
    const name = cleanName(rawName);
    if (!name) throw new GameError(400, 'bad_name', 'Enter a name of 1–20 characters.');
    const token = newToken();
    const result = tx(() => {
      const room = requireRoom(code);
      const count = q('SELECT COUNT(*) AS n FROM players WHERE room_code = ?').get(code).n;
      if (count >= MAX_MEMBERS) throw new GameError(409, 'room_full', 'This room is full.');
      if (q('SELECT 1 AS x FROM players WHERE room_code = ? AND name_key = ?').get(code, name.toLowerCase())) {
        throw new GameError(409, 'name_taken', 'Someone in this room already has that name. Add an initial.');
      }
      const spectator = room.phase === 'lobby' ? 0 : 1;
      q(`INSERT INTO players (id, room_code, name, name_key, token_hash, is_spectator, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newId(), code, name, name.toLowerCase(), hashToken(token), spectator, now());
      bump(code);
      return { spectator: !!spectator };
    });
    onChange(code);
    return { playerToken: token, ...result };
  }

  function reclaim(code, rawClaim) {
    const claim = normalizeCode(rawClaim);
    if (!/^[A-Z0-9]{6}$/.test(claim)) throw new GameError(400, 'bad_claim', 'Rejoin codes have 6 characters.');
    requireRoom(code);
    const p = q('SELECT * FROM players WHERE room_code = ? AND claim_hash = ? AND claim_expires > ?').get(code, hashToken(claim), now());
    if (!p) throw new GameError(403, 'bad_claim', 'That rejoin code is not valid or has expired. Ask the host for a new one.');
    const token = newToken();
    q('UPDATE players SET token_hash = ?, claim_hash = NULL, claim_expires = NULL WHERE id = ?').run(hashToken(token), p.id);
    return { playerToken: token };
  }

  // ----- idempotent actions -----

  function runAction(code, actor, requestId, fn, redact) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      throw new GameError(400, 'bad_request_id', 'Missing request id.');
    }
    const prior = q('SELECT body FROM action_log WHERE room_code = ? AND actor = ? AND request_id = ?').get(code, actor, requestId);
    if (prior) return { ...JSON.parse(prior.body), replayed: true };
    const body = tx(() => {
      const out = fn();
      q('INSERT INTO action_log (room_code, actor, request_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(code, actor, requestId, JSON.stringify(redact ? redact(out) : out), now());
      bump(code);
      return out;
    });
    onChange(code);
    return body;
  }

  // ----- player actions -----

  function playerAction(code, player, input) {
    if (!player) throw new GameError(401, 'no_session', 'Join the game first.');
    const { type, requestId } = input || {};
    return runAction(code, `p:${player.id}`, requestId, () => {
      // Re-read inside the transaction: never act on a stale player or phase.
      const room = requireRoom(code);
      const me = q('SELECT * FROM players WHERE id = ? AND room_code = ?').get(player.id, code);
      if (!me) throw new GameError(401, 'no_session', 'You are no longer in this game.');
      if (me.is_spectator || !me.role) throw new GameError(403, 'spectator', 'Spectators cannot take actions.');
      switch (type) {
        case 'referral': return sendReferral(room, me, input);
        case 'offer': return makeOffer(room, me, input);
        case 'withdraw': return withdrawOffer(room, me, input);
        case 'accept': return respondOffer(room, me, input, true);
        case 'decline': return respondOffer(room, me, input, false);
        default: throw new GameError(400, 'bad_action', 'Unknown action.');
      }
    });
  }

  const requireEmployer = (me) => { if (me.role !== 'employer') throw new GameError(403, 'not_employer', 'Only employers can do that.'); };
  const requireEmployee = (me) => { if (me.role !== 'employee') throw new GameError(403, 'not_employee', 'Only employees can do that.'); };
  const requirePhase = (room, phase) => {
    if (room.phase !== phase) throw new GameError(409, 'wrong_phase', `That is only allowed during ${PHASE_NAMES[phase].toLowerCase()}. The game is in ${PHASE_NAMES[room.phase].toLowerCase()}.`);
  };
  const employeeByLabel = (code, label) =>
    typeof label === 'string' ? q("SELECT * FROM players WHERE room_code = ? AND label = ? AND role = 'employee'").get(code, label) : null;
  const isHired = (employeeId) => !!q("SELECT 1 AS x FROM offers WHERE employee_id = ? AND status = 'accepted'").get(employeeId);

  function sendReferral(room, me, { employee, to }) {
    requireEmployer(me);
    requirePhase(room, 'networking');
    const emp = employeeByLabel(room.code, employee);
    if (!emp) throw new GameError(404, 'no_employee', 'No employee with that ID.');
    if (emp.group_of !== me.label) throw new GameError(403, 'not_in_group', 'You can only refer employees from your own group.');
    if (!EMPLOYERS.includes(to) || to === me.label) throw new GameError(400, 'bad_recipient', 'Send the referral to one of the other two employers.');
    const sent = q('SELECT COUNT(*) AS n FROM referrals WHERE room_code = ? AND sender = ?').get(room.code, me.label).n;
    if (sent >= room.hires) throw new GameError(409, 'referral_limit', 'You have already sent all your referrals.');
    if (q('SELECT 1 AS x FROM referrals WHERE room_code = ? AND sender = ? AND employee_id = ?').get(room.code, me.label, emp.id)) {
      throw new GameError(409, 'duplicate_referral', 'You already referred that employee.');
    }
    q('INSERT INTO referrals (id, room_code, sender, recipient, employee_id, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), room.code, me.label, to, emp.id, emp.score, now());
    return { ok: true, message: `Referral sent: ${emp.label} to Employer ${to}.` };
  }

  function makeOffer(room, me, { employee }) {
    requireEmployer(me);
    requirePhase(room, 'hiring');
    const emp = employeeByLabel(room.code, employee);
    if (!emp) throw new GameError(404, 'no_employee', 'No employee with that ID.');
    if (emp.group_of === me.label) throw new GameError(403, 'own_group', 'You cannot hire employees from your own group.');
    if (isHired(emp.id)) throw new GameError(409, 'already_hired', 'That employee has already been hired.');
    if (q("SELECT 1 AS x FROM offers WHERE room_code = ? AND employer = ? AND employee_id = ? AND status = 'pending'").get(room.code, me.label, emp.id)) {
      throw new GameError(409, 'duplicate_offer', 'You already have a pending offer to that employee.');
    }
    const used = q("SELECT COUNT(*) AS n FROM offers WHERE room_code = ? AND employer = ? AND status IN ('pending','accepted')").get(room.code, me.label).n;
    if (used >= room.hires) throw new GameError(409, 'no_slots', 'All your job slots are filled or reserved by pending offers.');
    q("INSERT INTO offers (id, room_code, employer, employee_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(newId(), room.code, me.label, emp.id, now());
    return { ok: true, message: `Offer sent to ${emp.label}.` };
  }

  function withdrawOffer(room, me, { offerId }) {
    requireEmployer(me);
    requirePhase(room, 'hiring');
    const offer = typeof offerId === 'string' ? q('SELECT * FROM offers WHERE id = ? AND room_code = ?').get(offerId, room.code) : null;
    if (!offer || offer.employer !== me.label) throw new GameError(404, 'no_offer', 'Offer not found.');
    if (offer.status !== 'pending') throw new GameError(409, 'offer_closed', 'That offer is no longer open.');
    q("UPDATE offers SET status = 'withdrawn', resolved_at = ? WHERE id = ?").run(now(), offer.id);
    return { ok: true, message: 'Offer withdrawn.' };
  }

  function respondOffer(room, me, { offerId }, accept) {
    requireEmployee(me);
    requirePhase(room, 'hiring');
    const offer = typeof offerId === 'string' ? q('SELECT * FROM offers WHERE id = ? AND room_code = ?').get(offerId, room.code) : null;
    if (!offer || offer.employee_id !== me.id) throw new GameError(404, 'no_offer', 'Offer not found.');
    if (offer.status !== 'pending') throw new GameError(409, 'offer_closed', 'That offer is no longer open.');
    if (!accept) {
      q("UPDATE offers SET status = 'declined', resolved_at = ? WHERE id = ?").run(now(), offer.id);
      return { ok: true, message: `You declined Employer ${offer.employer}.` };
    }
    if (isHired(me.id)) throw new GameError(409, 'already_hired', 'You have already accepted a job.');
    q("UPDATE offers SET status = 'accepted', resolved_at = ? WHERE id = ?").run(now(), offer.id);
    q("UPDATE offers SET status = 'closed', resolved_at = ? WHERE employee_id = ? AND status = 'pending'").run(now(), me.id);
    return { ok: true, message: `You accepted Employer ${offer.employer}'s job.` };
  }

  // ----- host actions -----

  function hostAction(code, isHost, input) {
    if (!isHost) throw new GameError(403, 'not_host', 'Only the host can do that.');
    const { type, requestId } = input || {};
    const redact = type === 'rejoin_code' ? (out) => ({ ...out, claimCode: undefined }) : undefined;
    return runAction(code, 'host', requestId, () => {
      const room = requireRoom(code);
      switch (type) {
        case 'advance': return advance(room, input);
        case 'reset': return reset(room, input);
        case 'remove': return removeMember(room, input);
        case 'rejoin_code': return rejoinCode(room, input);
        default: throw new GameError(400, 'bad_action', 'Unknown action.');
      }
    }, redact);
  }

  function warningsFor(room) {
    const warnings = [];
    if (room.phase === 'networking') {
      for (const e of EMPLOYERS) {
        const n = q('SELECT COUNT(*) AS n FROM referrals WHERE room_code = ? AND sender = ?').get(room.code, e).n;
        if (n < room.hires) warnings.push(`Employer ${e} has sent ${n} of ${room.hires} referrals.`);
      }
    }
    if (room.phase === 'hiring') {
      for (const e of EMPLOYERS) {
        const filled = q("SELECT COUNT(*) AS n FROM offers WHERE room_code = ? AND employer = ? AND status = 'accepted'").get(room.code, e).n;
        if (filled < room.hires) warnings.push(`Employer ${e} has filled ${filled} of ${room.hires} positions.`);
      }
      const pending = q("SELECT COUNT(*) AS n FROM offers WHERE room_code = ? AND status = 'pending'").get(room.code).n;
      if (pending) warnings.push(`${pending} pending ${pending === 1 ? 'offer' : 'offers'} will expire.`);
    }
    return warnings;
  }

  function advance(room, { from, confirm }) {
    if (from !== room.phase) {
      throw new GameError(409, 'stale_phase', `The game has already moved to ${PHASE_NAMES[room.phase].toLowerCase()}.`);
    }
    const next = PHASES[rank(room.phase) + 1];
    if (!next) throw new GameError(409, 'no_next', 'This is the last phase. Reset to play again.');
    if (room.phase === 'lobby') {
      const ids = q('SELECT id FROM players WHERE room_code = ? AND is_spectator = 0').all(room.code).map((r) => r.id);
      const { employers, employees, hires } = assignRoles(ids);
      for (const e of employers) {
        q("UPDATE players SET role = 'employer', label = ?, group_of = NULL, score = NULL WHERE id = ?").run(e.label, e.id);
      }
      for (const e of employees) {
        q("UPDATE players SET role = 'employee', label = ?, group_of = ?, score = ? WHERE id = ?").run(e.label, e.group, e.score, e.id);
      }
      q('UPDATE rooms SET hires = ? WHERE code = ?').run(hires, room.code);
    } else {
      const warnings = warningsFor(room);
      if (warnings.length && confirm !== true) {
        throw new GameError(409, 'needs_confirm', 'Some steps are unfinished.', { warnings });
      }
      if (room.phase === 'hiring') {
        q("UPDATE offers SET status = 'expired', resolved_at = ? WHERE room_code = ? AND status = 'pending'").run(now(), room.code);
      }
    }
    q('UPDATE rooms SET phase = ? WHERE code = ?').run(next, room.code);
    return { ok: true, phase: next };
  }

  function reset(room, { confirm }) {
    if (confirm !== true) throw new GameError(400, 'needs_confirm', 'Confirm the reset.');
    q('DELETE FROM offers WHERE room_code = ?').run(room.code);
    q('DELETE FROM referrals WHERE room_code = ?').run(room.code);
    q(`UPDATE players SET role = NULL, label = NULL, group_of = NULL, score = NULL, is_spectator = 0
       WHERE room_code = ?`).run(room.code);
    q("UPDATE rooms SET phase = 'lobby', hires = NULL, round = round + 1 WHERE code = ?").run(room.code);
    return { ok: true, phase: 'lobby' };
  }

  function removeMember(room, { playerId }) {
    const p = typeof playerId === 'string' ? q('SELECT * FROM players WHERE id = ? AND room_code = ?').get(playerId, room.code) : null;
    if (!p) throw new GameError(404, 'no_player', 'Player not found.');
    if (room.phase !== 'lobby' && !p.is_spectator) {
      throw new GameError(409, 'roster_locked', 'Roles are assigned, so the roster is locked. Reset the game to change players.');
    }
    q('DELETE FROM players WHERE id = ?').run(p.id);
    return { ok: true, message: `Removed ${p.name}.` };
  }

  function rejoinCode(room, { playerId }) {
    const p = typeof playerId === 'string' ? q('SELECT * FROM players WHERE id = ? AND room_code = ?').get(playerId, room.code) : null;
    if (!p) throw new GameError(404, 'no_player', 'Player not found.');
    const claimCode = randomCode(CLAIM_ALPHABET, 6);
    q('UPDATE players SET claim_hash = ?, claim_expires = ? WHERE id = ?').run(hashToken(claimCode), now() + CLAIM_TTL_MS, p.id);
    return { ok: true, claimCode, name: p.name };
  }

  // ----- views: only what the requester is allowed to see -----

  function totalsFor(code) {
    const rows = q(`SELECT o.employer AS employer, COUNT(*) AS filled, SUM(p.score) AS total
                    FROM offers o JOIN players p ON p.id = o.employee_id
                    WHERE o.room_code = ? AND o.status = 'accepted' GROUP BY o.employer`).all(code);
    const totals = Object.fromEntries(EMPLOYERS.map((e) => [e, { employer: e, filled: 0, total: 0 }]));
    for (const r of rows) totals[r.employer] = { employer: r.employer, filled: r.filled, total: r.total };
    const best = Math.max(...EMPLOYERS.map((e) => totals[e].total));
    const winners = EMPLOYERS.filter((e) => totals[e].total === best);
    return { totals: EMPLOYERS.map((e) => totals[e]), winners, best };
  }

  function publicView(room, members, hiredIds) {
    const players = members.filter((m) => !m.is_spectator);
    const spectators = members.filter((m) => m.is_spectator);
    const assigned = room.phase !== 'lobby';
    const setup = assigned
      ? (() => {
          const E = players.filter((p) => p.role === 'employee').length;
          const counts = EMPLOYERS.map((g) => players.filter((p) => p.group_of === g).length).sort((a, b) => b - a);
          return { players: players.length, ready: true, employers: 3, employees: E, hires: room.hires, groupSizes: counts };
        })()
      : setupFor(players.length);
    const view = {
      code: room.code,
      phase: room.phase,
      phaseName: PHASE_NAMES[room.phase],
      round: room.round,
      version: room.version,
      minPlayers: MIN_PLAYERS,
      setup,
      spectatorCount: spectators.length,
    };
    if (!assigned) {
      view.lobby = { names: players.map((p) => p.name), spectators: spectators.map((p) => p.name) };
    } else {
      const byLabel = (a, b) => a.label.localeCompare(b.label, 'en', { numeric: true });
      view.employers = players.filter((p) => p.role === 'employer').sort(byLabel).map((p) => ({ label: p.label, name: p.name }));
      view.employees = players.filter((p) => p.role === 'employee').sort(byLabel).map((p) => ({
        label: p.label,
        name: p.name,
        ...(rank(room.phase) >= rank('hiring') ? { hired: hiredIds.has(p.id) } : {}),
      }));
    }
    if (rank(room.phase) >= rank('results')) {
      const { totals, winners } = totalsFor(room.code);
      view.results = { totals, winners, hires: room.hires };
    }
    return view;
  }

  function stateFor(code, { isHost, player }, as) {
    const room = requireRoom(code);
    const members = membersOf(code);
    const offers = q('SELECT * FROM offers WHERE room_code = ? ORDER BY created_at, id').all(code);
    const referrals = q('SELECT * FROM referrals WHERE room_code = ? ORDER BY created_at, id').all(code);
    const byId = new Map(members.map((m) => [m.id, m]));
    const hiredBy = new Map(offers.filter((o) => o.status === 'accepted').map((o) => [o.employee_id, o.employer]));
    const base = publicView(room, members, new Set(hiredBy.keys()));

    if (as === 'host') {
      if (!isHost) throw new GameError(403, 'not_host', 'Only the host can see this.');
      return { ...base, viewer: 'host', host: hostView(room, members, offers, referrals, byId, hiredBy) };
    }
    if (!player) return { ...base, viewer: 'none' };
    const me = { id: player.id, name: player.name };
    if (player.is_spectator || !player.role) {
      return { ...base, viewer: player.is_spectator ? 'spectator' : 'player', me: { ...me, role: null } };
    }
    if (player.role === 'employer') {
      return { ...base, viewer: 'player', me: { ...me, role: 'employer', label: player.label }, employer: employerView(room, player, members, offers, referrals, byId, hiredBy) };
    }
    return { ...base, viewer: 'player', me: { ...me, role: 'employee', label: player.label }, employee: employeeView(room, player, members, offers, referrals) };
  }

  function employerView(room, me, members, offers, referrals, byId, hiredBy) {
    const revealed = rank(room.phase) >= rank('results');
    const group = members.filter((m) => m.role === 'employee' && m.group_of === me.label)
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
    const sent = referrals.filter((r) => r.sender === me.label);
    const received = referrals.filter((r) => r.recipient === me.label);
    const known = new Map(received.map((r) => [r.employee_id, r.score]));
    const person = (id) => ({ label: byId.get(id).label, name: byId.get(id).name });

    const mine = offers.filter((o) => o.employer === me.label);
    const hires = mine.filter((o) => o.status === 'accepted').map((o) => ({
      ...person(o.employee_id),
      score: revealed ? byId.get(o.employee_id).score : (known.get(o.employee_id) ?? null),
    }));
    const pending = mine.filter((o) => o.status === 'pending');
    const view = {
      hires: room.hires,
      group: group.map((g) => ({ label: g.label, name: g.name, score: g.score })),
      referralsSent: sent.map((r) => ({ ...person(r.employee_id), to: r.recipient, score: r.score })),
      referralsReceived: received.map((r) => ({ ...person(r.employee_id), from: r.sender, score: r.score })),
      hired: hires,
      offers: mine.filter((o) => o.status !== 'accepted').map((o) => ({ id: o.id, ...person(o.employee_id), status: o.status })),
      slotsUsed: hires.length + pending.length,
    };
    if (rank(room.phase) >= rank('hiring')) {
      const pendingTo = new Set(pending.map((o) => o.employee_id));
      view.candidates = members
        .filter((m) => m.role === 'employee' && m.group_of !== me.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }))
        .map((m) => ({
          label: m.label,
          name: m.name,
          knownScore: known.get(m.id) ?? null,
          referredBy: received.find((r) => r.employee_id === m.id)?.sender ?? null,
          hired: hiredBy.has(m.id),
          hiredByMe: hiredBy.get(m.id) === me.label,
          pendingOffer: pendingTo.has(m.id),
        }));
    }
    if (revealed) view.myTotal = hires.reduce((s, h) => s + h.score, 0);
    return view;
  }

  function employeeView(room, me, members, offers, referrals) {
    const revealed = rank(room.phase) >= rank('results');
    const groupEmployer = members.find((m) => m.role === 'employer' && m.label === me.group_of);
    const mine = offers.filter((o) => o.employee_id === me.id);
    const job = mine.find((o) => o.status === 'accepted');
    return {
      groupEmployer: { label: me.group_of, name: groupEmployer?.name ?? '' },
      referrals: referrals.filter((r) => r.employee_id === me.id).map((r) => ({ from: r.sender, to: r.recipient })),
      offers: mine.filter((o) => o.status !== 'accepted').map((o) => ({ id: o.id, from: o.employer, status: o.status })),
      job: job ? job.employer : null,
      score: revealed ? me.score : null,
    };
  }

  function hostView(room, members, offers, referrals, byId, hiredBy) {
    const person = (id) => ({ label: byId.get(id)?.label, name: byId.get(id)?.name });
    const view = {
      hostKey: room.host_key,
      nextAction: NEXT_ACTION[room.phase] || null,
      warnings: warningsFor(room),
      members: members.map((m) => ({
        id: m.id, name: m.name, spectator: !!m.is_spectator, role: m.role, label: m.label,
        group: m.group_of, score: m.score, hiredBy: hiredBy.get(m.id) ?? null,
      })),
    };
    if (room.phase !== 'lobby') {
      view.referrals = referrals.map((r) => ({ from: r.sender, to: r.recipient, ...person(r.employee_id), score: r.score }));
      view.offers = offers.map((o) => ({ id: o.id, employer: o.employer, ...person(o.employee_id), status: o.status }));
      view.progress = EMPLOYERS.map((e) => ({
        employer: e,
        referralsSent: referrals.filter((r) => r.sender === e).length,
        filled: offers.filter((o) => o.employer === e && o.status === 'accepted').length,
        pending: offers.filter((o) => o.employer === e && o.status === 'pending').length,
      }));
      view.preview = totalsFor(room.code);
    }
    return view;
  }

  function cleanup(maxAgeMs = 48 * 3600 * 1000) {
    q('DELETE FROM rooms WHERE updated_at < ?').run(now() - maxAgeMs);
  }

  return {
    createRoom, claimHost, viewerFor, join, reclaim, playerAction, hostAction, stateFor, cleanup,
    versionOf: (code) => getRoom(code)?.version ?? null,
  };
}
