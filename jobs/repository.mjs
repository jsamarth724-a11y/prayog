import { randomUUID } from "node:crypto";

const ACTIVE_JOB_STATUSES = new Set(["RUNNING", "PAUSED"]);
const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const TRANSITIONS = Object.freeze({
  DRAFT: new Set(["READY", "CANCELLED"]),
  READY: new Set(["RUNNING", "CANCELLED"]),
  RUNNING: new Set(["PAUSED", "COMPLETED", "FAILED", "CANCELLED"]),
  PAUSED: new Set(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
});

function parseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error("Could not parse persisted job JSON:", error);
    return fallback;
  }
}

function jobFromRow(row) {
  if (!row) return null;
  const file = row.file_id
    ? {
        id: row.file_id,
        filename: row.file_name,
        dialect: row.file_dialect,
        size_bytes: row.file_size_bytes,
        sha256: row.file_sha256,
        summary: parseJson(row.file_summary, {}),
        uploaded_at: row.file_uploaded_at,
      }
    : null;
  return {
    id: row.id,
    name: row.name,
    machine_id: row.machine_id,
    machine_label: row.machine_label,
    machine_type: row.machine_type,
    job_type: row.job_type,
    expected_duration_seconds: row.expected_duration_seconds,
    material_type: row.material_type,
    expected_parameters: parseJson(row.expected_parameters, {}),
    slicer_metadata: parseJson(row.slicer_metadata, {}),
    started_at: row.started_at,
    status: row.status,
    completed_at: row.completed_at,
    operator_notes: row.operator_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    file,
  };
}

const JOB_SELECT = `
  SELECT jobs.*, machines.label AS machine_label,
         job_files.id AS file_id, job_files.filename AS file_name,
         job_files.dialect AS file_dialect, job_files.size_bytes AS file_size_bytes,
         job_files.sha256 AS file_sha256, job_files.summary AS file_summary,
         job_files.uploaded_at AS file_uploaded_at
  FROM jobs
  JOIN machines ON machines.id = jobs.machine_id
  LEFT JOIN job_files ON job_files.job_id = jobs.id
`;

export function getJob(database, jobId) {
  return jobFromRow(database.prepare(`${JOB_SELECT} WHERE jobs.id = ?`).get(jobId));
}

export function findActiveJobForMachine(database, machineId) {
  const row = database.prepare(`
    ${JOB_SELECT}
    WHERE jobs.machine_id = ? AND jobs.status IN ('RUNNING', 'PAUSED')
    ORDER BY jobs.started_at DESC, jobs.created_at DESC
    LIMIT 1
  `).get(machineId);
  return jobFromRow(row);
}

export function getJobAnalysisHistory(database, jobId, { limit = 50, offset = 0 } = {}) {
  return database.prepare(`
    SELECT id, machine_id, job_id, timestamp, machine_type, machine_status,
           analysis_status, failure_type, severity, confidence, abnormality_score,
           risk_classification, is_uncertain
    FROM analysis_records
    WHERE job_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
    ORDER BY timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(jobId, limit, offset);
}

export function getJobAnalysisHistoryForInsights(database, jobId, limit = 100) {
  return database.prepare(`
    SELECT id, timestamp, is_valid, machine_status, analysis_status, failure_type,
           abnormality_score, confidence, risk_classification, is_uncertain
    FROM analysis_records
    WHERE job_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(jobId, limit);
}

export function listJobs(database, { machineId = null, status = null, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  if (machineId) {
    conditions.push("jobs.machine_id = ?");
    values.push(machineId);
  }
  if (status) {
    conditions.push("jobs.status = ?");
    values.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = database
    .prepare(`${JOB_SELECT} ${where} ORDER BY jobs.created_at DESC, jobs.id LIMIT ? OFFSET ?`)
    .all(...values, limit, offset);
  return rows.map(jobFromRow);
}

export function createJob(database, input) {
  const machine = database
    .prepare("SELECT id, label, machine_type FROM machines WHERE id = ?")
    .get(input.machineId);
  if (!machine) return { job: null, reason: "machine_not_found" };
  if (machine.machine_type !== input.machineType) {
    return { job: null, reason: "machine_type_mismatch" };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO jobs (
      id, name, machine_id, machine_type, job_type, expected_duration_seconds,
      material_type, expected_parameters, slicer_metadata, status, operator_notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
  `).run(
    id,
    input.name,
    input.machineId,
    input.machineType,
    input.jobType,
    input.expectedDurationSeconds,
    input.materialType,
    JSON.stringify(input.expectedParameters),
    JSON.stringify(input.slicerMetadata),
    input.operatorNotes,
    now,
    now,
  );
  return { job: getJob(database, id), reason: null };
}

export function updateJob(database, jobId, input) {
  const existing = getJob(database, jobId);
  if (!existing) return { job: null, reason: "job_not_found" };
  if (!["DRAFT", "READY"].includes(existing.status)) {
    return { job: existing, reason: "job_not_editable" };
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE jobs
    SET name = ?, job_type = ?, expected_duration_seconds = ?, material_type = ?,
        expected_parameters = ?, slicer_metadata = ?, operator_notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name,
    input.jobType,
    input.expectedDurationSeconds,
    input.materialType,
    JSON.stringify(input.expectedParameters),
    JSON.stringify(input.slicerMetadata),
    input.operatorNotes,
    now,
    jobId,
  );
  return { job: getJob(database, jobId), reason: null };
}

export function saveJobFile(database, jobId, file) {
  const job = getJob(database, jobId);
  if (!job) return { job: null, reason: "job_not_found" };
  if (!["DRAFT", "READY"].includes(job.status)) {
    return { job, reason: "job_not_editable" };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO job_files (
      id, job_id, filename, dialect, size_bytes, sha256, summary, content, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      id = excluded.id, filename = excluded.filename, dialect = excluded.dialect,
      size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
      summary = excluded.summary, content = excluded.content,
      uploaded_at = excluded.uploaded_at
  `).run(
    id,
    jobId,
    file.filename,
    file.dialect,
    file.sizeBytes,
    file.sha256,
    JSON.stringify(file.summary),
    file.content,
    now,
  );
  database.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(now, jobId);
  return { job: getJob(database, jobId), reason: null };
}

export function transitionJob(database, jobId, nextStatus) {
  const transition = database.transaction(() => {
    const job = database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!job) return { job: null, reason: "job_not_found", changed: false };
    if (job.status === nextStatus) {
      return { job: getJob(database, jobId), reason: null, changed: false };
    }
    if (!TRANSITIONS[job.status]?.has(nextStatus)) {
      return { job: getJob(database, jobId), reason: "invalid_transition", changed: false };
    }
    if (nextStatus === "RUNNING") {
      const otherActive = database.prepare(`
        SELECT id FROM jobs
        WHERE machine_id = ? AND id != ? AND status IN ('RUNNING', 'PAUSED')
        LIMIT 1
      `).get(job.machine_id, jobId);
      if (otherActive) {
        return { job: getJob(database, jobId), reason: "machine_has_active_job", changed: false };
      }
    }
    const now = new Date().toISOString();
    const startedAt = nextStatus === "RUNNING" ? job.started_at || now : job.started_at;
    const completedAt = TERMINAL_JOB_STATUSES.has(nextStatus) ? now : job.completed_at;
    database.prepare(`
      UPDATE jobs SET status = ?, started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, startedAt, completedAt, now, jobId);
    return { job: getJob(database, jobId), reason: null, changed: true };
  });
  return transition();
}

export function jobTransitionTargets(status) {
  return [...(TRANSITIONS[status] || [])];
}

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(status);
}
