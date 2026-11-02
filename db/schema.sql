-- Independent convenience store ledger. Run on a newly created Cloudflare D1 database.
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

-- Durable V2 documents, immutable revisions and backup history.
CREATE TABLE IF NOT EXISTS ledger_documents (
  ledger_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  revision TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO ledger_documents(ledger_key) VALUES('main-v2');
CREATE TABLE IF NOT EXISTS ledger_document_chunks (
  ledger_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  part INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(ledger_key,revision,part)
);
CREATE TABLE IF NOT EXISTS ledger_document_history (
  ledger_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  revision TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(ledger_key,version)
);
