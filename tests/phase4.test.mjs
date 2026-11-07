import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { closeDatabase, initializeDatabase } from "../db/database.mjs";
import { registerMachine } from "../db/repository.mjs";
import { parseGcode, validateGcodeFilename } from "../jobs/gcode.mjs";
import {
  detectJobDeviations,
  persistJobDeviations,
} from "../jobs/insights.mjs";
import {
  compareJobEvidence,
  evaluateCompletionVerification,
  listDeviationLifecycleEvents,
  transitionDeviation,
} from "../jobs/intelligence.mjs";
import { validateRootCauseResponse } from "../jobs/root-cause.mjs";

function providerResponse(content, status = 200) {
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

test("Phase 4 job registration and safe G-code ingestion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionops-phase4-"));
  const databasePath = path.join(directory, "phase4.test.db");
  const previousEnvironment = {
    VISION_OPS_DB_PATH: process.env.VISION_OPS_DB_PATH,
    AI_PROVIDER: process.env.AI_PROVIDER,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  };
  const originalFetch = globalThis.fetch;
  process.env.VISION_OPS_DB_PATH = databasePath;
  process.env.AI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "phase4-test-key";
  process.env.DISCORD_WEBHOOK_URL = "";
  let server = null;
  let socket = null;
  let mockProviderFailure = false;
  let mockRootCauseFailure = false;
  let mockRootCauseResult = null;
  let rootCauseCalls = 0;
  let mockProviderResult = {
    status: "normal",
    severity: 1,
    confidence: 0.9,
    failure_type: "none",
    scene_state: "printing_normally",
    material_pattern: "intentional_solid_geometry",
    attachment_state: "attached_flat",
    build_plate_visible: true,
    printed_part_visible: true,
    failed_material_visible: false,
  };
  let capturedProviderRequest = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://openrouter.ai/")) {
      capturedProviderRequest = JSON.parse(options.body);
      if (JSON.stringify(capturedProviderRequest.messages).includes("ROOT_CAUSE_REPORT")) {
        rootCauseCalls += 1;
        if (mockRootCauseFailure) return providerResponse("Root cause provider unavailable", 503);
        return providerResponse(mockRootCauseResult);
      }
      return mockProviderFailure
        ? providerResponse("Provider unavailable in test fixture", 503)
        : providerResponse(mockProviderResult);
    }
    const target = new URL(String(url), "http://localhost");
    if (["localhost", "127.0.0.1"].includes(target.hostname)) return originalFetch(url, options);
    throw new Error(`Unexpected external network request in Phase 4 test: ${url}`);
  };

  try {
    const database = initializeDatabase();
    const printer = registerMachine(database, {
      cameraId: "phase4-printer-camera",
      label: "Phase 4 printer fixture",
      machineType: "3d_printer",
    });
    const cnc = registerMachine(database, {
      cameraId: "phase4-cnc-camera",
      label: "Phase 4 CNC fixture",
      machineType: "cnc",
    });
    await t.test("parses supported dialect signals without executing commands", () => {
      const printerSummary = parseGcode(
        [
          ";LAYER:0",
          "; layer_height = 0.2",
          ";TIME:3600",
          "M104 S210",
          "M140 S60",
          "G28",
          "G1 X0 Y0 F1200",
          "G1 X1 Y2 E0.5",
          "G1 E-1",
          "M30",
        ].join("\n"),
        "3d_printer",
      );
      assert.equal(printerSummary.movement_command_count, 3);
      assert.equal(printerSummary.layer_marker_count, 1);
      assert.equal(printerSummary.layer_height_mm, 0.2);
      assert.deepEqual(printerSummary.nozzle_temperature_targets_c, [210]);
      assert.deepEqual(printerSummary.bed_temperature_targets_c, [60]);
      assert.equal(printerSummary.slicer_estimated_duration_seconds, 3600);
      assert.equal(printerSummary.physical_execution_verified, false);

      const cncSummary = parseGcode("T1 M6\nG0 X0 Y0\nM3 S12000\nG1 X20 F600\nM30", "cnc");
      assert.equal(cncSummary.tool_change_count, 1);
      assert.equal(cncSummary.spindle_command_count, 1);
      assert.equal(cncSummary.maximum_feed_rate, 600);
      assert.equal(cncSummary.layer_marker_count, null);

      const laserSummary = parseGcode("M4 S60\nG1 X10 Y10 F300\nM5\nM2", "laser_cutter");
      assert.equal(laserSummary.laser_power_command_count, 2);
      assert.equal(laserSummary.maximum_feed_rate, 300);
      assert.deepEqual(parseGcode("M999\nG0 X0", "cnc").operator_review_commands, ["M999"]);
    });

    await t.test("rejects malformed, empty, binary, oversized, and unsupported input safely", () => {
      assert.throws(() => parseGcode("", "3d_printer"), /empty/);
      assert.throws(() => parseGcode("; only a comment", "3d_printer"), /no parseable/);
      assert.throws(() => parseGcode("G1 X0 (missing close", "3d_printer"), /unterminated/);
      assert.throws(() => parseGcode("G1 X0\0Y0", "3d_printer"), /binary/);
      assert.throws(() => validateGcodeFilename("model.nc", "3d_printer"), /extension/);
      assert.throws(() => validateGcodeFilename("..\\model.gcode", "3d_printer"), /filename is invalid/);
      assert.equal(validateGcodeFilename("model.gcode", "3d_printer"), "model.gcode");
      assert.throws(() => parseGcode("G1 X0", "unsupported"), /Unsupported/);
    });

    const { startServer } = await import("../server.mjs");
    server = await startServer({ listenPort: 0 });
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const hello = waitForSocketMessage(socket, "hello");
    await once(socket, "open");
    await hello;

    await t.test("creates, uploads, lists, and transitions persisted jobs via API", async () => {
      const invalid = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bad machine", machine_id: "bad-id" }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "invalid_machine_id");

      const jobCreatedEvent = waitForSocketMessage(socket, "job_created");
      const created = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Fixture print",
          machine_id: printer.id,
          expected_duration_seconds: 3600,
          material_type: "PLA",
          expected_parameters: { nozzle_temperature_c: 210, bed_temperature_c: 60 },
          slicer_metadata: { slicer: "fixture", layer_height_mm: 0.2 },
        }),
      });
      assert.equal(created.status, 201);
      const job = (await created.json()).job;
      assert.equal(job.status, "DRAFT");
      assert.equal(job.machine_type, "3d_printer");
      assert.equal((await jobCreatedEvent).job.id, job.id);

      const gcode = [
        ";LAYER:0",
        "; layer_height = 0.2",
        ";TIME:3600",
        "M104 S210",
        "M140 S60",
        "G28",
        "G1 X0 Y0 F1200",
        "G1 X1 Y2 E0.5",
        "M30",
      ].join("\n");
      const uploaded = await fetch(
        `${base}/api/jobs/${job.id}/gcode?filename=${encodeURIComponent("fixture.gcode")}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: gcode,
        },
      );
      assert.equal(uploaded.status, 201);
      const uploadedJob = (await uploaded.json()).job;
      assert.equal(uploadedJob.file.filename, "fixture.gcode");
      assert.equal(uploadedJob.file.summary.layer_marker_count, 1);
      assert.equal(uploadedJob.file.size_bytes, Buffer.byteLength(gcode));
      assert.equal(JSON.stringify(uploadedJob).includes(gcode), false);

      const unsupported = await fetch(`${base}/api/jobs/${job.id}/gcode?filename=bad.exe`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "G1 X0",
      });
      assert.equal(unsupported.status, 400);
      const tooLarge = await fetch(`${base}/api/jobs/${job.id}/gcode?filename=large.gcode`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "x".repeat(2 * 1024 * 1024 + 1),
      });
      assert.equal(tooLarge.status, 413);

      const cncJobResponse = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Fixture milling",
          machine_id: cnc.id,
          expected_parameters: { spindle_speed_rpm: 12000, feed_rate_mm_min: 600, tool_identifier: "T1" },
        }),
      });
      assert.equal(cncJobResponse.status, 201);
      const cncJob = (await cncJobResponse.json()).job;
      const wrongParameter = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad CNC parameters",
          machine_id: cnc.id,
          expected_parameters: { nozzle_temperature_c: 210 },
        }),
      });
      assert.equal(wrongParameter.status, 400);
      assert.equal((await wrongParameter.json()).error.code, "invalid_job");
      const secondPrinterJobResponse = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Second printer job", machine_id: printer.id }),
      });
      assert.equal(secondPrinterJobResponse.status, 201);
      const secondPrinterJob = (await secondPrinterJobResponse.json()).job;

      const ready = await fetch(`${base}/api/jobs/${job.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "READY" }),
      });
      assert.equal(ready.status, 200);
      const startedEvent = waitForSocketMessage(socket, "job_started");
      const running = await fetch(`${base}/api/jobs/${job.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RUNNING" }),
      });
      assert.equal(running.status, 200);
      assert.equal((await startedEvent).job.status, "RUNNING");
      assert.ok((await running.json()).job.started_at);

      const secondReady = await fetch(`${base}/api/jobs/${secondPrinterJob.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "READY" }),
      });
      assert.equal(secondReady.status, 200);
      const blockedStart = await fetch(`${base}/api/jobs/${secondPrinterJob.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RUNNING" }),
      });
      assert.equal(blockedStart.status, 409);
      assert.equal((await blockedStart.json()).error.code, "machine_has_active_job");

      const analysisResponse = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(analysisResponse.status, 200);
      const analysisPayload = await analysisResponse.json();
      assert.equal(analysisPayload.job_id, job.id);
      const prompt = JSON.stringify(capturedProviderRequest.messages[0].content);
      assert.ok(prompt.includes("Fixture print"));
      assert.ok(prompt.includes("nozzle_temperature_c"));
      assert.equal(prompt.includes("G1 X1 Y2 E0.5"), false);
      const linkedRecord = database
        .prepare("SELECT job_id, is_valid FROM analysis_records WHERE machine_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(printer.id);
      assert.deepEqual(linkedRecord, { job_id: job.id, is_valid: 1 });
      const jobHistory = await fetch(`${base}/api/jobs/${job.id}/history`);
      assert.equal(jobHistory.status, 200);
      const jobHistoryBody = await jobHistory.json();
      assert.equal(jobHistoryBody.records.length, 1);
      assert.equal(jobHistoryBody.records[0].job_id, job.id);

      const initialComparisonEvent = waitForSocketMessage(socket, "job_comparison_updated");
      const initialComparisonResponse = await fetch(`${base}/api/jobs/${job.id}/comparison`, {
        method: "POST",
      });
      assert.equal(initialComparisonResponse.status, 201);
      const initialComparison = (await initialComparisonResponse.json()).comparison;
      assert.equal(initialComparison.classification, "NOT_MEASURABLE");
      assert.equal(initialComparison.evidence.telemetry.status, "NOT_AVAILABLE");
      assert.equal((await initialComparisonEvent).comparison.id, initialComparison.id);

      const initialInsightsResponse = await fetch(`${base}/api/jobs/${job.id}/insights`);
      assert.equal(initialInsightsResponse.status, 200);
      const initialInsights = (await initialInsightsResponse.json()).insights;
      assert.equal(initialInsights.progress.status, "UNAVAILABLE");
      assert.equal(initialInsights.parameter_verification.status, "UNAVAILABLE");
      assert.equal(initialInsights.valid_observation_count, 1);
      assert.equal(initialInsights.deviations.length, 0);

      mockProviderResult = {
        ...mockProviderResult,
        status: "failure",
        severity: 8,
        confidence: 0.9,
        failure_type: "bed_adhesion",
        scene_state: "printing_failure",
        attachment_state: "edge_lifted",
        failed_material_visible: true,
      };
      const firstFailureAnalysis = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(firstFailureAnalysis.status, 200);
      const deviationEvent = waitForSocketMessage(socket, "job_deviation");
      const secondFailureAnalysis = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(secondFailureAnalysis.status, 200);
      assert.equal((await deviationEvent).deviation.category, "REPEATED_FAILURE_BED_ADHESION");
      const insightsAfterRepeat = await fetch(`${base}/api/jobs/${job.id}/insights`);
      const jobInsights = (await insightsAfterRepeat.json()).insights;
      assert.equal(jobInsights.deviations.length, 1);
      assert.equal(jobInsights.deviations[0].state, "ACTIVE");
      assert.equal(jobInsights.deviations[0].evidence.observations.length, 2);
      const deviationId = jobInsights.deviations[0].id;
      let duplicateDeviationEvents = 0;
      const countDuplicateDeviationEvents = (data) => {
        if (JSON.parse(data.toString()).type === "job_deviation") duplicateDeviationEvents += 1;
      };
      socket.on("message", countDuplicateDeviationEvents);
      const thirdFailureAnalysis = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(thirdFailureAnalysis.status, 200);
      socket.off("message", countDuplicateDeviationEvents);
      const afterDuplicate = await fetch(`${base}/api/jobs/${job.id}/insights`);
      const deduplicated = (await afterDuplicate.json()).insights.deviations[0];
      assert.equal(deduplicated.id, deviationId);
      assert.equal(deduplicated.evidence.observations.length, 3);
      assert.equal(duplicateDeviationEvents, 0);

      mockRootCauseResult = {
        problem_summary: "Repeated camera observations show possible bed adhesion deterioration.",
        possible_root_causes: [{
          cause: "Possible first-layer adhesion loss",
          rationale: "Repeated visual bed_adhesion classifications are consistent with inadequate first-layer bonding.",
          confidence: 0.68,
          evidence_ids: [jobInsights.deviations[0].evidence.observations[0].id],
        }],
        risk_assessment: {
          level: "HIGH",
          explanation: "Repeated high-confidence visual evidence warrants operator inspection.",
        },
        recommended_operator_action: "Inspect the first layer and build surface before restarting.",
        preventive_recommendations: ["Review bed preparation and first-layer setup."],
        missing_information: ["No bed-temperature or controller telemetry is connected."],
      };
      const reportEvent = waitForSocketMessage(socket, "root_cause_report_created");
      const reportResponse = await fetch(`${base}/api/deviations/${deviationId}/investigate`, {
        method: "POST",
      });
      assert.equal(reportResponse.status, 201);
      const rootReport = (await reportResponse.json()).report;
      assert.equal(rootReport.status, "COMPLETED");
      assert.equal(rootReport.report.possible_root_causes[0].classification, "AI_HYPOTHESIS_NOT_CONFIRMED");
      assert.equal(rootReport.observed_facts.telemetry.status, "NOT_AVAILABLE");
      assert.equal((await reportEvent).report.id, rootReport.id);
      const providerCallsAfterReport = rootCauseCalls;
      const duplicateReportResponse = await fetch(`${base}/api/deviations/${deviationId}/investigate`, {
        method: "POST",
      });
      assert.equal(duplicateReportResponse.status, 200);
      assert.equal((await duplicateReportResponse.json()).reused, true);
      assert.equal(rootCauseCalls, providerCallsAfterReport);

      const failedDeviationId = randomUUID();
      const timestamp = new Date().toISOString();
      database.prepare(`
        INSERT INTO job_deviations (
          id, job_id, machine_id, category, severity, explanation, expected_behavior,
          observed_behavior, initial_evidence, evidence, recommended_action, first_detected_at,
          latest_detected_at, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'ROOT_CAUSE_FAILURE_TEST', 'MODERATE', 'fixture evidence',
                  'intended job', 'camera evidence', '{"observations":[]}', '{"observations":[]}',
                  'inspect', ?, ?, 'ACTIVE', ?, ?)
      `).run(failedDeviationId, job.id, printer.id, timestamp, timestamp, timestamp, timestamp);
      mockRootCauseFailure = true;
      const failedInvestigation = await fetch(`${base}/api/deviations/${failedDeviationId}/investigate`, {
        method: "POST",
      });
      assert.equal(failedInvestigation.status, 502);
      assert.equal(
        database.prepare("SELECT status FROM root_cause_reports WHERE deviation_id = ?").get(failedDeviationId).status,
        "FAILED",
      );
      mockRootCauseFailure = false;
      mockRootCauseResult = {
        problem_summary: "This intentionally invalid test response cites an unknown record.",
        possible_root_causes: [{
          cause: "Unverified possible cause",
          rationale: "No supplied observation supports this citation.",
          confidence: 0.6,
          evidence_ids: ["fabricated-evidence-id"],
        }],
        risk_assessment: { level: "MODERATE", explanation: "This should fail evidence validation." },
        recommended_operator_action: "Review available evidence.",
        preventive_recommendations: ["Review machine setup."],
        missing_information: ["No sensor data."],
      };
      const invalidStructuredReport = await fetch(`${base}/api/deviations/${failedDeviationId}/investigate`, {
        method: "POST",
      });
      assert.equal(invalidStructuredReport.status, 502);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM root_cause_reports WHERE deviation_id = ? AND status = 'FAILED'").get(failedDeviationId).count,
        2,
      );

      const acknowledgeEvent = waitForSocketMessage(socket, "deviation_acknowledged");
      const acknowledgedResponse = await fetch(`${base}/api/deviations/${deviationId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Operator inspected the camera evidence." }),
      });
      assert.equal(acknowledgedResponse.status, 200);
      const acknowledged = (await acknowledgedResponse.json()).deviation;
      assert.equal(acknowledged.state, "ACKNOWLEDGED");
      assert.ok(acknowledged.acknowledged_at);
      assert.equal(acknowledged.evidence.observations.length, 3);
      assert.equal(acknowledged.initial_evidence.observations.length, 2);
      assert.equal((await acknowledgeEvent).deviation.state, "ACKNOWLEDGED");
      const duplicateAcknowledge = await fetch(`${base}/api/deviations/${deviationId}/acknowledge`, {
        method: "POST",
      });
      assert.equal(duplicateAcknowledge.status, 409);

      const fourthFailure = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(fourthFailure.status, 200);
      const afterAcknowledgedNewEvidence = await fetch(`${base}/api/jobs/${job.id}/insights`);
      const acknowledgedAfterEvidence = (await afterAcknowledgedNewEvidence.json()).insights.deviations
        .find((deviation) => deviation.id === deviationId);
      assert.equal(acknowledgedAfterEvidence.state, "ACKNOWLEDGED");
      assert.equal(acknowledgedAfterEvidence.evidence.observations.length, 4);

      const deviationComparisonEvent = waitForSocketMessage(socket, "job_comparison_updated");
      const deviationComparisonResponse = await fetch(`${base}/api/jobs/${job.id}/comparison`, {
        method: "POST",
      });
      assert.equal(deviationComparisonResponse.status, 201);
      const deviationComparison = (await deviationComparisonResponse.json()).comparison;
      assert.equal(deviationComparison.classification, "DEVIATION_DETECTED");
      assert.equal(deviationComparison.evidence.observed.source, "camera_ai_analysis");
      await deviationComparisonEvent;

      const uncertainComparison = compareJobEvidence(
        { ...job, file: null },
        [{ is_valid: 1, timestamp: "2026-11-06T10:00:00.000Z", confidence: 0.3, abnormality_score: 50, analysis_status: "unclear", machine_status: "needs_attention" }],
        null,
      );
      assert.equal(uncertainComparison.classification, "UNCERTAIN");
      const layerProgressComparison = compareJobEvidence(
        { ...job, expected_parameters: { expected_layer_count: 100 }, file: null },
        [{
          is_valid: 1,
          timestamp: "2026-11-06T10:00:00.000Z",
          confidence: 0.9,
          abnormality_score: 10,
          analysis_status: "normal",
          machine_status: "printing",
        }],
        null,
      );
      assert.equal(layerProgressComparison.classification, "UNCERTAIN");
      assert.equal(
        compareJobEvidence(
          { ...job, expected_parameters: {}, file: null },
          [
            {
              is_valid: 1,
              timestamp: "2026-11-06T10:00:00.000Z",
              confidence: 0.9,
              abnormality_score: 10,
              analysis_status: "normal",
              machine_status: "printing",
            },
            {
              is_valid: 1,
              timestamp: "2026-11-06T10:01:00.000Z",
              confidence: 0.9,
              abnormality_score: 10,
              analysis_status: "normal",
              machine_status: "printing",
            },
          ],
          null,
        ).classification,
        "CONSISTENT",
      );
      const noTelemetryComparison = compareJobEvidence(
        job,
        [{ is_valid: 0, timestamp: "2026-11-06T10:00:00.000Z", confidence: 0.9, abnormality_score: null }],
        null,
      );
      assert.equal(noTelemetryComparison.classification, "NOT_MEASURABLE");
      assert.equal(noTelemetryComparison.evidence.telemetry.status, "NOT_AVAILABLE");

      const resolveEvent = waitForSocketMessage(socket, "deviation_resolved");
      const resolvedResponse = await fetch(`${base}/api/deviations/${deviationId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_notes: "Resolved after operator review." }),
      });
      assert.equal(resolvedResponse.status, 200);
      const resolved = (await resolvedResponse.json()).deviation;
      assert.equal(resolved.state, "RESOLVED");
      assert.ok(resolved.resolved_at);
      assert.equal(resolved.evidence.observations.length, 4);
      assert.equal((await resolveEvent).deviation.state, "RESOLVED");
      assert.equal(listDeviationLifecycleEvents(database, deviationId).length, 2);
      const duplicateResolve = await fetch(`${base}/api/deviations/${deviationId}/resolve`, { method: "POST" });
      assert.equal(duplicateResolve.status, 409);
      const acknowledgeResolved = await fetch(`${base}/api/deviations/${deviationId}/acknowledge`, { method: "POST" });
      assert.equal(acknowledgeResolved.status, 409);
      const invalidDeviationId = await fetch(`${base}/api/deviations/not-a-uuid/resolve`, { method: "POST" });
      assert.equal(invalidDeviationId.status, 400);

      const uncertainVerification = evaluateCompletionVerification(job, null);
      assert.equal(uncertainVerification.outcome, "COMPLETION_UNCERTAIN");
      const notCompleteVerification = evaluateCompletionVerification(job, {
        timestamp: new Date().toISOString(),
        machine_status: "printing",
        analysis_status: "normal",
        confidence: 0.9,
      });
      assert.equal(notCompleteVerification.outcome, "NOT_COMPLETE");

      mockProviderFailure = true;
      const failedAnalysis = await fetch(`${base}/api/analyze-machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentImageDataUrl: "data:image/jpeg;base64,dGVzdA==",
          cameraId: "phase4-printer-camera",
          cameraLabel: "Phase 4 printer fixture",
          machineType: "3d_printer",
        }),
      });
      assert.equal(failedAnalysis.status, 503);
      const invalidLinkedRecord = database
        .prepare("SELECT job_id, is_valid, abnormality_score FROM analysis_records WHERE machine_id = ? AND is_valid = 0 ORDER BY created_at DESC LIMIT 1")
        .get(printer.id);
      assert.deepEqual(invalidLinkedRecord, { job_id: job.id, is_valid: 0, abnormality_score: null });
      const afterProviderFailure = await fetch(`${base}/api/jobs/${job.id}/insights`);
      assert.equal((await afterProviderFailure.json()).insights.deviations.find((deviation) => deviation.id === deviationId).evidence.observations.length, 4);
      mockProviderFailure = false;
      mockProviderResult = {
        status: "normal",
        severity: 1,
        confidence: 0.9,
        failure_type: "none",
        scene_state: "printing_normally",
        material_pattern: "intentional_solid_geometry",
        attachment_state: "attached_flat",
        build_plate_visible: true,
        printed_part_visible: true,
        failed_material_visible: false,
      };

      const listed = await fetch(`${base}/api/jobs?machine_id=${printer.id}`);
      const listedBody = await listed.json();
      assert.equal(listed.status, 200);
      assert.equal(listedBody.jobs.length, 2);
      assert.ok(listedBody.jobs.some((item) => item.id === job.id));

      const prematureOperatorConfirmation = await fetch(`${base}/api/jobs/${job.id}/completion-verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      });
      assert.equal(prematureOperatorConfirmation.status, 409);

      const completedEvent = waitForSocketMessage(socket, "job_completed");
      const completed = await fetch(`${base}/api/jobs/${job.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      assert.equal(completed.status, 200);
      assert.equal((await completedEvent).job.status, "COMPLETED");
      const completedJob = (await completed.json()).job;
      assert.ok(completedJob.started_at);
      assert.ok(completedJob.completed_at);
      const invalidTransition = await fetch(`${base}/api/jobs/${job.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RUNNING" }),
      });
      assert.equal(invalidTransition.status, 409);

      const completionUpdateEvent = waitForSocketMessage(socket, "job_completion_verification_updated");
      const evaluatedResponse = await fetch(`${base}/api/jobs/${job.id}/completion-verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "evaluate" }),
      });
      assert.equal(evaluatedResponse.status, 201);
      const evaluatedVerification = (await evaluatedResponse.json()).verification;
      assert.equal(evaluatedVerification.outcome, "COMPLETION_UNCERTAIN");
      assert.equal(evaluatedVerification.operator_confirmed, false);
      assert.ok(evaluatedVerification.missing_evidence.some((item) => item.includes("telemetry")));
      assert.equal((await completionUpdateEvent).verification.id, evaluatedVerification.id);

      const operatorConfirmationEvent = waitForSocketMessage(socket, "job_completion_verification_updated");
      const operatorConfirmationResponse = await fetch(`${base}/api/jobs/${job.id}/completion-verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          operator_notes: "Reviewed the persisted camera evidence and confirmed the operator handoff.",
        }),
      });
      assert.equal(operatorConfirmationResponse.status, 201);
      const operatorConfirmation = (await operatorConfirmationResponse.json()).verification;
      assert.equal(operatorConfirmation.outcome, "LIKELY_COMPLETE");
      assert.equal(operatorConfirmation.operator_confirmed, true);
      assert.equal((await operatorConfirmationEvent).verification.id, operatorConfirmation.id);
      const duplicateConfirmation = await fetch(`${base}/api/jobs/${job.id}/completion-verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", operator_notes: "duplicate" }),
      });
      assert.equal(duplicateConfirmation.status, 200);
      assert.equal((await duplicateConfirmation.json()).verification.id, operatorConfirmation.id);
      const completionHistory = await fetch(`${base}/api/jobs/${job.id}/completion-verifications`);
      assert.equal((await completionHistory.json()).verifications.length, 2);
    });

    await t.test("persists job data and G-code summary after closing and reopening SQLite", async () => {
      socket.close();
      await once(socket, "close");
      socket = null;
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      server = null;
      closeDatabase();
      const reopened = initializeDatabase();
      const rows = reopened
        .prepare("SELECT jobs.id, jobs.status, job_files.filename, job_files.content FROM jobs LEFT JOIN job_files ON job_files.job_id = jobs.id")
        .all();
      assert.equal(rows.length, 3);
      assert.equal(rows.find((row) => row.status === "COMPLETED").filename, "fixture.gcode");
      assert.ok(rows.find((row) => row.filename === "fixture.gcode").content.includes("G1 X0 Y0"));
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM job_deviations").get().count, 2);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM deviation_lifecycle_events").get().count, 2);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM root_cause_reports WHERE status = 'COMPLETED'").get().count, 1);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM job_comparisons").get().count, 2);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM job_completion_verifications").get().count, 2);
    });
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("job deviations require repeated, valid, high-confidence visual evidence", () => {
  const job = { status: "RUNNING", machine_type: "3d_printer" };
  const records = [
    {
      id: "one",
      timestamp: "2026-11-06T10:00:00.000Z",
      is_valid: 1,
      analysis_status: "failure",
      failure_type: "bed_adhesion",
      abnormality_score: 80,
      confidence: 0.9,
    },
  ];
  assert.deepEqual(detectJobDeviations(job, records), []);
  assert.deepEqual(
    detectJobDeviations(job, [
      ...records,
      {
        ...records[0],
        id: "invalid",
        is_valid: 0,
        timestamp: "2026-11-06T10:01:00.000Z",
      },
    ]),
    [],
  );
  const repeated = detectJobDeviations(job, [
    ...records,
    {
      ...records[0],
      id: "two",
      timestamp: "2026-11-06T10:01:00.000Z",
    },
  ]);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].evidence.observations.length, 2);
  assert.deepEqual(
    detectJobDeviations(
      job,
      ["one", "two"].map((id, index) => ({
        ...records[0],
        id,
        timestamp: `2026-11-06T10:0${index}:00.000Z`,
        confidence: 0.5,
      })),
    ),
    [],
  );
  assert.deepEqual(detectJobDeviations({ ...job, status: "COMPLETED" }, repeated), []);
});

