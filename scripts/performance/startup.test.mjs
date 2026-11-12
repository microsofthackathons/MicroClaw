import assert from "node:assert/strict";
import { test } from "node:test";
import { collectStartupTiming } from "./startup.mjs";
import { collectInstallTiming } from "./install.mjs";

test("startup evidence isolates process epochs and preserves retry and worker clocks", () => {
  const event = (event, fields) => ({ event, processId: 2, timingVersion: 2, ...fields });
  const records = [
    { event: "main-process-start", processId: 1 },
    { event: "startup-summary", processId: 1, timingVersion: 2, phase: "old" },
    { event: "main-process-start", processId: 2 },
    event("startup-milestone", { phase: "renderer-loaded", appElapsedMs: 2000 }),
    event("startup-runtime-phase", {
      phase: "archive-extract",
      scope: "worker",
      status: "failed",
      durationMs: 50,
      elapsedMs: 80,
    }),
    event("startup-runtime-phase", {
      phase: "preparation-total",
      scope: "desktop",
      status: "success",
      durationMs: 100,
    }),
    event("startup-breakdown", { phase: "existing-gateway-check", attempt: 1, durationMs: 30 }),
    event("startup-outcome", { status: "retry", attempt: 1, attemptElapsedMs: 600 }),
    event("startup-breakdown", { phase: "existing-gateway-check", attempt: 2, durationMs: 10 }),
    event("startup-summary", { phase: "application-service-ready", attempt: 2 }),
  ];
  const result = collectStartupTiming(records, 2);
  assert.equal(result.coverage, "complete");
  assert.equal(result.phases.length, 2);
  assert.equal(result.summaries.length, 1);
  assert.equal(result.outcomes[0].status, "retry");
  assert.equal(result.runtime[0].elapsedMs, 80);
  assert.equal(result.runtime[0].durationMs, 50);
  assert.equal(collectStartupTiming(records, 99).coverage, "unavailable");
  assert.equal(collectStartupTiming(records.slice(0, -1), 2).coverage, "partial");
});

test("installer evidence rejects other attempts and retains partial failures and waits", () => {
  const request = { runId: "run", sampleId: "sample" };
  const event = {
    schemaVersion: 2,
    ...request,
    stageId: "desktop-60",
    phase: "attempt",
    kind: "phase",
    status: "failed",
    elapsedMs: 500,
    durationMs: 100,
    attempt: 1,
  };
  const line = (value) => "[INFO] MICROCLAW_INSTALL_TIMING " + JSON.stringify(value);
  const partial = collectInstallTiming(
    [
      [
        "unrelated output",
        "MICROCLAW_INSTALL_TIMING malformed",
        line({ ...event, sampleId: "old" }),
        line(event),
        line({ ...event, phase: "retry-wait", status: "success", durationMs: 1000 }),
      ].join("\n"),
    ],
    request,
  );
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.events.length, 2);
  assert.equal(partial.events[0].status, "failed");
  const complete = collectInstallTiming(
    [
      line({
        ...event,
        phase: "installation-total",
        kind: "summary",
        stepCount: 0,
        status: "failed",
        activeMs: 200,
        humanWaitMs: 300,
      }),
    ],
    request,
  );
  assert.equal(complete.coverage, "complete"); // complete evidence, not a successful install
  assert.equal(complete.events[0].activeMs, 200);
  assert.equal(
    collectInstallTiming(
      [
        line({
          ...event,
          phase: "installation-total",
          kind: "summary",
          status: "started",
          stepCount: 0,
        }),
      ],
      request,
    ).coverage,
    "partial",
  );
});
