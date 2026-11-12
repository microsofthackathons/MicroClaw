# OpenClaw 启动排查与优化（2026-11-11）

## 结论与测量边界

用户当前进程于 2026-11-11 17:17:58（UTC+8）启动，窗口 3.062 秒显示，应用服务在 146.844 秒就绪，首次历史请求在 147.459 秒返回。本轮对照使用同一份 OpenClaw **2026.10.10** 和桌面包内的 Node **26.13.0**，定位并修复了两处 MicroClaw 额外开销：

1. 客户端忽略 OpenClaw 明确返回的启动重试间隔，使用普通断线的指数退避，间隔可升到 15 秒。
2. 权限兼容模块加载钩子反复计算目标路径，并对每个文件调用 Windows 上成本较高的 JavaScript 路径解析实现。

改动保留源码 SHA-256 固定校验、逐次真实路径检查、Gateway PID 所有权、权限证明、鉴权限流和状态迁移。未通过跳过必要初始化或提前宣告服务就绪来缩短指标。

性能对照在独立 HOME、状态目录、随机本地端口运行；有插件的夹具使用测试凭据和本地模型服务桩，模型推理请求数为 **0**。不复制用户历史数据库或账号凭据，不停止正在运行的用户 Gateway。以下隔离结果不能替代用户真实配置重新启动的测量。

测量使用包含独立连接器开发分支的本地构建。连接器实现不随本次启动优化合入 upstream；相关插件与配置差异也是将本记录与公开发行包比较时需要保留的条件。

## 真实启动时间线

来源：`%APPDATA%\microclaw\diagnostics\electron-lifecycle.jsonl`，桌面 PID `27040`，Gateway PID `22452`，generation `3c5cd1fa-4e0a-4331-b0e8-a75874d27828`。主进程计时从 Electron 时间原点开始，不包含该原点之前的 OS 进程创建开销。

| 阶段 | 本段（秒） | 启动后累计（秒） |
| --- | ---: | ---: |
| 桌面初始化至 Gateway 启动请求 | 3.089 | 3.089 |
| Gateway 启动前准备 | 4.423 | 7.512 |
| Gateway 启动至 HTTP 就绪 | **86.319** | 93.831 |
| HTTP 就绪至 WebSocket 连通 | **40.974** | 134.805 |
| WebSocket 连通至应用服务就绪 | 12.039 | 146.844 |
| 首次历史请求返回 | 0.615 | 147.459 |

窗口显示为独立里程碑 `window-shown=3062ms`，不要再加入上述分段总和。运行时缓存命中，准备耗时 0.398 秒。4.423 秒启动前准备中，配置/personas 为 1.448 秒、微信运行时校验 1.662 秒、连接器运行时校验 0.159 秒、spawn preparation 1.008 秒。

后台日志 `%LOCALAPPDATA%\Temp\openclaw\openclaw-2026-11-11.log` 的相关内部阶段：

| OpenClaw 内部阶段 | 日志耗时（秒） | 范围 |
| --- | ---: | --- |
| `process.bootstrap` | 43.801 | HTTP 绑定前 |
| `config.auth` | 14.410 | HTTP 绑定前的配置与鉴权准备 |
| `state.schema-preflight` | 0.519 | 状态 schema 检查 |
| `sessions.admission` | 2.200 | 会话准入 |
| `plugins.runtime-post-bind` | 19.804 | HTTP 绑定后的插件初始化 |
| `sidecars.main-session-recovery` | 21.856 | 主会话恢复，与上项大量重叠 |
| `sidecars.worker-environments` | 1.413 | Worker 环境准备 |
| `sidecars.model-runtime` | 2.858 | 后台模型运行准备，存在并行工作 |

这些是同一启动中的嵌套/并行阶段，不可直接相加，也不能再次加入桌面时间线。HTTP 可响应时，OpenClaw 上层服务仍可能未就绪。

## 114 秒 Agent 准备的准确含义

后台在 17:20:21 记录 `agent database recovered after background inspection and preparation`，总计 **114.034 秒**。源码核对 `dist/agent-database-startup-AXJFrv8D.mjs` 后，主要字段的含义如下：

