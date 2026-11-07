# Watch Guard — project guide, demo notes, and hackathon rating

This file captures how the project works, how to run and test it without a real machine, and an honest take on hackathon competitiveness.

---

## What this project is

**Watch Guard** is an AI-powered fabrication monitoring camera for 3D printers, CNC machines, laser cutters, and maker spaces.

It does not only record video. It watches a machine, looks for early failure or safety risk, and helps the operator understand what went wrong.

Typical detections:

- 3D print spaghetti, poor bed adhesion, layer shift
- Laser smoke or flame risk
- CNC workpiece movement, chip buildup, tool chatter
- Idle vs printing vs needs attention
- Filament color on a visible part

When something looks wrong it can:

- Change status on the dashboard
- Draw a box on the failure region
- Alert on Discord
- Capture a snapshot
- Optionally pause the printer (OctoPrint or Moonraker)

Hardware is meant to be a simple USB webcam (orb-style enclosure + RGB light in the product story). The laptop camera is enough to test.

---

## What it is based on (tech stack)

This is **not** a trained computer-vision model. It is a **vision-LLM operations prototype**.

| Layer | What it uses |
| --- | --- |
| UI | `public/index.html` — HTML, CSS, vanilla JavaScript (no React/Vue) |
| Backend | Node.js ESM — `server.mjs` with Express 5 |
| AI | Groq (`groq-sdk`), default vision model `qwen/qwen3.8-27b` |
| Live updates | WebSockets (`ws`) |
| Alerts | Discord webhooks in `notifications.mjs` |
| Printer control | Optional OctoPrint or Moonraker pause API |
| Config | `.env` via `dotenv` |

### Request path

```text
Webcam
  → browser getUserMedia + canvas JPEG/base64
  → POST /api/analyze-machine
  → Groq chat completion with image(s)
  → JSON parse + normalizeResult()
  → SQLite analysis history + dashboard overlay, Discord, optional printer pause
```

### SQLite analysis history (Phase 1)

The server uses `better-sqlite3`, a synchronous SQLite driver that keeps short,
parameterized writes in the existing Node.js request flow without introducing
an asynchronous ORM or a second service. The connection enables WAL mode and
foreign-key checks. Migrations run transactionally before the HTTP listener
starts.

The default database is `data/visionops.db` (outside `public/` and ignored by
Git). Set `VISION_OPS_DB_PATH` to an absolute or relative file path to use a
different database.

The server loads `.env` from the directory containing `server.mjs`, regardless
of the shell's current directory. Existing process environment variables take
precedence over values in `.env`. Provider and model settings are read at
startup; changing `.env` requires restarting the server, or selecting the model
through the setup screen/API. `GET /api/config` reports the active provider,
model, and non-secret source fields (`providerSource`, `modelSource`) so a
stale process or environment override can be distinguished without exposing a
key.

| Table | Purpose and relationship |
| --- | --- |
| `machines` | One persistent UUID v4 and label/type per registered machine. |
| `machine_cameras` | Maps a camera device ID (primary key) to one machine UUID. A changed/unknown ID gets a new machine; names are never used to merge machines. |
| `analysis_records` | Valid results and invalid-attempt audit records. Machine association is nullable when it is unknown; invalid rows must have a NULL score. |
| `trend_snapshots` | Reserved legacy table; Phase 2 calculates live trends from valid `analysis_records`. |
| `early_warnings` | Persistent machine/category warnings with evidence, operator notes, and ACTIVE/ACKNOWLEDGED/RESOLVED state. |
| `jobs` | Machine-assigned jobs, intended parameters, operator-managed lifecycle, and timestamps. |
| `job_files` | One private G-code/NC source per job with digest and parsed summary; never served as static content. |
| `analysis_records.job_id` | Nullable link from camera analysis/audit row to the job active when analysis was requested. |
| `job_deviations` | Persistent repeated-failure evidence, original evidence snapshot, ACTIVE/ACKNOWLEDGED/RESOLVED state, operator notes, and lifecycle timestamps. |
| `deviation_lifecycle_events` | Immutable acknowledgment/resolution transitions and operator notes. |
| `root_cause_reports` | Validated AI hypotheses, separately stored observed facts, provider state, and evidence fingerprint. |
| `job_comparisons` | Persisted expected-vs-observed evidence comparisons with classification and confidence. |
| `job_completion_verifications` | Append-only verification evaluations and separate operator completion assertions. |
| `sensors` | Machine-assigned sensor registrations, hashed device credentials, provenance, calibration due date, and health state. |
| `sensor_readings` | Bounded, normalized measurement summaries with observed/received times and REAL/SIMULATED provenance; no raw audio or waveforms. |
| `sensor_health_events` | Auditable transitions between UNKNOWN, ONLINE, STALE, DISCONNECTED, and FAULT. |
| `sensor_incidents` | Deduplicated machine-level risk incidents, evidence, possible causes, recommended actions, and operator lifecycle. |
| `sensor_incident_events` | Persisted acknowledge/resolve transitions and operator notes. |
| `sensor_fusion_results` | Timestamped fusion outputs linked to the machine, optional triggering reading, and incident. |
| `copilot_conversations` | Conversation title, optional machine association, browser-session owner token, and timestamps. |
| `copilot_messages` | User/assistant messages and bounded evidence references; deleted with the conversation. |
| `schema_migrations` | Applied migration filenames and timestamps. |

```text
machines 1 ─── * machine_cameras
machines 1 ─── * analysis_records
machines 1 ─── * trend_snapshots
machines 1 ─── * early_warnings
machines 1 ─── * jobs 1 ─── 0..1 job_files
jobs 1 ─── * job_deviations
job_deviations 1 ─── * deviation_lifecycle_events
job_deviations 1 ─── * root_cause_reports
jobs 1 ─── * job_comparisons
jobs 1 ─── * job_completion_verifications
jobs 1 ─── * analysis_records (optional job_id)
machines 1 ─── * sensors 1 ─── * sensor_readings
sensors 1 ─── * sensor_health_events
machines 1 ─── * sensor_incidents 1 ─── * sensor_incident_events
machines 1 ─── * sensor_fusion_results
copilot_conversations 1 ─── * copilot_messages
```

