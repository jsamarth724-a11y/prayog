function numberSetting(env, name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function integerSetting(env, name, fallback, options) {
  return Math.round(numberSetting(env, name, fallback, options));
}

export function getTrendConfig(env = process.env) {
  const shortWindow = integerSetting(env, "TREND_SHORT_WINDOW", 3, { minimum: 2, maximum: 1000 });
  const longWindow = integerSetting(env, "TREND_LONG_WINDOW", 5, {
    minimum: shortWindow,
    maximum: 5000,
  });
  const moderateWindow = integerSetting(env, "TREND_MODERATE_WINDOW", 10, {
    minimum: 2,
    maximum: 5000,
  });
  const failureWindow = integerSetting(env, "TREND_FAILURE_WINDOW", 10, {
    minimum: 2,
    maximum: 5000,
  });
  const riskLowThreshold = integerSetting(env, "RISK_LOW_THRESHOLD", 20, {
    minimum: 1,
    maximum: 97,
  });
  const riskModerateThreshold = integerSetting(env, "RISK_MODERATE_THRESHOLD", 40, {
    minimum: riskLowThreshold + 1,
    maximum: 98,
  });
  const riskHighThreshold = integerSetting(env, "RISK_HIGH_THRESHOLD", 60, {
    minimum: riskModerateThreshold + 1,
    maximum: 99,
  });

  return {
    riskLowThreshold,
    riskModerateThreshold,
    riskHighThreshold,
    riskCriticalThreshold: integerSetting(env, "RISK_CRITICAL_THRESHOLD", 80, {
      minimum: riskHighThreshold + 1,
      maximum: 100,
    }),
    shortWindow,
    longWindow,
    baselineWindow: integerSetting(env, "TREND_BASELINE_WINDOW", 30, {
      minimum: longWindow,
      maximum: 10000,
    }),
    minimumObservations: integerSetting(env, "TREND_MIN_OBSERVATIONS", 5, {
      minimum: 3,
      maximum: 10000,
    }),
    risingSlopePerObservation: numberSetting(env, "TREND_RISING_SLOPE", 1, {
      minimum: 0.01,
      maximum: 100,
    }),
    rapidSlopePerObservation: numberSetting(env, "TREND_RAPID_SLOPE", 5, {
      minimum: 0.1,
      maximum: 100,
    }),
    minimumTrendDelta: numberSetting(env, "TREND_MIN_DELTA", 3, {
      minimum: 0,
      maximum: 100,
    }),
    persistentHighThreshold: numberSetting(env, "TREND_PERSISTENT_HIGH_SCORE", 70, {
      minimum: 0,
      maximum: 100,
    }),
    persistentObservationCount: integerSetting(env, "TREND_PERSISTENT_COUNT", 3, {
      minimum: 2,
      maximum: 1000,
    }),
    gradualMinimumObservations: integerSetting(env, "WARNING_GRADUAL_MIN_OBSERVATIONS", 5, {
      minimum: 3,
      maximum: 10000,
    }),
    moderateWindow,
    moderateObservationThreshold: integerSetting(env, "WARNING_MODERATE_COUNT", 3, {
      minimum: 2,
      maximum: moderateWindow,
    }),
    moderateMinimumObservations: integerSetting(env, "WARNING_MODERATE_MIN_OBSERVATIONS", 5, {
      minimum: 3,
      maximum: 10000,
    }),
    spikeBaselineWindow: integerSetting(env, "WARNING_SPIKE_BASELINE_WINDOW", 5, {
      minimum: 2,
      maximum: 1000,
    }),
    spikeIncreaseThreshold: numberSetting(env, "WARNING_SPIKE_INCREASE", 20, {
      minimum: 1,
      maximum: 100,
    }),
    spikeMinimumObservations: integerSetting(env, "WARNING_SPIKE_MIN_OBSERVATIONS", 6, {
      minimum: 3,
      maximum: 10000,
    }),
    repeatedFailureWindow: failureWindow,
    repeatedFailureCount: integerSetting(env, "WARNING_FAILURE_COUNT", 2, {
      minimum: 2,
      maximum: failureWindow,
    }),
    repeatedFailureMinimumObservations: integerSetting(env, "WARNING_FAILURE_MIN_OBSERVATIONS", 5, {
      minimum: 3,
      maximum: 10000,
    }),
    baselineMinimumObservations: integerSetting(env, "WARNING_BASELINE_MIN_OBSERVATIONS", 8, {
      minimum: 3,
      maximum: 10000,
    }),
    baselineRecentWindow: integerSetting(env, "WARNING_BASELINE_RECENT_WINDOW", 3, {
      minimum: 2,
      maximum: 1000,
    }),
    baselineZScoreThreshold: numberSetting(env, "WARNING_BASELINE_ZSCORE", 2, {
      minimum: 0.1,
      maximum: 20,
    }),
    baselineMinimumDeviation: numberSetting(env, "WARNING_BASELINE_MIN_DEVIATION", 15, {
      minimum: 1,
      maximum: 100,
    }),
    warningMinimumConfidence: numberSetting(env, "WARNING_MIN_CONFIDENCE", 0.35, {
      minimum: 0,
      maximum: 1,
    }),
    warningFullSeverityConfidence: numberSetting(env, "WARNING_FULL_SEVERITY_CONFIDENCE", 0.6, {
      minimum: 0,
      maximum: 1,
    }),
    maximumGapHours: numberSetting(env, "TREND_MAX_GAP_HOURS", 24, {
      minimum: 0.01,
      maximum: 24 * 365,
    }),
  };
}

export const DEFAULT_TREND_CONFIG = Object.freeze(getTrendConfig({}));
