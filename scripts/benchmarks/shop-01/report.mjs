function percent(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function fraction(value) {
  return `${value.numerator}/${value.denominator} (${percent(value.value)})`;
}

function text(value) {
  return String(value ?? "N/A")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]/g, " ");
}

function timing(value) {
  return value.count === 0
    ? "N/A"
    : `n=${value.count}; median=${value.median} ms; P90=${value.p90} ms`;
}

export function renderReport(result) {
  const summary = result.summary;
  return [
    "# SHOP-01 规则评测报告",
    "",
    `对象：${text(result.subject.label)}。层级：Replay。协议：${result.suiteVersion}。`,
    "",
    ...result.warnings.map((warning) => `> ${text(warning)}`),
    "",
    "## 执行覆盖",
    "",
    `计划 ${summary.planned}；已记录 ${summary.recorded}；有效 ${summary.valid}；INVALID ${summary.invalid}；NOT_RUN ${summary.notRun}。`,
    "",
    "INVALID 不进入成功率分母，但保留原因；超时和产品错误进入分母。未运行不能当作成功。",
    "",
    "## 核心指标",
    "",
    "| 指标 | 结果 |",
    "| --- | --- |",
    `| 可购买决策完成率 | ${fraction(summary.businessCompletion)} |`,
    `| 用例通过率 | ${fraction(summary.casePass)} |`,
    `| 可解题购买完成率 | ${fraction(summary.solvableBusinessCompletion)} |`,
    `| 预期不可完整报价题的正确处理率 | ${fraction(summary.expectedIncompletePass)} |`,
    `| 用例等权购买完成率 | ${percent(summary.macroBusinessCompletion)} |`,
    `| 用例等权通过率 | ${percent(summary.macroCasePass)} |`,
    `| business pass^3 | ${percent(summary.businessPass3)} |`,
    `| case pass^3 | ${percent(summary.casePass3)} |`,
    `| 硬失败率 | ${fraction(summary.hardFailureRate)} |`,
    `| 安全审计覆盖率（未核验不等于安全） | ${fraction(summary.safetyAuditCoverage)} |`,
    `| 诚实未完成 | ${summary.honestIncomplete} |`,
    `| 超时 / 产品错误 | ${summary.timeouts} / ${summary.errors} |`,
    "",
    "## 诊断与代价",
    "",
    "| 指标 | 结果 |",
    "| --- | --- |",
    `| 已确认断言的证据核验准确率 | ${fraction(summary.assertionAccuracy)} |`,
    `| 固定必填槽位的核验覆盖率 | ${fraction(summary.requiredFieldCoverage)} |`,
    `| 候选资格正确率 | ${fraction(summary.candidateEligibility)} |`,
    `| 有可核验价格样本中的最低价命中率 | ${fraction(summary.minimumHit)} |`,
    `| 价格差距（条件样本） | n=${summary.priceGap.count}; median=${percent(summary.priceGap.median)}; P90=${percent(summary.priceGap.p90)} |`,
    `| 完整成功耗时 | ${timing(summary.successLatencyMs)} |`,
    `| 未完整成功耗时 | ${timing(summary.failedElapsedMs)} |`,
    `| 人工等待（已包含在总耗时） | ${timing(summary.humanWaitMs)} |`,
    `| 额外用户轮次 | n=${summary.extraUserTurns.count}; median=${text(summary.extraUserTurns.median)}; P90=${text(summary.extraUserTurns.p90)} |`,
    `| 所有已记录运行总成本 USD | ${text(summary.totalCostUsd)} |`,
    `| 每次购买完成成本 USD（含失败消耗） | ${text(summary.costPerBusinessSuccessUsd)} |`,
    "",
    "准确率不能替代覆盖率；价格指标仅对可核验候选集合成立。未知不是零，N/A 不是成功。",
    "",
    "## 按用例",
    "",
    "| 用例 | 预期终态 | 记录/计划 | 购买完成 | 用例通过 | case pass^3 | INVALID / NOT_RUN |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...result.cases.map(
      (entry) =>
        `| ${entry.caseId} | ${entry.expectedOutcome} | ${entry.recorded}/${entry.planned} | ${fraction(entry.businessCompletion)} | ${fraction(entry.casePass)} | ${percent(entry.casePass3)} | ${entry.invalid} / ${entry.notRun} |`,
    ),
    "",
    "pass^3 = C(成功次数, 3) / C(有效次数, 3)，按用例计算再等权；计划缺样、INVALID 或少于三次时不计算。它不是三次里至少一次成功的 pass@3。",
    "",
    "## 逐次结果",
    "",
    "| Run | 结果 | 用例通过 | 已核验商家 | 未通过门槛/审计 | 硬失败 / INVALID 原因 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.runs.map(
      (run) =>
        `| ${text(run.runId)} | ${run.outcome} | ${run.casePassed} | ${run.independentVerifiedMerchants} | ${text(
          (run.casePassed
            ? []
            : [
                ...Object.entries(run.gates)
                  .filter(([, value]) => !value)
                  .map(([gate]) => gate),
                ...Object.entries(run.checks)
                  .filter(([, value]) => value !== "pass")
                  .map(([check, value]) => `${check}:${value}`),
              ]
          ).join(", "),
        )} | ${text([...run.hardFailures, ...(run.invalidReason ? [run.invalidReason] : [])].join(", "))} |`,
    ),
    "",
    "## 来源与边界",
    "",
    `- 构建：${text(result.subject.buildId)}；实际模型 ID：${text(result.subject.modelId)}；工具配置：${text(result.subject.toolProfile)}；profile：${text(result.subject.profileState)}。`,
    `- 输入 SHA-256：${text(result.provenance?.captureSha256)}。`,
    `- Fixture SHA-256：${text(result.provenance?.fixtureSha256)}；评分代码 SHA-256：${text(result.provenance?.scorerSha256)}。`,
    "- 评分器不读取自然语言答案、不访问真实商店、不验证手机送达；语义/交易副作用依赖独立审计记录，而非 agent 自评。",
    "- Replay 时钟与页面冻结；示例价格全部虚构。Live 和 Phone E2E 均为 NOT_RUN。",
    "",
  ].join("\n");
}
