import dotenv from "dotenv";
import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import express from "express";
import Groq from "groq-sdk";
import { WebSocketServer } from "ws";
import { classifyProviderError } from "./ai/errors.mjs";
import { createCopilotRouter } from "./ai/copilot.mjs";
import { createProductQualityRouter } from "./quality/api.mjs";
import {
  MAX_GCODE_BYTES,
  parseGcode,
  validateGcodeFilename,
} from "./jobs/gcode.mjs";
import {
  createJob,
  findActiveJobForMachine,
  getJobAnalysisHistory,
  getJobAnalysisHistoryForInsights,
  getJob,
  listJobs,
  saveJobFile,
  transitionJob,
  updateJob,
} from "./jobs/repository.mjs";
import {
  detectJobDeviations,
  getJobInsights,
  persistJobDeviations,
} from "./jobs/insights.mjs";
import {
  buildRootCausePrompt,
  validateRootCauseResponse,
} from "./jobs/root-cause.mjs";
import {
  compareJobEvidence,
  completeRootCauseReport,
  evaluateCompletionVerification,
  failRootCauseReport,
  listJobComparisons,
  persistCompletionVerification,
  persistJobComparison,
  reserveRootCauseReport,
  transitionDeviation,
} from "./jobs/intelligence.mjs";
import { getDatabase, initializeDatabase } from "./db/database.mjs";
import {
  findMachine,
  getValidAnalysisHistory,
  getValidTrendRecords,
  listMachines,
  listMachineWarnings,
  persistInvalidAnalysis,
  persistValidAnalysis,
  registerMachine,
  transitionWarning,
  upsertEarlyWarning,
} from "./db/repository.mjs";
import { getTrendConfig } from "./trend/config.mjs";
import { analyzeTrend, evaluateEarlyWarnings, publicTrendResult } from "./trend/engine.mjs";
import { createSensorRouter } from "./sensors/api.mjs";
import { fuseMachineContext, getSensorFusionConfig } from "./sensors/fusion.mjs";
import { listSensors } from "./sensors/repository.mjs";
import { createSimulationRouter, createSimulationService } from "./sensors/simulation.mjs";
import {
alertLevel,
describeNotifications,
flush as flushNotifications,
isValidWebhookUrl,
notifyError,
notifyFailure,
notifyInfo,
notifyRecovery,
notifyRoutine,
notifyTest,
notifyWarning,
} from "./notifications.mjs";
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const inheritedAiEnvironment = Object.fromEntries(
  ["AI_PROVIDER", "GROQ_MODEL", "OPENROUTER_MODEL"].map((name) => [name, process.env[name]]),
);
const dotenvLoadResult = dotenv.config({ path: ENV_PATH });
if (dotenvLoadResult.error && dotenvLoadResult.error.code !== "ENOENT") {
  throw new Error(`Could not load the project environment file "${ENV_PATH}": ${dotenvLoadResult.error.message}`);
}
const app = express();
const port = Number(process.env.PORT || 3001);
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-haiku";
const MACHINE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidMachineId(value) {
  return MACHINE_UUID_PATTERN.test(value);
}

function validJobInput(body, machine) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A JSON object is required." };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return { error: "Job name must be 1–100 characters." };
  if (!isValidMachineId(body.machine_id)) return { error: "Machine ID must be a UUID." };
  const machineType = machine?.machine_type;
  const parameterRules = {
    "3d_printer": {
      nozzle_temperature_c: [0, 350, false],
      bed_temperature_c: [0, 150, false],
      layer_height_mm: [0.01, 2, false],
      expected_layer_count: [1, 1_000_000, true],
    },
    cnc: {
      spindle_speed_rpm: [1, 100_000, false],
      feed_rate_mm_min: [1, 100_000, false],
      tool_identifier: ["string", 80],
    },
    laser_cutter: {
      laser_power_percent: [0, 100, false],
      cutting_speed_mm_min: [1, 100_000, false],
    },
  };
  const rules = parameterRules[machineType];
  if (!rules) return { error: "Jobs are supported only for 3D printers, CNC machines, and laser cutters." };
  const expectedParameters = body.expected_parameters ?? {};
  if (
    !expectedParameters ||
    typeof expectedParameters !== "object" ||
    Array.isArray(expectedParameters)
  ) {
    return { error: "Expected parameters must be a JSON object." };
  }
  const normalizedParameters = {};
  for (const [key, value] of Object.entries(expectedParameters)) {
    const rule = rules[key];
    if (!rule) return { error: `Parameter "${key}" is not supported for ${machineType}.` };
    if (rule[0] === "string") {
      if (typeof value !== "string" || !value.trim() || value.length > rule[1]) {
        return { error: `${key} must be a non-empty string of at most ${rule[1]} characters.` };
      }
      normalizedParameters[key] = value.trim();
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < rule[0] ||
      value > rule[1] ||
      (rule[2] && !Number.isInteger(value))
    ) {
      return { error: `${key} must be a valid number from ${rule[0]} to ${rule[1]}.` };
    }
    normalizedParameters[key] = value;
  }
  const duration = body.expected_duration_seconds ?? null;
  if (
    duration !== null &&
    (!Number.isInteger(duration) || duration < 1 || duration > 100_000_000)
  ) {
    return { error: "Expected duration must be a positive number of seconds." };
  }
  const optionalString = (value, label, max) => {
    if (value === undefined || value === null || value === "") return { value: null };
    if (typeof value !== "string" || value.trim().length > max) {
      return { error: `${label} must be at most ${max} characters.` };
    }
    return { value: value.trim() || null };
  };
  const jobType = optionalString(body.job_type, "Job type", 60);
  const materialType = optionalString(body.material_type, "Material type", 80);
  const operatorNotes = optionalString(body.operator_notes, "Operator notes", 1000);
  for (const field of [jobType, materialType, operatorNotes]) {
    if (field.error) return { error: field.error };
  }
  const metadata = body.slicer_metadata ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { error: "Slicer metadata must be a JSON object." };
  }
  const slicerMetadata = {};
  const metadataEntries = Object.entries(metadata);
  if (metadataEntries.length > 20) return { error: "Slicer metadata may contain at most 20 fields." };
  for (const [key, value] of metadataEntries) {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(key)) return { error: "Slicer metadata contains an invalid key." };
    if (typeof value === "string" && value.length <= 200) slicerMetadata[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) slicerMetadata[key] = value;
    else if (typeof value === "boolean") slicerMetadata[key] = value;
    else return { error: `Slicer metadata "${key}" must be a short string, number, or boolean.` };
  }
  const machineTypeDefaults = {
    "3d_printer": "3d_print",
    cnc: "cnc_machining",
    laser_cutter: "laser_cutting",
  };
  return {
    value: {
      name,
      machineId: body.machine_id,
      machineType,
      jobType: jobType.value || machineTypeDefaults[machineType],
      expectedDurationSeconds: duration,
      materialType: materialType.value,
      expectedParameters: normalizedParameters,
      slicerMetadata,
      operatorNotes: operatorNotes.value,
    },
  };
}

function jobInputForUpdate(body, existing) {
  const patch = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const patchValue = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
  const result = validJobInput(
    {
      ...patch,
      name: patchValue("name", existing.name),
      machine_id: existing.machine_id,
      job_type: patchValue("job_type", existing.job_type),
      expected_duration_seconds: patchValue("expected_duration_seconds", existing.expected_duration_seconds),
      material_type: patchValue("material_type", existing.material_type),
      expected_parameters: patchValue("expected_parameters", existing.expected_parameters),
      slicer_metadata: patchValue("slicer_metadata", existing.slicer_metadata),
      operator_notes: patchValue("operator_notes", existing.operator_notes),
    },
    existing,
  );
  if (!result.value) return result;
  const { machineId: _machineId, machineType: _machineType, ...value } = result.value;
  return { value };
}

function jobFileBody(request, response, next) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!["text/plain", "application/gcode", "application/octet-stream"].includes(contentType)) {
    return response.status(415).json({
      error: { code: "unsupported_media_type", message: "Upload G-code as text/plain or application/gcode." },
    });
  }
  express.raw({ type: contentType, limit: MAX_GCODE_BYTES })(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error.status === 413 || error.type === "entity.too.large";
    return response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "gcode_file_too_large" : "invalid_gcode_upload",
        message: tooLarge
          ? `G-code files may not exceed ${MAX_GCODE_BYTES} bytes.`
          : "The G-code upload could not be read.",
      },
    });
  });
}

function analyzeMachineHistory(database, machineId) {
  const config = getTrendConfig();
  const records = getValidTrendRecords(database, machineId);
  return { config, records, trend: analyzeTrend(records, config) };
}

function warningResponse(warning) {
  const evidence = warning.supporting_evidence || {};
  return {
    id: warning.id,
    machine_id: warning.machine_id,
    category: warning.category,
    severity: warning.severity,
    reason: warning.explanation,
    supporting_observations: evidence.supporting_observations || [],
    first_detected_timestamp: evidence.first_detected_at || warning.created_at,
    latest_detected_timestamp: evidence.latest_detected_at || warning.updated_at,
    recommended_operator_action: evidence.recommended_action || "Review the machine condition.",
    state: warning.state,
    created_at: warning.created_at,
    updated_at: warning.updated_at,
    acknowledged_at: warning.acknowledged_at,
    resolved_at: warning.resolved_at,
    operator_notes: warning.operator_notes,
  };
}

let openrouterApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
let groqApiKey = (process.env.GROQ_API_KEY || "").trim();

function configuredValueSource(name) {
  if (String(inheritedAiEnvironment[name] || "").trim()) return "process_environment";
  if (String(dotenvLoadResult.parsed?.[name] || "").trim()) return "project_env_file";
  return "default";
}

let provider = process.env.AI_PROVIDER || (openrouterApiKey ? "openrouter" : "groq");
let providerSource = process.env.AI_PROVIDER
  ? configuredValueSource("AI_PROVIDER")
  : openrouterApiKey ? "auto_detected_openrouter_key" : "default_groq";
let model = provider === "openrouter"
  ? (process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL)
  : (process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL);
let modelSource = configuredValueSource(provider === "openrouter" ? "OPENROUTER_MODEL" : "GROQ_MODEL");

let groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;
const requestTimeoutMs = Number(process.env.GROQ_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 25_000);
console.info(
  `[ai-config] provider=${provider} provider_source=${providerSource} model=${model} ` +
  `model_source=${modelSource} project_env_loaded=${Boolean(dotenvLoadResult.parsed)} ` +
  `active_key_configured=${provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groqApiKey)}`,
);

