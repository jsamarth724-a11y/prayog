-- Migration 006: persist evidence-backed job deviations without auto-resolution.

CREATE TABLE IF NOT EXISTS job_deviations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('MODERATE', 'HIGH')),
  explanation TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  observed_behavior TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  latest_detected_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RESOLVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_deviations_active_category
  ON job_deviations(job_id, category) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_job_deviations_machine_state
  ON job_deviations(machine_id, state, latest_detected_at DESC);