The browser's `cameraId` is the current `MediaDeviceInfo.deviceId`, not a
permanent hardware identifier. The server matches only an exact previously
registered camera ID. A new ID gets a new UUID v4 machine; matching by camera
label is intentionally avoided. If the ID is absent, the event is logged and a
successful result receives an unlinked machine UUID rather than being attached
to another machine. That UUID is returned additively as `machine_id`; clients
can use it with `GET /api/machines/:id/history`. A camera whose browser ID
changes must be explicitly reassociated in a future identity-management flow
if its historical timeline is to be continued.

#### Abnormality score

For severity `s` from 0–10 and confidence `c` from 0–1:

```text
severity_score = 10 × s
blended_score = round(severity_score × c + 40 × (1 − c))
score = max(blended_score, status_floor)

status_floor = 60 for analysis status "failure"
status_floor = 40 for machine status "needs_attention" (unless status is failure)
status_floor = 0 otherwise
```

The 40-point blend baseline represents uncertainty, not a clean result. The
separate `is_uncertain` flag is set when confidence is below 0.50, the analysis
status is `unclear`, or a needs-attention result has confidence below 0.70.
Scores are deterministic, rounded to integers, and remain within 0–100.

Examples:

- Severity 2, confidence 0.90, printing normally: `round(20×0.90 + 40×0.10) = 22` → **LOW**.
- Severity 8, confidence 0.20, failure: blended score `48`; failure floor raises it to `60` → **HIGH**, with `is_uncertain = 1`.

| Score | Risk classification |
| --- | --- |
| 0–19 | NORMAL |
| 20–39 | LOW |
| 40–59 | MODERATE |
| 60–79 | HIGH |
| 80–100 | CRITICAL |

Phase 2 computes trends from valid, persisted analysis records. Invalid audit
rows have no score and are excluded from all trend, baseline, and warning
calculations.

### Failure Trend Intelligence (Phase 2)

The trend engine reads the machine's valid records in timestamp order. It does
not call the AI provider, so existing history remains analyzable during provider
outages. Its API is:

- `GET /api/machines` — registered machine labels, camera mappings, last valid
  analysis timestamps, and open-warning counts for the comparison view.
- `GET /api/machines/:id/trend` — latest score and risk band, short/long moving
  averages and comparisons, timestamp regression slope, baseline statistics,
  evidence confidence, and classification.
- `GET /api/machines/:id/early-warnings` — ACTIVE and ACKNOWLEDGED warnings,
  evidence, first/latest detection timestamps, and operator actions.
- `POST /api/warnings/:warningId/acknowledge` and
  `POST /api/warnings/:warningId/resolve` — auditable operator transitions;
  optionally accept `{ "operator_notes": "..." }`.

The trend `slope` is linear-regression abnormality points per hour over the
long-term window. `rate_per_observation` is regression points per valid frame
and is used for classification so camera sampling intervals do not redefine
the configured slope thresholds. SMA values are means of the most recent
configured valid observations. Window comparisons compare the most recent N
valid scores with the prior N. The established machine baseline is the configured
number of valid observations immediately before the long-term window.

Classification rules require at least `TREND_MIN_OBSERVATIONS` valid records.
Precedence is exactly:

1. `PERSISTENT_HIGH`: the trailing `TREND_PERSISTENT_COUNT` valid scores are
   each at or above `TREND_PERSISTENT_HIGH_SCORE`.
2. `RAPIDLY_RISING`: long-window regression is at least
   `TREND_RAPID_SLOPE` points per observation and short-window average increased
   by at least `TREND_MIN_DELTA`.
3. `RISING`: regression is at least `TREND_RISING_SLOPE` and the short-window
   average is higher than the preceding window.
4. `IMPROVING`: at least two short windows are available, and both short- and
   long-window comparisons show a decrease (short delta at least
   `TREND_MIN_DELTA` points down). This prevents a single lower frame from
   appearing to improve machine condition.
5. `STABLE`: enough data exists but none of the preceding rules apply.
6. `INSUFFICIENT_DATA`: fewer than the required valid records exist.

The evaluator checks each warning category against its own minimum observation
count. It can detect:

| Category | Default rule | Recommended action |
| --- | --- | --- |
| Gradual increase | At least 5 observations and `RISING`/`RAPIDLY_RISING`. | Inspect the machine and compare with its known-good setup. |
| Repeated moderate | At least 3 scores in 40–59 within the last 10 observations. | Schedule inspection and review process conditions. |
| Sudden spike | Latest score is at least 20 points above the previous 5-score average, with at least 6 records. | Inspect the latest frame and verify the machine. |
| Persistent high | 3 consecutive valid scores are at least 70. | Pause safely, then inspect the machine and work area. |
| Repeated failure type | Same non-`none`/non-`unknown` category appears at least twice in the last 10 records. | Inspect the recurring failure mechanism and setup. |
| Baseline deviation | Recent 3-score mean is at least 15 above a baseline of at least 8 observations and meets a 2 standard-deviation test. | Compare with normal operation and inspect for change. |

Warning evidence confidence is the recent-window mean AI confidence multiplied
by sample sufficiency (`min(1, total valid count / (2 × minimum observations)`),
an uncertainty factor (`1 − 0.5 × uncertain-row fraction`), timestamp coverage
factor (`0.75 + 0.25 × coverage`), and a `0.75` penalty for each excessive
timestamp gap. Below `WARNING_MIN_CONFIDENCE` (0.35), warnings are suppressed;
below `WARNING_FULL_SEVERITY_CONFIDENCE` (0.60), severity is downgraded. Every
warning includes the actual observations and a cautious early-warning
explanation; it does not claim that a failure is certain.
The baseline-deviation warning compares the recent window with up to
`TREND_BASELINE_WINDOW` valid observations immediately before that window.

