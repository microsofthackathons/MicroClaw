# 沙箱与权限管理 — 高优先级功能清单

> 日期：2026-04-22  
> 基于：[AppContainer 对比分析](2026-04-22-appcontainer-comparison-microclaw-vs-mxc.md) 及代码审查  
> 状态：待评审

---

## 概述

基于 MicroClaw1P 与 MXC 的对比分析和代码审查，以下是按优先级排列的待实现功能。每项包含背景、实现方案、涉及文件和预估工作量。

---

## P0 — 必须尽快实现

### 1. LPAC（Least Privilege AppContainer）支持

**背景**：当前 AppContainer 使用标准权限基线，进程可访问标记为 `ALL APPLICATION PACKAGES` 的所有资源。启用 LPAC 后，进程被限制在更小的权限范围内，只有显式授予的能力和路径才可访问。MXC 已实现此功能。

**当前状态**：`ContainerManager.cs` 中创建进程时未设置 `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` 属性。

**实现方案**：
1. 在 `ContainerManager.Run()` 中的 `UpdateProcThreadAttribute` 调用链中增加 `ALL_APPLICATION_PACKAGES_POLICY` 属性
2. 添加配置开关 `sandboxLeastPrivilege: boolean`（默认 `true`）
3. 确保启用 LPAC 后，已授权的 RW/RO 路径依然可访问（ACL grant 已用容器 SID，不受影响）

**涉及文件**：
- `appcontainer/ContainerManager.cs` — 增加 LPAC 属性
- `appcontainer/NativeMethods.cs` — 增加 `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` 常量
- `desktop/src/tool-sandbox.ts` — 传递 LPAC 配置

**工作量**：~30 行 C# 代码，风险低

---

### 2. 精确网络访问控制

**背景**：当前网络控制仅有"有网/无网"二值开关（`internetClient` capability）。Agent 场景下需要更精确的控制——例如只允许访问特定 API endpoint，阻止访问其他所有地址。MXC 通过 Windows Firewall API 实现了 per-host 规则。

**当前状态**：`sandboxCapabilities` 中可配置 `internetClient`，但无法控制目标地址。

**实现方案**：
1. 新增 `NetworkFirewallManager` 模块，使用 `INetFwPolicy2` COM 接口操作 Windows 防火墙
2. 支持两种策略模式：
   - **默认放行 + 黑名单**：`defaultPolicy: "allow"` + `blockedHosts: ["malware.example.com"]`
   - **默认阻断 + 白名单**：`defaultPolicy: "block"` + `allowedHosts: ["api.github.com", "140.82.121.0/24"]`
3. 规则以 `MicroClaw_{containerName}_{timestamp}` 命名，进程退出时清理
4. 支持 hostname → IP 解析、CIDR 表示法
5. 添加 Settings UI 页面，允许用户配置网络策略

**涉及文件**：
- `desktop/src/network-firewall.ts`（新建）— 防火墙规则管理
- `desktop/src/tool-sandbox.ts` — 集成防火墙 setup/teardown
- `desktop/src/main.ts` — IPC 注册
- `desktop/renderer/src/views/SettingsView.vue` — 网络策略 UI

**工作量**：中等，需要较多测试确保规则正确清理

---

### 3. 进程超时强制终止

**背景**：当前 `AppContainerLauncher.exe` 启动子进程后没有独立的超时终止逻辑，完全依赖 Gateway 侧管理。如果 Gateway 自身卡死或超时机制失效，沙箱进程可能无限运行。MXC 使用 `WaitForSingleObject` + `TerminateProcess` 实现了可靠的进程超时。

**当前状态**：`Program.cs` 中 `CmdRun()` 无 `WaitForSingleObject` 超时逻辑。

**实现方案**：
1. 添加 `--timeout <ms>` 参数到 Launcher CLI
2. 在 `ContainerManager.Run()` 中用 `WaitForSingleObject(hProcess, timeoutMs)` 替代无限等待
3. 超时后调用 `TerminateProcess(hProcess, EXIT_CODE_TIMEOUT)` + 二次等待确认终止
4. 通过环境变量 `OPENCLAW_SANDBOX_TIMEOUT` 传递（Gateway → Launcher）
5. 默认超时 300 秒（5 分钟），可配置

