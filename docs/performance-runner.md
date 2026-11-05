# Scenario performance runner

The runner measures explicit scenarios, not unit-test/build duration. It does not
fetch a baseline, build an application, install on the host, or change the current
checkout. Playwright is a root development dependency, not a desktop runtime
dependency. Run `npm install` at the repository root before using the UI driver.

## Agent entry point

In a local Codex session opened on this repository, invoke:

```text
$test-performance
```

The repository skill prepares missing build dependencies and runtime resources,
packages the current checkout, runs every built-in performance case, and delivers
an interpreted report. The default is three samples per case with the local
`fixed-response` model and no baseline comparison. Add a case name or other
requirements only when narrowing or overriding that default.

The suite is discovered from `SCENARIOS` in `scripts/performance/results.mjs`, not
from a case list embedded in the prompt. New built-in cases are included without
changing the invocation. External-fixture cases remain explicit opt-ins. Normal
permission approvals still apply to dependency downloads and desktop launches.

## Preparing a complete application

For the agent's default current-checkout workflow, inspect the generated desktop
resources before packaging. A normal `pack` prepares native helpers and the Weixin
plugin, but does not itself stage Node and OpenClaw. An isolated performance fixture
cannot rely on the user's existing OpenClaw installation.

When Node/OpenClaw resources are missing, run from the repository root:

```powershell
npm run prepare-resources --prefix desktop
npm run pack:prepared --prefix desktop
```

`prepare-resources` downloads the pinned OpenClaw runtime and recreates the
generated `desktop/resources` directory, including Node, OpenClaw and the native
resources. It can take substantial time and requires download/build permissions.
When those resources are already complete, `pack:prepared` can reuse them. Build
time is preparation, not a runtime metric.

Use the newly built `desktop/release/win-unpacked/MicroClawDesktop.exe` with its
complete directory, including `resources/node.exe` and `resources/openclaw.asar`.
No system installation is needed, and building does not update the existing
installed application. If the user supplies a specific artifact, use it unchanged
and diagnose missing resources rather than silently replacing it.

## Commands

```powershell
npm run perf -- report --app "C:\artifacts\win-unpacked\MicroClawDesktop.exe" --scenario all --samples 3
npm run perf -- compare --app "C:\artifacts\win-unpacked\MicroClawDesktop.exe" --baseline "build/performance/<baseline-run>/results.json" --scenario all --samples 3
npm run perf -- --help
```

All relative paths resolve against the repository root, even when the command is
started from another directory. Results go to `build/performance/<run-id>/` by
default; `--output` changes the parent directory. Existing runs are never reused.
Each desktop scenario starts in a fresh isolated profile, so an already-built EXE
may still need to extract its bundled runtime on the first launch. That unmeasured
setup uses `--setup-timeout-ms` (default `600000`); measured desktop actions keep
`--timeout-ms` (default `120000`). Setup elapsed time and its timeout are preserved
in `<scenario>.setup.json`, including failed launches. Increasing the setup timeout
does not rebuild the application or include setup time in restart/chat metrics.

Packaged startup prepares a missing or stale bundled runtime in a worker thread,
then completes integrity validation before creating the first window. A current
runtime cache is reused without starting a worker. The renderer loads before
Gateway preflight, so runtime extraction and plugin convergence do not block ASAR
navigation. Integrity validation is not skipped. Windows lifecycle matching uses
the Electron main-process PID, not Playwright's shell-wrapper PID.
Second-instance recovery waits for initial preparation and navigation rather than
racing a second extraction. Temporary cache-rename locks receive bounded retries;
fixture preparation failures are logged and exit without an interactive dialog.
Report mode has no baseline or regression verdict. Compare mode preserves the
candidate report when a baseline is missing, malformed or incompatible. It shows
deltas and failure-rate differences, without a gating verdict or invented thresholds.

