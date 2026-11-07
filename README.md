<img width="1201" height="328" alt="Watch Guard" src="public/assets/watch-guard-mark.svg" />

# Watch Guard

Watch Guard is an AI-powered fabrication monitoring camera platform designed for 3D printers, CNC machines, laser cutters, and maker spaces. Instead of simply recording video, Watch Guard watches a machine while it runs, detects early signs of failure or safety risk, and helps the operator understand what is going wrong.

The device uses a clean orb-style webcam enclosure with RGB status lighting. Inside the enclosure, the only core component is a webcam, making the hardware simple, reliable, and easy to build. A USB-A cable provides both power and data, so it can plug directly into a laptop or demo computer.

Watch Guard can detect problems such as 3D print spaghetti failures, poor bed adhesion, layer shifts, laser smoke or flame risk, CNC workpiece movement, tool chatter, and other visible machine issues. When a problem appears, the system can change its RGB status light, alert the user, capture snapshots, and generate an AI incident report with the likely cause and recommended next action.

The goal of Watch Guard is to turn ordinary machine footage into useful operational intelligence. Most cameras only let you watch a machine fail. Watch Guard helps you catch the failure early, understand why it happened, and prevent it from happening again.

Additionally, Watch Guard is designed so it is able to monitor loaded filament, print status whether a machine is idle, needs attention, or printing ongoing. It is designed around the peace of mind of a user.

----------------------------------------------------------------
How to use Watch Guard?
1. In your terminal type:
   ```bash
   git clone https://github.com/ShaanSomanna12/prayog.git
   cd prayog
   ```

2. PLEASE ENTER YOUR API KEY
To get your API key:
- **For Claude (Recommended):**
  a) Go to https://openrouter.ai/keys
  b) Create your key and add it to `.env`:
     ```env
     AI_PROVIDER=openrouter
     OPENROUTER_API_KEY=sk-or-v1-YOUR_KEY
     OPENROUTER_MODEL=anthropic/claude-3.5-haiku
     ```
- **For Groq:**
  a) Go to https://console.groq.com/keys
  b) Create your key and add it to `.env`:
     ```env
     AI_PROVIDER=groq
     GROQ_API_KEY=gsk_YOUR_KEY
     GROQ_MODEL=qwen/qwen3.8-27b
     ```
*(You can also simply launch the app and enter your key in the setup window in the browser).*

3. After entering API key, go into the folder containing the files
   
   <img width="860" height="189" alt="image" src="https://github.com/user-attachments/assets/42031c57-2f85-497b-b9fe-3a5b4d4791ef" />

4. Type "cmd" to enter the terminal
   
   <img width="592" height="148" alt="image" src="https://github.com/user-attachments/assets/a63fcaad-026a-4deb-839f-7df78c66c8a3" />
   
   This should pop up:
   <img width="862" height="468" alt="image" src="https://github.com/user-attachments/assets/6b90d429-9c52-4650-bb14-fd2b4c8e6ea7" />

5. Type "npm install"
   
   <img width="500" height="252" alt="image" src="https://github.com/user-attachments/assets/3e11d30d-4c53-45b4-9d17-620cca3736ca" />

6. Type "cd VisionOPS_4"
   
   <img width="628" height="158" alt="image" src="https://github.com/user-attachments/assets/0383243a-4e8d-45d1-951c-76f7e44be302" />
   
7. Type "npm start" as seen above

8. Enter in: "http://localhost:3001/" in your browser

   <img width="803" height="56" alt="image" src="https://github.com/user-attachments/assets/585e7262-8ec1-4169-ad27-5afb8e9f3bf3" />


----------------------------------------------------------------
## Job registry and job-linked camera evidence (Phase 4, staged implementation)

The **Jobs** view lets an operator register a draft job against a machine
already known to camera monitoring. FDM printers, CNC machines, and laser
cutters expose different intended-parameter fields. A job may optionally
include a G-code/NC file; uploaded files are parsed as untrusted UTF-8 text,
stored outside the public web root, and never executed or sent to hardware.
The upload limit is 2 MiB. The parser reports recognized command and metadata
summaries, flags unsupported commands for review, and does not infer actual
machine progress, material usage, or sensor readings from program text.

Job lifecycle states are `DRAFT`, `READY`, `RUNNING`, `PAUSED`, `COMPLETED`,
`FAILED`, and `CANCELLED`. A machine cannot have more than one `RUNNING` or
`PAUSED` job at once. Lifecycle buttons record operator-managed state only;
they do not start monitoring or issue physical machine commands.

