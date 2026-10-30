-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — Error observability
-- Migration 0003: errors table for worker + client error tracking
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  route      TEXT    NOT NULL DEFAULT '',
  firm_code  TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT '',
  message    TEXT    NOT NULL DEFAULT '',
  hash       TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  first_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_errors_dedup
  ON errors (day, hash);

CREATE INDEX IF NOT EXISTS idx_errors_day
  ON errors (day, count DESC);
