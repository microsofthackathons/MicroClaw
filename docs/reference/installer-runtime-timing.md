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
- 普通桌面启动不启用这些详细日志；只在安装器的专用准备模式传递计时器并记录。
- 修改后的源码需要重新构建桌面包与安装器才会生效。不能用新增日志还原此前未采样安装的耗时分布。