### Vision OPS Manufacturing Copilot

The dashboard's floating Copilot is a read-only assistant over existing
repository data. `ai/copilot-context.mjs` retrieves a bounded machine list,
valid camera history and trend outputs, active early warnings, sensor health and
latest readings, persisted fusion results, incidents, and selected job
intelligence. It computes vision trend summaries from up to the latest 5,000
valid persisted analyses; it does not call the camera model or modify trend or
incident state. G-code is represented by its parsed summary only.

`ai/copilot.mjs` validates requests, maintains conversations, limits message,
history, context, provider timeout, and rate volume, and calls the same runtime
Groq/OpenRouter provider and model used by camera analysis. There is no separate
AI key, model, or Python service. Provider credentials and detailed provider
responses are never sent to the browser. The UI renders model output as text
(not HTML) and displays attached database evidence references with timestamp
and provenance.

Migration `010_manufacturing_copilot.sql` is additive and preserves all prior
tables and records. Conversations and messages are stored in the configured
SQLite database. A random HttpOnly, SameSite=Strict cookie scopes history to a
browser session because the existing application has no login or user identity
system. This is **not account authentication or strong user authorization**;
do not expose the unauthenticated application to untrusted users. The Copilot
cannot control machines, mutate job or incident lifecycle, acknowledge
warnings, or execute G-code. Its only writes are chat conversations/messages.

Endpoints are `GET /api/copilot/health`,
`GET/POST /api/copilot/conversations`,
`GET/DELETE /api/copilot/conversations/:id`,
`DELETE /api/copilot/conversations/:id/messages`, and
`POST /api/copilot/chat`. The chat API accepts `{ "message": "...",
"conversation_id": "...", "machine_id": "..." }`; conversation and machine
selection are optional. Limits are 2,000 characters per message, 12 prior
messages, 20,000 serialized context characters, a 25-second provider timeout,
and 12 requests per browser session per five minutes.

REAL camera analyses and sensor evidence retain their database provenance.
SIMULATED readings remain explicitly SIMULATED; missing/stale readings remain
UNKNOWN or stale, not normal. G-code and job lifecycle describe intended or
operator-entered state, not measured execution. Recommendations are conditional
and do not assert confirmed causes. A generated report is a chat answer based
on available records, not a separately downloadable or certified report.

Warnings deduplicate by machine and category while ACTIVE or ACKNOWLEDGED.
Evidence and last-updated time are refreshed, but first-detected time is
preserved. Warnings are never automatically deleted or resolved; an operator
must resolve them. WebSocket broadcasts use the existing `{ type, ... }`
envelope and add `trend_update`, `early_warning`, `warning_acknowledged`, and
`warning_resolved`; repeated evidence updates do not emit duplicate warning
events.

#### Trend configuration

Defaults are centralized in `trend/config.mjs`; set environment variables to
override them. Window values count valid observations. The starter values use
short/long windows of 3/5 frames, require five valid observations for a
classification, and demand persistence or a score delta in addition to slope
to avoid reacting to one frame. The 70-point persistent threshold corresponds
to the existing HIGH risk band. Risk-band boundaries remain at the Phase 1
defaults (20/40/60/80) unless overridden. Baseline deviation requires both an absolute
15-point increase and a 2σ deviation (unless the baseline variance is zero).
Maximum timestamp gaps down-weight warning evidence rather than treating a
missing interval as a new score.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `RISK_LOW_THRESHOLD` / `RISK_MODERATE_THRESHOLD` | 20 / 40 | Lower bounds for LOW and MODERATE risk. |
| `RISK_HIGH_THRESHOLD` / `RISK_CRITICAL_THRESHOLD` | 60 / 80 | Lower bounds for HIGH and CRITICAL risk. |
| `TREND_SHORT_WINDOW` / `TREND_LONG_WINDOW` | 3 / 5 | SMA and comparison windows. |
| `TREND_BASELINE_WINDOW` | 30 | Baseline size before the long window. |
| `TREND_MIN_OBSERVATIONS` | 5 | Minimum classification sample size. |
| `TREND_RISING_SLOPE` / `TREND_RAPID_SLOPE` | 1 / 5 | Regression points per valid observation. |
| `TREND_MIN_DELTA` | 3 | Minimum short-window score change. |
| `TREND_PERSISTENT_HIGH_SCORE` / `TREND_PERSISTENT_COUNT` | 70 / 3 | Persistent-high rule. |
| `WARNING_GRADUAL_MIN_OBSERVATIONS` | 5 | Minimum gradual-rise samples. |
| `TREND_MODERATE_WINDOW` / `WARNING_MODERATE_COUNT` | 10 / 3 | Repeated-moderate rule. |
| `WARNING_MODERATE_MIN_OBSERVATIONS` | 5 | Minimum records for moderate warnings. |
| `WARNING_SPIKE_BASELINE_WINDOW` / `WARNING_SPIKE_INCREASE` | 5 / 20 | Spike baseline and minimum increase. |
| `WARNING_SPIKE_MIN_OBSERVATIONS` | 6 | Minimum records for spike warnings. |
| `TREND_FAILURE_WINDOW` / `WARNING_FAILURE_COUNT` | 10 / 2 | Repeated failure-type rule. |
| `WARNING_FAILURE_MIN_OBSERVATIONS` | 5 | Minimum records for repeated failures. |
| `WARNING_BASELINE_MIN_OBSERVATIONS` | 8 | Minimum established baseline sample size. |
| `WARNING_BASELINE_RECENT_WINDOW` | 3 | Number of recent scores compared with baseline. |
| `WARNING_BASELINE_ZSCORE` / `WARNING_BASELINE_MIN_DEVIATION` | 2 / 15 | Statistical and absolute deviation thresholds. |
| `WARNING_MIN_CONFIDENCE` | 0.35 | Below this evidence confidence, suppress warnings. |
| `WARNING_FULL_SEVERITY_CONFIDENCE` | 0.60 | Below this confidence, downgrade severity. |
| `TREND_MAX_GAP_HOURS` | 24 | Gap beyond which warning evidence is down-weighted. |