// Groq's free tier caps vision requests at 8000 tokens per minute. One 320px
// frame fits; the moment the UI starts sending the previous frame as a
// reference, the pair costs ~8.3k and every request fails with 413. When that
// happens we fall back to single-frame analysis for the rest of the run.
// Set SEND_REFERENCE_IMAGE=false to start in that mode deliberately.
let referenceImagesDisabled = /^(0|false|no|off)$/i.test(
String(process.env.SEND_REFERENCE_IMAGE ?? "").trim(),
);
function isTokenBudgetError(error) {
const message = String(
error?.error?.error?.message || error?.error?.message || error?.message || "",
);
return (
Number(error?.status) === 413 ||
/request too large|tokens per minute|reduce your message size/i.test(message)
);
}
const parseSensorJson = express.json({ limit: "4kb" });
app.use(["/api/sensors", "/api/incidents"], (request, response, next) => {
  parseSensorJson(request, response, (error) => {
    if (!error) return next();
    const tooLarge = Number(error.status) === 413;
    console.warn("Rejected sensor API JSON body:", error.message);
    return response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "sensor_payload_too_large" : "invalid_sensor_json",
        message: tooLarge
          ? "Sensor API JSON payload must not exceed 4 KB."
          : "Sensor API request body must be valid JSON.",
      },
    });
  });
});
const parseCopilotJson = express.json({ limit: "32kb" });
app.use("/api/copilot", (request, response, next) => {
  parseCopilotJson(request, response, (error) => {
    if (!error) return next();
    const tooLarge = Number(error.status) === 413;
    console.warn("Rejected Copilot API JSON body:", error.message);
    return response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "copilot_payload_too_large" : "invalid_copilot_json",
        message: tooLarge
          ? "Copilot API JSON payload must not exceed 32 KB."
          : "Copilot API request body must be valid JSON.",
      },
    });
  });
});
const parseQualityJson = express.json({ limit: "5mb" });
app.use("/api/quality", (request, response, next) => {
  parseQualityJson(request, response, (error) => {
    if (!error) return next();
    const tooLarge = Number(error.status) === 413;
    console.warn("Rejected product quality API JSON body:", error.message);
    return response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "quality_payload_too_large" : "invalid_quality_json",
        message: tooLarge
          ? "Product inspection uploads must fit within the 5 MiB request limit."
          : "Product quality API request body must be valid JSON.",
      },
    });
  });
});
app.use(express.json({ limit: "6mb" }));
// No caching on static assets — this is a locally-run dev tool, and stale
// cached JS after an update is far more confusing than a slightly slower
// reload.
app.use(
express.static("public", {
etag: false,
lastModified: false,
setHeaders: (res) => {
res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
},
}),
);

function maskKey(key) {
if (!key || key.length < 8) return "";
return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Persists a KEY=value pair into the .env file, creating the file or
// replacing an existing line for that key as needed, so a key entered from
// the browser survives a server restart.
function upsertEnvFile(updates) {
let lines = [];
if (fs.existsSync(ENV_PATH)) {
lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
}
for (const [key, value] of Object.entries(updates)) {
const index = lines.findIndex((line) => line.startsWith(`${key}=`));
const entry = `${key}=${value}`;
if (index >= 0) {
lines[index] = entry;
} else {
lines.push(entry);
}
}
const cleaned = lines.filter((line, index) => line.trim() !== "" || index === lines.length - 1);
fs.writeFileSync(ENV_PATH, cleaned.join("\n").replace(/\n*$/, "\n"), "utf8");
}

app.get("/api/health", (_request, response) => {
response.json({
ok: true,
message: "Watch Guard backend is running.",
provider,
model,
});
});

app.get("/api/machines", (_request, response) => {
  try {
    return response.json({ machines: listMachines(getDatabase()) });
  } catch (error) {
    console.error("Could not load machine overview:", error);
    return response.status(500).json({
      error: { code: "machines_unavailable", message: "Machine overview could not be loaded." },
    });
  }
});

app.get("/api/jobs", (request, response) => {
  const machineId = request.query.machine_id;
  const status = request.query.status;
  const allowedStatuses = new Set([
    "DRAFT", "READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED",
  ]);
  const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
  const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
  if (machineId !== undefined && !isValidMachineId(machineId)) {
    return response.status(400).json({
      error: { code: "invalid_machine_id", message: "Machine ID must be a UUID." },
    });
  }
  if (status !== undefined && !allowedStatuses.has(status)) {
    return response.status(400).json({
      error: { code: "invalid_job_status", message: "Job status is not recognized." },
    });
  }
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    return response.status(400).json({
      error: { code: "invalid_pagination", message: "Limit must be positive and offset non-negative." },
    });
  }
  try {
    const database = getDatabase();
    if (machineId && !findMachine(database, machineId)) {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    return response.json({
      jobs: listJobs(database, {
        machineId: machineId || null,
        status: status || null,
        limit: Math.min(limit, 200),
        offset,
      }),
      limit: Math.min(limit, 200),
      offset,
    });
  } catch (error) {
    console.error("Could not load jobs:", error);
    return response.status(500).json({
      error: { code: "jobs_unavailable", message: "Jobs could not be loaded." },
    });
  }
});

app.post("/api/jobs", (request, response) => {
  if (!isValidMachineId(request.body?.machine_id)) {
    return response.status(400).json({
      error: { code: "invalid_machine_id", message: "Machine ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    const machine = findMachine(database, request.body.machine_id);
    if (!machine) {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    const validated = validJobInput(request.body, machine);
    if (validated.error) {
      return response.status(400).json({
        error: { code: "invalid_job", message: validated.error },
      });
    }
    const result = createJob(database, validated.value);
    if (result.reason === "machine_not_found") {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    if (result.reason === "machine_type_mismatch") {
      return response.status(409).json({
        error: { code: "machine_type_mismatch", message: "Job type must match the registered machine type." },
      });
    }
    broadcast({ type: "job_created", machineId: result.job.machine_id, job: result.job });
    return response.status(201).json({ job: result.job });
  } catch (error) {
    console.error("Could not create job:", error);
    return response.status(500).json({
      error: { code: "job_create_failed", message: "The job could not be created." },
    });
  }
});

app.get("/api/jobs/:id", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const job = getJob(getDatabase(), jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    return response.json({ job });
  } catch (error) {
    console.error("Could not load job:", error);
    return response.status(500).json({
      error: { code: "job_unavailable", message: "The job could not be loaded." },
    });
  }
});

function validOperatorNotes(body) {
  if (!body || body.operator_notes === undefined || body.operator_notes === null) {
    return { value: null };
  }
  if (typeof body.operator_notes !== "string" || body.operator_notes.length > 1000) {
    return { error: "Operator notes must be a string no longer than 1000 characters." };
  }
  return { value: body.operator_notes.trim() || null };
}

function handleDeviationTransition(action) {
  return (request, response) => {
    const deviationId = request.params.id;
    if (!isValidMachineId(deviationId)) {
      return response.status(400).json({
        error: { code: "invalid_deviation_id", message: "Deviation ID must be a UUID." },
      });
    }
    const notes = validOperatorNotes(request.body);
    if (notes.error) {
      return response.status(400).json({
        error: { code: "invalid_operator_notes", message: notes.error },
      });
    }
    try {
      const database = getDatabase();
      const result = transitionDeviation(database, deviationId, action, notes.value);
      if (result.reason === "deviation_not_found") {
        return response.status(404).json({
          error: { code: "deviation_not_found", message: "No deviation exists with that ID." },
        });
      }
      if (result.reason === "invalid_transition") {
        return response.status(409).json({
          error: {
            code: "invalid_deviation_transition",
            message: `A ${result.deviation.state} deviation cannot be ${action}d.`,
          },
        });
      }
      const deviation = {
        ...result.deviation,
        initial_evidence: JSON.parse(result.deviation.initial_evidence),
        evidence: JSON.parse(result.deviation.evidence),
      };
      const eventType = action === "acknowledge"
        ? "deviation_acknowledged"
        : "deviation_resolved";
      const event = {
        id: result.event_id,
        from_state: result.from_state,
        to_state: deviation.state,
        operator_notes: notes.value,
        created_at: deviation.updated_at,
      };
      broadcast({
        type: eventType,
        machineId: deviation.machine_id,
        jobId: deviation.job_id,
        deviation: { ...deviation, lifecycle_event: event },
      });
      return response.json({ deviation, lifecycle_event: event });
    } catch (error) {
      console.error(`Could not ${action} job deviation:`, error);
      return response.status(500).json({
        error: {
          code: "deviation_transition_failed",
          message: "The deviation state could not be changed.",
        },
      });
    }
  };
}

app.post("/api/deviations/:id/acknowledge", handleDeviationTransition("acknowledge"));
app.post("/api/deviations/:id/resolve", handleDeviationTransition("resolve"));

app.post("/api/deviations/:id/investigate", async (request, response) => {
  const deviationId = request.params.id;
  if (!isValidMachineId(deviationId)) {
    return response.status(400).json({
      error: { code: "invalid_deviation_id", message: "Deviation ID must be a UUID." },
    });
  }
  try {
  const database = getDatabase();
  const deviation = database
    .prepare("SELECT * FROM job_deviations WHERE id = ?")
    .get(deviationId);
  if (!deviation) {
    return response.status(404).json({
      error: { code: "deviation_not_found", message: "No deviation exists with that ID." },
    });
  }
  const job = getJob(database, deviation.job_id);
  const machine = findMachine(database, deviation.machine_id);
  if (!job || !machine) {
    return response.status(409).json({
      error: { code: "investigation_context_unavailable", message: "The job or machine context is no longer available." },
    });
  }
  const validHistory = getValidAnalysisHistory(database, deviation.machine_id, {
    limit: 30,
    offset: 0,
  });
  const trend = publicTrendResult(
    analyzeTrend(getValidTrendRecords(database, deviation.machine_id), getTrendConfig()),
  );
  const facts = {
    deviation: {
      id: deviation.id,
      category: deviation.category,
      severity: deviation.severity,
      explanation: deviation.explanation,
      first_detected_at: deviation.first_detected_at,
      latest_detected_at: deviation.latest_detected_at,
      supporting_evidence: JSON.parse(deviation.evidence),
    },
    machine: { id: machine.id, label: machine.label, type: machine.machine_type },
    valid_machine_history: validHistory.map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      analysis_status: record.analysis_status,
      machine_status: record.machine_status,
      failure_type: record.failure_type,
      abnormality_score: record.abnormality_score,
      confidence: record.confidence,
    })),
    historical_failure_categories: [...new Set(
      validHistory
        .map((record) => record.failure_type)
        .filter((type) => type && !["none", "unknown"].includes(type)),
    )],
    phase2_trend: trend,
    telemetry: { status: "NOT_AVAILABLE", values: null },
    evidence_limitations: [
      "Camera classifications are visual AI evidence, not physical telemetry.",
      "G-code and job parameters are intended instructions, not proof of execution.",
      "No temperature, speed, power, tool-load, or controller-completion telemetry is connected.",
    ],
  };
  const evidenceIds = new Set([
    ...facts.deviation.supporting_evidence.observations.map((observation) => observation.id),
    ...facts.valid_machine_history.map((record) => record.id),
  ]);
  const evidenceFingerprint = createHash("sha256")
    .update(JSON.stringify({ facts, job: { id: job.id, updated_at: job.updated_at } }))
    .digest("hex");
  const reservation = reserveRootCauseReport(database, {
    deviation,
    provider,
    model,
    evidenceFingerprint,
    observedFacts: facts,
  });
  if (!reservation.created) {
    const statusCode = reservation.report.status === "PENDING" ? 202 : 200;
    return response.status(statusCode).json({ report: reservation.report, reused: true });
  }
  const reportId = reservation.report.id;
  const hasProviderKey = provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq);
  if (!hasProviderKey) {
    failRootCauseReport(database, reportId, "missing_provider_key");
    return response.status(503).json({
      error: { code: "root_cause_provider_unavailable", message: "No configured AI provider is available for investigation." },
    });
  }
  try {
    const rawReport = await requestStructuredCompletion(
      buildRootCausePrompt({ deviation, job, facts }),
    );
    const validatedReport = validateRootCauseResponse(rawReport, evidenceIds);
    if (!validatedReport) {
      failRootCauseReport(database, reportId, "invalid_structured_response");
      return response.status(502).json({
        error: { code: "invalid_root_cause_response", message: "The AI provider returned an invalid root-cause report." },
      });
    }
    const stored = completeRootCauseReport(database, reportId, validatedReport);
    if (!stored) throw new Error("The pending root-cause report could not be finalized.");
    const report = {
      ...reservation.report,
      status: "COMPLETED",
      report: validatedReport,
      updated_at: new Date().toISOString(),
    };
    broadcast({
      type: "root_cause_report_created",
      machineId: deviation.machine_id,
      jobId: deviation.job_id,
      report,
    });
    return response.status(201).json({ report, reused: false });
  } catch (error) {
    console.error("Root-cause investigation failed; camera monitoring is unaffected:", error);
    failRootCauseReport(
      database,
      reportId,
      error?.invalidResponse ? "invalid_provider_response" : "provider_error",
    );
    return response.status(502).json({
      error: { code: "root_cause_investigation_failed", message: "The AI investigation failed; monitoring and stored evidence remain available." },
    });
  }
  } catch (error) {
    console.error("Could not prepare root-cause investigation:", error);
    return response.status(500).json({
      error: { code: "root_cause_context_unavailable", message: "The investigation evidence could not be prepared." },
    });
  }
});

app.get("/api/jobs/:id/insights", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    const job = getJob(database, jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    return response.json({ insights: getJobInsights(database, job) });
  } catch (error) {
    console.error("Could not load job insights:", error);
    return response.status(500).json({
      error: { code: "job_insights_unavailable", message: "Job insights could not be loaded." },
    });
  }
});

