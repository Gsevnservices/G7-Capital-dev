-- 0008_link_clicks.sql
-- Tracked link redirects (/go/{code}). No IP or personal data stored.
-- ip_day_hash is SHA-256(ip + daily_salt) for unique-visitor counting.

CREATE TABLE IF NOT EXISTS link_clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_code   TEXT    NOT NULL,
  link_code   TEXT    NOT NULL,
  lead_id     TEXT,
  kind        TEXT    NOT NULL DEFAULT 'general',
  ip_day_hash TEXT    NOT NULL DEFAULT '',
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_code
  ON link_clicks (link_code, at);

CREATE INDEX IF NOT EXISTS idx_link_clicks_firm
  ON link_clicks (firm_code, at);

-- Tracked links registered per firm.
-- code is the opaque slug used in /go/{code}.
-- kind: 'regulars_qr', 'review_qr', 'my_link', 'lead_link'
CREATE TABLE IF NOT EXISTS tracked_links (
  firm_code TEXT NOT NULL,
  code      TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL DEFAULT 'general',
  url       TEXT NOT NULL DEFAULT '',
  lead_id   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (firm_code, code)
);
