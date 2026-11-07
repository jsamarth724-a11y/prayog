CREATE TABLE IF NOT EXISTS sensors (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sensor_type TEXT NOT NULL CHECK (sensor_type IN ('SOUND', 'VIBRATION', 'TEMPERATURE', 'SMOKE')),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('ESP32', 'USB', 'SERIAL', 'MQTT', 'NETWORK')),
  provenance TEXT NOT NULL CHECK (provenance IN ('REAL', 'SIMULATED')),
  unit TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  health_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (health_status IN ('UNKNOWN', 'ONLINE', 'STALE', 'DISCONNECTED', 'FAULT')),
  calibration_due_at TEXT,
  last_seen_at TEXT,
  last_reading_at TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sensors_machine_enabled ON sensors(machine_id, enabled, sensor_type);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id TEXT PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  event_type TEXT,
  alarm_detected INTEGER CHECK (alarm_detected IS NULL OR alarm_detected IN (0, 1)),
  details TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL CHECK (provenance IN ('REAL', 'SIMULATED')),
  source_event_id TEXT,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE RESTRICT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT,
  UNIQUE (sensor_id, source_event_id),
  UNIQUE (sensor_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_machine_time ON sensor_readings(machine_id, observed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_time ON sensor_readings(sensor_id, observed_at DESC, id);

CREATE TABLE IF NOT EXISTS sensor_health_events (
  id TEXT PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  from_status TEXT NOT NULL CHECK (from_status IN ('UNKNOWN', 'ONLINE', 'STALE', 'DISCONNECTED', 'FAULT')),
  to_status TEXT NOT NULL CHECK (to_status IN ('UNKNOWN', 'ONLINE', 'STALE', 'DISCONNECTED', 'FAULT')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE RESTRICT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sensor_health_history ON sensor_health_events(sensor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sensor_incidents (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  summary TEXT NOT NULL,
  explanation TEXT NOT NULL,
  possible_root_causes TEXT NOT NULL,
  recommended_actions TEXT NOT NULL,
  evidence TEXT NOT NULL,
  fusion_score INTEGER NOT NULL CHECK (fusion_score BETWEEN 0 AND 100),
  first_detected_at TEXT NOT NULL,
  latest_detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_incidents_open_category
  ON sensor_incidents(machine_id, category) WHERE state IN ('OPEN', 'ACKNOWLEDGED');
CREATE INDEX IF NOT EXISTS idx_sensor_incidents_machine_state
  ON sensor_incidents(machine_id, state, latest_detected_at DESC);

CREATE TABLE IF NOT EXISTS sensor_fusion_results (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  trigger_reading_id TEXT,
  incident_id TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('UNAVAILABLE', 'NORMAL', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  evidence TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_reading_id) REFERENCES sensor_readings(id) ON DELETE RESTRICT,
  FOREIGN KEY (incident_id) REFERENCES sensor_incidents(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sensor_fusion_machine_time ON sensor_fusion_results(machine_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sensor_incident_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  from_state TEXT NOT NULL CHECK (from_state IN ('OPEN', 'ACKNOWLEDGED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('ACKNOWLEDGED', 'RESOLVED')),
  operator_notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES sensor_incidents(id) ON DELETE RESTRICT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sensor_incident_events_history ON sensor_incident_events(incident_id, created_at DESC);
