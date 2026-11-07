import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.mjs";
import { persistValidAnalysis, registerMachine } from "../db/repository.mjs";
import { createSensor, insertSensorReading } from "../sensors/repository.mjs";
import { createCopilotRouter } from "../ai/copilot.mjs";
import { buildCopilotContext } from "../ai/copilot-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startCopilotServer(database, options = {}) {
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  app.use("/api/copilot", createCopilotRouter({
    databaseProvider: () => database,
    complete: options.complete || (async () => "Evidence is limited; inspect the latest persisted readings before acting."),
    getProviderState: options.getProviderState || (() => ({
      providerName: "Groq",
      model: "test-model",
      hasApiKey: true,
      secrets: ["test-secret-key"],
    })),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/copilot`,
  };
}

async function request(baseUrl, route, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

test("Manufacturing Copilot stores scoped conversations and answers from labeled persisted evidence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-copilot-"));
  const database = new Database(path.join(directory, "copilot.test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, path.join(root, "migrations"));
  const machine = registerMachine(database, {
    cameraId: "copilot-test-camera",
    label: "Copilot Test Printer",
    machineType: "3d_printer",
  });
  const timestamp = new Date().toISOString();
  const analysis = persistValidAnalysis(database, {
    machineId: machine.id,
    machineType: "3d_printer",
    timestamp,
    result: {
      status: "warning",
      machine_status: "needs_attention",
      failure_type: "spaghetti",
      severity: 8,
      confidence: 0.91,
      scene_state: "printing",
    },
  });
  const sensor = createSensor(database, machine.id, {
    name: "Virtual temperature",
    type: "TEMPERATURE",
    adapterType: "USB",
    provenance: "SIMULATED",
    unit: "°C",
    calibrationDueAt: null,
  }).sensor;
  insertSensorReading(database, sensor, {
    observedAt: timestamp,
    value: 88,
    unit: "°C",
    eventType: "OVERHEATING",
    alarmDetected: true,
    details: {},
    sourceEventId: "copilot-reading-1",
  });

  let capturedMessages = null;
  const { server, baseUrl } = await startCopilotServer(database, {
    complete: async (messages) => {
      capturedMessages = messages;
      if (messages.at(-1).content.toLowerCase().includes("maintenance report")) {
        return "Maintenance report: verify the camera observation and independently confirm the simulated temperature with a real sensor.";
      }
      return "The camera recorded a spaghetti warning. The 88 °C temperature value is SIMULATED, not a physical measurement.";
    },
  });
  t.after(() => {
    server.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const list = await request(baseUrl, "/conversations");
  const ownerCookie = cookieFrom(list.response);
  assert.match(ownerCookie, /^vision_ops_copilot_session=/);
  assert.match(list.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(list.response.headers.get("set-cookie"), /SameSite=Strict/);
  const machineCountBefore = database.prepare("SELECT COUNT(*) AS count FROM machines").get().count;
  const analysisCountBefore = database.prepare("SELECT COUNT(*) AS count FROM analysis_records").get().count;
  const sensorCountBefore = database.prepare("SELECT COUNT(*) AS count FROM sensors").get().count;
  const healthEventsBefore = database.prepare("SELECT COUNT(*) AS count FROM sensor_health_events").get().count;

  const chat = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: { message: "Show the latest sensor readings and camera evidence.", machine_id: machine.id },
  });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.data.message.role, "assistant");
  assert.match(chat.data.message.content, /SIMULATED/);
  assert.ok(chat.data.message.evidence_refs.some((item) => item.type === "camera_analysis" && item.id === analysis.id));
  assert.ok(chat.data.message.evidence_refs.some((item) =>
    item.type === "sensor_reading" && item.provenance === "SIMULATED",
  ));
  const systemMessage = capturedMessages.find((item) => item.role === "system").content;
  assert.match(systemMessage, /"provenance":"SIMULATED"/);
  assert.match(systemMessage, /"provenance":"REAL"/);
  assert.match(systemMessage, /G-code describe operator intent/);
  assert.match(systemMessage, /not normal/);

  const loaded = await request(baseUrl, `/conversations/${chat.data.conversation_id}`, { cookie: ownerCookie });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.conversation.messages.length, 2);
  assert.equal(loaded.data.conversation.owner_id, undefined);
  assert.equal(loaded.data.conversation.messages[0].role, "user");
  assert.equal(loaded.data.conversation.messages[1].role, "assistant");

  const report = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      conversation_id: chat.data.conversation_id,
      machine_id: machine.id,
      message: "Generate a maintenance report from the latest camera evidence and sensor readings.",
    },
  });
  assert.equal(report.response.status, 200);
  assert.match(report.data.message.content, /Maintenance report/);
  assert.ok(report.data.message.evidence_refs.length > 0);

  const otherBrowser = await request(baseUrl, `/conversations/${chat.data.conversation_id}`);
  const otherCookie = cookieFrom(otherBrowser.response);
  assert.notEqual(otherCookie, ownerCookie);
  assert.equal(otherBrowser.response.status, 404);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM machines").get().count, machineCountBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM analysis_records").get().count, analysisCountBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensors").get().count, sensorCountBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_health_events").get().count, healthEventsBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);

  const empty = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: { message: "  " },
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.data.error.code, "empty_message");
  const oversized = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: { message: "x".repeat(2001) },
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.data.error.code, "message_too_large");
  const invalidMachine = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: { message: "Status?", machine_id: "not-a-uuid" },
  });
  assert.equal(invalidMachine.response.status, 400);
  const unknownMachine = await request(baseUrl, "/chat", {
    method: "POST",
    cookie: ownerCookie,
    body: { message: "Unknown machine?", machine_id: "5d37afac-e38a-43fd-920f-4f6655f8ac80" },
  });
  assert.equal(unknownMachine.response.status, 404);
  assert.equal(unknownMachine.data.error.code, "machine_not_found");

  const cleared = await request(baseUrl, `/conversations/${chat.data.conversation_id}/messages`, {
    method: "DELETE",
    cookie: ownerCookie,
  });
  assert.equal(cleared.data.cleared, true);
  const afterClear = await request(baseUrl, `/conversations/${chat.data.conversation_id}`, { cookie: ownerCookie });
  assert.deepEqual(afterClear.data.conversation.messages, []);
  const deleted = await request(baseUrl, `/conversations/${chat.data.conversation_id}`, {
    method: "DELETE",
    cookie: ownerCookie,
  });
  assert.equal(deleted.data.deleted, true);
  const afterDelete = await request(baseUrl, `/conversations/${chat.data.conversation_id}`, { cookie: ownerCookie });
  assert.equal(afterDelete.response.status, 404);
});

test("Copilot context preserves unknown and stale sensor health without writing health events", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-copilot-context-"));
  const database = new Database(path.join(directory, "copilot-context.test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, path.join(root, "migrations"));
  const machine = registerMachine(database, {
    cameraId: "copilot-context-camera",
    label: "Context Test Printer",
    machineType: "3d_printer",
  });
  const unknown = createSensor(database, machine.id, {
    name: "Unreported real temperature",
    type: "TEMPERATURE",
    adapterType: "USB",
    provenance: "REAL",
    unit: "°C",
    calibrationDueAt: null,
  }).sensor;
  const stale = createSensor(database, machine.id, {
    name: "Stale virtual vibration",
    type: "VIBRATION",
    adapterType: "USB",
    provenance: "SIMULATED",
    unit: "g",
    calibrationDueAt: null,
  }).sensor;
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
  insertSensorReading(database, stale, {
    observedAt: oldTimestamp,
    value: 0.9,
    unit: "g",
    eventType: null,
    alarmDetected: null,
    details: {},
    sourceEventId: "copilot-stale-reading",
  });
  database.prepare("UPDATE sensors SET last_seen_at = ?, last_reading_at = ? WHERE id = ?")
    .run(oldTimestamp, oldTimestamp, stale.id);
  const healthEventsBefore = database.prepare("SELECT COUNT(*) AS count FROM sensor_health_events").get().count;

  try {
    const result = buildCopilotContext(database, {
      question: "Show sensor health and the latest readings.",
      machineId: machine.id,
    });
    const sensors = result.context.sources[0].sensors;
    const unknownContext = sensors.find((item) => item.id === unknown.id);
    const staleContext = sensors.find((item) => item.id === stale.id);
    assert.equal(unknownContext.status, "UNKNOWN");
    assert.equal(unknownContext.reading, null);
    assert.equal(staleContext.status, "STALE");
    assert.equal(staleContext.reading.provenance, "SIMULATED");
    assert.equal(result.references.find((item) => item.id === stale.id).provenance, "SIMULATED");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sensor_health_events").get().count, healthEventsBefore);
    assert.throws(
      () => buildCopilotContext(database, {
        question: "Current health?",
        machineId: "5d37afac-e38a-43fd-920f-4f6655f8ac80",
      }),
      (error) => error.status === 404 && error.code === "machine_not_found",
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Manufacturing Copilot handles provider failures, missing keys, invalid responses, and abuse limits", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-copilot-errors-"));
  const database = new Database(path.join(directory, "copilot.test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, path.join(root, "migrations"));
  const machine = registerMachine(database, {
    cameraId: "copilot-error-camera",
    label: "Copilot Error Printer",
    machineType: "3d_printer",
  });
  let completion = async () => "There is not enough persisted evidence to establish a cause.";
  let hasApiKey = true;
  const { server, baseUrl } = await startCopilotServer(database, {
    complete: (...args) => completion(...args),
    getProviderState: () => ({
      providerName: "Groq",
      model: "test-model",
      hasApiKey,
      secrets: ["test-secret-key"],
    }),
  });
  t.after(() => {
    server.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const initial = await request(baseUrl, "/conversations");
  const cookie = cookieFrom(initial.response);
  const timeoutConversation = await request(baseUrl, "/conversations", {
    method: "POST",
    cookie,
    body: { title: "Timeout test", machine_id: machine.id },
  });
  completion = async () => {
    const error = new Error("The request timed out.");
    error.name = "AbortError";
    throw error;
  };
  const timeout = await request(baseUrl, "/chat", {
    method: "POST",
    cookie,
    body: { conversation_id: timeoutConversation.data.conversation.id, message: "Current health?" },
  });
  assert.equal(timeout.response.status, 502);
  assert.equal(timeout.data.error.code, "provider_timeout");
  const messagesAfterFailure = await request(
    baseUrl,
    `/conversations/${timeoutConversation.data.conversation.id}`,
    { cookie },
  );
  assert.deepEqual(messagesAfterFailure.data.conversation.messages, []);

  hasApiKey = false;
  const unavailable = await request(baseUrl, "/chat", {
    method: "POST",
    cookie,
    body: { conversation_id: timeoutConversation.data.conversation.id, message: "Try again?" },
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.data.error.code, "provider_configuration_error");

  hasApiKey = true;
  completion = async () => ({ unexpected: "object" });
  const invalidResponse = await request(baseUrl, "/chat", {
    method: "POST",
    cookie,
    body: { conversation_id: timeoutConversation.data.conversation.id, message: "Try a malformed response?" },
  });
  assert.equal(invalidResponse.response.status, 502);
  assert.equal(invalidResponse.data.error.code, "provider_invalid_response");

  completion = async () => "Evidence is insufficient to draw a conclusion.";
  let rateResponse;
  for (let index = 0; index < 13; index += 1) {
    rateResponse = await request(baseUrl, "/chat", {
      method: "POST",
      cookie,
      body: { conversation_id: timeoutConversation.data.conversation.id, message: `Rate test ${index}` },
    });
    if (rateResponse.response.status === 429) break;
  }
  assert.equal(rateResponse.response.status, 429);
  assert.equal(rateResponse.data.error.code, "copilot_rate_limited");
});