app.get("/api/jobs/:id/comparison", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    if (!getJob(database, jobId)) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    return response.json({ comparisons: listJobComparisons(database, jobId) });
  } catch (error) {
    console.error("Could not load job comparisons:", error);
    return response.status(500).json({
      error: { code: "job_comparison_unavailable", message: "Job comparisons could not be loaded." },
    });
  }
});

app.post("/api/jobs/:id/comparison", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    const job = getJob(database, jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    const records = getJobAnalysisHistoryForInsights(database, job.id);
    const trend = publicTrendResult(
      analyzeTrend(getValidTrendRecords(database, job.machine_id), getTrendConfig()),
    );
    const comparison = compareJobEvidence(job, records, trend);
    const result = persistJobComparison(database, job, comparison);
    if (result.created) {
      broadcast({
        type: "job_comparison_updated",
        machineId: job.machine_id,
        jobId: job.id,
        comparison: result.comparison,
      });
    }
    return response.status(result.created ? 201 : 200).json({
      comparison: result.comparison,
      reused: !result.created,
    });
  } catch (error) {
    console.error("Could not compare job intent with available evidence:", error);
    return response.status(500).json({
      error: { code: "job_comparison_failed", message: "The job comparison could not be calculated." },
    });
  }
});

app.get("/api/jobs/:id/completion-verifications", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const job = getJob(getDatabase(), jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    return response.json({
      verifications: getJobInsights(getDatabase(), job).completion_verifications,
    });
  } catch (error) {
    console.error("Could not load completion verification history:", error);
    return response.status(500).json({
      error: { code: "completion_history_unavailable", message: "Completion verification history could not be loaded." },
    });
  }
});

