import { createHash, randomUUID } from "node:crypto";

const DEVIATION_STATES = new Set(["ACTIVE", "ACKNOWLEDGED", "RESOLVED"]);
const COMPARISON_CLASSES = new Set([
  "CONSISTENT",
  "DEVIATION_DETECTED",
  "UNCERTAIN",
  "NOT_MEASURABLE",
]);
const COMPLETION_OUTCOMES = new Set([
  "VERIFIED_COMPLETE",
  "LIKELY_COMPLETE",
  "COMPLETION_UNCERTAIN",
  "NOT_COMPLETE",
]);

function stableFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error("Could not parse persisted job intelligence JSON:", error);
    return fallback;
  }
}

export function transitionDeviation(database, deviationId, action, operatorNotes = null) {
  const transitions = {
    acknowledge: { from: "ACTIVE", to: "ACKNOWLEDGED" },
    resolve: { from: ["ACTIVE", "ACKNOWLEDGED"], to: "RESOLVED" },
  };
  const transition = transitions[action];
  if (!transition) return { reason: "invalid_action" };
  const now = new Date().toISOString();
  return database.transaction(() => {
    const deviation = database
      .prepare("SELECT * FROM job_deviations WHERE id = ?")
      .get(deviationId);
    if (!deviation) return { reason: "deviation_not_found" };
    const allowedFrom = Array.isArray(transition.from)
      ? transition.from
      : [transition.from];
    if (!allowedFrom.includes(deviation.state)) {
      return { reason: "invalid_transition", deviation };
    }
    const nextState = transition.to;
    database.prepare(`
      UPDATE job_deviations
      SET state = ?,
          acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN ? ELSE acknowledged_at END,
          resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_at END,
          operator_notes = CASE WHEN ? IS NULL THEN operator_notes ELSE ? END,
          updated_at = ?
      WHERE id = ? AND state = ?
    `).run(
      nextState,
      nextState,
      now,
      nextState,
      now,
      operatorNotes,
      operatorNotes,
      now,
      deviationId,
      deviation.state,
    );
    const eventId = randomUUID();
    database.prepare(`
      INSERT INTO deviation_lifecycle_events (
        id, deviation_id, job_id, machine_id, from_state, to_state,
        operator_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      deviationId,
      deviation.job_id,
      deviation.machine_id,
      deviation.state,
      nextState,
      operatorNotes,
      now,
    );
    return {
      reason: null,
      changed: true,
      event_id: eventId,
      from_state: deviation.state,
      deviation: database.prepare("SELECT * FROM job_deviations WHERE id = ?").get(deviationId),
    };
  })();
}

export function listDeviationLifecycleEvents(database, deviationId) {
  return database.prepare(`
    SELECT id, deviation_id, from_state, to_state, operator_notes, created_at
    FROM deviation_lifecycle_events
    WHERE deviation_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(deviationId);
}

export function reserveRootCauseReport(database, {
  deviation,
  provider,
  model,
  evidenceFingerprint,
  observedFacts,
}) {
  return database.transaction(() => {
    const existing = database.prepare(`
      SELECT id, status, observed_facts, report, error_category, created_at, updated_at
      FROM root_cause_reports
      WHERE deviation_id = ? AND evidence_fingerprint = ?
        AND status IN ('PENDING', 'COMPLETED')
      LIMIT 1
    `).get(deviation.id, evidenceFingerprint);
    if (existing) {
      return {
        created: false,
        report: {
          ...existing,
          observed_facts: parseJson(existing.observed_facts, []),
          report: parseJson(existing.report),
        },
      };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO root_cause_reports (
        id, deviation_id, job_id, machine_id, provider, model, status,
        evidence_fingerprint, observed_facts, report, error_category,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      deviation.id,
      deviation.job_id,
      deviation.machine_id,
      provider,
      model,
      evidenceFingerprint,
      JSON.stringify(observedFacts),
      now,
      now,
    );
    return {
      created: true,
      report: {
        id,
        deviation_id: deviation.id,
        job_id: deviation.job_id,
        machine_id: deviation.machine_id,
        provider,
        model,
        status: "PENDING",
        observed_facts: observedFacts,
        report: null,
        created_at: now,
        updated_at: now,
      },
    };
  })();
}

export function completeRootCauseReport(database, reportId, report) {
  const result = database.prepare(`
    UPDATE root_cause_reports
    SET status = 'COMPLETED', report = ?, updated_at = ?
    WHERE id = ? AND status = 'PENDING'
  `).run(JSON.stringify(report), new Date().toISOString(), reportId);
  return result.changes === 1;
}

export function failRootCauseReport(database, reportId, errorCategory) {
  const result = database.prepare(`
    UPDATE root_cause_reports
    SET status = 'FAILED', error_category = ?, updated_at = ?
    WHERE id = ? AND status = 'PENDING'
  `).run(errorCategory, new Date().toISOString(), reportId);
  return result.changes === 1;
}

export function listRootCauseReports(database, jobId) {
  return database.prepare(`
    SELECT id, deviation_id, job_id, machine_id, provider, model, status,
           observed_facts, report, error_category, created_at, updated_at
    FROM root_cause_reports
    WHERE job_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(jobId).map((row) => ({
    ...row,
    observed_facts: parseJson(row.observed_facts, []),
    report: parseJson(row.report),
  }));
}

function comparisonResult(job, records, trend) {
  const validRecords = records
    .filter((record) =>
      record.is_valid === 1 &&
      Number.isFinite(Number(record.abnormality_score)) &&
      Number.isFinite(Number(record.confidence)) &&
      Number.isFinite(Date.parse(record.timestamp)),
    )
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const latest = validRecords[0] || null;
  const expected = {
    source: "operator_job_metadata_and_parsed_program",
    execution_verified: false,
    job_type: job.job_type,
    material_type: job.material_type,
    parameters: job.expected_parameters,
    program_summary: job.file?.summary || null,
  };
  const expectedLayerCount = Number(
    job.expected_parameters?.expected_layer_count ??
      job.file?.summary?.layer_marker_count ??
      0,
  );
  const expectedControllerParameters = Object.keys(job.expected_parameters || {})
    .filter((key) => key !== "expected_layer_count");
  const telemetry = {
    status: "NOT_AVAILABLE",
    source: null,
    values: null,
  };
  let classification = "NOT_MEASURABLE";
  let confidence = null;
  let explanation = "No valid job-linked camera observation or machine telemetry is available.";
  let observed = {
    source: "none",
    timestamp: null,
    measured_values: null,
    inferred_values: null,
  };

  if (latest) {
    const analysisConfidence = Number(latest.confidence);
    const failureType = String(latest.failure_type || "unknown").toLowerCase();
    observed = {
      source: "camera_ai_analysis",
      timestamp: latest.timestamp,
      measured_values: null,
      inferred_values: {
        machine_status: latest.machine_status,
        analysis_status: latest.analysis_status,
        failure_type: latest.failure_type,
        abnormality_score: Number(latest.abnormality_score),
        risk_classification: latest.risk_classification,
      },
    };
    confidence = analysisConfidence;
    if (analysisConfidence < 0.5 || latest.analysis_status === "unclear") {
      classification = "UNCERTAIN";
      explanation = "The latest camera analysis is uncertain or low-confidence; it cannot establish whether the observed work matches the intended job.";
    } else if (
      ["warning", "failure"].includes(latest.analysis_status) &&
      !["", "none", "unknown"].includes(failureType)
    ) {
      classification = "DEVIATION_DETECTED";
      explanation =
        `A valid camera analysis classified ${failureType} as ${latest.analysis_status} ` +
        `at ${Math.round(analysisConfidence * 100)}% confidence. This is visual evidence, ` +
        "not measured machine telemetry or proof of program execution.";
    } else if (
      latest.machine_status === "printing" &&
      latest.analysis_status === "normal" &&
      analysisConfidence >= 0.7
    ) {
      if (expectedControllerParameters.length) {
        classification = "NOT_MEASURABLE";
        explanation =
          `The camera reported normal visible printing activity, but the job also specifies ` +
          `${expectedControllerParameters.join(", ")} and no controller telemetry is connected ` +
          "to compare those intended settings with actual values.";
      } else if (expectedLayerCount > 0 && validRecords.length < 2) {
        classification = "UNCERTAIN";
        explanation =
          `The job expects layer progression (${expectedLayerCount} intended layers), but only ` +
          `${validRecords.length} valid camera observation is available; progression cannot be established.`;
      } else {
        classification = "CONSISTENT";
        explanation =
          "The camera reported normal visible printing activity consistent with the registered job context. " +
          "The observation does not verify execution of the uploaded program or intended machine settings.";
      }
    } else if (latest.machine_status === "idle") {
      classification = "UNCERTAIN";
      explanation =
        "The camera reported an idle scene, but inactivity alone cannot establish job completion or a job deviation.";
    } else {
      classification = "UNCERTAIN";
      explanation = "Available camera evidence is insufficient to compare the intended job with the physical process.";
    }
  }

  const evidence = {
    expected,
    observed,
    telemetry,
    measurability: {
      expected_controller_parameters: expectedControllerParameters,
      expected_layer_count: expectedLayerCount || null,
      valid_camera_observations: validRecords.length,
    },
    trend: trend
      ? {
          classification: trend.trend_classification,
          valid_observations: trend.valid_observations,
          risk_classification: trend.risk_classification,
        }
      : null,
    supporting_history: validRecords.slice(0, 20).map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      failure_type: record.failure_type,
      analysis_status: record.analysis_status,
      abnormality_score: Number(record.abnormality_score),
      confidence: Number(record.confidence),
      evidence_source: "camera_ai_analysis",
    })),
  };
  return { classification, confidence, explanation, evidence };
}

export function compareJobEvidence(job, records, trend) {
  return comparisonResult(job, records, trend);
}

export function persistJobComparison(database, job, comparison) {
  const evidenceFingerprint = stableFingerprint(comparison.evidence);
  const existing = database.prepare(`
    SELECT id, job_id, machine_id, classification, evidence, confidence,
           explanation, created_at
    FROM job_comparisons WHERE job_id = ? AND evidence_fingerprint = ?
  `).get(job.id, evidenceFingerprint);
  if (existing) return { created: false, comparison: { ...existing, evidence: parseJson(existing.evidence) } };

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO job_comparisons (
      id, job_id, machine_id, classification, evidence_fingerprint,
      evidence, confidence, explanation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    job.id,
    job.machine_id,
    comparison.classification,
    evidenceFingerprint,
    JSON.stringify(comparison.evidence),
    comparison.confidence,
    comparison.explanation,
    createdAt,
  );
  return {
    created: true,
    comparison: { id, job_id: job.id, machine_id: job.machine_id, ...comparison, created_at: createdAt },
  };
}

export function listJobComparisons(database, jobId) {
  return database.prepare(`
    SELECT id, job_id, machine_id, classification, evidence, confidence,
           explanation, created_at
    FROM job_comparisons WHERE job_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(jobId).map((row) => ({ ...row, evidence: parseJson(row.evidence, {}) }));
}

export function evaluateCompletionVerification(job, latestAnalysis, {
  operatorConfirmed = false,
  operatorNotes = null,
  now = Date.now(),
} = {}) {
  const evidence = [];
  const missingEvidence = [
    "Controller/sensor telemetry confirming physical job completion is not connected.",
    "G-code and elapsed expected duration do not prove physical execution or completion.",
  ];
  let outcome = "COMPLETION_UNCERTAIN";
  let recentPrintingEvidence = false;
  if (latestAnalysis && Number.isFinite(Date.parse(latestAnalysis.timestamp))) {
    const ageMs = now - Date.parse(latestAnalysis.timestamp);
    if (ageMs >= 0 && ageMs <= 30 * 60 * 1000) {
      evidence.push({
        source: "camera_ai_analysis",
        timestamp: latestAnalysis.timestamp,
        machine_status: latestAnalysis.machine_status,
        analysis_status: latestAnalysis.analysis_status,
        confidence: Number(latestAnalysis.confidence),
        interpretation: "AI camera observation; not an independent completion signal.",
      });
      if (
        latestAnalysis.machine_status === "printing" &&
        latestAnalysis.analysis_status === "normal" &&
        Number(latestAnalysis.confidence) >= 0.7
      ) {
        outcome = "NOT_COMPLETE";
        recentPrintingEvidence = true;
      }
    } else {
      missingEvidence.push("The latest valid camera observation is stale or has an invalid timestamp.");
    }
  } else {
    missingEvidence.push("No valid job-linked camera observation is available.");
  }

  if (job.status === "COMPLETED" && operatorConfirmed) {
    evidence.push({
      source: "operator_confirmation",
      timestamp: new Date(now).toISOString(),
      job_lifecycle_status: job.status,
      operator_notes: operatorNotes,
      interpretation: "Operator assertion is recorded separately; physical completion is not telemetry-verified.",
    });
    if (recentPrintingEvidence) {
      outcome = "COMPLETION_UNCERTAIN";
      missingEvidence.push("Recent camera evidence showed normal printing while the operator marked the job complete; review this conflicting evidence.");
    } else {
      outcome = "LIKELY_COMPLETE";
    }
  } else if (operatorConfirmed) {
    outcome = "COMPLETION_UNCERTAIN";
    missingEvidence.push("The job lifecycle is not marked COMPLETED; the operator assertion conflicts with the recorded job state.");
  }

  if (!COMPLETION_OUTCOMES.has(outcome)) throw new Error("Completion evaluator produced an unsupported outcome.");
  return {
    outcome,
    evidence,
    missing_evidence: [...new Set(missingEvidence)],
    operator_confirmed: operatorConfirmed,
    operator_notes: operatorNotes,
  };
}

export function persistCompletionVerification(database, job, verification) {
  if (verification.operator_confirmed) {
    const existing = database.prepare(`
      SELECT id, job_id, machine_id, outcome, evidence, missing_evidence,
             operator_confirmed, operator_notes, created_at
      FROM job_completion_verifications
      WHERE job_id = ? AND operator_confirmed = 1
      LIMIT 1
    `).get(job.id);
    if (existing) {
      return {
        ...existing,
        evidence: parseJson(existing.evidence, []),
        missing_evidence: parseJson(existing.missing_evidence, []),
        operator_confirmed: true,
        reused: true,
      };
    }
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO job_completion_verifications (
      id, job_id, machine_id, outcome, evidence, missing_evidence,
      operator_confirmed, operator_notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    job.id,
    job.machine_id,
    verification.outcome,
    JSON.stringify(verification.evidence),
    JSON.stringify(verification.missing_evidence),
    verification.operator_confirmed ? 1 : 0,
    verification.operator_notes,
    createdAt,
  );
  return {
    id,
    job_id: job.id,
    machine_id: job.machine_id,
    ...verification,
    created_at: createdAt,
    reused: false,
  };
}

export function listCompletionVerifications(database, jobId) {
  return database.prepare(`
    SELECT id, job_id, machine_id, outcome, evidence, missing_evidence,
           operator_confirmed, operator_notes, created_at
    FROM job_completion_verifications
    WHERE job_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(jobId).map((row) => ({
    ...row,
    evidence: parseJson(row.evidence, []),
    missing_evidence: parseJson(row.missing_evidence, []),
    operator_confirmed: row.operator_confirmed === 1,
  }));
}

export function isSupportedDeviationState(value) {
  return DEVIATION_STATES.has(value);
}

export function isSupportedComparisonClassification(value) {
  return COMPARISON_CLASSES.has(value);
}
