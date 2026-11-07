import { randomUUID } from "node:crypto";
import { DEFAULT_TREND_CONFIG } from "../trend/config.mjs";

const SCORE_UNCERTAINTY_BASELINE = 40;
const FAILURE_SCORE_FLOOR = 60;
const NEEDS_ATTENTION_SCORE_FLOOR = 40;

export function calculateAbnormality(result) {
  const severity = Math.max(0, Math.min(10, Number(result.severity) || 0));
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  const severityScore = severity * 10;

  // Blend severity with a conservative uncertainty baseline. Low confidence
  // cannot erase a serious severity; explicit failure/attention states add floors.
  const blendedScore = Math.round(
    severityScore * confidence + SCORE_UNCERTAINTY_BASELINE * (1 - confidence),
  );
  const statusFloor =
    result.status === "failure"
      ? FAILURE_SCORE_FLOOR
      : result.machine_status === "needs_attention"
        ? NEEDS_ATTENTION_SCORE_FLOOR
        : 0;
  const abnormalityScore = Math.max(blendedScore, statusFloor);
  const uncertain =
    confidence < 0.5 ||
    result.status === "unclear" ||
    (result.machine_status === "needs_attention" && confidence < 0.7);

  return {
    abnormality_score: abnormalityScore,
    is_uncertain: uncertain,
    risk_classification: classifyRisk(abnormalityScore),
  };
}

export function classifyRisk(score, config = DEFAULT_TREND_CONFIG) {
  const thresholds = config && typeof config === "object" ? config : DEFAULT_TREND_CONFIG;
  if (score >= thresholds.riskCriticalThreshold) return "CRITICAL";
  if (score >= thresholds.riskHighThreshold) return "HIGH";
  if (score >= thresholds.riskModerateThreshold) return "MODERATE";
  if (score >= thresholds.riskLowThreshold) return "LOW";
  return "NORMAL";
}

function machineLabel(label, cameraId) {
  const cleaned = String(label || "").trim().slice(0, 100);
  return cleaned || (cameraId ? `Machine ${cameraId.slice(0, 12)}` : "Unidentified machine");
}

