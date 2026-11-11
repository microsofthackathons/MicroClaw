import assert from "node:assert/strict";
import { test } from "node:test";
import { reportText } from "./report-zh.mjs";
import { SCENARIOS, compare, emptyMetrics, renderReport, summarize } from "./results.mjs";

function recordedResult(scenarioId = "app.restart", outcomes = ["success"]) {
  const scenario = {
    id: scenarioId,
    ...SCENARIOS[scenarioId],
    profile: "fixed-response",
    packaging: "packaged",
    cachePolicy: "retained-disk-caches-after-unmeasured-initial-launch",
    fixture: { model: "perf-fixed" },
    requestedSamples: outcomes.length,
  };
  const samples = outcomes.map((outcome, index) => ({
    scenarioId,
    sampleId: `${scenarioId}-${index + 1}`,
    outcome,
    elapsedMs: outcome === "success" ? 110 : 99999,
    metrics:
      outcome === "success"
        ? Object.fromEntries(Object.keys(scenario.endpoints).map((metric) => [metric, 100.125]))
        : emptyMetrics(scenarioId),
    failure: outcome === "success" ? null : { message: "Original | failure\ndetail" },
    evidence: [`${scenarioId}-${index + 1}.json`],
  }));
  return {
    schemaVersion: 1,
    mode: "report",
    runId: "recorded-run",
    startedAt: "2026-10-31T08:13:26.742Z",
    finishedAt: "2026-10-31T08:24:06.096Z",
    source: {
      revision: "recorded-revision",
      dirty: true,
      artifact: {
        executableSha256: "recorded-hash",
        sourceAssociation: "unknown: binary hashes do not establish which checkout built them",
      },
    },
    environment: { machineId: "recorded-machine" },
    scenarios: [scenario],
    samples,
    summary: summarize([scenario], samples),
    limitations: [
      "Synthetic fixture has no personal sessions, plugins or bundled skills enabled; it is not a measurement of a user's populated profile.",
    ],
  };
}

