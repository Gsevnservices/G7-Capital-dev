-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — Customers on D1
-- Migration 0002: add synced_at (server-stamped on every upsert)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE customers ADD COLUMN synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE INDEX IF NOT EXISTS idx_customers_synced
  ON customers (firm_code, synced_at);