test("root-cause reports require bounded, evidence-cited hypotheses", () => {
  const valid = {
    problem_summary: "Repeated visual bed adhesion failures were observed.",
    possible_root_causes: [{
      cause: "Possible first-layer adhesion loss",
      rationale: "Repeated lifted-edge classifications are consistent with adhesion loss.",
      confidence: 0.6,
      evidence_ids: ["analysis-1"],
    }],
    risk_assessment: { level: "HIGH", explanation: "Repeated observations merit operator review." },
    recommended_operator_action: "Inspect the first layer before restarting.",
    preventive_recommendations: ["Review surface preparation."],
    missing_information: ["No temperature sensor data is available."],
  };
  const result = validateRootCauseResponse(valid, ["analysis-1"]);
  assert.equal(result.possible_root_causes[0].classification, "AI_HYPOTHESIS_NOT_CONFIRMED");
  assert.equal(validateRootCauseResponse(valid, []), null);
  assert.equal(
    validateRootCauseResponse({
      ...valid,
      possible_root_causes: [{ ...valid.possible_root_causes[0], confidence: 1.1 }],
    }, ["analysis-1"]),
    null,
  );
  assert.equal(validateRootCauseResponse({ ...valid, risk_assessment: { level: "CERTAIN", explanation: "x" } }, ["analysis-1"]), null);
});
