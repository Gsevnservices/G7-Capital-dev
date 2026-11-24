-- 0011_signups.sql — Track pending sign-up → firm creation (idempotent guard)
CREATE TABLE IF NOT EXISTS signups (
  pending_id    TEXT PRIMARY KEY,
  firm_code     TEXT,
  status        TEXT NOT NULL DEFAULT 'creating',   -- creating, done, failed
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