Default scope, also selected by `--scenario all`, is every built-in case, with three
samples each. Currently these are `app.restart` and `chat.new-session`; newly
registered built-in cases are included automatically. `install.clean` requires
explicit selection and an external disposable-VM adapter, so it is not part of
the default suite. Without suitable prerequisites, affected samples are explicitly
`unavailable`.
`npm run perf -- report` is safe to use to check this reporting path: it does not
launch an application or contact a model provider without an `--app` argument.
The first version supports packaged Electron applications, not Vite/dev mode.

Exit codes: `0` means all selected scenarios were measured, `1` means incomplete
coverage or failed attempts, `2` means invalid arguments/runner errors, and `130`
means interruption. Comparison compatibility is separate from measurement coverage;
inspect `baseline.status` rather than interpreting exit code zero as a regression gate.

## Evidence and boundaries

Each run saves `results.json`, `report.md`, per-attempt JSON, observed renderer
milestones, sanitized Electron lifecycle summaries and model-request counts/timings.
`report.md` defaults to Chinese, retaining technical identifiers and original failure
diagnostics for traceability. `results.json` keeps its machine-readable schema and values.
The opening summary lists each built-in case's completion result, chat reply/error
checks, and arithmetic mean of successful `totalMs` samples in seconds. Unselected
cases are marked untested; failed or incomplete samples are excluded from the mean.
Chat checks cover the measured conversation, not a full application-log audit.
The source revision, relevant source-file hashes, dirty state, executable/application
archive hashes and environment are recorded outside the measured interval. An
existing binary is **not** attributed to the current source just because both are
available. Binary/source association remains unknown; retain your build provenance.
OpenClaw runtime archive identity is hashed when available; unavailable versions or
hardware information must not be inferred from the source checkout.

- `app.restart`: an initial unmeasured launch establishes readiness and disk caches.
  The measured interval starts with the normal-exit request and ends when the
  relaunched chat surface is observed ready. Both the owned desktop and Gateway
  must exit before relaunch. Reused Gateways, forced-shutdown fallbacks and missing
  startup summaries cannot produce a successful full-restart sample.
  Scenario/probe contract v2 additionally waits for the real Electron main PID,
  rejects a nonzero or signal-terminated Playwright wrapper, and requires matching
  post-request graceful exit receipts (PID and generation, exit code zero, no signal)
  for every Gateway spawned in the old main-process epoch. The new epoch must contain
  a live newly spawned Gateway and a different main/Gateway PID; absence of negative
  diagnostics is not affirmative proof of a normal restart.
  Desktop's owned-Gateway graceful-stop deadline is `330000` ms, matching the
  bundled OpenClaw 2026.10.5 service stop policy (`325000` ms for drain/cleanup plus
  a `5000` ms supervisor exit margin). This is an upper bound, not a fixed wait:
  shutdown completes as soon as the child exits. The old `10000` ms deadline
  could kill a Gateway still performing normal server cleanup. Lifecycle
  diagnostics record the requested deadline and any force fallback. The runner's
  measured-action timeout remains unchanged; exceeding it still fails the sample.
  A Gateway's own shutdown watchdog, nonzero exit, signal exit or failed stop
  observation also fails the sample, even without a Desktop force-fallback event.
  Packaged bundled-runtime ESM source is read from the existing `openclaw.asar`
  through one retained descriptor instead of reopening thousands of extracted
  module files. Normal Node resolution, archive-entry integrity verification and
  the downstream compatibility hooks remain active. External runtimes, local
  plugins, CommonJS, native modules and missing/unpacked archive entries retain
  normal filesystem loading. The extracted runtime still supplies resolution,
  package metadata, native binaries and other assets; build/extraction time is
  not part of the restart sample.
  The archive preload is inherited through `NODE_OPTIONS`, including OpenClaw's
  SQLite Workers and forked inspectors that explicitly clear `execArgv`. It only
  activates when the process/Worker entry belongs to the bundled runtime; unrelated
  Node tool processes do not open the archive or register the loader.
  The local-model compatibility preload registers its module loader even when the
  local provider is not installed yet. Unrelated modules pass through unchanged;
  provider entries and captured setup modules are checked against the pinned
  official version, source hashes and unredirected paths when loaded. First-use
  installation can therefore hot-load the verified adapter in the same Gateway
  process. The backend checks the applied provider runtime before preparation and
  requires exact-model selection and explicit download consent. The catalog's
  Download action passes `downloadConfirmed: true` with the exact model
  reference; after validating the provider's pinned download plan, the backend
  consumes that approval once without a second UI confirmation. Approval is not
  persisted across app restarts, reused by other operations, or applied to
  unexpected confirmation steps. Cancelling revokes unused approval. Legacy setup
  and recovered operations still require confirmation when no approval exists.
  Ordinary model-picker selections are not download approvals; only an explicit
  Download action opts into this one-click flow.
  Installation does not require a Gateway restart or bypass those checks.
