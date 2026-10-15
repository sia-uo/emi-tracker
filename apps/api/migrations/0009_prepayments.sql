-- Prepayments and foreclosures the user actually made. They change the stored schedule: each is
-- applied right after the last instalment billed on or before paid_date. applied_amount,
-- charges and after_n are written back whenever the schedule is regenerated.
CREATE TABLE prepayments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  paid_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('part', 'foreclosure')),
  amount INTEGER CHECK (amount IS NULL OR amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('reduce_tenure', 'reduce_emi')),
  charge TEXT NOT NULL DEFAULT '{"kind":"none"}',
  charge_tax_rate REAL NOT NULL DEFAULT 0,
  note TEXT,
  applied_amount INTEGER NOT NULL DEFAULT 0,
  charges INTEGER NOT NULL DEFAULT 0,
  after_n INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_prepayments_loan ON prepayments(loan_id);
CREATE INDEX idx_prepayments_user_date ON prepayments(user_id, paid_date);
