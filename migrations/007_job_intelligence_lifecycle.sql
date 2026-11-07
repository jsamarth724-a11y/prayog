-- Migration 007: add deviation lifecycle, root-cause, comparison, and completion evidence.

CREATE TABLE job_deviations_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('MODERATE', 'HIGH')),
  explanation TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  observed_behavior TEXT NOT NULL,
  initial_evidence TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  latest_detected_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_at TEXT,
  resolved_at TEXT,
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);

INSERT INTO job_deviations_v2 (
  id, job_id, machine_id, category, severity, explanation, expected_behavior,
  observed_behavior, initial_evidence, evidence, recommended_action, first_detected_at,
  latest_detected_at, state, acknowledged_at, resolved_at, operator_notes,
  created_at, updated_at
)
SELECT id, job_id, machine_id, category, severity, explanation, expected_behavior,
       observed_behavior, evidence, evidence, recommended_action, first_detected_at,
       latest_detected_at, state, NULL,
       CASE WHEN state = 'RESOLVED' THEN updated_at ELSE NULL END,
       NULL, created_at, updated_at
FROM job_deviations;

DROP TABLE job_deviations;
ALTER TABLE job_deviations_v2 RENAME TO job_deviations;

CREATE UNIQUE INDEX idx_job_deviations_open_category
  ON job_deviations(job_id, category)
  WHERE state IN ('ACTIVE', 'ACKNOWLEDGED');
CREATE INDEX idx_job_deviations_machine_state
  ON job_deviations(machine_id, state, latest_detected_at DESC);

CREATE TABLE deviation_lifecycle_events (
  id TEXT PRIMARY KEY,
  deviation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  from_state TEXT NOT NULL CHECK (from_state IN ('ACTIVE', 'ACKNOWLEDGED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('ACKNOWLEDGED', 'RESOLVED')),
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (deviation_id) REFERENCES job_deviations(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE INDEX idx_deviation_events_history
  ON deviation_lifecycle_events(deviation_id, created_at, id);

CREATE TABLE root_cause_reports (
  id TEXT PRIMARY KEY,
  deviation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  evidence_fingerprint TEXT NOT NULL,
  observed_facts TEXT NOT NULL,
  report TEXT,
  error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (deviation_id) REFERENCES job_deviations(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_root_reports_nonfailed_fingerprint
  ON root_cause_reports(deviation_id, evidence_fingerprint)
  WHERE status IN ('PENDING', 'COMPLETED');
CREATE INDEX idx_root_reports_deviation_history
  ON root_cause_reports(deviation_id, created_at DESC);

CREATE TABLE job_comparisons (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  classification TEXT NOT NULL
    CHECK (classification IN ('CONSISTENT', 'DEVIATION_DETECTED', 'UNCERTAIN', 'NOT_MEASURABLE')),
  evidence_fingerprint TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT,
  UNIQUE (job_id, evidence_fingerprint)
);
CREATE INDEX idx_job_comparisons_history
  ON job_comparisons(job_id, created_at DESC);

CREATE TABLE job_completion_verifications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('VERIFIED_COMPLETE', 'LIKELY_COMPLETE', 'COMPLETION_UNCERTAIN', 'NOT_COMPLETE')
  ),
  evidence TEXT NOT NULL,
  missing_evidence TEXT NOT NULL,
  operator_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (operator_confirmed IN (0, 1)),
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE INDEX idx_job_completion_history
  ON job_completion_verifications(job_id, created_at DESC);
CREATE UNIQUE INDEX idx_job_one_operator_confirmation
  ON job_completion_verifications(job_id)
  WHERE operator_confirmed = 1;