- `chat.new-session`: the real new-conversation button and composer are operated.
  If the fixture's current conversation is empty, one UI chat first makes it nonempty
  outside the measured interval. This preparation uses the same reply/error gates,
  counts toward the shared model request budget, and is retained as `preparation`
  in the per-attempt JSON. A failed preparation cannot become a successful sample.
  The existing UI behavior of reusing an empty conversation is unchanged. Each
  measured click must select a different, previously unused, empty conversation;
  merely clicking the button does not satisfy the new-session boundary.
  The renderer records the click and submit keydown with its own monotonic clock.
  Session/run matching, response completion, nonempty answer DOM visibility and
  paint opportunities are required. Reasoning/tool panels, lifecycle-end alone,
  empty finals, duplicate terminal events and unrelated sessions cannot complete
  the sample. The send promise is not a completion signal.
  Probe v2 binds the run ID from the actual `chat.send` acknowledgment, retaining
  early events until it arrives. Only new visible answer bodies attributed to that
  run count; an old answer elsewhere in the DOM cannot satisfy the fixed-response
  check. Matching errors/cancellation or a reported conversation error through final
  rendering fail the sample, including errors arriving after `final` but before paint.
  Ordinary launches without the performance flag install no probe or observers.
  Old v1 packaged probes are rejected with an upgrade diagnostic. Both scenarios
  are version 2; prior reports remain intact and cannot be treated as measurements
  under the stricter contract or directly compared as compatible baselines.
- `install.clean`: the VM adapter supplies confirmation-through-first-service-
  readiness-and-final-validation timing, excluding VM restore/boot and human
  approval waits. It must restore its clean fixture before every sample.

Runner-side restart timing and renderer-side chat timing use separate clocks;
their absolute timestamps are not subtracted. UI detection and observer scheduling
add overhead: DOM visibility after paint opportunities is not physical screen
presentation timing. Main-process startup stages are nested/cumulative and must
not be summed blindly. GPU details, provider token counts and internal model-runtime
stages are not currently measured.

All failed attempts remain visible with elapsed time and classification. After a
failed sample, remaining samples in that scenario are skipped rather than silently
retrying or altering the fixture. Statistics include only successful metric samples;
missing values are `null`, never zero. Reports show median/min/max/count, not a
purported stable p95 from a few samples.

## Model profiles

`fixed-response` uses a real UI, desktop and Gateway against a loopback-only model
service implementing OpenAI chat completions. It emits `MICROCLAW_` and `PERF_OK`
with a fixed 20 ms delay per chunk. This measures product overhead, not inference
or remote-provider latency. The synthetic profile starts without personal history,
extra plugins or bundled skills; the application may converge its own resources.

For `real-model`, explicitly authorize the model, sample count and **whole-run**
request budget, including normal application warmup and title-generation requests:

```powershell
npm run perf -- report --app "C:\artifacts\win-unpacked\MicroClaw.exe" --scenario chat.new-session --profile real-model --model "<model-id>" --endpoint "https://<provider>/v1" --api-key-env PERF_MODEL_API_KEY --samples 3 --max-model-requests 12
```

Set `PERF_MODEL_API_KEY` separately using your normal secret-management method.
Never put an API key in arguments or fixture JSON. The local proxy forwards only
chat-completion requests to the explicit HTTPS endpoint (loopback HTTP is allowed
for local inference), refuses redirects and enforces the request budget across all
scenarios. It does not record request bodies, response text or the key. It uses
the normal provider adapter chain; it does not mock Gateway `chat.send`.
No arbitrary provider protocols or Vite/browser mocks are supported in this version.
Disk caches are retained across samples after the initial unmeasured launch; this
is not an OS cold-boot or model-cold-start measurement. Profiles must not be mixed.

