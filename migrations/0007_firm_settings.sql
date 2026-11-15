-- 0007_firm_settings.sql
-- Strongly consistent per-firm settings (replaces KV for owner-edited values).
-- Each row is one setting; concurrent writes to different keys cannot overwrite each other.

CREATE TABLE IF NOT EXISTS firm_settings (
  firm_code TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  value_json TEXT   NOT NULL DEFAULT '{}',
  updated_at TEXT   NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (firm_code, key)
);
