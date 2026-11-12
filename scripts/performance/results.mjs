import { reportText } from "./report-zh.mjs";

export const SCENARIOS = {
  "install.clean": {
    version: 2,
    requiresExternalFixture: true,
    endpoints: { totalMs: "installation-confirmed -> installation-complete-and-final-validation" },
  },
  "app.first-launch": {
    version: 1,
    endpoints: { totalMs: "electron-launch-call -> observed-chat-ready" },
  },
  "app.restart": {
    version: 2,
    endpoints: {
      totalMs: "normal-exit-request -> observed-chat-ready",
      shutdownMs: "normal-exit-request -> desktop-and-owned-gateway-exited",
      launchToChatReadyMs: "electron-launch-call -> observed-chat-ready",
    },
  },
  "chat.new-session": {
    version: 2,
    endpoints: {
      totalMs: "new-conversation-click -> matching-final-body-after-paint-opportunity",
      sessionReadyMs: "new-conversation-click -> usable-empty-session",
      sendToFirstTextMs: "submit-keydown -> first-visible-answer-after-paint-opportunity",
      sendToFinalRenderedMs: "submit-keydown -> matching-final-body-after-paint-opportunity",
    },
  },
};

export function builtInScenarioIds(registry = SCENARIOS) {
  return Object.keys(registry).filter((id) => !registry[id].requiresExternalFixture);
}

