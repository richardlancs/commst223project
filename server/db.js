import { DatabaseSync } from 'node:sqlite';

// Schema version 2: every player is an employer; candidates are a computer-run bank.
// Games are short-lived, so an older database is simply rebuilt.
const SCHEMA_VERSION = 2;

// The triggers re-check the rules the game code already enforces, so a logic bug
// cannot produce an out-of-phase action, an own-group hire, an over-limit hire,
// a double hire or an untruthful referral.
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

-- Players. Once roles are assigned, every non-spectator is an employer with a label (A, B, … AA).
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  claim_hash    TEXT,
  claim_expires INTEGER,
  is_spectator  INTEGER NOT NULL DEFAULT 0 CHECK (is_spectator IN (0,1)),
  label         TEXT,
  joined_at     INTEGER NOT NULL,
  UNIQUE (room_code, name_key),
  UNIQUE (room_code, label)
);

-- The candidate bank. group_of is the employer who privately knows this score.
CREATE TABLE IF NOT EXISTS candidates (
  id          TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  name        TEXT NOT NULL,
  group_of    TEXT NOT NULL,
  score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  hired_by    TEXT,
  hired_at    INTEGER,
  UNIQUE (room_code, label),
  CHECK (hired_by IS NULL OR hired_by <> group_of)
);
CREATE INDEX IF NOT EXISTS candidates_room ON candidates(room_code);

CREATE TABLE IF NOT EXISTS referrals (
  id           TEXT PRIMARY KEY,
  room_code    TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  score        INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at   INTEGER NOT NULL,
  CHECK (sender <> recipient),
  UNIQUE (room_code, sender, recipient, candidate_id)
);
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
  SELECT RAISE(ABORT, 'RR:not_in_group')
    WHERE NOT EXISTS (SELECT 1 FROM candidates
                      WHERE id = NEW.candidate_id AND room_code = NEW.room_code
                        AND group_of = NEW.sender AND score = NEW.score);
  SELECT RAISE(ABORT, 'RR:bad_recipient')
    WHERE NOT EXISTS (SELECT 1 FROM players WHERE room_code = NEW.room_code AND label = NEW.recipient AND is_spectator = 0);
END;

CREATE TRIGGER IF NOT EXISTS candidates_hire_guard BEFORE UPDATE OF hired_by ON candidates
BEGIN
  SELECT RAISE(ABORT, 'RR:already_hired') WHERE OLD.hired_by IS NOT NULL;
  SELECT RAISE(ABORT, 'RR:wrong_phase')
    WHERE (SELECT phase FROM rooms WHERE code = NEW.room_code) <> 'hiring';
  SELECT RAISE(ABORT, 'RR:own_group') WHERE NEW.hired_by = OLD.group_of;
  SELECT RAISE(ABORT, 'RR:not_employer')
    WHERE NOT EXISTS (SELECT 1 FROM players WHERE room_code = NEW.room_code AND label = NEW.hired_by AND is_spectator = 0);
  SELECT RAISE(ABORT, 'RR:no_slots')
    WHERE (SELECT COUNT(*) FROM candidates WHERE room_code = NEW.room_code AND hired_by = NEW.hired_by)
       >= (SELECT hires FROM rooms WHERE code = NEW.room_code);
END;
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version !== SCHEMA_VERSION) {
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
