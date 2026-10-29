-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — Customers on D1
-- Migration 0001: customers + customer_events
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS customers (
  firm_code  TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  phone      TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT '',
  stage      TEXT    NOT NULL DEFAULT 'contacted',
  source     TEXT    NOT NULL DEFAULT 'manual',
  value      REAL    NOT NULL DEFAULT 0,
  next_action_at TEXT,
  data       TEXT    NOT NULL DEFAULT '{}',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  PRIMARY KEY (firm_code, id)
);

CREATE INDEX IF NOT EXISTS idx_customers_stage
  ON customers (firm_code, stage);

CREATE INDEX IF NOT EXISTS idx_customers_updated
  ON customers (firm_code, updated_at);

CREATE INDEX IF NOT EXISTS idx_customers_phone
  ON customers (firm_code, phone);

CREATE TABLE IF NOT EXISTS customer_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_code   TEXT    NOT NULL,
  customer_id TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'stage_change',
  from_stage  TEXT,
  to_stage    TEXT,
  note        TEXT    NOT NULL DEFAULT '',
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_customer
  ON customer_events (firm_code, customer_id);
