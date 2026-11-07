import { randomUUID } from "node:crypto";
import {
  listCompletionVerifications,
  listDeviationLifecycleEvents,
  listJobComparisons,
  listRootCauseReports,
} from "./intelligence.mjs";

export const JOB_INSIGHT_CONFIG = Object.freeze({
  repeatedFailureWindowHours: 6,
  repeatedFailureMinimumObservations: 2,
  repeatedFailureMinimumConfidence: 0.7,
  repeatedFailureMinimumScore: 60,
  maximumHistoryObservations: 100,
});

const NON_FAILURE_TYPES = new Set(["", "none", "unknown"]);

function isValidObservation(record) {
  return (
    record?.is_valid === 1 &&
    Number.isFinite(Number(record.abnormality_score)) &&
    Number.isFinite(Number(record.confidence)) &&
    typeof record.timestamp === "string" &&
    Number.isFinite(Date.parse(record.timestamp))
  );
}

function actionFor(machineType, failureType) {
  if (failureType === "smoke" || failureType === "excess_smoke" || failureType === "flame") {
    return "Follow the site's fire and machine-stop procedure, then inspect the camera evidence before resuming.";
  }
  if (machineType === "cnc" || machineType === "laser_cutter") {
    return "Review the linked camera evidence and inspect fixturing, tooling, and the work area using the approved operator procedure.";
  }
  return "Review the linked camera evidence and inspect the workpiece, material feed, and build-plate adhesion before resuming.";
}

export function detectJobDeviations(job, inputRecords, config = JOB_INSIGHT_CONFIG) {
  if (!job || !["RUNNING", "PAUSED"].includes(job.status)) return [];
  const records = inputRecords
    .filter(isValidObservation)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, config.maximumHistoryObservations);
  if (!records.length) return [];

  const newestTimestamp = Date.parse(records[0].timestamp);
  const windowStart = newestTimestamp - config.repeatedFailureWindowHours * 60 * 60 * 1000;
  const eligible = records.filter((record) => {
    const failureType = String(record.failure_type || "").toLowerCase();
    return (
      Date.parse(record.timestamp) >= windowStart &&
      !NON_FAILURE_TYPES.has(failureType) &&
      ["warning", "failure"].includes(record.analysis_status) &&
      Number(record.confidence) >= config.repeatedFailureMinimumConfidence &&
      Number(record.abnormality_score) >= config.repeatedFailureMinimumScore
    );
  });

  const groups = new Map();
  for (const record of eligible) {
    const failureType = String(record.failure_type).toLowerCase();
    const group = groups.get(failureType) || [];
    group.push(record);
    groups.set(failureType, group);
  }

  return [...groups.entries()]
    .filter(([, observations]) => observations.length >= config.repeatedFailureMinimumObservations)
    .map(([failureType, observations]) => {
      const chronological = [...observations].sort(
        (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
      );
      const meanScore =
        observations.reduce((total, record) => total + Number(record.abnormality_score), 0) /
        observations.length;
      const meanConfidence =
        observations.reduce((total, record) => total + Number(record.confidence), 0) /
        observations.length;
      const firstTimestamp = chronological[0].timestamp;
      const lastTimestamp = chronological.at(-1).timestamp;
      const spanMinutes = Math.max(
        0,
        Math.round((Date.parse(lastTimestamp) - Date.parse(firstTimestamp)) / 60_000),
      );
      const explanation =
        `The camera reported ${failureType} in ${observations.length} valid, ` +
        `high-confidence analyses within ${config.repeatedFailureWindowHours} hours ` +
        `(mean abnormality ${meanScore.toFixed(0)}/100; mean confidence ` +
        `${Math.round(meanConfidence * 100)}%; span ${spanMinutes} minutes). ` +
        "This is visual evidence only and does not verify physical job execution.";
      return {
        category: `REPEATED_FAILURE_${failureType.toUpperCase()}`,
        severity: meanScore >= 80 ? "HIGH" : "MODERATE",
        explanation,
        expected_behavior: "The registered job is marked RUNNING or PAUSED; intended settings are not measured telemetry.",
        observed_behavior:
          `${failureType} was reported in ${observations.length} valid camera analyses.`,
        recommended_action: actionFor(job.machine_type, failureType),
        first_detected_at: firstTimestamp,
        latest_detected_at: lastTimestamp,
        evidence: {
          evidence_source: "camera_analysis",
          valid_observation_count: observations.length,
          time_window_hours: config.repeatedFailureWindowHours,
          mean_abnormality_score: Number(meanScore.toFixed(2)),
          mean_confidence: Number(meanConfidence.toFixed(4)),
          observations: chronological.map((record) => ({
            id: record.id,
            timestamp: record.timestamp,
            failure_type: record.failure_type,
            analysis_status: record.analysis_status,
            abnormality_score: Number(record.abnormality_score),
            confidence: Number(record.confidence),
          })),
        },
      };
    });
}