export function registerMachine(database, { cameraId, label, machineType }) {
  const now = new Date().toISOString();
  const validCameraId =
    typeof cameraId === "string" && cameraId.trim() ? cameraId.trim().slice(0, 200) : null;
  const safeMachineType = String(machineType || "3d_printer").trim().slice(0, 60) || "3d_printer";

  if (validCameraId) {
    const existing = database
      .prepare(`
        SELECT machines.id, machines.label, machines.machine_type
        FROM machine_cameras
        JOIN machines ON machines.id = machine_cameras.machine_id
        WHERE machine_cameras.camera_id = ?
      `)
      .get(validCameraId);

    if (existing) {
      database
        .prepare(`
          UPDATE machines
          SET label = ?, machine_type = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(machineLabel(label, validCameraId), safeMachineType, now, existing.id);
      database
        .prepare("UPDATE machine_cameras SET last_seen_at = ? WHERE camera_id = ?")
        .run(now, validCameraId);
      return { id: existing.id, cameraId: validCameraId };
    }
  } else {
    console.warn("Analysis received without a camera deviceId; creating an unlinked machine identity.");
  }

  const id = randomUUID();
  database
    .prepare(`
      INSERT INTO machines (id, label, machine_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(id, machineLabel(label, validCameraId), safeMachineType, now, now);

  if (validCameraId) {
    database
      .prepare(`
        INSERT INTO machine_cameras (camera_id, machine_id, created_at, last_seen_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(validCameraId, id, now, now);
  }

  return { id, cameraId: validCameraId };
}

export function persistValidAnalysis(database, { machineId, machineType, result, timestamp, jobId = null }) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const analysisTime = timestamp || createdAt;
  const score = calculateAbnormality(result);
  const failureType = result.failure_type || "unknown";

  database
    .prepare(`
      INSERT INTO analysis_records (
        id, machine_id, timestamp, is_valid, invalid_reason, abnormality_score,
        confidence, failure_category, risk_classification, severity, scene_state,
        incident_reference, raw_metadata, created_at, machine_type, machine_status,
        analysis_status, failure_type, is_uncertain, provider, error_category, job_id
      ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `)
    .run(
      id,
      machineId,
      analysisTime,
      score.abnormality_score,
      result.confidence,
      failureType,
      score.risk_classification,
      result.severity,
      result.scene_state,
      createdAt,
      machineType,
      result.machine_status,
      result.status,
      failureType,
      score.is_uncertain ? 1 : 0,
      jobId,
    );

  return { id, timestamp: analysisTime, ...score };
}

export function persistInvalidAnalysis(
  database,
  { machineId = null, machineType = null, timestamp, reason, provider, errorCategory, cameraId = null, jobId = null },
) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const analysisTime = timestamp || createdAt;
  database
    .prepare(`
      INSERT INTO analysis_records (
        id, machine_id, timestamp, is_valid, invalid_reason, abnormality_score,
        confidence, failure_category, risk_classification, severity, scene_state,
        incident_reference, raw_metadata, created_at, machine_type, machine_status,
        analysis_status, failure_type, is_uncertain, provider, error_category, job_id
      ) VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 'invalid', NULL, 1, ?, ?, ?)
    `)
    .run(
      id,
      machineId,
      analysisTime,
      String(reason || "Analysis failed").slice(0, 1000),
      JSON.stringify({ camera_id: cameraId }),
      createdAt,
      machineType,
      String(provider || "unknown").slice(0, 40),
      String(errorCategory || "analysis_error").slice(0, 80),
      jobId,
    );
  return { id, timestamp: analysisTime };
}

export function findMachine(database, machineId) {
  return database.prepare("SELECT id, label, machine_type, created_at, updated_at FROM machines WHERE id = ?").get(machineId);
}

export function listMachines(database) {
  const machines = database
    .prepare(`
      SELECT machines.id, machines.label, machines.machine_type,
             machines.created_at, machines.updated_at,
             (
               SELECT MAX(analysis_records.timestamp)
               FROM analysis_records
               WHERE analysis_records.machine_id = machines.id
                 AND analysis_records.is_valid = 1
                 AND analysis_records.abnormality_score IS NOT NULL
             ) AS last_analysis_timestamp,
             (
               SELECT COUNT(*)
               FROM early_warnings
               WHERE early_warnings.machine_id = machines.id
                 AND early_warnings.state IN ('ACTIVE', 'ACKNOWLEDGED')
             ) AS active_warning_count
      FROM machines
      ORDER BY machines.label COLLATE NOCASE, machines.id
    `)
    .all();
  const cameraIds = database
    .prepare("SELECT camera_id, machine_id FROM machine_cameras ORDER BY machine_id, camera_id")
    .all();
  const camerasByMachine = new Map();
  for (const { camera_id: cameraId, machine_id: machineId } of cameraIds) {
    const cameras = camerasByMachine.get(machineId) || [];
    cameras.push(cameraId);
    camerasByMachine.set(machineId, cameras);
  }
  return machines.map((machine) => ({
    ...machine,
    camera_ids: camerasByMachine.get(machine.id) || [],
  }));
}

export function getValidAnalysisHistory(database, machineId, { limit, offset }) {
  return database
    .prepare(`
      SELECT id, machine_id, timestamp, machine_type, machine_status, analysis_status,
             failure_type, severity, confidence, abnormality_score, risk_classification,
             is_uncertain, is_valid
      FROM analysis_records
      WHERE machine_id = ? AND is_valid = 1
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(machineId, limit, offset);
}

export function getValidTrendRecords(database, machineId, { limit = null } = {}) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
  if (boundedLimit) {
    return database.prepare(`
      SELECT * FROM (
        SELECT id, machine_id, timestamp, abnormality_score, confidence,
               failure_type, failure_category, risk_classification, is_uncertain, is_valid
        FROM analysis_records
        WHERE machine_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, id ASC
    `).all(machineId, boundedLimit);
  }
  return database
    .prepare(`
      SELECT id, machine_id, timestamp, abnormality_score, confidence,
             failure_type, failure_category, risk_classification, is_uncertain, is_valid
      FROM analysis_records
      WHERE machine_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
      ORDER BY timestamp ASC, id ASC
    `)
    .all(machineId);
}

function warningRow(row) {
  if (!row) return null;
  let evidence;
  try {
    evidence = JSON.parse(row.supporting_evidence);
  } catch (error) {
    console.error(`Warning ${row.id} has malformed supporting evidence:`, error);
    evidence = [];
  }
  return {
    id: row.id,
    machine_id: row.machine_id,
    category: row.category,
    severity: row.severity,
    explanation: row.explanation,
    supporting_evidence: evidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: row.state,
    acknowledged_at: row.acknowledged_at,
    resolved_at: row.resolved_at,
    operator_notes: row.operator_notes,
  };
}

function getWarning(database, id) {
  return warningRow(database.prepare("SELECT * FROM early_warnings WHERE id = ?").get(id));
}

export function upsertEarlyWarning(database, machineId, candidate) {
  const now = new Date().toISOString();
  const evidence = {
    supporting_observations: candidate.supporting_evidence,
    first_detected_at: candidate.first_detected_at,
    latest_detected_at: candidate.latest_detected_at,
    recommended_action: candidate.recommended_action,
    failure_type: candidate.failure_type || null,
    baseline_mean: candidate.baseline_mean ?? null,
    z_score: candidate.z_score ?? null,
  };
  const upsert = database.transaction(() => {
    const existing = database
      .prepare(`
        SELECT id, supporting_evidence FROM early_warnings
        WHERE machine_id = ? AND category = ? AND state IN ('ACTIVE', 'ACKNOWLEDGED')
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(machineId, candidate.category);

    if (existing) {
      const existingEvidence = JSON.parse(existing.supporting_evidence);
      const evidenceJson = JSON.stringify({
        ...evidence,
        first_detected_at: existingEvidence.first_detected_at || evidence.first_detected_at,
      });
      database
        .prepare(`
          UPDATE early_warnings
          SET severity = ?, explanation = ?, supporting_evidence = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(candidate.severity, candidate.explanation, evidenceJson, now, existing.id);
      return { created: false, warning: getWarning(database, existing.id) };
    }

    const id = randomUUID();
    const evidenceJson = JSON.stringify(evidence);
    database
      .prepare(`
        INSERT INTO early_warnings (
          id, machine_id, category, severity, explanation, supporting_evidence,
          created_at, updated_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `)
      .run(
        id,
        machineId,
        candidate.category,
        candidate.severity,
        candidate.explanation,
        evidenceJson,
        now,
        now,
      );
    return { created: true, warning: getWarning(database, id) };
  });
  return upsert();
}

export function listMachineWarnings(database, machineId) {
  return database
    .prepare(`
      SELECT * FROM early_warnings
      WHERE machine_id = ? AND state IN ('ACTIVE', 'ACKNOWLEDGED')
      ORDER BY updated_at DESC, id DESC
    `)
    .all(machineId)
    .map(warningRow);
}

export function transitionWarning(database, warningId, transition, operatorNotes = null) {
  const now = new Date().toISOString();
  const update = database.transaction(() => {
    const warning = database.prepare("SELECT * FROM early_warnings WHERE id = ?").get(warningId);
    if (!warning) return { warning: null, changed: false };

    if (transition === "acknowledge") {
      if (warning.state === "RESOLVED") {
        return { warning: warningRow(warning), changed: false, conflict: true };
      }
      if (warning.state === "ACKNOWLEDGED") {
        return { warning: warningRow(warning), changed: false };
      }
      database
        .prepare(`
          UPDATE early_warnings
          SET state = 'ACKNOWLEDGED', acknowledged_at = ?, operator_notes = COALESCE(?, operator_notes),
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, operatorNotes, now, warningId);
    } else if (transition === "resolve") {
      if (warning.state === "RESOLVED") {
        return { warning: warningRow(warning), changed: false };
      }
      database
        .prepare(`
          UPDATE early_warnings
          SET state = 'RESOLVED', resolved_at = ?, operator_notes = COALESCE(?, operator_notes),
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, operatorNotes, now, warningId);
    } else {
      throw new Error(`Unsupported warning transition: ${transition}`);
    }

    return { warning: getWarning(database, warningId), changed: true };
  });
  return update();
}