Migration `003_persistent_early_warnings.sql` only creates the additive warning
table and indexes. The existing migration runner applies it transactionally and
records it in `schema_migrations`; no Phase 1 history is rewritten.

### Failure Trend Intelligence dashboard (Phase 3)

The **Failure Trends** navigation opens the dashboard alongside the existing
Monitors and Active Monitor views. It loads actual machine records from the
machine-list, trend, history, and early-warning APIs. The comparison view lets
operators select a machine; its chart uses up to the latest 200 valid persisted
history records and plots the real abnormality series with a trailing short
moving average. High-risk and critical chart lines come from the trend API's
configured risk thresholds.

The displayed health index is explicitly defined as `100 - current abnormality
score`; it is unavailable when no persisted score exists. An
`INSUFFICIENT_DATA` classification remains visible until the configured minimum
valid-observation count is met. Empty history, API errors, stale cached values,
and WebSocket reconnect status have separate UI states; no chart points or
scores are synthesized to fill missing data.

Warning cards show their persisted evidence and provide functional acknowledge
and resolve actions using the Phase 2 warning endpoints. WebSocket events
update the relevant machine and warning views without a page reload, and
reconnection triggers a fresh API read. This dashboard does not replace the
camera-based Monitors or Active Monitor workflows.

### Job registration, analysis context, and job evidence (Phase 4 stages)

Migration `004_jobs_and_gcode.sql` adds the `jobs` and `job_files` tables without
rewriting or deleting machine, analysis, trend, or warning history. Job rows
reference a persistent machine UUID. G-code is stored as UTF-8 text in SQLite,
outside the static `public/` directory; the API returns only its digest,
filename, dialect, size, and parsed summary. File contents are never included
in WebSocket messages or job API responses.

Migration `005_job_analysis_link.sql` additively adds nullable `job_id` to
`analysis_records` and an index. At analysis-request start, the server resolves
the machine's RUNNING or PAUSED job, provides only its name, intended
parameters, and parsed summary as context to the existing vision prompt, and
associates the resulting valid or invalid audit record with that job. The
prompt explicitly distinguishes intended settings from measured telemetry.
Job history returns valid scored analyses only; invalid provider/camera
attempts remain linked for audit in SQLite but are not surfaced as valid
observations.

Migration `006_job_deviations.sql` adds persistent job-deviation storage. The
engine considers only valid scored rows and only evaluates RUNNING/PAUSED jobs.
Its initial repeated-failure rule requires the same non-`none`/non-`unknown`
category in at least two warning/failure analyses within six hours, with
confidence of at least 0.70 and abnormality score of at least 60 for each
observation. It stores supporting record IDs, timestamps, scores, confidences,
evidence count, and time span. Equivalent ACTIVE categories are updated in
place; they are not auto-resolved or deleted. Rule thresholds are in
`jobs/insights.mjs` as `JOB_INSIGHT_CONFIG`.

The job evidence endpoint reports progress and expected-parameter verification
as `UNAVAILABLE`: lifecycle state, G-code, and camera imagery do not measure
physical execution, temperature, speed, or power. It also reports valid
analysis count, latest valid analysis, and persisted repeated-failure
deviations. A deviation is a review prompt, not a guaranteed failure
prediction or a substitute for the existing camera warning workflow.

Migration `007_job_intelligence_lifecycle.sql` rebuilds `job_deviations`
transactionally into a wider state constraint while copying every existing
deviation ID, current evidence, and metadata. Existing resolved rows retain
their resolution time using the prior `updated_at`; the copied evidence is also
stored as the immutable initial-evidence snapshot. It adds lifecycle events,
root-cause reports, job comparisons, and completion-verification history.
Active and acknowledged categories remain deduplicated. Acknowledgment records
`acknowledged_at`; resolution records `resolved_at`; transitions are
`ACTIVE → ACKNOWLEDGED → RESOLVED` or `ACTIVE → RESOLVED`. Duplicate or
out-of-order state changes return a conflict and do not write another event.

Root-cause investigation is operator-requested. The current provider and model
receive persisted valid camera observations, machine history, Phase 2 trend,
job metadata, and parsed G-code summary. The system stores observed facts
separately from schema-validated possible causes. Hypotheses must cite IDs from
the evidence and are explicitly marked unconfirmed. Repeated investigation of
an unchanged evidence snapshot reuses its report; failed attempts are recorded
and may be retried. Provider or validation failures do not interrupt camera
monitoring.

Expected-vs-actual comparison is an evidence snapshot:

* `DEVIATION_DETECTED` requires a sufficiently confident valid warning/failure
  camera observation with a non-empty failure category.
* `CONSISTENT` means visible normal activity is consistent with the job
  context; it does not prove program execution.
* `UNCERTAIN` is used for weak/unclear observations or insufficient evidence
  for expected layer progression.
* `NOT_MEASURABLE` is used when required physical telemetry is absent, including
  expected temperature/speed/power comparisons.

Comparisons identify their expected, observed, and telemetry evidence sources;
camera-derived values are marked inferred, not measured. Invalid analyses are
excluded.

Completion verification is separate from the operator-managed job lifecycle.
Evidence evaluation never uses elapsed expected duration or G-code end markers.
A fresh valid camera view reporting normal printing can yield `NOT_COMPLETE`;
otherwise missing independent completion evidence yields
`COMPLETION_UNCERTAIN`. Operator confirmation is stored separately and may
yield `LIKELY_COMPLETE` only after the lifecycle state is `COMPLETED`. Recent
camera evidence showing printing conflicts with confirmation and remains
uncertain. `VERIFIED_COMPLETE` is not currently emitted because no controller
completion telemetry is connected. Confirmation is idempotent per job and does
not issue machine-control commands.

