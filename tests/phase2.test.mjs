import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import WebSocket from "ws";
import { closeDatabase, initializeDatabase } from "../db/database.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  getValidTrendRecords,
  listMachineWarnings,
  classifyRisk,
  persistInvalidAnalysis,
  persistValidAnalysis,
  registerMachine,
  transitionWarning,
  upsertEarlyWarning,
} from "../db/repository.mjs";
import { getTrendConfig } from "../trend/config.mjs";
import { analyzeTrend, evaluateEarlyWarnings } from "../trend/engine.mjs";

const TEST_CONFIG = Object.freeze({
  shortWindow: 3,
  longWindow: 4,
  baselineWindow: 8,
  minimumObservations: 5,
  risingSlopePerObservation: 1,
  rapidSlopePerObservation: 2,
  minimumTrendDelta: 3,
  persistentHighThreshold: 70,
  persistentObservationCount: 3,
  gradualMinimumObservations: 5,
  moderateWindow: 5,
  moderateObservationThreshold: 3,
  moderateMinimumObservations: 5,
  spikeBaselineWindow: 3,
  spikeIncreaseThreshold: 20,
  spikeMinimumObservations: 6,
  repeatedFailureWindow: 6,
  repeatedFailureCount: 2,
  repeatedFailureMinimumObservations: 5,
  baselineMinimumObservations: 4,
  baselineRecentWindow: 2,
  baselineZScoreThreshold: 2,
  baselineMinimumDeviation: 15,
  warningMinimumConfidence: 0.1,
  warningFullSeverityConfidence: 0.5,
  maximumGapHours: 24,
});

function records(scores, options = {}) {
  const start = Date.parse("2026-11-06T00:00:00.000Z");
  return scores.map((score, index) => ({
    id: `record-${index}`,
    timestamp: new Date(start + index * 3_600_000).toISOString(),
    abnormality_score: score,
    confidence: options.confidence ?? 0.9,
    is_uncertain: options.is_uncertain ?? 0,
    is_valid: options.invalidIndex === index ? 0 : 1,
    failure_type: options.failureTypes?.[index] || "none",
  }));
}

function apiResponse(content, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { choices: [{ message: { content: JSON.stringify(content) } }] }
        : { error: { message: String(content) } },
    ),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

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

