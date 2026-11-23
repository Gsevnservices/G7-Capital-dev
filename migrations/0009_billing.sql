-- 0009_billing.sql — Razorpay billing tables
-- billing: one row per firm, tracks plan status and Razorpay IDs
-- billing_events: webhook + admin event log with duplicate rejection

CREATE TABLE IF NOT EXISTS billing (
  firm_code       TEXT PRIMARY KEY,
  plan            TEXT NOT NULL DEFAULT 'monthly',   -- 'monthly' or 'yearly'
  status          TEXT NOT NULL DEFAULT 'none',      -- none, active, past_due, cancelled, refunded, expired
  razorpay_customer_id    TEXT,
  razorpay_subscription_id TEXT,
  razorpay_payment_id     TEXT,
  current_period_end      TEXT,                      -- ISO datetime
  first_paid_at           TEXT,                      -- ISO datetime — used for 7-day refund window
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0, -- 1 = will cancel when period ends
  refunded_at             TEXT,                      -- ISO datetime — set once, never cleared
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT UNIQUE,                             -- Razorpay event ID or admin-generated UUID
  type      TEXT NOT NULL,                           -- e.g. subscription.activated, admin.activate
  firm_code TEXT NOT NULL,
  payload_json TEXT,                                 -- raw webhook payload or admin context
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_events_firm ON billing_events (firm_code, at);
