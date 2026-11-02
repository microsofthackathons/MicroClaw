import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { parseOptions, ROOT } from "./cli.mjs";
import {
  aggregate,
  builtInScenarioIds,
  compare,
  emptyMetrics,
  SCENARIOS,
  summarize,
} from "./results.mjs";
import { createFixture, sanitizeError } from "./fixtures.mjs";
import { collectArtifact, inspectFile } from "./provenance.mjs";
import { FIXED_TEXT, startModelService } from "./model-service.mjs";
import { validateInstallFixture, validateInstallResult } from "./install.mjs";
import { runPerformance } from "./runner.mjs";

const roots = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "microclaw-perf-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), await realpath(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("CLI validates scope and keeps compare explicit", () => {
  const options = parseOptions(["report", "--scenario", "chat.new-session", "--samples", "2"]);
  assert.equal(options.mode, "report");
  assert.deepEqual(options.scenarios, ["chat.new-session"]);
  assert.equal(options.samples, 2);
  assert.equal(options.output, path.join(ROOT, "build", "performance"));
  assert.throws(() => parseOptions(["--samples", "0"]), /positive/);
  assert.throws(() => parseOptions(["--samples", "1.5"]), /positive/);
  assert.throws(() => parseOptions(["--scenario", "unknown"]), /Unknown scenario/);
  assert.throws(() => parseOptions(["report", "--baseline", "baseline.json"]), /compare/);
});

test("CLI defaults to every built-in case and accepts the all selector", () => {
  const defaults = parseOptions([]);
  assert.deepEqual(defaults.scenarios, ["app.restart", "chat.new-session"]);
  assert.equal(defaults.samples, 3);
  assert.equal(defaults.profile, "fixed-response");
  assert.deepEqual(parseOptions(["--scenario", "all"]).scenarios, defaults.scenarios);
  assert.deepEqual(parseOptions(["--scenario", "all,app.restart"]).scenarios, defaults.scenarios);
});

test("the built-in suite discovers new registered cases without a separate allowlist", () => {
  const registry = {
    ...SCENARIOS,
    "future.case": { version: 1, endpoints: { totalMs: "start -> end" } },
  };
  assert.deepEqual(builtInScenarioIds(registry), [...builtInScenarioIds(), "future.case"]);
});

test("cold fixture preparation has a separate timeout from measured desktop actions", () => {
  const defaults = parseOptions([]);
  assert.equal(defaults.timeoutMs, 120000);
  assert.equal(defaults.setupTimeoutMs, 600000);
  const options = parseOptions(["--timeout-ms", "2000", "--setup-timeout-ms", "900000"]);
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.setupTimeoutMs, 900000);
  assert.equal(parseOptions(["--timeout-ms", "2000"]).setupTimeoutMs, 600000);
  assert.throws(() => parseOptions(["--setup-timeout-ms", "0"]), /positive/);
  assert.throws(() => parseOptions(["--setup-timeout-ms", "1.5"]), /positive/);
});

test("external-fixture cases remain available through explicit selection", () => {
  assert.deepEqual(parseOptions(["--scenario", "install.clean"]).scenarios, ["install.clean"]);
  assert.deepEqual(parseOptions(["--scenario", "all,install.clean"]).scenarios, [
    ...builtInScenarioIds(),
    "install.clean",
  ]);
});

test("real-model is opt-in with explicit sample and total request budgets", () => {
  assert.throws(() => parseOptions(["--profile", "real-model"]), /explicit/);
  const args = [
    "--profile",
    "real-model",
    "--model",
    "model",
    "--endpoint",
    "https://example.com/v1",
    "--samples",
    "2",
    "--max-model-requests",
    "8",
    "--api-key-env",
    "PERF_KEY",
  ];
  assert.throws(() => parseOptions(args, {}), /populated/);
  const options = parseOptions(args, { PERF_KEY: "secret" });
  assert.equal(options.apiKey, "secret");
  assert.equal(options.maxRequests, 8);
  assert.throws(
    () =>
      parseOptions(
        args.map((value) => (value === "https://example.com/v1" ? "http://example.com/v1" : value)),
        { PERF_KEY: "secret" },
      ),
    /HTTPS/,
  );
});