| 字段 | 耗时（秒） | 源码中的实际含义 |
| --- | ---: | --- |
| `inspection` | 1.403 | 等待已安排的检查结果 |
| `activation` | **66.078** | `await this.activation.promise`，等待 Gateway 激活许可 |
| `readiness` | **22.017** | 等待 `activation.preparationReady` 及准入前置条件 |
| `open` | 1.234 | 打开 Agent 数据库 |
| `migration` | **3.871** | 执行 Agent 迁移阶段 |
| `secrets` | 0.261 | 准备凭据相关状态 |
| `models` | **19.163** | 模型相关准备 |
| 其他队列/发布 | 约 0.006 | 对应其余字段及舍入差额 |

因此，`activation=66.078 秒` 不能解释成“数据库自身计算了 66 秒”。它包含对其他启动工作的等待；改善这项应从被等待的工作入手。此流程跨越 HTTP 就绪前后，与主时间线重叠。

真实日志还记录了 15.165、9.999、8.229 秒等主线程停顿，采样栈涉及文件边界检查、模型/provider 信息加载。`llama-cpp` 的 OpenClaw peer 指向全局 npm 目录，微信插件存在注册来源记录缺失警告；这些问题的独立耗时尚未量化，本轮没有在线修改用户插件或运行官方 Doctor。

## 同版本裸启动与 MicroClaw 路径的对照

最小配置使用同一 Node、同一 OpenClaw 入口和独立状态。裸启动去掉 MicroClaw 预加载；managed 路径保留当前模块归档、状态所有权、fs-safe、本地模型及权限兼容预加载，保留 stdin lifeline。

| 场景 | HTTP（秒） | WebSocket（秒） | 首次历史返回（秒） |
| --- | ---: | ---: | ---: |
| managed，编译缓存禁用，新测试状态 | 38.820 | 56.070 | 63.527 |
| 同一 OpenClaw 裸启动，新测试状态 | 56.334 | 66.589 | 78.891 |
| managed，使用 OpenClaw 缓存策略，新测试状态 | 27.794 | 36.023 | 44.690 |
| managed，编译缓存禁用，同测试状态重启 | 21.619 | 30.756 | 30.955 |
| 同一 OpenClaw 裸启动，同测试状态重启 | 21.123 | 31.403 | 31.639 |
| managed，使用 OpenClaw 缓存策略，同测试状态重启 | 21.510 | 30.669 | 30.842 |

新状态测量是顺序执行的单次样本，存在 OS 文件缓存、基础设施预热和首次状态准备的影响，不能将三项首次结果直接解释为某个开关的稳定收益。重启结果相近，说明“所有启动耗时都由 MicroClaw 封装引入”缺少本轮证据。

缓存设置暂不修改。历史 PR #358 关闭 managed Gateway 编译缓存是为了避免 OpenClaw respawn 后改变监听 PID，破坏 Windows Node 的所有权检查；本轮缓存实验也没有证明值得承担该行为变化。

## 两处修复

### 按启动协议重试 WebSocket

OpenClaw `startup-unavailable-D0-EeFjq.mjs` / `message-handler-DSPg7e4A.mjs` 的启动拒绝帧为：

```json
{
  "code": "UNAVAILABLE",
  "retryable": true,
  "retryAfterMs": 500,
  "details": { "reason": "startup-sidecars" }
}
```

旧客户端只对鉴权限流处理 `retryAfterMs`，启动拒绝仍使用 800 毫秒起、1.7 倍增长、最多 15 秒的断线退避。服务完成初始化后，下一次连接仍可能要等较长时间。

[gateway-client.ts](../../desktop/src/gateway-client.ts) 现在保留 `retryable` 字段，仅对以上结构化启动错误应用 100–2000 毫秒的协议间隔，缺省为 500 毫秒。普通断线继续指数退避；鉴权限流和 token 错误保留原处理。若 close 帧先于 Promise 拒绝回调到达，也会更新已经安排的重试定时器；停止客户端会取消该定时器。

新增 `gateway-ws-startup-retry` 生命周期日志记录等待值，不包含 token 或凭据。后续真实启动可据此区分服务未就绪和客户端退避。

最终插件样本中，第一次启动拒绝回执在 HTTP 就绪约 8 秒后才到达；后续部分回执间隔也明显超过客户端的 500 毫秒等待值。这说明该区间还包含服务端初始化/事件循环阻塞，不能把 HTTP 到 WebSocket 的全部时间视为客户端定时器成本。

