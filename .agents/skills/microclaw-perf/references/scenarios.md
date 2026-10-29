# Scenario Definitions and Result Contract

## Current implementation

The repository already has installer step timing in `deployer/install_timing.py`,
startup milestones in `desktop/src/startup-timing.ts`, and startup summaries emitted
from `desktop/src/main.ts`. See
[startup timing](../../../../docs/startup-timing.md) for clock boundaries, phase
ownership, and the persisted Electron lifecycle log.

The chat path starts in `desktop/renderer/src/stores/chat.ts`: `sendMessage`
dispatches a request, while `handleChatEvent` handles streamed and final output.
The send promise alone does not establish that the answer is complete.

There is not yet a unified runner, automatic clean-install fixture, or committed
performance baseline. These definitions are the contract for those implementations,
not evidence that they have run. Prefer current source over stale names in this
reference when locating an existing hook.

## Initial scenarios

| ID | Start | End | Metrics |
| --- | --- | --- | --- |
| `install.clean` | Confirm installation in a disposable clean fixture | Installer completes successfully after first application service readiness and final validation | `totalMs`, installer step timings, first-launch milestones when available |
| `app.restart` | Request normal exit from the ready fixture | Relaunched app's chat surface is usable | `totalMs`, `shutdownMs`, `launchToChatReadyMs`, startup stages |
| `chat.new-session` | Activate the new-conversation action in a ready app | The matching response finishes and its final nonempty text is rendered | `totalMs`, `sessionReadyMs`, `sendToFirstTextMs`, `sendToFinalRenderedMs` |

Missing metrics are `null` with an explanation, never zero or values inferred from
unrelated logs. Store individual metrics' endpoints and do not assume all metrics
sum to the total; some are nested or run in parallel.

### Installation

Record the VM/image identity and whether Node, Git, OpenClaw, and download caches
were present before installation. Use a restored fixture for each clean attempt.
Do not label an upgrade, an already-installed check, or a portable archive extraction
as a clean install. If clean installation cannot be executed safely, mark this
scenario unavailable and explain the required environment.

Exclude time spent reading the installer or waiting for human confirmation from
installation execution time; record any human approval wait encountered after the
start separately. A failure is an unsuccessful attempt, not a successful install
whose duration can be compared with completed installations.

### Restart

Start from an installed, configured, ready application. Wait for the owned desktop
and managed Gateway processes to exit before relaunching. Record whether a Gateway
was spawned or reused; reused-Gateway samples are not equivalent to full restarts.
Do not kill unrelated Gateway instances or change production autostart settings.

Define chat readiness as the renderer being loaded, application service readiness,
the initial conversation/empty state being resolved, and the composer being usable.
Record those milestones separately if a unified readiness hook is missing. HTTP
health, a WebSocket connection, and the first history response each observe only
part of this boundary. In particular, first history can include user delay or
renderer retries, and is not an exact model-runtime readiness timestamp.

Ordinary application restart retains the fixture's declared disk caches; an OS
cold boot is a separate scenario. Record the cache policy and restore an equivalent
state for every sample. Avoid performing unrelated profiling work inside the
measured interval.

### New session and fixed message

Use a unique session for every sample and a fixed fixture prompt, for example:
`Reply with exactly MICROCLAW_PERF_OK. Do not use tools.` Record the prompt/fixture
version rather than private conversation content.

Measure visible first answer text, not reasoning, a tool event, or request
acknowledgment. End only for the matching session/run after response completion
and the final answer's render. Duplicate terminal events, background title
generation, silent/empty finals, and other sessions must not finish the sample.
Treat model errors, empty responses, cancellation, and timeouts as distinct outcomes.

Keep two named execution profiles:

- `fixed-response`: Real UI, desktop, and Gateway with a deterministic model-service
  fixture. Use fixed response content and streaming cadence to isolate product
  overhead. Do not claim to measure real inference or provider latency.
- `real-model`: Record provider/model identity, local model artifact where applicable,
  relevant inference/context settings, output token count when available, and warmup
  policy. Report external-network and generation variability as limitations.

Never mix profiles, cold/warm runs, or dev/packaged application samples in one
aggregate or comparison.

## Evidence and output

Use a run manifest with these fields in `results.json`; keep raw evidence alongside
it using relative artifact paths:

| Field | Contents |
| --- | --- |
| `schemaVersion` | Version of the result contract; initially `1` |
| `mode` | `report` or `compare` |
| `runId`, `startedAt`, `finishedAt` | Unique run identity and UTC timestamps |
| `source` | Revision, dirty flag, dirty-source fingerprint, and built artifact identity when known |
| `environment` | Non-secret machine/VM identity, OS, CPU/RAM/GPU, relevant runtime versions |
| `scenarios` | ID/version, execution profile, fixture/cache policy, requested/observed sample counts |
| `samples` | Scenario/sample IDs, outcome, nullable metrics in milliseconds, evidence paths, failure classification |
| `summary` | Coverage status and per-scenario aggregates; keep failed/skipped counts visible |
| `baseline` | Optional baseline identity and compatibility findings; omitted in report mode |

If source or artifact provenance is unknown, record it as unknown instead of
assigning the current repository revision to old logs. Capture fingerprints only
for relevant source files and store hashes/paths, not secret file contents.

For each successful metric, report its contributing sample count, median, minimum,
and maximum. A five-sample run does not support a reliable tail-latency claim; show
the raw samples instead of advertising a stable p95. Report failed attempt duration
separately from successful completion duration.

## Comparison only

Report mode needs neither a baseline nor regression thresholds. It can identify
observed dominant stages and explicitly supplied absolute-budget violations without
claiming a change relative to another revision.

For compare mode, check scenario/fixture versions, metric endpoints, environment,
execution profile, packaging mode, cache policy, and sample adequacy. Record
application and OpenClaw dependency versions as part of the tested revisions;
an intentional dependency update is a possible source of a real change, not a
reason to silently omit that result. Explain uncontrolled environment differences.

Compare corresponding successful metrics and report failure-rate differences.
Apply only agreed thresholds; without them provide deltas but no gating verdict.
Keep missing/zero baselines explicit, and never invent a relative percentage for
division by zero. Missing or incompatible evidence makes comparison inconclusive,
while the candidate's standalone report remains useful.
