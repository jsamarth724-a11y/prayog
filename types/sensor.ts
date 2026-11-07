export type SensorType = 'SOUND' | 'VIBRATION' | 'TEMPERATURE' | 'SMOKE';
export type SensorAdapterType = 'ESP32' | 'USB' | 'SERIAL' | 'MQTT' | 'NETWORK';
export type SensorProvenance = 'REAL' | 'SIMULATED';
export type SensorHealthStatus = 'UNKNOWN' | 'ONLINE' | 'STALE' | 'DISCONNECTED' | 'FAULT';
export type SensorCalibrationStatus = 'UNKNOWN' | 'CURRENT' | 'DUE';
export type SensorIncidentSeverity = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export type SensorIncidentState = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type SimulationScenario =
  | 'NORMAL'
  | 'OVERHEATING'
  | 'EXCESSIVE_VIBRATION'
  | 'UNUSUAL_NOISE'
  | 'SMOKE_INDICATION'
  | 'SPAGHETTI'
  | 'LAYER_SHIFT'
  | 'POOR_BED_ADHESION'
  | 'COMBINED_FAILURES';
export type SimulationStatus = 'RUNNING' | 'PAUSED' | 'STOPPED';

export interface SensorReading {
  id: string;
  sensor_id: string;
  machine_id: string;
  observed_at: string;
  received_at: string;
  value: number;
  unit: string;
  event_type: string | null;
  alarm_detected: boolean | null;
  provenance: SensorProvenance;
  details?: Record<string, number | boolean | string>;
  source_event_id?: string | null;
}

export interface SensorHealthEvent {
  id: string;
  sensor_id: string;
  machine_id: string;
  from_status: SensorHealthStatus;
  to_status: SensorHealthStatus;
  reason: string;
  created_at: string;
}

export interface SensorDevice {
  id: string;
  machine_id: string;
  name: string;
  sensor_type: SensorType;
  adapter_type: SensorAdapterType;
  provenance: SensorProvenance;
  unit: string;
  enabled: boolean;
  health_status: SensorHealthStatus;
  calibration_due_at: string | null;
  calibration_status: SensorCalibrationStatus;
  last_seen_at: string | null;
  last_reading_at: string | null;
  latest_reading: SensorReading | null;
  recent_readings?: SensorReading[];
  health_events?: SensorHealthEvent[];
  health_changed?: boolean;
}

export interface SensorIncidentEvent {
  id: string;
  incident_id: string;
  machine_id: string;
  from_state: 'OPEN' | 'ACKNOWLEDGED';
  to_state: 'ACKNOWLEDGED' | 'RESOLVED';
  operator_notes: string | null;
  created_at: string;
}

export interface SensorIncident {
  id: string;
  machine_id: string;
  category: string;
  severity: SensorIncidentSeverity;
  state: SensorIncidentState;
  summary: string;
  explanation: string;
  possible_root_causes: string[];
  recommended_actions: string[];
  evidence: Record<string, unknown>;
  fusion_score: number;
  first_detected_at: string;
  latest_detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  operator_notes: string | null;
  lifecycle_events?: SensorIncidentEvent[];
}

export interface SensorSignal {
  category: string;
  severity: SensorIncidentSeverity;
  description: string;
  possibleRootCauses: string[];
  recommendedActions: string[];
  evidence: Record<string, unknown> & { provenance?: SensorProvenance };
}

export interface SensorFusionResult {
  machine_id: string;
  sampled_at: string;
  risk_level: SensorIncidentSeverity | 'NORMAL' | 'UNAVAILABLE';
  risk_score: number;
  explanation: string;
  coverage: {
    status: 'COMPLETE' | 'PARTIAL';
    modalities: Array<{
      type: SensorType;
      status: 'AVAILABLE' | 'UNAVAILABLE';
      sensor_count: number;
      online_sensor_count: number;
      reason: string | null;
    }>;
    vision_status: 'AVAILABLE' | 'UNAVAILABLE';
    trend_status: 'AVAILABLE' | 'INSUFFICIENT_DATA';
    active_job: {
      id: string;
      name: string;
      status: string;
      machine_type: string;
    } | null;
  };
  signals: SensorSignal[];
  evidence: Record<string, unknown>;
  data_provenance: SensorProvenance | 'MIXED' | 'UNAVAILABLE';
  risk_sources: Array<{
    provenance: SensorProvenance;
    source: string;
    severity: SensorIncidentSeverity;
    categories: string[];
  }>;
  simulation: {
    id: string;
    scenario: SimulationScenario;
    scenario_label: string;
    status: SimulationStatus;
    speed: number;
    run_number: number;
    tick_count: number;
    started_at: string;
    provenance: 'SIMULATED';
  } | null;
  possible_root_causes: string[];
  recommended_actions: string[];
  provenance: SensorProvenance | 'MIXED' | 'NONE';
  trigger_sensor: SensorDevice | null;
  fusion_id?: string;
  incident?: SensorIncident | null;
}

export interface SimulationReading extends SensorReading {
  sensor_type: SensorType;
  run_number: number;
  tick_number: number;
  scenario: SimulationScenario;
  provenance: 'SIMULATED';
}

export interface SimulationSession {
  id: string;
  machine_id: string;
  scenario: SimulationScenario;
  scenario_label: string;
  status: SimulationStatus;
  speed: 0.25 | 0.5 | 1 | 2 | 4;
  run_number: number;
  tick_count: number;
  replay_of_session_id: string | null;
  started_at: string;
  paused_at: string | null;
  stopped_at: string | null;
  reset_at: string | null;
  created_at: string;
  updated_at: string;
  readings: SimulationReading[];
}

export interface SimulationSessionList {
  sessions: SimulationSession[];
  active_session: Omit<SimulationSession, 'readings'> | null;
}

export interface PersistedSensorFusion {
  id: string;
  machine_id: string;
  trigger_reading_id: string | null;
  incident_id: string | null;
  risk_level: SensorIncidentSeverity | 'NORMAL' | 'UNAVAILABLE';
  risk_score: number;
  evidence: Record<string, unknown>;
  explanation: string;
  created_at: string;
}

export interface SensorIntelligenceSnapshot {
  machine_id: string;
  machine_label: string;
  sensors: SensorDevice[];
  incidents: SensorIncident[];
  current_fusion: SensorFusionResult;
  last_fusion: PersistedSensorFusion | null;
  trend: Record<string, unknown> | null;
  active_job: SensorFusionResult['coverage']['active_job'];
}
