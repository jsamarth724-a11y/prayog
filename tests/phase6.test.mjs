import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrate.mjs";
import { persistValidAnalysis, registerMachine } from "../db/repository.mjs";
import { createJob, transitionJob } from "../jobs/repository.mjs";
import { createSensorRouter } from "../sensors/api.mjs";
import { fuseMachineContext } from "../sensors/fusion.mjs";
import { upsertSensorIncident } from "../sensors/repository.mjs";
import { getSimulationSample, SIMULATION_SCENARIOS } from "../sensors/scenarios.mjs";
import { createSimulationRouter, createSimulationService } from "../sensors/simulation.mjs";

function waitForSocketMessage(socket, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket message "${type}".`));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function jsonRequest(baseUrl, route, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test("Phase 6 deterministic scenarios are repeatable and explicitly simulated", () => {
  assert.deepEqual(Object.keys(SIMULATION_SCENARIOS), [
    "NORMAL",
    "OVERHEATING",
    "EXCESSIVE_VIBRATION",
    "UNUSUAL_NOISE",
    "SMOKE_INDICATION",
    "SPAGHETTI",
    "LAYER_SHIFT",
    "POOR_BED_ADHESION",
    "COMBINED_FAILURES",
  ]);
  for (const scenario of Object.keys(SIMULATION_SCENARIOS)) {
    assert.deepEqual(getSimulationSample(scenario, 2), getSimulationSample(scenario, 2));
  }
  assert.equal(getSimulationSample("OVERHEATING", 1).TEMPERATURE.value, 66);
  assert.equal(getSimulationSample("OVERHEATING", 4).TEMPERATURE.value, 90);
  assert.equal(getSimulationSample("EXCESSIVE_VIBRATION", 4).VIBRATION.value, 1.35);
  assert.equal(getSimulationSample("UNUSUAL_NOISE", 4).SOUND.eventType, "GRINDING");
  assert.equal(getSimulationSample("SMOKE_INDICATION", 4).SMOKE.alarmDetected, true);
  assert.equal(getSimulationSample("NORMAL", 4).SMOKE.value, 0);
  assert.throws(() => getSimulationSample("UNKNOWN", 1), /Unknown simulation scenario/);
});

test("Phase 6 simulation workflow persists, fuses, broadcasts, transitions, and replays", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase6-"));
  const databasePath = path.join(directory, "phase6.test.db");
  let database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  let socket = null;
  let webSocketServer = null;
  let server = null;
  const emittedTypes = [];
  let timerSequence = 0;
  const databaseProvider = () => database;
  const broadcast = (message) => {
    emittedTypes.push(message.type);
    if (!webSocketServer) return;
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    }
  };
  const service = createSimulationService({
    databaseProvider,
    broadcast,
    setTimer: () => ({ id: ++timerSequence, unref() {} }),
    clearTimer: () => {},
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createSensorRouter({ databaseProvider, broadcast }));
  app.use("/api", createSimulationRouter({ service }));

  try {
    const machine = registerMachine(database, {
      cameraId: "phase6-virtual-printer",
      label: "Phase 6 virtual printer",
      machineType: "3d_printer",
    });
    const cameraAnalysis = persistValidAnalysis(database, {
      machineId: machine.id,
      machineType: "3d_printer",
      timestamp: new Date().toISOString(),
      result: {
        status: "needs_attention",
        severity: 8,
        confidence: 0.95,
        failure_type: "possible_spaghetti",
        machine_status: "needs_attention",
        scene_state: "possible_spaghetti",
      },
    });
    const createdJob = createJob(database, {
      machineId: machine.id,
      name: "Phase 6 active print job",
      machineType: "3d_printer",
      jobType: "PRINT",
      expectedDurationSeconds: 1800,
      materialType: "PLA",
      expectedParameters: { nozzle_temperature_c: 210 },
      slicerMetadata: {},
      operatorNotes: "Simulation fixture only.",
    });
    assert.ok(createdJob.job);
    assert.equal(transitionJob(database, createdJob.job.id, "READY").changed, true);
    assert.equal(transitionJob(database, createdJob.job.id, "RUNNING").changed, true);

    server = app.listen(0);
    await once(server, "listening");
    webSocketServer = new WebSocketServer({ server });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await once(socket, "open");

    const startedEvent = waitForSocketMessage(socket, "simulation_started");
    const updateEvent = waitForSocketMessage(socket, "simulation_update");
    const incidentEvent = waitForSocketMessage(socket, "sensor_incident_created");
    const started = await jsonRequest(baseUrl, "/api/simulations", {
      method: "POST",
      body: { machine_id: machine.id, scenario: "COMBINED_FAILURES", speed: 1 },
    });
    assert.equal(started.response.status, 201);
    const sessionId = started.data.session.id;
    assert.equal(started.data.session.status, "RUNNING");
    assert.equal(started.data.session.tick_count, 1);
    assert.equal(started.data.session.readings.length, 4);
    assert.ok(started.data.session.readings.every((reading) => reading.provenance === "SIMULATED"));
    assert.ok(started.data.session.readings.some((reading) => reading.sensor_type === "TEMPERATURE" && reading.value === 72));
    assert.equal((await startedEvent).session.id, sessionId);
    assert.equal((await updateEvent).session.id, sessionId);
    const createdIncident = (await incidentEvent).incident;
    assert.equal(createdIncident.evidence.provenance, "MIXED");
    assert.equal(createdIncident.evidence.vision.id, cameraAnalysis.id);
    assert.equal(createdIncident.evidence.simulation.scenario, "COMBINED_FAILURES");
    assert.equal(createdIncident.evidence.active_job.name, "Phase 6 active print job");
    assert.ok(createdIncident.evidence.signals.every((signal) =>
      signal.evidence.provenance === "REAL" || signal.evidence.provenance === "SIMULATED",
    ));

    const fused = fuseMachineContext(database, machine.id);
    assert.equal(fused.result.provenance, "MIXED");
    assert.equal(fused.result.evidence.vision.id, cameraAnalysis.id);
    assert.equal(fused.result.evidence.active_job.name, "Phase 6 active print job");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM simulation_readings WHERE session_id = ?").get(sessionId).count, 4);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_readings WHERE provenance = 'SIMULATED'").get().count, 4);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_readings WHERE provenance = 'REAL'").get().count, 0);

    const ackEvent = waitForSocketMessage(socket, "sensor_incident_acknowledged");
    const acknowledged = await jsonRequest(baseUrl, `/api/incidents/${createdIncident.id}/acknowledge`, {
      method: "POST",
      body: { operator_notes: "Operator reviewing simulated alert." },
    });
    assert.equal(acknowledged.response.status, 200);
    assert.equal(acknowledged.data.incident.state, "ACKNOWLEDGED");
    assert.equal((await ackEvent).incident.id, createdIncident.id);

    const paused = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/pause`, { method: "POST" });
    assert.equal(paused.data.session.status, "PAUSED");
    const invalidPause = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/pause`, { method: "POST" });
    assert.equal(invalidPause.response.status, 409);
    assert.equal((await jsonRequest(baseUrl, `/api/simulations/${sessionId}/speed`, {
      method: "PATCH",
      body: { speed: 2 },
    })).data.session.speed, 2);

    const resumedEvent = waitForSocketMessage(socket, "simulation_resumed");
    const resumed = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/resume`, { method: "POST" });
    assert.equal(resumed.data.session.status, "RUNNING");
    assert.equal((await resumedEvent).session.id, sessionId);
    const stillAcknowledged = await jsonRequest(baseUrl, `/api/incidents/${createdIncident.id}`);
    assert.equal(stillAcknowledged.data.incident.state, "ACKNOWLEDGED");

    const reset = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/reset`, { method: "POST" });
    assert.equal(reset.data.session.status, "PAUSED");
    assert.equal(reset.data.session.run_number, 2);
    assert.equal(reset.data.session.tick_count, 0);
    assert.equal(reset.data.session.readings.length, 8);
    const resumedAgain = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/resume`, { method: "POST" });
    assert.equal(resumedAgain.data.session.tick_count, 1);
    assert.ok(resumedAgain.data.session.readings.every((reading) => reading.provenance === "SIMULATED"));

    const resolveEvent = waitForSocketMessage(socket, "sensor_incident_resolved");
    const resolved = await jsonRequest(baseUrl, `/api/incidents/${createdIncident.id}/resolve`, {
      method: "POST",
      body: { operator_notes: "Simulation reviewed and resolved." },
    });
    assert.equal(resolved.data.incident.state, "RESOLVED");
    assert.equal((await resolveEvent).incident.id, createdIncident.id);

    const stopped = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/stop`, { method: "POST" });
    assert.equal(stopped.data.session.status, "STOPPED");
    const replayEvent = waitForSocketMessage(socket, "simulation_replayed");
    const replayUpdateEvent = waitForSocketMessage(socket, "simulation_update");
    const replayIncidentEvent = waitForSocketMessage(socket, "sensor_incident_created");
    const replayed = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/replay`, { method: "POST" });
    assert.equal(replayed.data.session.status, "RUNNING");
    assert.equal(replayed.data.session.replay_of_session_id, sessionId);
    assert.notEqual(replayed.data.session.id, sessionId);
    assert.equal((await replayEvent).session.id, replayed.data.session.id);
    assert.equal((await replayUpdateEvent).session.id, replayed.data.session.id);
    assert.equal((await replayIncidentEvent).incident.state, "OPEN");
    await jsonRequest(baseUrl, `/api/simulations/${replayed.data.session.id}/stop`, { method: "POST" });

    const badSpeed = await jsonRequest(baseUrl, `/api/simulations/${sessionId}/speed`, {
      method: "PATCH",
      body: { speed: 3 },
    });
    assert.equal(badSpeed.response.status, 400);
    const badScenario = await jsonRequest(baseUrl, "/api/simulations", {
      method: "POST",
      body: { machine_id: machine.id, scenario: "RANDOM_FAILURE" },
    });
    assert.equal(badScenario.response.status, 400);
    const history = await jsonRequest(baseUrl, `/api/simulations?machine_id=${machine.id}`);
    assert.equal(history.data.sessions.length, 2);
    assert.ok(history.data.sessions.every((session) =>
      session.readings.every((reading) => reading.provenance === "SIMULATED"),
    ));
    for (const type of [
      "simulation_started",
      "simulation_update",
      "simulation_paused",
      "simulation_resumed",
      "simulation_reset",
      "simulation_stopped",
      "simulation_replayed",
      "sensor_incident_created",
      "sensor_incident_acknowledged",
      "sensor_incident_resolved",
    ]) assert.ok(emittedTypes.includes(type), `Expected WebSocket event ${type}`);

    service.stopTimers();
    socket.close();
    await once(socket, "close");
    await new Promise((resolve) => webSocketServer.close(resolve));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    assert.equal(runMigrations(database).length, 11);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM simulation_sessions").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM simulation_readings").get().count, 16);
    assert.equal(database.prepare("SELECT state FROM sensor_incidents WHERE id = ?").get(createdIncident.id).state, "RESOLVED");
  } finally {
    service.stopTimers();
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (webSocketServer) await new Promise((resolve) => webSocketServer.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("normal simulations preserve REAL incidents and failure scenarios create SIMULATED incidents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase6-provenance-"));
  const databasePath = path.join(directory, "phase6-provenance.test.db");
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const service = createSimulationService({
    databaseProvider: () => database,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });

  try {
    const normalMachine = registerMachine(database, {
      cameraId: "phase6-normal-only",
      label: "Phase 6 normal-only machine",
      machineType: "3d_printer",
    });
    const normal = service.start({ machineId: normalMachine.id, scenario: "NORMAL", speed: 1 });
    assert.equal(normal.status, 201);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sensor_incidents WHERE machine_id = ?
    `).get(normalMachine.id).count, 0);
    service.transition(normal.session.id, "stop");

    const realMachine = registerMachine(database, {
      cameraId: "phase6-real-camera",
      label: "Phase 6 REAL camera",
      machineType: "3d_printer",
    });
    const analysis = persistValidAnalysis(database, {
      machineId: realMachine.id,
      machineType: "3d_printer",
      result: {
        status: "failure",
        severity: 8,
        confidence: 0.95,
        failure_type: "spaghetti",
        machine_status: "needs_attention",
        scene_state: "failed_material_on_plate",
      },
    });
    const originalEvidence = { provenance: "REAL", marker: "must-not-change" };
    const realIncident = upsertSensorIncident(database, {
      machineId: realMachine.id,
      category: "MACHINE_MULTIMODAL_RISK",
      severity: "HIGH",
      summary: "Existing real camera incident",
      explanation: "Persisted independently of simulation.",
      possibleRootCauses: [],
      recommendedActions: [],
      evidence: originalEvidence,
      fusionScore: 78,
      timestamp: analysis.timestamp,
    }).incident;
    const before = database.prepare(`
      SELECT severity, summary, evidence, latest_detected_at, updated_at
      FROM sensor_incidents WHERE id = ?
    `).get(realIncident.id);

    const realContextNormal = service.start({ machineId: realMachine.id, scenario: "NORMAL", speed: 1 });
    assert.equal(realContextNormal.status, 201);
    const normalFusion = database.prepare(`
      SELECT risk_level, evidence FROM sensor_fusion_results
      WHERE machine_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(realMachine.id);
    const normalEvidence = JSON.parse(normalFusion.evidence);
    assert.equal(normalFusion.risk_level, "MODERATE");
    assert.equal(normalEvidence.provenance, "REAL");
    assert.equal(normalEvidence.data_provenance, "MIXED");
    assert.ok(normalEvidence.signals.some((signal) => signal.evidence.source === "camera_analysis"));
    assert.ok(normalEvidence.signals.every((signal) => signal.evidence.provenance === "REAL"));
    const after = database.prepare(`
      SELECT severity, summary, evidence, latest_detected_at, updated_at
      FROM sensor_incidents WHERE id = ?
    `).get(realIncident.id);
    assert.deepEqual(after, before);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sensor_incidents
      WHERE machine_id = ? AND category = 'SIMULATED_MACHINE_MULTIMODAL_RISK'
    `).get(realMachine.id).count, 0);
    service.transition(realContextNormal.session.id, "stop");

    const expectedSensorSignals = new Map([
      ["OVERHEATING", "TEMPERATURE_OVER_LIMIT"],
      ["EXCESSIVE_VIBRATION", "ABNORMAL_VIBRATION"],
      ["UNUSUAL_NOISE", "UNUSUAL_SOUND"],
      ["SMOKE_INDICATION", "SMOKE_SENSOR_ALERT"],
      ["COMBINED_FAILURES", "SMOKE_SENSOR_ALERT"],
    ]);
    for (const [scenario, expectedCategory] of expectedSensorSignals) {
      const machine = registerMachine(database, {
        cameraId: `phase6-${scenario.toLowerCase()}`,
        label: `Phase 6 ${scenario}`,
        machineType: "3d_printer",
      });
      const started = service.start({ machineId: machine.id, scenario, speed: 1 });
      assert.equal(started.status, 201);
      const fusion = database.prepare(`
        SELECT risk_level, evidence FROM sensor_fusion_results
        WHERE machine_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(machine.id);
      const evidence = JSON.parse(fusion.evidence);
      assert.ok(evidence.signals.some((signal) =>
        signal.category === expectedCategory &&
        signal.evidence.provenance === "SIMULATED",
      ), `${scenario} should report ${expectedCategory} with SIMULATED provenance`);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM sensor_incidents
        WHERE machine_id = ? AND category = 'SIMULATED_MACHINE_MULTIMODAL_RISK'
          AND json_extract(evidence, '$.provenance') = 'SIMULATED'
      `).get(machine.id).count, 1);
      service.transition(started.session.id, "stop");
    }
  } finally {
    service.stopTimers();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