app.post("/api/jobs/:id/completion-verifications", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  const action = request.body?.action;
  if (!["evaluate", "confirm"].includes(action)) {
    return response.status(400).json({
      error: { code: "invalid_completion_action", message: "Action must be evaluate or confirm." },
    });
  }
  const notes = validOperatorNotes(request.body);
  if (notes.error) {
    return response.status(400).json({
      error: { code: "invalid_operator_notes", message: notes.error },
    });
  }
  try {
    const database = getDatabase();
    const job = getJob(database, jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    if (action === "confirm" && job.status !== "COMPLETED") {
      return response.status(409).json({
        error: {
          code: "job_lifecycle_not_completed",
          message: "Mark the job COMPLETED through its lifecycle action before recording operator verification.",
        },
      });
    }
    const latestAnalysis = database.prepare(`
      SELECT id, timestamp, machine_status, analysis_status, failure_type,
             abnormality_score, confidence, risk_classification, is_uncertain
      FROM analysis_records
      WHERE job_id = ? AND is_valid = 1 AND abnormality_score IS NOT NULL
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(jobId) || null;
    const verification = evaluateCompletionVerification(job, latestAnalysis, {
      operatorConfirmed: action === "confirm",
      operatorNotes: action === "confirm" ? notes.value : null,
    });
    const stored = persistCompletionVerification(database, job, verification);
    if (!stored.reused) {
      broadcast({
        type: "job_completion_verification_updated",
        machineId: job.machine_id,
        jobId: job.id,
        verification: stored,
      });
    }
    return response.status(stored.reused ? 200 : 201).json({ verification: stored });
  } catch (error) {
    console.error("Could not record job completion verification:", error);
    return response.status(500).json({
      error: { code: "completion_verification_failed", message: "Completion verification could not be recorded." },
    });
  }
});

app.get("/api/jobs/:id/history", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  const requestedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);
  const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return response.status(400).json({
      error: {
        code: "invalid_pagination",
        message: "Limit must be positive and offset non-negative.",
      },
    });
  }
  try {
    const database = getDatabase();
    if (!getJob(database, jobId)) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    return response.json({
      job_id: jobId,
      records: getJobAnalysisHistory(database, jobId, {
        limit: Math.min(requestedLimit, 200),
        offset,
      }),
      limit: Math.min(requestedLimit, 200),
      offset,
    });
  } catch (error) {
    console.error("Could not load job analysis history:", error);
    return response.status(500).json({
      error: { code: "job_history_unavailable", message: "Job analysis history could not be loaded." },
    });
  }
});

app.patch("/api/jobs/:id", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    const existing = getJob(database, jobId);
    if (!existing) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    const validated = jobInputForUpdate(request.body, existing);
    if (validated.error) {
      return response.status(400).json({
        error: { code: "invalid_job", message: validated.error },
      });
    }
    const result = updateJob(database, jobId, validated.value);
    if (result.reason === "job_not_editable") {
      return response.status(409).json({
        error: { code: "job_not_editable", message: "Only DRAFT and READY jobs can be edited." },
      });
    }
    return response.json({ job: result.job });
  } catch (error) {
    console.error("Could not update job:", error);
    return response.status(500).json({
      error: { code: "job_update_failed", message: "The job could not be updated." },
    });
  }
});

app.post("/api/jobs/:id/gcode", jobFileBody, (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return response.status(400).json({
      error: { code: "empty_gcode_file", message: "The G-code file is empty." },
    });
  }
  try {
    const database = getDatabase();
    const job = getJob(database, jobId);
    if (!job) {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    let filename;
    try {
      filename = validateGcodeFilename(request.query.filename, job.machine_type);
    } catch (error) {
      return response.status(400).json({
        error: { code: "invalid_gcode_filename", message: error.message },
      });
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(request.body);
    } catch {
      return response.status(400).json({
        error: { code: "invalid_gcode_encoding", message: "G-code must be valid UTF-8 text." },
      });
    }
    let summary;
    try {
      summary = parseGcode(content, job.machine_type);
    } catch (error) {
      return response.status(400).json({
        error: { code: "invalid_gcode_file", message: error.message },
      });
    }
    const result = saveJobFile(database, jobId, {
      filename,
      dialect: job.machine_type,
      sizeBytes: request.body.length,
      sha256: createHash("sha256").update(request.body).digest("hex"),
      summary,
      content,
    });
    if (result.reason === "job_not_editable") {
      return response.status(409).json({
        error: { code: "job_not_editable", message: "G-code can only be uploaded to DRAFT or READY jobs." },
      });
    }
    broadcast({
      type: "job_file_uploaded",
      machineId: result.job.machine_id,
      job: result.job,
    });
    return response.status(201).json({ job: result.job });
  } catch (error) {
    console.error("Could not store G-code file:", error);
    return response.status(500).json({
      error: { code: "gcode_upload_failed", message: "The G-code file could not be stored." },
    });
  }
});

app.post("/api/jobs/:id/transition", (request, response) => {
  const jobId = request.params.id;
  if (!isValidMachineId(jobId)) {
    return response.status(400).json({
      error: { code: "invalid_job_id", message: "Job ID must be a UUID." },
    });
  }
  const nextStatus = request.body?.status;
  const supportedStatuses = new Set([
    "DRAFT", "READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED",
  ]);
  if (typeof nextStatus !== "string" || !supportedStatuses.has(nextStatus)) {
    return response.status(400).json({
      error: { code: "invalid_job_status", message: "Job status is not recognized." },
    });
  }
  try {
    const result = transitionJob(getDatabase(), jobId, nextStatus);
    if (result.reason === "job_not_found") {
      return response.status(404).json({
        error: { code: "job_not_found", message: "No job exists with that ID." },
      });
    }
    if (result.reason === "invalid_transition") {
      return response.status(409).json({
        error: { code: "invalid_job_transition", message: "That job lifecycle transition is not allowed." },
      });
    }
    if (result.reason === "machine_has_active_job") {
      return response.status(409).json({
        error: { code: "machine_has_active_job", message: "This machine already has a running or paused job." },
      });
    }
    if (result.changed) {
      const eventType = nextStatus === "RUNNING"
        ? "job_started"
        : nextStatus === "COMPLETED"
          ? "job_completed"
          : "job_status_update";
      broadcast({ type: eventType, machineId: result.job.machine_id, job: result.job });
    }
    return response.json({ job: result.job });
  } catch (error) {
    console.error("Could not transition job:", error);
    return response.status(500).json({
      error: { code: "job_transition_failed", message: "The job status could not be changed." },
    });
  }
});

app.get("/api/machines/:id/history", (request, response) => {
  const machineId = request.params.id;
  if (!isValidMachineId(machineId)) {
    return response.status(400).json({
      error: { code: "invalid_machine_id", message: "Machine ID must be a UUID." },
    });
  }

  const requestedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);
  const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return response.status(400).json({
      error: {
        code: "invalid_pagination",
        message: "Limit must be a positive integer and offset must be a non-negative integer.",
      },
    });
  }

  try {
    const database = getDatabase();
    if (!findMachine(database, machineId)) {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    const records = getValidAnalysisHistory(database, machineId, {
      limit: Math.min(requestedLimit, 200),
      offset,
    });
    return response.json({
      machine_id: machineId,
      records,
      limit: Math.min(requestedLimit, 200),
      offset,
    });
  } catch (error) {
    console.error("Could not load machine analysis history:", error);
    return response.status(500).json({
      error: { code: "history_unavailable", message: "Machine history could not be loaded." },
    });
  }
});

app.get("/api/machines/:id/trend", (request, response) => {
  const machineId = request.params.id;
  if (!isValidMachineId(machineId)) {
    return response.status(400).json({
      error: { code: "invalid_machine_id", message: "Machine ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    const machine = findMachine(database, machineId);
    if (!machine) {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    const { config, trend } = analyzeMachineHistory(database, machineId);
    return response.json({
      machine_id: machineId,
      machine_label: machine.label,
      minimum_observations: config.minimumObservations,
      risk_thresholds: {
        warning: config.riskHighThreshold,
        critical: config.riskCriticalThreshold,
      },
      ...publicTrendResult(trend),
    });
  } catch (error) {
    console.error("Could not calculate machine trend:", error);
    return response.status(500).json({
      error: { code: "trend_unavailable", message: "Machine trend could not be calculated." },
    });
  }
});

app.get("/api/machines/:id/early-warnings", (request, response) => {
  const machineId = request.params.id;
  if (!isValidMachineId(machineId)) {
    return response.status(400).json({
      error: { code: "invalid_machine_id", message: "Machine ID must be a UUID." },
    });
  }
  try {
    const database = getDatabase();
    if (!findMachine(database, machineId)) {
      return response.status(404).json({
        error: { code: "machine_not_found", message: "No machine exists with that ID." },
      });
    }
    return response.json({
      machine_id: machineId,
      warnings: listMachineWarnings(database, machineId).map(warningResponse),
    });
  } catch (error) {
    console.error("Could not load machine early warnings:", error);
    return response.status(500).json({
      error: { code: "warnings_unavailable", message: "Machine warnings could not be loaded." },
    });
  }
});

for (const transitionName of ["acknowledge", "resolve"]) {
  app.post(`/api/warnings/:warningId/${transitionName}`, (request, response) => {
    const warningId = request.params.warningId;
    if (!isValidMachineId(warningId)) {
      return response.status(400).json({
        error: { code: "invalid_warning_id", message: "Warning ID must be a UUID." },
      });
    }
    const operatorNotes =
      typeof request.body?.operator_notes === "string"
        ? request.body.operator_notes.trim().slice(0, 1000)
        : null;
    if (request.body?.operator_notes !== undefined && typeof request.body.operator_notes !== "string") {
      return response.status(400).json({
        error: { code: "invalid_operator_notes", message: "Operator notes must be a string." },
      });
    }
    try {
      const transition = transitionWarning(
        getDatabase(),
        warningId,
        transitionName,
        operatorNotes || null,
      );
      if (!transition.warning) {
        return response.status(404).json({
          error: { code: "warning_not_found", message: "No warning exists with that ID." },
        });
      }
      if (transition.conflict) {
        return response.status(409).json({
          error: { code: "warning_already_resolved", message: "A resolved warning cannot be acknowledged." },
        });
      }
      if (transition.changed) {
        const type = transitionName === "acknowledge" ? "warning_acknowledged" : "warning_resolved";
        broadcast({
          type,
          machineId: transition.warning.machine_id,
          warning: warningResponse(transition.warning),
        });
      }
      return response.json({ warning: warningResponse(transition.warning) });
    } catch (error) {
      console.error(`Could not ${transitionName} warning:`, error);
      return response.status(500).json({
        error: { code: "warning_transition_failed", message: "The warning state could not be updated." },
      });
    }
  });
}

app.get("/api/config", (_request, response) => {
const activeKey = provider === "openrouter" ? openrouterApiKey : groqApiKey;
response.json({
provider,
hasApiKey: Boolean(provider === "openrouter" ? openrouterApiKey : groq),
model,
providerSource,
modelSource,
projectEnvLoaded: Boolean(dotenvLoadResult.parsed),
maskedApiKey: maskKey(activeKey),
});
});

app.post("/api/config", (request, response) => {
const apiKey = clean(request.body?.apiKey, 200);
const requestedModel = clean(request.body?.model, 120);
const hasActiveKey = provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq);

// If no new API key is passed, allow switching the active model if an API key is already configured
if (!apiKey) {
if (!requestedModel) {
return response.status(400).json({
error: "Please enter an API key or select a model.",
});
}
try {
if (
requestedModel.startsWith("anthropic/") ||
requestedModel.startsWith("openrouter/") ||
requestedModel.startsWith("nvidia/") ||
requestedModel.startsWith("meta-llama/")
) {
if (!openrouterApiKey) {
return response.status(400).json({
error: "No OpenRouter API key configured. Enter your OpenRouter key (sk-or-v1-...).",
});
}
provider = "openrouter";
model = requestedModel;
providerSource = "runtime_settings";
modelSource = "runtime_settings";
process.env.AI_PROVIDER = "openrouter";
process.env.OPENROUTER_MODEL = model;
upsertEnvFile({ AI_PROVIDER: "openrouter", OPENROUTER_MODEL: model });
} else if (requestedModel.includes("qwen") || !requestedModel.includes("/")) {
if (!groq) {
return response.status(400).json({
error: "No Groq API key configured for scanning. Enter your Groq key (gsk_...).",
});
}
provider = "groq";
model = requestedModel;
providerSource = "runtime_settings";
modelSource = "runtime_settings";
process.env.AI_PROVIDER = "groq";
process.env.GROQ_MODEL = model;
upsertEnvFile({ AI_PROVIDER: "groq", GROQ_MODEL: model });
} else {
model = requestedModel;
modelSource = "runtime_settings";
if (provider === "openrouter") {
process.env.OPENROUTER_MODEL = model;
upsertEnvFile({ OPENROUTER_MODEL: model });
} else {
process.env.GROQ_MODEL = model;
upsertEnvFile({ GROQ_MODEL: model });
}
}
console.log(`Scanning model switched to: ${model} (${provider}).`);
const activeKey = provider === "openrouter" ? openrouterApiKey : groqApiKey;
return response.json({
ok: true,
provider,
model,
providerSource,
modelSource,
maskedApiKey: maskKey(activeKey),
});
} catch (error) {
console.error("Failed to update model:", error);
return response.status(500).json({ error: "The model could not be saved on the server." });
}
}

const isOpenRouterKey = apiKey.startsWith("sk-or-") || (apiKey.startsWith("sk-") && !apiKey.startsWith("gsk_"));
const isGroqKey = apiKey.startsWith("gsk_");

if (!isOpenRouterKey && !isGroqKey) {
return response.status(400).json({
error: "Please enter a valid OpenRouter API key (starts with 'sk-or-') or Groq API key (starts with 'gsk_').",
});
}
try {
if (isOpenRouterKey) {
provider = "openrouter";
providerSource = "runtime_settings";
openrouterApiKey = apiKey;
process.env.AI_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = apiKey;
if (requestedModel) {
model = requestedModel;
modelSource = "runtime_settings";
process.env.OPENROUTER_MODEL = requestedModel;
} else if (!model || !model.includes("/")) {
model = DEFAULT_OPENROUTER_MODEL;
modelSource = "default";
process.env.OPENROUTER_MODEL = model;
}
upsertEnvFile({
AI_PROVIDER: "openrouter",
OPENROUTER_API_KEY: apiKey,
OPENROUTER_MODEL: model,
});
console.log(`OpenRouter key configured (${maskKey(apiKey)}). Model: ${model}`);
} else {
provider = "groq";
providerSource = "runtime_settings";
groqApiKey = apiKey;
groq = new Groq({ apiKey });
process.env.AI_PROVIDER = "groq";
process.env.GROQ_API_KEY = apiKey;
if (requestedModel) {
model = requestedModel;
modelSource = "runtime_settings";
process.env.GROQ_MODEL = requestedModel;
} else if (!model || model.startsWith("anthropic/") || model.startsWith("meta-llama/") || model.startsWith("nvidia/")) {
model = DEFAULT_GROQ_MODEL;
modelSource = "default";
process.env.GROQ_MODEL = model;
}
upsertEnvFile({
AI_PROVIDER: "groq",
GROQ_API_KEY: apiKey,
GROQ_MODEL: model,
});
console.log(`Groq API key configured (${maskKey(apiKey)}). Model: ${model}`);
}
response.json({
ok: true,
provider,
model,
providerSource,
modelSource,
maskedApiKey: maskKey(apiKey),
});
} catch (error) {
console.error("Failed to save API key:", error);
response.status(500).json({ error: "The key could not be saved on the server." });
}
});
function isImage(value) {
return typeof value === "string" && value.startsWith("data:image/");
}
function clean(value, maximumLength = 280) {
return String(value ?? "").trim().slice(0, maximumLength);
}
function clamp(value, minimum, maximum, fallback = 0) {
const number = Number(value);
return Number.isFinite(number)
? Math.max(minimum, Math.min(maximum, number))
: fallback;
}
function normalizeHex(value) {
const text = String(value ?? "").trim().toUpperCase();
if (/^#[0-9A-F]{6}$/.test(text)) return text;
if (/^[0-9A-F]{6}$/.test(text)) return `#${text}`;
return "#808080";
}
function normalizeColors(rawColors) {
if (!Array.isArray(rawColors)) return [];
const seen = new Set();
return rawColors
.map((color) => ({
name: clean(color?.name || "Unknown", 30),
hex: normalizeHex(color?.hex),
confidence: clamp(color?.confidence, 0, 1, 0),
coverage: clamp(color?.coverage, 0, 1, 0),
}))
.filter((color) => {
const key = `${color.name.toLowerCase()}-${color.hex}`;
if (seen.has(key)) return false;
seen.add(key);
return true;
})
.sort((a, b) => b.coverage - a.coverage || b.confidence - a.confidence)
.slice(0, 4);
}
function normalizeBox(rawBox) {
const empty = { x: 0, y: 0, width: 0, height: 0 };
if (!rawBox || typeof rawBox !== "object") return empty;
const x = clamp(rawBox.x, 0, 1, 0);
const y = clamp(rawBox.y, 0, 1, 0);
const width = clamp(rawBox.width, 0, Math.max(0, 1 - x), 0);
const height = clamp(rawBox.height, 0, Math.max(0, 1 - y), 0);
const minimumFraction = 0.015;
if (width < minimumFraction || height < minimumFraction) return empty;
return { x, y, width, height };
}
function chooseReference({
previousImageDataUrl,
expectedPartReferenceDataUrl,
emptyPlateReferenceDataUrl,
}) {
const candidates = [
{
type: "previous",
label: "PREVIOUS CAMERA FRAME — compare this with the current frame",
image: previousImageDataUrl,
},
{
type: "expected",
label: "EXPECTED OR KNOWN-GOOD PART REFERENCE",
image: expectedPartReferenceDataUrl,
},
{
type: "empty",
label: "EMPTY BUILD-PLATE REFERENCE",
image: emptyPlateReferenceDataUrl,
},
];
return candidates.find((item) => isImage(item.image)) || null;
}
function machineInstructions(machineType) {
if (machineType === "laser_cutter") {
return `
Inspect a laser cutter camera frame.
Normal may include a workpiece, fixtures, ordinary cutting glow, brief sparks,
light smoke, reflections, residue, and the machine frame.
A machine needs attention when there is sustained flame, excessive smoke,
serious scorching, abnormal material reaction, exhaust failure, or an unusable view.
Automatic machine_status rules:
- printing: a workpiece or active cutting job is visibly present and no problem is visible
- idle: the work area is visibly empty
- needs_attention: a warning, failure, unsafe condition, or unreliable camera view is visible
Allowed failure_type values:
none, excess_smoke, flame, scorching, exhaust_problem,
material_problem, camera_problem, unknown
`;
}
if (machineType === "cnc") {
return `
Inspect a CNC or router camera frame.
Normal may include a workpiece, clamps, fixtures, ordinary chips, dust,
coolant, and normal cutting marks.
A machine needs attention when the workpiece shifted, fixturing failed,
chip buildup is extreme, a tool appears damaged, the toolpath appears wrong,
or the camera view is unreliable.
Automatic machine_status rules:
- printing: a workpiece or machining job is visibly present and no problem is visible
- idle: the work area is visibly empty
- needs_attention: a warning, failure, abnormal condition, or unreliable view is visible
Allowed failure_type values:
none, workpiece_shift, bad_fixturing, chip_buildup,
tool_damage, chatter, path_problem, zero_problem,
camera_problem, unknown
`;
}
return `
Inspect an FDM 3D-printer build plate.
First classify material_pattern:
- empty: no meaningful printed object and no failed plastic
- intentional_solid_geometry: organized layers, walls, surfaces, curves, edges,
holes, or deliberate manufactured geometry
- chaotic_loose_filament: many random overlapping loops, coils, bird-nest strands,
or tangled plastic without a dominant coherent object
- plastic_blob: a dense irregular mass of melted plastic
- unclear
Then classify attachment_state:
- not_applicable
- attached_flat
- edge_lifted
- partially_detached
- fully_detached
- tipped_or_displaced
- unclear
Failure priority:
1. A coherent solid part lifting from the plate is bed_adhesion, not spaghetti.
2. A fully separated coherent part is detachment.
3. A moved or tipped coherent part is tipped_object.
4. Spaghetti requires many random loops or a tangled mass.
5. One isolated strand does not make a coherent part spaghetti.
6. Build plate, rails, nozzle, clips, markings, screws, frame, and cables are not obstructions.
7. Examine the entire visible perimeter of the printed object, especially corners and edges
   closest to the camera, before concluding it is fully and flatly attached. A small raised
   corner or curled edge is still bed_adhesion evidence even if the rest of the part looks fine.
Automatic machine_status must be exactly one of:
- printing: ANY meaningful printed object or printed material is visible on the build plate,
and no warning or failure is visible. For this prototype, an object remaining on the plate
is treated as Printing even if actual motor motion cannot be proven from one still image.
- idle: the build plate is visible and no meaningful object or failed plastic is present.
- needs_attention: a warning, failure, lifted part, detachment, spaghetti, blob, smoke,
camera problem, or uncertain/unreliable view is present.
Filament color rules:
- Detect only colors belonging to visible printed filament or the printed part.
- Ignore the build plate, printer frame, nozzle, cables, background, glare, reflections, and shadows.
- Return no more than four dominant filament colors.
- Give each color a common name and approximate six-digit HEX value.
- If no printed material is visible, return an empty array.
Allowed failure_type values:
none, spaghetti, first_layer, detachment, bed_adhesion,
layer_shift, tipped_object, nozzle_blob, nozzle_drag,
smoke, camera_problem, unknown
`;
}
function normalizeResult(raw, context) {
const allowedStatuses = new Set(["normal", "warning", "failure", "unclear"]);
const allowedScenes = new Set([
"idle_empty_build_plate",
"object_on_build_plate",
"printing_normally",
"printing_suspicious",
"printing_failure",
"failed_material_on_plate",
"camera_unusable",
"unknown",
]);
const allowedPatterns = new Set([
"empty",
"intentional_solid_geometry",
"chaotic_loose_filament",
"plastic_blob",
"unclear",
]);
const allowedAttachment = new Set([
"not_applicable",
"attached_flat",
"edge_lifted",
"partially_detached",
"fully_detached",
"tipped_or_displaced",
"unclear",
]);
const allowedLooseFilament = new Set([
"none",
"isolated_strand",
"multiple_loops",
"tangled_mass",
"unclear",
]);
const allowedActions = new Set([
"continue",
"inspect_machine",
"strongly_consider_pause",
"stop_and_inspect",
]);
const result = {
scene_state: allowedScenes.has(raw?.scene_state)
? raw.scene_state
: "unknown",
material_pattern: allowedPatterns.has(raw?.material_pattern)
? raw.material_pattern
: "unclear",
attachment_state: allowedAttachment.has(raw?.attachment_state)
? raw.attachment_state
: "unclear",
loose_filament_extent: allowedLooseFilament.has(raw?.loose_filament_extent)
? raw.loose_filament_extent
: "unclear",
build_plate_visible: Boolean(raw?.build_plate_visible),
printed_part_visible: Boolean(raw?.printed_part_visible),
failed_material_visible: Boolean(raw?.failed_material_visible),
temporal_change_detected: Boolean(raw?.temporal_change_detected),
machine_status: "needs_attention",
status_confidence: clamp(raw?.status_confidence, 0, 1, 0),
detected_colors: normalizeColors(raw?.detected_colors),
status: allowedStatuses.has(raw?.status) ? raw.status : "unclear",
failure_type: clean(raw?.failure_type || "unknown", 60).toLowerCase(),
failure_box: normalizeBox(raw?.failure_box),
confidence: clamp(raw?.confidence, 0, 1, 0),
severity: Math.round(clamp(raw?.severity, 0, 10, 0)),
should_notify_user: Boolean(raw?.should_notify_user),
recommended_action: allowedActions.has(raw?.recommended_action)
? raw.recommended_action
: "inspect_machine",
reason: clean(raw?.reason || "No explanation was returned."),
evidence: clean(raw?.evidence || "No specific evidence was returned."),
probable_cause: clean(raw?.probable_cause || "unknown", 220),
next_step: clean(raw?.next_step || "Inspect the machine.", 220),
machine_status_reason: clean(
raw?.machine_status_reason || "The camera result requires review.",
220,
),
};
if (context.machineType === "3d_printer") {
const coherentPart = result.material_pattern === "intentional_solid_geometry";
const partialLift = ["edge_lifted", "partially_detached"].includes(
result.attachment_state,
);
const strongSpaghetti =
result.material_pattern === "chaotic_loose_filament" &&
["multiple_loops", "tangled_mass"].includes(result.loose_filament_extent);
if (coherentPart && partialLift) {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "bed_adhesion",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 7),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason:
"A coherent printed part is visibly lifting or warping away from the build plate.",
evidence:
"An edge or section appears raised, curled, bowed, or separated while the part retains intentional geometry.",
probable_cause:
"Possible adhesion loss, warping, contamination, or insufficient first-layer bonding.",
next_step:
"Pause the print and inspect bed cleanliness, leveling, temperature, and first-layer adhesion.",
});
} else if (coherentPart && result.attachment_state === "fully_detached") {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "detachment",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason:
"A coherent printed part appears fully separated from its build-plate footprint.",
evidence:
"The object has intentional geometry but no longer appears seated normally on the plate.",
probable_cause:
"Possible adhesion loss, warping, plate contamination, or first-layer failure.",
next_step:
"Stop the print and inspect the build surface and first-layer settings.",
});
} else if (coherentPart && result.attachment_state === "tipped_or_displaced") {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "tipped_object",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason: "The printed part appears tipped, displaced, or moved from its normal position.",
evidence:
"The solid object appears rotated, leaned, raised, or shifted relative to the plate.",
probable_cause:
"Possible adhesion loss, nozzle collision, warping, or insufficient support.",
next_step:
"Stop the print and inspect adhesion, supports, and possible nozzle contact.",
});
} else if (strongSpaghetti) {
Object.assign(result, {
scene_state: "failed_material_on_plate",
failed_material_visible: true,
status: "failure",
failure_type: "spaghetti",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason: "Multiple uncontrolled filament loops or a tangled filament mass are visible.",
evidence:
"Random loose strands and overlapping coils dominate instead of a coherent printed shape.",
probable_cause:
"The print may have lost adhesion or continued extruding after the intended geometry failed.",
next_step:
"Stop the print, remove failed filament, and inspect bed adhesion and the first layer.",
});
} else if (result.failure_type === "spaghetti" && !strongSpaghetti) {
result.status = partialLift ? "failure" : "warning";
result.failure_type = partialLift ? "bed_adhesion" : "unknown";
result.severity = partialLift
? Math.max(result.severity, 7)
: Math.min(Math.max(result.severity, 3), 5);
result.recommended_action = partialLift
? "stop_and_inspect"
: "inspect_machine";
result.reason = partialLift
? "The image is more consistent with a solid part lifting from the plate than with spaghetti."
: "There is not enough loose-loop evidence to confirm spaghetti.";
}
}
const visibleProblem =
result.status === "failure" ||
result.status === "warning" ||
result.status === "unclear" ||
result.failed_material_visible ||
result.failure_type === "camera_problem" ||
result.failure_type === "smoke" ||
(result.failure_type !== "none" && result.failure_type !== "unknown");
const visiblyEmpty =
result.build_plate_visible &&
result.material_pattern === "empty" &&
!result.printed_part_visible &&
!result.failed_material_visible;
const visibleObject =
result.printed_part_visible ||
[
"intentional_solid_geometry",
"chaotic_loose_filament",
"plastic_blob",
].includes(result.material_pattern);
if (visibleProblem) {
result.machine_status = "needs_attention";
result.status_confidence = Math.max(result.status_confidence, 0.82);
result.machine_status_reason =
"The camera detected a warning, failure, or condition that requires inspection.";
} else if (visiblyEmpty) {
result.machine_status = "idle";
result.status_confidence = Math.max(result.status_confidence, 0.84);
result.machine_status_reason =
"The build plate is visible and no meaningful printed object or failed material is present.";
result.detected_colors = [];
result.status = "normal";
result.failure_type = "none";
result.failure_box = { x: 0, y: 0, width: 0, height: 0 };
result.severity = 0;
result.should_notify_user = false;
result.recommended_action = "continue";
} else if (visibleObject) {
result.machine_status = "printing";
result.status_confidence = Math.max(result.status_confidence, 0.76);
result.machine_status_reason =
"Meaningful printed material or a printed object is visible on the build plate.";
result.failure_box = { x: 0, y: 0, width: 0, height: 0 };
} else {
result.machine_status = "needs_attention";
result.status_confidence = Math.max(result.status_confidence, 0.55);
result.machine_status_reason =
"The camera could not confidently determine whether the build plate is empty or contains a print.";
}
if (!visibleObject && result.material_pattern === "empty") {
result.detected_colors = [];
}
return result;
}
function extractJson(text) {
const trimmed = String(text ?? "").trim();
const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
const body = fenced ? fenced[1].trim() : trimmed;
const start = body.indexOf("{");
const end = body.lastIndexOf("}");
if (start === -1 || end === -1 || end < start) return body;
return body.slice(start, end + 1);
}
function isValidAnalysisResponse(value) {
return Boolean(
  value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["normal", "warning", "failure", "unclear"].includes(value.status) &&
    Number.isFinite(value.severity) &&
    value.severity >= 0 &&
    value.severity <= 10 &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.failure_type === "string" &&
    value.failure_type.trim(),
);
}
async function requestAnalysis(content) {
if (provider !== "groq" && provider !== "openrouter") {
  const error = new Error(`Unsupported AI_PROVIDER value "${provider}". Use "groq" or "openrouter".`);
  error.code = "provider_configuration_error";
  throw error;
}
const maxAttempts = 2;
let lastRawText = "";
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
let rawText = "";
if (provider === "openrouter") {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
try {
const fetchRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
method: "POST",
headers: {
"Authorization": `Bearer ${openrouterApiKey}`,
"Content-Type": "application/json",
"HTTP-Referer": "http://localhost:3001",
"X-Title": "Watch Guard",
},
body: JSON.stringify({
model,
messages: [{ role: "user", content }],
response_format: { type: "json_object" },
temperature: 0,
max_tokens: 2048,
}),
signal: controller.signal,
});

if (!fetchRes.ok) {
const errBody = await fetchRes.json().catch(() => ({}));
const errMsg =
errBody?.error?.message ||
fetchRes.statusText ||
`OpenRouter HTTP ${fetchRes.status}`;
const err = new Error(errMsg);
err.status = fetchRes.status;
err.error = errBody;
err.provider = "OpenRouter";
throw err;
}

const data = await fetchRes.json();
rawText = data?.choices?.[0]?.message?.content || "";
} finally {
clearTimeout(timer);
}
} else {
if (!groq) {
throw new Error("No Groq client configured. Please provide a Groq API key.");
}
const isReasoningModel = /qwen|deepseek/i.test(model);
const completion = await groq.chat.completions.create(
{
model,
messages: [{ role: "user", content }],
response_format: { type: "json_object" },
...(isReasoningModel ? { reasoning_effort: "none", reasoning_format: "hidden" } : {}),
temperature: 0,
max_completion_tokens: 2048,
stream: false,
},
{ timeout: requestTimeoutMs, maxRetries: 2 },
);
rawText = completion.choices[0]?.message?.content || "";
}

