# 安全工具绕过 AppContainer — 设计文档

**目标：** 让已知安全的 CLI 工具（如 officecli）直接执行，跳过 AppContainer 包装，消除每次调用约 50-200ms 的进程创建开销。

**动机：** 用户使用 officecli 处理 Office 文档时，每个命令都要经过完整的 sandbox spawn hook 链路：`powershell → sandbox-preload 拦截 → AppContainerLauncher.exe → CreateProcess(AC token) → powershell → officecli`。一个典型的文档工作流有 10-20 个命令，累计开销 0.5-4 秒。

---

## 1. 问题分析

### 当前调用链（每次 officecli 命令）

```
Gateway: spawn('powershell', ['-Command', 'officecli create report.docx'])
  │
  ├─ sandbox-preload.js 拦截
  │   ├─ isShellExe('powershell') → true
  │   ├─ preBlockShellCommand(): 30+ 正则提取路径 + 权限检查
  │   └─ buildLA(): 构建 AppContainerLauncher 参数
  │
  ├─ spawn('AppContainerLauncher.exe', ['run', '--name', 'MicroClaw',
  │    '--exe', 'powershell.exe', '--cap', 'internetClient', '--',
  │    '-Command', 'officecli create report.docx'])
  │
  ├─ AppContainerLauncher.exe (.NET)
  │   ├─ CreateAppContainerProfile / DeriveAppContainerSid
  │   ├─ GrantAncestorTraverse (ACL 检查)
  │   └─ CreateProcessW (构建 AC token + SECURITY_CAPABILITIES)
  │
  └─ powershell.exe (在 AppContainer 内)
      └─ officecli create report.docx
```

### 开销明细

| 阶段 | 耗时 | 说明 |
|------|------|------|
| sandbox-preload.js 拦截 | <5ms | JS 字符串匹配 + 正则路径提取 |
| AppContainerLauncher 进程创建 | 10-50ms | .NET AOT 二进制，Windows 进程创建本身有开销 |
| Win32 AC CreateProcess | 10-50ms | SECURITY_CAPABILITIES 构建 + token 创建 |
| powershell 冷启动 | 50-150ms | 在 AC 内启动 PowerShell 解释器 |
| **总计（每次命令）** | **~70-250ms** | 纯沙箱开销，不含 officecli 本身执行时间 |

### 为什么 officecli 可以安全绕过

| 属性 | 说明 |
|------|------|
| 不执行任意代码 | officecli 只解析和操作 Office XML 文件结构 |
| 无网络能力 | 不发起网络请求 |
| 文件访问有限 | 只读写用户指定的 .docx/.xlsx/.pptx 文件 |
| 无子进程 | 不 spawn 其他进程 |
| 受信来源 | 从官方仓库安装，已有 skill integrity 签名保护 |

---

## 2. 方案设计

### 方案一：安全工具白名单（推荐）

在 sandbox-preload.js 的 spawn hook 中，**在** `isShellExe()` 检查之前，先检查命令文本是否只调用白名单内的安全工具。如果是，直接执行原始 spawn，不走 AC 包装。

#### 白名单定义

```javascript
// 安全工具：不执行任意代码，只操作特定文件格式
var SAFE_TOOLS = new Set(['officecli']);
```

#### 拦截逻辑修改

```
spawn('powershell', ['-Command', 'officecli set report.docx /body ...'])
  │
  ├─ isShellExe('powershell') → true
  ├─ extractToolName(args) → 'officecli' ∈ SAFE_TOOLS
  ├─ 仍然执行 fs 层面的 RO/RW 权限检查（保持文件保护）
  └─ 直接 _spawn(cmd, args, opts)，不走 AC 包装
```

#### 安全保证

1. **仍受 fs monkey-patch 保护** — sandbox-preload 的 `fs.writeFileSync` / `fs.readFileSync` 等 hook 不受影响，文件读写权限检查依然生效
2. **只绕过进程级沙箱** — 跳过 AppContainerLauncher 包装，但 JS 层面的 RO/RW 目录限制仍然有效
3. **白名单可配置** — 通过 settings 或环境变量配置，不硬编码

#### 工具名提取

从 shell 命令参数中提取实际执行的工具名：