Supported machine types use the existing machine identifiers:

| Machine type | Operator-entered parameters | Accepted program extensions |
| --- | --- | --- |
| `3d_printer` (FDM) | Nozzle/bed temperature, layer height/count, material | `.gcode`, `.gco`, `.gc` |
| `cnc` | Spindle RPM, feed rate, tool identifier | `.nc`, `.ngc`, `.tap`, `.gcode` |
| `laser_cutter` | Laser power percentage, cutting speed, material | `.nc`, `.ngc`, `.tap`, `.gcode` |

These are intended job settings, not measured telemetry. The parser is a
bounded single-pass text parser; it never executes, uploads to, or sends a
command to a machine. It recognizes common movement, tool-change, temperature,
spindle/laser power, layer-marker, and program-end tokens, records unsupported
commands for review, and marks a small set of sensitive firmware commands for
operator review. It rejects empty, binary, malformed-comment, overlong, and
over-2-MiB input. Parsed movement counts and slicer-provided duration comments
are summaries, not evidence that a physical operation occurred. Material
usage and execution-verified duration are not inferred.

The lifecycle is `DRAFT → READY → RUNNING ↔ PAUSED`; `DRAFT` and `READY` may
also be cancelled, and a running or paused job may become `COMPLETED`, `FAILED`,
or `CANCELLED`. Terminal states cannot be reopened. A machine may have at most
one `RUNNING` or `PAUSED` job; drafts and ready jobs do not reserve it. Start,
pause, resume, completion, failure, and cancellation only change the persisted
operator-managed job state. They do not start a camera, establish progress, or
control hardware. An explicit operator transition is required to mark a job
complete.

