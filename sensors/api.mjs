import express from "express";
import { getDatabase } from "../db/database.mjs";
import { findMachine } from "../db/repository.mjs";
import { getSensorFusionConfig, fuseMachineReading, sensorIntelligenceSnapshot } from "./fusion.mjs";
import {
  authenticateSensor,
  authenticateSensorAdmin,
  createSensor,
  getIncident,
  getSensorRow,
  insertSensorReading,
  listIncidentEvents,
  listIncidents,
  listSensorHealthEvents,
  listSensorReadings,
  listSensors,
  transitionIncident,
  touchSensor,
  updateSensorHealth,
} from "./repository.mjs";
import {
  normalizeCalibrationTimestamp,
  normalizeAdapterPayload,
  normalizeSensorReading,
  normalizeSensorRegistration,
} from "./adapters.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_INCIDENT_STATES = new Set(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
const VALID_SEVERITIES = new Set(["LOW", "MODERATE", "HIGH", "CRITICAL"]);

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function bearerToken(request) {
  const authorization = request.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] || null;
}

function apiError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function validateOperatorNotes(body) {
  if (body?.operator_notes === undefined || body.operator_notes === null || body.operator_notes === "") {
    return { value: null };
  }
  if (typeof body.operator_notes !== "string" || body.operator_notes.length > 1000) {
    return { error: "operator_notes must be a string of at most 1000 characters." };
  }
  return { value: body.operator_notes.trim() || null };
}

function requireSensorAdmin(request, response) {
  const configured = process.env.SENSOR_ADMIN_TOKEN || "";
  if (!configured) {
    apiError(response, 503, "sensor_admin_not_configured", "Sensor registration and maintenance require SENSOR_ADMIN_TOKEN to be configured.");
    return false;
  }
  if (!authenticateSensorAdmin(configured, bearerToken(request))) {
    apiError(response, 401, "sensor_admin_unauthorized", "A valid sensor administrator bearer token is required.");
    return false;
  }
  return true;
}

function validateMachineId(value) {
  if (!isUuid(value)) return "machine_id must be a UUID.";
  return null;
}

function broadcastHealthTransitions(broadcast, sensors) {
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
}