```javascript
function extractToolName(cmd, args) {
  // powershell -Command "officecli set ..."
  // cmd /c "officecli set ..."
  var payload = '';
  var argArr = Array.isArray(args) ? args : [];
  for (var i = 0; i < argArr.length; i++) {
    var a = String(argArr[i]);
    if (/^[-\/][a-z]/i.test(a)) continue;  // skip flags
    payload = argArr.slice(i).join(' ');
    break;
  }
  if (!payload) return null;
  // 提取第一个 token（可能带引号或路径）
  var m = payload.match(/^\s*["']?(?:[a-zA-Z]:\\[^"'\s]*\\)?([a-zA-Z0-9_.-]+?)(?:\.exe)?["']?\s/i);
  return m ? m[1].toLowerCase() : null;
}
```

#### 安全验证

必须确保整个命令**只**包含安全工具调用，不能有管道、链式命令等注入向量：

```javascript
function isSafeToolOnlyCommand(cmd, args) {
  var toolName = extractToolName(cmd, args);
  if (!toolName || !SAFE_TOOLS.has(toolName)) return false;
  
  // 确保命令中没有危险的链式操作符
  var payload = buildCmdPreview(cmd, args);
  if (/[;&|`$]/.test(payload)) return false;  // 管道、链式、变量展开
  if (/>/.test(payload)) return false;  // 重定向
  
  return true;
}
```

### 方案二：resident mode 提示（互补）

officecli 本身支持 `open`/`close` 常驻模式：

```bash
officecli open report.docx       # 保持文件在内存中
officecli set report.docx ...    # 无文件 I/O 开销
officecli close report.docx      # 保存并释放
```

即使不做方案一的优化，SKILL.md 中已经提到了 resident mode。如果 AI agent 正确使用 `open`/`close`，可以减少文件 I/O 但**不能**减少进程创建开销（每条命令仍然是独立的 spawn）。

**结论**：方案一和方案二互补。方案一消除进程创建开销，方案二减少文件 I/O 开销。

---

## 3. 实现计划

### Task 1: sandbox-preload.js — 安全工具白名单

**文件**: `appcontainer/sandbox-preload.js`

修改点：
1. 新增 `SAFE_TOOLS` 集合（从环境变量 `OPENCLAW_SANDBOX_SAFE_TOOLS` 读取）
2. 新增 `extractToolName(cmd, args)` — 从 shell 命令中提取工具名
3. 新增 `isSafeToolOnlyCommand(cmd, args)` — 验证命令是否只包含白名单工具调用
4. 在 `cp.spawn` / `cp.spawnSync` / `cp.execFile` / `cp.execFileSync` 四个 hook 中，`isShellExe()` 为 true 时，先检查 `isSafeToolOnlyCommand()`，如果是则直接调用原始函数

### Task 2: tool-sandbox.ts — 传递安全工具列表

**文件**: `desktop/src/tool-sandbox.ts`

修改点：
1. `getGatewayEnv()` 中添加 `OPENCLAW_SANDBOX_SAFE_TOOLS` 环境变量
2. 默认值: `officecli`

### Task 3: main.ts — settings 配置

**文件**: `desktop/src/main.ts`

修改点：
1. settingsStore 增加 `sandboxSafeTools: string[]` 字段
2. IPC handler 暴露给 renderer

### Task 4: 测试验证

手动测试：
1. 启动 desktop app
2. 让 agent 使用 officecli 创建一个文档
3. 观察 stderr 日志：应该看到 `[sandbox] spawn: powershell -> SAFE_TOOL_BYPASS (officecli)`
4. 对比：不走 AC 的命令 vs 走 AC 的命令的执行时间

---

## 4. 安全分析

### 注入风险

| 攻击向量 | 防御 |
|---------|------|
| `officecli; malicious-command` | `isSafeToolOnlyCommand()` 拒绝包含 `;` 的命令 |
| `officecli \| malicious-pipe` | 拒绝包含 `\|` 的命令 |
| `officecli && rm -rf /` | 拒绝包含 `&&` 的命令 |
| `officecli $(evil)` | 拒绝包含 `$` 的命令 |
| `officecli > /etc/passwd` | 拒绝包含 `>` 的命令 |
| 伪造工具名 (PATH 劫持) | officecli 安装在签名保护的 skill 目录，PATH 由 gateway 控制 |

### 残余保护

即使绕过 AC，以下保护仍然生效：
- **fs monkey-patch**: 所有 fs 读写操作仍受 RO/RW 目录限制检查
- **skill integrity**: officecli 二进制受签名保护，无法被篡改
- **gateway 进程权限**: 以用户权限运行，无 admin 提权
