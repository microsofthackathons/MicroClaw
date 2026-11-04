---
name: test-performance
description: Prepare, build, run all built-in MicroClaw performance cases, and deliver a measured report. Use for end-to-end performance testing or explicitly requested baseline comparisons, not ordinary unit tests or unrelated optimization.
---

# Test Performance

## One-command workflow

`$test-performance` requests an end-to-end report for the current checkout. Do the
preparation, packaging, execution and report interpretation rather than handing
the user a list of shell commands.

- Run every built-in case via the runner's `all` selector, with three samples per
  case and the deterministic `fixed-response` model. Discover cases from the runner
  registry; do not hardcode a pair of case names or a fixed case count.
- Prepare missing repository-local dependencies and generated runtime resources,
  then build a complete packaged application. Request required permissions at the
  relevant operation; do not install or replace the user's system application.
- Preserve the current checkout and uncommitted changes. An explicitly supplied
  application artifact is measured as supplied, not silently rebuilt or replaced.
- External-fixture cases such as `install.clean` require explicit selection and a
  disposable VM adapter; they are not part of the built-in suite.
- Honor explicit scenario, sample, model and comparison choices instead of these
  defaults. Do not fetch a baseline or use a real provider for a bare invocation.

## Choose the mode

- **Report (default):** Measure the current checkout and explain its absolute
  timings, stage breakdown, slowest stages, failures, and coverage. No baseline is
  required. Do not fetch main, switch revisions, or add percentage-change columns.
- **Compare (explicit request):** Measure or load a baseline and candidate under
  comparable conditions, then report differences. If the baseline is missing or
  incompatible, still produce the candidate report and mark comparison inconclusive.

Examples:

- "Report this repository's current startup and chat performance" selects report.
- "Profile the current checkout without comparing main" selects report.
- "Compare this PR with main for performance regressions" selects compare.

A report without a baseline must not claim regression, improvement, or no regression.
An explicitly requested absolute budget can be evaluated without a baseline; label
that finding as a budget result, not a regression result.

## Establish the measurement

Treat the directory containing `.agents/` as the repository root. Read
[scenario definitions and result contract](references/scenarios.md) for the selected
scenarios before measuring.

1. Record the current revision, dirty-tree state, application artifact identity,
   scenario version, and relevant environment. Include uncommitted changes when
   the request is about the current checkout; never silently replace it with HEAD.
2. Read [preparation, runner usage and limitations](../../../docs/performance-runner.md).
   Use the checked-in resource-preparation and packaging scripts; `pack` alone does
   not guarantee that the packaged application contains Node and OpenClaw. Unless
   the user supplied an artifact, build from the current checkout and verify that
   the complete runtime was packaged before launching the runner.
3. Use `npm run perf -- report --app "<packaged executable>" --scenario all
   --samples 3` by default, or pass the user's explicit scope and sample count.
   Reuse the runner's deterministic execution, timing, aggregation and comparison
   helpers. The runner defaults to a deterministic local model fixture; real-model
   runs require an explicit model, sample count and whole-run request budget.
   Clean installation requires an explicitly disposable external VM adapter; no
   VM provisioning backend is bundled. Missing prerequisites produce an unavailable
   report, not synthetic timings. Do not launch an older binary without the runner's
   isolation contract or replace an explicitly supplied application artifact.
4. Prefer a packaged application built from the recorded source. Keep build time
   outside runtime metrics. A dev-mode measurement is allowed when requested, but
   label it explicitly and do not compare it with a packaged build.
5. Distinguish a fresh run, imported logs, and source-code analysis. Imported logs
   need provenance before attribution to the current checkout. Code inspection
   explains paths and hypotheses; it cannot supply measured durations.

## Execute only the requested scope

- Run only the selected performance scenarios, not the full unit/lint/build suite
  unless those operations are needed and within the user's request.
- Use an isolated disposable environment for installation. Do not uninstall or
  repair the user's real installation, remove their OpenClaw state, or terminate
  unrelated processes to obtain a sample.
- Keep restart fixtures, cache policy, and model conditions consistent. Agent
  planning, report generation, and artifact preparation are outside scenario timing.
- Real-model runs can consume API quota or substantial local resources. Establish
  the model and authorized sample count; do not silently substitute credentials or
  expand the workload. Keep fixed-response and real-model results separate.
- Preserve every attempt, including failures and timeouts. A retry is a new sample,
  not a replacement for a failed sample. Do not manufacture missing timings.

## Diagnose setup failures

Read the report, per-attempt evidence and isolated startup logs before proposing a
rerun. Resolve safe, repository-local build, runtime-resource or test-fixture issues
yourself; do not change business behavior to obtain better timings. Allow at most
one corrective rerun by default, in a new run directory with the earlier evidence
retained. If execution still cannot proceed, report the concrete blocker and what
was tried instead of repeatedly asking the user to run the same command.

## Produce the report

Save `report.md` and `results.json` under `build/performance/<run-id>/` when reporting
is possible. Resolve output paths against the repository root, not the shell's
starting directory. Do not commit generated evidence or include credentials and
private chat contents in artifacts.

For **report**, include:

- Source/artifact/environment identity, selected scenarios, and evidence provenance.
- Start/end definitions, cache/model conditions, successful/total attempts, and
  individual samples with observed timings.
- Median and min/max of successful samples; failures and their elapsed times remain
  visible separately. State when there is only one sample or no usable sample.
- Available stage breakdowns, the slowest observed stages, measurement gaps, and
  clearly separated hypotheses or optimization suggestions.
- A `measured`, `partial`, or `unavailable` coverage status; no comparison verdict.

For **compare**, include the report information plus baseline identity,
comparability checks, absolute/relative changes, and the agreed budget/threshold
evaluation. Use supplied thresholds or checked-in configuration, not invented ones.
Do not silently rebaseline, change thresholds, or exclude unfavorable samples.

If no execution or attributable logs are available, produce an unavailable report
explaining what is missing rather than presenting a design review as measured data.
Running this skill does not authorize publishing PR comments, changing CI policy,
committing results, or modifying OpenClaw.
