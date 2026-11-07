CREATE TABLE product_quality_inspections (
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  job_id TEXT,
  image_sha256 TEXT NOT NULL,
  image_provenance TEXT NOT NULL CHECK (image_provenance IN ('REAL', 'SIMULATED')),
  reference_sha256 TEXT,
  reference_provenance TEXT CHECK (reference_provenance IS NULL OR reference_provenance IN ('REAL', 'SIMULATED')),
  result_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE SET NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  CHECK ((reference_sha256 IS NULL AND reference_provenance IS NULL) OR
         (reference_sha256 IS NOT NULL AND reference_provenance IS NOT NULL))
);

CREATE INDEX idx_product_quality_machine_time
  ON product_quality_inspections(machine_id, created_at DESC);
CREATE INDEX idx_product_quality_job_time
  ON product_quality_inspections(job_id, created_at DESC);