## Isolation and ordinary-use overhead

Normal startup has no runner, model server, performance IPC, observer or timer.
The renderer probe is dynamically imported only when the main process has validated
the explicit disposable-fixture marker and token. With performance mode disabled,
the fixture configuration returns before filesystem access or environment changes.
There remains a small one-time module/flag-check cost; no zero-overhead claim is made.

In performance mode, home, app-data, Electron user/session data, temporary paths,
OpenClaw state, credentials and Gateway port are isolated. Existing personal state
is never copied. Fixture model tools are denied globally (`tools.deny: ["*"]`),
not merely discouraged by the prompt. Auto-start synchronization is suppressed. A port collision fails
the fixture rather than reusing or terminating an external Gateway; forced cleanup
does not scan for unrelated listener PIDs. Cleanup targets the launched desktop
process; its normal lifeline shutdown owns the Gateway. Fixtures are retained for
diagnosis and are not recursively deleted by the runner. After a failed cleanup,
review the reported owned process before removing fixture directories.

Before launch the packaged `resources/app.asar` is checked for the isolation
contract. Older builds are reported unavailable without being launched. Rebuild
the application with the new hooks before measuring. This is an accidental-old-
artifact guard, not a trust or security verification of arbitrary executables.

## Clean-install VM adapter

There is deliberately no built-in command that installs/uninstalls on the user's
host, and no bundled Hyper-V/Windows Sandbox provisioning backend yet. A trusted
external VM adapter is required for actual clean-install measurements. The test
adapter under `scripts/performance/test-fixtures/` is synthetic test data only.

```powershell
npm run perf -- report --scenario install.clean --installer "C:\artifacts\MicroClawSetup.exe" --install-fixture "C:\fixtures\install-vm.json" --samples 3
```

The adapter descriptor has this contract:

```json
{
  "kind": "microclaw.performance.install-vm.v1",
  "disposable": true,
  "restorePerSample": true,
  "vmId": "dedicated-performance-vm",
  "imageId": "clean-image-version",
  "prerequisites": { "node": false, "git": false, "openclaw": false, "downloadCache": "empty" },
  "executable": "C:\\absolute\\path\\to\\adapter.exe",
  "args": []
}
```

For each attempt the runner executes the explicit executable without a shell,
appending `--request <request.json> --result <result.json>`. Requests include
`schemaVersion`, `runId`, `sampleId`, `installer`, VM/image identity and timeout.
The adapter must restore before installation, control the installer confirmation
boundary, collect existing installer step timings and first-launch milestones,
exclude human wait, handle cancellation/cleanup, and write the matching identity:

```json
{
  "schemaVersion": 1,
  "runId": "<from request>",
  "sampleId": "<from request>",
  "outcome": "success",
  "restored": true,
  "clean": true,
  "serviceReady": true,
  "finalValidation": true,
  "elapsedMs": 1234,
  "metrics": { "totalMs": 1234, "stage.installation": 1000 },
  "evidence": ["relative-sanitized-log.jsonl"]
}
```

Failures use `failed`, `timeout` or `cancelled`; unavailable completion metrics are
null. Evidence must stay inside the run directory and contain no credentials or
private chat contents. Successful extraction, upgrade checks or preinstalled
dependency checks are not a clean installation. The VM adapter is trusted code;
the descriptor's assertions do not independently prove its VM isolation.

## Focused tests

```powershell
npm run test:perf
cd desktop
npx --no-install vitest run src/performance-fixture.test.ts
cd renderer
npx --no-install vitest run src/performance-sample.test.ts src/performance-probe.test.ts
```

These tests cover contracts, isolation guards, deterministic SSE, request budgets,
report/compare behavior, failures and completion boundaries. They do not substitute
for a packaged-application end-to-end run or a real disposable-VM installation.
