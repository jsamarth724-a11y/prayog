import { randomBytes } from "node:crypto";

export const SENSOR_TYPES = Object.freeze(["SOUND", "VIBRATION", "TEMPERATURE", "SMOKE"]);
export const ADAPTER_TYPES = Object.freeze(["ESP32", "USB", "SERIAL", "MQTT", "NETWORK"]);
export const SENSOR_UNITS = Object.freeze({
  SOUND: ["dBA"],
  VIBRATION: ["g", "m/s2"],
  TEMPERATURE: ["°C"],
  SMOKE: ["ppm"],
});

const EVENT_TYPES = Object.freeze({
  SOUND: new Set(["GRINDING", "RATTLING", "SQUEAKING", "IMPACT", "UNUSUAL_NOISE"]),
  VIBRATION: new Set(["ABNORMAL_VIBRATION", "MOVEMENT", "MECHANICAL_INSTABILITY"]),
  TEMPERATURE: new Set(["OVERHEATING"]),
  SMOKE: new Set(["SMOKE_SUSPECTED", "SMOKE_ALARM"]),
});
const ALLOWED_READING_FIELDS = new Set([
  "sensor_id",
  "observed_at",
  "value",
  "unit",
  "event_type",
  "alarm_detected",
  "source_event_id",
  "details",
]);
const ALLOWED_DETAIL_FIELDS = new Set([
  "rms",
  "peak",
  "window_ms",
  "frequency_hz",
  "axes",
  "quality",
  "sample_count",
  "alarm_code",
  "spectral_flags",
]);

export const SENSOR_ADAPTERS = Object.freeze({
  ESP32: Object.freeze({ type: "ESP32", transport: "HTTP JSON ingestion; device firmware adapter contract" }),
  USB: Object.freeze({ type: "USB", transport: "Local gateway adapter contract; no device driver installed" }),
  SERIAL: Object.freeze({ type: "SERIAL", transport: "Serial gateway adapter contract; no port opened" }),
  MQTT: Object.freeze({ type: "MQTT", transport: "Broker bridge adapter contract; no broker connection opened" }),
  NETWORK: Object.freeze({ type: "NETWORK", transport: "Network gateway adapter contract; no device connection opened" }),
});

export function createSensorCredential() {
  return randomBytes(32).toString("base64url");
}

export function normalizeSensorRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "A JSON object is required." };
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const type = String(input.sensor_type || "").toUpperCase();
  const adapterType = String(input.adapter_type || "").toUpperCase();
  const provenance = String(input.provenance || "").toUpperCase();
  const unit = String(input.unit || "");
  if (!name || name.length > 100) return { error: "Sensor name must be 1–100 characters." };
  if (!SENSOR_TYPES.includes(type)) return { error: "Sensor type must be SOUND, VIBRATION, TEMPERATURE, or SMOKE." };
  if (!ADAPTER_TYPES.includes(adapterType)) return { error: "Adapter type must be ESP32, USB, SERIAL, MQTT, or NETWORK." };
  if (!["REAL", "SIMULATED"].includes(provenance)) return { error: "Provenance must explicitly be REAL or SIMULATED." };
  if (!SENSOR_UNITS[type].includes(unit)) return { error: `Unsupported unit for ${type}.` };

  let calibrationDueAt = null;
  if (input.calibration_due_at !== undefined && input.calibration_due_at !== null && input.calibration_due_at !== "") {
    calibrationDueAt = normalizeCalibrationTimestamp(input.calibration_due_at);
    if (!calibrationDueAt) return { error: "calibration_due_at must be a valid ISO timestamp within one year." };
  }
  return { value: { name, type, adapterType, provenance, unit, calibrationDueAt } };
}

