-- Migration 003: persistent operator warnings. This migration is additive only.

CREATE TABLE IF NOT EXISTS early_warnings (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MODERATE', 'HIGH')),
  explanation TEXT NOT NULL,
  supporting_evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_at TEXT,
  resolved_at TEXT,
  operator_notes TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_early_warnings_machine_state_updated
  ON early_warnings(machine_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_early_warnings_machine_category_state
  ON early_warnings(machine_id, category, state);
