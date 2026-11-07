-- Migration 005: associate future camera analyses with the active registered job.

ALTER TABLE analysis_records
  ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_records_job_time
  ON analysis_records(job_id, timestamp DESC);
