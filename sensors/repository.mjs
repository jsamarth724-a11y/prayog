import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createSensorCredential } from "./adapters.mjs";

const HEALTH_STATES = new Set(["UNKNOWN", "ONLINE", "STALE", "DISCONNECTED", "FAULT"]);
const INCIDENT_SEVERITY_RANK = Object.freeze({ LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 });

function hashCredential(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[\da-f]{64}$/i.test(left) || !/^[\da-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error("Could not parse persisted sensor JSON:", error);
    return fallback;
  }
}

function sensorFromRow(row) {
  if (!row) return null;
  const { token_hash: _tokenHash, ...sensor } = row;
  const latest = row.latest_reading_id
    ? {
        id: row.latest_reading_id,
        observed_at: row.latest_observed_at,
        received_at: row.latest_received_at,
        value: row.latest_value,
        unit: row.latest_unit,
        event_type: row.latest_event_type,
        alarm_detected: row.latest_alarm_detected === null ? null : Boolean(row.latest_alarm_detected),
        provenance: row.latest_provenance,
      }
    : null;
  return {
    ...sensor,
    enabled: Boolean(row.enabled),
    latest_reading: latest,
    calibration_status: row.calibration_due_at
      ? Date.parse(row.calibration_due_at) < Date.now() ? "DUE" : "CURRENT"
      : "UNKNOWN",
  };
}

export function createSensor(database, machineId, registration) {
  const id = randomUUID();
  const token = createSensorCredential();
  const tokenHash = hashCredential(token);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO sensors (
      id, machine_id, name, sensor_type, adapter_type, provenance, unit,
      token_hash, enabled, health_status, calibration_due_at, registered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'UNKNOWN', ?, ?, ?)
  `).run(
    id,
    machineId,
    registration.name,
    registration.type,
    registration.adapterType,
    registration.provenance,
    registration.unit,
    tokenHash,
    registration.calibrationDueAt,
    now,
    now,
  );
  return { sensor: getSensor(database, id), token };
}

export function getSensorRow(database, sensorId) {
  return database.prepare("SELECT * FROM sensors WHERE id = ?").get(sensorId) || null;
}

export function getSensor(database, sensorId) {
  const row = database.prepare(`
    SELECT sensors.*,
      latest.id AS latest_reading_id, latest.observed_at AS latest_observed_at,
      latest.received_at AS latest_received_at, latest.value AS latest_value,
      latest.unit AS latest_unit, latest.event_type AS latest_event_type,
      latest.alarm_detected AS latest_alarm_detected,
      latest.provenance AS latest_provenance
    FROM sensors
    LEFT JOIN sensor_readings AS latest
      ON latest.id = (
        SELECT readings.id FROM sensor_readings AS readings
        WHERE readings.sensor_id = sensors.id
        ORDER BY readings.observed_at DESC, readings.id DESC LIMIT 1
      )
    WHERE sensors.id = ?
  `).get(sensorId);
  return sensorFromRow(row);
}

export function authenticateSensor(database, sensorId, token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const sensor = getSensorRow(database, sensorId);
  if (!sensor || !sensor.enabled || !safeEqualHex(sensor.token_hash, hashCredential(token))) return null;
  return sensor;
}

export function authenticateSensorAdmin(configuredToken, suppliedToken) {
  if (typeof configuredToken !== "string" || configuredToken.length < 24 ||
      typeof suppliedToken !== "string" || suppliedToken.length < 24) return false;
  const configuredHash = hashCredential(configuredToken);
  const suppliedHash = hashCredential(suppliedToken);
  return safeEqualHex(configuredHash, suppliedHash);
}

function writeHealthTransition(database, sensor, nextStatus, reason, timestamp) {
  if (!HEALTH_STATES.has(nextStatus) || sensor.health_status === nextStatus) return false;
  database.transaction(() => {
    database.prepare(`
      INSERT INTO sensor_health_events (
        id, sensor_id, machine_id, from_status, to_status, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), sensor.id, sensor.machine_id, sensor.health_status, nextStatus, reason, timestamp);
    database.prepare("UPDATE sensors SET health_status = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, timestamp, sensor.id);
  })();
  sensor.health_status = nextStatus;
  return true;
}

