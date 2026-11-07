import { randomUUID } from "node:crypto";
import express from "express";
import { createSensor, getSensorRow, insertSensorReading, touchSensor } from "./repository.mjs";
import { fuseMachineReading } from "./fusion.mjs";
import {
  PRINTER_ONLY_SCENARIOS,
  SIMULATION_SCENARIOS,
  SIMULATION_SENSOR_TYPES,
  getSimulationSample,
} from "./scenarios.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPEEDS = new Set([0.25, 0.5, 1, 2, 4]);
const SENSOR_UNITS = Object.freeze({
  SOUND: "dBA",
  VIBRATION: "g",
  TEMPERATURE: "°C",
  SMOKE: "ppm",
});
function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function sessionFromRow(row) {
  if (!row) return null;
  return { ...row, scenario_label: SIMULATION_SCENARIOS[row.scenario]?.label || row.scenario };
}

function readSessionReadings(database, sessionId, limit = 600) {
  const readings = database.prepare(`
    SELECT readings.id, readings.sensor_id, readings.machine_id, readings.observed_at,
           readings.received_at, readings.value, readings.unit, readings.event_type,
           readings.alarm_detected, readings.provenance, readings.details,
           sensors.sensor_type, simulation_readings.run_number,
           simulation_readings.tick_number, simulation_readings.scenario
    FROM simulation_readings
    JOIN sensor_readings AS readings ON readings.id = simulation_readings.sensor_reading_id
    JOIN sensors ON sensors.id = readings.sensor_id
    WHERE simulation_readings.session_id = ?
    ORDER BY readings.observed_at DESC, simulation_readings.tick_number DESC
    LIMIT ?
  `).all(sessionId, limit).reverse();
  return readings.map((reading) => ({
    ...reading,
    alarm_detected: reading.alarm_detected === null ? null : Boolean(reading.alarm_detected),
    details: JSON.parse(reading.details),
    provenance: "SIMULATED",
  }));
}

function readSession(database, sessionId, limit = 600) {
  const session = sessionFromRow(database.prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId));
  if (!session) return null;
  session.readings = readSessionReadings(database, sessionId, limit);
  return session;
}

function activeForMachine(database, machineId) {
  return sessionFromRow(database.prepare(`
    SELECT * FROM simulation_sessions
    WHERE machine_id = ? AND status IN ('RUNNING', 'PAUSED')
    ORDER BY created_at DESC LIMIT 1
  `).get(machineId));
}

function listSessions(database, machineId = null, limit = 20) {
  const rows = machineId
    ? database.prepare("SELECT * FROM simulation_sessions WHERE machine_id = ? ORDER BY created_at DESC LIMIT ?").all(machineId, limit)
    : database.prepare("SELECT * FROM simulation_sessions ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((row) => {
    const session = sessionFromRow(row);
    session.readings = readSessionReadings(database, row.id, 600);
    return session;
  });
}

function simulationIntervalMs(speed) {
  const configured = Number(process.env.SIMULATION_INTERVAL_MS);
  const base = Number.isFinite(configured) ? Math.min(60_000, Math.max(1000, configured)) : 5_000;
  return Math.max(1000, Math.round(base / speed));
}

function apiError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function validateStartBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "A JSON object is required.";
  if (Object.keys(body).some((key) => !["machine_id", "scenario", "speed"].includes(key))) {
    return "Only machine_id, scenario, and speed are accepted.";
  }
  if (!isUuid(body.machine_id)) return "machine_id must be a UUID.";
  if (typeof body.scenario !== "string" || !Object.hasOwn(SIMULATION_SCENARIOS, body.scenario)) {
    return `scenario must be one of ${Object.keys(SIMULATION_SCENARIOS).join(", ")}.`;
  }
  if (body.speed !== undefined && !SPEEDS.has(body.speed)) {
    return "speed must be one of 0.25, 0.5, 1, 2, or 4.";
  }
  return null;
}

