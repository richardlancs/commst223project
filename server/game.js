import crypto from 'node:crypto';

export const PHASES = ['lobby', 'reveal', 'networking', 'hiring', 'results', 'discussion'];
export const MIN_PLAYERS = 3;
export const RECOMMENDED_PLAYERS = 6;
export const BANK_PER_PLAYER = 4; // each employer privately knows this many candidates
export const HIRES = 2;           // positions each employer fills
export const MAX_MEMBERS = 80;    // players + spectators per room
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

const FIRST_NAMES = ['Avery', 'Bea', 'Cal', 'Dara', 'Eli', 'Fern', 'Gus', 'Hana', 'Ira', 'Jo', 'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Pia',
  'Quinn', 'Rosa', 'Sol', 'Tess', 'Umi', 'Vic', 'Wren', 'Xavi', 'Yara', 'Zed', 'Ines', 'Theo', 'Maya', 'Raj', 'Lou', 'Noor', 'Ezra', 'Ada',
  'Bo', 'Cleo', 'Dev', 'Esme', 'Femi', 'Gita'];
const LAST_NAMES = ['Abbott', 'Brook', 'Cruz', 'Doyle', 'Ekwueme', 'Fenwick', 'Garza', 'Holt', 'Ito', 'Jansen', 'Kowalski', 'Lindqvist', 'Moreau',
  'Nakamura', 'Okafor', 'Pell', 'Quint', 'Rossi', 'Sato', 'Tran', 'Ueda', 'Varga', 'Whitlock', 'Xu', 'Yilmaz', 'Zhou', 'Achebe', 'Banerjee',
  'Castillo', 'Dunmore', 'Eriksen', 'Faraday', 'Gallo', 'Haddad', 'Iqbal', 'Juarez', 'Kim', 'Laurent', 'Mbeki', 'Novak'];

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
  not_in_group: 'You can only refer candidates from your own private file.',
  bad_recipient: 'Send the referral to another employer in this room.',
  already_hired: 'Another employer has already hired that candidate.',
  own_group: 'You cannot hire candidates from your own private file.',
  no_slots: 'All your positions are filled.',
  not_employer: 'Only employers can hire.',
  bad_transition: 'That phase change is not allowed.',
};

// ---------- pure helpers ----------

