import {
  getValidAnalysisHistory,
  getValidTrendRecords,
  listMachines,
  listMachineWarnings,
} from "../db/repository.mjs";
import { findActiveJobForMachine, getJob, listJobs } from "../jobs/repository.mjs";
import { getJobInsights } from "../jobs/insights.mjs";
import { getTrendConfig } from "../trend/config.mjs";
import { analyzeTrend, publicTrendResult } from "../trend/engine.mjs";
import { getSensorFusionConfig } from "../sensors/fusion.mjs";
import { getLatestFusionResult, listIncidents, listSensors } from "../sensors/repository.mjs";

const MACHINE_LIMIT = 12;

function intentFor(question) {
  const text = question.toLowerCase();
  return {
    camera: /camera|visual|frame|image|analysis|spaghetti|layer shift|adhesion/.test(text),
    trend: /trend|risk|health|condition|status|happening|machine|printer|worsen|improv|warning|predict|performance|history|compare/.test(text),
    sensor: /sensor|temperature|heat|vibration|sound|noise|smoke|reading|stale|calibrat|health|condition|inspect|maintenance|warning|risk/.test(text),
    incident: /incident|alert|cause|root cause|evidence|open|resolved|inspect|maintenance/.test(text),
    job: /job|g-?code|deviation|completion|filament|maintenance|inspect|report/.test(text),
    history: /today|last|histor|recent|compare|summari|report/.test(text),
  };
}

function reference(type, id, label, timestamp, provenance = "REAL") {
  return { type, id, label: String(label).slice(0, 140), timestamp: timestamp || null, provenance };
}

function boundedValue(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, 600);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (depth >= 5) return "[additional details omitted]";
  return Object.fromEntries(
    Object.entries(value).slice(0, 20).map(([key, item]) => [key, boundedValue(item, depth + 1)]),
  );
}

function provenanceFromEvidence(evidence) {
  const found = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if ((key === "provenance" || key === "data_provenance") && typeof item === "string") {
        if (item === "REAL" || item === "SIMULATED") found.add(item);
        if (item === "MIXED") {
          found.add("REAL");
          found.add("SIMULATED");
        }
      } else {
        visit(item, depth + 1);
      }
    }
  };
  visit(evidence);
  return found.size > 1 ? "MIXED" : found.values().next().value || "UNKNOWN";
}

