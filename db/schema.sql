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

-- Owner-approved MCP connections. Only token hashes are stored.
CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL, scope TEXT NOT NULL, challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  access_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL,
  scope TEXT NOT NULL, access_expires INTEGER NOT NULL, refresh_expires INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mcp_used_refresh (
  refresh_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_public_limits (
  bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS management_changes (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, identity_json TEXT NOT NULL,
  reason TEXT NOT NULL, version_before INTEGER NOT NULL, version_after INTEGER NOT NULL,
  created_at TEXT NOT NULL, undo_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_management_changes_recent ON management_changes(created_at DESC);