The initial job APIs are:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs` | Paginated job list with optional `machine_id` and `status` filters. |
| `POST /api/jobs` | Create an assigned draft job. |
| `GET /api/jobs/:id` | Read job data and parsed G-code summary. |
| `PATCH /api/jobs/:id` | Edit a draft or ready job. |
| `POST /api/jobs/:id/gcode?filename=...` | Validate and store G-code/NC text. |
| `GET /api/jobs/:id/history` | Paginated valid camera analyses linked to that job. |
| `GET /api/jobs/:id/insights` | Valid observation summary, repeated-failure deviations, and explicit unavailable progress/telemetry status. |
| `POST /api/deviations/:id/acknowledge` | Acknowledge an active deviation with optional operator notes. |
| `POST /api/deviations/:id/resolve` | Resolve an active or acknowledged deviation. |
| `POST /api/deviations/:id/investigate` | Request a validated, evidence-cited root-cause report. |
| `GET/POST /api/jobs/:id/comparison` | Read or create a persisted evidence comparison. |
| `GET/POST /api/jobs/:id/completion-verifications` | Read verification history, evaluate evidence, or record separate operator confirmation. |
| `POST /api/jobs/:id/transition` | Request a validated job lifecycle transition. |

Migrations `004_jobs_and_gcode.sql` and `005_job_analysis_link.sql` add job
storage and a nullable job reference to camera history without rewriting
Phase 1 or Phase 2 records. Migration `006_job_deviations.sql` adds persistent
job-deviation storage. Migration `007_job_intelligence_lifecycle.sql`
transactionally preserves existing deviation IDs/evidence while adding
acknowledgment, resolution, lifecycle history, root-cause report, comparison,
and completion-verification storage. While a job is RUNNING or PAUSED, camera analysis
requests include its operator-provided intent and parsed summary as context;
valid results and invalid audit attempts are linked to that job. Program
contents are not sent to the vision provider or included in WebSocket events.
This association does not establish progress or physical execution.

Repeated camera failures are reported only after the same failure category
appears in at least two valid warning/failure analyses within six hours, each
with confidence >= 0.70 and abnormality >= 60. The deviation includes its
supporting observation IDs, timestamps, scores, and confidences, and is
deduplicated per active job/category. It is not automatically resolved.
Operators can acknowledge or resolve deviations; transitions and optional notes
are persisted, duplicate transitions are rejected, and original evidence is
preserved. Root-cause reports separate database-backed observed facts from
unconfirmed AI hypotheses and reuse reports for unchanged evidence. Provider
errors are recorded without interrupting camera monitoring.

Expected-vs-actual comparisons use valid camera results and clearly label
inferred visual values versus measured telemetry. Missing sensor values produce
`NOT_MEASURABLE`, not a fabricated deviation. Completion verification is stored
separately from lifecycle state: recent visible printing may show
`NOT_COMPLETE`, an operator confirmation after lifecycle completion may show
`LIKELY_COMPLETE`, and missing evidence remains `COMPLETION_UNCERTAIN`.
`VERIFIED_COMPLETE` is not currently emitted because the application has no
independent controller-completion telemetry. Neither elapsed duration nor
G-code proves physical completion.

## Alerts

Watch Guard can message you on Discord when something goes wrong, so you do not
have to watch the camera feed. Nothing is sent until you configure a channel.

### What triggers a message

| Trigger | When it fires |
| --- | --- |
| Any visible problem | The first frame a camera reports a warning, a failure, or an unreadable view. Sent immediately, without waiting for confirmation. |
| Confirmed print failure | A camera reports `needs_attention` for `CONFIRMATION_STREAK` frames in a row (default 3). This is the louder alert, and the one that triggers auto-pause. |
| Analysis failure | Groq rejects the API key, rate-limits, times out, or is down, so monitoring has effectively stopped. |
| Unreadable model output | The model returned text that was not valid JSON after retrying. |
| Auto-pause failure | A confirmed failure happened, but the configured printer driver could not pause the machine. |
| Server crash | An uncaught exception or unhandled rejection. |

A confirmed failure also attaches the camera frame that triggered it, so you can
see the problem without walking over to the machine. When a camera that was in a
confirmed failure returns to normal, a short recovery message follows.

Everything except confirmed failures can be turned off with
`DISCORD_NOTIFY_ERRORS=false`, and recovery messages with
`DISCORD_NOTIFY_RECOVERY=false`.

### How much gets posted

`DISCORD_ALERT_LEVEL` controls the volume:

| Level | Behaviour |
| --- | --- |
| `warnings` | Default. Every distinct problem the moment it is seen, plus the confirmed alert once the streak agrees. |
| `confirmed` | Only confirmed failures. Quietest, but a fault that flickers never reaches three frames in a row and is never reported at all. |
| `all` | Every analysed frame, including clean ones. Debugging only — this posts continuously while monitoring runs. |

A message is sent when a camera's problem *changes*, not once per frame, so a
stuck camera reports once rather than every few seconds. If the same problem is
still there after `DISCORD_REPEAT_MS` (default 10 minutes) it is repeated, so a
fault left running overnight keeps reminding you.

Discord allows roughly 30 messages per minute per webhook. Sends are queued and
serialized, and a 429 is retried after the delay Discord asks for, so bursts are
slowed rather than lost. If a flickering fault still posts more often than you
want, set `DISCORD_WARNING_COOLDOWN_MS` to put a floor between warnings.

Beyond that, repeats are suppressed for `DISCORD_ERROR_COOLDOWN_MS` (default 1
minute). The next message that does go out reports how many were suppressed, so
nothing is silently dropped.

### Setting up Discord

1. In your Discord server, open **Server Settings > Integrations > Webhooks > New Webhook**.
2. Pick the channel you want alerts in, then click **Copy Webhook URL**.
3. Paste it into the `.env` file:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

4. Save the file and restart the server.

### Getting it on your phone

Discord push-notifies on mentions, so add your own user ID to `.env` and a
confirmed failure or a crash will buzz your phone:

```
DISCORD_MENTION=<@your_user_id>
```

To find your ID, turn on **Settings > Advanced > Developer Mode** in Discord,
then right-click your name and choose **Copy User ID**. A role (`<@&role_id>`),
`@here`, or `@everyone` works too. Leave it blank for no ping.

### Checking it works

With the server running, send a real test message:

```
curl -X POST http://localhost:3001/api/notifications/test
```

A rejected webhook comes back with the reason Discord gave.

### Alert API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/notifications` | Current alert configuration. The webhook URL is never returned. |
| `POST /api/notifications` | Set or clear the webhook at runtime and save it to `.env`. Send `{"webhookUrl": "..."}`, or an empty string to disable. |
| `POST /api/notifications/test` | Send a test alert. |

