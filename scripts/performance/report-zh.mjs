const TEXT = {
  unknown: "未知",
  report: "性能报告（report）",
  compare: "基线对比（compare）",
  measured: "已实测（measured）",
  partial: "部分实测（partial）",
  unavailable: "不可用（unavailable）",
  success: "成功（success）",
  failed: "失败（failed）",
  timeout: "超时（timeout）",
  skipped: "已跳过（skipped）",
  cancelled: "已取消（cancelled）",
  "incomplete-restart": "重启不完整（incomplete-restart）",
  "unexpected-response": "响应不符合预期（unexpected-response）",
  "model-error": "模型错误（model-error）",
  "empty-response": "空回复（empty-response）",
  "session-not-new": "未创建新会话（session-not-new）",
  "session-not-empty": "新会话非空（session-not-empty）",
  "missing-run-ack": "缺少请求运行标识（missing-run-ack）",
  "submission-error": "消息提交错误（submission-error）",
  "chat-error": "会话出现错误（chat-error）",
  "preparation-failed": "会话预热失败（preparation-failed）",
  "shutdown-not-observed": "缺少正常退出凭据（shutdown-not-observed）",
  "event-buffer-overflow": "请求事件缓存超限（event-buffer-overflow）",
  "fixed-response": "固定响应（fixed-response）",
  "real-model": "真实模型（real-model）",
  installer: "安装程序（installer）",
  packaged: "打包版本（packaged）",
  installed: "已安装版本（installed）",
  "restore-vm-before-each-sample": "每次采样前还原虚拟机",
  "retained-disk-caches-after-unmeasured-initial-launch": "首次启动不计入采样，后续保留磁盘缓存",
  "install.clean": "全新安装（install.clean）",
  "app.restart": "应用完整重启（app.restart）",
  "chat.new-session": "新建会话并对话（chat.new-session）",
  totalMs: "总耗时（totalMs）",
  shutdownMs: "退出耗时（shutdownMs）",
  launchToChatReadyMs: "启动至聊天就绪（launchToChatReadyMs）",
  sessionReadyMs: "新会话就绪（sessionReadyMs）",
  sendToFirstTextMs: "发送至首段文字可见（sendToFirstTextMs）",
  sendToFinalRenderedMs: "发送至完整回答渲染（sendToFinalRenderedMs）",
  "stage.appBeforeAttemptMs": "启动至 Gateway 启动尝试前（stage.appBeforeAttemptMs）",
  "stage.microclawPreflightMs": "MicroClaw 启动预检（stage.microclawPreflightMs）",
  "stage.openclawHttpMs": "OpenClaw HTTP 就绪（stage.openclawHttpMs）",
  "stage.integrationMs": "集成初始化（stage.integrationMs）",
  "installation-confirmed -> service-ready-and-final-validation":
    "确认安装 → 服务就绪且最终校验完成",
  "normal-exit-request -> observed-chat-ready": "请求正常退出 → 重启后观测到聊天就绪",
  "normal-exit-request -> desktop-and-owned-gateway-exited":
    "请求正常退出 → 桌面进程及其管理的 Gateway 均退出",
  "electron-launch-call -> observed-chat-ready": "调用 Electron 启动 → 观测到聊天就绪",
  "new-conversation-click -> matching-final-body-after-paint-opportunity":
    "点击新建会话 → 浏览器获得绘制机会后，完整回答可见且内容匹配",
  "new-conversation-click -> usable-empty-session": "点击新建会话 → 空会话可用",
  "submit-keydown -> first-visible-answer-after-paint-opportunity":
    "按键提交消息 → 浏览器获得绘制机会后，首段回答可见",
  "submit-keydown -> matching-final-body-after-paint-opportunity":
    "按键提交消息 → 浏览器获得绘制机会后，完整回答可见且内容匹配",
  "unknown: binary hashes do not establish which checkout built them":
    "未知：二进制哈希不能证明产物由哪个源码工作区构建",
  "Binary/source association is unknown unless separately established by a trusted build pipeline. Current source fingerprints are not attributed to an existing binary.":
    "除非可信构建流水线另行确认，否则二进制产物与源码的关联未知；不能将当前源码指纹直接归属于已有二进制产物。",
  "UI timings observe DOM visibility after paint opportunities, not a physical screen presentation timestamp. Automation/observer scheduling adds measurement overhead.":
    "界面计时依据浏览器获得绘制机会后的 DOM 可见性，并非物理屏幕实际呈现时间；自动化和观测器调度会引入测量开销。",
  "Initial fixture startup and report generation are outside scenario timing. Normal startup may call the model for warmup/title work; all proxy requests count toward the request budget.":
    "测试环境首次启动和报告生成不计入场景耗时。正常启动可能为预热或生成标题调用模型；所有代理请求均计入请求预算。",
  "Initial fixture startup, optional UI chat preparation and report generation are outside scenario timing. Startup/preparation may call the model for warmup/title work; all proxy requests count toward the request budget.":
    "测试环境首次启动、按需进行的界面会话预热和报告生成不计入场景耗时；预热和标题等模型调用仍计入统一请求预算，预热凭据单独保留。",
  "GPU identity, provider output token counts and internal model-runtime stages are unavailable. Real-model networking and inference are uncontrolled sources of variation.":
    "未采集 GPU 标识、模型服务输出 token 数和模型运行时内部阶段；真实模型的网络与推理耗时是未受控的波动来源。",
  "Synthetic fixture has no personal sessions, plugins or bundled skills enabled; it is not a measurement of a user's populated profile.":
    "隔离测试环境未启用个人会话、插件或内置技能；结果不代表用户已有数据和配置下的性能。",
  comparable: "可对比（comparable）",
  inconclusive: "无法得出结论（inconclusive）",
  "not-evaluated: no agreed thresholds": "未评估性能是否达标：尚未约定阈值",
  "Missing or incompatible baseline schema": "缺少基线，或基线数据格式不兼容",
  "Environment/runtime identity differs": "环境或运行时标识不一致",
  "scenario/profile/fixture/cache/packaging/sample count differs":
    "场景、模型模式、测试夹具、缓存、打包方式或采样数量不一致",
  "no comparable observed attempts": "没有可对比的实测采样",
  "no corresponding successful metrics": "没有对应的成功采样指标",
};

export function reportText(value) {
  const text = String(value ?? "unknown");
  if (Object.hasOwn(TEXT, text)) return TEXT[text];
  const separator = text.indexOf(": ");
  const detail = text.slice(separator + 2);
  if (separator >= 0 && Object.hasOwn(TEXT, detail))
    return `${text.slice(0, separator)}：${TEXT[detail]}`;
  if (text.startsWith("Owned fixture cleanup: "))
    return `隔离测试环境清理：${text.slice("Owned fixture cleanup: ".length)}`;
  return text;
}
