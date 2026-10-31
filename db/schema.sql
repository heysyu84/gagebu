-- Independent convenience store ledger. Run on a newly created Cloudflare D1 database.
CREATE TABLE IF NOT EXISTS ledger_data (
  ledger_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ledger_data(ledger_key, version, content)
VALUES('main', 0, '{"schema":"store-ledger-v1","transactions":[],"dailyLotto":[],"sourceTitle":"","exportedAt":""}');

CREATE TABLE IF NOT EXISTS ledger_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_sessions_exp ON ledger_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  previous_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);