test("Phase 2 trend intelligence, warnings, and API", async (t) => {
  await t.test("computes SMA, timestamp regression slope, and per-observation rate", () => {
    const result = analyzeTrend(records([10, 20, 30, 40, 50]), TEST_CONFIG);
    assert.equal(result.moving_average, 40);
    assert.equal(result.long_moving_average, 35);
    assert.equal(result.slope, 10);
    assert.equal(result.rate_per_observation, 10);
    assert.equal(result.slope_unit, "abnormality_points_per_hour");
  });

  await t.test("excludes invalid scores from all aggregates and handles empty/short/missing time data", () => {
    const valid = records([10, 20, 30, 40, 50]);
    const invalidIncluded = [...valid, {
      id: "invalid",
      timestamp: "2026-11-06T02:30:00.000Z",
      abnormality_score: 100,
      confidence: 1,
      is_valid: 0,
      failure_type: "spaghetti",
    }];
    const baseline = analyzeTrend(valid, TEST_CONFIG);
    const withInvalid = analyzeTrend(invalidIncluded, TEST_CONFIG);
    assert.equal(withInvalid.valid_observations, 5);
    assert.equal(withInvalid.moving_average, baseline.moving_average);
    assert.equal(withInvalid.slope, baseline.slope);
    assert.deepEqual(
      evaluateEarlyWarnings(invalidIncluded, withInvalid, TEST_CONFIG),
      evaluateEarlyWarnings(valid, baseline, TEST_CONFIG),
    );
    assert.deepEqual(analyzeTrend([], TEST_CONFIG).trend_classification, "INSUFFICIENT_DATA");
    assert.equal(analyzeTrend(records([10, 20, 30, 40]), TEST_CONFIG).trend_classification, "INSUFFICIENT_DATA");
    assert.equal(analyzeTrend(records([10, 20, 30, 40, 50]), TEST_CONFIG).short_term_trend.delta, null);
    const missingTimes = records([10, 20, 30, 40, 50]).map((record) => ({ ...record, timestamp: null }));
    assert.equal(analyzeTrend(missingTimes, TEST_CONFIG).slope, null);
    const identical = analyzeTrend(records([25, 25, 25, 25, 25]), TEST_CONFIG);
    assert.equal(identical.rate_per_observation, 0);
    assert.equal(identical.trend_classification, "STABLE");
  });

  await t.test("applies every classification and documented precedence", () => {
    const cases = [
      [[10, 12, 14, 16], "INSUFFICIENT_DATA"],
      [[20, 20, 20, 20, 20, 20], "STABLE"],
      [[10, 11, 12, 13, 14, 15, 16], "RISING"],
      [[10, 12, 14, 16, 18, 20, 22], "RAPIDLY_RISING"],
      [[80, 75, 70, 65, 60, 55, 50, 45, 40, 35], "IMPROVING"],
      [[75, 76, 77, 78, 79], "PERSISTENT_HIGH"],
    ];
    for (const [scores, expected] of cases) {
      assert.equal(analyzeTrend(records(scores), TEST_CONFIG).trend_classification, expected);
    }
    const conflicting = analyzeTrend(records([10, 12, 14, 16, 18, 75, 76, 77]), TEST_CONFIG);
    assert.equal(conflicting.trend_classification, "PERSISTENT_HIGH");
  });

  await t.test("evaluates early-warning rules with minimum observations and suppresses one-frame alerts", () => {
    const fixtures = [
      { category: "gradual_increase", scores: [10, 12, 14, 16, 18, 20] },
      { category: "repeated_moderate", scores: [45, 46, 47, 45, 48] },
      { category: "sudden_spike", scores: [10, 10, 10, 10, 10, 45] },
      { category: "persistent_high", scores: [75, 76, 77, 78, 79] },
      {
        category: "repeated_failure:bed_adhesion",
        scores: [20, 20, 20, 20, 20, 20],
        failureTypes: ["none", "bed_adhesion", "none", "none", "bed_adhesion", "none"],
      },
      { category: "baseline_deviation", scores: [10, 10, 10, 10, 10, 10, 10, 10, 40, 40] },
    ];
    for (const fixture of fixtures) {
      const sample = records(fixture.scores, { failureTypes: fixture.failureTypes });
      const trend = analyzeTrend(sample, TEST_CONFIG);
      const warnings = evaluateEarlyWarnings(sample, trend, TEST_CONFIG);
      const warning = warnings.find((candidate) => candidate.category === fixture.category);
      assert.ok(warning, `Expected ${fixture.category} from its controlled sample`);
      assert.ok(warning.recommended_action, `${fixture.category} must have an operator action`);
    }

    const one = records([95]);
    assert.deepEqual(evaluateEarlyWarnings(one, analyzeTrend(one, TEST_CONFIG), TEST_CONFIG), []);
    const isolatedSpike = records([10, 10, 10, 10, 10, 95]);
    const isolatedSpikeTrend = analyzeTrend(isolatedSpike, TEST_CONFIG);
    const isolatedSpikeWarnings = evaluateEarlyWarnings(
      isolatedSpike,
      isolatedSpikeTrend,
      TEST_CONFIG,
    );
    assert.notEqual(isolatedSpikeTrend.trend_classification, "PERSISTENT_HIGH");
    assert.ok(!isolatedSpikeWarnings.some((warning) => warning.category === "persistent_high"));
    const lowConfidence = records([10, 12, 14, 16, 18, 20], { confidence: 0.01 });
    assert.deepEqual(
      evaluateEarlyWarnings(lowConfidence, analyzeTrend(lowConfidence, TEST_CONFIG), TEST_CONFIG),
      [],
    );
    const tooFewForHighPersistence = records([75, 76]);
    assert.ok(
      !evaluateEarlyWarnings(
        tooFewForHighPersistence,
        analyzeTrend(tooFewForHighPersistence, TEST_CONFIG),
        TEST_CONFIG,
      ).some((warning) => warning.category === "persistent_high"),
    );
  });

  await t.test("configures thresholds from environment with safe defaults", () => {
    const defaults = getTrendConfig({});
    assert.equal(defaults.shortWindow, 3);
    assert.equal(defaults.persistentHighThreshold, 70);
    assert.equal(defaults.spikeIncreaseThreshold, 20);
    const configured = getTrendConfig({
      TREND_SHORT_WINDOW: "4",
      TREND_LONG_WINDOW: "8",
      TREND_PERSISTENT_HIGH_SCORE: "75",
      WARNING_MODERATE_COUNT: "4",
    });
    assert.equal(configured.shortWindow, 4);
    assert.equal(configured.longWindow, 8);
    assert.equal(configured.persistentHighThreshold, 75);
    assert.equal(configured.moderateObservationThreshold, 4);
    const customRiskBands = getTrendConfig({
      RISK_LOW_THRESHOLD: "25",
      RISK_MODERATE_THRESHOLD: "45",
      RISK_HIGH_THRESHOLD: "65",
      RISK_CRITICAL_THRESHOLD: "85",
    });
    assert.equal(classifyRisk(24), "LOW");
    assert.equal(classifyRisk(25, customRiskBands), "LOW");
    assert.equal(classifyRisk(65, customRiskBands), "HIGH");
    assert.equal(classifyRisk(85, customRiskBands), "CRITICAL");
  });

  await t.test("deduplicates, acknowledges, resolves, and persists warnings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-warning-test-"));
    const databasePath = path.join(directory, "warnings.db");
    process.env.VISION_OPS_DB_PATH = databasePath;
    try {
      const database = initializeDatabase();
      const machine = registerMachine(database, {
        cameraId: "warning-test-camera",
        label: "Warning test fixture",
        machineType: "3d_printer",
      });
      const candidate = {
        category: "gradual_increase",
        severity: "MODERATE",
        explanation: "Fixture-only early warning.",
        supporting_evidence: [{ id: "fixture-1", abnormality_score: 50 }],
        first_detected_at: "2026-11-06T01:00:00.000Z",
        latest_detected_at: "2026-11-06T02:00:00.000Z",
        recommended_action: "Fixture-only recommendation.",
      };
      const created = upsertEarlyWarning(database, machine.id, candidate);
      const deduplicated = upsertEarlyWarning(database, machine.id, {
        ...candidate,
        explanation: "Updated fixture evidence.",
        first_detected_at: "2026-11-06T03:00:00.000Z",
      });
      assert.equal(created.created, true);
      assert.equal(deduplicated.created, false);
      assert.equal(deduplicated.warning.id, created.warning.id);
      assert.equal(deduplicated.warning.explanation, "Updated fixture evidence.");
      assert.equal(
        deduplicated.warning.supporting_evidence.first_detected_at,
        candidate.first_detected_at,
      );
      assert.equal(listMachineWarnings(database, machine.id).length, 1);

      const acknowledged = transitionWarning(database, created.warning.id, "acknowledge", "checked");
      assert.equal(acknowledged.warning.state, "ACKNOWLEDGED");
      assert.ok(acknowledged.warning.acknowledged_at);
      assert.equal(transitionWarning(database, created.warning.id, "acknowledge").changed, false);

      closeDatabase();
      const reopened = initializeDatabase();
      assert.equal(listMachineWarnings(reopened, machine.id)[0].state, "ACKNOWLEDGED");
      const resolved = transitionWarning(reopened, created.warning.id, "resolve", "action complete");
      assert.equal(resolved.warning.state, "RESOLVED");
      assert.ok(resolved.warning.resolved_at);
      assert.equal(listMachineWarnings(reopened, machine.id).length, 0);
      assert.equal(transitionWarning(reopened, created.warning.id, "resolve").changed, false);
      assert.equal(transitionWarning(reopened, created.warning.id, "acknowledge").conflict, true);
    } finally {
      closeDatabase();
      delete process.env.VISION_OPS_DB_PATH;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("additive migrations preserve Phase 1 records and schema", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-migration-test-"));
    const migrationsPath = path.join(directory, "migrations");
    fs.mkdirSync(migrationsPath);
    const root = path.resolve("migrations");
    for (const filename of ["001_initial_trend_schema.sql", "002_persistent_analysis_history.sql"]) {
      fs.copyFileSync(path.join(root, filename), path.join(migrationsPath, filename));
    }
    const database = new Database(path.join(directory, "migration.db"));
    try {
      runMigrations(database, migrationsPath);
      const now = new Date().toISOString();
      database
        .prepare("INSERT INTO machines (id, label, machine_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("migration-fixture-machine", "Migration fixture", "3d_printer", now, now);
      database
        .prepare(`
          INSERT INTO analysis_records (
            id, machine_id, timestamp, is_valid, abnormality_score, confidence,
            severity, created_at, machine_type, machine_status, analysis_status,
            failure_type, is_uncertain
          ) VALUES (?, ?, ?, 1, 21, 0.9, 2, ?, '3d_printer', 'printing', 'normal', 'none', 0)
        `)
        .run("migration-fixture-record", "migration-fixture-machine", now, now);

      fs.copyFileSync(
        path.resolve("migrations", "003_persistent_early_warnings.sql"),
        path.join(migrationsPath, "003_persistent_early_warnings.sql"),
      );
      runMigrations(database, migrationsPath);
      fs.copyFileSync(
        path.resolve("migrations", "004_jobs_and_gcode.sql"),
        path.join(migrationsPath, "004_jobs_and_gcode.sql"),
      );
      runMigrations(database, migrationsPath);
      fs.copyFileSync(
        path.resolve("migrations", "005_job_analysis_link.sql"),
        path.join(migrationsPath, "005_job_analysis_link.sql"),
      );
      runMigrations(database, migrationsPath);
      fs.copyFileSync(
        path.resolve("migrations", "006_job_deviations.sql"),
        path.join(migrationsPath, "006_job_deviations.sql"),
      );
      runMigrations(database, migrationsPath);
      database.prepare(`
        INSERT INTO jobs (id, name, machine_id, machine_type, job_type, created_at, updated_at)
        VALUES ('migration-fixture-job', 'Migration fixture job', 'migration-fixture-machine',
                '3d_printer', 'FDM', ?, ?)
      `).run(now, now);
      database.prepare(`
        INSERT INTO job_deviations (
          id, job_id, machine_id, category, severity, explanation, expected_behavior,
          observed_behavior, evidence, recommended_action, first_detected_at,
          latest_detected_at, state, created_at, updated_at
        ) VALUES (
          'migration-fixture-deviation', 'migration-fixture-job', 'migration-fixture-machine',
          'REPEATED_FAILURE_FIXTURE', 'MODERATE', 'preserve this finding', 'expected',
          'observed', '{}', 'inspect', ?, ?, 'ACTIVE', ?, ?
        )
      `).run(now, now, now, now);
      fs.copyFileSync(
        path.resolve("migrations", "007_job_intelligence_lifecycle.sql"),
        path.join(migrationsPath, "007_job_intelligence_lifecycle.sql"),
      );
      runMigrations(database, migrationsPath);
      fs.copyFileSync(
        path.resolve("migrations", "008_sensor_intelligence.sql"),
        path.join(migrationsPath, "008_sensor_intelligence.sql"),
      );
      runMigrations(database, migrationsPath);
      assert.equal(
        database.prepare("SELECT abnormality_score FROM analysis_records WHERE id = ?").get("migration-fixture-record").abnormality_score,
        21,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
        8,
      );
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("early_warnings"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("jobs"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("job_deviations"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("sensors"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("sensor_readings"));
      assert.equal(database.prepare("SELECT job_id FROM analysis_records WHERE id = ?").get("migration-fixture-record").job_id, null);
      const migratedDeviation = database.prepare(
        "SELECT id, state, explanation, evidence FROM job_deviations WHERE id = ?",
      ).get("migration-fixture-deviation");
      assert.deepEqual(migratedDeviation, {
        id: "migration-fixture-deviation",
        state: "ACTIVE",
        explanation: "preserve this finding",
        evidence: "{}",
      });
      assert.equal(runMigrations(database, migrationsPath).length, 8);
    } finally {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("history access excludes invalid rows and records warning category recurrence", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-trend-repo-"));
    process.env.VISION_OPS_DB_PATH = path.join(directory, "trend.db");
    try {
      const database = initializeDatabase();
      const machine = registerMachine(database, {
        cameraId: "trend-record-camera",
        label: "Trend fixture",
        machineType: "cnc",
      });
      const valid = persistValidAnalysis(database, {
        machineId: machine.id,
        machineType: "cnc",
        result: {
          severity: 3,
          confidence: 0.9,
          status: "normal",
          machine_status: "printing",
          failure_type: "chatter",
          scene_state: "printing_normally",
        },
      });
      persistInvalidAnalysis(database, {
        machineId: machine.id,
        machineType: "cnc",
        reason: "fixture outage",
        provider: "test",
        errorCategory: "test_only",
      });
      const result = getValidTrendRecords(database, machine.id);
      assert.equal(result.length, 1);
      assert.equal(result[0].id, valid.id);
    } finally {
      closeDatabase();
      delete process.env.VISION_OPS_DB_PATH;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("serves trend and warnings APIs and broadcasts warning state changes", async (tContext) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase2-api-"));
    const originalDatabasePath = process.env.VISION_OPS_DB_PATH;
    const originalProvider = process.env.AI_PROVIDER;
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const originalDiscordWebhook = process.env.DISCORD_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    process.env.VISION_OPS_DB_PATH = path.join(directory, "api.db");
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "phase2-test-key";
    process.env.DISCORD_WEBHOOK_URL = "";
    let server;
    let socket;
    let machine;
    let mockProviderFailure = false;
    const aiResult = {
      status: "normal",
      severity: 2,
      confidence: 0.9,
      failure_type: "none",
      machine_status: "printing",
      scene_state: "printing_normally",
      material_pattern: "intentional_solid_geometry",
      attachment_state: "attached_flat",
      build_plate_visible: true,
      printed_part_visible: true,
      failed_material_visible: false,
    };
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://openrouter.ai/")) {
        return mockProviderFailure
          ? apiResponse("Provider unavailable in test fixture", 500)
          : apiResponse(aiResult);
      }
      const parsed = new URL(String(url), "http://localhost");
      if (["localhost", "127.0.0.1"].includes(parsed.hostname)) return originalFetch(url, options);
      throw new Error(`Unexpected external network request in Phase 2 test: ${url}`);
    };
    try {
      const database = initializeDatabase();
      machine = registerMachine(database, {
        cameraId: "phase2-api-camera",
        label: "Phase 2 API fixture",
        machineType: "3d_printer",
      });
      const createdAt = new Date(Date.now() - 6 * 3_600_000);
      const insert = database.prepare(`
        INSERT INTO analysis_records (
          id, machine_id, timestamp, is_valid, abnormality_score, confidence,
          severity, created_at, machine_type, machine_status, analysis_status,
          failure_type, is_uncertain
        ) VALUES (?, ?, ?, 1, ?, 0.9, 2, ?, '3d_printer', 'printing', 'normal', 'none', 0)
      `);
      for (const [index, score] of [0, 5, 10, 15, 20, 25].entries()) {
        const time = new Date(createdAt.getTime() + index * 3_600_000).toISOString();
        insert.run(`api-record-${index}`, machine.id, time, score, time);
      }

      const serverModule = await import("../server.mjs");
      server = await serverModule.startServer({ listenPort: 0 });
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const machineListResponse = await fetch(`${base}/api/machines`);
      const machineList = await machineListResponse.json();
      assert.equal(machineListResponse.status, 200);
      assert.ok(machineList.machines.some((item) =>
        item.id === machine.id && item.camera_ids.includes("phase2-api-camera"),
      ));
      const trendResponse = await fetch(`${base}/api/machines/${machine.id}/trend`);
      const trend = await trendResponse.json();
      assert.equal(trendResponse.status, 200);
      assert.equal(trend.valid_observations, 6);
      assert.equal(trend.trend_classification, "RAPIDLY_RISING");
      assert.equal(typeof trend.moving_average, "number");
      assert.equal(trend.slope_unit, "abnormality_points_per_hour");
      assert.equal(trend.minimum_observations, 5);
      assert.deepEqual(trend.risk_thresholds, { warning: 60, critical: 80 });

      const invalid = await fetch(`${base}/api/machines/not-a-uuid/trend`);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "invalid_machine_id");
      const missing = await fetch(
        `${base}/api/machines/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/early-warnings`,
      );
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "machine_not_found");

      socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      const helloMessage = waitForSocketMessage(socket, "hello");
      await once(socket, "open");
      await helloMessage;
      const earlyWarningMessage = waitForSocketMessage(socket, "early_warning");
      const trendUpdateMessage = waitForSocketMessage(socket, "trend_update");
      const analysisResponse = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase2-api-camera",
          cameraLabel: "Phase 2 API fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(analysisResponse.status, 200);
      const earlyWarning = await earlyWarningMessage;
      const trendUpdate = await trendUpdateMessage;
      assert.equal(trendUpdate.machineId, machine.id);
      assert.equal(trendUpdate.trend.trend_classification, "RISING");
      assert.equal(earlyWarning.machineId, machine.id);
      assert.equal(earlyWarning.warning.state, "ACTIVE");
      assert.ok(earlyWarning.warning.reason.includes("Early Warning"));

      const warningsResponse = await fetch(`${base}/api/machines/${machine.id}/early-warnings`);
      const warnings = await warningsResponse.json();
      assert.equal(warningsResponse.status, 200);
      assert.ok(warnings.warnings.length >= 1);
      const warningId = earlyWarning.warning.id;
      const acknowledgedEvent = waitForSocketMessage(socket, "warning_acknowledged");
      const acknowledgeResponse = await fetch(`${base}/api/warnings/${warningId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Inspected fixture." }),
      });
      assert.equal(acknowledgeResponse.status, 200);
      assert.equal((await acknowledgedEvent).warning.state, "ACKNOWLEDGED");

      const resolvedEvent = waitForSocketMessage(socket, "warning_resolved");
      const resolveResponse = await fetch(`${base}/api/warnings/${warningId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Resolved fixture." }),
      });
      assert.equal(resolveResponse.status, 200);
      assert.equal((await resolvedEvent).warning.state, "RESOLVED");
      const activeWarnings = await (await fetch(`${base}/api/machines/${machine.id}/early-warnings`)).json();
      assert.ok(!activeWarnings.warnings.some((warning) => warning.id === warningId));

      mockProviderFailure = true;
      const failedAnalysis = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase2-api-camera",
          cameraLabel: "Phase 2 API fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(failedAnalysis.status, 500);
      const trendDuringOutageResponse = await fetch(`${base}/api/machines/${machine.id}/trend`);
      const trendDuringOutage = await trendDuringOutageResponse.json();
      assert.equal(trendDuringOutageResponse.status, 200);
      assert.equal(trendDuringOutage.valid_observations, 7);
      const historyDuringOutage = await fetch(`${base}/api/machines/${machine.id}/history?limit=200`);
      assert.equal((await historyDuringOutage.json()).records.length, 7);

      await tContext.test("endpoint pagination remains available", async () => {
        const history = await fetch(`${base}/api/machines/${machine.id}/history?limit=1`);
        assert.equal(history.status, 200);
        assert.equal((await history.json()).records.length, 1);
      });
    } finally {
      if (socket) {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      }
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      closeDatabase();
      globalThis.fetch = originalFetch;
      if (originalDatabasePath === undefined) delete process.env.VISION_OPS_DB_PATH;
      else process.env.VISION_OPS_DB_PATH = originalDatabasePath;
      if (originalProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = originalProvider;
      if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      if (originalDiscordWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = originalDiscordWebhook;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
