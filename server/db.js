import { DatabaseSync } from 'node:sqlite';

// The schema doubles as a second line of defence: the triggers below re-check
// the rules the game code already enforces, so a logic bug cannot produce an
// out-of-phase action, an over-limit referral or offer, or a double hire.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT PRIMARY KEY,
  host_key    TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'lobby'
              CHECK (phase IN ('lobby','reveal','networking','hiring','results','discussion')),
  hires       INTEGER CHECK (hires IS NULL OR hires >= 1),
  version     INTEGER NOT NULL DEFAULT 1,
  round       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_sessions (
  token_hash  TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  claim_hash    TEXT,
  claim_expires INTEGER,
  is_spectator  INTEGER NOT NULL DEFAULT 0 CHECK (is_spectator IN (0,1)),
  role          TEXT CHECK (role IN ('employer','employee')),
  label         TEXT,
  group_of      TEXT CHECK (group_of IN ('A','B','C')),
  score         INTEGER CHECK (score BETWEEN 1 AND 10),
  joined_at     INTEGER NOT NULL,
  UNIQUE (room_code, name_key),
  UNIQUE (room_code, label),
  CHECK (role IS NOT 'employee' OR (group_of IS NOT NULL AND score IS NOT NULL)),
  CHECK (role IS NOT 'employer' OR (group_of IS NULL AND score IS NULL))
);

CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  sender      TEXT NOT NULL CHECK (sender IN ('A','B','C')),
  recipient   TEXT NOT NULL CHECK (recipient IN ('A','B','C')),
  employee_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at  INTEGER NOT NULL,
  CHECK (sender <> recipient),
  UNIQUE (room_code, sender, employee_id)
);

CREATE TABLE IF NOT EXISTS offers (
  id          TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  employer    TEXT NOT NULL CHECK (employer IN ('A','B','C')),
  employee_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status      TEXT NOT NULL
              CHECK (status IN ('pending','accepted','declined','withdrawn','closed','expired')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_job ON offers(employee_id) WHERE status = 'accepted';
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_pending_pair ON offers(room_code, employer, employee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS offers_room ON offers(room_code);
CREATE INDEX IF NOT EXISTS referrals_room ON referrals(room_code);
CREATE INDEX IF NOT EXISTS players_room ON players(room_code);

CREATE TABLE IF NOT EXISTS action_log (
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, actor, request_id)
);

CREATE TRIGGER IF NOT EXISTS rooms_phase_order BEFORE UPDATE OF phase ON rooms
WHEN NEW.phase <> OLD.phase AND NEW.phase <> 'lobby' AND NOT (
     (OLD.phase = 'lobby'      AND NEW.phase = 'reveal')
  OR (OLD.phase = 'reveal'     AND NEW.phase = 'networking')
  OR (OLD.phase = 'networking' AND NEW.phase = 'hiring')
  OR (OLD.phase = 'hiring'     AND NEW.phase = 'results')
  OR (OLD.phase = 'results'    AND NEW.phase = 'discussion'))
BEGIN
  SELECT RAISE(ABORT, 'RR:bad_transition');
END;

CREATE TRIGGER IF NOT EXISTS referrals_guard BEFORE INSERT ON referrals
BEGIN
  SELECT RAISE(ABORT, 'RR:wrong_phase')
    WHERE (SELECT phase FROM rooms WHERE code = NEW.room_code) <> 'networking';
  SELECT RAISE(ABORT, 'RR:referral_limit')
    WHERE (SELECT COUNT(*) FROM referrals WHERE room_code = NEW.room_code AND sender = NEW.sender)
       >= (SELECT hires FROM rooms WHERE code = NEW.room_code);
  SELECT RAISE(ABORT, 'RR:not_in_group')
    WHERE NOT EXISTS (SELECT 1 FROM players
                      WHERE id = NEW.employee_id AND room_code = NEW.room_code
                        AND role = 'employee' AND group_of = NEW.sender AND score = NEW.score);
END;

CREATE TRIGGER IF NOT EXISTS offers_insert_guard BEFORE INSERT ON offers
BEGIN
  SELECT RAISE(ABORT, 'RR:wrong_phase')
    WHERE (SELECT phase FROM rooms WHERE code = NEW.room_code) <> 'hiring';
  SELECT RAISE(ABORT, 'RR:bad_status') WHERE NEW.status <> 'pending';
  SELECT RAISE(ABORT, 'RR:not_eligible')
    WHERE NOT EXISTS (SELECT 1 FROM players
                      WHERE id = NEW.employee_id AND room_code = NEW.room_code
                        AND role = 'employee' AND group_of <> NEW.employer);
  SELECT RAISE(ABORT, 'RR:already_hired')
    WHERE EXISTS (SELECT 1 FROM offers WHERE employee_id = NEW.employee_id AND status = 'accepted');
  SELECT RAISE(ABORT, 'RR:no_slots')
    WHERE (SELECT COUNT(*) FROM offers WHERE room_code = NEW.room_code AND employer = NEW.employer
             AND status IN ('pending','accepted'))
       >= (SELECT hires FROM rooms WHERE code = NEW.room_code);
END;

CREATE TRIGGER IF NOT EXISTS offers_update_guard BEFORE UPDATE OF status ON offers
BEGIN
  SELECT RAISE(ABORT, 'RR:offer_closed') WHERE OLD.status <> 'pending';
  SELECT RAISE(ABORT, 'RR:wrong_phase')
    WHERE NEW.status IN ('accepted','declined','withdrawn','closed')
      AND (SELECT phase FROM rooms WHERE code = NEW.room_code) <> 'hiring';
END;
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}