test("Chinese reports retain recorded identities, timings and evidence without mutating results", () => {
  const result = recordedResult("app.restart", ["success", "timeout"]);
  const original = JSON.stringify(result);
  const report = renderReport(result);
  assert.match(report, /# MicroClaw 性能测试报告/);
  assert.match(report, /覆盖状态：部分实测（partial）；成功 1\/2；失败 1/);
  assert.match(report, /总耗时（totalMs） \| 1 \| 100\.13 \| 100\.13 \| 100\.13/);
  assert.match(report, /超时（timeout）；本次采样耗时 99999\.00 ms/);
  assert.ok(report.includes("Original \\| failure detail"));
  assert.match(report, /证据文件：app\.restart-1\.json/);
  assert.match(report, /未知：二进制哈希不能证明产物由哪个源码工作区构建/);
  assert.match(report, /结果不代表用户已有数据和配置下的性能/);
  assert.match(report, /recorded-revision/);
  assert.match(report, /recorded-hash/);
  assert.match(report, /2026-10-31T08:13:26\.742Z/);
  assert.doesNotMatch(report, /## 基线对比/);
  assert.equal(JSON.stringify(result), original);
});

test("all registered scenario endpoints have Chinese descriptions", () => {
  for (const [scenarioId, scenario] of Object.entries(SCENARIOS)) {
    const report = renderReport(recordedResult(scenarioId));
    assert.match(report, /### 计时边界/);
    assert.match(report, /覆盖状态：已实测（measured）/);
    for (const endpoint of Object.values(scenario.endpoints)) {
      assert.notEqual(reportText(endpoint), endpoint);
      assert.ok(report.includes(reportText(endpoint)));
    }
  }
});

test("unavailable reports keep null metrics visibly missing instead of showing zero", () => {
  const report = renderReport(recordedResult("app.restart", ["unavailable", "skipped"]));
  assert.match(report, /覆盖状态：不可用（unavailable）；成功 0\/2；失败 0；不可用 1；跳过 1/);
  assert.match(report, /总耗时（totalMs） \| 0 \| 无数据 \| 无数据 \| 无数据/);
});

test("comparison explanations are Chinese while machine-readable deltas remain unchanged", () => {
  const result = recordedResult();
  result.mode = "compare";
  result.baseline = compare(result, null);
  let report = renderReport(result);
  assert.match(report, /## 基线对比/);
  assert.match(report, /无法得出结论（inconclusive）/);
  assert.match(report, /缺少基线，或基线数据格式不兼容/);
  result.baseline = compare(result, result);
  report = renderReport(result);
  assert.match(report, /可对比（comparable）/);
  assert.match(report, /未评估性能是否达标：尚未约定阈值/);
  assert.ok(report.includes(JSON.stringify(result.baseline.deltas, null, 2)));
  assert.equal(
    reportText("app.restart: no comparable observed attempts"),
    "app.restart：没有可对比的实测采样",
  );
});

test("the opening summary shows both case results and arithmetic means rather than medians or attempt durations", () => {
  const result = recordedResult("app.restart", ["success", "success", "success"]);
  const chat = recordedResult("chat.new-session", ["success", "success", "success"]);
  result.scenarios.push(...chat.scenarios);
  result.samples.push(...chat.samples);
  for (const scenario of result.scenarios) {
    const attempts = result.samples.filter((sample) => sample.scenarioId === scenario.id);
    for (const [index, sample] of attempts.entries()) {
      sample.metrics.totalMs = [1000, 2000, 9000][index];
      sample.elapsedMs = 99999;
    }
  }
  result.summary = summarize(result.scenarios, result.samples);
  const original = JSON.stringify(result);
  const report = renderReport(result);
  const summary = report.split("## 运行信息")[0];
  assert.match(
    summary,
    /应用完整重启（app.restart） \| 成功（3\/3） \| 正常退出并重启，聊天界面就绪 \| 4\.00/,
  );
  assert.match(
    summary,
    /新建会话并对话（chat.new-session） \| 成功（3\/3） \| 完整回复，未检测到聊天流程错误 \| 4\.00/,
  );
  assert.match(summary, /算术平均值/);
  assert.match(summary, /不代表全量日志无错误/);
  assert.equal(JSON.stringify(result), original);
});

test("partial chat results do not claim every reply was error-free and failures never enter the mean", () => {
  const result = recordedResult("chat.new-session", ["success", "model-error", "timeout"]);
  result.samples[0].metrics.totalMs = 1000;
  result.samples[1].metrics.totalMs = 500000;
  result.samples[2].metrics.totalMs = 900000;
  result.summary = summarize(result.scenarios, result.samples);
  const summary = renderReport(result).split("## 运行信息")[0];
  assert.match(
    summary,
    /chat.new-session） \| 未全部成功（1\/3） \| 部分采样完整回复，另有失败或未完成 \| 1\.00/,
  );
  assert.doesNotMatch(summary, /完整回复，未检测到聊天流程错误/);
});

test("unselected cases are visibly untested and unavailable cases have no average", () => {
  const summary = renderReport(recordedResult("app.restart", ["unavailable", "skipped"])).split(
    "## 运行信息",
  )[0];
  assert.match(summary, /app.restart） \| 未完成（0\/2） \| 失败或未完成，原因见逐次采样 \| —/);
  assert.match(summary, /chat.new-session） \| 未测试 \| — \| —/);
  assert.doesNotMatch(summary, /0\.00/);
});

test("success labels with missing endpoints or failure records do not pass the summary", () => {
  const result = recordedResult("chat.new-session", ["success", "success"]);
  result.samples[0].metrics.sendToFinalRenderedMs = null;
  result.samples[1].failure = { message: "Recorded error" };
  result.summary = summarize(result.scenarios, result.samples);
  const summary = renderReport(result).split("## 运行信息")[0];
  assert.match(
    summary,
    /chat.new-session） \| 未全部成功（0\/2） \| 未确认正常回复，原因见逐次采样 \| —/,
  );
});

test("explicit external-fixture cases remain visible alongside the built-in summary", () => {
  const summary = renderReport(recordedResult("install.clean")).split("## 运行信息")[0];
  assert.match(summary, /install.clean） \| 成功（1\/1）/);
  assert.match(summary, /app.restart） \| 未测试/);
  assert.match(summary, /chat.new-session） \| 未测试/);
});

test("unknown diagnostics and future metric identifiers are preserved", () => {
  assert.equal(reportText("future.metric"), "future.metric");
  assert.equal(reportText("untranslated diagnostic: EIO"), "untranslated diagnostic: EIO");
  assert.equal(reportText("Owned fixture cleanup: EIO"), "隔离测试环境清理：EIO");
});

test("startup reports retain nested phase evidence without summing it into scenario totals", () => {
  const result = recordedResult("app.first-launch");
  result.samples[0].startupTiming = {
    coverage: "partial",
    missing: ["service-ready"],
    phases: [{ phase: "existing-gateway-check", owner: "microclaw", attempt: 1, durationMs: 20 }],
    runtime: [
      {
        scope: "desktop",
        phase: "worker-total",
        kind: "summary",
        status: "failed",
        durationMs: 80,
      },
      {
        scope: "worker",
        phase: "archive-extract",
        kind: "phase",
        status: "failed",
        durationMs: 50,
        elapsedMs: 9999,
      },
    ],
    mxc: [],
    milestones: [{ phase: "renderer-loaded", appElapsedMs: 110 }],
    outcomes: [{ attempt: 1, status: "failed", phase: "gateway-startup", attemptElapsedMs: 90 }],
  };
  const report = renderReport(result);
  assert.match(report, /启动细分覆盖：partial；缺少：service-ready/);
  assert.match(report, /Gateway\/microclaw \| 1 \| existing-gateway-check/);
  assert.match(report, /运行时\/desktop（汇总）/);
  assert.match(report, /archive-extract \| failed \| 50.00/);
  assert.match(report, /renderer-loaded \| 110.00/);
  assert.doesNotMatch(report, /9999.00/);
  assert.equal(result.samples[0].metrics.totalMs, 100.125);
});
