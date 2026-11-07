import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { closeDatabase } from "../db/database.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { classifyProviderError } from "../ai/errors.mjs";
import { persistValidAnalysis, registerMachine } from "../db/repository.mjs";
import {
  getIncident,
  listIncidentEvents,
  refreshSensorHealth,
  transitionIncident,
  upsertSensorIncident,
} from "../sensors/repository.mjs";
import {
  evaluateSensorFusion,
  fuseMachineContext,
  getSensorFusionConfig,
} from "../sensors/fusion.mjs";
import {
  normalizeCalibrationTimestamp,
  normalizeSensorReading,
  normalizeSensorRegistration,
} from "../sensors/adapters.mjs";
import { createSensorRouter } from "../sensors/api.mjs";

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

function responseWith(content, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { choices: [{ message: { content: JSON.stringify(content) } }] }
        : { error: { message: String(content) } },
    ),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

test("Phase 5 sensor validation, persistence, fusion, and live integration", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase5-"));
  const databasePath = path.join(directory, "phase5.test.db");
  const environmentKeys = [
    "VISION_OPS_DB_PATH",
    "SENSOR_ADMIN_TOKEN",
    "SENSOR_MIN_INTERVAL_MS",
    "SENSOR_SOUND_CRITICAL_DB",
    "AI_PROVIDER",
    "OPENROUTER_API_KEY",
    "DISCORD_WEBHOOK_URL",
    "PRINTER_DRIVER",
  ];
  const previousEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  const adminToken = "phase5-admin-token-for-tests-only";
  process.env.VISION_OPS_DB_PATH = databasePath;
  process.env.SENSOR_ADMIN_TOKEN = adminToken;
  process.env.SENSOR_MIN_INTERVAL_MS = "1000";
  process.env.SENSOR_SOUND_CRITICAL_DB = "100";
  let database = new Database(databasePath);
  let apiServer = null;
  let monitoringServer = null;
  let socket = null;
  let pendingFusionEvent = null;

  try {
    await t.test("classifies provider setup, authentication, model, quota, and image failures", () => {
      const options = {
        provider: "Groq",
        model: "qwen/qwen3.8-27b",
        secrets: ["gsk-test-secret"],
      };
      const cases = [
        [{ message: "No Groq API key is configured." }, "provider_configuration_error", null],
        [{ status: 401, message: "Invalid API key gsk-test-secret" }, "provider_authentication_failed", 401],
        [{ status: 404, message: "The model does not exist." }, "provider_model_access_failed", 404],
        [{ status: 429, message: "Rate limit reached." }, "provider_rate_limited", 429],
        [{ status: 400, message: "Invalid image format." }, "provider_image_format_invalid", 400],
        [{ status: 415, message: "Unsupported image media type." }, "provider_image_format_invalid", 415],
        [{ status: 413, message: "Payload too large." }, "provider_image_too_large", 413],
        [{ code: "provider_configuration_error", message: "Unsupported provider." }, "provider_configuration_error", null],
      ];
      for (const [error, expectedCode, expectedStatus] of cases) {
        const classified = classifyProviderError(error, options);
        assert.equal(classified.code, expectedCode);
        assert.equal(classified.status, expectedStatus);
        assert.equal(classified.providerMessage.includes("gsk-test-secret"), false);
      }
    });

    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const machine = registerMachine(database, {
      cameraId: "phase5-sensor-fixture",
      label: "Phase 5 sensor fixture",
      machineType: "3d_printer",
    });
    const offlineMachine = registerMachine(database, {
      cameraId: "phase5-offline-fixture",
      label: "Phase 5 offline fixture",
      machineType: "cnc",
    });
    const now = Date.now();

    await t.test("validates timestamps, provenance, ranges, units, and bounded payloads", () => {
      const validRegistration = normalizeSensorRegistration({
        name: "Fixture sound sensor",
        sensor_type: "SOUND",
        adapter_type: "ESP32",
        provenance: "REAL",
        unit: "dBA",
      });
      assert.equal(validRegistration.value.type, "SOUND");
      assert.equal(normalizeSensorRegistration({
        name: "Unlabeled source",
        sensor_type: "SOUND",
        adapter_type: "ESP32",
        unit: "dBA",
      }).error !== undefined, true);

      const sensor = {
        id: "fixture-sensor",
        sensor_type: "VIBRATION",
        unit: "m/s2",
      };
      const converted = normalizeSensorReading(sensor, {
        observed_at: new Date(now).toISOString(),
        value: 9.80665,
        unit: "m/s2",
      }, { now });
      assert.equal(converted.value.value, 1);
      assert.equal(converted.value.unit, "g");
      assert.match(normalizeSensorReading(sensor, {
        observed_at: new Date(now).toISOString(),
        value: 981,
        unit: "m/s2",
      }, { now }).error, /between/);
      assert.match(normalizeSensorReading(sensor, {
        observed_at: "2026-02-30T12:00:00.000Z",
        value: 1,
        unit: "m/s2",
      }, { now }).error, /observed_at/);
      assert.match(normalizeSensorReading(sensor, {
        observed_at: new Date(now).toISOString(),
        value: 1,
        unit: "m/s2",
        waveform: [0, 1],
      }, { now }).error, /unsupported fields/);
      assert.match(normalizeSensorReading(sensor, {
        observed_at: new Date(now).toISOString(),
        value: 1,
        unit: "g",
      }, { now }).error, /registered unit/);
      assert.equal(normalizeCalibrationTimestamp("invalid"), null);
    });

    await t.test("evaluates each modality and combines smoke sensing with camera suspicion", () => {
      const currentTime = Date.now();
      const cases = [
        ["SOUND", 110, "dBA", "UNUSUAL_SOUND"],
        ["VIBRATION", 1.1, "g", "ABNORMAL_VIBRATION"],
        ["TEMPERATURE", 90, "°C", "TEMPERATURE_OVER_LIMIT"],
        ["SMOKE", 60, "ppm", "SMOKE_SENSOR_ALERT"],
      ];
      const results = cases.map(([type, value, unit, expectedCategory]) => {
        const sensor = {
          id: `fixture-${type.toLowerCase()}`,
          name: `Fixture ${type.toLowerCase()}`,
          sensor_type: type,
          enabled: true,
          health_status: "ONLINE",
          calibration_status: "CURRENT",
          latest_reading: {
            id: `fixture-reading-${type.toLowerCase()}`,
            observed_at: new Date(currentTime).toISOString(),
            value,
            unit,
            event_type: null,
            alarm_detected: type === "SMOKE" ? true : null,
            provenance: "SIMULATED",
          },
        };
        const evaluated = evaluateSensorFusion({
          machine: machine,
          sensors: [sensor],
          vision: null,
          trend: null,
          active_job: null,
        }, getSensorFusionConfig(), currentTime);
        assert.ok(evaluated.signals.some((signal) => signal.category === expectedCategory));
        assert.equal(evaluated.provenance, "SIMULATED");
        return evaluated;
      });
      assert.equal(results[3].risk_level, "CRITICAL");

      const smokeFusion = evaluateSensorFusion({
        machine,
        sensors: [{
          id: "fixture-real-smoke",
          name: "Fixture real smoke sensor",
          sensor_type: "SMOKE",
          enabled: true,
          health_status: "ONLINE",
          calibration_status: "CURRENT",
          latest_reading: {
            id: "fixture-real-smoke-reading",
            observed_at: new Date(currentTime).toISOString(),
            value: 55,
            unit: "ppm",
            event_type: "SMOKE_SUSPECTED",
            alarm_detected: true,
            provenance: "REAL",
          },
        }],
        vision: {
          id: "fixture-camera-analysis",
          timestamp: new Date(currentTime).toISOString(),
          failure_type: "smoke_suspicion",
          scene_state: "smoke_visible",
          confidence: 0.9,
          abnormality_score: 82,
          is_uncertain: 0,
        },
        trend: null,
        active_job: null,
      }, getSensorFusionConfig(), currentTime);
      assert.ok(smokeFusion.signals.some((signal) => signal.category === "CAMERA_SMOKE_SUSPICION"));
      assert.ok(smokeFusion.signals.some((signal) => signal.category === "SMOKE_SENSOR_ALERT"));
      assert.equal(smokeFusion.provenance, "REAL");
      assert.equal(smokeFusion.risk_level, "CRITICAL");
    });

    await t.test("bounds configurable thresholds and keeps warning/critical ordering valid", () => {
      const keys = [
        "SENSOR_STALE_AFTER_MS",
        "SENSOR_DISCONNECTED_AFTER_MS",
        "SENSOR_FUSION_FRESH_MS",
        "SENSOR_SOUND_WARNING_DB",
        "SENSOR_SOUND_CRITICAL_DB",
      ];
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      try {
        process.env.SENSOR_STALE_AFTER_MS = "10";
        process.env.SENSOR_DISCONNECTED_AFTER_MS = "1";
        process.env.SENSOR_FUSION_FRESH_MS = "999999999";
        process.env.SENSOR_SOUND_WARNING_DB = "200";
        process.env.SENSOR_SOUND_CRITICAL_DB = "0";
        const config = getSensorFusionConfig();
        assert.equal(config.staleAfterMs, 1000);
        assert.equal(config.disconnectedAfterMs, 2000);
        assert.equal(config.freshReadingMs, 2000);
        assert.equal(config.soundWarningDb, 160);
        assert.equal(config.soundCriticalDb, 160);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    await t.test("authenticates sensor APIs, stores evidence, fuses incidents, and broadcasts state changes", async () => {
      const events = [];
      const app = express();
      app.use(express.json({ limit: "4kb" }));
      app.use("/api", createSensorRouter({
        databaseProvider: () => database,
        broadcast: (event) => events.push(event),
        now: () => now,
      }));
      apiServer = app.listen(0);
      if (!apiServer.listening) await once(apiServer, "listening");
      const baseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
      const unconfiguredRegistration = await fetch(`${baseUrl}/sensors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_id: machine.id }),
      });
      assert.equal(unconfiguredRegistration.status, 401);
      const registerResponse = await fetch(`${baseUrl}/sensors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          machine_id: machine.id,
          name: "Fixture enclosure sound",
          sensor_type: "SOUND",
          adapter_type: "ESP32",
          provenance: "REAL",
          unit: "dBA",
          calibration_due_at: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      });
      assert.equal(registerResponse.status, 201);
      const registration = await registerResponse.json();
      assert.equal(registration.sensor.provenance, "REAL");
      assert.ok(registration.credential);
      assert.equal(Object.hasOwn(registration.sensor, "token_hash"), false);
      const sensorId = registration.sensor.id;
      const sensorCredential = registration.credential;
      const missingEvidence = await fetch(`${baseUrl}/sensor-intelligence?machine_id=${offlineMachine.id}`);
      assert.equal(missingEvidence.status, 200);
      const unavailable = await missingEvidence.json();
      assert.equal(unavailable.current_fusion.risk_level, "UNAVAILABLE");
      assert.equal(unavailable.current_fusion.coverage.status, "PARTIAL");
      assert.ok(unavailable.current_fusion.coverage.modalities.every((item) => item.status === "UNAVAILABLE"));

      const unauthorized = await fetch(`${baseUrl}/sensors/${sensorId}/readings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observed_at: new Date(now).toISOString(),
          value: 110,
          unit: "dBA",
        }),
      });
      assert.equal(unauthorized.status, 401);

      const readingResponse = await fetch(`${baseUrl}/sensors/${sensorId}/readings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sensorCredential}`,
        },
        body: JSON.stringify({
          observed_at: new Date(now).toISOString(),
          value: 110,
          unit: "dBA",
          event_type: "GRINDING",
          source_event_id: "phase5-fixture-reading-1",
        }),
      });
      assert.equal(readingResponse.status, 201);
      const reading = await readingResponse.json();
      assert.equal(reading.reading.provenance, "REAL");
      assert.equal(reading.health_status, "ONLINE");
      assert.equal(reading.fusion.risk_level, "CRITICAL");
      assert.equal(reading.fusion.signals[0].evidence.sensor_type, "SOUND");

      const duplicate = await fetch(`${baseUrl}/sensors/${sensorId}/readings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sensorCredential}`,
        },
        body: JSON.stringify({
          observed_at: new Date(now).toISOString(),
          value: 110,
          unit: "dBA",
          source_event_id: "phase5-fixture-reading-1",
        }),
      });
      assert.equal(duplicate.status, 409);

      const snapshotResponse = await fetch(`${baseUrl}/sensor-intelligence?machine_id=${machine.id}`);
      assert.equal(snapshotResponse.status, 200);
      const snapshot = await snapshotResponse.json();
      assert.equal(snapshot.current_fusion.risk_level, "CRITICAL");
      assert.equal(snapshot.sensors[0].latest_reading.provenance, "REAL");
      assert.equal(snapshot.incidents.length, 1);
      const incidentId = snapshot.incidents[0].id;

      const sensorRow = database.prepare("SELECT * FROM sensors WHERE id = ?").get(sensorId);
      const stale = refreshSensorHealth(database, { ...sensorRow }, {
        staleAfterMs: 60_000,
        disconnectedAfterMs: 300_000,
        now: Date.parse(sensorRow.last_seen_at) + 90_000,
      });
      assert.equal(stale.health_status, "STALE");
      const disconnected = refreshSensorHealth(
        database,
        database.prepare("SELECT * FROM sensors WHERE id = ?").get(sensorId),
        {
          staleAfterMs: 60_000,
          disconnectedAfterMs: 300_000,
          now: Date.parse(sensorRow.last_seen_at) + 360_000,
        },
      );
      assert.equal(disconnected.health_status, "DISCONNECTED");

      const repeatedIncident = upsertSensorIncident(database, {
        machineId: machine.id,
        category: "MACHINE_MULTIMODAL_RISK",
        severity: "HIGH",
        summary: "Fixture repeated evidence",
        explanation: "Repeated fixture evidence.",
        possibleRootCauses: [],
        recommendedActions: [],
        evidence: { fixture: true },
        fusionScore: 70,
        timestamp: new Date(now + 1000).toISOString(),
      });
      assert.equal(repeatedIncident.created, false);
      assert.equal(repeatedIncident.incident.id, incidentId);
      assert.equal(repeatedIncident.incident.severity, "CRITICAL");

      const acknowledged = await fetch(`${baseUrl}/incidents/${incidentId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Fixture inspected." }),
      });
      assert.equal(acknowledged.status, 200);
      assert.equal((await acknowledged.json()).incident.state, "ACKNOWLEDGED");
      const duplicateAcknowledgment = await transitionIncident(database, incidentId, "acknowledge");
      assert.equal(duplicateAcknowledgment.changed, false);

      const resolved = await fetch(`${baseUrl}/incidents/${incidentId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Fixture resolved." }),
      });
      assert.equal(resolved.status, 200);
      assert.equal((await resolved.json()).incident.state, "RESOLVED");
      assert.equal((await fetch(`${baseUrl}/incidents/${incidentId}/acknowledge`, { method: "POST" })).status, 409);
      assert.equal(listIncidentEvents(database, incidentId).length, 2);

      const emittedTypes = events.map((event) => event.type);
      for (const type of [
        "sensor_reading",
        "sensor_fusion_update",
        "sensor_incident_created",
        "sensor_health_update",
        "sensor_incident_acknowledged",
        "sensor_incident_resolved",
      ]) assert.ok(emittedTypes.includes(type), `Expected event ${type}`);

      database.close();
      database = new Database(databasePath);
      database.pragma("foreign_keys = ON");
      assert.equal(runMigrations(database).length, 11);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_readings").get().count, 1);
      assert.equal(getIncident(database, incidentId).state, "RESOLVED");
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_fusion_results").get().count, 1);
    });

    await t.test("fuses camera records through the existing persisted-history path", () => {
      const analysis = persistValidAnalysis(database, {
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
      const fused = fuseMachineContext(database, machine.id);
      assert.ok(fused);
      assert.ok(fused.result.signals.some((signal) => signal.evidence.source === "camera_analysis"));
      assert.equal(
        database.prepare("SELECT id FROM sensor_fusion_results ORDER BY created_at DESC LIMIT 1").get().id,
        fused.fusion.id,
      );
      assert.ok(analysis.id);
    });

    await t.test("connects camera analysis to the live WebSocket fusion updates", async () => {
      const originalCwd = process.cwd();
      const previousFetch = globalThis.fetch;
      process.env.AI_PROVIDER = "openrouter";
      process.env.OPENROUTER_API_KEY = "phase5-openrouter-test-key";
      process.env.DISCORD_WEBHOOK_URL = "";
      process.env.PRINTER_DRIVER = "none";
      process.chdir(directory);
      globalThis.fetch = async (url, options) => {
        if (String(url).startsWith("https://openrouter.ai/")) {
          return responseWith({
            status: "warning",
            severity: 9,
            confidence: 0.95,
            failure_type: "spaghetti",
            scene_state: "printing_suspicious",
            material_pattern: "chaotic_loose_filament",
            loose_filament_extent: "tangled_mass",
          });
        }
        const target = new URL(String(url), "http://localhost");
        if (["localhost", "127.0.0.1"].includes(target.hostname)) return previousFetch(url, options);
        throw new Error(`Unexpected external request in Phase 5 fixture: ${url}`);
      };
      try {
        const serverModule = await import("../server.mjs");
        monitoringServer = await serverModule.startServer({ listenPort: 0 });
        if (!monitoringServer.listening) await once(monitoringServer, "listening");
        const configResponse = await fetch(`http://127.0.0.1:${monitoringServer.address().port}/api/config`);
        const runtimeConfig = await configResponse.json();
        assert.equal(runtimeConfig.provider, "openrouter");
        assert.equal(runtimeConfig.model, "anthropic/claude-3.5-haiku");
        assert.equal(runtimeConfig.modelSource, "default");
        assert.equal(runtimeConfig.projectEnvLoaded, true);
        socket = new WebSocket(`ws://127.0.0.1:${monitoringServer.address().port}`);
        await once(socket, "open");
        pendingFusionEvent = waitForSocketMessage(socket, "sensor_fusion_update");
        const malformedJson = await fetch(`http://127.0.0.1:${monitoringServer.address().port}/api/sensors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        });
        assert.equal(malformedJson.status, 400);
        assert.equal((await malformedJson.json()).error.code, "invalid_sensor_json");
        const oversizedPayload = await fetch(`http://127.0.0.1:${monitoringServer.address().port}/api/sensors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ padding: "x".repeat(5000) }),
        });
        assert.equal(oversizedPayload.status, 413);
        assert.equal((await oversizedPayload.json()).error.code, "sensor_payload_too_large");
        const response = await fetch(`http://127.0.0.1:${monitoringServer.address().port}/api/analyze-machine`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
            machineType: "3d_printer",
            cameraId: "phase5-sensor-fixture",
            cameraLabel: "Phase 5 sensor fixture",
          }),
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        const message = await pendingFusionEvent;
        assert.equal(message.machineId, payload.machine_id);
        assert.ok(message.fusion.evidence.signals.some((signal) => signal.evidence.source === "camera_analysis"));
        assert.ok(database.prepare("SELECT id FROM sensor_incidents WHERE machine_id = ? AND state = 'OPEN'").get(machine.id));
      } finally {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const socketClosed = once(socket, "close");
          socket.close();
          await socketClosed;
        }
        if (monitoringServer?.listening) {
          await new Promise((resolve, reject) => {
            monitoringServer.close((error) => error ? reject(error) : resolve());
          });
          monitoringServer = null;
        }
        if (pendingFusionEvent) await Promise.allSettled([pendingFusionEvent]);
        globalThis.fetch = previousFetch;
        process.chdir(originalCwd);
      }
    });
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const socketClosed = once(socket, "close");
      socket.close();
      await socketClosed;
    }
    if (apiServer?.listening) await new Promise((resolve) => apiServer.close(resolve));
    if (monitoringServer?.listening) await new Promise((resolve) => monitoringServer.close(resolve));
    closeDatabase();
    if (database?.open) database.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
