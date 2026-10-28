# Desktop startup timing

The desktop reports startup timing without changing OpenClaw, starting extra
processes, or making additional readiness requests. All values are wall-clock
milliseconds measured with the Electron main process's monotonic clock.

## Log records

- `[startup-timing]` marks application milestones such as `app-ready`,
  `window-created`, `integrity-complete`, and `renderer-loaded`. The `+...ms`
  value is elapsed time from the Electron process's time origin, including
  main-module initialization. It does not include `npm`, TypeScript compilation,
  Vite startup, or the operating system's work before that time origin.
- `[startup-breakdown]` contains JSON phase records with `owner`, `phase`,
  `durationMs`, `appElapsedMs`, `attempt`, and `gatewayGeneration`.
- `[startup-summary]` contains JSON cumulative summaries at HTTP readiness,
  WebSocket connection, application service readiness, and the first successful
  history response. Summaries are also saved as `startup-summary` events in
  `diagnostics/electron-lifecycle.jsonl` under Electron's user-data directory.

Every Gateway startup attempt has its own attempt number. Once spawned, records
also identify the Gateway generation. Retries and later restarts are not folded
into the first attempt.

## Attribution

| Field | Meaning |
| --- | --- |
| `appBeforeAttemptMs` | Application age before this attempt. On initial startup this is Electron/MicroClaw bootstrap; on later attempts it includes prior activity and is not attributed to MicroClaw preparation. |
| `microclawPreflightMs` | This attempt's MicroClaw preparation, from entering Gateway startup until spawning or reusing the process. |
| `openclawHttpMs` | From immediately before spawning the Gateway child until MicroClaw observes HTTP health readiness. This process-boundary measurement includes OS scheduling, compatibility preloads, and readiness-poll detection delay, not just OpenClaw's own CPU time. |
| `integrationMs` | From observed HTTP readiness until the summary milestone, including desktop commit work, WebSocket authentication, security activation, renderer scheduling, and RPC waits. For a reused Gateway it begins at the reuse decision. |
| `attemptElapsedMs` | Total elapsed time for this attempt at the summary milestone. |
| `appElapsedMs` | Elapsed time since the Electron main-process time origin. |

MicroClaw phases split preparation into configuration/personas, the existing
Gateway check, Weixin runtime verification, agent skills/workspaces, old-process
shutdown/port release, and spawn preparation. The Weixin phase includes any
required installation or repair; it is near zero when convergence is deferred
because a Gateway is already running.

For a normally observed cold start, `microclawPreflightMs + openclawHttpMs +
integrationMs` equals `attemptElapsedMs`, subject to millisecond rounding.
`appBeforeAttemptMs + attemptElapsedMs` equals `appElapsedMs`. Integration phase
durations cover consecutive observed milestones, whereas summary values are
cumulative: do not sum multiple summaries. Renderer loading runs in parallel
with service startup, so do not add `renderer-loaded` elapsed time to Gateway
startup time.

`mode: "reused"` means no child was spawned. `openclawHttpMs` is `null`, not an
invented zero-duration cold start. It is also `null` if HTTP readiness was never
observed before the health-check timeout, even if WebSocket connects later.

HTTP readiness and application service readiness do not prove that the agent's
model runtime has finished preparation. `first-history-response` records the
first successful existing renderer history request; it adds no probe or model
inference. It is an observed milestone, not the exact internal readiness time,
and can include renderer retries or user delay. OpenClaw's existing startup
trace remains the source for its internal database/plugin/model subphases.

## Weixin verification

An unchanged installation is fully validated against the bundled provenance
manifest, including every installed file's SHA-256, the exact file list, and
the OpenClaw peer link. The package identity and host SDK remain checked.
Only a missing or invalid installation triggers a full scan of the bundled
runtime before staging and replacement. Staged and installed replacements
retain the original verification and rollback checks.

This avoids hashing two complete copies on every unchanged startup. It does
not use an mtime-only cache, skip installed-file verification, or alter Weixin
account state. Next manual launch measurements, rather than the earlier
read-only sample, determine the actual speedup.
