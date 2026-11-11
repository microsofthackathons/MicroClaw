# 安装器内置运行时分段计时

安装器在“Preparing the bundled OpenClaw runtime before service startup”阶段记录
`MICROCLAW_RUNTIME_TIMING ` 前缀的 JSON 日志，用于区分启动准备、缓存检查、文件展开和旧目录清理。
此功能只增加观测，不改变缓存标识、提取范围、发布重试或校验条件。

## 字段

- `scope`：`installer` 为 Python 安装器，`desktop` 为桌面准备进程，`worker` 为展开线程。
- `phase`：阶段名称，见下表。
- `status`：`started`、`success`、`failed`；安装器等待子进程超时另记为 `timeout`。
- `durationMs`：已完成或已失败阶段的耗时，单位毫秒，使用单调时钟。开始记录不含此字段。
- `elapsedMs`：本作用域时钟的累计位置，用于辅助排列记录；不要跨作用域直接相减。
- `kind`：普通阶段为 `phase`，包含子阶段的总等待为 `summary`。
- `cache`：缓存检查结束时明确记录 `hit` 或 `miss`。
- `attempt`、`errorCode`：发布重试的次数和文件系统错误码；失败阶段可带错误码。

## 阶段

| scope | phase | 含义 |
| --- | --- | --- |
| installer | preparation-total | 整个运行时准备调用，含环境准备、子进程及结果校验；汇总项 |
| installer | environment-preparation | 准备子进程环境变量、移除 ELECTRON_RUN_AS_NODE |
| installer | helper-process | 从启动桌面准备进程至退出/失败/超时；汇总项 |
| desktop | desktop-startup | 从 Node/Electron 进程时钟起点到进入准备模式，含模块加载及 Electron ready |
| desktop | preparation-total | 准备模式内部工作；汇总项，不含前面的 desktop-startup |
| desktop | archive-metadata | 读取包元数据、生成原有缓存版本标识 |
| desktop / worker | cache-check | 检查入口和缓存版本标记，附缓存命中结果 |
| desktop | worker-startup | 创建 Worker 到 Worker 完成模块加载、进入准备代码 |
| desktop | worker-total | Worker 启动、工作和结果校验的完整等待；汇总项 |
| worker | staging-cleanup | 删除本次暂存目录 |
| worker | staging-parent-create | 创建运行时父目录 |
| worker | archive-extract | 将 ASAR 全量展开到暂存目录 |
| worker | entry-validation | 检查展开后的运行时入口 |
| worker | version-marker-write | 写入缓存版本标记 |
| worker | old-runtime-remove | 递归删除旧运行时目录 |
| worker | runtime-publish | 发布暂存目录，包含已有重试等待 |
| worker | publish-retry-wait | 单次发布重试等待，是 runtime-publish 的内部明细，不应重复相加 |
| worker | failed-staging-cleanup | 失败时清理暂存目录 |
| desktop | worker-result-validation | Worker 退出后的入口和版本标记检查 |
| installer | result-validation | 校验回执、预期路径、入口、版本标记及包信息 |

## 读取方式与边界

- 每个阶段先记录开始，再记录结束或失败；缓存命中时不会出现不曾执行的展开、删旧或发布阶段。
- 子进程仍按原方式捕获输出。安装器在子进程结束后将上述计时记录写入安装日志；不是实时流式显示。
- 非零退出也转存记录；超时时尽量转存 `TimeoutExpired` 中已有的 stdout/stderr，包括字节形式的部分输出。
  进程被强制终止且没有机会输出的记录无法补回。
- 不要把不同作用域的同一工作、`summary` 汇总项和内部子阶段重复相加。
- 普通桌面启动同样传递计时器，通过 `startup-runtime-phase` 写入 Electron 生命周期日志；
  安装器专用准备模式继续输出带前缀的 JSON。worker 明细由父进程转发，保留原始作用域。
- 修改后的源码需要重新构建桌面包与安装器才会生效。不能用新增日志还原此前未采样安装的耗时分布。

## 安装全过程

Web 安装器另外输出 `MICROCLAW_INSTALL_TIMING ` JSON（`schemaVersion: 2`）：

- `runId`、`sampleId`：适配器通过 `MICROCLAW_PERF_RUN_ID`、`MICROCLAW_PERF_SAMPLE_ID`
  环境变量传入；手动安装自动生成 runId，sampleId 为 null。
- `stageId`：不依赖界面语言的阶段编号，例如 `desktop-60`、`prepareUpgrade-18` 和
  `prepareUpgrade-52`。重复文案仍可区分，运行时子进程记录继承相同安装身份。
- `kind: step` 记录整个步骤；`phase: attempt`、`retry-wait`、`human-wait`
  分别记录单次尝试、退避等待和关闭现有应用前的人工确认等待。
- `installation-total` 汇总包含 `durationMs`（总经过时间）、`humanWaitMs` 和
  `activeMs`（扣除已观测人工确认等待）。系统 UAC 和外部安装器内部等待未单独拆分。
- 失败、取消和意外异常保留已完成阶段；日志写入失败不会改变安装结果。

安装结束边界是安装完成与最终校验，不包含启动桌面应用或服务就绪。原有安装成功后不自动
启动应用的行为保持不变。下载和桌面 ZIP 展开仍包含在各自安装步骤内，未提供逐下载子阶段。
步骤、内部尝试、运行时汇总与子阶段不能重复相加。VM 适配器计时覆盖确认安装到最终完成；
本地结构化日志从安装线程进入开始，两者之间的调度开销不应被误当成某个安装步骤。
