CREATE TABLE IF NOT EXISTS simulation_sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN (
    'NORMAL', 'OVERHEATING', 'EXCESSIVE_VIBRATION', 'UNUSUAL_NOISE',
    'SMOKE_INDICATION', 'SPAGHETTI', 'LAYER_SHIFT', 'POOR_BED_ADHESION',
    'COMBINED_FAILURES'
  )),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED')),
  speed REAL NOT NULL CHECK (speed IN (0.25, 0.5, 1, 2, 4)),
  run_number INTEGER NOT NULL DEFAULT 1 CHECK (run_number >= 1),
  tick_count INTEGER NOT NULL DEFAULT 0 CHECK (tick_count >= 0),
  replay_of_session_id TEXT,
  started_at TEXT NOT NULL,
  paused_at TEXT,
  stopped_at TEXT,
  reset_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT,
  FOREIGN KEY (replay_of_session_id) REFERENCES simulation_sessions(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_active_machine
  ON simulation_sessions(machine_id) WHERE status IN ('RUNNING', 'PAUSED');
CREATE INDEX IF NOT EXISTS idx_simulation_sessions_machine_time
  ON simulation_sessions(machine_id, created_at DESC);

CREATE TABLE IF NOT EXISTS simulation_session_sensors (
  session_id TEXT NOT NULL,
  sensor_type TEXT NOT NULL CHECK (sensor_type IN ('SOUND', 'VIBRATION', 'TEMPERATURE', 'SMOKE')),
  sensor_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (session_id, sensor_type),
  FOREIGN KEY (session_id) REFERENCES simulation_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS simulation_readings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sensor_reading_id TEXT NOT NULL UNIQUE,
  run_number INTEGER NOT NULL CHECK (run_number >= 1),
  tick_number INTEGER NOT NULL CHECK (tick_number >= 1),
  scenario TEXT NOT NULL CHECK (scenario IN (
    'NORMAL', 'OVERHEATING', 'EXCESSIVE_VIBRATION', 'UNUSUAL_NOISE',
    'SMOKE_INDICATION', 'SPAGHETTI', 'LAYER_SHIFT', 'POOR_BED_ADHESION',
    'COMBINED_FAILURES'
  )),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, run_number, tick_number, sensor_reading_id),
  FOREIGN KEY (session_id) REFERENCES simulation_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (sensor_reading_id) REFERENCES sensor_readings(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_simulation_readings_session_time
  ON simulation_readings(session_id, run_number DESC, tick_number DESC);