test("aggregation excludes null and failures while preserving failed durations", () => {
  assert.deepEqual(aggregate([null, undefined, -1, NaN, 10, 30, 20, 40]), {
    count: 4,
    median: 25,
    min: 10,
    max: 40,
  });
  const scenarios = [
    { id: "chat.new-session", ...SCENARIOS["chat.new-session"], requestedSamples: 2 },
  ];
  const samples = [
    {
      scenarioId: "chat.new-session",
      outcome: "success",
      metrics: { totalMs: 10, sessionReadyMs: 1, sendToFirstTextMs: 2, sendToFinalRenderedMs: 9 },
    },
    {
      scenarioId: "chat.new-session",
      outcome: "timeout",
      elapsedMs: 100,
      metrics: { ...emptyMetrics("chat.new-session"), totalMs: 999 },
    },
  ];
  const summary = summarize(scenarios, samples);
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.scenarios[0].failed, 1);
  assert.equal(summary.scenarios[0].metrics.totalMs.median, 10);
  assert.equal(summary.scenarios[0].failedElapsedMs.median, 100);
});

test("comparisons reject mixed profiles and never divide by a zero baseline", () => {
  const scenario = {
    id: "app.restart",
    ...SCENARIOS["app.restart"],
    profile: "fixed-response",
    fixture: { version: 1 },
    cachePolicy: "warm",
    packaging: "packaged",
    requestedSamples: 1,
  };
  const result = {
    schemaVersion: 1,
    environment: { machineId: "test" },
    scenarios: [scenario],
    summary: {
      scenarios: [
        { id: "app.restart", observed: 1, failed: 0, metrics: { totalMs: aggregate([0]) } },
      ],
    },
  };
  const candidate = structuredClone(result);
  candidate.summary.scenarios[0].metrics.totalMs = aggregate([5]);
  const comparison = compare(candidate, result);
  assert.equal(comparison.status, "comparable");
  assert.equal(comparison.deltas[0].metrics.totalMs.relativePercent, null);
  candidate.scenarios[0].profile = "real-model";
  assert.equal(compare(candidate, result).status, "inconclusive");
  assert.equal(compare(candidate, null).status, "inconclusive");
  assert.equal(
    compare(candidate, { schemaVersion: 1, scenarios: "malformed" }).status,
    "inconclusive",
  );
  assert.equal(
    compare(candidate, {
      schemaVersion: 1,
      scenarios: [null],
      summary: { scenarios: [] },
      environment: {},
    }).status,
    "inconclusive",
  );
});

