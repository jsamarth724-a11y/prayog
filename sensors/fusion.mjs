import { getValidTrendRecords } from "../db/repository.mjs";
import { findActiveJobForMachine } from "../jobs/repository.mjs";
import { getTrendConfig } from "../trend/config.mjs";
import { analyzeTrend, publicTrendResult } from "../trend/engine.mjs";
import {
  getLatestFusionResult,
  listSensors,
  recordFusionResult,
  upsertSensorIncident,
} from "./repository.mjs";
import { SIMULATION_SCENARIOS } from "./scenarios.mjs";

const SEVERITY_RANK = Object.freeze({ LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 });
const BASE_RISK_SCORE = Object.freeze({ LOW: 25, MODERATE: 45, HIGH: 70, CRITICAL: 92 });
const SENSOR_KINDS = Object.freeze(["SOUND", "VIBRATION", "TEMPERATURE", "SMOKE"]);

function threshold(name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

export function getSensorFusionConfig() {
  const staleAfterMs = threshold("SENSOR_STALE_AFTER_MS", 60_000, {
    minimum: 1_000,
    maximum: 86_400_000,
  });
  const disconnectedAfterMs = threshold("SENSOR_DISCONNECTED_AFTER_MS", 300_000, {
    minimum: staleAfterMs + 1_000,
    maximum: 604_800_000,
  });
  const soundWarningDb = threshold("SENSOR_SOUND_WARNING_DB", 85, { maximum: 160 });
  const vibrationWarningG = threshold("SENSOR_VIBRATION_WARNING_G", 0.5, { maximum: 100 });
  const temperatureWarningC = threshold("SENSOR_TEMPERATURE_WARNING_C", 70, {
    minimum: -50,
    maximum: 1_000,
  });
  const smokeWarningPpm = threshold("SENSOR_SMOKE_WARNING_PPM", 10, { maximum: 1_000_000 });
  return Object.freeze({
    staleAfterMs,
    disconnectedAfterMs,
    freshReadingMs: threshold("SENSOR_FUSION_FRESH_MS", 120_000, {
      minimum: 1_000,
      maximum: disconnectedAfterMs,
    }),
    soundWarningDb,
    soundCriticalDb: threshold("SENSOR_SOUND_CRITICAL_DB", 105, {
      minimum: soundWarningDb,
      maximum: 160,
    }),
    vibrationWarningG,
    vibrationCriticalG: threshold("SENSOR_VIBRATION_CRITICAL_G", 1, {
      minimum: vibrationWarningG,
      maximum: 100,
    }),
    temperatureWarningC,
    temperatureCriticalC: threshold("SENSOR_TEMPERATURE_CRITICAL_C", 85, {
      minimum: temperatureWarningC,
      maximum: 1_000,
    }),
    smokeWarningPpm,
    smokeCriticalPpm: threshold("SENSOR_SMOKE_CRITICAL_PPM", 50, {
      minimum: smokeWarningPpm,
      maximum: 1_000_000,
    }),
  });
}

function addSensorFinding(sensor, reading, config) {
  const eventLabel = reading.event_type?.toLowerCase().replaceAll("_", " ") || null;
  const reportedAlarm = reading.alarm_detected === true;
  let category = null;
  let severity = null;
  let description = null;
  let possibleRootCauses = [];
  let recommendedActions = [];

  if (sensor.sensor_type === "SOUND") {
    if (reading.value >= config.soundCriticalDb) severity = "CRITICAL";
    else if (reading.value >= config.soundWarningDb) severity = "HIGH";
    else if (eventLabel) severity = "MODERATE";
    if (severity) {
      category = "UNUSUAL_SOUND";
      description = `A sound sensor reported ${reading.value} dBA${eventLabel ? ` and classified ${eventLabel}` : ""}.`;
      possibleRootCauses = ["Possible bearing or tool friction", "A loose component or workpiece may be vibrating"];
      recommendedActions = ["Review a short operator-observed sound sample using approved local procedures.", "Inspect mounts, guards, and tooling while following the machine's safe isolation process."];
    }
  } else if (sensor.sensor_type === "VIBRATION") {
    if (reading.value >= config.vibrationCriticalG) severity = "HIGH";
    else if (reading.value >= config.vibrationWarningG || eventLabel) severity = "MODERATE";
    if (severity) {
      category = "ABNORMAL_VIBRATION";
      description = `A vibration sensor reported ${reading.value} g RMS${eventLabel ? ` (${eventLabel})` : ""}.`;
      possibleRootCauses = ["Possible imbalance, loosened mounting, or tool/workpiece chatter"];
      recommendedActions = ["Inspect machine mounting and the workpiece/tool setup.", "Compare the vibration reading with the machine-specific operating baseline."];
    }
  } else if (sensor.sensor_type === "TEMPERATURE") {
    if (reading.value >= config.temperatureCriticalC) severity = "CRITICAL";
    else if (reading.value >= config.temperatureWarningC || eventLabel) severity = "HIGH";
    if (severity) {
      category = "TEMPERATURE_OVER_LIMIT";
      description = `A temperature sensor reported ${reading.value} °C${eventLabel ? ` (${eventLabel})` : ""}.`;
      possibleRootCauses = ["Possible cooling restriction, increased load, or a sensor-placement issue; verify independently."];
      recommendedActions = ["Check the sensor location and machine-specific thermal limits.", "Have an operator inspect cooling and load conditions; this system does not control the machine."];
    }
  } else if (sensor.sensor_type === "SMOKE") {
    if (reportedAlarm || reading.value >= config.smokeCriticalPpm) severity = "CRITICAL";
    else if (reading.value >= config.smokeWarningPpm || eventLabel) severity = "HIGH";
    if (severity) {
      category = "SMOKE_SENSOR_ALERT";
      description = `A smoke sensor ${reportedAlarm ? "reported an alarm" : `reported ${reading.value} ppm`}${eventLabel ? ` (${eventLabel})` : ""}.`;
      possibleRootCauses = ["An airborne-particle or smoke condition may be present; the sensor reading does not identify its source."];
      recommendedActions = ["Follow the site's smoke/fire response procedure and have an operator verify the area.", "Do not treat this software alert as a replacement for certified life-safety equipment."];
    }
  }
  if (!category) return null;
  if (sensor.calibration_status !== "CURRENT" && severity !== "LOW") {
    severity = severity === "CRITICAL" ? "HIGH" : severity === "HIGH" ? "MODERATE" : "LOW";
    description += ` Calibration status is ${sensor.calibration_status}; verify the device before relying on its absolute value.`;
  }
  return {
    category,
    severity,
    description,
    possibleRootCauses,
    recommendedActions,
    evidence: {
      source: "sensor",
      sensor_id: sensor.id,
      sensor_name: sensor.name,
      sensor_type: sensor.sensor_type,
      health_status: sensor.health_status,
      calibration_status: sensor.calibration_status,
      provenance: reading.provenance,
      observed_at: reading.observed_at,
      value: reading.value,
      unit: reading.unit,
      event_type: reading.event_type,
      alarm_detected: reading.alarm_detected,
    },
  };
}

function latestVisionRecord(database, machineId) {
  return database.prepare(`
    SELECT id, timestamp, analysis_status, machine_status, failure_type,
           scene_state, confidence, abnormality_score, risk_classification, is_uncertain
    FROM analysis_records
    WHERE machine_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
    ORDER BY timestamp DESC, id DESC LIMIT 1
  `).get(machineId) || null;
}

export function buildMachineFusionContext(database, machineId, config = getSensorFusionConfig()) {
  const sensors = listSensors(database, {
    machineId,
    staleAfterMs: config.staleAfterMs,
    disconnectedAfterMs: config.disconnectedAfterMs,
    refreshHealth: false,
  });
  const records = getValidTrendRecords(database, machineId);
  const trend = records.length
    ? publicTrendResult(analyzeTrend(records, getTrendConfig()))
    : null;
  const machine = database.prepare("SELECT id, label, machine_type FROM machines WHERE id = ?").get(machineId);
  const activeJob = findActiveJobForMachine(database, machineId);
  const simulation = database.prepare(`
    SELECT id, scenario, status, speed, run_number, tick_count, started_at
    FROM simulation_sessions
    WHERE machine_id = ? AND status = 'RUNNING'
    ORDER BY created_at DESC LIMIT 1
  `).get(machineId) || null;
  return {
    machine,
    sensors,
    vision: latestVisionRecord(database, machineId),
    trend,
    simulation,
    active_job: activeJob
      ? { id: activeJob.id, name: activeJob.name, status: activeJob.status, machine_type: activeJob.machine_type }
      : null,
  };
}

export function evaluateSensorFusion(context, config = getSensorFusionConfig(), now = Date.now()) {
  const freshSensors = context.sensors.filter((sensor) =>
    sensor.enabled &&
    sensor.health_status === "ONLINE" &&
    sensor.latest_reading &&
    now - Date.parse(sensor.latest_reading.observed_at) <= config.freshReadingMs,
  );
  const availableKinds = new Set(freshSensors.map((sensor) => sensor.sensor_type));
  const modalities = SENSOR_KINDS.map((kind) => {
    const matches = context.sensors.filter((sensor) => sensor.sensor_type === kind);
    const available = freshSensors.filter((sensor) => sensor.sensor_type === kind);
    return {
      type: kind,
      status: available.length ? "AVAILABLE" : "UNAVAILABLE",
      sensor_count: matches.length,
      online_sensor_count: available.length,
      reason: available.length
        ? null
        : matches.length
          ? `No fresh online ${kind.toLowerCase()} reading is available.`
          : `No ${kind.toLowerCase()} sensor is registered; this modality is unknown.`,
    };
  });
  const signals = [];
  for (const sensor of freshSensors) {
    const finding = addSensorFinding(sensor, sensor.latest_reading, config);
    if (finding) signals.push(finding);
  }

  if (context.simulation && context.simulation.scenario !== "NORMAL") {
    const scenario = SIMULATION_SCENARIOS[context.simulation.scenario];
    if (scenario?.severity) {
      signals.push({
        category: `SIMULATED_${context.simulation.scenario}`,
        severity: scenario.severity,
        description: `SIMULATED scenario "${scenario.label}" is injected into virtual session ${context.simulation.id}. This is a deterministic demonstration input, not a physical condition confirmed by a camera or sensor.`,
        possibleRootCauses: [`Injected demonstration scenario: ${scenario.label}. This is not a diagnosis of the physical machine.`],
        recommendedActions: ["Review the clearly labeled simulated evidence and use replay to repeat the demonstration; verify physical conditions independently."],
        evidence: {
          source: "simulation_scenario",
          provenance: "SIMULATED",
          simulation_session_id: context.simulation.id,
          scenario: context.simulation.scenario,
          run_number: context.simulation.run_number,
          tick_count: context.simulation.tick_count,
          started_at: context.simulation.started_at,
          description: scenario.description,
        },
      });
    }
  }

  const vision = context.vision;
  const visionConfidence = Number(vision?.confidence);
  const visionScore = Number(vision?.abnormality_score);
  const visionUsable = vision &&
    Number.isFinite(visionScore) &&
    Number.isFinite(visionConfidence) &&
    visionConfidence >= 0.5 &&
    Number(vision.is_uncertain || 0) === 0;
  const cameraSmokeSuspicion = visionUsable &&
    /smoke|fire|flame/i.test(`${vision.failure_type || ""} ${vision.scene_state || ""}`);
  const cameraRisk = visionUsable && visionScore >= 70;
  if (cameraRisk || cameraSmokeSuspicion) {
    const smokeSuspicion = cameraSmokeSuspicion;
    const smokeSensorAlertPresent = signals.some((signal) =>
      signal.evidence.source === "sensor" && signal.evidence.sensor_type === "SMOKE",
    );
    signals.push({
      category: smokeSuspicion ? "CAMERA_SMOKE_SUSPICION" : "CAMERA_ABNORMALITY",
      severity: smokeSuspicion && smokeSensorAlertPresent
        ? "HIGH"
        : visionScore >= 85 ? "HIGH" : "MODERATE",
      description: smokeSuspicion
        ? `Persisted camera analysis ${vision.id} suggests possible smoke or flame.`
        : `Persisted valid camera analysis ${vision.id} reported abnormality ${visionScore}/100 at ${vision.timestamp}.`,
      possibleRootCauses: smokeSuspicion
        ? ["Camera analysis suggests possible smoke or flame; visual classification requires operator verification."]
        : ["A visual abnormality was classified; the image alone does not establish a mechanical root cause."],
      recommendedActions: smokeSuspicion
        ? ["Follow the site's smoke/fire response procedure and have an operator verify the area."]
        : ["Review the persisted camera evidence and verify the machine condition directly."],
      evidence: {
        source: "camera_analysis",
        provenance: "REAL",
        record_id: vision.id,
        observed_at: vision.timestamp,
        abnormality_score: visionScore,
        confidence: visionConfidence,
        failure_type: vision.failure_type,
      },
    });
  }

  if (context.trend && ["RAPIDLY_RISING", "PERSISTENT_HIGH"].includes(context.trend.trend_classification)) {
    signals.push({
      category: "VISION_TREND",
      severity: context.trend.trend_classification === "PERSISTENT_HIGH" ? "HIGH" : "MODERATE",
      description: `Stored vision history is classified ${context.trend.trend_classification} across ${context.trend.valid_observations} valid observations.`,
      possibleRootCauses: ["A sustained visual trend may indicate a worsening process condition; inspect before drawing a mechanical conclusion."],
      recommendedActions: ["Review the machine's Failure Trend Intelligence history and inspect the process."],
      evidence: {
        source: "persisted_vision_trend",
        provenance: "REAL",
        trend_classification: context.trend.trend_classification,
        valid_observations: context.trend.valid_observations,
        current_score: context.trend.current_score,
        slope: context.trend.slope,
        last_analysis_timestamp: context.trend.last_analysis_timestamp,
      },
    });
  }

  const distinctSources = new Set(signals.map((signal) => signal.evidence.provenance === "SIMULATED"
    ? "simulated_virtual_source"
    : signal.evidence.source === "sensor"
      ? signal.evidence.sensor_type
      : signal.evidence.source));
  let severity = signals.reduce((highest, signal) =>
    (SEVERITY_RANK[signal.severity] || 0) > (SEVERITY_RANK[highest] || 0) ? signal.severity : highest, "LOW");
  if (signals.length && distinctSources.size >= 2 && severity !== "CRITICAL") {
    severity = severity === "HIGH" ? "CRITICAL" : "HIGH";
  }
  if (signals.some((signal) => signal.category === "SMOKE_SENSOR_ALERT" && signal.evidence.alarm_detected)) {
    severity = "CRITICAL";
  }

  const triggerSensor = context.sensors.find((sensor) =>
    sensor.latest_reading && sensor.latest_reading.id === context.trigger_reading_id,
  );
  const sourceProvenance = new Set(signals.map((signal) => signal.evidence.provenance));
  const groupedRiskSources = new Map();
  for (const signal of signals) {
    const source = signal.evidence.source === "sensor"
      ? `${signal.evidence.sensor_type.toLowerCase()} sensor`
      : signal.evidence.source === "camera_analysis"
        ? "camera analysis"
        : signal.evidence.source === "persisted_vision_trend"
          ? "vision trend"
          : signal.evidence.source === "simulation_scenario"
            ? "simulation scenario"
            : signal.evidence.source;
    const key = `${signal.evidence.provenance}:${source}`;
    const grouped = groupedRiskSources.get(key) || {
      provenance: signal.evidence.provenance,
      source,
      severity: signal.severity,
      categories: [],
    };
    if ((SEVERITY_RANK[signal.severity] || 0) > (SEVERITY_RANK[grouped.severity] || 0)) {
      grouped.severity = signal.severity;
    }
    grouped.categories.push(signal.category);
    groupedRiskSources.set(key, grouped);
  }
  const dataProvenanceSources = new Set(
    context.sensors
      .filter((sensor) => sensor.latest_reading)
      .map((sensor) => sensor.provenance),
  );
  if (vision) dataProvenanceSources.add("REAL");
  if (context.trend?.valid_observations) dataProvenanceSources.add("REAL");
  const riskScore = signals.length
    ? Math.min(100, (BASE_RISK_SCORE[severity] || 0) +
        Math.max(0, distinctSources.size - 1) * 8)
    : 0;
  const trendMinimum = getTrendConfig().minimumObservations;
  const trendSufficient = Boolean(context.trend && context.trend.valid_observations >= trendMinimum);
  const fullCoverage = SENSOR_KINDS.every((kind) => availableKinds.has(kind)) &&
    Boolean(vision) && trendSufficient;
  const riskLevel = signals.length ? severity : fullCoverage ? "NORMAL" : "UNAVAILABLE";
  const explanation = signals.length
    ? `${signals.length} evidence-backed signal${signals.length === 1 ? "" : "s"} detected across ${distinctSources.size} source type${distinctSources.size === 1 ? "" : "s"}. This is an early warning, not a confirmed cause or guaranteed failure.`
    : fullCoverage
      ? "No configured rules were exceeded in the current fresh sensor observations or latest valid camera evidence."
      : "Overall machine condition is unavailable: one or more modalities lack fresh evidence. Missing data is not treated as normal.";

  return {
    machine_id: context.machine.id,
    machine_label: context.machine.label,
    sampled_at: new Date(now).toISOString(),
    risk_level: riskLevel,
    risk_score: riskScore,
    explanation,
    coverage: {
      status: fullCoverage ? "COMPLETE" : "PARTIAL",
      modalities,
      vision_status: vision ? "AVAILABLE" : "UNAVAILABLE",
      trend_status: trendSufficient ? "AVAILABLE" : "INSUFFICIENT_DATA",
      active_job: context.active_job,
    },
    signals,
    evidence: {
      sensor_readings: freshSensors.map((sensor) => ({
        sensor_id: sensor.id,
        sensor_name: sensor.name,
        sensor_type: sensor.sensor_type,
        health_status: sensor.health_status,
        calibration_status: sensor.calibration_status,
        reading: sensor.latest_reading,
      })),
      vision: vision ? {
        id: vision.id,
        observed_at: vision.timestamp,
        analysis_status: vision.analysis_status,
        failure_type: vision.failure_type,
        abnormality_score: visionScore,
        confidence: visionConfidence,
        provenance: "REAL",
      } : null,
      trend: context.trend,
      simulation: context.simulation ? {
        ...context.simulation,
        scenario_label: SIMULATION_SCENARIOS[context.simulation.scenario]?.label || context.simulation.scenario,
        provenance: "SIMULATED",
      } : null,
      active_job: context.active_job,
      unavailable_modalities: modalities.filter((modality) => modality.status === "UNAVAILABLE"),
    },
    possible_root_causes: [...new Set(signals.flatMap((signal) => signal.possibleRootCauses))],
    recommended_actions: [...new Set(signals.flatMap((signal) => signal.recommendedActions))],
    provenance: sourceProvenance.size > 1
      ? "MIXED"
      : sourceProvenance.values().next().value || "NONE",
    data_provenance: dataProvenanceSources.size > 1
      ? "MIXED"
      : dataProvenanceSources.values().next().value || "UNAVAILABLE",
    risk_sources: [...groupedRiskSources.values()],
    trigger_sensor: triggerSensor || null,
  };
}

function persistFusion(database, context, machineId, triggerReadingId, config) {
  context.trigger_reading_id = triggerReadingId;
  const evaluationTime = Date.now();
  const result = evaluateSensorFusion(context, config, evaluationTime);
  const triggerSensor = context.sensors.find((sensor) =>
    sensor.latest_reading?.id === triggerReadingId,
  );
  const realContext = {
    ...context,
    sensors: context.sensors.filter((sensor) => sensor.provenance === "REAL"),
    simulation: null,
  };
  const realResult = evaluateSensorFusion(realContext, config, evaluationTime);
  const simulatedContext = {
    ...context,
    sensors: context.sensors.filter((sensor) => sensor.provenance === "SIMULATED"),
    vision: null,
    trend: null,
  };
  const simulatedResult = evaluateSensorFusion(simulatedContext, config, evaluationTime);
  const incidentResults = [];
  const persistIncident = (candidate, category) => {
    if (!candidate.signals.length) return;
    const evidence = {
      ...candidate.evidence,
      signals: candidate.signals,
      coverage: candidate.coverage,
      provenance: candidate.provenance,
      data_provenance: candidate.data_provenance,
      risk_sources: candidate.risk_sources,
    };
    incidentResults.push(upsertSensorIncident(database, {
      machineId,
      category,
      severity: candidate.risk_level,
      summary: candidate.signals.map((signal) => signal.category.replaceAll("_", " ")).join(" · "),
      explanation: candidate.explanation,
      possibleRootCauses: candidate.possible_root_causes,
      recommendedActions: candidate.recommended_actions,
      evidence,
      fusionScore: candidate.risk_score,
      timestamp: result.sampled_at,
    }));
  };

  if (simulatedResult.signals.length) {
    persistIncident(result, "SIMULATED_MACHINE_MULTIMODAL_RISK");
  }
  if (triggerSensor?.provenance !== "SIMULATED") {
    persistIncident(realResult, "MACHINE_MULTIMODAL_RISK");
  }
  const incidentResult = incidentResults[0] || null;
  const evidence = {
    ...result.evidence,
    signals: result.signals,
    coverage: result.coverage,
    provenance: result.provenance,
    data_provenance: result.data_provenance,
    risk_sources: result.risk_sources,
  };
  const fusion = recordFusionResult(database, {
    machineId,
    triggerReadingId,
    incidentId: incidentResult?.incident.id || null,
    riskLevel: result.risk_level,
    riskScore: result.risk_score,
    evidence,
    explanation: result.explanation,
  });
  return {
    result: { ...result, fusion_id: fusion.id, incident: incidentResult?.incident || null },
    fusion,
    incidentResult,
    incidentResults,
  };
}

export function fuseMachineReading(database, machineId, readingId, config = getSensorFusionConfig()) {
  return persistFusion(
    database,
    buildMachineFusionContext(database, machineId, config),
    machineId,
    readingId,
    config,
  );
}

export function fuseMachineContext(database, machineId, config = getSensorFusionConfig()) {
  const context = buildMachineFusionContext(database, machineId, config);
  if (!context.sensors.length) return null;
  return persistFusion(database, context, machineId, null, config);
}

export function sensorIntelligenceSnapshot(database, machineId, config = getSensorFusionConfig()) {
  const context = buildMachineFusionContext(database, machineId, config);
  return {
    machine_id: machineId,
    machine_label: context.machine.label,
    sensors: context.sensors,
    incidents: null,
    current_fusion: evaluateSensorFusion(context, config),
    last_fusion: getLatestFusionResult(database, machineId),
    trend: context.trend,
    simulation: context.simulation ? {
      ...context.simulation,
      scenario_label: SIMULATION_SCENARIOS[context.simulation.scenario]?.label || context.simulation.scenario,
      provenance: "SIMULATED",
    } : null,
    active_job: context.active_job,
  };
}
