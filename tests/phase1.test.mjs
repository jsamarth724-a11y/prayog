import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase, initializeDatabase } from "../db/database.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  calculateAbnormality,
  classifyRisk,
  getValidAnalysisHistory,
  persistInvalidAnalysis,
  persistValidAnalysis,
  registerMachine,
} from "../db/repository.mjs";

const analysisResult = {
  status: "normal",
  severity: 2,
  confidence: 0.9,
  failure_type: "none",
  machine_status: "printing",
  scene_state: "printing_normally",
};

function openRouterResponse(content, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }
        : { error: { message: String(content) } },
    ),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

test("Phase 1 SQLite history and API integration", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase1-"));
  const databasePath = path.join(temporaryDirectory, "phase1.test.db");
  const originalEnvironment = {
    VISION_OPS_DB_PATH: process.env.VISION_OPS_DB_PATH,
    AI_PROVIDER: process.env.AI_PROVIDER,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  };
  const originalFetch = globalThis.fetch;
  let mockContent = analysisResult;
  let mockStatus = 200;
  let aiRequestCount = 0;
  process.env.VISION_OPS_DB_PATH = databasePath;
  process.env.AI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.DISCORD_WEBHOOK_URL = "";
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://openrouter.ai/")) {
      aiRequestCount += 1;
      return openRouterResponse(mockContent, mockStatus);
    }
    const target = new URL(String(url), "http://localhost");
    if (["localhost", "127.0.0.1"].includes(target.hostname)) {
      return originalFetch(url, options);
    }
    throw new Error(`Unexpected external network request in test: ${url}`);
  };

  let server;
  try {
    const database = initializeDatabase();

    await t.test("initializes tables, foreign keys, WAL, and migrations idempotently", () => {
      assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("analysis_records"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("machine_cameras"));
      const appliedMigrations = runMigrations(database);
      assert.equal(appliedMigrations.length, 11);
      assert.ok(appliedMigrations.some(({ filename }) => filename === "011_product_quality_inspections.sql"));
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("product_quality_inspections"));
      assert.equal(runMigrations(database).length, 11);
    });

    await t.test("persists analysis fields and deterministic uncertainty-aware score", () => {
      const machine = registerMachine(database, {
        cameraId: "unit-camera",
        label: "Unit Camera",
        machineType: "3d_printer",
      });
      const saved = persistValidAnalysis(database, {
        machineId: machine.id,
        machineType: "3d_printer",
        result: analysisResult,
        timestamp: "2026-11-06T10:00:00.000Z",
      });
      assert.equal(saved.abnormality_score, 22);
      assert.equal(saved.risk_classification, "LOW");
      const record = database.prepare("SELECT * FROM analysis_records WHERE id = ?").get(saved.id);
      assert.equal(record.machine_id, machine.id);
      assert.equal(record.is_valid, 1);
      assert.equal(record.machine_status, "printing");
      assert.equal(record.analysis_status, "normal");
      assert.equal(record.failure_type, "none");
      assert.equal(record.severity, 2);
      assert.equal(record.confidence, 0.9);
      assert.equal(record.abnormality_score, 22);
      assert.equal(record.is_uncertain, 0);
    });

    await t.test("applies risk bands and retains a meaningful score at low confidence", () => {
      assert.deepEqual(
        [0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(classifyRisk),
        ["NORMAL", "NORMAL", "LOW", "LOW", "MODERATE", "MODERATE", "HIGH", "HIGH", "CRITICAL", "CRITICAL"],
      );
      assert.deepEqual(
        calculateAbnormality({
          severity: 8,
          confidence: 0.2,
          status: "failure",
          machine_status: "needs_attention",
        }),
        { abnormality_score: 60, is_uncertain: true, risk_classification: "HIGH" },
      );
    });

    await t.test("persists invalid attempts without scores and excludes them from valid history", () => {
      const machine = registerMachine(database, {
        cameraId: "audit-camera",
        label: "Audit Camera",
        machineType: "cnc",
      });
      const invalid = persistInvalidAnalysis(database, {
        machineId: machine.id,
        machineType: "cnc",
        reason: "provider timed out",
        provider: "openrouter",
        errorCategory: "provider_timeout",
        cameraId: "audit-camera",
      });
      const record = database.prepare("SELECT * FROM analysis_records WHERE id = ?").get(invalid.id);
      assert.equal(record.is_valid, 0);
      assert.equal(record.abnormality_score, null);
      assert.equal(record.invalid_reason, "provider timed out");
      assert.throws(
        () =>
          database
            .prepare("UPDATE analysis_records SET abnormality_score = ? WHERE id = ?")
            .run(91, invalid.id),
        /CHECK constraint failed/,
      );
      assert.equal(
        getValidAnalysisHistory(database, machine.id, { limit: 50, offset: 0 }).length,
        0,
      );
    });

    await t.test("registers an unknown camera separately and reuses a known UUID", () => {
      const first = registerMachine(database, {
        cameraId: "stable-camera",
        label: "Printer A",
        machineType: "3d_printer",
      });
      const repeated = registerMachine(database, {
        cameraId: "stable-camera",
        label: "Renamed Printer A",
        machineType: "3d_printer",
      });
      const changed = registerMachine(database, {
        cameraId: "changed-camera",
        label: "Renamed Printer A",
        machineType: "3d_printer",
      });
      const unlinked = registerMachine(database, {
        cameraId: null,
        label: "Unlinked camera",
        machineType: "3d_printer",
      });
      const otherUnlinked = registerMachine(database, {
        cameraId: null,
        label: "Unlinked camera",
        machineType: "3d_printer",
      });
      assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(repeated.id, first.id);
      assert.notEqual(changed.id, first.id);
      assert.notEqual(unlinked.id, otherUnlinked.id);
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM machine_cameras WHERE machine_id IN (?, ?)")
          .get(unlinked.id, otherUnlinked.id).count,
        0,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM machines").get().count, 6);
    });

    const serverModule = await import("../server.mjs");
    server = await serverModule.startServer({ listenPort: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await t.test("retains the existing success response contract and saves valid frames", async () => {
      const response = await fetch(`${baseUrl}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          machineType: "3d_printer",
          cameraId: "api-camera",
          cameraLabel: "API Printer",
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      for (const key of [
        "status",
        "severity",
        "confidence",
        "machine_status",
        "confirmation_streak",
        "confirmation_target",
        "confirmed_failure",
        "newly_confirmed",
        "newly_recovered",
        "latency_ms",
        "camera_id",
      ]) {
        assert.ok(Object.hasOwn(payload, key), `Missing legacy response field: ${key}`);
      }
      assert.equal(payload.camera_id, "api-camera");
      assert.match(payload.machine_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(Object.hasOwn(payload, "abnormality_score"), false);
      assert.equal(aiRequestCount, 1);
    });

    const apiMachineId = database
      .prepare("SELECT machine_id FROM machine_cameras WHERE camera_id = ?")
      .get("api-camera").machine_id;

    await t.test("validates and paginates history, returning only valid records", async () => {
      const history = await fetch(`${baseUrl}/api/machines/${apiMachineId}/history?limit=1&offset=0`);
      const payload = await history.json();
      assert.equal(history.status, 200);
      assert.equal(payload.records.length, 1);
      assert.equal(payload.records[0].is_valid, 1);
      assert.equal(payload.records[0].machine_id, apiMachineId);
      assert.equal(payload.limit, 1);
      assert.equal(payload.offset, 0);

      const malformed = await fetch(`${baseUrl}/api/machines/not-a-uuid/history`);
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, "invalid_machine_id");

      const missing = await fetch(
        `${baseUrl}/api/machines/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/history`,
      );
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "machine_not_found");
    });

    await t.test("audits invalid camera input and malformed AI responses", async () => {
      const invalidInput = await fetch(`${baseUrl}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: "api-camera", currentImageDataUrl: "invalid" }),
      });
      assert.equal(invalidInput.status, 400);

      mockContent = "not JSON";
      const malformedAi = await fetch(`${baseUrl}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "api-camera",
        }),
      });
      assert.equal(malformedAi.status, 502);
      assert.equal((await malformedAi.json()).code, "invalid_json");
      assert.equal(aiRequestCount, 3);

      const records = database
        .prepare(`
          SELECT is_valid, invalid_reason, abnormality_score, error_category, provider
          FROM analysis_records
          WHERE machine_id = ? AND is_valid = 0
          ORDER BY created_at DESC
        `)
        .all(apiMachineId);
      assert.equal(records.length, 2);
      assert.ok(records.every((record) => record.is_valid === 0 && record.abnormality_score === null));
      assert.ok(records.some((record) => record.error_category === "invalid_camera_input"));
      assert.ok(records.some((record) => record.error_category === "malformed_response"));
      assert.ok(records.every((record) => record.provider === "openrouter"));

      mockStatus = 503;
      const providerFailure = await fetch(`${baseUrl}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "api-camera",
        }),
      });
      assert.equal(providerFailure.status, 503);
      mockStatus = 200;
      const latestInvalid = database
        .prepare("SELECT is_valid, abnormality_score, error_category FROM analysis_records WHERE machine_id = ? AND is_valid = 0 ORDER BY created_at DESC LIMIT 1")
        .get(apiMachineId);
      assert.equal(latestInvalid.abnormality_score, null);
      assert.equal(latestInvalid.error_category, "provider_unavailable");
    });

    await t.test("keeps history and camera identity after server and database restart", async () => {
      const firstIdentity = database
        .prepare("SELECT machine_id FROM machine_cameras WHERE camera_id = ?")
        .get("api-camera").machine_id;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server = null;
      closeDatabase();
      const reopenedDatabase = initializeDatabase();
      const secondIdentity = registerMachine(reopenedDatabase, {
        cameraId: "api-camera",
        label: "API Printer",
        machineType: "3d_printer",
      });
      assert.equal(secondIdentity.id, firstIdentity);
      assert.equal(
        getValidAnalysisHistory(reopenedDatabase, firstIdentity, { limit: 50, offset: 0 }).length,
        1,
      );

      server = await serverModule.startServer({ listenPort: 0 });
      if (!server.listening) await once(server, "listening");
      const restartedResponse = await fetch(
        `http://127.0.0.1:${server.address().port}/api/machines/${firstIdentity}/history`,
      );
      assert.equal(restartedResponse.status, 200);
      assert.equal((await restartedResponse.json()).records.length, 1);
    });
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase();
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