if (!rawText) {
lastRawText = "";
continue;
}
try {
const rawResult = JSON.parse(extractJson(rawText));
if (!isValidAnalysisResponse(rawResult)) {
  lastRawText = rawText;
  console.error(`Attempt ${attempt}/${maxAttempts} returned malformed analysis fields.`);
  continue;
}
return { rawResult, attempts: attempt };
} catch {
lastRawText = rawText;
console.error(
`Attempt ${attempt}/${maxAttempts} returned unparseable JSON:`,
rawText.slice(0, 300),
);
}
}
const providerLabel = provider === "openrouter" ? "OpenRouter" : "Groq";
const error = new Error(`${providerLabel} returned text that was not valid JSON after retrying.`);
error.invalidJson = true;
error.rawText = lastRawText;
throw error;
}
async function requestStructuredCompletion(content) {
let rawText = "";
if (provider === "openrouter") {
if (!openrouterApiKey) throw new Error("No OpenRouter API key is configured.");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
try {
const fetchRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
method: "POST",
headers: {
"Authorization": `Bearer ${openrouterApiKey}`,
"Content-Type": "application/json",
"HTTP-Referer": "http://localhost:3001",
"X-Title": "Watch Guard",
},
body: JSON.stringify({
model,
messages: [{ role: "user", content }],
response_format: { type: "json_object" },
temperature: 0,
max_tokens: 1800,
}),
signal: controller.signal,
});
if (!fetchRes.ok) {
const error = new Error(`OpenRouter returned HTTP ${fetchRes.status}.`);
error.status = fetchRes.status;
throw error;
}
const result = await fetchRes.json();
rawText = result?.choices?.[0]?.message?.content || "";
} finally {
clearTimeout(timer);
}
} else {
if (!groq) throw new Error("No Groq client is configured.");
const isReasoningModel = /qwen|deepseek/i.test(model);
const completion = await groq.chat.completions.create(
{
model,
messages: [{ role: "user", content }],
response_format: { type: "json_object" },
...(isReasoningModel ? { reasoning_effort: "none", reasoning_format: "hidden" } : {}),
temperature: 0,
max_completion_tokens: 1800,
stream: false,
},
{ timeout: requestTimeoutMs, maxRetries: 1 },
);
rawText = completion.choices[0]?.message?.content || "";
}
if (!rawText) {
const error = new Error("The AI provider returned an empty root-cause response.");
error.invalidResponse = true;
throw error;
}
try {
return JSON.parse(extractJson(rawText));
} catch {
const error = new Error("The AI provider returned malformed root-cause JSON.");
error.invalidResponse = true;
throw error;
}
}
const CONFIRMATION_STREAK = Number(process.env.CONFIRMATION_STREAK || 3);
const cameraConfirmations = new Map();
function getCameraConfirmation(cameraId) {
if (!cameraConfirmations.has(cameraId)) {
cameraConfirmations.set(cameraId, { streak: 0, confirmed: false });
}
return cameraConfirmations.get(cameraId);
}
function updateConfirmation(cameraId, result) {
const state = getCameraConfirmation(cameraId);
const problem = result.machine_status === "needs_attention";
state.streak = problem ? state.streak + 1 : 0;
const wasConfirmed = state.confirmed;
state.confirmed = problem && state.streak >= CONFIRMATION_STREAK;
return {
confirmation_streak: Math.min(state.streak, CONFIRMATION_STREAK),
confirmation_target: CONFIRMATION_STREAK,
confirmed_failure: state.confirmed,
newly_confirmed: state.confirmed && !wasConfirmed,
newly_recovered: wasConfirmed && !state.confirmed,
};
}
// Warnings are posted the first time a given problem state is seen on a camera,
// then held back until the state changes or the problem has persisted for
// DISCORD_REPEAT_MS. Without this, a stuck camera would post one message per
// analysed frame and hit Discord's per-webhook rate limit within a minute.
const REPEAT_ALERT_MS = Number(process.env.DISCORD_REPEAT_MS || 600_000);
const cameraAlertState = new Map();
function problemSignature(result) {
return `${result.status}:${result.failure_type}:${result.machine_status}`;
}
function shouldAlertProblem(cameraId, result) {
const signature = problemSignature(result);
const previous = cameraAlertState.get(cameraId);
const now = Date.now();
if (
previous &&
previous.signature === signature &&
now - previous.lastAlertAt < REPEAT_ALERT_MS
) {
return false;
}
cameraAlertState.set(cameraId, { signature, lastAlertAt: now });
return true;
}
function markAlerted(cameraId, result) {
cameraAlertState.set(cameraId, {
signature: problemSignature(result),
lastAlertAt: Date.now(),
});
}