Job APIs:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs?machine_id=&status=&limit=&offset=` | Paginated job list; filters are optional. |
| `POST /api/jobs` | Create an assigned `DRAFT`; accepts machine-specific expected parameters and notes. |
| `GET /api/jobs/:id` | Read job and parsed file summary. |
| `GET /api/jobs/:id/insights` | Read valid camera evidence, supported deviations, and explicit unavailable progress/telemetry status. |
| `POST /api/deviations/:id/acknowledge` | Acknowledge an ACTIVE deviation and record an optional operator note. |
| `POST /api/deviations/:id/resolve` | Resolve an ACTIVE or ACKNOWLEDGED deviation with an optional operator note. |
| `POST /api/deviations/:id/investigate` | Request/reuse a validated, persisted AI root-cause report. |
| `GET /api/jobs/:id/comparison` | Read persisted expected-vs-observed comparisons. |
| `POST /api/jobs/:id/comparison` | Compare current valid job evidence and persist a deduplicated result. |
| `GET /api/jobs/:id/completion-verifications` | Read append-only completion-verification history. |
| `POST /api/jobs/:id/completion-verifications` | Evaluate evidence (`action: evaluate`) or record manual confirmation (`action: confirm`). |
| `GET /api/jobs/:id/history?limit=&offset=` | Paginated valid camera analyses associated with the job. |
| `PATCH /api/jobs/:id` | Edit job metadata while it is `DRAFT` or `READY`. |
| `POST /api/jobs/:id/gcode?filename=...` | Upload raw UTF-8 G-code/NC text for validation and parsing. |
| `POST /api/jobs/:id/transition` | Change lifecycle state with `{ "status": "READY" }`, etc. |

Errors use the `{ "error": { "code": "...", "message": "..." } }` response
shape. WebSocket messages retain the existing `{ type, ... }` envelope and
include `job_created`, `job_file_uploaded`, `job_started`, `job_status_update`,
`job_completed`, `job_deviation`, `deviation_acknowledged`,
`deviation_resolved`, `root_cause_report_created`,
`job_comparison_updated`, and `job_completion_verification_updated`.
Deviation events are emitted on creation or severity change, not every frame.
Lifecycle events are broadcast only after a persisted state transition.

The Jobs view supports machine selection, typed expected-parameter entry,
optional program upload, operator lifecycle actions, and on-demand panels for
deviation management, root-cause investigation, expected-vs-actual comparison,
and completion verification. Physical progress, controller telemetry,
telemetry-based parameter comparison, and independent verified completion
remain unavailable. No missing camera or sensor data is represented as a
failure or progress estimate.

### Multimodal Sensor Intelligence (Phase 5)

Migration `008_sensor_intelligence.sql` adds the sensor, reading, health-event,
fusion-result, and incident tables without modifying prior records. Sensor
registration associates a device with an existing machine. Every accepted
reading is explicitly labeled `REAL` or `SIMULATED`, normalized to a supported
unit, timestamp-checked, duplicate-checked, bounded, and rate-limited (default:
one reading per sensor every 10 seconds). Invalid or duplicate readings do not
enter fusion. Raw audio, waveforms, video, and high-frequency payloads are not
accepted or stored; sound inputs are short dBA summaries/events, and vibration
inputs are scalar values with optional bounded metadata.

The current transport is authenticated JSON over HTTP. ESP32, USB, serial,
MQTT, and network adapter names are registration contracts for future gateways;
they do not open device ports, subscribe to brokers, or claim hardware is
connected. Each device uses the credential returned once by registration;
SQLite stores only its SHA-256 hash. Set `SENSOR_ADMIN_TOKEN` to a random secret
of at least 24 characters before using registration or calibration endpoints.
Device write APIs require the sensor's bearer credential. The built-in server
does not terminate TLS; remote gateways should connect through an HTTPS
reverse proxy or a trusted private network, and credentials must not be sent
over an untrusted plain-HTTP network. `REAL` means the
registered source claims real hardware provenance; it is not independently
verified by this software. Simulated data must be explicitly registered as
`SIMULATED` and retains that label in readings and incidents.

#### Sensor validation and fusion rules

| Modality | Canonical unit | Initial warning / critical thresholds |
| --- | --- | --- |
| Sound | dBA | 85 / 105 |
| Vibration | g RMS | 0.5 / 1.0 |
| Temperature | °C | 70 / 85 |
| Smoke | ppm | 10 / 50; an explicit sensor alarm is critical evidence |

These are generic starting values, not certified safety limits. Configure them
for the sensor placement and machine using `.env`; warning/critical settings
include `SENSOR_SOUND_WARNING_DB`, `SENSOR_VIBRATION_CRITICAL_G`,
`SENSOR_TEMPERATURE_WARNING_C`, and `SENSOR_SMOKE_CRITICAL_PPM`. Vibration in
`m/s2` is converted to g. Readings are checked against bounded physical input
ranges, must have an ISO timestamp no more than five minutes in the future or
24 hours old, and must match the registered unit.

Fusion uses only the latest fresh, authenticated reading from each enabled
sensor, the latest valid persisted camera analysis, stored Phase 2 trend
results, and active job context. Sensor thresholds and existing camera/trend
rules produce auditable signals. Distinct corroborating signal sources can
raise severity; possible causes and operator actions are rule-based
hypotheses, never confirmed diagnoses. A smoke camera classification is
presented as visual suspicion; a registered smoke sensor contributes separate
sensor evidence when it is available. The engine does not infer unavailable
temperatures, sound, vibration, smoke, or machine telemetry. `NORMAL` is
returned only when all four modalities, valid vision evidence, and a sufficient
trend history are available; otherwise the overall result is `UNAVAILABLE`
unless an actual rule has evidence for a risk signal.

Health is derived from authenticated heartbeats/readings and calibration
metadata. Defaults are 60 seconds to STALE, 300 seconds to DISCONNECTED, a
120-second fusion freshness window, and a 15-second health refresh interval.
No readings means UNKNOWN/UNAVAILABLE, never healthy. Calibration due dates
are surfaced and reduce confidence in absolute sensor-threshold alerts. These
health and fusion intervals can be configured with the `SENSOR_*` values in
`.env.example`.

#### Sensor API and WebSocket events

| Endpoint | Purpose |
| --- | --- |
| `POST /api/sensors` | Register a sensor for an existing machine; requires administrator bearer token and returns the device credential once. |
| `GET /api/sensors?machine_id=` | List registrations and current health. |
| `POST /api/sensors/:id/readings` | Submit one validated canonical reading using that sensor's bearer credential. |
| `POST /api/sensors/:id/heartbeat` | Report an authenticated OK/FAULT heartbeat. |
| `GET /api/sensors/:id/readings?limit=&offset=` | Read persisted sensor history. |
| `POST /api/sensors/:id/calibration` | Update calibration due date; requires administrator bearer token. |
| `GET /api/sensor-intelligence?machine_id=` | Read current and last persisted fusion, trend/job context, sensor history/health, and incidents. |
| `GET /api/incidents?machine_id=&state=&severity=` | Filter persisted sensor incidents. |
| `GET /api/incidents/:id` | Read incident evidence and lifecycle events. |
| `POST /api/incidents/:id/acknowledge` | Acknowledge an OPEN incident with optional operator notes. |
| `POST /api/incidents/:id/resolve` | Resolve an OPEN or ACKNOWLEDGED incident with optional operator notes. |

Sensor writes and lifecycle actions broadcast using the existing `{ type, ... }`
WebSocket envelope: `sensor_reading`, `sensor_health_update`,
`sensor_calibration_updated`, `sensor_fusion_update`,
`sensor_incident_created`, `sensor_incident_updated`,
`sensor_incident_acknowledged`, and `sensor_incident_resolved`. A periodic
health check persists and broadcasts state changes; dashboard reconnects
reload persisted data. Sensor incidents are deduplicated per machine while
active, retained after resolution, and never auto-control or shut down a
machine.

The Sensors dashboard shows machine risk/coverage, sensor status and provenance,
persisted reading charts, incident evidence and lifecycle actions, and exposes
registration/one-time device credentials. Missing modalities and stale
snapshots are explicitly labeled. Real ESP32, USB, serial, MQTT, and network
transport drivers, certified safety workflows, and physical calibration
verification remain hardware integration work.

### Hardware-Free Multimodal Simulation (Phase 6)

Migration `009_hardware_free_simulation.sql` adds durable virtual-machine
sessions, virtual-sensor references, and links to ordinary persisted sensor
readings. A backend timer generates deterministic SOUND, VIBRATION,
TEMPERATURE, and SMOKE summaries, using the existing sensor health,
multimodal-fusion, incident, and WebSocket paths. The process continues
generating samples while the browser is closed and restores persisted RUNNING
sessions after a server restart. Each session is bounded at 10,000 ticks;
readings remain in SQLite after pause, stop, reset, and replay.

Supported repeatable scenarios are `NORMAL`, `OVERHEATING`,
`EXCESSIVE_VIBRATION`, `UNUSUAL_NOISE`, `SMOKE_INDICATION`, `SPAGHETTI`,
`LAYER_SHIFT`, `POOR_BED_ADHESION`, and `COMBINED_FAILURES`. Sensor ramps use
fixed values and do not call a random generator. The three visual-failure
scenarios are explicitly injected simulation context, not fabricated camera
analysis or Groq results. Actual camera frames continue through the existing
camera/Groq path and can be included separately in fusion evidence. Current
Phase 2 history and active job context remain part of the existing fusion
snapshot.

Virtual samples use `provenance=SIMULATED`, separately registered virtual
sensors, and are tagged in persisted charts, fusion evidence, incidents, and
WebSocket payloads. Real sensor records are never overwritten or relabeled.
Fusion groups simulated evidence as a single virtual source rather than
mistaking multiple generated channels for independent physical corroboration.
Stopped virtual sensors become `STALE` after the configured freshness timeout;
they are not marked healthy and stale readings are excluded from current risk.
Fusion reports overall data provenance separately from risk-contributing
sources, so historical simulated readings can make data provenance `MIXED`
without being represented as a current simulated risk signal. Incidents
triggered by simulated risk use the separate
`SIMULATED_MACHINE_MULTIMODAL_RISK` category; simulated readings do not advance
or replace a `MACHINE_MULTIMODAL_RISK` incident based on REAL evidence.
No readings from absent physical sensors are synthesized as REAL, and no
simulation endpoint controls or shuts down a machine.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/simulations?machine_id=` | Read persisted sessions and bounded chart history for one machine. |
| `POST /api/simulations` | Start `{ machine_id, scenario, speed }`; speed is one of 0.25, 0.5, 1, 2, or 4. |
| `GET /api/simulations/:id` | Read a session and persisted virtual readings. |
| `POST /api/simulations/:id/pause` / `resume` / `stop` | Control the backend simulation lifecycle. |
| `POST /api/simulations/:id/reset` | Start a new numbered run while preserving all previous readings. |
| `POST /api/simulations/:id/replay` | Create a new session from the saved scenario and speed. |
| `PATCH /api/simulations/:id/speed` | Change a running or paused session speed. |

