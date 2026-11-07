const RISK_LEVELS = new Set(["LOW", "MODERATE", "HIGH", "CRITICAL"]);

function boundedText(value, maximum = 1000) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum
    ? value.trim()
    : null;
}

function boundedTextList(value, maximumItems = 8, maximumLength = 500) {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const items = value.map((item) => boundedText(item, maximumLength));
  return items.every(Boolean) ? items : null;
}

export function validateRootCauseResponse(value, supportingEvidenceIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const problemSummary = boundedText(value.problem_summary);
  const recommendedAction = boundedText(value.recommended_operator_action);
  const riskExplanation = boundedText(value.risk_assessment?.explanation);
  const preventiveRecommendations = boundedTextList(value.preventive_recommendations);
  const missingInformation = boundedTextList(value.missing_information);
  if (
    !problemSummary ||
    !recommendedAction ||
    !riskExplanation ||
    !preventiveRecommendations ||
    !missingInformation ||
    !RISK_LEVELS.has(value.risk_assessment?.level) ||
    !Array.isArray(value.possible_root_causes) ||
    value.possible_root_causes.length < 1 ||
    value.possible_root_causes.length > 5
  ) {
    return null;
  }
  const evidenceIds = new Set(supportingEvidenceIds);
  const possibleRootCauses = [];
  for (const candidate of value.possible_root_causes) {
    const cause = boundedText(candidate?.cause, 300);
    const rationale = boundedText(candidate?.rationale);
    if (
      !cause ||
      !rationale ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1 ||
      !Array.isArray(candidate.evidence_ids) ||
      candidate.evidence_ids.length === 0 ||
      candidate.evidence_ids.some((id) => typeof id !== "string" || !evidenceIds.has(id))
    ) {
      return null;
    }
    possibleRootCauses.push({
      cause,
      rationale,
      confidence: candidate.confidence,
      evidence_ids: [...new Set(candidate.evidence_ids)],
      classification: "AI_HYPOTHESIS_NOT_CONFIRMED",
    });
  }
  return {
    problem_summary: problemSummary,
    possible_root_causes: possibleRootCauses,
    risk_assessment: {
      level: value.risk_assessment.level,
      explanation: riskExplanation,
    },
    recommended_operator_action: recommendedAction,
    preventive_recommendations: preventiveRecommendations,
    missing_information: missingInformation,
  };
}

export function buildRootCausePrompt({ deviation, job, facts }) {
  return [
    "ROOT_CAUSE_REPORT",
    "You are a cautious manufacturing failure investigator. Return only a JSON object matching the requested schema.",
    "Separate observed facts (provided below) from possible causes. Every cause is a hypothesis, never a confirmed root cause.",
    "Use only the supplied evidence IDs. Do not invent sensor readings, temperatures, spindle speeds, feed rates, execution progress, or events.",
    "G-code and job parameters are operator intent, not proof of execution or actual telemetry.",
    "Acknowledge missing telemetry and state uncertainty. Recommendations must be safe operator inspection actions; never issue machine-control commands.",
    `Deviation: ${JSON.stringify(deviation)}`,
    `Job metadata: ${JSON.stringify({
      name: job.name,
      status: job.status,
      machine_type: job.machine_type,
      job_type: job.job_type,
      material_type: job.material_type,
      expected_parameters: job.expected_parameters,
      parsed_gcode_summary: job.file?.summary || null,
    })}`,
    `Observed facts and evidence: ${JSON.stringify(facts)}`,
    "Required schema:",
    JSON.stringify({
      problem_summary: "concise observed problem summary",
      possible_root_causes: [
        {
          cause: "possible cause, explicitly a hypothesis",
          rationale: "why the supplied evidence is consistent with it",
          confidence: 0.0,
          evidence_ids: ["an ID supplied in the evidence"],
        },
      ],
      risk_assessment: { level: "LOW | MODERATE | HIGH | CRITICAL", explanation: "evidence-based risk reasoning" },
      recommended_operator_action: "safe operator review/inspection action",
      preventive_recommendations: ["preventive recommendation"],
      missing_information: ["unavailable measurement or evidence"],
    }),
  ].join("\n\n");
}
