-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — Customer Finder v2: leads engine
-- Migration 0004: place_id on customers + lead_stats table
-- ═══════════════════════════════════════════════════════════════

-- Add place_id to customers (nullable — only set for Places-sourced leads)
ALTER TABLE customers ADD COLUMN place_id TEXT;

-- One Google place per firm — prevents duplicate leads
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_place
  ON customers (firm_code, place_id) WHERE place_id IS NOT NULL;

-- Lead performance stats — one row per (firm, group, query)
CREATE TABLE IF NOT EXISTS lead_stats (
  firm_code    TEXT NOT NULL,
  group_name   TEXT NOT NULL,
  query        TEXT NOT NULL DEFAULT '',
  found        INTEGER NOT NULL DEFAULT 0,
  thumbs_up    INTEGER NOT NULL DEFAULT 0,
  thumbs_down  INTEGER NOT NULL DEFAULT 0,
  contacted    INTEGER NOT NULL DEFAULT 0,
  replied      INTEGER NOT NULL DEFAULT 0,
  won          INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (firm_code, group_name, query)
);