### 减少权限兼容加载钩子的路径开销

一次隔离诊断记录 `fs.realpathSync` **48,910 次、累计约 4.115 秒**；V8 采样中权限兼容 `load` 栈约 4.051 秒，包含嵌套加载，不能与前者相加。诊断本身有开销，不用该轮绝对耗时计算最终提速。

[openclaw-approval-replay-compat.mjs](../../desktop/src/openclaw-approval-replay-compat.mjs) 在 Windows 使用 `realpathSync.native`，并将已验证目标的索引预先建立为 Map。逐次真实路径解析继续执行，不缓存文件身份，不跳过别名或重定向检查。该 API 是 Node 的原生同步真实路径解析接口，见 [Node 文件系统文档](https://nodejs.org/api/fs.html#fsrealpathsyncnativepath-options)。

同机 1,000 个运行时模块路径的独立检查：JavaScript 实现约 296 毫秒，原生实现两次约 102、90 毫秒；返回路径一致。测试覆盖普通文件、目录别名、验证后重定向，以及真实官方包全部固定源码 hash/补丁点。

## 有插件的隔离配置复测

在同一独立状态目录保留微信、本地模型插件、GitHub Copilot 插件配置和内置连接器；模型服务使用本地桩。只复用公开插件程序文件，不复用真实账号和历史数据库。先完成一次初始化，再执行旧实现、新实现和回切旧实现的重启对照。

| 轮次 | HTTP（秒） | WebSocket（秒） | 首次历史返回（秒） |
| --- | ---: | ---: | ---: |
| 旧实现，新测试状态首次初始化，仅作条件记录 | 37.890 | 60.485 | 67.545 |
| 旧实现，同状态重启 | 21.508 | 41.076 | 41.318 |
| 优化候选，同状态重启 1 | 19.811 | 35.694 | 36.201 |
| 优化候选，同状态重启 2 | 19.617 | 35.902 | 36.078 |
| 回切旧实现，同状态重启 | 21.657 | 41.998 | 42.219 |
| 最终版本，同状态重启 1 | 20.593 | 37.061 | 37.325 |
| 最终版本，同状态重启 2 | 20.393 | 36.754 | 37.130 |

最终版本补齐了 close 帧与 Promise 回调的定时器竞态处理。采用该版本两次复测，首次历史返回平均由旧实现的 **41.769 秒降到 37.228 秒**，约减少 **4.541 秒（10.87%）**。此前候选结果约 36.140 秒，作为过程数据保留，不代替最终版本的测量。样本量较小，仅用于确认本机同配置下的收益方向与数量级。

有效插件样本均核对监听 PID 等于启动的子进程 PID，首次历史请求成功，退出码为 0，模型推理请求数为 0。该指标不包含真实桌面窗口和 Windows Node 服务交接，不能宣称用户的 147 秒已经降成 36 秒。

## 验证与原始记录

- Gateway 客户端、真实 WebSocket 传输、权限兼容固定源码、启动顺序和计时相关测试：**189 项通过**，包括启用真实官方 OpenClaw 包后的固定源码验证。
- 权限证明测试原有的非 ASCII 示例发生了乱码；按现有 C# 固定向量改为 Unicode 转义。预期 hash、签名和生产协议未改变。
- TypeScript 全项目 `tsc --noEmit` 通过；修改文件的格式与 diff 检查通过。ESLint 没有错误，客户端测试中原有的 3 个 `no-explicit-any` 警告保留。
- 未重打包或替换用户正在运行的桌面应用；真实配置端到端收益仍需新包启动日志验证。

本机诊断文件位于 `build/startup-analysis-20261111/`：

- `results.json`、`repeat-results.json`：最小配置裸启动、缓存策略和重启对照。
- `diagnostic-results.json`：带文件操作/进程调用与 CPU 采样的诊断轮。
- `optimized-results.json`：最小配置优化样本。
- `feature-baseline-results.json`、`feature-optimized-results.json`、`feature-baseline-check.json`：有插件夹具的前后对照。
- `feature-final-results.json`：包含最终重试定时器竞态处理后的复测。
- `probe.cjs`、`diagnostic.mjs`：本次本机诊断脚本；每轮结果记录独立夹具路径，其中保留完整 stdout/stderr 和 Gateway 日志。
- `final-tests.log`、`typecheck.log`：验证输出。
