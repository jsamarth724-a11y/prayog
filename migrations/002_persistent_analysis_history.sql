-- Migration 002: add durable camera identity and complete analysis audit fields.

CREATE TABLE machine_cameras (
  camera_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);

CREATE INDEX idx_machine_cameras_machine
  ON machine_cameras(machine_id);

CREATE TABLE analysis_records_v2 (
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  timestamp TEXT NOT NULL,
  is_valid INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
  invalid_reason TEXT,
  abnormality_score REAL,
  confidence REAL,
  failure_category TEXT,
  risk_classification TEXT,
  severity INTEGER,
  scene_state TEXT,
  incident_reference TEXT,
  raw_metadata TEXT,
  created_at TEXT NOT NULL,
  machine_type TEXT NOT NULL DEFAULT '3d_printer',
  machine_status TEXT,
  analysis_status TEXT,
  failure_type TEXT,
  is_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (is_uncertain IN (0, 1)),
  provider TEXT,
  error_category TEXT,
  CHECK (is_valid = 1 OR abnormality_score IS NULL),
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);

INSERT INTO analysis_records_v2 (
  id, machine_id, timestamp, is_valid, invalid_reason, abnormality_score,
  confidence, failure_category, risk_classification, severity, scene_state,
  incident_reference, raw_metadata, created_at, machine_type, failure_type
)
SELECT id, machine_id, timestamp, is_valid, invalid_reason,
       CASE WHEN is_valid = 1 THEN abnormality_score ELSE NULL END,
       confidence, failure_category, risk_classification, severity, scene_state,
       incident_reference, raw_metadata, created_at, '3d_printer', failure_category
FROM analysis_records;

DROP TABLE analysis_records;
ALTER TABLE analysis_records_v2 RENAME TO analysis_records;

CREATE INDEX idx_records_machine_time
  ON analysis_records(machine_id, timestamp DESC);

CREATE INDEX idx_records_machine_valid_time
  ON analysis_records(machine_id, is_valid, timestamp DESC);

CREATE INDEX idx_records_category
  ON analysis_records(machine_id, failure_category);
