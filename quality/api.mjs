import express from "express";
import { getJob } from "../jobs/repository.mjs";
import { findMachine } from "../db/repository.mjs";
import { getInspection, listInspections, saveInspection } from "./repository.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFECT_TYPES = new Set([
  "crack",
  "hole",
  "layer_shifting",
  "warping",
  "stringing",
  "poor_surface_quality",
  "incomplete_printing",
  "visible_deformation",
]);
const SEVERITIES = new Set(["LOW", "MODERATE", "HIGH"]);
const ASSESSMENTS = new Set(["ACCEPTABLE", "NEEDS_REVIEW", "UNABLE_TO_ASSESS"]);
const IMAGE_QUALITY = new Set(["GOOD", "LIMITED", "POOR"]);
const PROVENANCE = new Set(["REAL", "SIMULATED"]);

function errorResponse(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function inspectImageDataUrl(value) {
  if (typeof value !== "string") return { error: "Upload an image file." };
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !IMAGE_TYPES.has(match[1])) {
    return { error: "Use a valid JPEG, PNG, or WebP image." };
  }
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > MAX_IMAGE_BYTES) {
    return { tooLarge: image.length > MAX_IMAGE_BYTES, error: "Each image must be no larger than 2 MiB." };
  }
  const isPng = match[1] === "image/png" &&
    image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = match[1] === "image/jpeg" && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isWebp = match[1] === "image/webp" &&
    image.toString("ascii", 0, 4) === "RIFF" &&
    image.toString("ascii", 8, 12) === "WEBP";
  if (!(isPng || isJpeg || isWebp)) {
    return { error: "The image content does not match its declared JPEG, PNG, or WebP type." };
  }
  return { value: { dataUrl: value, mimeType: match[1], byteLength: image.length } };
}

function boundedText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeInspection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !ASSESSMENTS.has(value.overall_assessment) ||
      !IMAGE_QUALITY.has(value.image_quality) ||
      !Array.isArray(value.visible_defects) ||
      !Array.isArray(value.possible_causes) ||
      !Array.isArray(value.recommended_actions) ||
      !(value.confidence === null ||
        (typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1))) {
    return null;
  }
  const defects = [];
  for (const defect of value.visible_defects.slice(0, 12)) {
    if (!defect || typeof defect !== "object" || !DEFECT_TYPES.has(defect.type) ||
        !SEVERITIES.has(defect.severity) || typeof defect.evidence !== "string" ||
        !defect.evidence.trim()) return null;
    defects.push({
      type: defect.type,
      severity: defect.severity,
      evidence: boundedText(defect.evidence),
      possible_causes: Array.isArray(defect.possible_causes)
        ? defect.possible_causes.slice(0, 5).map((item) => boundedText(item)).filter(Boolean)
        : [],
      recommended_actions: Array.isArray(defect.recommended_actions)
        ? defect.recommended_actions.slice(0, 5).map((item) => boundedText(item)).filter(Boolean)
        : [],
    });
  }
  if (value.overall_assessment === "ACCEPTABLE" && defects.length) return null;
  if (value.overall_assessment === "UNABLE_TO_ASSESS" && value.image_quality === "GOOD") return null;
  const hasReference = Boolean(value.reference_comparison);
  return {
    overall_assessment: value.overall_assessment,
    summary: boundedText(value.summary, 800),
    image_quality: value.image_quality,
    visible_defects: defects,
    possible_causes: value.possible_causes.slice(0, 8).map((item) => boundedText(item)).filter(Boolean),
    recommended_actions: value.recommended_actions.slice(0, 8).map((item) => boundedText(item)).filter(Boolean),
    confidence: value.confidence,
    uncertainty: boundedText(value.uncertainty, 600),
    reference_comparison: hasReference && typeof value.reference_comparison === "object"
      ? {
          visible_differences: Array.isArray(value.reference_comparison.visible_differences)
            ? value.reference_comparison.visible_differences.slice(0, 8).map((item) => boundedText(item)).filter(Boolean)
            : [],
          note: boundedText(value.reference_comparison.note, 500),
        }
      : null,
    limitations: [
      "Image inspection cannot establish internal structural quality.",
      "A reference-image comparison describes visible differences only; it does not verify dimensions or tolerances.",
    ],
  };
}

