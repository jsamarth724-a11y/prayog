export const MAX_GCODE_BYTES = 2 * 1024 * 1024;
const MAX_GCODE_LINES = 100_000;
const MAX_LINE_LENGTH = 4096;

const MACHINE_DIALECTS = Object.freeze({
  "3d_printer": {
    label: "FDM 3D printer",
    allowedExtensions: new Set([".gcode", ".gco", ".gc"]),
  },
  cnc: {
    label: "CNC",
    allowedExtensions: new Set([".nc", ".ngc", ".tap", ".gcode"]),
  },
  laser_cutter: {
    label: "Laser cutter",
    allowedExtensions: new Set([".nc", ".ngc", ".tap", ".gcode"]),
  },
});

const SUPPORTED_COMMANDS = new Set([
  "G0", "G1", "G2", "G3", "G4", "G10", "G17", "G18", "G19", "G20", "G21",
  "G28", "G40", "G43", "G49", "G53", "G54", "G55", "G56", "G57", "G58",
  "G59", "G80", "G90", "G91", "G92", "G94",
  "M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M30",
  "M82", "M83", "M104", "M105", "M106", "M107", "M109", "M140", "M190",
  "M204", "M205", "M206", "M207", "M208", "M400", "M600", "M900",
]);
const REVIEW_COMMANDS = new Set(["M112", "M500", "M501", "M502", "M999"]);
const MOVEMENT_COMMANDS = new Set(["G0", "G1", "G2", "G3"]);

function stripComments(line) {
  const semicolon = line.indexOf(";");
  const program = semicolon >= 0 ? line.slice(0, semicolon) : line;
  let output = "";
  let inComment = false;
  let malformed = false;
  for (const character of program) {
    if (character === "(") {
      if (inComment) malformed = true;
      inComment = true;
    } else if (character === ")") {
      if (!inComment) malformed = true;
      inComment = false;
    } else if (!inComment) {
      output += character;
    }
  }
  return { code: output, malformed: malformed || inComment };
}

function wordsFor(line) {
  const words = new Map();
  const expression = /([A-Z])\s*(-?\d+(?:\.\d+)?)/gi;
  for (const match of line.matchAll(expression)) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) words.set(match[1].toUpperCase(), value);
  }
  return words;
}

function parseSlicerDuration(line) {
  const compact = line.match(/;\s*TIME\s*:\s*(\d+)\s*$/i);
  if (compact) return Number(compact[1]);
  const descriptive = line.match(
    /;\s*estimated printing time.*?=\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i,
  );
  if (!descriptive || !descriptive.slice(1).some(Boolean)) return null;
  return Number(descriptive[1] || 0) * 3600 +
    Number(descriptive[2] || 0) * 60 +
    Number(descriptive[3] || 0);
}

export function validateGcodeFilename(filename, machineType) {
  const dialect = MACHINE_DIALECTS[machineType];
  if (!dialect) {
    throw new Error("Machine type must be 3d_printer, cnc, or laser_cutter.");
  }
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) {
    throw new Error("A filename of at most 255 characters is required.");
  }
  const safeName = filename.trim();
  if (
    !safeName ||
    safeName === "." ||
    safeName === ".." ||
    /[\\/]/.test(safeName) ||
    /[\u0000-\u001f]/.test(safeName)
  ) {
    throw new Error("The G-code filename is invalid.");
  }
  const extension = safeName.slice(safeName.lastIndexOf(".")).toLowerCase();
  if (!dialect.allowedExtensions.has(extension)) {
    throw new Error(`Unsupported file extension for ${dialect.label}.`);
  }
  return safeName;
}