function summarizeMachine(database, machine, requested) {
  const id = machine.id;
  const references = [];
  const result = {
    machine: {
      id,
      label: machine.label,
      machine_type: machine.machine_type,
      status: machine.status || null,
    },
  };

  const history = getValidAnalysisHistory(database, id, {
    limit: requested.history || requested.camera ? 10 : 3,
    offset: 0,
  });
  const latest = history[0] || null;
  if (latest) {
    result.latest_camera_analysis = {
      id: latest.id,
      timestamp: latest.timestamp,
      status: latest.analysis_status,
      failure_category: latest.failure_category || latest.failure_type || null,
      score: latest.abnormality_score,
      confidence: latest.confidence,
      risk: latest.risk_classification,
      provenance: "REAL",
    };
    references.push(reference(
      "camera_analysis",
      latest.id,
      `Camera analysis: ${latest.failure_category || latest.failure_type || latest.analysis_status}, score ${latest.abnormality_score}/100`,
      latest.timestamp,
    ));
  } else {
    result.latest_camera_analysis = { status: "UNAVAILABLE", reason: "No valid persisted camera analysis.", provenance: "UNKNOWN" };
  }

  if (requested.trend || requested.camera) {
    const trendRecords = getValidTrendRecords(database, id, { limit: 5_000 });
    result.vision_trend = publicTrendResult(analyzeTrend(trendRecords, getTrendConfig()));
    result.vision_trend.provenance = "REAL";
    if (latest) references.push(reference(
      "vision_trend",
      `${id}:${latest.id}`,
      `Vision trend: ${result.vision_trend.classification}`,
      latest.timestamp,
    ));
  }
  if (requested.history || requested.camera) {
    result.camera_history = history.map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      status: record.analysis_status,
      failure_category: record.failure_category || record.failure_type || null,
      score: record.abnormality_score,
      confidence: record.confidence,
      risk: record.risk_classification,
      provenance: "REAL",
    }));
  }

  const warnings = listMachineWarnings(database, id).slice(0, 5);
  result.active_early_warnings = warnings.map((warning) => ({
    id: warning.id,
    category: warning.category,
    severity: warning.severity,
    explanation: warning.explanation,
    state: warning.state,
    created_at: warning.created_at,
    updated_at: warning.updated_at,
    evidence: boundedValue(warning.supporting_evidence),
    provenance: "REAL",
  }));
  for (const warning of warnings) references.push(reference(
    "early_warning",
    warning.id,
    `Early warning: ${warning.category} (${warning.severity})`,
    warning.updated_at,
  ));

  if (requested.sensor || requested.trend || requested.incident) {
    const sensorConfig = getSensorFusionConfig();
    result.sensors = listSensors(database, {
      machineId: id,
      staleAfterMs: sensorConfig.staleAfterMs,
      disconnectedAfterMs: sensorConfig.disconnectedAfterMs,
      refreshHealth: false,
    }).map((sensor) => ({
      id: sensor.id,
      name: sensor.name,
      type: sensor.sensor_type,
      status: sensor.health_status,
      calibration_status: sensor.calibration_status,
      provenance: sensor.provenance,
      reading: sensor.latest_reading ? {
        value: sensor.latest_reading.value,
        unit: sensor.latest_reading.unit,
        observed_at: sensor.latest_reading.observed_at,
        event_type: sensor.latest_reading.event_type,
        alarm_detected: sensor.latest_reading.alarm_detected,
        provenance: sensor.latest_reading.provenance,
      } : null,
    }));
    for (const sensor of result.sensors) {
      if (sensor.reading) references.push(reference(
        "sensor_reading",
        sensor.id,
        `${sensor.type} sensor: ${sensor.reading.value} ${sensor.reading.unit} (${sensor.status})`,
        sensor.reading.observed_at,
        sensor.reading.provenance || sensor.provenance || "UNKNOWN",
      ));
    }
    const fusion = getLatestFusionResult(database, id);
    result.latest_sensor_fusion = fusion ? {
      id: fusion.id,
      risk_level: fusion.risk_level,
      risk_score: fusion.risk_score,
      explanation: String(fusion.explanation || "").slice(0, 600),
      created_at: fusion.created_at,
      provenance: provenanceFromEvidence(fusion.evidence),
      evidence: boundedValue(fusion.evidence),
    } : null;
    if (fusion) {
      references.push(reference(
        "sensor_fusion",
        fusion.id,
        `Sensor fusion: ${fusion.risk_level || "risk unavailable"}`,
        fusion.created_at,
        result.latest_sensor_fusion.provenance,
      ));
    }
  }

  if (requested.incident || requested.history) {
    result.recent_incidents = listIncidents(database, { machineId: id, limit: 6 }).map((incident) => ({
      id: incident.id,
      category: incident.category,
      severity: incident.severity,
      state: incident.state,
      summary: incident.summary,
      possible_root_causes: incident.possible_root_causes,
      recommended_actions: incident.recommended_actions,
      first_detected_at: incident.first_detected_at,
      latest_detected_at: incident.latest_detected_at,
      evidence: boundedValue(incident.evidence),
      provenance: provenanceFromEvidence(incident.evidence),
    }));
    for (const incident of result.recent_incidents) references.push(reference(
      "incident",
      incident.id,
      `Incident: ${incident.category} (${incident.severity}, ${incident.state})`,
      incident.latest_detected_at,
      incident.provenance,
    ));
  }

  if (requested.job || requested.history) {
    const activeJob = findActiveJobForMachine(database, id);
    const jobs = activeJob ? [activeJob] : listJobs(database, { machineId: id, limit: 4 });
    result.jobs = jobs.map((job) => {
      const current = getJob(database, job.id);
      const insights = getJobInsights(database, current);
      references.push(reference("job", current.id, `Job: ${current.name} (${current.status})`, current.updated_at, "REAL"));
      return {
        id: current.id,
        name: current.name,
        status: current.status,
        job_type: current.job_type,
        started_at: current.started_at,
        completed_at: current.completed_at,
        intended_parameters: current.expected_parameters,
        gcode_summary: current.file?.summary || null,
        progress: insights.progress,
        parameter_verification: insights.parameter_verification,
        latest_linked_analysis: insights.latest_analysis,
        deviations: insights.deviations.slice(0, 5).map((deviation) => ({
          id: deviation.id,
          category: deviation.category,
          severity: deviation.severity,
          explanation: String(deviation.explanation || "").slice(0, 600),
          recommended_action: String(deviation.recommended_action || "").slice(0, 600),
          state: deviation.state,
          latest_detected_at: deviation.latest_detected_at,
        })),
        root_cause_reports: insights.root_cause_reports.slice(0, 3).map((report) => ({
          id: report.id,
          status: report.status,
          observed_facts: boundedValue(report.observed_facts),
          report: boundedValue(report.report),
          created_at: report.created_at,
        })),
        comparisons: boundedValue(insights.comparisons.slice(0, 3)),
        completion_verifications: boundedValue(insights.completion_verifications.slice(0, 3)),
        provenance: "REAL",
      };
    });
  }

  return { context: result, references };
}

export function buildCopilotContext(database, { question, machineId = null }) {
  const machines = listMachines(database);
  if (machineId && !machines.some((machine) => machine.id === machineId)) {
    const error = new Error("The selected machine does not exist.");
    error.status = 404;
    error.code = "machine_not_found";
    throw error;
  }
  const targets = machineId
    ? machines.filter((machine) => machine.id === machineId)
    : machines.slice(0, MACHINE_LIMIT);
  const requested = intentFor(question);
  const machineResults = targets.map((machine) => summarizeMachine(database, machine, requested));
  const context = {
    selected_machine_id: machineId,
    factory_machine_count: machines.length,
    omitted_machine_count: Math.max(0, machines.length - targets.length),
    sources: machineResults.map((item) => item.context),
    important_limits: [
      "Sensor values preserve REAL or SIMULATED provenance; absent values are UNKNOWN, not normal.",
      "Job lifecycle and G-code describe operator intent and do not prove physical execution or measured telemetry.",
      "Completion confirmation by an operator is not physical proof.",
      "Camera analysis is REAL persisted camera/AI evidence; trend summaries are computed from valid persisted camera records.",
    ],
  };
  const references = machineResults.flatMap((item) => item.references).slice(0, 100);
  let serialized = JSON.stringify(context);
  if (serialized.length > 16_000) {
    for (const source of context.sources) {
      if (source.recent_incidents) source.recent_incidents = source.recent_incidents.slice(0, 3);
      if (source.jobs) source.jobs = source.jobs.slice(0, 2);
      if (source.sensors) source.sensors = source.sensors.slice(0, 6);
      if (source.active_early_warnings) source.active_early_warnings = source.active_early_warnings.slice(0, 3);
    }
    serialized = JSON.stringify(context);
  }
  if (serialized.length > 20_000) {
    const error = new Error("The available machine context exceeds the safe Copilot context limit.");
    error.status = 503;
    error.code = "context_too_large";
    throw error;
  }
  return { context, references, intents: requested };
}