**涉及文件**：
- `appcontainer/Program.cs` — 解析 `--timeout` 参数
- `appcontainer/ContainerManager.cs` — `WaitForSingleObject` + `TerminateProcess`
- `desktop/src/constants.ts` — 添加 `SANDBOX_PROCESS_TIMEOUT_MS`
- `desktop/src/tool-sandbox.ts` — 传递超时环境变量

**工作量**：~50 行 C#，风险低

---

## P1 — 高优先级

### 4. ACL 操作事务化

**背景**：当前 `provision()` 遍历目录列表逐个 grant，如果第 3 个目录 grant 失败，前 2 个已授予的 ACL 不会回滚，导致权限状态不一致。MXC 的 BFS 管理器实现了事务性回滚——任一路径失败则清理全部。

**当前状态**：`tool-sandbox.ts` 中 `provision()` 使用 `try/catch` 捕获错误但不回滚。

**实现方案**：
1. 在 grant 循环中记录已成功的路径列表
2. 如果某个 grant 失败，遍历已成功列表逐个 revoke
3. 仅在全部成功后将路径写入 settings
4. 添加 `--batch-grant` 命令到 Launcher，原子性处理多路径（可选优化）

**涉及文件**：
- `desktop/src/tool-sandbox.ts` — 重构 `provision()` 和 `grantDirAsync()`
- `appcontainer/Program.cs` — 可选：添加 batch 命令

**工作量**：中等

---

### 5. 权限弹窗超时自动拒绝

**背景**：`SANDBOX_PERMISSION_TIMEOUT_MS` 设为 60 秒，但当前超时后的行为未明确定义为"拒绝"。应确保超时 = 拒绝，且 Agent 收到明确的错误消息。

**当前状态**：`sandbox-permission.js` 中超时逻辑需验证是否返回明确的 deny 信号。

**实现方案**：
1. 审计权限弹窗超时路径，确保所有 code path 在超时后返回 `{ granted: false, reason: "timeout" }`
2. Agent 侧收到的错误消息应说明"用户未在 60 秒内响应，权限请求已拒绝"
3. 日志记录超时拒绝事件

**涉及文件**：
- `appcontainer/sandbox-permission.js` — 超时处理
- `desktop/src/main.ts` — 弹窗超时逻辑

**工作量**：小

---

### 6. 自定义 `deniedPaths` 支持

**背景**：当前仅内置敏感路径（`.ssh`/`.gnupg`/`.aws`/`.azure`/`.config/gcloud`）受保护。用户无法添加自定义黑名单路径。某些企业用户可能需要保护额外的目录（如证书存储、密钥管理器数据库等）。

**当前状态**：`sensitive-shield.ts` 中 `DEFAULT_SENSITIVE_DIRS` 硬编码，无扩展点。

**实现方案**：
1. 添加 `sandboxDeniedPaths: string[]` 到 settings schema
2. 在 `sensitive-shield.ts` 中合并内置列表和用户自定义列表
3. 在 Settings UI 中提供路径管理界面（添加/删除）
4. 自定义路径与内置路径同等对待——ACL shield + fs-hooks + cp-hooks 三层保护

**涉及文件**：
- `desktop/src/sensitive-shield.ts` — 合并自定义路径
- `desktop/src/tool-sandbox.ts` — 读取 settings 中的 deniedPaths
- `desktop/renderer/src/views/SettingsView.vue` — UI 管理
- `appcontainer/sandbox-sensitive.js` — 运行时读取自定义列表

**工作量**：中等

---

### 7. 资源清理可靠性增强

**背景**：JS 层缺乏 RAII 机制，异常路径可能遗漏清理。C# 层有部分 `using` 但覆盖不完整。代码审查发现 `main.ts` 中有多处 "safety delay" 时序变通逻辑，说明 ACL 传播存在竞态。

**当前状态**：多处 `console.warn("[sandbox:verify] no SID cached — adding 500ms safety delay")`，表明存在时序敏感的清理问题。

**实现方案**：
1. **C# 层**：确保所有 SID/Handle 资源包裹在 `SafeHandle` 或 `IDisposable` 中
2. **JS 层**：所有权限操作包裹在 `try/finally`，确保异常路径也执行清理
3. **ACL 传播**：用事件通知替代 safety delay（或增加指数退避 + 上限）
4. **Electron 崩溃恢复**：启动时读取 settings 中的 `sandboxUserDirsRW/RO`，对比实际 ACL 状态，清理孤儿

