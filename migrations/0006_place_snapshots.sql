-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — "How people find you on Google"
-- Migration 0006: weekly place snapshots for competitor tracking
-- ═══════════════════════════════════════════════════════════════

-- Weekly snapshots of nearby same-type businesses
CREATE TABLE IF NOT EXISTS place_snapshots (
  firm_code    TEXT NOT NULL,
  place_id     TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  rating       REAL NOT NULL DEFAULT 0,
  reviews      INTEGER NOT NULL DEFAULT 0,
  seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (firm_code, place_id, seen_at)
);

-- Fast lookup: snapshots for a firm, most recent first
CREATE INDEX IF NOT EXISTS idx_place_snapshots_firm
  ON place_snapshots (firm_code, seen_at DESC);