let wss = null;
let sensorHealthTimer = null;
let processHandlersRegistered = false;
function broadcast(message) {
if (!wss) return;
const payload = JSON.stringify(message);
for (const client of wss.clients) {
if (client.readyState === client.OPEN) client.send(payload);
}
}
const simulationService = createSimulationService({ databaseProvider: getDatabase, broadcast });
app.use("/api", createSensorRouter({ broadcast }));
app.use("/api", createSimulationRouter({ service: simulationService }));
app.use("/api/quality", createProductQualityRouter({
  databaseProvider: getDatabase,
  getProviderState: () => ({
    providerName: provider === "openrouter" ? "OpenRouter" : "Groq",
    model,
    hasApiKey: provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq),
  }),
  completeVision: async (messages, { maxTokens, timeoutMs }) => {
    const timeout = Math.min(60_000, Math.max(1_000, Number(timeoutMs) || requestTimeoutMs));
    if (provider === "openrouter") {
      if (!openrouterApiKey) {
        const error = new Error("OpenRouter API key is not configured.");
        error.code = "provider_configuration_error";
        throw error;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openrouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3001",
            "X-Title": "Vision OPS Product Quality Inspection",
          },
          body: JSON.stringify({
            model,
            messages,
            response_format: { type: "json_object" },
            temperature: 0,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        if (!result.ok) {
          const error = new Error(`OpenRouter returned HTTP ${result.status}.`);
          error.status = result.status;
          throw error;
        }
        const payload = await result.json();
        return payload?.choices?.[0]?.message?.content;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!groq) {
      const error = new Error("Groq API key is not configured.");
      error.code = "provider_configuration_error";
      throw error;
    }
    const isReasoningModel = /qwen|deepseek/i.test(model);
    const completion = await groq.chat.completions.create(
      {
        model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0,
        max_completion_tokens: maxTokens,
        stream: false,
        ...(isReasoningModel ? { reasoning_effort: "none", reasoning_format: "hidden" } : {}),
      },
      { timeout, maxRetries: 0 },
    );
    return completion.choices[0]?.message?.content;
  },
}));
app.use("/api/copilot", createCopilotRouter({
  databaseProvider: getDatabase,
  getProviderState: () => ({
    providerName: provider === "openrouter" ? "OpenRouter" : "Groq",
    model,
    hasApiKey: provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq),
    secrets: [groqApiKey, openrouterApiKey],
  }),
  complete: async (messages, { maxTokens, timeoutMs }) => {
    const timeout = Math.min(60_000, Math.max(1_000, Number(timeoutMs) || requestTimeoutMs));
    if (provider === "openrouter") {
      if (!openrouterApiKey) {
        const error = new Error("OpenRouter API key is not configured.");
        error.code = "provider_configuration_error";
        throw error;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openrouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3001",
            "X-Title": "Vision OPS Manufacturing Copilot",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        if (!result.ok) {
          const error = new Error(`OpenRouter returned HTTP ${result.status}.`);
          error.status = result.status;
          throw error;
        }
        const payload = await result.json();
        return payload?.choices?.[0]?.message?.content;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!groq) {
      const error = new Error("Groq API key is not configured.");
      error.code = "provider_configuration_error";
      throw error;
    }
    const isReasoningModel = /qwen|deepseek/i.test(model);
    const completion = await groq.chat.completions.create(
      {
        model,
        messages,
        temperature: 0.2,
        max_completion_tokens: maxTokens,
        stream: false,
        ...(isReasoningModel ? { reasoning_effort: "none", reasoning_format: "hidden" } : {}),
      },
      { timeout, maxRetries: 0 },
    );
    return completion.choices[0]?.message?.content;
  },
}));
// Notification wiring lives in notifications.mjs; these endpoints let the
// webhook be configured and tested without touching the UI.
app.get("/api/notifications", (_request, response) => {
const { configured, invalidUrl, notifyErrors, notifyRecovery: recovery, attachSnapshots } =
describeNotifications();
response.json({ configured, invalidUrl, notifyErrors, notifyRecovery: recovery, attachSnapshots });
});

app.post("/api/notifications", (request, response) => {
// Clearing the webhook has to be deliberate — a malformed request must not
// silently switch alerting off.
if (typeof request.body?.webhookUrl !== "string") {
return response.status(400).json({
error: 'Send {"webhookUrl": "https://discord.com/api/webhooks/..."}, or an empty string to disable alerts.',
});
}
const webhookUrl = clean(request.body.webhookUrl, 300);
if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
return response.status(400).json({
error: "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/...).",
});
}
try {
process.env.DISCORD_WEBHOOK_URL = webhookUrl;
upsertEnvFile({ DISCORD_WEBHOOK_URL: webhookUrl });
console.log(
webhookUrl
? "Discord webhook configured; failure and error alerts are enabled."
: "Discord webhook cleared; alerts are disabled.",
);
response.json({ ok: true, configured: Boolean(webhookUrl) });
} catch (error) {
console.error("Failed to save the Discord webhook:", error);
response.status(500).json({ error: "The webhook URL could not be saved on the server." });
}
});