export function touchSensor(database, sensor, { timestamp, fault = false } = {}) {
  const now = timestamp || new Date().toISOString();
  database.prepare(`
    UPDATE sensors SET last_seen_at = ?, last_reading_at = COALESCE(?, last_reading_at), updated_at = ?
    WHERE id = ?
  `).run(now, timestamp || null, now, sensor.id);
  const nextStatus = fault ? "FAULT" : "ONLINE";
  const changed = writeHealthTransition(
    database,
    sensor,
    nextStatus,
    fault ? "Sensor reported a fault." : "Authenticated sensor heartbeat or reading received.",
    now,
  );
  return { changed, status: nextStatus, last_seen_at: now };
}

export function updateSensorHealth(database, sensor, {
  status = null,
  calibrationDueAt,
} = {}) {
  const now = new Date().toISOString();
  if (calibrationDueAt !== undefined) {
    database.prepare("UPDATE sensors SET calibration_due_at = ?, updated_at = ? WHERE id = ?")
      .run(calibrationDueAt, now, sensor.id);
  }
  if (status) {
    const changed = writeHealthTransition(database, sensor, status, `Authenticated sensor report: ${status}.`, now);
    if (status === "ONLINE" || status === "FAULT") {
      database.prepare("UPDATE sensors SET last_seen_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, sensor.id);
    }
    return { changed, status };
  }
  return { changed: false, status: sensor.health_status };
}

function calculatedSensorStatus(sensor, {
  staleAfterMs = 60_000,
  disconnectedAfterMs = 300_000,
  now = Date.now(),
} = {}) {
  let nextStatus = "UNKNOWN";
  if (!sensor.enabled) {
    nextStatus = "DISCONNECTED";
  } else if (sensor.last_seen_at) {
    const age = now - Date.parse(sensor.last_seen_at);
    if (sensor.health_status === "FAULT" && age <= staleAfterMs) {
      nextStatus = "FAULT";
    } else if (age >= disconnectedAfterMs) {
      nextStatus = "DISCONNECTED";
    } else if (age >= staleAfterMs) {
      nextStatus = "STALE";
    } else {
      nextStatus = sensor.health_status === "FAULT" ? "FAULT" : "ONLINE";
    }
  }
  return nextStatus;
}

export function refreshSensorHealth(database, sensor, options = {}) {
  const nextStatus = calculatedSensorStatus(sensor, options);
  const now = options.now ?? Date.now();
  const changed = writeHealthTransition(
    database,
    sensor,
    nextStatus,
    nextStatus === "STALE"
      ? "No authenticated sensor message arrived before the stale-reading deadline."
      : nextStatus === "DISCONNECTED"
        ? "No authenticated sensor message arrived before the disconnection deadline."
        : nextStatus === "UNKNOWN"
          ? "No sensor reading or heartbeat has been received."
          : "Sensor health recalculated from the last authenticated message.",
    new Date(now).toISOString(),
  );
  return { ...sensor, health_status: nextStatus, health_changed: changed };
}

function deriveSensorHealth(sensor, options = {}) {
  return {
    ...sensor,
    health_status: calculatedSensorStatus(sensor, options),
    health_changed: false,
  };
}

const SENSOR_SELECT = `
  SELECT sensors.*,
    latest.id AS latest_reading_id, latest.observed_at AS latest_observed_at,
    latest.received_at AS latest_received_at, latest.value AS latest_value,
    latest.unit AS latest_unit, latest.event_type AS latest_event_type,
    latest.alarm_detected AS latest_alarm_detected,
    latest.provenance AS latest_provenance
  FROM sensors
  LEFT JOIN sensor_readings AS latest
    ON latest.id = (
      SELECT readings.id FROM sensor_readings AS readings
      WHERE readings.sensor_id = sensors.id
      ORDER BY readings.observed_at DESC, readings.id DESC LIMIT 1
    )
`;

export function listSensors(database, {
  machineId = null,
  staleAfterMs,
  disconnectedAfterMs,
  refreshHealth = true,
} = {}) {
  const rows = database.prepare(`${SENSOR_SELECT}
    ${machineId ? "WHERE sensors.machine_id = ?" : ""}
    ORDER BY sensors.machine_id, sensors.sensor_type, sensors.name, sensors.id
  `).all(...(machineId ? [machineId] : []));
  return rows.map((row) => {
    const sensor = sensorFromRow(row);
    const options = { staleAfterMs, disconnectedAfterMs };
    return refreshHealth
      ? refreshSensorHealth(database, sensor, options)
      : deriveSensorHealth(sensor, options);
  });
}

export function listSensorReadings(database, sensorId, { limit = 100, offset = 0 } = {}) {
  return database.prepare(`
    SELECT id, sensor_id, machine_id, observed_at, received_at, value, unit,
           event_type, alarm_detected, details, provenance, source_event_id
    FROM sensor_readings WHERE sensor_id = ?
    ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(sensorId, limit, offset).map((row) => ({
    ...row,
    alarm_detected: row.alarm_detected === null ? null : Boolean(row.alarm_detected),
    details: parseJson(row.details, {}),
  }));
}

export function insertSensorReading(database, sensor, reading) {
  const id = randomUUID();
  const receivedAt = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO sensor_readings (
        id, sensor_id, machine_id, observed_at, received_at, value, unit,
        event_type, alarm_detected, details, provenance, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sensor.id,
      sensor.machine_id,
      reading.observedAt,
      receivedAt,
      reading.value,
      reading.unit,
      reading.eventType,
      reading.alarmDetected === null ? null : Number(reading.alarmDetected),
      JSON.stringify(reading.details),
      sensor.provenance,
      reading.sourceEventId,
    );
  } catch (error) {
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") return { duplicate: true, reading: null };
    throw error;
  }
  database.prepare(`
    UPDATE sensors SET last_seen_at = ?, last_reading_at = ?, updated_at = ? WHERE id = ?
  `).run(receivedAt, receivedAt, receivedAt, sensor.id);
  return {
    duplicate: false,
    reading: {
      id,
      sensor_id: sensor.id,
      machine_id: sensor.machine_id,
      observed_at: reading.observedAt,
      received_at: receivedAt,
      value: reading.value,
      unit: reading.unit,
      event_type: reading.eventType,
      alarm_detected: reading.alarmDetected,
      details: reading.details,
      provenance: sensor.provenance,
      source_event_id: reading.sourceEventId,
    },
  };
}

export function listSensorHealthEvents(database, sensorId, limit = 50) {
  return database.prepare(`
    SELECT id, sensor_id, machine_id, from_status, to_status, reason, created_at
    FROM sensor_health_events WHERE sensor_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(sensorId, limit);
}

function parseIncident(row) {
  if (!row) return null;
  return {
    ...row,
    possible_root_causes: parseJson(row.possible_root_causes, []),
    recommended_actions: parseJson(row.recommended_actions, []),
    evidence: parseJson(row.evidence, {}),
  };
}

export function getIncident(database, incidentId) {
  return parseIncident(database.prepare("SELECT * FROM sensor_incidents WHERE id = ?").get(incidentId));
}

export function listIncidents(database, { machineId = null, state = null, severity = null, limit = 100 } = {}) {
  const conditions = [];
  const values = [];
  if (machineId) {
    conditions.push("machine_id = ?");
    values.push(machineId);
  }
  if (state) {
    conditions.push("state = ?");
    values.push(state);
  }
  if (severity) {
    conditions.push("severity = ?");
    values.push(severity);
  }
  values.push(limit);
  return database.prepare(`
    SELECT * FROM sensor_incidents
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY latest_detected_at DESC, id DESC LIMIT ?
  `).all(...values).map(parseIncident);
}

export function upsertSensorIncident(database, candidate) {
  const upsert = database.transaction(() => {
    const existing = database.prepare(`
      SELECT * FROM sensor_incidents
      WHERE machine_id = ? AND category = ? AND state IN ('OPEN', 'ACKNOWLEDGED')
    `).get(candidate.machineId, candidate.category);
    const now = new Date().toISOString();
    if (existing) {
      const previousSeverity = existing.severity;
      const nextSeverity = (INCIDENT_SEVERITY_RANK[candidate.severity] || 0) >
        (INCIDENT_SEVERITY_RANK[previousSeverity] || 0) ? candidate.severity : previousSeverity;
      database.prepare(`
        UPDATE sensor_incidents
        SET severity = ?, summary = ?, explanation = ?, possible_root_causes = ?,
            recommended_actions = ?, evidence = ?, fusion_score = ?,
            latest_detected_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextSeverity,
        candidate.summary,
        candidate.explanation,
        JSON.stringify(candidate.possibleRootCauses),
        JSON.stringify(candidate.recommendedActions),
        JSON.stringify(candidate.evidence),
        candidate.fusionScore,
        candidate.timestamp,
        now,
        existing.id,
      );
      return {
        incident: getIncident(database, existing.id),
        created: false,
        severityChanged: previousSeverity !== nextSeverity,
      };
    }
    const id = randomUUID();
    database.prepare(`
      INSERT INTO sensor_incidents (
        id, machine_id, category, severity, state, summary, explanation,
        possible_root_causes, recommended_actions, evidence, fusion_score,
        first_detected_at, latest_detected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      candidate.machineId,
      candidate.category,
      candidate.severity,
      candidate.summary,
      candidate.explanation,
      JSON.stringify(candidate.possibleRootCauses),
      JSON.stringify(candidate.recommendedActions),
      JSON.stringify(candidate.evidence),
      candidate.fusionScore,
      candidate.timestamp,
      candidate.timestamp,
      now,
      now,
    );
    return { incident: getIncident(database, id), created: true, severityChanged: false };
  });
  return upsert();
}

export function recordFusionResult(database, {
  machineId,
  triggerReadingId,
  incidentId = null,
  riskLevel,
  riskScore,
  evidence,
  explanation,
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO sensor_fusion_results (
      id, machine_id, trigger_reading_id, incident_id, risk_level, risk_score,
      evidence, explanation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, machineId, triggerReadingId, incidentId, riskLevel, riskScore, JSON.stringify(evidence), explanation, createdAt);
  return {
    id,
    machine_id: machineId,
    trigger_reading_id: triggerReadingId,
    incident_id: incidentId,
    risk_level: riskLevel,
    risk_score: riskScore,
    evidence,
    explanation,
    created_at: createdAt,
  };
}

export function getLatestFusionResult(database, machineId) {
  const row = database.prepare(`
    SELECT * FROM sensor_fusion_results WHERE machine_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(machineId);
  return row ? { ...row, evidence: parseJson(row.evidence, {}) } : null;
}

export function transitionIncident(database, incidentId, transition, operatorNotes = null) {
  const apply = database.transaction(() => {
    const incident = database.prepare("SELECT * FROM sensor_incidents WHERE id = ?").get(incidentId);
    if (!incident) return { incident: null, changed: false, conflict: false };
    if (transition === "acknowledge") {
      if (incident.state !== "OPEN") {
        return { incident: parseIncident(incident), changed: false, conflict: incident.state === "RESOLVED" };
      }
    } else if (transition === "resolve") {
      if (incident.state === "RESOLVED") {
        return { incident: parseIncident(incident), changed: false, conflict: false };
      }
    } else {
      throw new Error(`Unsupported incident transition: ${transition}`);
    }
    const nextState = transition === "acknowledge" ? "ACKNOWLEDGED" : "RESOLVED";
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE sensor_incidents
      SET state = ?, acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN ? ELSE acknowledged_at END,
          resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_at END,
          operator_notes = COALESCE(?, operator_notes), updated_at = ?
      WHERE id = ?
    `).run(nextState, nextState, now, nextState, now, operatorNotes, now, incidentId);
    database.prepare(`
      INSERT INTO sensor_incident_events (
        id, incident_id, machine_id, from_state, to_state, operator_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), incidentId, incident.machine_id, incident.state, nextState, operatorNotes, now);
    return { incident: getIncident(database, incidentId), changed: true, conflict: false };
  });
  return apply();
}

export function listIncidentEvents(database, incidentId) {
  return database.prepare(`
    SELECT id, incident_id, machine_id, from_state, to_state, operator_notes, created_at
    FROM sensor_incident_events WHERE incident_id = ?
    ORDER BY created_at, id
  `).all(incidentId);
}
