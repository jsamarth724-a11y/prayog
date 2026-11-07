/**
 * Typed domain interfaces for Watch Guard AI Failure Trend Prediction System.
 */

export type RiskClassification = 'HEALTHY' | 'OBSERVE' | 'WARNING' | 'HIGH RISK' | 'CRITICAL';

export type AnalysisRiskClassification = 'NORMAL' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export type TrendDirection = 'INCREASING' | 'DECREASING' | 'STABLE';

export interface RiskBandRange {
  min: number;
  max: number;
}

export interface TrendEngineConfig {
  shortWindow: number;          // e.g. 5 frames
  longWindow: number;           // e.g. 15 frames
  persistenceCount: number;     // e.g. 3 consecutive frames
  slopeThreshold: number;       // rate of score rise/frame, e.g. 2.0
  minConfidence: number;        // minimum confidence to escalate, e.g. 0.60
  baselineWindow: number;       // baseline historical window, e.g. 50
  riskBands: {
    healthy: RiskBandRange;     // 0 - 29
    observe: RiskBandRange;     // 30 - 49
    warning: RiskBandRange;     // 50 - 69
    highRisk: RiskBandRange;    // 70 - 84
    critical: RiskBandRange;    // 85 - 100
  };
}

export interface MachineEntity {
  id: string;
  label: string;
  machine_type: string;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRecordInput {
  machine_id: string;
  machine_label?: string;
  machine_type?: string;
  timestamp?: string;
  is_valid: boolean;
  invalid_reason?: string | null;
  abnormality_score?: number | null;
  confidence?: number | null;
  failure_category?: string | null;
  risk_classification?: RiskClassification | null;
  severity?: number | null;
  scene_state?: string | null;
  incident_reference?: string | null;
  raw_metadata?: Record<string, unknown> | null;
}

export interface AnalysisRecord {
  id: string;
  machine_id: string;
  timestamp: string;
  is_valid: number; // 1 or 0 in SQLite
  invalid_reason: string | null;
  abnormality_score: number | null;
  confidence: number | null;
  failure_category: string | null;
  risk_classification: RiskClassification | null;
  severity: number | null;
  scene_state: string | null;
  incident_reference: string | null;
  raw_metadata: string | null; // serialized JSON
  created_at: string;
}

export interface EarlyWarningPayload {
  machine_id: string;
  machine_label: string;
  timestamp: string;
  abnormality_score: number;
  trend_direction: TrendDirection;
  detected_issue: string;
  risk_classification: RiskClassification;
  recommendation: string;
  supporting_snapshot?: string | null;
  evidence_points: string[];
}

export interface TrendAnalysisResult {
  machine_id: string;
  timestamp: string;
  current_score: number;
  health_score: number;
  risk_classification: RiskClassification;
  short_moving_avg: number;
  long_moving_avg: number;
  slope: number;
  trend_direction: TrendDirection;
  is_persistent: boolean;
  consecutive_above_warning: number;
  baseline_mean: number;
  historical_deviation: number;
  repeated_failures: Array<{ category: string; count: number }>;
  early_warning_active: boolean;
  early_warning: EarlyWarningPayload | null;
  data_points_count: number;
}