export function aggregate(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median: null, min: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

export function emptyMetrics(scenarioId) {
  return Object.fromEntries(
    Object.keys(SCENARIOS[scenarioId].endpoints).map((metric) => [metric, null]),
  );
}

export function summarize(scenarios, samples) {
  const entries = scenarios.map((scenario) => {
    const attempts = samples.filter((sample) => sample.scenarioId === scenario.id);
    const successes = attempts.filter((sample) => sample.outcome === "success");
    const observed = attempts.filter(
      (sample) => !["unavailable", "skipped"].includes(sample.outcome),
    );
    const complete = successes.filter((sample) =>
      Object.keys(scenario.endpoints).every(
        (metric) => Number.isFinite(sample.metrics[metric]) && sample.metrics[metric] >= 0,
      ),
    );
    const metricNames = new Set(attempts.flatMap((sample) => Object.keys(sample.metrics)));
    return {
      id: scenario.id,
      coverage:
        complete.length === scenario.requestedSamples
          ? "measured"
          : observed.length
            ? "partial"
            : "unavailable",
      requested: scenario.requestedSamples,
      observed: observed.length,
      successful: successes.length,
      failed: observed.length - successes.length,
      unavailable: attempts.filter((sample) => sample.outcome === "unavailable").length,
      skipped: attempts.filter((sample) => sample.outcome === "skipped").length,
      metrics: Object.fromEntries(
        [...metricNames].map((metric) => [
          metric,
          aggregate(successes.map((sample) => sample.metrics[metric])),
        ]),
      ),
      failedElapsedMs: aggregate(
        observed.filter((sample) => sample.outcome !== "success").map((sample) => sample.elapsedMs),
      ),
    };
  });
  return {
    coverage: entries.every((entry) => entry.coverage === "measured")
      ? "measured"
      : entries.every((entry) => entry.coverage === "unavailable")
        ? "unavailable"
        : "partial",
    scenarios: entries,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function compare(candidate, baseline) {
  const issues = [];
  if (
    !baseline ||
    baseline.schemaVersion !== candidate.schemaVersion ||
    !Array.isArray(baseline.scenarios) ||
    !Array.isArray(baseline.summary?.scenarios) ||
    baseline.scenarios.some((entry) => !entry || typeof entry.id !== "string") ||
    baseline.summary.scenarios.some((entry) => !entry || typeof entry.id !== "string") ||
    !baseline.environment
  ) {
    return {
      status: "inconclusive",
      issues: ["Missing or incompatible baseline schema"],
      deltas: [],
    };
  }
  if (
    JSON.stringify(canonical(baseline.environment)) !==
    JSON.stringify(canonical(candidate.environment))
  ) {
    issues.push("Environment/runtime identity differs");
  }
  const deltas = [];
  for (const scenario of candidate.scenarios) {
    const previous = baseline.scenarios?.find((entry) => entry.id === scenario.id);
    const identity = (entry) =>
      entry && {
        version: entry.version,
        endpoints: entry.endpoints,
        profile: entry.profile,
        fixture: entry.fixture,
        cachePolicy: entry.cachePolicy,
        packaging: entry.packaging,
        requestedSamples: entry.requestedSamples,
      };
    if (
      JSON.stringify(canonical(identity(previous))) !==
      JSON.stringify(canonical(identity(scenario)))
    ) {
      issues.push(`${scenario.id}: scenario/profile/fixture/cache/packaging/sample count differs`);
      continue;
    }
    const currentSummary = candidate.summary.scenarios.find((entry) => entry.id === scenario.id);
    const previousSummary = baseline.summary?.scenarios?.find((entry) => entry.id === scenario.id);
    if (
      !Number.isFinite(currentSummary?.observed) ||
      currentSummary.observed <= 0 ||
      !Number.isFinite(previousSummary?.observed) ||
      previousSummary.observed <= 0
    ) {
      issues.push(`${scenario.id}: no comparable observed attempts`);
      continue;
    }
    const metrics = {};
    for (const [metric, current] of Object.entries(currentSummary.metrics)) {
      const old = previousSummary.metrics?.[metric];
      if (
        !current.count ||
        !old?.count ||
        !Number.isFinite(current.median) ||
        !Number.isFinite(old.median)
      )
        continue;
      metrics[metric] = {
        candidateCount: current.count,
        baselineCount: old.count,
        absoluteMs: current.median - old.median,
        relativePercent:
          old.median === 0 ? null : ((current.median - old.median) / old.median) * 100,
      };
    }
    if (!Object.keys(metrics).length)
      issues.push(`${scenario.id}: no corresponding successful metrics`);
    deltas.push({
      scenarioId: scenario.id,
      metrics,
      failureRateDelta:
        currentSummary.failed / currentSummary.observed -
        previousSummary.failed / previousSummary.observed,
    });
  }
  return {
    status: issues.length ? "inconclusive" : "comparable",
    runId: baseline.runId ?? null,
    source: baseline.source ?? null,
    issues,
    deltas,
    verdict: "not-evaluated: no agreed thresholds",
  };
}

const cell = (value) =>
  String(value ?? "未知")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]/g, " ");
const timing = (value) => (value === null || value === undefined ? "无数据" : value.toFixed(2));

function renderSummary(result) {
  const lines = [
    "## 简洁总结",
    "",
    "| 场景 | 最终结果 | 流程检查 | 平均耗时（秒） |",
    "| --- | --- | --- | ---: |",
  ];
  const scenarioIds = new Set([
    ...builtInScenarioIds(),
    ...result.scenarios.map((entry) => entry.id),
  ]);
  for (const scenarioId of scenarioIds) {
    const scenario = result.scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
      lines.push(`| ${cell(reportText(scenarioId))} | 未测试 | — | — |`);
      continue;
    }
    const attempts = result.samples.filter((entry) => entry.scenarioId === scenarioId);
    const successful = attempts.filter(
      (sample) =>
        sample.outcome === "success" &&
        !sample.failure &&
        Object.keys(scenario.endpoints).every(
          (metric) => Number.isFinite(sample.metrics[metric]) && sample.metrics[metric] >= 0,
        ),
    );
    const passed =
      scenario.requestedSamples > 0 &&
      successful.length === scenario.requestedSamples &&
      attempts.length === scenario.requestedSamples;
    const observed = attempts.some(
      (sample) => !["unavailable", "skipped"].includes(sample.outcome),
    );
    const status = passed ? "成功" : observed ? "未全部成功" : "未完成";
    const average = successful.length
      ? (
          successful.reduce((total, sample) => total + sample.metrics.totalMs, 0) /
          successful.length /
          1000
        ).toFixed(2)
      : "—";
    let check = passed ? "流程完成，未记录采样错误" : "失败或未完成，原因见逐次采样";
    if (scenarioId === "app.restart" && passed) check = "正常退出并重启，聊天界面就绪";
    if (scenarioId === "chat.new-session")
      check = passed
        ? "完整回复，未检测到聊天流程错误"
        : successful.length
          ? "部分采样完整回复，另有失败或未完成"
          : "未确认正常回复，原因见逐次采样";
    lines.push(
      `| ${cell(reportText(scenarioId))} | ${status}（${successful.length}/${scenario.requestedSamples}） | ${check} | ${average} |`,
    );
  }
  lines.push(
    "",
    "平均耗时为成功采样总耗时（totalMs）的算术平均值；不计失败采样、测试夹具生成和报告生成。首次启动场景包含运行时准备，重启场景单独列出退出与启动时间。",
    "聊天错误检查仅覆盖被测会话的模型错误、取消、空回复及采样失败，不代表全量日志无错误。",
    "",
  );
  return lines;
}