Simulation lifecycle and sample events use the existing WebSocket connection:
`simulation_started`, `simulation_paused`, `simulation_resumed`,
`simulation_stopped`, `simulation_reset`, `simulation_replayed`,
`simulation_speed_changed`, and `simulation_update`. Sensor reading, fusion,
and incident events continue to be emitted through their Phase 5 event names.
The sensor page offers REAL/SIMULATED evidence filters, deterministic scenario
controls, provenance-labeled traces, persisted session history, and replay.
The default server-side sample interval is five seconds and can be adjusted
using `SIMULATION_INTERVAL_MS` (bounded to 1–60 seconds before speed scaling).

#### Adding a migration

1. Add the next lexically ordered migration, for example
   `migrations/010_add_field.sql`; do not edit an applied migration.
2. Keep SQL compatible with SQLite and preserve existing records when
   rebuilding tables.
3. Start the server (`npm start`) or run `npm test`. The migration runner
   records successful filenames in `schema_migrations` and applies each
   migration exactly once in a transaction.

Set `VISION_OPS_DB_PATH` before startup to select a non-default database. Tests
create temporary database files and do not touch the production default.

The model is treated as an unreliable inspector. The real engineering is:

1. **Prompting** — long inspector prompt plus machine-specific rules
2. **Schema enforcement** — allowed enums, clamped scores, JSON extraction
3. **Post-rules** — e.g. solid geometry + lifted edge → `bed_adhesion`
4. **Confirmation streak** — default 3 `needs_attention` frames before Discord / auto-pause
5. **Rate-limit fallback** — drop the previous-frame reference image if Groq’s token budget is exceeded
6. **Alert hygiene** — notify on state change, not every frame; cooldowns; attach snapshot

A later path (see `replacing_groq_with_trained_model.md`) is to swap Groq for a local YOLO/CNN.

---

## What to learn from this codebase

Read in this order:

1. **Browser camera and canvas** — `getUserMedia`, device list, JPEG data URLs, `failure_box` overlay (0–1 coordinates)
2. **Small Express API** — `/api/health`, `/api/config`, `/api/analyze-machine`, `/api/machines/:id/history`, `/api/notifications`
3. **Vision LLM as a classifier** — images + prompt that demands JSON, `response_format: json_object`, temperature `0`, then still validate
4. **Prompt design** — `machineInstructions()` for printer vs CNC vs laser
5. **Safe model output** — `normalizeResult()`, `extractJson()`, retries, token-budget detection
6. **Ops logic** — streaks, problem signatures, recovery alerts, WebSocket broadcast
7. **Integrations** — Discord webhooks, OctoPrint/Moonraker
8. **Optional deeper CV** — labeling frames, YOLOv8, FastAPI, replace `requestAnalysis()`

The three files that *are* the product: `server.mjs`, `public/index.html`, `notifications.mjs`.

You do not need PyTorch to understand this repo. You need JavaScript, HTTP, JSON, and how a webcam frame becomes a decision.

---

## How to run

Run from the project root (`Vision-OPS-Monitoring-main`). The README step `cd VisionOPS_4` is outdated.

### Requirements

| Required | Optional |
| --- | --- |
| Node.js / npm | Discord webhook |
| Groq API key | OctoPrint / Moonraker auto-pause |
| Browser with camera permission (Chrome or Edge) | A real printer — photos/props are enough |

### Steps