**涉及文件**：
- `appcontainer/ContainerManager.cs` — SafeHandle 包装
- `appcontainer/sandbox-permission.js` — try/finally
- `desktop/src/main.ts` — 启动恢复逻辑
- `desktop/src/tool-sandbox.ts` — 清理保障

**工作量**：中到大

---

## P2 — 中优先级

### 8. 权限一键撤销 UI

**背景**：当前用户只能逐个目录 revoke 权限，会话结束后如果授予了多个目录，清理操作繁琐。

**实现方案**：
1. 在 Settings 或 Tray 菜单添加"撤销所有权限"按钮
2. 遍历 `sandboxUserDirsRW` + `sandboxUserDirsRO`，批量 revoke
3. 执行后清空 settings 中的目录列表
4. 可选：会话结束时自动提示清理

**涉及文件**：
- `desktop/src/tool-sandbox.ts` — `revokeAll()` 方法
- `desktop/src/tray.ts` — 菜单项
- `desktop/renderer/src/views/SettingsView.vue` — UI 按钮

**工作量**：小

---

### 9. 正则路径提取对抗性测试

**背景**：`path-extraction.js` 使用正则从 shell 命令中提取路径，代码注释明确标注"NOT a security boundary"。但提高提取准确率可减少用户看到不必要的 fallback 弹窗。

**实现方案**：
1. 添加测试用例覆盖：
   - Unicode 路径（`C:\用户\文档\`）
   - UNC 路径（`\\server\share\file`）
   - 符号链接 / Junction（`mklink /J`）
   - 带空格路径（`"C:\Program Files\..."`）
   - 环境变量展开（`%USERPROFILE%\Desktop`）
   - 嵌套引号 / 转义
2. 根据测试结果修复误报/漏报最多的正则模式

**涉及文件**：
- `appcontainer/path-extraction.js` — 正则优化
- `desktop/src/path-extraction.test.ts` — 测试用例

**工作量**：中等

---

### 10. 沙箱状态持久化与崩溃恢复

**背景**：如果 Electron 主进程崩溃，内存中的沙箱状态丢失，但 ACL 已实际修改。重启后不会自动恢复，可能留下 ACL 孤儿。

**实现方案**：
1. 启动时从 `settings.json` 读取 `sandboxUserDirsRW` / `sandboxUserDirsRO`
2. 对每个目录执行 `check-acl` 验证实际状态
3. 如果 settings 有记录但 ACL 无效 → 从 settings 移除
4. 如果 ACL 存在但 settings 无记录 → 提示用户确认或清理

**涉及文件**：
- `desktop/src/tool-sandbox.ts` — 启动恢复逻辑
- `desktop/src/main.ts` — 启动时调用恢复

**工作量**：中等

---

### 11. ACL 验证重试上限

**背景**：`verifyAclPropagation` 重试 3 次（每次 1 秒间隔），但无总时间上限。极端情况下 ACL 传播可能持续卡住。

**实现方案**：
1. 增加 `MAX_ACL_VERIFY_ELAPSED_MS = 10_000`（10 秒上限）
2. 重试循环同时检查已用时间
3. 超出上限后返回失败并记录日志

**涉及文件**：
- `desktop/src/main.ts` — `verifyAclPropagation()` 方法
- `desktop/src/constants.ts` — 新常量

**工作量**：小

---

## 实施路线建议

```
Phase 1 (Quick Wins)
├── #1  LPAC 支持           ← 最高投入产出比
├── #3  进程超时强制终止     ← 安全兜底
├── #5  超时自动拒绝        ← 语义明确化
└── #11 ACL 验证重试上限    ← 30 分钟修复

Phase 2 (Core Security)
├── #2  精确网络控制        ← 最大安全提升
├── #4  ACL 事务化          ← 状态一致性
└── #6  自定义 deniedPaths  ← 企业需求

Phase 3 (Robustness & UX)
├── #7  资源清理增强        ← 稳定性
├── #8  一键撤销 UI         ← 用户便利
├── #9  路径提取测试        ← 防御纵深
└── #10 崩溃恢复            ← 容错性
```