export function renderReport(result) {
  const lines = [
    "# MicroClaw 性能测试报告",
    "",
    ...renderSummary(result),
    "## 运行信息",
    "",
    `- 运行编号：${cell(result.runId)}`,
    `- 模式：${reportText(result.mode)}；覆盖状态：${reportText(result.summary.coverage)}`,
    `- 源码版本：${cell(result.source.revision)}；存在未提交修改：${result.source.dirty === true ? "是" : result.source.dirty === false ? "否" : "未知"}`,
    `- 源码指纹：${cell(result.source.dirtySourceFingerprint)}`,
    `- 运行环境（原始配置）：${cell(JSON.stringify(result.environment))}`,
    `- 可执行文件 SHA-256：${cell(result.source.artifact?.executableSha256)}`,
    `- 应用归档 SHA-256：${cell(result.source.artifact?.applicationSha256)}`,
    `- OpenClaw 归档 SHA-256：${cell(result.source.artifact?.openclawRuntimeSha256)}`,
    `- 安装程序 SHA-256：${cell(result.source.installer?.sha256)}`,
    `- 产物与源码的关联：${cell(reportText(result.source.artifact?.sourceAssociation))}`,
    `- 开始时间：${result.startedAt}；结束时间：${result.finishedAt}（ISO 8601，Z 表示 UTC）`,
    "",
    "耗时单位均为毫秒（ms）。并行或嵌套阶段不可直接相加。",
    "少量采样不足以确定尾延迟；失败采样的耗时不计入成功采样统计。",
    "",
  ];
  for (const scenario of result.scenarios) {
    const summary = result.summary.scenarios.find((entry) => entry.id === scenario.id);
    lines.push(
      `## ${reportText(scenario.id)}`,
      "",
      `模型模式：${reportText(scenario.profile)}；打包方式：${reportText(scenario.packaging)}；缓存策略：${reportText(scenario.cachePolicy)}。`,
      `覆盖状态：${reportText(summary.coverage)}；成功 ${summary.successful}/${summary.requested}；失败 ${summary.failed}；不可用 ${summary.unavailable}；跳过 ${summary.skipped}。`,
      `测试夹具（原始配置）：${cell(JSON.stringify(scenario.fixture))}`,
      "",
      "| 指标 | 成功样本数 | 中位数 | 最小值 | 最大值 |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const [metric, stats] of Object.entries(summary.metrics)) {
      lines.push(
        `| ${cell(reportText(metric))} | ${stats.count} | ${timing(stats.median)} | ${timing(stats.min)} | ${timing(stats.max)} |`,
      );
    }
    lines.push("", "### 逐次采样", "");
    for (const sample of result.samples.filter((entry) => entry.scenarioId === scenario.id)) {
      lines.push(
        `- ${sample.sampleId}：${reportText(sample.outcome)}；本次采样耗时 ${timing(sample.elapsedMs)} ms；${sample.failure ? `原因（保留原始诊断）：${cell(sample.failure.message)}` : "已完成"}`,
        `  - 原始指标：${cell(JSON.stringify(sample.metrics))}`,
        `  - 证据文件：${sample.evidence.map(cell).join("、") || "无"}`,
      );
      if (sample.cleanupFailure)
        lines.push(`  - 测试进程清理失败：${cell(sample.cleanupFailure)}；后续采样停止。`);
      if (sample.startupTiming) {
        const detail = sample.startupTiming;
        lines.push(
          "",
          `启动细分覆盖：${cell(detail.coverage)}；缺少：${detail.missing.map(cell).join("、") || "无"}。`,
          "",
          "| 分组 | 尝试 | 阶段 | 状态 | 耗时（ms） | 缓存 |",
          "| --- | ---: | --- | --- | ---: | --- |",
        );
        for (const [group, events] of [
          ["Gateway", detail.phases],
          ["运行时", detail.runtime],
          ["MXC", detail.mxc],
        ]) {
          for (const event of events.filter((event) => event.status !== "started"))
            lines.push(
              `| ${group}${event.scope || event.owner ? `/${cell(event.scope ?? event.owner)}` : ""}${event.kind === "summary" ? "（汇总）" : ""} | ${cell(event.attempt ?? "—")} | ${cell(event.phase)} | ${cell(event.status ?? "observed")} | ${timing(event.durationMs)} | ${cell(event.cache ?? "—")} |`,
            );
        }
        lines.push(
          "",
          "主进程里程碑（进程启动后的单调时钟，非阶段耗时）：",
          "",
          "| 里程碑 | 进程内时间（ms） |",
          "| --- | ---: |",
        );
        for (const event of detail.milestones)
          lines.push(`| ${cell(event.phase)} | ${timing(event.appElapsedMs)} |`);
        lines.push(
          "",
          "阶段汇总与子阶段存在包含关系；worker 与主进程使用各自时钟，不跨时钟相减或重复相加。",
          "",
        );
        for (const outcome of detail.outcomes ?? [])
          lines.push(
            `- 启动尝试 ${outcome.attempt}：${cell(outcome.status)}，${cell(outcome.phase)}，${timing(outcome.attemptElapsedMs)} ms。`,
          );
      }
      if (sample.installTiming) {
        lines.push(
          "",
          `安装细分覆盖：${cell(sample.installTiming.coverage)}。`,
          "",
          "| 安装阶段 | 类型 | 尝试 | 状态 | 耗时（ms） | 缓存 |",
          "| --- | --- | ---: | --- | ---: | --- |",
        );
        for (const event of sample.installTiming.events.filter(
          (event) => event.status !== "started",
        )) {
          lines.push(
            `| ${cell(event.scope)}/${cell(event.stageId)}/${cell(event.phase)} | ${cell(event.kind)} | ${cell(event.attempt ?? "—")} | ${cell(event.status)} | ${timing(event.durationMs)} | ${cell(event.cache ?? "—")} |`,
          );
        }
        const total = sample.installTiming.events.findLast(
          (event) => event.phase === "installation-total" && event.kind === "summary",
        );
        if (total)
          lines.push(
            "",
            `安装执行耗时：${timing(total.activeMs)} ms；人工确认等待：${timing(total.humanWaitMs)} ms。`,
          );
        lines.push("", "安装步骤包含内部尝试和重试等待，不能重复相加。", "");
      }
    }
    const stages = Object.entries(summary.metrics)
      .filter(([name, stats]) => name.startsWith("stage.") && stats.count)
      .sort((left, right) => right[1].median - left[1].median);
    if (stages.length)
      lines.push(
        "",
        `最慢阶段（按成功采样中位数排序）：${stages
          .slice(0, 5)
          .map(([name, stats]) => `${reportText(name)} ${timing(stats.median)} ms`)
          .join("；")}。`,
      );
    lines.push(
      "",
      "### 计时边界",
      "",
      ...Object.entries(scenario.endpoints).map(
        ([metric, endpoint]) => `- ${cell(reportText(metric))}：${cell(reportText(endpoint))}`,
      ),
      "",
    );
  }
  lines.push(
    "## 测量限制",
    "",
    ...result.limitations.map((entry) => `- ${cell(reportText(entry))}`),
    "",
  );
  if (result.mode === "compare") {
    lines.push(
      "## 基线对比",
      "",
      `状态：${reportText(result.baseline.status)}。${result.baseline.verdict ? reportText(result.baseline.verdict) : ""}`,
      ...result.baseline.issues.map((entry) => `- ${cell(reportText(entry))}`),
      "",
      "对比原始数据（保留机器字段名）：",
      "",
      "```json",
      JSON.stringify(result.baseline.deltas, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