/** Spreadsheet-style employer labels: A … Z, AA, AB … */
export function employerLabel(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function setupFor(playerCount) {
  if (playerCount < MIN_PLAYERS) return { players: playerCount, ready: false, needed: MIN_PLAYERS - playerCount };
  return { players: playerCount, ready: true, employers: playerCount, bank: playerCount * BANK_PER_PLAYER, groupSize: BANK_PER_PLAYER, hires: HIRES };
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

// Stratified scores: one draw from each of n equal slices of the 1–10 range,
// so every game has a spread of weak, middling and strong candidates.
export function makeScores(n) {
  const scores = [];
  for (let i = 0; i < n; i++) scores.push(Math.min(10, 1 + Math.floor(((i + unit()) / n) * 10)));
  return scores;
}

export function candidateNames(n) {
  const all = [];
  for (const f of FIRST_NAMES) for (const l of LAST_NAMES) all.push(`${f} ${l}`);
  return shuffle(all).slice(0, n);
}

/**
 * Every player becomes an employer. The bank holds BANK_PER_PLAYER candidates per
 * employer; each employer privately knows one group. Labels, groups and scores come
 * from independent shuffles, and scores are snake-dealt so groups are roughly even.
 */
export function assignRoles(playerIds) {
  if (playerIds.length < MIN_PLAYERS) throw new GameError(409, 'need_players', `At least ${MIN_PLAYERS} players are needed.`);
  const employers = shuffle(playerIds).map((id, i) => ({ id, label: employerLabel(i) }));
  const labels = employers.map((e) => e.label);
  const total = labels.length * BANK_PER_PLAYER;

  const names = candidateNames(total);
  const bank = shuffle(Array.from({ length: total }, (_, i) => ({ label: `E${i + 1}`, name: names[i] })));
  const groups = Object.fromEntries(labels.map((l, k) => [l, bank.slice(k * BANK_PER_PLAYER, (k + 1) * BANK_PER_PLAYER)]));

  const sorted = makeScores(total).sort((a, b) => b - a);
  const pools = Object.fromEntries(labels.map((l) => [l, []]));
  let seq = shuffle(labels);
  let i = 0;
  while (i < sorted.length) {
    for (const g of seq) if (i < sorted.length && pools[g].length < BANK_PER_PLAYER) pools[g].push(sorted[i++]);
    seq = [...seq].reverse();
  }
  const candidates = [];
  for (const g of labels) {
    const scores = shuffle(pools[g]);
    groups[g].forEach((c, k) => candidates.push({ ...c, group: g, score: scores[k] }));
  }
  return { employers, candidates, hires: HIRES };
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
const byLabel = (a, b) => a.label.localeCompare(b.label, 'en', { numeric: true });
const byEmployer = (a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label);

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
    if (/UNIQUE constraint failed: referrals/.test(err?.message)) return new GameError(409, 'duplicate_referral', 'You already sent that referral to that employer.');
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
  const candidatesOf = (code) => q('SELECT * FROM candidates WHERE room_code = ?').all(code).sort(byLabel);

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

  // ----- player (employer) actions -----

  function playerAction(code, player, input) {
    if (!player) throw new GameError(401, 'no_session', 'Join the game first.');
    const { type, requestId } = input || {};
    return runAction(code, `p:${player.id}`, requestId, () => {
      // Re-read inside the transaction: never act on a stale player or phase.
      const room = requireRoom(code);
      const me = q('SELECT * FROM players WHERE id = ? AND room_code = ?').get(player.id, code);
      if (!me) throw new GameError(401, 'no_session', 'You are no longer in this game.');
      if (me.is_spectator || !me.label) throw new GameError(403, 'spectator', 'Observers cannot take actions.');
      switch (type) {
        case 'referral': return sendReferral(room, me, input);
        case 'hire': return hire(room, me, input);
        default: throw new GameError(400, 'bad_action', 'Unknown action.');
      }
    });
  }

  const requirePhase = (room, phase) => {
    if (room.phase !== phase) throw new GameError(409, 'wrong_phase', `That is only allowed during ${PHASE_NAMES[phase].toLowerCase()}. The game is in ${PHASE_NAMES[room.phase].toLowerCase()}.`);
  };
  const candidateByLabel = (code, label) =>
    typeof label === 'string' ? q('SELECT * FROM candidates WHERE room_code = ? AND label = ?').get(code, label) : null;

  function sendReferral(room, me, { candidate, to }) {
    requirePhase(room, 'networking');
    const c = candidateByLabel(room.code, candidate);
    if (!c) throw new GameError(404, 'no_candidate', 'No candidate with that ID.');
    if (c.group_of !== me.label) throw new GameError(403, 'not_in_group', 'You can only refer candidates from your own private file.');
    const recipient = typeof to === 'string' ? q('SELECT * FROM players WHERE room_code = ? AND label = ? AND is_spectator = 0').get(room.code, to) : null;
    if (!recipient || recipient.label === me.label) throw new GameError(400, 'bad_recipient', 'Send the referral to another employer in this room.');
    if (q('SELECT 1 AS x FROM referrals WHERE room_code = ? AND sender = ? AND recipient = ? AND candidate_id = ?').get(room.code, me.label, to, c.id)) {
      throw new GameError(409, 'duplicate_referral', 'You already sent that referral to that employer.');
    }
    q('INSERT INTO referrals (id, room_code, sender, recipient, candidate_id, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), room.code, me.label, to, c.id, c.score, now());
    return { ok: true, message: `Referral sent: ${c.label} to Employer ${to}.` };
  }

  function hire(room, me, { candidate }) {
    requirePhase(room, 'hiring');
    const c = candidateByLabel(room.code, candidate);
    if (!c) throw new GameError(404, 'no_candidate', 'No candidate with that ID.');
    if (c.group_of === me.label) throw new GameError(403, 'own_group', 'You cannot hire candidates from your own private file.');
    if (c.hired_by) throw new GameError(409, 'already_hired', 'Another employer has already hired that candidate.');
    const filled = q('SELECT COUNT(*) AS n FROM candidates WHERE room_code = ? AND hired_by = ?').get(room.code, me.label).n;
    if (filled >= room.hires) throw new GameError(409, 'no_slots', 'All your positions are filled.');
    // Conditional update: if someone else got there first, nothing changes.
    const res = q('UPDATE candidates SET hired_by = ?, hired_at = ? WHERE id = ? AND hired_by IS NULL').run(me.label, now(), c.id);
    if (res.changes !== 1) throw new GameError(409, 'already_hired', 'Another employer has already hired that candidate.');
    return { ok: true, message: `You hired ${c.label}, ${c.name}.`, candidate: c.label, name: c.name };
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
    if (room.phase !== 'hiring') return [];
    const employers = q('SELECT label FROM players WHERE room_code = ? AND is_spectator = 0 AND label IS NOT NULL').all(room.code).sort(byEmployer);
    const open = [];
    for (const e of employers) {
      const filled = q('SELECT COUNT(*) AS n FROM candidates WHERE room_code = ? AND hired_by = ?').get(room.code, e.label).n;
      if (filled < room.hires) open.push(`Employer ${e.label} has filled ${filled} of ${room.hires} positions.`);
    }
    if (open.length > 6) return [`${open.length} employers still have open positions.`, ...open.slice(0, 5), `…and ${open.length - 5} more.`];
    return open;
  }

  function advance(room, { from, confirm }) {
    if (from !== room.phase) {
      throw new GameError(409, 'stale_phase', `The game has already moved to ${PHASE_NAMES[room.phase].toLowerCase()}.`);
    }
    const next = PHASES[rank(room.phase) + 1];
    if (!next) throw new GameError(409, 'no_next', 'This is the last phase. Reset to play again.');
    if (room.phase === 'lobby') {
      const ids = q('SELECT id FROM players WHERE room_code = ? AND is_spectator = 0').all(room.code).map((r) => r.id);
      const { employers, candidates, hires } = assignRoles(ids);
      for (const e of employers) q('UPDATE players SET label = ? WHERE id = ?').run(e.label, e.id);
      for (const c of candidates) {
        q('INSERT INTO candidates (id, room_code, label, name, group_of, score) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId(), room.code, c.label, c.name, c.group, c.score);
      }
      q('UPDATE rooms SET hires = ? WHERE code = ?').run(hires, room.code);
    } else {
      const warnings = warningsFor(room);
      if (warnings.length && confirm !== true) {
        throw new GameError(409, 'needs_confirm', 'Some positions are unfilled.', { warnings });
      }
    }
    q('UPDATE rooms SET phase = ? WHERE code = ?').run(next, room.code);
    return { ok: true, phase: next };
  }

  function reset(room, { confirm }) {
    if (confirm !== true) throw new GameError(400, 'needs_confirm', 'Confirm the reset.');
    q('DELETE FROM referrals WHERE room_code = ?').run(room.code);
    q('DELETE FROM candidates WHERE room_code = ?').run(room.code);
    q('UPDATE players SET label = NULL, is_spectator = 0 WHERE room_code = ?').run(room.code);
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

  function totalsFor(code, employers) {
    const rows = q(`SELECT hired_by AS employer, COUNT(*) AS filled, SUM(score) AS total
                    FROM candidates WHERE room_code = ? AND hired_by IS NOT NULL GROUP BY hired_by`).all(code);
    const map = new Map(rows.map((r) => [r.employer, r]));
    const totals = employers.map((e) => ({ employer: e.label, name: e.name, filled: map.get(e.label)?.filled ?? 0, total: map.get(e.label)?.total ?? 0 }));
    const best = Math.max(0, ...totals.map((t) => t.total));
    const winners = totals.filter((t) => t.total === best).map((t) => t.employer);
    totals.sort((a, b) => b.total - a.total || byEmployer({ label: a.employer }, { label: b.employer }));
    return { totals, winners, best };
  }

  function publicView(room, members, bank) {
    const players = members.filter((m) => !m.is_spectator);
    const spectators = members.filter((m) => m.is_spectator);
    const assigned = room.phase !== 'lobby';
    const view = {
      code: room.code,
      phase: room.phase,
      phaseName: PHASE_NAMES[room.phase],
      round: room.round,
      version: room.version,
      minPlayers: MIN_PLAYERS,
      recommendedPlayers: RECOMMENDED_PLAYERS,
      setup: assigned ? { ...setupFor(players.length), bank: bank.length, hires: room.hires } : setupFor(players.length),
      spectatorCount: spectators.length,
    };
    if (!assigned) {
      view.lobby = { names: players.map((p) => p.name), spectators: spectators.map((p) => p.name) };
    } else {
      view.employers = players.filter((p) => p.label).map((p) => ({ label: p.label, name: p.name })).sort(byEmployer);
      if (rank(room.phase) >= rank('hiring')) view.hiredCount = bank.filter((c) => c.hired_by).length;
    }
    if (rank(room.phase) >= rank('results')) {
      const { totals, winners } = totalsFor(room.code, view.employers);
      view.results = { totals, winners, hires: room.hires };
    }
    return view;
  }

  function stateFor(code, { isHost, player }, as) {
    const room = requireRoom(code);
    const members = membersOf(code);
    const bank = candidatesOf(code);
    const referrals = q('SELECT * FROM referrals WHERE room_code = ? ORDER BY created_at, id').all(code);
    const base = publicView(room, members, bank);

    if (as === 'host') {
      if (!isHost) throw new GameError(403, 'not_host', 'Only the host can see this.');
      return { ...base, viewer: 'host', host: hostView(room, members, bank, referrals, base.employers) };
    }
    if (!player) return { ...base, viewer: 'none' };
    const me = { id: player.id, name: player.name };
    if (player.is_spectator || !player.label) {
      return { ...base, viewer: player.is_spectator ? 'spectator' : 'player', me: { ...me, role: null } };
    }
    return { ...base, viewer: 'player', me: { ...me, role: 'employer', label: player.label }, employer: employerView(room, player, bank, referrals) };
  }

  function employerView(room, me, bank, referrals) {
    const revealed = rank(room.phase) >= rank('results');
    const byId = new Map(bank.map((c) => [c.id, c]));
    const sent = referrals.filter((r) => r.sender === me.label);
    const received = referrals.filter((r) => r.recipient === me.label);
    const known = new Map(received.map((r) => [r.candidate_id, r.score]));
    const person = (id) => ({ label: byId.get(id).label, name: byId.get(id).name });
    const hired = bank.filter((c) => c.hired_by === me.label).sort((a, b) => a.hired_at - b.hired_at);

    const view = {
      hires: room.hires,
      group: bank.filter((c) => c.group_of === me.label).map((c) => ({ label: c.label, name: c.name, score: c.score, taken: !!c.hired_by })),
      referralsSent: sent.map((r) => ({ ...person(r.candidate_id), to: r.recipient, score: r.score })),
      referralsReceived: received.map((r) => ({ ...person(r.candidate_id), from: r.sender, score: r.score })),
      hired: hired.map((c) => ({ label: c.label, name: c.name, score: revealed ? c.score : (known.get(c.id) ?? null) })),
    };
    if (rank(room.phase) >= rank('hiring')) {
      view.candidates = bank.filter((c) => c.group_of !== me.label).map((c) => ({
        label: c.label,
        name: c.name,
        knownScore: known.get(c.id) ?? null,
        referredBy: received.find((r) => r.candidate_id === c.id)?.sender ?? null,
        taken: !!c.hired_by,
        takenByMe: c.hired_by === me.label,
      }));
    }
    if (revealed) view.myTotal = hired.reduce((s, c) => s + c.score, 0);
    return view;
  }

  function hostView(room, members, bank, referrals, employers) {
    const byId = new Map(bank.map((c) => [c.id, c]));
    const view = {
      hostKey: room.host_key,
      nextAction: NEXT_ACTION[room.phase] || null,
      warnings: warningsFor(room),
      members: members.map((m) => ({ id: m.id, name: m.name, spectator: !!m.is_spectator, label: m.label })),
    };
    if (room.phase !== 'lobby') {
      view.bank = bank.map((c) => ({ label: c.label, name: c.name, group: c.group_of, score: c.score, hiredBy: c.hired_by }));
      view.referrals = referrals.map((r) => ({ from: r.sender, to: r.recipient, label: byId.get(r.candidate_id)?.label, name: byId.get(r.candidate_id)?.name, score: r.score }));
      view.progress = (employers || []).map((e) => ({
        employer: e.label,
        name: e.name,
        referralsSent: referrals.filter((r) => r.sender === e.label).length,
        referralsReceived: referrals.filter((r) => r.recipient === e.label).length,
        filled: bank.filter((c) => c.hired_by === e.label).length,
      }));
      view.preview = totalsFor(room.code, employers || []);
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
