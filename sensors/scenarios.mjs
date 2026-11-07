export const SIMULATION_SCENARIOS = Object.freeze({
  NORMAL: Object.freeze({
    label: "Normal operation",
    severity: null,
    description: "Stable deterministic baseline across all virtual sensor modalities.",
  }),
  OVERHEATING: Object.freeze({
    label: "Overheating",
    severity: "HIGH",
    description: "Temperature rises into an over-limit range.",
  }),
  EXCESSIVE_VIBRATION: Object.freeze({
    label: "Excessive vibration",
    severity: "HIGH",
    description: "Vibration rises to represent mechanical instability.",
  }),
  UNUSUAL_NOISE: Object.freeze({
    label: "Unusual noise",
    severity: "HIGH",
    description: "Sound level rises and a grinding event is explicitly injected.",
  }),
  SMOKE_INDICATION: Object.freeze({
    label: "Smoke indication",
    severity: "CRITICAL",
    description: "A virtual smoke sensor reports an alarm-level indication.",
  }),
  SPAGHETTI: Object.freeze({
    label: "Spaghetti",
    severity: "MODERATE",
    description: "An injected visual-failure scenario; it is not a camera AI result.",
  }),
  LAYER_SHIFT: Object.freeze({
    label: "Layer shift",
    severity: "MODERATE",
    description: "An injected visual-failure scenario; it is not a camera AI result.",
  }),
  POOR_BED_ADHESION: Object.freeze({
    label: "Poor bed adhesion",
    severity: "MODERATE",
    description: "An injected visual-failure scenario; it is not a camera AI result.",
  }),
  COMBINED_FAILURES: Object.freeze({
    label: "Combined failures",
    severity: "CRITICAL",
    description: "Deterministic temperature, vibration, noise, and smoke faults are combined.",
  }),
});

export const PRINTER_ONLY_SCENARIOS = Object.freeze(["SPAGHETTI", "LAYER_SHIFT", "POOR_BED_ADHESION"]);

const BASE_SAMPLE = Object.freeze({
  SOUND: Object.freeze({ value: 48, unit: "dBA", eventType: null, alarmDetected: null }),
  VIBRATION: Object.freeze({ value: 0.12, unit: "g", eventType: null, alarmDetected: null }),
  TEMPERATURE: Object.freeze({ value: 42, unit: "°C", eventType: null, alarmDetected: null }),
  SMOKE: Object.freeze({ value: 0, unit: "ppm", eventType: null, alarmDetected: false }),
});

const RAMP = Object.freeze({
  OVERHEATING: Object.freeze([
    Object.freeze({ TEMPERATURE: 66 }),
    Object.freeze({ TEMPERATURE: 74 }),
    Object.freeze({ TEMPERATURE: 82 }),
    Object.freeze({ TEMPERATURE: 90 }),
    Object.freeze({ TEMPERATURE: 96 }),
  ]),
  EXCESSIVE_VIBRATION: Object.freeze([
    Object.freeze({ VIBRATION: 0.45 }),
    Object.freeze({ VIBRATION: 0.72 }),
    Object.freeze({ VIBRATION: 1.05 }),
    Object.freeze({ VIBRATION: 1.35 }),
  ]),
  UNUSUAL_NOISE: Object.freeze([
    Object.freeze({ SOUND: 78 }),
    Object.freeze({ SOUND: 92 }),
    Object.freeze({ SOUND: 108 }),
    Object.freeze({ SOUND: 118 }),
  ]),
  SMOKE_INDICATION: Object.freeze([
    Object.freeze({ SMOKE: 8 }),
    Object.freeze({ SMOKE: 18 }),
    Object.freeze({ SMOKE: 35 }),
    Object.freeze({ SMOKE: 65 }),
  ]),
  COMBINED_FAILURES: Object.freeze([
    Object.freeze({ TEMPERATURE: 72, VIBRATION: 0.72, SOUND: 92, SMOKE: 12 }),
    Object.freeze({ TEMPERATURE: 82, VIBRATION: 1.05, SOUND: 108, SMOKE: 35 }),
    Object.freeze({ TEMPERATURE: 96, VIBRATION: 1.35, SOUND: 118, SMOKE: 65 }),
  ]),
});

export function getSimulationSample(scenario, tickNumber) {
  if (!SIMULATION_SCENARIOS[scenario]) throw new RangeError(`Unknown simulation scenario "${scenario}".`);
  if (!Number.isInteger(tickNumber) || tickNumber < 1) throw new RangeError("Simulation tickNumber must be a positive integer.");
  const sample = Object.fromEntries(
    Object.entries(BASE_SAMPLE).map(([type, reading]) => [type, { ...reading }]),
  );
  const sequence = RAMP[scenario];
  if (sequence?.length) {
    const step = sequence[Math.min(tickNumber - 1, sequence.length - 1)];
    for (const [type, value] of Object.entries(step)) sample[type].value = value;
  }
  if (scenario === "OVERHEATING") sample.TEMPERATURE.eventType = "OVERHEATING";
  if (scenario === "EXCESSIVE_VIBRATION") sample.VIBRATION.eventType = "MECHANICAL_INSTABILITY";
  if (scenario === "UNUSUAL_NOISE") sample.SOUND.eventType = "GRINDING";
  if (scenario === "SMOKE_INDICATION" || scenario === "COMBINED_FAILURES") {
    sample.SMOKE.eventType = "SMOKE_ALARM";
    sample.SMOKE.alarmDetected = true;
  }
  return sample;
}

export const SIMULATION_SENSOR_TYPES = Object.freeze(["SOUND", "VIBRATION", "TEMPERATURE", "SMOKE"]);