export function createSimulationService({
  databaseProvider,
  broadcast = () => {},
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (typeof databaseProvider !== "function") throw new TypeError("databaseProvider is required.");
  const timers = new Map();
  const ticking = new Set();

  function broadcastState(type, session) {
    broadcast({ type, machineId: session.machine_id, session });
  }

  function clearSessionTimer(sessionId) {
    const timer = timers.get(sessionId);
    if (timer) clearTimer(timer);
    timers.delete(sessionId);
  }

  function pauseAfterFailure(sessionId, error) {
    console.error(`Simulation tick failed for ${sessionId}:`, error);
    clearSessionTimer(sessionId);
    const database = databaseProvider();
    const current = database.prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId);
    if (current?.status !== "RUNNING") return;
    const timestamp = new Date(now()).toISOString();
    database.prepare("UPDATE simulation_sessions SET status = 'PAUSED', paused_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, sessionId);
    broadcastState("simulation_paused", readSession(database, sessionId, 600));
  }

  function ensureSensors(database, session) {
    const sensors = new Map();
    const existing = database.prepare(`
      SELECT sensor_type, sensor_id FROM simulation_session_sensors WHERE session_id = ?
    `).all(session.id);
    for (const row of existing) sensors.set(row.sensor_type, row.sensor_id);
    for (const type of SIMULATION_SENSOR_TYPES) {
      if (sensors.has(type)) continue;
      const created = createSensor(database, session.machine_id, {
        name: `Virtual ${type.toLowerCase()} · ${session.id.slice(0, 8)}`,
        type,
        adapterType: "NETWORK",
        provenance: "SIMULATED",
        unit: SENSOR_UNITS[type],
        calibrationDueAt: null,
      });
      database.prepare(`
        INSERT INTO simulation_session_sensors (session_id, sensor_type, sensor_id)
        VALUES (?, ?, ?)
      `).run(session.id, type, created.sensor.id);
      sensors.set(type, created.sensor.id);
    }
    return sensors;
  }

  function tick(sessionId) {
    if (ticking.has(sessionId)) return null;
    ticking.add(sessionId);
    try {
      const database = databaseProvider();
      const started = database.transaction(() => {
        const row = database.prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId);
        if (!row || row.status !== "RUNNING") return null;
        if (row.tick_count >= 10_000) {
          const stoppedAt = new Date(now()).toISOString();
          database.prepare("UPDATE simulation_sessions SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?")
            .run(stoppedAt, stoppedAt, sessionId);
          return { maxTicks: true, session: sessionFromRow({ ...row, status: "STOPPED", stopped_at: stoppedAt, updated_at: stoppedAt }) };
        }
        const nextTick = row.tick_count + 1;
        const lastObserved = database.prepare(`
          SELECT MAX(readings.observed_at) AS observed_at
          FROM simulation_readings
          JOIN sensor_readings AS readings ON readings.id = simulation_readings.sensor_reading_id
          WHERE simulation_readings.session_id = ?
        `).get(sessionId)?.observed_at;
        const timestamp = new Date(Math.max(now(), Number.isFinite(Date.parse(lastObserved || "")) ? Date.parse(lastObserved) + 1 : 0)).toISOString();
        const sensorIds = ensureSensors(database, row);
        const sample = getSimulationSample(row.scenario, nextTick);
        const insertedReadings = [];
        for (const type of SIMULATION_SENSOR_TYPES) {
          const sensor = getSensorRow(database, sensorIds.get(type));
          const result = sample[type];
          const inserted = insertSensorReading(database, sensor, {
            observedAt: timestamp,
            value: result.value,
            unit: result.unit,
            eventType: result.eventType,
            alarmDetected: result.alarmDetected,
            sourceEventId: `${sessionId}:${row.run_number}:${nextTick}:${type}`,
            details: { quality: "DETERMINISTIC_SIMULATION", sample_count: 1 },
          });
          if (inserted.duplicate || !inserted.reading) {
            throw new Error(`Simulation failed to persist ${type} reading for tick ${nextTick}.`);
          }
          touchSensor(database, sensor, { timestamp });
          database.prepare(`
            INSERT INTO simulation_readings (
              id, session_id, sensor_reading_id, run_number, tick_number, scenario, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(randomUUID(), sessionId, inserted.reading.id, row.run_number, nextTick, row.scenario, timestamp);
          insertedReadings.push({ ...inserted.reading, sensor_type: type, run_number: row.run_number, tick_number: nextTick });
        }
        database.prepare("UPDATE simulation_sessions SET tick_count = ?, updated_at = ? WHERE id = ?")
          .run(nextTick, timestamp, sessionId);
        const session = sessionFromRow({
          ...row,
          tick_count: nextTick,
          updated_at: timestamp,
        });
        return { session, readings: insertedReadings, triggerReadingId: insertedReadings.at(-1).id };
      })();
      if (!started) return null;
      if (started.maxTicks) {
        clearSessionTimer(sessionId);
        broadcastState("simulation_stopped", started.session);
        return { session: started.session, readings: [], fusion: null };
      }
      const fusion = fuseMachineReading(database, started.session.machine_id, started.triggerReadingId);
      for (const reading of started.readings) {
        broadcast({
          type: "sensor_reading",
          machineId: started.session.machine_id,
          sensorId: reading.sensor_id,
          reading: { ...reading, provenance: "SIMULATED" },
          health_status: "ONLINE",
        });
      }
      broadcast({
        type: "sensor_fusion_update",
        machineId: started.session.machine_id,
        fusion: fusion.result,
      });
      for (const incidentResult of fusion.incidentResults) {
        broadcast({
          type: incidentResult.created ? "sensor_incident_created" : "sensor_incident_updated",
          machineId: started.session.machine_id,
          incident: incidentResult.incident,
        });
      }
      const session = readSession(database, sessionId, 600);
      broadcast({
        type: "simulation_update",
        machineId: session.machine_id,
        session,
        readings: started.readings.map((reading) => ({ ...reading, provenance: "SIMULATED" })),
        fusion: fusion.result,
      });
      return { session, readings: started.readings, fusion: fusion.result };
    } finally {
      ticking.delete(sessionId);
    }
  }

  function schedule(sessionId) {
    clearSessionTimer(sessionId);
    const database = databaseProvider();
    const session = database.prepare("SELECT status, speed FROM simulation_sessions WHERE id = ?").get(sessionId);
    if (!session || session.status !== "RUNNING") return;
    const timer = setTimer(() => {
      try {
        tick(sessionId);
      } catch (error) {
        pauseAfterFailure(sessionId, error);
      }
    }, simulationIntervalMs(session.speed));
    timer.unref?.();
    timers.set(sessionId, timer);
  }

  function start({ machineId, scenario, speed = 1, replayOfSessionId = null }) {
    if (!isUuid(machineId)) return { error: "machine_id must be a UUID.", status: 400 };
    if (!Object.hasOwn(SIMULATION_SCENARIOS, scenario)) return { error: "Unknown simulation scenario.", status: 400 };
    if (!SPEEDS.has(speed)) return { error: "Unsupported simulation speed.", status: 400 };
    const database = databaseProvider();
    const machine = database.prepare("SELECT id, machine_type FROM machines WHERE id = ?").get(machineId);
    if (!machine) {
      return { error: "No machine exists with that ID.", status: 404 };
    }
    if (PRINTER_ONLY_SCENARIOS.includes(scenario) && machine.machine_type !== "3d_printer") {
      return { error: `${scenario} is a printer-only visual demonstration scenario.`, status: 400 };
    }
    if (activeForMachine(database, machineId)) {
      return { error: "This machine already has a running or paused simulation.", status: 409 };
    }
    if (replayOfSessionId && !database.prepare("SELECT id FROM simulation_sessions WHERE id = ?").get(replayOfSessionId)) {
      return { error: "The source simulation session does not exist.", status: 404 };
    }
    const timestamp = new Date(now()).toISOString();
    const id = randomUUID();
    try {
      database.transaction(() => {
        database.prepare(`
          INSERT INTO simulation_sessions (
            id, machine_id, scenario, status, speed, run_number, tick_count,
            replay_of_session_id, started_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'RUNNING', ?, 1, 0, ?, ?, ?, ?)
        `).run(id, machineId, scenario, speed, replayOfSessionId, timestamp, timestamp, timestamp);
        ensureSensors(database, { id, machine_id: machineId });
      })();
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "This machine already has a running or paused simulation.", status: 409 };
      }
      throw error;
    }
    schedule(id);
    const session = readSession(database, id, 600);
    broadcastState(replayOfSessionId ? "simulation_replayed" : "simulation_started", session);
    try {
      tick(id);
    } catch (error) {
      pauseAfterFailure(id, error);
      throw error;
    }
    return { session: readSession(database, id, 600), status: 201 };
  }

  function transition(sessionId, action) {
    const database = databaseProvider();
    const row = database.prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId);
    if (!row) return { error: "Simulation session not found.", status: 404 };
    const timestamp = new Date(now()).toISOString();
    if (action === "pause" && row.status !== "RUNNING") {
      return { error: `A ${row.status.toLowerCase()} simulation cannot be paused.`, status: 409 };
    }
    if (action === "resume" && row.status !== "PAUSED") {
      return { error: `A ${row.status.toLowerCase()} simulation cannot be resumed.`, status: 409 };
    }
    if (action === "stop" && row.status === "STOPPED") return { session: readSession(database, sessionId), changed: false };
    const status = action === "pause" ? "PAUSED" : action === "stop" ? "STOPPED" : "RUNNING";
    database.prepare(`
      UPDATE simulation_sessions
      SET status = ?, paused_at = ?, stopped_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      action === "pause" ? timestamp : row.paused_at,
      action === "stop" ? timestamp : null,
      timestamp,
      sessionId,
    );
    if (status === "RUNNING") {
      schedule(sessionId);
      try {
        tick(sessionId);
      } catch (error) {
        pauseAfterFailure(sessionId, error);
        throw error;
      }
    } else {
      clearSessionTimer(sessionId);
    }
    const session = readSession(database, sessionId);
    broadcastState(`simulation_${action === "resume" ? "resumed" : action === "pause" ? "paused" : "stopped"}`, session);
    return { session, changed: true };
  }

  function reset(sessionId) {
    const database = databaseProvider();
    const row = database.prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId);
    if (!row) return { error: "Simulation session not found.", status: 404 };
    clearSessionTimer(sessionId);
    const timestamp = new Date(now()).toISOString();
    database.prepare(`
      UPDATE simulation_sessions
      SET status = 'PAUSED', run_number = run_number + 1, tick_count = 0,
          paused_at = ?, stopped_at = NULL, reset_at = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, timestamp, sessionId);
    const session = readSession(database, sessionId, 600);
    broadcastState("simulation_reset", session);
    return { session, changed: true };
  }

  function updateSpeed(sessionId, speed) {
    if (!SPEEDS.has(speed)) return { error: "speed must be one of 0.25, 0.5, 1, 2, or 4.", status: 400 };
    const database = databaseProvider();
    const row = database.prepare("SELECT status FROM simulation_sessions WHERE id = ?").get(sessionId);
    if (!row) return { error: "Simulation session not found.", status: 404 };
    database.prepare("UPDATE simulation_sessions SET speed = ?, updated_at = ? WHERE id = ?")
      .run(speed, new Date(now()).toISOString(), sessionId);
    if (row.status === "RUNNING") schedule(sessionId);
    const session = readSession(database, sessionId, 600);
    broadcastState("simulation_speed_changed", session);
    return { session, changed: true };
  }

  function restoreRunningSessions() {
    const database = databaseProvider();
    const sessions = database.prepare("SELECT id FROM simulation_sessions WHERE status = 'RUNNING'").all();
    for (const session of sessions) {
      schedule(session.id);
      tick(session.id);
    }
    return sessions.length;
  }

  function stopTimers() {
    for (const sessionId of timers.keys()) clearSessionTimer(sessionId);
  }

  return {
    start,
    get(sessionId) {
      return readSession(databaseProvider(), sessionId);
    },
    list(machineId = null) {
      return {
        sessions: listSessions(databaseProvider(), machineId),
        active_session: machineId ? activeForMachine(databaseProvider(), machineId) : null,
      };
    },
    transition,
    reset,
    updateSpeed,
    replay(sessionId) {
      const source = databaseProvider().prepare("SELECT * FROM simulation_sessions WHERE id = ?").get(sessionId);
      if (!source) return { error: "Simulation session not found.", status: 404 };
      return start({
        machineId: source.machine_id,
        scenario: source.scenario,
        speed: source.speed,
        replayOfSessionId: source.id,
      });
    },
    restoreRunningSessions,
    stopTimers,
    tick,
  };
}

export function createSimulationRouter({ service }) {
  if (!service) throw new TypeError("simulation service is required.");
  const router = express.Router();

  router.get("/simulations", (request, response) => {
    const machineId = request.query.machine_id;
    if (machineId !== undefined && !isUuid(machineId)) {
      return apiError(response, 400, "invalid_machine_id", "machine_id must be a UUID.");
    }
    try {
      return response.json(service.list(machineId || null));
    } catch (error) {
      console.error("Could not load simulation sessions:", error);
      return apiError(response, 500, "simulations_unavailable", "Simulation history could not be loaded.");
    }
  });

  router.post("/simulations", (request, response) => {
    const validationError = validateStartBody(request.body);
    if (validationError) return apiError(response, 400, "invalid_simulation", validationError);
    try {
      const result = service.start({
        machineId: request.body.machine_id,
        scenario: request.body.scenario,
        speed: request.body.speed ?? 1,
      });
      if (result.error) return apiError(response, result.status, "simulation_start_failed", result.error);
      return response.status(201).json({ session: result.session });
    } catch (error) {
      console.error("Could not start simulation:", error);
      return apiError(response, 500, "simulation_start_failed", "Simulation could not be started.");
    }
  });

  router.get("/simulations/:id", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_simulation_id", "Simulation ID must be a UUID.");
    try {
      const session = service.get(request.params.id);
      return session
        ? response.json({ session })
        : apiError(response, 404, "simulation_not_found", "Simulation session not found.");
    } catch (error) {
      console.error("Could not load simulation session:", error);
      return apiError(response, 500, "simulation_unavailable", "Simulation session could not be loaded.");
    }
  });

  const actions = {
    pause: (id) => service.transition(id, "pause"),
    resume: (id) => service.transition(id, "resume"),
    stop: (id) => service.transition(id, "stop"),
    reset: (id) => service.reset(id),
    replay: (id) => service.replay(id),
  };
  for (const [action, invoke] of Object.entries(actions)) {
    router.post(`/simulations/:id/${action}`, (request, response) => {
      if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_simulation_id", "Simulation ID must be a UUID.");
      if (Object.keys(request.body || {}).length) {
        return apiError(response, 400, "invalid_simulation_action", "This simulation action does not accept a request body.");
      }
      try {
        const result = invoke(request.params.id);
        if (result.error) return apiError(response, result.status, `simulation_${action}_failed`, result.error);
        return response.json({ session: result.session, changed: result.changed ?? true });
      } catch (error) {
        console.error(`Could not ${action} simulation:`, error);
        return apiError(response, 500, `simulation_${action}_failed`, `Simulation could not be ${action}d.`);
      }
    });
  }

  router.patch("/simulations/:id/speed", (request, response) => {
    if (!isUuid(request.params.id)) return apiError(response, 400, "invalid_simulation_id", "Simulation ID must be a UUID.");
    if (!request.body || Object.keys(request.body).some((key) => key !== "speed")) {
      return apiError(response, 400, "invalid_simulation_speed", "A JSON object with only a speed field is required.");
    }
    try {
      const result = service.updateSpeed(request.params.id, request.body.speed);
      if (result.error) return apiError(response, result.status, "invalid_simulation_speed", result.error);
      return response.json({ session: result.session });
    } catch (error) {
      console.error("Could not change simulation speed:", error);
      return apiError(response, 500, "simulation_speed_failed", "Simulation speed could not be changed.");
    }
  });
  return router;
}