test("model fixture emits deterministic streamed text without persisting prompts", async () => {
  const service = await startModelService({ maxRequests: 2 });
  try {
    const response = await fetch(`${service.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "perf-fixed",
        stream: true,
        messages: [{ role: "user", content: "not-to-be-recorded" }],
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.text();
    const content = data
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "")
      .join("");
    assert.equal(content, FIXED_TEXT);
    assert.ok(data.includes("data: [DONE]"));
    assert.ok(!JSON.stringify(service.requests).includes("not-to-be-recorded"));
  } finally {
    await service.close();
  }
});

test("request budget is shared across services/scenarios", async () => {
  const budget = { remaining: 1 };
  const first = await startModelService({ budget });
  const second = await startModelService({ budget });
  try {
    const body = JSON.stringify({ model: "perf-fixed" });
    assert.equal(
      (await fetch(`${first.baseUrl}/chat/completions`, { method: "POST", body })).status,
      200,
    );
    assert.equal(
      (await fetch(`${second.baseUrl}/chat/completions`, { method: "POST", body })).status,
      429,
    );
    assert.equal(budget.remaining, 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test("fixture is fresh, local-only and never inherits production credentials", async () => {
  const root = await temporary();
  const fixture = await createFixture(path.join(root, "fixture"), {
    baseUrl: "http://127.0.0.1:12345/v1",
    model: "perf-fixed",
    baseEnvironment: {
      PATH: process.env.PATH,
      PERF_BEARER: "not-inherited",
      OPENAI_API_KEY: "not-inherited",
    },
    secretEnvironmentKeys: ["PERF_BEARER"],
  });
  const config = JSON.parse(
    await readFile(path.join(fixture.root, "state", "openclaw.json"), "utf8"),
  );
  assert.equal(config.gateway.bind, "loopback");
  assert.deepEqual(config.tools, { profile: "minimal", deny: ["*"] });
  assert.equal(config.gateway.port, fixture.gatewayPort);
  assert.equal(fixture.environment.OPENCLAW_STATE_DIR, path.join(fixture.root, "state"));
  assert.ok(!Object.keys(fixture.environment).some((key) => /API_KEY|SECRET|PASSWORD/.test(key)));
  assert.equal(fixture.environment.PERF_BEARER, undefined);
  await assert.rejects(
    createFixture(fixture.root, { baseUrl: "unused", model: "unused" }),
    /EEXIST/,
  );
  assert.equal(
    sanitizeError(new Error("Bearer abc token=def hidden"), ["hidden"]),
    "Bearer [redacted] token=[redacted] [redacted]",
  );
});

test("old packaged artifacts are rejected before launch", async () => {
  const root = await temporary();
  const app = path.join(root, "MicroClaw.exe");
  await writeFile(app, "not-an-application");
  await mkdir(path.join(root, "resources"));
  await writeFile(path.join(root, "resources", "app.asar"), "old application");
  assert.equal((await collectArtifact(app)).available, false);
  await writeFile(path.join(root, "resources", "app.asar"), "microclaw.performance.fixture.v1");
  assert.equal((await collectArtifact(app)).available, true);
  assert.equal((await inspectFile(app)).sha256.length, 64);
});

test("install adapter cannot claim a clean success without all readiness gates", () => {
  assert.throws(() => validateInstallFixture({ disposable: true }), /VM/);
  const request = { runId: "run", sampleId: "sample" };
  const result = {
    ...request,
    schemaVersion: 1,
    outcome: "success",
    restored: true,
    clean: true,
    serviceReady: true,
    finalValidation: true,
    elapsedMs: 100,
    metrics: { totalMs: 100 },
  };
  assert.equal(validateInstallResult(result, request), result);
  assert.throws(() => validateInstallResult({ ...result, clean: false }, request), /clean/);
  assert.throws(() => validateInstallResult({ ...result, sampleId: "old" }, request), /identity/);
  assert.throws(
    () => validateInstallResult({ ...result, metrics: { totalMs: NaN } }, request),
    /timing/,
  );
  assert.throws(
    () => validateInstallResult({ ...result, evidence: ["../outside.log"] }, request),
    /relative/,
  );
});

test("missing prerequisites still produce a complete unavailable report without baseline claims", async () => {
  const root = await temporary();
  const options = { ...parseOptions(["report", "--samples", "2"]), root, output: root };
  const { output, result } = await runPerformance(options);
  assert.equal(result.summary.coverage, "unavailable");
  assert.equal(result.samples.length, options.samples * options.scenarios.length);
  assert.ok(
    result.samples.every(
      (sample) => sample.outcome === "unavailable" && sample.metrics.totalMs === null,
    ),
  );
  assert.equal("baseline" in result, false);
  assert.equal(
    JSON.parse(await readFile(path.join(output, "results.json"), "utf8")).runId,
    result.runId,
  );
  const report = await readFile(path.join(output, "report.md"), "utf8");
  assert.match(report, /# MicroClaw 性能测试报告/);
  assert.match(report, /覆盖状态：不可用（unavailable）/);
  assert.doesNotMatch(report, /## 基线对比/);
});

test("missing comparison baseline does not suppress the candidate report", async () => {
  const root = await temporary();
  const { result } = await runPerformance({
    ...parseOptions(["compare", "--scenario", "app.restart", "--samples", "1"]),
    root,
    output: root,
  });
  assert.equal(result.baseline.status, "inconclusive");
  assert.equal(result.samples.length, 1);
});

test("VM adapter integration uses per-attempt request identities and external timings", async () => {
  const root = await temporary();
  const adapter = path.join(root, "adapter.json");
  const installer = path.join(root, "installer.exe");
  await writeFile(installer, "fixture-installer");
  await writeFile(
    adapter,
    JSON.stringify({
      kind: "microclaw.performance.install-vm.v1",
      disposable: true,
      restorePerSample: true,
      imageId: "fixture-image-v1",
      vmId: "fixture-vm",
      executable: process.execPath,
      args: [fileURLToPath(new URL("./test-fixtures/install-adapter.mjs", import.meta.url))],
    }),
  );
  const options = parseOptions([
    "--scenario",
    "install.clean",
    "--samples",
    "2",
    "--install-fixture",
    adapter,
    "--installer",
    installer,
  ]);
  const { result } = await runPerformance({ ...options, root, output: root });
  assert.equal(result.summary.coverage, "measured");
  assert.equal(result.samples[0].metrics.totalMs, 123);
  assert.equal(result.samples[1].metrics.totalMs, 123);
  assert.notEqual(result.samples[0].sampleId, result.samples[1].sampleId);
});