export function createSensorRouter({
  databaseProvider = getDatabase,
  broadcast = () => {},
  now = () => Date.now(),
} = {}) {
  const router = express.Router();

  router.post("/sensors", (request, response) => {
    if (!requireSensorAdmin(request, response)) return;
    const machineError = validateMachineId(request.body?.machine_id);
    if (machineError) return apiError(response, 400, "invalid_machine_id", machineError);
    const registration = normalizeSensorRegistration(request.body);
    if (registration.error) return apiError(response, 400, "invalid_sensor", registration.error);
    try {
      const database = databaseProvider();
      const machine = findMachine(database, request.body.machine_id);
      if (!machine) return apiError(response, 404, "machine_not_found", "No machine exists with that ID.");
      const created = createSensor(database, machine.id, registration.value);
      return response.status(201).json({
        sensor: created.sensor,
        credential: created.token,
        credential_notice: "This sensor credential is shown once. Store it securely in the sensor or gateway configuration.",
      });
    } catch (error) {
      console.error("Could not register sensor:", error);
      return apiError(response, 500, "sensor_registration_failed", "Sensor could not be registered.");
    }
  });

  router.get("/sensors", (request, response) => {
    const machineId = request.query.machine_id;
    if (machineId !== undefined && !isUuid(machineId)) {
      return apiError(response, 400, "invalid_machine_id", "machine_id must be a UUID.");
    }
    try {
      const database = databaseProvider();
      if (machineId && !findMachine(database, machineId)) {
        return apiError(response, 404, "machine_not_found", "No machine exists with that ID.");
      }
      const config = getSensorFusionConfig();
      const sensors = listSensors(database, {
        machineId: machineId || null,
        staleAfterMs: config.staleAfterMs,
        disconnectedAfterMs: config.disconnectedAfterMs,
      });
      broadcastHealthTransitions(broadcast, sensors);
      return response.json({
        sensors,
        adapters: ["ESP32", "USB", "SERIAL", "MQTT", "NETWORK"],
      });
    } catch (error) {
      console.error("Could not load sensors:", error);
      return apiError(response, 500, "sensors_unavailable", "Sensors could not be loaded.");
    }
  });

  router.post("/sensors/:id/readings", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_sensor_id", "Sensor ID must be a UUID.");
    try {
      const database = databaseProvider();
      const sensor = authenticateSensor(database, request.params.id, bearerToken(request));
      if (!sensor) return apiError(response, 401, "sensor_unauthorized", "Sensor credential is invalid or the sensor is disabled.");
      const adapted = normalizeAdapterPayload(sensor.adapter_type, request.body);
      if (adapted.error) return apiError(response, 400, "invalid_sensor_payload", adapted.error);
      const normalized = normalizeSensorReading(sensor, adapted.value, { now: now() });
      if (normalized.error) return apiError(response, 400, "invalid_sensor_reading", normalized.error);
      if (normalized.value.sourceEventId) {
        const duplicate = database.prepare("SELECT id FROM sensor_readings WHERE sensor_id = ? AND source_event_id = ?")
          .get(sensor.id, normalized.value.sourceEventId);
        if (duplicate) return apiError(response, 409, "duplicate_sensor_reading", "This source_event_id has already been accepted.");
      }
      const configuredInterval = Number(process.env.SENSOR_MIN_INTERVAL_MS);
      const minIntervalMs = Number.isFinite(configuredInterval)
        ? Math.min(60_000, Math.max(1000, configuredInterval))
        : 10_000;
      if (sensor.last_reading_at && now() - Date.parse(sensor.last_reading_at) < minIntervalMs) {
        return apiError(response, 429, "sensor_rate_limited", `Sensor readings must be at least ${minIntervalMs} ms apart.`);
      }
      const inserted = insertSensorReading(database, sensor, normalized.value);
      if (inserted.duplicate) return apiError(response, 409, "duplicate_sensor_reading", "This source_event_id has already been accepted.");
      const health = touchSensor(database, sensor, {});
      const fusion = fuseMachineReading(database, sensor.machine_id, inserted.reading.id);
      broadcast({
        type: "sensor_reading",
        machineId: sensor.machine_id,
        sensorId: sensor.id,
        reading: inserted.reading,
        health_status: health.status,
      });
      broadcast({
        type: "sensor_fusion_update",
        machineId: sensor.machine_id,
        fusion: fusion.fusion,
      });
      for (const incidentResult of fusion.incidentResults) {
        if (incidentResult.created) {
          broadcast({
            type: "sensor_incident_created",
            machineId: sensor.machine_id,
            incident: incidentResult.incident,
          });
        } else if (incidentResult.severityChanged) {
          broadcast({
            type: "sensor_incident_updated",
            machineId: sensor.machine_id,
            incident: incidentResult.incident,
          });
        }
      }
      if (health.changed) {
        broadcast({
          type: "sensor_health_update",
          machineId: sensor.machine_id,
          sensor: { id: sensor.id, health_status: health.status, last_seen_at: health.last_seen_at },
        });
      }
      return response.status(201).json({ reading: inserted.reading, health_status: health.status, fusion: fusion.result });
    } catch (error) {
      console.error("Could not persist sensor reading:", error);
      return apiError(response, 500, "sensor_reading_failed", "Sensor reading could not be stored.");
    }
  });

  router.post("/sensors/:id/heartbeat", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_sensor_id", "Sensor ID must be a UUID.");
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return apiError(response, 400, "invalid_sensor_heartbeat", "A JSON heartbeat object is required.");
    }
    if (Object.keys(request.body).some((key) => key !== "status")) {
      return apiError(response, 400, "invalid_sensor_heartbeat", "Heartbeat accepts only an optional status field.");
    }
    const status = String(request.body.status || "OK").toUpperCase();
    if (!["OK", "FAULT"].includes(status)) {
      return apiError(response, 400, "invalid_sensor_heartbeat", "Heartbeat status must be OK or FAULT.");
    }
    try {
      const database = databaseProvider();
      const sensor = authenticateSensor(database, request.params.id, bearerToken(request));
      if (!sensor) return apiError(response, 401, "sensor_unauthorized", "Sensor credential is invalid or the sensor is disabled.");
      const health = touchSensor(database, sensor, { fault: status === "FAULT" });
      if (health.changed) {
        broadcast({
          type: "sensor_health_update",
          machineId: sensor.machine_id,
          sensor: { id: sensor.id, health_status: health.status, last_seen_at: health.last_seen_at },
        });
      }
      return response.json({ sensor_id: sensor.id, health_status: health.status, last_seen_at: health.last_seen_at });
    } catch (error) {
      console.error("Could not record sensor heartbeat:", error);
      return apiError(response, 500, "sensor_heartbeat_failed", "Sensor heartbeat could not be recorded.");
    }
  });

  router.get("/sensors/:id/readings", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_sensor_id", "Sensor ID must be a UUID.");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
      return apiError(response, 400, "invalid_pagination", "limit must be positive and offset non-negative.");
    }
    try {
      const database = databaseProvider();
      const sensor = getSensorRow(database, request.params.id);
      if (!sensor) return apiError(response, 404, "sensor_not_found", "No sensor exists with that ID.");
      return response.json({
        sensor_id: sensor.id,
        readings: listSensorReadings(database, sensor.id, { limit: Math.min(limit, 500), offset }),
      });
    } catch (error) {
      console.error("Could not load sensor readings:", error);
      return apiError(response, 500, "sensor_history_unavailable", "Sensor history could not be loaded.");
    }
  });

  router.post("/sensors/:id/calibration", (request, response) => {
    if (!requireSensorAdmin(request, response)) return;
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_sensor_id", "Sensor ID must be a UUID.");
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => key !== "calibration_due_at")) {
      return apiError(response, 400, "invalid_calibration_date", "A JSON object with only calibration_due_at is required.");
    }
    const due = request.body?.calibration_due_at;
    let calibrationDueAt = null;
    if (due !== undefined && due !== null && due !== "") {
      calibrationDueAt = normalizeCalibrationTimestamp(due);
      if (!calibrationDueAt) return apiError(response, 400, "invalid_calibration_date", "calibration_due_at must be a valid ISO timestamp within one year or null.");
    }
    try {
      const database = databaseProvider();
      const sensor = getSensorRow(database, request.params.id);
      if (!sensor) return apiError(response, 404, "sensor_not_found", "No sensor exists with that ID.");
      updateSensorHealth(database, sensor, { calibrationDueAt });
      const updated = getSensorRow(database, sensor.id);
      const calibrationStatus = updated.calibration_due_at
        ? Date.parse(updated.calibration_due_at) < now() ? "DUE" : "CURRENT"
        : "UNKNOWN";
      broadcast({
        type: "sensor_calibration_updated",
        machineId: sensor.machine_id,
        sensor: { id: sensor.id, calibration_due_at: updated.calibration_due_at, calibration_status: calibrationStatus },
      });
      return response.json({ sensor_id: sensor.id, calibration_due_at: updated.calibration_due_at, calibration_status: calibrationStatus });
    } catch (error) {
      console.error("Could not update sensor calibration:", error);
      return apiError(response, 500, "sensor_calibration_failed", "Sensor calibration metadata could not be updated.");
    }
  });

  router.get("/sensor-intelligence", (request, response) => {
    const machineId = request.query.machine_id;
    const machineError = validateMachineId(machineId);
    if (machineError) return apiError(response, 400, "invalid_machine_id", machineError);
    try {
      const database = databaseProvider();
      if (!findMachine(database, machineId)) return apiError(response, 404, "machine_not_found", "No machine exists with that ID.");
      const config = getSensorFusionConfig();
      const snapshot = sensorIntelligenceSnapshot(database, machineId, config);
      snapshot.sensors = listSensors(database, {
        machineId,
        staleAfterMs: config.staleAfterMs,
        disconnectedAfterMs: config.disconnectedAfterMs,
      });
      broadcastHealthTransitions(broadcast, snapshot.sensors);
      snapshot.sensors = snapshot.sensors.map((sensor) => ({
        ...sensor,
        recent_readings: listSensorReadings(database, sensor.id, { limit: 100 }),
        health_events: listSensorHealthEvents(database, sensor.id, 25),
      }));
      snapshot.incidents = listIncidents(database, { machineId, limit: 100 });
      snapshot.incidents = snapshot.incidents.map((incident) => ({
        ...incident,
        lifecycle_events: listIncidentEvents(database, incident.id),
      }));
      return response.json(snapshot);
    } catch (error) {
      console.error("Could not load sensor intelligence:", error);
      return apiError(response, 500, "sensor_intelligence_unavailable", "Sensor intelligence could not be loaded.");
    }
  });

  router.get("/incidents", (request, response) => {
    const { machine_id: machineId, state, severity } = request.query;
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (machineId !== undefined && !isUuid(machineId)) return apiError(response, 400, "invalid_machine_id", "machine_id must be a UUID.");
    if (state !== undefined && !VALID_INCIDENT_STATES.has(state)) return apiError(response, 400, "invalid_incident_state", "Incident state is not recognized.");
    if (severity !== undefined && !VALID_SEVERITIES.has(severity)) return apiError(response, 400, "invalid_incident_severity", "Incident severity is not recognized.");
    if (!Number.isInteger(limit) || limit < 1) return apiError(response, 400, "invalid_pagination", "limit must be a positive integer.");
    try {
      const database = databaseProvider();
      if (machineId && !findMachine(database, machineId)) return apiError(response, 404, "machine_not_found", "No machine exists with that ID.");
      return response.json({
        incidents: listIncidents(database, { machineId: machineId || null, state: state || null, severity: severity || null, limit: Math.min(limit, 200) }),
      });
    } catch (error) {
      console.error("Could not load sensor incidents:", error);
      return apiError(response, 500, "incidents_unavailable", "Sensor incidents could not be loaded.");
    }
  });

  router.get("/incidents/:id", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_incident_id", "Incident ID must be a UUID.");
    try {
      const database = databaseProvider();
      const incident = getIncident(database, request.params.id);
      if (!incident) return apiError(response, 404, "incident_not_found", "No incident exists with that ID.");
      return response.json({ incident, lifecycle_events: listIncidentEvents(database, incident.id) });
    } catch (error) {
      console.error("Could not load sensor incident:", error);
      return apiError(response, 500, "incident_unavailable", "Sensor incident could not be loaded.");
    }
  });

  const transitionIncidentHandler = (transition) => (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_incident_id", "Incident ID must be a UUID.");
    const notes = validateOperatorNotes(request.body);
    if (notes.error) return apiError(response, 400, "invalid_operator_notes", notes.error);
    try {
      const database = databaseProvider();
      const result = transitionIncident(database, request.params.id, transition, notes.value);
      if (!result.incident) return apiError(response, 404, "incident_not_found", "No incident exists with that ID.");
      if (result.conflict) return apiError(response, 409, "invalid_incident_transition", `A ${result.incident.state} incident cannot be ${transition}d.`);
      if (result.changed) {
        broadcast({
          type: transition === "acknowledge" ? "sensor_incident_acknowledged" : "sensor_incident_resolved",
          machineId: result.incident.machine_id,
          incident: result.incident,
        });
      }
      return response.json({ incident: result.incident, changed: result.changed });
    } catch (error) {
      console.error(`Could not ${transition} sensor incident:`, error);
      return apiError(response, 500, `incident_${transition}_failed`, `Sensor incident could not be ${transition}d.`);
    }
  };
  router.post("/incidents/:id/acknowledge", transitionIncidentHandler("acknowledge"));
  router.post("/incidents/:id/resolve", transitionIncidentHandler("resolve"));

  return router;
}