export function parseGcode(input, machineType) {
  const dialect = MACHINE_DIALECTS[machineType];
  if (!dialect) throw new Error("Unsupported machine type for G-code parsing.");
  if (typeof input !== "string" || !input.length) throw new Error("The G-code file is empty.");
  if (Buffer.byteLength(input, "utf8") > MAX_GCODE_BYTES) {
    throw new Error(`The G-code file exceeds the ${MAX_GCODE_BYTES} byte limit.`);
  }
  if (input.includes("\0")) throw new Error("The G-code file contains binary data.");

  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length > MAX_GCODE_LINES) {
    throw new Error(`The G-code file exceeds the ${MAX_GCODE_LINES} line limit.`);
  }

  let programLineCount = 0;
  let movementCommandCount = 0;
  let extrusionMoveLineCount = 0;
  let negativeExtrusionWordCount = 0;
  let toolChangeCount = 0;
  let layerMarkers = 0;
  let maximumFeedRate = null;
  let nozzleTargets = new Set();
  let bedTargets = new Set();
  let spindleCommands = 0;
  let spindleSpeedCommands = 0;
  let programEndPresent = false;
  let slicerEstimatedDurationSeconds = null;
  let layerHeightMm = null;
  let malformedCommentLines = 0;
  const unsupportedCommands = new Set();
  const commands = new Set();
  const operatorReviewCommands = new Set();

  for (const rawLine of lines) {
    if (rawLine.length > MAX_LINE_LENGTH) {
      throw new Error(`A G-code line exceeds the ${MAX_LINE_LENGTH} character limit.`);
    }
    if (/;\s*(?:LAYER(?:_CHANGE)?\s*:|CHANGE_LAYER\b)/i.test(rawLine)) layerMarkers += 1;
    const duration = parseSlicerDuration(rawLine);
    if (duration !== null && Number.isFinite(duration) && duration > 0) {
      slicerEstimatedDurationSeconds = duration;
    }
    const height = rawLine.match(/;\s*layer[_ ]height\s*=\s*(\d+(?:\.\d+)?)/i);
    if (height) {
      const value = Number(height[1]);
      if (Number.isFinite(value) && value > 0 && value <= 10) layerHeightMm = value;
    }

    const { code, malformed } = stripComments(rawLine);
    if (malformed) malformedCommentLines += 1;
    const trimmed = code.trim();
    if (!trimmed) continue;
    programLineCount += 1;

    const words = wordsFor(trimmed);
    const commandMatch = trimmed.match(/^\s*(?:N\s*\d+\s*)?([GMT])\s*(\d+(?:\.\d+)?)/i);
    if (!commandMatch) continue;
    const letter = commandMatch[1].toUpperCase();
    const commandNumber = Number(commandMatch[2]);
    const command = `${letter}${Number.isInteger(commandNumber) ? commandNumber : commandNumber}`;
    commands.add(command);
    if (letter === "G" || letter === "M") {
      if (!SUPPORTED_COMMANDS.has(command)) unsupportedCommands.add(command);
      if (REVIEW_COMMANDS.has(command)) operatorReviewCommands.add(command);
    }
    if (letter === "T") toolChangeCount += 1;
    if (MOVEMENT_COMMANDS.has(command)) {
      movementCommandCount += 1;
      if (words.has("E")) {
        extrusionMoveLineCount += 1;
        if (words.get("E") < 0) negativeExtrusionWordCount += 1;
      }
      if (words.has("F")) {
        maximumFeedRate = Math.max(maximumFeedRate || 0, words.get("F"));
      }
    }
    if (["M104", "M109"].includes(command) && words.has("S")) nozzleTargets.add(words.get("S"));
    if (["M140", "M190"].includes(command) && words.has("S")) bedTargets.add(words.get("S"));
    if (["M3", "M4", "M5"].includes(command)) {
      spindleCommands += 1;
      if (words.has("S")) spindleSpeedCommands += 1;
    }
    if (["M2", "M30"].includes(command)) programEndPresent = true;
  }

  if (malformedCommentLines > 0) {
    throw new Error("The G-code file contains an unterminated or unmatched parenthetical comment.");
  }
  if (programLineCount === 0 || commands.size === 0) {
    throw new Error("The file contains no parseable G-code commands.");
  }

  return {
    dialect: machineType,
    dialect_label: dialect.label,
    program_line_count: programLineCount,
    command_count: commands.size,
    movement_command_count: movementCommandCount,
    extrusion_move_line_count: machineType === "3d_printer" ? extrusionMoveLineCount : null,
    negative_extrusion_word_count: machineType === "3d_printer" ? negativeExtrusionWordCount : null,
    layer_marker_count: machineType === "3d_printer" ? layerMarkers : null,
    layer_height_mm: machineType === "3d_printer" ? layerHeightMm : null,
    nozzle_temperature_targets_c: machineType === "3d_printer" ? [...nozzleTargets].sort((a, b) => a - b) : [],
    bed_temperature_targets_c: machineType === "3d_printer" ? [...bedTargets].sort((a, b) => a - b) : [],
    maximum_feed_rate: maximumFeedRate,
    tool_change_count: machineType === "cnc" ? toolChangeCount : null,
    spindle_command_count: machineType === "cnc" ? spindleCommands : null,
    spindle_speed_command_count: machineType === "cnc" ? spindleSpeedCommands : null,
    laser_power_command_count: machineType === "laser_cutter" ? spindleCommands : null,
    laser_power_value_command_count: machineType === "laser_cutter" ? spindleSpeedCommands : null,
    program_end_present: programEndPresent,
    slicer_estimated_duration_seconds: slicerEstimatedDurationSeconds,
    duration_estimate_source: slicerEstimatedDurationSeconds === null ? null : "gcode_slicer_comment",
    unsupported_commands: [...unsupportedCommands].sort(),
    operator_review_commands: [...operatorReviewCommands].sort(),
    malformed_comment_line_count: malformedCommentLines,
    material_usage_estimate: null,
    physical_execution_verified: false,
  };
}