app.post("/api/notifications/test", async (_request, response) => {
if (!describeNotifications().configured) {
return response.status(400).json({
error: "No Discord webhook is configured. Set DISCORD_WEBHOOK_URL in .env or POST it to /api/notifications.",
});
}
const outcome = await notifyTest();
if (outcome?.ok) return response.json({ ok: true });
response.status(502).json({
error: "Discord rejected the test message.",
details: String(outcome?.error || outcome?.status || "unknown"),
});
});
const printerDrivers = {
none: {
async pause() {
return { ok: false, skipped: true, reason: "No PRINTER_DRIVER configured." };
},
},
octoprint: {
async pause() {
const baseUrl = process.env.OCTOPRINT_URL;
const apiKey = process.env.OCTOPRINT_API_KEY;
if (!baseUrl || !apiKey) {
return { ok: false, skipped: true, reason: "OCTOPRINT_URL or OCTOPRINT_API_KEY is missing." };
}
try {
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/job`, {
method: "POST",
headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
body: JSON.stringify({ command: "pause", action: "pause" }),
});
return { ok: response.ok, status: response.status };
} catch (driverError) {
return { ok: false, error: driverError.message };
}
},
},
moonraker: {
async pause() {
const baseUrl = process.env.MOONRAKER_URL;
if (!baseUrl) {
return { ok: false, skipped: true, reason: "MOONRAKER_URL is missing." };
}
try {
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/printer/print/pause`, {
method: "POST",
});
return { ok: response.ok, status: response.status };
} catch (driverError) {
return { ok: false, error: driverError.message };
}
},
},
};
async function pausePrinter() {
const driverName = process.env.PRINTER_DRIVER || "none";
const driver = printerDrivers[driverName] || printerDrivers.none;
return driver.pause();
}
app.post("/api/analyze-machine", async (request, response) => {
const body = request.body && typeof request.body === "object" ? request.body : {};
const suppliedCameraId =
 typeof body.cameraId === "string" && body.cameraId.trim()
   ? body.cameraId.trim().slice(0, 200)
   : null;
const cameraId = suppliedCameraId || "default";
const cameraLabel = clean(body.cameraLabel, 100) || cameraId;
const machineType = clean(body.machineType || "3d_printer", 60) || "3d_printer";
let machine = null;
let activeJob = null;
try {
 if (suppliedCameraId) {
   try {
     machine = registerMachine(getDatabase(), {
       cameraId: suppliedCameraId,
       label: cameraLabel,
       machineType,
     });
   } catch (error) {
     console.error("Could not register the camera's machine identity:", error);
   }
 } else {
   console.warn("Analysis request has no camera deviceId; it will not be linked to an existing machine.");
 }
 if (machine) {
   try {
     activeJob = findActiveJobForMachine(getDatabase(), machine.id);
   } catch (error) {
     console.error("Could not load active job context; continuing without job context:", error);
   }
 }
 const recordInvalidAttempt = ({ reason, errorCategory }) => {
   try {
     persistInvalidAnalysis(getDatabase(), {
       machineId: machine?.id || null,
       machineType,
       reason,
       provider,
       errorCategory,
       cameraId: suppliedCameraId,
       jobId: activeJob?.id || null,
     });
   } catch (error) {
     console.error("Could not persist invalid analysis audit record:", error);
   }
 };
try {
const hasKey = provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq);
if (!hasKey) {
const providerLabel = provider === "openrouter" ? "OpenRouter" : "Groq";
recordInvalidAttempt({
 reason: `No ${providerLabel} API key is configured.`,
 errorCategory: "missing_api_key",
});
return response.status(401).json({
error: `No ${providerLabel} API key is configured yet. Add one in .env or the setup screen.`,
code: "missing_api_key",
});
}
const {
currentImageDataUrl,
emptyPlateReferenceDataUrl,
expectedPartReferenceDataUrl,
previousImageDataUrl,
jobContext = {},
} = body;
if (!isImage(currentImageDataUrl)) {
recordInvalidAttempt({
 reason: "A valid current camera image was not received.",
 errorCategory: "invalid_camera_input",
});
return response.status(400).json({
error: "A valid current camera image was not received.",
});
}
const reference = chooseReference({
previousImageDataUrl,
expectedPartReferenceDataUrl,
emptyPlateReferenceDataUrl,
});
const images = [];
if (reference) images.push(reference);
images.push({
type: "current",
label: "CURRENT CAMERA FRAME — classify this image now",
image: currentImageDataUrl,
});
const totalCharacters = images.reduce(
(total, item) => total + item.image.length,
0,
);
// Groq's free/on-demand tier caps requests at a few thousand tokens per
// minute. Vision token cost scales mainly with pixel dimensions, not file
// size, so this is a loose backstop against something unexpectedly large
// (e.g. a full-resolution upload) slipping through — normal 384px frames
// land far below this.
if (totalCharacters > 350_000) {
recordInvalidAttempt({
  reason: "The camera frame request exceeded the supported image size.",
  errorCategory: "image_too_large",
});
return response.status(413).json({
error:
"The combined images are too large for the current Groq rate limit. Reduce camera resolution/quality or clear an unnecessary reference image.",
});
}
const safeJobContext = {
cameraName: clean(jobContext.cameraName, 100),
material: clean(jobContext.material, 80),
operator: clean(jobContext.operator, 80),
registeredJob: activeJob
  ? {
      id: activeJob.id,
      name: activeJob.name,
      status: activeJob.status,
      job_type: activeJob.job_type,
      machine_type: activeJob.machine_type,
      material_type: activeJob.material_type,
      expected_duration_seconds: activeJob.expected_duration_seconds,
      expected_parameters: activeJob.expected_parameters,
      gcode_summary: activeJob.file?.summary || null,
    }
  : null,
};
// Rebuilt per attempt: if the reference image has to be dropped to fit the
// token budget, the prompt must stop claiming one was sent.
const buildPrompt = (referenceType) => `
You are Watch Guard, a conservative fabrication-machine visual inspector.
Use only visible evidence. Never invent motion, sound, heat, smoke, or events.
If registeredJob is present in context, treat its settings and parsed program only as operator intent;
they are not measured telemetry and do not prove execution. Do not claim a temperature, spindle,
feed-rate, or progress mismatch unless the corresponding sensor/evidence is actually available.
If expected progress cannot be compared with visible evidence, describe it as unavailable rather
than a failure. Missing telemetry is unknown, not a deviation.
When the evidence sits between two classifications, prefer the one that flags a possible
problem over the one that assumes the machine is fine — a small, easy-to-miss issue (one
lifted corner, one stray strand, a faint smoke haze) still counts as visible evidence and
must not be reported as "none" or "normal". Only act on what is actually visible; do not
invent a problem in a genuinely clean frame.
Machine type: ${machineType}
Context: ${JSON.stringify(safeJobContext)}
Reference image type: ${referenceType}
${machineInstructions(machineType)}
If a PREVIOUS CAMERA FRAME is included, compare it with the CURRENT CAMERA FRAME
and set temporal_change_detected only when a meaningful visible change exists.
The machine_status must be exactly one of:
printing, needs_attention, idle
Failure location:
- If failure_type is not "none", set failure_box to the tightest rectangle around the single
  clearest piece of visible evidence for that failure_type (the lifted corner, the tangled
  strands, the detached section, the smoke plume, the shifted workpiece, the damaged tool).
- failure_box coordinates are fractions of the CURRENT CAMERA FRAME from 0.0 to 1.0, where
  x,y is the top-left corner of the box and width,height is its size. (0,0) is the top-left
  corner of the image and (1,1) is the bottom-right corner.
- If failure_type is "none" or no single region explains the finding, set x, y, width, and
  height all to 0.
Output rules:
- Respond with ONLY the JSON object below as raw text — no markdown code fences, no
  <think> or reasoning text, and no words before or after the JSON object.
- Keep reason, evidence, probable_cause, next_step, and machine_status_reason each to 12
  words or fewer.
Return JSON only:
{
"scene_state": "idle_empty_build_plate | object_on_build_plate | printing_normally | printing_suspicious | printing_failure | failed_material_on_plate | camera_unusable | unknown",
"material_pattern": "empty | intentional_solid_geometry | chaotic_loose_filament | plastic_blob | unclear",
"attachment_state": "not_applicable | attached_flat | edge_lifted | partially_detached | fully_detached | tipped_or_displaced | unclear",
"loose_filament_extent": "none | isolated_strand | multiple_loops | tangled_mass | unclear",
"build_plate_visible": true,
"printed_part_visible": false,
"failed_material_visible": false,
"temporal_change_detected": false,
"machine_status": "printing | needs_attention | idle",
"status_confidence": 0.0,
"machine_status_reason": "short visible reason",
"detected_colors": [
{
"name": "Blue",
"hex": "#1E6BFF",
"confidence": 0.0,
"coverage": 0.0
}
],
"status": "normal | warning | failure | unclear",
"failure_type": "allowed failure type",
"failure_box": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
"confidence": 0.0,
"severity": 0,
"should_notify_user": false,
"recommended_action": "continue | inspect_machine | strongly_consider_pause | stop_and_inspect",
"reason": "short conclusion",
"evidence": "short visible evidence",
"probable_cause": "short cautious cause",
"next_step": "short action"
}
`;
const buildContent = (items) => {
const content = [{ type: "text", text: buildPrompt(items.length > 1 ? reference.type : "none") }];
for (const item of items) {
content.push({ type: "text", text: item.label });
content.push({
type: "image_url",
image_url: { url: item.image },
});
}
return content;
};
// The current frame is always the last entry; dropping everything before it
// leaves a valid single-image request.
const currentOnly = images.slice(-1);
const attemptImages = referenceImagesDisabled ? currentOnly : images;
console.log(
`Analyzing with ${model}; images=${attemptImages.length}; machine=${machineType}`,
);
const startedAt = Date.now();
let rawResult;
let attempts;
try {
({ rawResult, attempts } = await requestAnalysis(buildContent(attemptImages)));
} catch (error) {
// Two 320px frames cost roughly 8.3k tokens, which does not fit the free
// tier's 8000 tokens/minute. Rather than fail every frame from here on,
// drop the reference image and keep monitoring with the current frame
// alone — worse temporal comparison, but the machine stays watched.
if (!isTokenBudgetError(error) || attemptImages.length < 2) throw error;
const wasDisabled = referenceImagesDisabled;
referenceImagesDisabled = true;
console.warn(
"Groq rejected the two-image request as too large for the token limit; " +
"continuing with the current frame only.",
);
if (!wasDisabled) {
notifyInfo({
title: "ℹ️ Watch Guard switched to single-frame analysis",
message:
"Two camera frames exceed this Groq tier's tokens-per-minute limit, so the reference " +
"frame is no longer sent. Monitoring continues; frame-to-frame change detection is off. " +
"Lower the camera resolution or upgrade the Groq tier to restore it.",
});
}
({ rawResult, attempts } = await requestAnalysis(buildContent(currentOnly)));
}
const latencyMs = Date.now() - startedAt;
const providerLabel = provider === "openrouter" ? "OpenRouter" : "Groq";
console.log(`${providerLabel} responded in ${latencyMs}ms (attempts=${attempts}).`);
const normalized = normalizeResult(rawResult, { machineType });
if (!machine) {
  try {
    machine = registerMachine(getDatabase(), {
      cameraId: null,
      label: cameraLabel,
      machineType,
    });
  } catch (error) {
    console.error("Could not create an unlinked machine identity for this analysis:", error);
  }
}
let previousTrend = null;
let analysisPersisted = false;
try {
  if (!machine) throw new Error("Machine identity is unavailable.");
  const database = getDatabase();
  const config = getTrendConfig();
  previousTrend = analyzeTrend(getValidTrendRecords(database, machine.id), config);
  persistValidAnalysis(database, {
    machineId: machine.id,
    machineType,
    result: normalized,
    jobId: activeJob?.id || null,
  });
  analysisPersisted = true;
} catch (error) {
  console.error("Could not persist valid analysis; continuing with notifications and response:", error);
}
if (analysisPersisted && machine) {
  try {
    const database = getDatabase();
    const { config, records, trend } = analyzeMachineHistory(database, machine.id);
    const candidates = evaluateEarlyWarnings(records, trend, config);
    const persistedWarnings = candidates.map((candidate) =>
      upsertEarlyWarning(database, machine.id, candidate),
    );
    const publicTrend = publicTrendResult(trend);
    const trendChanged =
      previousTrend &&
      (previousTrend.trend_classification !== trend.trend_classification ||
        previousTrend.risk_classification !== trend.risk_classification ||
        (previousTrend.valid_observations < config.minimumObservations &&
          trend.valid_observations >= config.minimumObservations));
    if (trendChanged) {
      broadcast({
        type: "trend_update",
        machineId: machine.id,
        machineLabel: cameraLabel,
        trend: publicTrend,
      });
    }
    for (const persistedWarning of persistedWarnings) {
      if (persistedWarning.created) {
        broadcast({
          type: "early_warning",
          machineId: machine.id,
          machineLabel: cameraLabel,
          warning: warningResponse(persistedWarning.warning),
        });
      }
    }
  } catch (error) {
    console.error("Could not update machine trend/warning intelligence:", error);
  }
  try {
    const fused = fuseMachineContext(getDatabase(), machine.id);
    if (fused) {
      broadcast({
        type: "sensor_fusion_update",
        machineId: machine.id,
        fusion: fused.fusion,
      });
      for (const incidentResult of fused.incidentResults) {
        if (incidentResult.created) {
          broadcast({
            type: "sensor_incident_created",
            machineId: machine.id,
            incident: incidentResult.incident,
          });
        } else if (incidentResult.severityChanged) {
          broadcast({
            type: "sensor_incident_updated",
            machineId: machine.id,
            incident: incidentResult.incident,
          });
        }
      }
    }
  } catch (error) {
    console.error("Could not fuse camera analysis with sensor intelligence:", error);
  }
  if (activeJob) {
    try {
      const database = getDatabase();
      const currentJob = getJob(database, activeJob.id);
      if (currentJob && ["RUNNING", "PAUSED"].includes(currentJob.status)) {
        const candidates = detectJobDeviations(
          currentJob,
          getJobAnalysisHistoryForInsights(database, currentJob.id),
        );
        for (const deviation of persistJobDeviations(database, currentJob.id, candidates)) {
          if (deviation.created || deviation.severityChanged) {
            broadcast({
              type: "job_deviation",
              machineId: currentJob.machine_id,
              jobId: currentJob.id,
              deviation,
            });
          }
        }
      }
    } catch (error) {
      console.error("Could not update job deviation intelligence:", error);
    }
  }
}
const confirmation = updateConfirmation(cameraId, normalized);
const payload = {
...normalized,
...confirmation,
latency_ms: latencyMs,
camera_id: cameraId,
machine_id: machine?.id || null,
job_id: activeJob?.id || null,
};
const livePayload = {
...normalized,
...confirmation,
latency_ms: latencyMs,
camera_id: cameraId,
job_id: activeJob?.id || null,
};
response.json(payload);
broadcast({ type: "status_update", cameraId, cameraLabel, result: livePayload });
if (confirmation.newly_confirmed) {
console.log(`Confirmed failure on "${cameraLabel}": ${normalized.failure_type}`);
notifyFailure({
cameraId,
cameraLabel,
result: payload,
snapshotDataUrl: currentImageDataUrl,
});
pausePrinter().then((outcome) => {
console.log(`Printer pause attempt for "${cameraLabel}":`, outcome);
broadcast({ type: "printer_pause_result", cameraId, cameraLabel, outcome });
// A pause that was attempted and failed means the machine is still
// running on a confirmed failure — worth its own alert.
if (!outcome.ok && !outcome.skipped) {
notifyError({
scope: "printer pause",
message: `Could not pause "${cameraLabel}" after a confirmed failure. Stop the machine by hand.`,
details: String(outcome.error || `driver responded ${outcome.status}`),
cameraLabel,
key: `pause:${cameraId}`,
});
}
});
broadcast({ type: "failure_confirmed", cameraId, cameraLabel, result: livePayload });
markAlerted(cameraId, normalized);
} else if (confirmation.newly_recovered) {
console.log(`"${cameraLabel}" recovered: ${normalized.machine_status}`);
cameraAlertState.delete(cameraId);
notifyRecovery({ cameraId, cameraLabel, result: payload });
} else if (
normalized.machine_status === "needs_attention" &&
alertLevel() !== "confirmed" &&
shouldAlertProblem(cameraId, normalized)
) {
// Anything visibly wrong is reported immediately. The confirmation streak
// still gates the louder alert and the auto-pause, but it no longer decides
// whether you hear about the problem at all — a fault that flickers never
// reaches three in a row and used to go completely unreported.
console.log(
`Warning on "${cameraLabel}": ${normalized.failure_type} ` +
`(${confirmation.confirmation_streak}/${confirmation.confirmation_target})`,
);
notifyWarning({
cameraId,
cameraLabel,
result: payload,
snapshotDataUrl: currentImageDataUrl,
});
} else if (normalized.machine_status !== "needs_attention") {
cameraAlertState.delete(cameraId);
if (alertLevel() === "all") {
notifyRoutine({ cameraId, cameraLabel, result: payload });
}
}
} catch (error) {
const failedCameraLabel = clean(request.body?.cameraLabel, 100) || "unknown camera";
const providerLabel = provider === "openrouter" ? "OpenRouter" : "Groq";
if (error?.invalidJson) {
recordInvalidAttempt({
  reason: `${providerLabel} returned malformed or unparseable analysis JSON.`,
  errorCategory: "malformed_response",
});
notifyError({
scope: "analysis",
message: `${providerLabel} returned unparseable JSON for "${failedCameraLabel}". Monitoring is not producing results.`,
details: (error.rawText || "").slice(0, 400),
cameraLabel: failedCameraLabel,
key: "analyze:invalid_json",
});
return response.status(502).json({
error: `${providerLabel} returned text that was not valid JSON.`,
code: "invalid_json",
details: (error.rawText || "").slice(0, 500),
});
}
const failure = classifyProviderError(error, {
  provider: providerLabel,
  model,
  secrets: [groqApiKey, openrouterApiKey],
});
recordInvalidAttempt({
  reason: failure.providerMessage,
  errorCategory: failure.code,
});
console.error("[ai-request] Provider call failed.", {
  provider: providerLabel,
  model,
  status: failure.status,
  code: failure.code,
  message: failure.providerMessage,
});
notifyError({
scope: "analysis",
message: `${failure.message} Monitoring on "${failedCameraLabel}" is not producing results.`,
details: failure.providerMessage,
cameraLabel: failedCameraLabel,
key: `analyze:${failure.code}:${failure.status || "unknown"}`,
});
response.status(failure.status || 500).json({
error: failure.message,
code: failure.code,
provider_status: failure.status,
provider,
model,
details: failure.providerMessage,
});
}
} catch (error) {
  console.error("Unexpected analysis pipeline error:", error);
  response.status(500).json({
    error: "The analysis could not be completed.",
    code: "analysis_internal_error",
  });
}
});
function registerProcessHandlers() {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    console.error("UNHANDLED REJECTION:", reason);
    notifyError({
      scope: "server",
      message: "An unhandled promise rejection occurred. Monitoring may be degraded.",
      details: String(reason?.stack || reason?.message || reason),
      key: "server:unhandled_rejection",
    });
  });

  process.on("uncaughtException", async (error) => {
    console.error("UNCAUGHT EXCEPTION:", error);
    notifyError({
      scope: "server",
      message: "Watch Guard crashed. Monitoring has stopped and the machine is unwatched.",
      details: String(error?.stack || error?.message || error),
      key: "server:uncaught_exception",
      fatal: true,
    });
    await flushNotifications();
    process.exit(1);
  });
}

