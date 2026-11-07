import { createHash, randomUUID } from "node:crypto";

export function inspectionImageDigest(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex");
}

export function saveInspection(database, {
  machineId,
  jobId,
  imageDataUrl,
  imageProvenance,
  referenceDataUrl,
  referenceProvenance,
  result,
  provider,
  model,
}) {
  const inspectionId = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO product_quality_inspections (
      id, machine_id, job_id, image_sha256, image_provenance,
      reference_sha256, reference_provenance, result_json, provider, model, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inspectionId,
    machineId,
    jobId,
    inspectionImageDigest(imageDataUrl),
    imageProvenance,
    referenceDataUrl ? inspectionImageDigest(referenceDataUrl) : null,
    referenceDataUrl ? referenceProvenance : null,
    JSON.stringify(result),
    provider,
    model,
    createdAt,
  );
  return getInspection(database, inspectionId);
}

function inspectionFromRow(row) {
  if (!row) return null;
  let result;
  try {
    result = JSON.parse(row.result_json);
  } catch (error) {
    console.error(`Could not parse product inspection ${row.id}:`, error);
    result = null;
  }
  return {
    id: row.id,
    machine_id: row.machine_id,
    job_id: row.job_id,
    image_sha256: row.image_sha256,
    image_provenance: row.image_provenance,
    reference_sha256: row.reference_sha256,
    reference_provenance: row.reference_provenance,
    result,
    provider: row.provider,
    model: row.model,
    created_at: row.created_at,
  };
}

export function getInspection(database, inspectionId) {
  const row = database.prepare(`
    SELECT id, machine_id, job_id, image_sha256, image_provenance,
           reference_sha256, reference_provenance, result_json, provider, model, created_at
    FROM product_quality_inspections WHERE id = ?
  `).get(inspectionId);
  return inspectionFromRow(row);
}

export function listInspections(database, { machineId = null, jobId = null, limit = 20 } = {}) {
  const conditions = [];
  const values = [];
  if (machineId) {
    conditions.push("machine_id = ?");
    values.push(machineId);
  }
  if (jobId) {
    conditions.push("job_id = ?");
    values.push(jobId);
  }
  values.push(Math.max(1, Math.min(50, limit)));
  return database.prepare(`
    SELECT id, machine_id, job_id, image_sha256, image_provenance,
           reference_sha256, reference_provenance, result_json, provider, model, created_at
    FROM product_quality_inspections
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(...values).map(inspectionFromRow);
}