See `.env.example` for every setting, including snapshot attachments, cooldowns,
and the bot's display name.

----------------------------------------------------------------
## Vision OPS Manufacturing Copilot

The floating **AI Copilot** panel is available on every dashboard view. It can
summarize machine health, camera trends, sensor readings, incidents, warnings,
and job intelligence from persisted SQLite records. Choose a machine in the
panel or use **All machines**. Suggested prompts, conversation history, retry
feedback, and clear/new-chat controls are included.

The Copilot reuses the active `AI_PROVIDER`, model, and credentials already
configured for camera analysis. It has no separate key or model setting.
Requests are read-only with respect to machines, jobs, incidents, and warnings;
only Copilot conversation records are written. It cannot control a machine,
change job state, acknowledge an incident, or edit G-code.

Answers use bounded, relevant database context. Sensor evidence retains
REAL/SIMULATED provenance, missing or stale data is not treated as normal, and
job/G-code intent is not described as measured progress. Evidence references
and timestamps are shown below assistant responses. If evidence is insufficient,
the assistant is instructed to say so.

Migration `010_manufacturing_copilot.sql` adds the conversation and message
tables. Conversations are scoped to a random HttpOnly, SameSite=Strict browser
cookie, so separate browser sessions do not see each other's history. This is
**browser-session isolation, not user authentication**: the existing app has no
login/account ownership system. Do not expose an unauthenticated deployment to
untrusted users or treat the cookie as account-level authorization.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/copilot/health` | Reports whether the active provider is configured; returns no credentials. |
| `GET /api/copilot/conversations` | Lists this browser session's conversations. |
| `POST /api/copilot/conversations` | Creates an empty conversation. |
| `GET /api/copilot/conversations/:id` | Retrieves an owned conversation and messages. |
| `DELETE /api/copilot/conversations/:id` | Deletes an owned conversation and its messages. |
| `DELETE /api/copilot/conversations/:id/messages` | Clears messages but retains the conversation. |
| `POST /api/copilot/chat` | Answers a validated question using persisted context and bounded history. |

Messages are limited to 2,000 characters, provider requests time out after 25
seconds, history is limited to 12 messages, and the per-browser-session rate
limit is 12 requests per five minutes. Report requests return an
evidence-based response in the conversation; no downloadable report file is
generated. The Copilot is not a certified diagnostic system and does not
establish real-world prediction accuracy.

----------------------------------------------------------------
## Troubleshooting

### "The image request is too large" after the first analysis

Watch Guard normally sends two images per analysis: the current frame and the
previous one, so the model can tell what changed. On Groq's free tier that pair
costs roughly 8300 tokens against a limit of 8000 tokens per minute, so the
first analysis succeeds and every one after it fails.

The server now handles this on its own — it drops the reference frame, retries,
and stays in single-frame mode for the rest of the run, posting one Discord
notice when it switches. Monitoring keeps working; only frame-to-frame change
detection is lost.

To avoid the one failed request entirely, set `SEND_REFERENCE_IMAGE=false` in
`.env`. To get the reference frame back, lower the camera resolution or upgrade
the Groq tier at [console.groq.com/settings/billing](https://console.groq.com/settings/billing).

### "Port 3001 is already in use"

Watch Guard is already running in another terminal window or browser tab session.
Open <http://localhost:3001> instead of starting it again, or close the other
window first. To run a second copy alongside it, give it another port:

```
PORT=3002 npm start
```

### A note on .env

`.env` is no longer tracked by git, because it holds your Groq API key and your
Discord webhook URL and this repository is public. Anyone cloning the project
should copy `.env.example` to `.env` and fill in their own values.