export function persistJobDeviations(database, jobId, candidates) {
  const upsert = database.prepare(`
    INSERT INTO job_deviations (
      id, job_id, machine_id, category, severity, explanation, expected_behavior,
      observed_behavior, initial_evidence, evidence, recommended_action, first_detected_at,
      latest_detected_at, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(job_id, category) WHERE state IN ('ACTIVE', 'ACKNOWLEDGED') DO UPDATE SET
      severity = excluded.severity,
      explanation = excluded.explanation,
      expected_behavior = excluded.expected_behavior,
      observed_behavior = excluded.observed_behavior,
      evidence = excluded.evidence,
      recommended_action = excluded.recommended_action,
      latest_detected_at = excluded.latest_detected_at,
      updated_at = excluded.updated_at
  `);
  const findActive = database.prepare(`
    SELECT id, severity, latest_detected_at
    FROM job_deviations
    WHERE job_id = ? AND category = ? AND state IN ('ACTIVE', 'ACKNOWLEDGED')
  `);
  const machineId = database.prepare("SELECT machine_id FROM jobs WHERE id = ?").get(jobId)?.machine_id;
  if (!machineId) return [];

  const now = new Date().toISOString();
  return database.transaction(() =>
    candidates.map((candidate) => {
      const existing = findActive.get(jobId, candidate.category);
      const id = existing?.id || randomUUID();
      upsert.run(
        id,
        jobId,
        machineId,
        candidate.category,
        candidate.severity,
        candidate.explanation,
        candidate.expected_behavior,
        candidate.observed_behavior,
        JSON.stringify(candidate.evidence),
        JSON.stringify(candidate.evidence),
        candidate.recommended_action,
        candidate.first_detected_at,
        candidate.latest_detected_at,
        now,
        now,
      );
      return {
        id,
        created: !existing,
        severityChanged: Boolean(existing && existing.severity !== candidate.severity),
        ...candidate,
      };
    }),
  )();
}

export function getJobInsights(database, job) {
  const valid_observation_count = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM analysis_records
      WHERE job_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
    `)
    .get(job.id).count;
  const latest_analysis = database
    .prepare(`
      SELECT id, timestamp, machine_status, analysis_status, failure_type,
             abnormality_score, confidence, risk_classification, is_uncertain
      FROM analysis_records
      WHERE job_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `)
    .get(job.id) || null;
  const deviations = database
    .prepare(`
      SELECT id, job_id, machine_id, category, severity, explanation,
             expected_behavior, observed_behavior, initial_evidence, evidence, recommended_action,
             first_detected_at, latest_detected_at, state, acknowledged_at,
             resolved_at, operator_notes, created_at, updated_at
      FROM job_deviations
      WHERE job_id = ?
      ORDER BY latest_detected_at DESC, id
    `)
    .all(job.id)
    .map((deviation) => ({
      ...deviation,
      initial_evidence: JSON.parse(deviation.initial_evidence),
      evidence: JSON.parse(deviation.evidence),
      lifecycle_events: listDeviationLifecycleEvents(database, deviation.id),
    }));

  return {
    job_id: job.id,
    progress: {
      status: "UNAVAILABLE",
      reason: "No machine execution or progress telemetry is connected. Lifecycle state and G-code describe operator intent, not physical progress.",
    },
    parameter_verification: {
      status: "UNAVAILABLE",
      intended_parameters: job.expected_parameters,
      actual_parameters: null,
      reason: "The camera analysis pipeline does not measure controller temperature, speed, power, or tool settings.",
    },
    valid_observation_count,
    latest_analysis,
    deviations,
    root_cause_reports: listRootCauseReports(database, job.id),
    comparisons: listJobComparisons(database, job.id),
    completion_verifications: listCompletionVerifications(database, job.id),
  };
}
