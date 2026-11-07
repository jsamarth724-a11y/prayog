import { classifyRisk } from "../db/repository.mjs";
import { DEFAULT_TREND_CONFIG } from "./config.mjs";

const round = (value, places = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function normalizedRecords(records) {
  return records
    .map((record, index) => ({
      ...record,
      _index: index,
      _score: Number(record.abnormality_score),
      _time: Date.parse(record.timestamp),
    }))
    .filter(
      (record) =>
        Number(record.is_valid ?? 1) === 1 &&
        Number.isFinite(record._score) &&
        record._score >= 0 &&
        record._score <= 100,
    )
    .sort((left, right) => {
      if (Number.isFinite(left._time) && Number.isFinite(right._time)) {
        return left._time - right._time || left._index - right._index;
      }
      if (Number.isFinite(left._time)) return -1;
      if (Number.isFinite(right._time)) return 1;
      return String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")) ||
        left._index - right._index;
    });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function linearRegression(records, xFor) {
  const points = records
    .map((record, index) => ({ x: xFor(record, index), y: record._score }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 2) return null;

  const xMean = mean(points.map((point) => point.x));
  const yMean = mean(points.map((point) => point.y));
  const denominator = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  if (denominator === 0) return null;
  return points.reduce(
    (sum, point) => sum + (point.x - xMean) * (point.y - yMean),
    0,
  ) / denominator;
}

function linearSlopes(records) {
  const timed = records.filter((record) => Number.isFinite(record._time));
  const firstTime = timed[0]?._time;
  const scorePerHour =
    Number.isFinite(firstTime)
      ? linearRegression(timed, (record) => (record._time - firstTime) / 3_600_000)
      : null;
  const scorePerObservation = linearRegression(records, (_record, index) => index);
  return {
    score_per_hour: round(scorePerHour),
    score_per_observation: round(scorePerObservation),
    regression_observations: timed.length,
  };
}

function baselineStatistics(records, windowSize) {
  const baseline = records.slice(-windowSize);
  const values = baseline.map((record) => record._score);
  const average = mean(values);
  const standardDeviation =
    values.length && average !== null
      ? Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
      : null;
  return {
    observations: baseline.length,
    mean: round(average),
    standard_deviation: round(standardDeviation),
    records: baseline,
  };
}

function compareWindows(records, windowSize) {
  if (records.length < windowSize * 2) {
    return { recent_average: null, previous_average: null, delta: null };
  }
  const recent = records.slice(-windowSize);
  const preceding = records.slice(-2 * windowSize, -windowSize);
  const recentAverage = mean(recent.map((record) => record._score));
  const previousAverage = mean(preceding.map((record) => record._score));
  return {
    recent_average: round(recentAverage),
    previous_average: round(previousAverage),
    delta: round(recentAverage - previousAverage),
  };
}

function confidenceAndGaps(records, config) {
  if (!records.length) return { confidence: 0, gaps_detected: 0, timed_observations: 0 };
  const recent = records.slice(-config.longWindow);
  const confidences = recent
    .map((record) => Number(record.confidence))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const averageConfidence = confidences.length ? mean(confidences) : 0.5;
  const uncertaintyRate =
    recent.filter((record) => Number(record.is_uncertain) === 1).length / recent.length;
  const timed = recent.filter((record) => Number.isFinite(record._time));
  let gapsDetected = 0;
  for (let index = 1; index < timed.length; index += 1) {
    if (timed[index]._time - timed[index - 1]._time > config.maximumGapHours * 3_600_000) {
      gapsDetected += 1;
    }
  }
  const dataSufficiency = Math.min(1, records.length / (config.minimumObservations * 2));
  const timestampCoverage = recent.length ? timed.length / recent.length : 0;
  const gapQuality = gapsDetected ? 0.75 ** gapsDetected : 1;
  const confidence = averageConfidence * (1 - uncertaintyRate * 0.5) *
    dataSufficiency * (0.75 + 0.25 * timestampCoverage) * gapQuality;
  return {
    confidence: round(confidence, 3),
    gaps_detected: gapsDetected,
    timed_observations: timed.length,
  };
}

function trailingCount(records, predicate) {
  let count = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!predicate(records[index])) break;
    count += 1;
  }
  return count;
}

/**
 * All score aggregates exclude invalid rows. The regression slope is measured
 * in abnormality points/hour; the observation slope is points per valid frame.
 */
export function analyzeTrend(inputRecords, config = DEFAULT_TREND_CONFIG) {
  const records = normalizedRecords(inputRecords);
  const count = records.length;
  const values = records.map((record) => record._score);
  const currentScore = values.at(-1) ?? null;
  const shortAverage = mean(values.slice(-config.shortWindow));
  const longAverage = mean(values.slice(-config.longWindow));
  const baselineRecords = records.slice(
    Math.max(0, count - config.longWindow - config.baselineWindow),
    Math.max(0, count - config.longWindow),
  );
  const establishedBaseline = baselineStatistics(baselineRecords, config.baselineWindow);
  const shortTrend = compareWindows(records, config.shortWindow);
  const longTrend = compareWindows(records, config.longWindow);
  const slopes = linearSlopes(records.slice(-config.longWindow));
  const persistentCount = trailingCount(
    records,
    (record) => record._score >= config.persistentHighThreshold,
  );
  const riskClassification = currentScore === null ? null : classifyRisk(currentScore, config);
  let classification = "INSUFFICIENT_DATA";

  if (count >= config.minimumObservations) {
    // Precedence: persistent high, rapidly rising, rising, sustained improving,
    // then stable. Competing conditions always resolve to the first match.
    if (persistentCount >= config.persistentObservationCount) {
      classification = "PERSISTENT_HIGH";
    } else if (
      slopes.score_per_observation !== null &&
      slopes.score_per_observation >= config.rapidSlopePerObservation &&
      shortTrend.delta !== null &&
      shortTrend.delta >= config.minimumTrendDelta
    ) {
      classification = "RAPIDLY_RISING";
    } else if (
      slopes.score_per_observation !== null &&
      slopes.score_per_observation >= config.risingSlopePerObservation &&
      shortTrend.delta !== null &&
      shortTrend.delta > 0
    ) {
      classification = "RISING";
    } else if (
      count >= config.shortWindow * 2 &&
      shortTrend.delta !== null &&
      longTrend.delta !== null &&
      shortTrend.delta <= -config.minimumTrendDelta &&
      longTrend.delta < 0
    ) {
      classification = "IMPROVING";
    } else {
      classification = "STABLE";
    }
  }

  return {
    current_score: currentScore,
    moving_average: round(shortAverage),
    moving_average_window: Math.min(count, config.shortWindow),
    long_moving_average: round(longAverage),
    short_term_trend: shortTrend,
    long_term_trend: longTrend,
    slope: slopes.score_per_hour,
    slope_unit: "abnormality_points_per_hour",
    rate_per_observation: slopes.score_per_observation,
    regression_observations: slopes.regression_observations,
    trend_classification: classification,
    valid_observations: count,
    last_analysis_timestamp: records.at(-1)?.timestamp ?? null,
    risk_classification: riskClassification,
    persistent_high_observations: persistentCount,
    baseline: {
      window: config.baselineWindow,
      observations: establishedBaseline.observations,
      mean: establishedBaseline.mean,
      standard_deviation: establishedBaseline.standard_deviation,
    },
    evidence_confidence: confidenceAndGaps(records, config),
    _records: records,
    _baseline_records: establishedBaseline.records,
  };
}

const RECOMMENDATIONS = {
  gradual_increase: "Inspect the machine and compare the work area with its known-good setup.",
  repeated_moderate: "Schedule an operator inspection and check recent process conditions.",
  sudden_spike: "Inspect the latest camera frame and verify the machine before continuing.",
  persistent_high: "Pause the job if safe, then inspect the machine and affected work area.",
  repeated_failure: "Inspect the recurring failure mechanism and review the related setup.",
  baseline_deviation: "Compare current operation with the machine's normal baseline and inspect for change.",
};

function evidenceFor(records) {
  return records.map((record) => ({
    id: record.id ?? null,
    timestamp: record.timestamp ?? null,
    abnormality_score: record._score,
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
    failure_type: record.failure_type || record.failure_category || null,
  }));
}

function warningCandidate(category, severity, explanation, records, extra = {}) {
  const recommendationCategory = category.startsWith("repeated_failure:")
    ? "repeated_failure"
    : category;
  return {
    category,
    severity,
    explanation,
    supporting_evidence: evidenceFor(records),
    first_detected_at: records.at(-1)?.timestamp ?? null,
    latest_detected_at: records.at(-1)?.timestamp ?? null,
    recommended_action: RECOMMENDATIONS[recommendationCategory],
    ...extra,
  };
}

/**
 * Every warning checks its own minimum sample count. Evidence confidence
 * combines sample sufficiency, AI confidence, uncertain-row share, timestamp
 * coverage, and a penalty for gaps beyond the configured maximum.
 */
export function evaluateEarlyWarnings(inputRecords, trend, config = DEFAULT_TREND_CONFIG) {
  const records = trend._records || normalizedRecords(inputRecords);
  const candidates = [];
  const latest = records.at(-1);
  if (!latest || trend.valid_observations < config.minimumObservations) return candidates;
  if (trend.evidence_confidence.confidence < config.warningMinimumConfidence) return candidates;

  const severityForEvidence = (base) =>
    trend.evidence_confidence.confidence >= config.warningFullSeverityConfidence
      ? base
      : base === "HIGH"
        ? "MODERATE"
        : "LOW";
  const last = (size) => records.slice(-size);

  if (
    trend.valid_observations >= config.gradualMinimumObservations &&
    ["RISING", "RAPIDLY_RISING"].includes(trend.trend_classification)
  ) {
    const supporting = last(Math.min(config.longWindow, records.length));
    const average = mean(supporting.map((record) => record._score));
    const baseline = trend.baseline.mean;
    candidates.push(
      warningCandidate(
        "gradual_increase",
        severityForEvidence(trend.trend_classification === "RAPIDLY_RISING" ? "HIGH" : "MODERATE"),
        `Early Warning: abnormality increased across ${supporting.length} valid observations. ` +
          `Recent average: ${round(average)}; established baseline: ${baseline ?? "unavailable"}; ` +
          `slope: ${trend.rate_per_observation ?? "unavailable"} points per observation.`,
        supporting,
      ),
    );
  }

  const moderateRecords = last(config.moderateWindow).filter(
    (record) =>
      record._score >= 40 &&
      record._score < 60,
  );
  if (
    trend.valid_observations >= config.moderateMinimumObservations &&
    moderateRecords.length >= config.moderateObservationThreshold
  ) {
    candidates.push(
      warningCandidate(
        "repeated_moderate",
        severityForEvidence("LOW"),
        `Early Warning: ${moderateRecords.length} of the last ${Math.min(config.moderateWindow, records.length)} ` +
          `valid observations were moderate risk (40–59).`,
        last(config.moderateWindow),
      ),
    );
  }

  const previous = records.slice(
    Math.max(0, records.length - config.spikeBaselineWindow - 1),
    -1,
  );
  const previousAverage = mean(previous.map((record) => record._score));
  if (
    trend.valid_observations >= config.spikeMinimumObservations &&
    previous.length >= config.spikeBaselineWindow &&
    previousAverage !== null &&
    latest._score - previousAverage >= config.spikeIncreaseThreshold
  ) {
    candidates.push(
      warningCandidate(
        "sudden_spike",
        severityForEvidence("MODERATE"),
        `Early Warning: latest score ${latest._score} is ${round(latest._score - previousAverage)} ` +
          `points above the prior ${previous.length}-observation average (${round(previousAverage)}).`,
        [...previous, latest],
      ),
    );
  }

  const persistentRecords = last(config.persistentObservationCount);
  if (
    trend.valid_observations >= config.persistentObservationCount &&
    persistentRecords.length === config.persistentObservationCount &&
    persistentRecords.every((record) => record._score >= config.persistentHighThreshold)
  ) {
    candidates.push(
      warningCandidate(
        "persistent_high",
        severityForEvidence("HIGH"),
        `Early Warning: ${persistentRecords.length} consecutive valid scores are at or above ` +
          `${config.persistentHighThreshold} (latest ${latest._score}).`,
        persistentRecords,
      ),
    );
  }

  const failureRecords = last(config.repeatedFailureWindow);
  const failureCounts = new Map();
  for (const record of failureRecords) {
    const failureType = record.failure_type || record.failure_category;
    if (!failureType || ["none", "unknown"].includes(String(failureType).toLowerCase())) continue;
    failureCounts.set(failureType, (failureCounts.get(failureType) || 0) + 1);
  }
  for (const [failureType, occurrences] of failureCounts) {
    if (
      trend.valid_observations >= config.repeatedFailureMinimumObservations &&
      occurrences >= config.repeatedFailureCount
    ) {
      const supporting = failureRecords.filter(
        (record) => (record.failure_type || record.failure_category) === failureType,
      );
      candidates.push(
        warningCandidate(
          `repeated_failure:${failureType}`,
          severityForEvidence("MODERATE"),
          `Early Warning: failure type "${failureType}" occurred ${occurrences} times ` +
            `within the last ${failureRecords.length} valid observations.`,
          supporting,
          { failure_type: failureType },
        ),
      );
    }
  }

  const recentCount = Math.min(config.baselineRecentWindow, records.length);
  const baselineRecords = records.slice(
    Math.max(0, records.length - recentCount - config.baselineWindow),
    -recentCount,
  );
  const recentRecords = last(recentCount);
  const baselineMean = mean(baselineRecords.map((record) => record._score));
  const baselineDeviation = baselineRecords.length
    ? Math.sqrt(
        mean(
          baselineRecords.map((record) => (record._score - baselineMean) ** 2),
        ),
      )
    : null;
  const recentMean = mean(recentRecords.map((record) => record._score));
  if (
    baselineRecords.length >= config.baselineMinimumObservations &&
    trend.valid_observations >= config.baselineMinimumObservations + config.baselineRecentWindow &&
    baselineMean !== null &&
    baselineDeviation !== null
  ) {
    const delta = recentMean - baselineMean;
    const zScore = baselineDeviation > 0 ? delta / baselineDeviation : null;
    const significant =
      delta >= config.baselineMinimumDeviation &&
      (baselineDeviation === 0 || zScore >= config.baselineZScoreThreshold);
    if (significant) {
      candidates.push(
        warningCandidate(
          "baseline_deviation",
          severityForEvidence("MODERATE"),
          `Early Warning: recent average ${round(recentMean)} is ${round(delta)} points above ` +
            `the prior ${baselineRecords.length}-observation baseline (${round(baselineMean)}; ` +
            `standard deviation ${round(baselineDeviation)}${zScore === null ? "" : `; z-score ${round(zScore)}`} ).`,
          [...baselineRecords, ...recentRecords],
          { baseline_mean: round(baselineMean), z_score: round(zScore) },
        ),
      );
    }
  }

  return candidates;
}

export function publicTrendResult(trend) {
  const { _records, _baseline_records, ...result } = trend;
  return result;
}