export async function startServer({ listenPort = port } = {}) {
  const database = initializeDatabase();
  simulationService.restoreRunningSessions();
  registerProcessHandlers();

  const server = app.listen(listenPort);
  if (sensorHealthTimer) clearInterval(sensorHealthTimer);
  const healthConfig = getSensorFusionConfig();
  const healthPollMs = Math.max(5_000, Math.min(60_000, Number(process.env.SENSOR_HEALTH_POLL_MS) || 15_000));
  const healthTimer = setInterval(() => {
    try {
      const sensors = listSensors(database, {
        staleAfterMs: healthConfig.staleAfterMs,
        disconnectedAfterMs: healthConfig.disconnectedAfterMs,
      });
      for (const sensor of sensors) {
        if (!sensor.health_changed) continue;
        broadcast({
          type: "sensor_health_update",
          machineId: sensor.machine_id,
          sensor: {
            id: sensor.id,
            health_status: sensor.health_status,
            last_seen_at: sensor.last_seen_at,
          },
        });
      }
    } catch (error) {
      console.error("Could not refresh sensor health status:", error);
    }
  }, healthPollMs);
  healthTimer.unref();
  sensorHealthTimer = healthTimer;
  server.once("close", () => {
    clearInterval(healthTimer);
    simulationService.stopTimers();
    if (sensorHealthTimer === healthTimer) {
      sensorHealthTimer = null;
    }
  });
  server.on("listening", () => {
    const notifications = describeNotifications();
    console.log(`Watch Guard is running at http://localhost:${listenPort}`);
    const hasActiveKey = provider === "openrouter" ? Boolean(openrouterApiKey) : Boolean(groq);
    console.log(`Provider: ${provider === "openrouter" ? "OpenRouter" : "Groq"} | Model: ${model}`);
    console.log(
      hasActiveKey
        ? `${provider === "openrouter" ? "OpenRouter" : "Groq"} API key loaded.`
        : "No API key yet — open the app to configure or add OPENROUTER_API_KEY in .env.",
    );
    if (notifications.configured) {
      console.log("Discord alerts enabled (confirmed failures, recoveries, and errors).");
      if (/^(1|true|yes|on)$/i.test(String(process.env.DISCORD_NOTIFY_STARTUP || "").trim())) {
        notifyInfo({
          title: "🟢 Watch Guard online",
          message: `Monitoring backend started on port ${listenPort} using ${model}.`,
        });
      }
    } else if (notifications.invalidUrl) {
      console.warn("DISCORD_WEBHOOK_URL is set but is not a valid Discord webhook URL — alerts are disabled.");
    } else {
      console.log("Discord alerts disabled — set DISCORD_WEBHOOK_URL in .env to enable them.");
    }
  });
  server.on("error", async (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(
        `\nPort ${listenPort} is already in use — Watch Guard is probably already running.\n` +
          `Open http://localhost:${listenPort} in your browser, or close the other terminal\n` +
          `window first. To run a second copy on another port: PORT=${listenPort + 1} npm start\n`,
      );
      process.exit(1);
    }
    console.error("Watch Guard could not start:", error);
    await notifyError({
      scope: "startup",
      message: `Watch Guard could not start on port ${listenPort}, so nothing is being monitored.`,
      details: String(error?.stack || error?.message || error),
      key: "server:listen_error",
      fatal: true,
    });
    await flushNotifications();
    process.exit(1);
  });

  wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", message: "Connected to Watch Guard live updates." }));
  });
  return server;
}

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await startServer();
}
