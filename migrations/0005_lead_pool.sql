-- ═══════════════════════════════════════════════════════════════
-- G7 Scout — Customer Finder v2: candidate pool
-- Migration 0005: lead_pool table for caching filtered candidates
-- ═══════════════════════════════════════════════════════════════

-- Candidate pool — stores filtered Places results not yet promoted to leads
CREATE TABLE IF NOT EXISTS lead_pool (
  firm_code    TEXT NOT NULL,
  place_id     TEXT NOT NULL,
  group_name   TEXT NOT NULL,
  query        TEXT NOT NULL DEFAULT '',
  facts        TEXT NOT NULL DEFAULT '{}',   -- JSON: name, types, primaryType, location, rating, ratingCount, businessStatus
  found_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_code, place_id)
);

-- Fast lookup: pool candidates for a firm, ordered by freshness
CREATE INDEX IF NOT EXISTS idx_lead_pool_firm
  ON lead_pool (firm_code, found_at DESC);