function jsonFromProviderText(text) {
  if (typeof text !== "string" || text.length > 12_000) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenced ? fenced[1] : trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildMessages({ image, referenceImage, imageProvenance, referenceProvenance }) {
  const prompt = `Inspect a completed 3D-printed product from the supplied image. The primary image is declared ${imageProvenance} by the operator; do not infer authenticity from pixels. ${referenceImage ? `The optional reference image is declared ${referenceProvenance} by the operator. Compare only visible differences between the images.` : "No reference image was supplied."}
Identify only clearly visible evidence for cracks, holes, layer shifting, warping, stringing, poor surface quality, incomplete printing, and visible deformation. Do not invent defects or treat uncertain details as confirmed. If framing, focus, lighting, or occlusion prevents assessment, mark image_quality LIMITED or POOR and assessment UNABLE_TO_ASSESS as appropriate.
Separate observed defects from possible causes. Give no numerical quality score. A single external image cannot establish internal structural quality. Reference comparisons cannot establish dimensions or tolerances without calibrated measurement.
Return only JSON with this shape:
{"overall_assessment":"ACCEPTABLE|NEEDS_REVIEW|UNABLE_TO_ASSESS","summary":"cautious concise summary","image_quality":"GOOD|LIMITED|POOR","visible_defects":[{"type":"crack|hole|layer_shifting|warping|stringing|poor_surface_quality|incomplete_printing|visible_deformation","severity":"LOW|MODERATE|HIGH","evidence":"specific visible evidence","possible_causes":["hypotheses only"],"recommended_actions":["safe corrective actions"]}],"possible_causes":["hypotheses only"],"recommended_actions":["safe actions"],"confidence":0.0,"uncertainty":"limits or reason for uncertainty","reference_comparison":{"visible_differences":["only visible differences"],"note":"no dimensional validation"}}
confidence must be null when evidence is insufficient, otherwise a calibrated qualitative confidence estimate from 0 to 1. Use empty arrays when no visible defect is supported. Assessment ACCEPTABLE requires no visible defects and a sufficiently usable image.`;
  const content = [{ type: "text", text: prompt }];
  content.push({ type: "text", text: `PRIMARY PRODUCT IMAGE (${imageProvenance})` });
  content.push({ type: "image_url", image_url: { url: image.dataUrl } });
  if (referenceImage) {
    content.push({ type: "text", text: `REFERENCE IMAGE (${referenceProvenance}) — compare visible differences only` });
    content.push({ type: "image_url", image_url: { url: referenceImage.dataUrl } });
  }
  return [{ role: "user", content }];
}

export function createProductQualityRouter({ databaseProvider, completeVision, getProviderState }) {
  const router = express.Router();

  router.get("/inspections", (request, response) => {
    const machineId = request.query.machine_id || null;
    const jobId = request.query.job_id || null;
    if ((machineId && !UUID_PATTERN.test(machineId)) || (jobId && !UUID_PATTERN.test(jobId))) {
      return errorResponse(response, 400, "invalid_filter", "Machine and job filters must be UUIDs.");
    }
    try {
      return response.json({ inspections: listInspections(databaseProvider(), { machineId, jobId }) });
    } catch (error) {
      console.error("Could not load product inspections:", error);
      return errorResponse(response, 500, "inspections_unavailable", "Saved inspections could not be loaded.");
    }
  });

  router.get("/inspections/:id", (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      return errorResponse(response, 400, "invalid_inspection_id", "Inspection ID must be a UUID.");
    }
    try {
      const inspection = getInspection(databaseProvider(), request.params.id);
      if (!inspection) return errorResponse(response, 404, "inspection_not_found", "Inspection not found.");
      return response.json({ inspection });
    } catch (error) {
      console.error("Could not load product inspection:", error);
      return errorResponse(response, 500, "inspection_unavailable", "The inspection could not be loaded.");
    }
  });

  router.post("/inspections", async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(response, 400, "invalid_request", "A JSON object is required.");
    }
    if (!PROVENANCE.has(body.image_provenance) ||
        (body.reference_image !== undefined && body.reference_image !== null && !PROVENANCE.has(body.reference_provenance))) {
      return errorResponse(response, 400, "invalid_provenance", "Select whether each supplied image is REAL or SIMULATED.");
    }
    const image = inspectImageDataUrl(body.image);
    if (image.error) return errorResponse(response, image.tooLarge ? 413 : 400, image.tooLarge ? "image_too_large" : "invalid_image", image.error);
    const referenceImage = body.reference_image == null
      ? { value: null }
      : inspectImageDataUrl(body.reference_image);
    if (referenceImage.error) {
      return errorResponse(
        response,
        referenceImage.tooLarge ? 413 : 400,
        referenceImage.tooLarge ? "image_too_large" : "invalid_reference_image",
        referenceImage.error,
      );
    }
    const totalBytes = image.value.byteLength + (referenceImage.value?.byteLength || 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return errorResponse(response, 413, "images_too_large", "The combined uploaded images must not exceed 3 MiB.");
    }
    if (body.job_id !== undefined && body.job_id !== null &&
        (typeof body.job_id !== "string" || !UUID_PATTERN.test(body.job_id))) {
      return errorResponse(response, 400, "invalid_job_id", "Job ID must be a UUID or null.");
    }
    const providerState = getProviderState();
    if (!providerState.hasApiKey) {
      return errorResponse(response, 503, "provider_configuration_error", `${providerState.providerName} is not configured in Vision OPS settings.`);
    }
    const database = databaseProvider();
    let job = null;
    if (body.job_id) {
      job = getJob(database, body.job_id);
      if (!job) return errorResponse(response, 404, "job_not_found", "The selected job does not exist.");
      if (job.machine_type !== "3d_printer") {
        return errorResponse(response, 400, "unsupported_job_type", "Product quality inspection can only be associated with a 3D printer job.");
      }
    }
    try {
      const completion = await completeVision(
        buildMessages({
          image: image.value,
          referenceImage: referenceImage.value,
          imageProvenance: body.image_provenance,
          referenceProvenance: referenceImage.value ? body.reference_provenance : null,
        }),
        { maxTokens: 1400, timeoutMs: 45_000 },
      );
      const normalized = normalizeInspection(jsonFromProviderText(completion));
      if (!normalized) {
        return errorResponse(response, 502, "provider_invalid_response", "The vision provider returned an invalid inspection result. Retry with a clear image.");
      }
      const inspection = saveInspection(database, {
        machineId: job?.machine_id || null,
        jobId: job?.id || null,
        imageDataUrl: image.value.dataUrl,
        imageProvenance: body.image_provenance,
        referenceDataUrl: referenceImage.value?.dataUrl || null,
        referenceProvenance: referenceImage.value ? body.reference_provenance : null,
        result: normalized,
        provider: providerState.providerName,
        model: providerState.model,
      });
      return response.status(201).json({ inspection });
    } catch (error) {
      console.error("Product quality inspection failed:", {
        provider: providerState.providerName,
        model: providerState.model,
        status: Number.isInteger(error?.status) ? error.status : null,
        code: error?.code || null,
      });
      return errorResponse(response, 502, "provider_request_failed", "The configured vision provider could not complete this inspection. Check provider status and retry.");
    }
  });
  return router;
}
