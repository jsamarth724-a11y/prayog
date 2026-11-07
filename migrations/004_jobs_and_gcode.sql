-- Migration 004: additive job registration and safe G-code storage.

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_type TEXT NOT NULL CHECK (machine_type IN ('3d_printer', 'cnc', 'laser_cutter')),
  job_type TEXT NOT NULL,
  expected_duration_seconds INTEGER,
  material_type TEXT,
  expected_parameters TEXT NOT NULL DEFAULT '{}',
  slicer_metadata TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  completed_at TEXT,
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT,
  CHECK (expected_duration_seconds IS NULL OR expected_duration_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_jobs_machine_created
  ON jobs(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_machine_status
  ON jobs(machine_id, status);

CREATE TABLE IF NOT EXISTS job_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK (dialect IN ('3d_printer', 'cnc', 'laser_cutter')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