function normalizeTimestamp(value, { now = Date.now(), maxFutureMs = 5 * 60 * 1000, maxPastMs = 24 * 60 * 60 * 1000 } = {}) {
  if (typeof value !== "string" || value.length > 40) return null;
  const timestampParts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!timestampParts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = timestampParts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? isLeapYear ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59 ||
      (offsetHourText && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > now + maxFutureMs || milliseconds < now - maxPastMs) return null;
  return new Date(milliseconds).toISOString();
}

export function normalizeCalibrationTimestamp(value) {
  return normalizeTimestamp(value, {
    maxFutureMs: 365 * 24 * 60 * 60 * 1000,
    maxPastMs: Number.MAX_SAFE_INTEGER,
  });
}

function normalizeDetails(input) {
  const details = input.details ?? {};
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const entries = Object.entries(details);
  if (entries.length > 12) return null;
  const safe = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_DETAIL_FIELDS.has(key)) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      safe[key] = Math.round(value * 1000) / 1000;
    } else if (typeof value === "boolean" || (typeof value === "string" && value.length <= 80)) {
      safe[key] = value;
    } else {
      return null;
    }
  }
  if (JSON.stringify(safe).length > 1024) return null;
  return safe;
}

export function normalizeSensorReading(sensor, input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "A JSON reading object is required." };
  }
  if (input.sensor_id !== undefined && input.sensor_id !== sensor.id) {
    return { error: "Reading sensor_id does not match the authenticated sensor." };
  }
  if (Object.keys(input).some((key) => !ALLOWED_READING_FIELDS.has(key))) {
    return { error: "Reading contains unsupported fields. Raw audio, waveform, video, and unbounded sensor payloads are not accepted." };
  }
  const observedAt = normalizeTimestamp(input.observed_at, { now });
  if (!observedAt) return { error: "observed_at must be a recent ISO timestamp (not more than 5 minutes in the future or 24 hours old)." };
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return { error: "value must be a finite number." };
  }
  if (input.unit !== sensor.unit) return { error: `Reading unit must match the registered unit (${sensor.unit}).` };
  if (input.source_event_id !== undefined &&
      (typeof input.source_event_id !== "string" || input.source_event_id.length < 1 || input.source_event_id.length > 120)) {
    return { error: "source_event_id must be 1–120 characters." };
  }
  const eventType = input.event_type === undefined || input.event_type === null || input.event_type === ""
    ? null
    : String(input.event_type).toUpperCase();
  if (eventType && !EVENT_TYPES[sensor.sensor_type]?.has(eventType)) {
    return { error: `event_type is not valid for ${sensor.sensor_type}.` };
  }
  if (input.alarm_detected !== undefined && typeof input.alarm_detected !== "boolean") {
    return { error: "alarm_detected must be a boolean." };
  }
  const details = normalizeDetails(input);
  if (!details) return { error: "details must contain only bounded scalar summaries; raw audio and high-frequency payloads are not accepted." };

  let value = input.value;
  let unit = sensor.unit;
  const ranges = {
    SOUND: [0, 160],
    VIBRATION: [0, sensor.unit === "g" ? 100 : 100 * 9.80665],
    TEMPERATURE: [-50, 1000],
    SMOKE: [0, 1_000_000],
  };
  const [minimum, maximum] = ranges[sensor.sensor_type];
  if (value < minimum || value > maximum) return { error: `value must be between ${minimum} and ${maximum} ${sensor.unit}.` };
  if (sensor.sensor_type === "VIBRATION" && sensor.unit === "m/s2") {
    value /= 9.80665;
    unit = "g";
  }
  return {
    value: {
      observedAt,
      value: Math.round(value * 1000) / 1000,
      unit,
      eventType,
      alarmDetected: input.alarm_detected ?? null,
      sourceEventId: input.source_event_id || null,
      details,
    },
  };
}

export function normalizeAdapterPayload(adapterType, payload) {
  const normalizedType = String(adapterType || "").toUpperCase();
  if (!SENSOR_ADAPTERS[normalizedType]) return { error: "Unsupported sensor adapter." };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Adapter payload must be a JSON object." };
  }
  return { value: payload };
}
