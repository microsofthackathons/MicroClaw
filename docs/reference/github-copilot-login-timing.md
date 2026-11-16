# GitHub Copilot 登录分阶段计时

桌面主进程将 `github-copilot-login-timing` 事件写入用户数据目录下的 `diagnostics/electron-lifecycle.jsonl`（Windows 默认是 `%APPDATA%/microclaw/diagnostics/electron-lifecycle.jsonl`）。使用 `sessionId` 关联一次登录，`workerPid` 可以与 OpenClaw 日志中的进程 ID 对照。

| 阶段 | 记录的范围 |
| --- | --- |
| `worker-startup` | 主进程收到登录请求至独立登录进程开始执行 |
| `sdk-import` | 并行导入认证、提供商目录和配置 SDK |
| `config-read` | 读取配置并准备内存中的 Copilot 配置 |
| `provider-prepare` | 加载并确认 Copilot 提供商 |
| `auth-flow` | 调用 SDK 登录流程至返回，包含下面的请求、授权和保存阶段 |
| `device-code-http` | GitHub 设备码 HTTP 请求创建至响应体接收结束；附请求序号和 HTTP 状态码 |
| `device-code-ready` | SDK 将设备码交给登录进程 |
| `device-code-delivered` | 主进程将设备码事件发送给界面；不代表界面完成绘制 |
| `authorization-and-model-check` | 设备码就绪至 SDK 开始持久化；包含用户授权、轮询和提供商模型检查 |
| `credential-save-and-refresh` | SDK 的 `beforePersistentEffect` 回调至登录流程返回；包含凭据保存和认证刷新 |
| `login-total` | 后端登录请求至成功、失败或取消；不含页面先前的状态检查和登录后的模型列表加载 |
| `worker-exit` | 登录进程退出，便于确认取消清理是否结束 |

`status` 为 `started`、`success`、`error` 或 `cancelled`。`durationMs` 是阶段耗时，`elapsedMs` 是事件在所属进程中的相对时间，`totalElapsedMs` 是主进程从登录请求开始计算的累计时间。计时使用单调时钟。嵌套阶段与总耗时不可相加；用户授权时间也不应算作程序启动耗时。

设备码 HTTP 计时通过 Node 的 Undici 诊断通道观测，不替换请求实现、不读取请求体或响应体。DNS 和 SDK 的请求前检查可能发生在该 HTTP 阶段之前。SDK 未发出相应事件时，日志不会伪造阶段边界。

日志仅接受固定阶段名称、状态和数值，丢弃额外字段。不记录一次性授权码、设备码、令牌、请求头、响应内容或凭据配置。诊断失败不会阻断登录。未完成的阶段在失败或取消时记录相应状态，主进程也记录总超时和取消请求。

快速定位：若 `worker-startup` 慢，检查进程启动；若 `sdk-import` 或 `provider-prepare` 慢，检查本地加载；若 `device-code-http` 慢，检查 GitHub 请求。若 `auth-flow` 开始后很久都没有 HTTP 开始事件，则还需检查 SDK 的请求前准备。`device-code-delivered.totalElapsedMs` 可用于比较后端收到请求到出码的耗时。

修改后需重新构建并运行更新后的桌面程序和独立认证 worker；旧安装包不会自动获得这些计时事件。