1. `npm install`
2. Copy `.env.example` to `.env` if needed
3. Get a key at [https://console.groq.com/keys](https://console.groq.com/keys)
4. Either paste `GROQ_API_KEY=gsk_...` into `.env`, or enter it on the setup screen in the browser
5. Start:

```powershell
npm start
```

Auto-reload while editing `server.mjs`:

```powershell
npm run dev
```

6. Open **http://localhost:3001/**

If port 3001 is taken:

```powershell
$env:PORT=3002; npm start
```

### Quick API checks (server already running)

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/config
```

Healthy config looks like: `hasApiKey: true`, model `qwen/qwen3.8-27b`.
If the model differs from `.env`, inspect `providerSource` and `modelSource`;
restart the server after editing `.env`.

Analysis errors return separate codes for missing configuration,
authentication, model access, rate limiting, oversized images, and invalid
image encoding. The response includes the provider HTTP status and provider
message with any configured API key redacted.

`node test.mjs` is **not** a reliable check. It still calls an old model name (`llama-3.1-8b-instant`) and can fail even when the app is fine.

Discord test (only if `DISCORD_WEBHOOK_URL` is set):

```powershell
Invoke-RestMethod -Method POST http://localhost:3001/api/notifications/test
```

---

## How to test in the UI

1. Keep `npm start` running
2. Open http://localhost:3001/
3. If asked, paste the Groq key → **Save & Continue**
4. **Allow / Refresh Cameras** (or **Scan Cameras**) and allow the camera
5. Open the **Unassigned** tab — laptop webcams show up here (often “Integrated Camera”)
6. Set the camera type (**3D Printer**, **Laser Cutter**, or **CNC Machine**)
7. Open **Active Monitor**
8. Optional: **Capture** and drag a box around the work area
9. Start analysis

Watch the terminal for:

```text
Analyzing with qwen/qwen3.8-27b
Groq responded in …ms
```

A confirmed fault may log `Confirmed failure on "…": …`

### Laptop camera

Yes — any `videoinput` device works. Close Zoom/Teams/other tabs that lock the webcam. Only one app can use a given camera at a time.

### If nothing happens

- Black video: another app owns the camera
- Setup overlay again: key rejected — **API Key** → paste again
- Rate limit / request too large: wait, or set `SEND_REFERENCE_IMAGE=false` in `.env` and restart
- Needs Attention never sticks: keep the fault in view 10–15 seconds (default 3-frame streak)

---

## Demo without a real 3D printer

You do not need a printer. The model only sees the camera frame.

Assign the laptop camera as **3D Printer**.

| Test | What to show | Expected |
| --- | --- | --- |
| Idle | Empty desk / empty paper | **Idle** |
| Printing (fake) | Photo of a normal print, or a solid printed part | **Printing** |
| Failure | Physical spaghetti filament, or a photo of spaghetti failure | **Needs Attention**, `failure_type` around spaghetti |

Hold spaghetti (or a phone photo) **10–30 cm** from the camera, fill the frame, keep it still **10–15 seconds**.

Search images: `3D print spaghetti failure`.

Discord is optional for this demo. UI + terminal are enough.

---

## Demo without a CNC machine

Assign the same camera as **CNC Machines** (dropdown on the Unassigned card). It then appears under the **CNC Machines** tab.

Status labels are still **Idle / Printing / Needs Attention**. For CNC, **Printing** means “a workpiece is visible and looks OK.”

| Demo | What to show | Expected |
| --- | --- | --- |
| Idle | Empty desk | **Idle** |
| Running / OK | Photo of a CNC bed with a clamped workpiece, light chips | **Printing** |
| Problem | Loose/shifted workpiece, huge chip pile, broken end mill | **Needs Attention** |

Search images:

- `CNC mill vise workpiece`
- `CNC chip buildup`
- `CNC workpiece shifted in vise`
- `broken end mill`

Hold the phone 15–30 cm from the laptop camera for 10–15 seconds.

Physical stand-in: a board with a block “clamped” by tape, then knock the block aside or dump chips/sawdust on it.

CNC failure types the prompt allows:

- `workpiece_shift`
- `bad_fixturing`
- `chip_buildup`
- `tool_damage` / `chatter`
- `path_problem` / `zero_problem`
- `camera_problem`

**Do not use printer spaghetti for the CNC demo.** Use mill/router photos or a shifted-block prop.

Demo one type at a time: spaghetti as 3D printer, then switch the camera type to CNC and use mill photos.

---

## Honest hackathon rating

**Overall: about 7.5 / 10 as a project.**

- Typical student / maker / AI hackathon: **can place; maybe 20–40% chance of first** if the live demo is clean
- “Train a model / novel ML” contest: weaker
- “Hardware + ops + useful product” contest: stronger

It is **not an automatic winner**. It **can win** a well-chosen track with a reliable 2-minute live fail.

### Why it scores well

Judges reward a full loop:

- Camera in the browser
- Vision model out
- Status on a dashboard
- Confirm over several frames
- Discord alert
- Optional printer pause

Confirmation streak, Groq token-budget fallback, and “alert on state change not every frame” look like shipping, not a thin API wrapper.

The story is easy: spaghetti, laser fire, shifted CNC part.

### Why it may not win

1. **Intelligence is rented** — Groq + a prompt, no trained detector. Judges will ask what *you* built besides prompt and UI.
2. **Demo risk** — LLMs can mislabel, rate-limit, or lag during judging.
3. **No real machine** — spaghetti + photos work; a real printer failing on camera hits harder. CNC/laser without footage is the weakest pitch.
4. **Polish vs novelty** — arcade UI / warehouse map do not replace a unique technical claim.

### Rough rubric

| Rubric | Score | Why |
| --- | --- | --- |
| Idea / problem | 8.5 | Real, easy to explain, safety/money |
| Completeness | 8 | End-to-end |
| Technical depth | 6–7 | Solid engineering, little original ML |
| Demo | 6–9 | Entirely depends on the live camera bit |
| Impact | 7.5 | Makerspaces yes; factories want a real model |

### What actually decides a win

Lead with **3D print spaghetti on the laptop camera**, not CNC.

Pitch sequence:

1. Empty desk → Idle
2. Photo of a good print → Printing
3. Spaghetti in frame → Needs Attention + box + confirmed in the terminal

If Discord is configured, a phone notification during the pitch is the best 15 seconds.

Say out loud: *today the brain is a vision LLM; production would be a local YOLO trained on our frames.* That answers “is this just an API?”

Skip CNC/laser unless a judge asks.

### Bottom line

- Maker / hardware / campus hackathon: strong contender if the live fail works
- Big AI/ML hackathon: solid finalist; first is harder
- Without a live visual fail: looks like a Groq tutorial with a nice skin

The project is good enough to win **if the demo lands**. Bring spaghetti, rehearse Idle → Printing → Needs Attention until it is boringly reliable, add Discord if possible.
