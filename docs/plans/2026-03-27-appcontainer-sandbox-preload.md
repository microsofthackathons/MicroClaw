# AppContainer 沙箱与 Preload Hook 完整设计文档

**日期**: 2026-03-27  
**分支**: `feature/appcontainer`  
**核心提交**: `293b1c6`, `1c9a454`, `1aa04d4`, `18cfeb9`, `47fab1a`

---

## 1. 总体架构

MicroClaw 使用 Windows AppContainer 沙箱隔离 AI 工具执行的子进程。核心设计：

```
┌──────────────────────────────────────────────────────────────┐
│  Electron 主进程 (非沙箱)                                     │
│  ├─ ToolSandbox 配置                                         │
│  ├─ 签名白名单文件                                            │
│  ├─ 审批弹窗 (dialog)                                        │
│  └─ Gateway 进程管理                                         │
│       │                                                      │
│       ▼                                                      │
│  Gateway 进程 (Node.js, 非沙箱)                               │
│  ├─ sandbox-preload.js (via NODE_OPTIONS --require)           │
│  │   ├─ 拦截 child_process.spawn/spawnSync/execFile/...       │
│  │   ├─ shell 命令 → 路由到 AppContainerLauncher.exe          │
│  │   ├─ 白名单 app → 绕过沙箱                                │
│  │   └─ 未知 app → 通过 IPC 请求用户审批                      │
│  │       │                                                    │
│  │       ▼                                                    │
│  │   ┌─────────────────────────────┐                          │
│  │   │ AppContainerLauncher.exe    │                          │
│  │   │ (CreateProcess w/ AC token) │                          │
│  │   └────────────┬────────────────┘                          │
│  │                │                                           │
│  │                ▼                                           │
│  │   ┌─────────────────────────────┐                          │
│  │   │ 子进程 (cmd/pwsh/python...) │ ← AppContainer 沙箱内    │
│  │   │ • 有限文件访问 (ACL)         │                          │
│  │   │ • 网络: internetClient only  │                          │
│  │   │ • 不能创建命名管道           │                          │
│  │   │ • 不能访问 COM/RPC          │                          │
│  │   └─────────────────────────────┘                          │
│  │                                                            │
│  └── COMSPEC = AppContainerLauncher.exe                       │
│       └─ exec() 调用也通过沙箱                                │
└──────────────────────────────────────────────────────────────┘
```

**关键原则**: Gateway 本身在 AppContainer **外部**运行（AC 内事件循环会阻塞），只有 AI 工具发起的命令行调用被拦截并在 AC 内执行。

---

## 2. 文件清单与职责

| 文件 | 职责 |
|------|------|
| `appcontainer/sandbox-preload.js` | Node.js preload 脚本，拦截 `child_process.*` 并路由到 AC |
| `appcontainer/AppContainerLauncher.exe` | .NET 9 原生启动器，在 AC 沙箱内创建进程 |
| `appcontainer/ContainerManager.cs` | AC 配置管理：创建 profile、ACL、loopback 豁免 |
| `appcontainer/NativeMethods.cs` | Win32 P/Invoke 声明 |
| `appcontainer/Program.cs` | CLI 入口：check/sid/run/grant/revoke/setup/loopback |
| `appcontainer/provision-appcontainer.ps1` | 独立 provision 脚本（开发/调试用） |
| `desktop/src/tool-sandbox.ts` | `ToolSandbox` 类：封装 AC exec/provision/env 配置 |
| `desktop/src/main.ts` | Electron 主进程：sandbox 初始化、IPC 审批、gateway env |
| `desktop/src/preload.ts` | Electron preload：暴露 sandbox API 给 renderer |
| `desktop/renderer/src/views/SettingsView.vue` | 安全设置 UI：白名单编辑 + 目录权限管理 |
| `desktop/renderer/src/i18n/en-US.ts` | 英文翻译（含沙箱目录权限相关 key） |
| `desktop/renderer/src/i18n/zh-CN.ts` | 中文翻译（含沙箱目录权限相关 key） |
| `deployer/windows_setup.py` | 安装程序中的 `provision_appcontainer()` |

---

## 3. sandbox-preload.js 详细设计

### 3.1 加载方式

通过 `NODE_OPTIONS="--require c:/path/to/sandbox-preload.js"` 注入到 gateway 进程。

**注意**: `--require` 路径必须用正斜杠 `/`，反斜杠 `\` 会被 Node.js 解释为转义符。

### 3.2 拦截的方法

| 方法 | 拦截方式 |
|------|---------|
| `child_process.spawn()` | 替换为 `spawn(LAUNCHER, ['run', '--name', ...])` |
| `child_process.spawnSync()` | 同上（同步版本） |
| `child_process.execFile()` | 同上 |
| `child_process.execFileSync()` | 同上 |
| `child_process.exec()` | 通过 `COMSPEC=AppContainerLauncher.exe` 自动拦截 |

### 3.3 拦截条件

只拦截 **shell 可执行文件**（`SHELL_NAMES_SET`）：

```javascript
var SHELL_NAMES_SET = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wsl', 'python', 'python3', 'node'
]);
```

非 shell 的可执行文件（如 `chrome.exe`, `git.exe`）不会被拦截。

### 3.4 延迟激活

Gateway 启动时需要执行一些初始化命令（如 netstat 端口检查）。如果立即激活沙箱，这些命令会在 AC 内失败。

```
启动流程:
1. OPENCLAW_SANDBOX_BYPASS=1 → sandboxActive = false
2. Gateway 正常启动，初始化命令正常执行
3. http.Server.listen() 被 hook
4. 监听到 listen 事件后 → setTimeout(3000ms) → sandboxActive = true
5. 之后所有 shell 调用走沙箱
```

Worker 子进程（没有 `OPENCLAW_SANDBOX_BYPASS`）立即激活。

### 3.5 `stripShell()` 函数

当原始调用带有 `{ shell: true }` option 时，必须移除它。否则 Node.js 会用 COMSPEC 包裹 launcher 命令，导致双重包装：

```
Without strip: cmd.exe /c AppContainerLauncher.exe run ... → 无效
With strip:    AppContainerLauncher.exe run ... → 正确
```

---

## 4. 外部应用白名单系统

### 4.1 问题

某些应用不能在 AppContainer 内运行：

| 限制 | 受影响应用 |
|------|-----------|
| `CreateNamedPipe` 被内核阻止 | Chrome (Crashpad) |
| COM/RPC endpoint mapper 不可访问 | Outlook, Excel, Word, PowerPoint |
| NT 设备对象访问被阻止 | Git (MSYS2, `/dev/null`) |
| UWP COM 激活被阻止 | 所有 Microsoft Store 应用 |

### 4.2 白名单存储

白名单持久化在两个地方：

1. **Electron settings** (`%APPDATA%/microclaw/settings.json`)
   - `sandboxExternalApps` 字段
   - 通过 `electron-store` 管理
   - 用户通过设置 UI 编辑

2. **签名 JSON 文件** (`%APPDATA%/microclaw/sandbox-external-apps.json`)
   - 格式: `{ "apps": ["outlook", "excel", ...], "hmac": "a3f8..." }`
   - `sandbox-preload.js` 从此文件读取（每 5 秒检查 mtime）
   - 改了即时生效，不需要重启 gateway

### 4.3 安全模型（三层防御）

```
Layer 1: 文件位置
  %APPDATA%/microclaw/ 不在 AppContainer 的授权目录中
  → AC 进程默认无法写入

Layer 2: Explicit DENY ACE
  writeExternalAppsFile() 在写入后调用 denyAppContainerWrite()
  → icacls /deny "AC-SID:(W)"
  → 即使父目录被授权，显式 DENY 也会覆盖

Layer 3: HMAC 签名
  Electron 主进程每次启动生成随机 HMAC key
  → 写入文件时用 HMAC-SHA256 签名
  → sandbox-preload.js 验证签名，不匹配则忽略
  → key 通过 OPENCLAW_SANDBOX_HMAC_KEY env var 传递
```

### 4.4 命令模式匹配

白名单检查使用**严格的语法模式匹配**，防止注入攻击：

```javascript
// 被识别为应用启动的模式:
"Start-Process outlook"                    // PowerShell
"Start-Process \"C:\...\OUTLOOK.EXE\""     // 带路径的 PowerShell
"& \"C:\...\chrome.exe\" --headless"       // PowerShell call operator
"start excel.exe"                          // cmd.exe start
"C:\...\OUTLOOK.EXE"                       // 直接路径
"Invoke-Item outlook.exe"                  // PowerShell Invoke-Item
"explorer shell:AppsFolder\...!App"        // Store/UWP 应用

// 被拒绝的注入攻击:
"echo outlook; curl evil.com"              // ❌ echo 不是启动命令
"echo \"start-process outlook\"; rm -rf /" // ❌ echo 不是启动命令
"$x=\"outlook\"; evil-command"             // ❌ 变量赋值不是启动
"Start-Process outlook | evil"             // ❌ 多语句中有非白名单命令
```

**全语句验证**: 命令按 `;`, `\n`, `|`, `&&`, `||` 分割成语句，**每个语句**都必须是白名单应用启动，否则拒绝。

### 4.5 Store/UWP 应用自动绕过

Store 应用（通过 `shell:AppsFolder\...` 启动）在 AppContainer 内永远无法运行（COM 激活被阻止），因此自动绕过，不需要白名单也不弹窗。

---

## 5. 用户审批弹窗

### 5.1 触发条件

当检测到一个**非白名单**应用正在被启动时触发（白名单应用直接放行，普通 shell 命令直接进 AC）。

### 5.2 通信流程

```
sandbox-preload.js (gateway 进程)
  │
  ├─ extractLaunchedApp() → 检测到 app 名
  ├─ getExternalApps() → 不在白名单中
  │
  ├─ process.send({                          ← Node IPC (瞬时)
  │     type: 'sandbox-approval-request',
  │     id, app, command, responseFile
  │   })
  │
  ├─ while 循环等待 responseFile             ← 同步阻塞 (Atomics.wait 200ms)
  │     最长等 60 秒
  │
  ▼
Electron 主进程
  │
  ├─ child.on('message') 接收
  ├─ 检查 session 拒绝列表 → 如已拒绝过就自动拒绝
  ├─ dialog.showMessageBoxSync() 弹窗
  │     [拒绝] [允许一次] [始终允许]
  ├─ 写 responseFile
  │
  └─ 如果"始终允许":
       settingsStore.set() + writeExternalAppsFile()
       → 持久化到白名单
```

### 5.3 三种决定

| 选项 | 效果 | 持久化 |
|------|------|--------|
| 拒绝 | 在 AC 内运行（可能失败）+ 加入 session 拒绝列表 | 仅本次对话 |
| 允许一次 | 绕过 AC 运行 | 无 |
| 始终允许 | 绕过 AC + 加入白名单 | 永久（写入 settings + 签名文件） |

### 5.4 Session 拒绝列表

用户点"拒绝"后，同一 session（对话）内不再弹窗，自动拒绝。

- 按 `sessionKey`（如 `agent:main:session-1774591491646-8ss9va`）隔离
- 新对话重新询问
- Map 最多保留 20 个 session，旧的自动清理

---

## 6. AppContainerLauncher.exe

### 6.1 CLI 命令

```
check                                       检查 OS 是否支持 AC
sid --name NAME                             获取/创建 AC profile，输出 SID
run --name NAME --exe PATH [--cap CAP]...   在 AC 内运行进程
    [--no-window] [--workdir PATH] [-- ARGS...]
grant --name NAME --dir PATH [--access rw|r] 授予目录访问权限
revoke --name NAME --dir PATH               撤销目录访问权限
delete --name NAME                          删除 AC profile
setup --name NAME                           管理员设置 (C:\, C:\Users traverse)
loopback --name NAME [--remove]             添加/移除 loopback 网络豁免
```

### 6.2 COMSPEC 模式

当 `COMSPEC=AppContainerLauncher.exe` 时，Node.js 的 `exec()` 自动通过沙箱：

```
Node.js exec("dir C:\\") 
  → 使用 COMSPEC 启动: AppContainerLauncher.exe /d /s /c "dir C:\"
  → COMSPEC 模式: 解析 args → 在 AC 内启动 cmd.exe /d /s /c "dir C:\"
```

环境变量控制 COMSPEC 模式的行为：

| 变量 | 作用 |
|------|------|
| `OPENCLAW_SANDBOX_BYPASS=1` | 直接传递给真实 cmd.exe |
| `OPENCLAW_SANDBOX_NAME` | AC profile 名 (默认 MicroClaw) |
| `OPENCLAW_SANDBOX_CAPS` | 逗号分隔的 capability |
| `OPENCLAW_SANDBOX_DIRS_RW` | 逗号分隔的 RW 目录 |
| `OPENCLAW_SANDBOX_DIRS_RO` | 逗号分隔的 RO 目录 |
| `OPENCLAW_ORIGINAL_COMSPEC` | 真实 cmd.exe 路径（bypass 时用） |

### 6.3 进程生命周期管理

- **Job Object**: launcher 创建 `KILL_ON_JOB_CLOSE` Job Object
  - 如果 launcher 被杀，子进程也会被杀
  - 防止孤儿进程
- **stdio 继承**: stdin/stdout/stderr 直接继承给子进程
- **Loopback 自动豁免**: 每次 `run` 时自动调用 `checknetisolation`
- **Stale lock 清理**: 每次 `run` 前清理 `%TEMP%/openclaw*/gateway.*.lock`

---

## 7. 文件系统权限模型

### 7.1 系统默认目录

| 目录 | 权限 | 用途 |
|------|------|------|
| `~/.openclaw` | RW (Modify) | 配置、状态、workspace |
| `~/.openclaw/sandbox` | RW (Modify) | 沙箱工作目录 |
| `~/.openclaw-node` | RO (ReadExecute) | Node.js + openclaw 代码 |
| `%TEMP%` | RW (Modify) | 临时文件 |
| `C:\Users\<user>` | Traverse only (no inherit) | 路径遍历（realpathSync） |
| `C:\Users` | Traverse only (no inherit) | 路径遍历 |

这些目录在启动时由 `provisionAsync()` 自动配置 ACL，无需用户操作。在设置 UI 中以半透明样式 + "系统" 标签显示，不可删除。

### 7.2 用户自定义目录

用户可通过设置 UI 添加额外的 RW 或 RO 目录，持久化在 `settingsStore`：

| 设置字段 | 说明 |
|---------|------|
| `sandboxUserDirsRW` | 用户添加的读写目录列表 |
| `sandboxUserDirsRO` | 用户添加的只读目录列表 |

**添加流程**:
1. 用户点击 "+ 添加文件夹" → 弹出系统文件夹选择对话框
2. 选择后写入 `settingsStore` + 内存中的 `ToolSandbox` 列表
3. 调用 `grantDirAsync()` 异步设置 NTFS ACL（不阻塞 UI）
4. 如目录已存在于另一权限列表，自动迁移（如 RO → RW）

**删除流程**:
1. 用户点击 × → 从 `settingsStore` 和内存列表中移除
2. NTFS ACL 不主动撤销（不影响安全性，因为 preload fs 拦截依然生效）

### 7.3 未授权的目录

| 目录 | 结果 |
|------|------|
| `Desktop`, `Documents`, `Downloads` | ❌ 不可访问 |
| `OneDrive` | ❌ 不可访问 |
| `%APPDATA%/microclaw` | 只读（继承），不可写 |
| `C:\Program Files\*` | 只读（`ALL APPLICATION PACKAGES` 默认 ACL） |

### 7.4 Traverse vs ReadExecute

```
Traverse (无继承):
  C:\Users\hasu  → (RD,REA,RA,X) — 只能 lstat 目录本身
  子目录不继承任何权限

ReadExecute (有继承):
  ~/.openclaw-node → (OI)(CI)(RX) — 所有子目录/文件都可读
```

**关键修复** (`47fab1a`): 之前对 `$HOME` 用了 `GrantAccess(readOnly=true)`，它设置 `(OI)(CI)(RX)` 导致所有子目录继承只读。改为 traverse-only 后，只有明确授权的目录可被访问。

### 7.5 fs 写入拦截（白名单模式）

Gateway 进程本身在 AppContainer 外运行，其 `fs.writeFile()` 不受 AC ACL 限制。因此在 `sandbox-preload.js` 中通过 monkey-patch Node.js `fs` 模块来强制执行。

**安全模式**: 采用**白名单模式** — 只有在 RW 目录或安全路径内的写入才被允许，其他所有写入都会触发弹窗询问用户。

**拦截的 fs 操作**:

| 模块 | 同步方法 | 异步方法 | Promise 方法 |
|------|---------|---------|-------------|
| `fs` | `writeFileSync`, `appendFileSync`, `copyFileSync`, `renameSync`, `unlinkSync`, `mkdirSync`, `rmdirSync`, `rmSync`, `openSync` | `writeFile`, `appendFile`, `copyFile`, `rename`, `unlink`, `mkdir`, `rmdir`, `rm`, `open` | — |
| `fs/promises` | — | — | `writeFile`, `appendFile`, `copyFile`, `rename`, `unlink`, `mkdir`, `rmdir`, `rm`, `open` |
| `fs` (流) | `createWriteStream` | — | — |

**读操作不受影响**: `readFile`, `readdir`, `stat`, `access`, `createReadStream` 等正常工作。

**`openSync`/`open` 特殊处理**: 仅在 flags 不是 `r` / `rs` / `sr` 时才拦截（允许只读打开）。

**安全路径白名单**: Gateway 基础设施目录永远不会被拦截：

| 安全路径 | 来源 |
|---------|------|
| `~/.openclaw/` | USERPROFILE |
| `~/.openclaw-node/` | USERPROFILE |
| `OPENCLAW_STATE_DIR` | 环境变量 |
| `%TEMP%` | 环境变量 |
| `%APPDATA%/microclaw/` | APPDATA |
| `%SystemDrive%\tmp\openclaw\` | Gateway 日志目录 |

### 7.6 文件权限弹窗系统

当写入未授权目录时，弹出授权对话框（复用应用白名单弹窗样式）：

#### Gateway fs 写入（同步弹窗）

```
┌───────────────────────────────────────┐
│  AI 助手正在尝试写入未授权的目录         │
│                                       │
│  目标路径: c:\c\test.txt               │
│  所属目录: c:\c\                         │
│                                       │
│  [拒绝] [允许一次] [授予只读] [授予读写] │
└───────────────────────────────────────┘
```

通信流程：`shouldBlockWrite()` → IPC (`sandbox-file-permission-request`) → `dialog.showMessageBoxSync()` → 写 responseFile → preload 同步读取。

#### Shell 命令权限拒绝（异步弹窗）

Shell 命令在 AppContainer 内执行，权限不足时由 OS 内核拒绝。preload 在 `spawn` 的 `close` 事件中检测 stderr 中的 "Access is denied" 等模式，异步发送 IPC 通知 Electron 主进程弹窗。

```
┌───────────────────────────────────────┐
│  AI 执行的命令因权限不足而失败         │
│                                       │
│  被拒绝的路径: C:\c                    │
│  命令: pwsh Get-ChildItem C:\c          │
│                                       │
│  [拒绝]  [授予只读权限]  [授予读写权限]  │
└───────────────────────────────────────┘
```

通信流程：`child.on('close')` → `detectAccessDenied(stderr)` → IPC (`sandbox-shell-permission-request-async`) → `dialog.showMessageBox()` (异步) → 授权 ACL。

注意：Shell 命令的弹窗是**事后**的 — 命令本次已失败，授权后 AI 自然重试时才会成功。`spawnSync` 支持同步重试（弹窗后立即重新执行）。

#### 弹窗选项总结

| 场景 | 按钮 | 效果 | 缓存 |
|------|------|------|------|
| fs 写入 | 拒绝 | 阻止写入 | session 级 |
| fs 写入 | 允许一次 | 允许本次操作 | 5秒 TTL |
| fs 写入 | 授予只读 | 永久加入 RO + ACL | 永久 |
| fs 写入 | 授予读写 | 永久加入 RW + ACL | 永久 |
| shell 命令 | 拒绝 | 不授权 | — |
| shell 命令 | 授予只读 | 永久 ACL，AI 重试时生效 | 永久 |
| shell 命令 | 授予读写 | 永久 ACL，AI 重试时生效 | 永久 |

### 7.7 RW/RO 上下级目录优先级

当父目录和子目录拥有不同权限时，使用**最长路径前缀匹配**（more specific wins）：

```
示例:
  C:\data\         = RO
  C:\data\project\ = RW

  写入 C:\data\readme.txt        → ❌ 拒绝 (匹配 RO, 路径长度 8)
  写入 C:\data\project\file.txt  → ✅ 允许 (匹配 RW, 路径长度 16 > 8)
```

| 配置 | 写入目标 | 结果 | 原因 |
|------|---------|------|------|
| `C:\data\` = RO, `C:\data\project\` = RW | `C:\data\project\file.txt` | ✅ 允许 | RW 路径更长 |
| `C:\data\` = RW, `C:\data\project\` = RO | `C:\data\project\file.txt` | ❌ 拒绝 | RO 路径更长 |
| 同深度冲突 | 任意文件 | ❌ 拒绝 | RO 优先（fail-safe） |

此规则在两层同时生效：
- **fs monkey-patch** (preload): `isReadOnlyPath()` 比较 `_roDirs` 和 `_rwDirs` 的最长匹配
- **NTFS ACL** (AppContainer): Windows 原生支持子目录 ACL 覆盖父目录继承

---

## 8. 第三方软件兼容性

### 8.1 在 AC 内可运行

| 软件 | 原因 |
|------|------|
| python, node | 纯 CLI，只需文件系统 + 网络 |
| curl (Windows 原生) | 系统工具，默认可访问 |
| cmd.exe, powershell, pwsh | 系统 shell |

### 8.2 在 AC 内不可运行

| 软件 | 原因 | 解决方案 |
|------|------|---------|
| Chrome | Crashpad `CreateNamedPipe` 崩溃 | 白名单绕过 |
| Edge | 子进程初始化失败（短暂可启动但不稳定） | 白名单绕过 |
| Outlook/Excel/Word/PPT | COM/RPC endpoint mapper 被阻止 | 白名单绕过 |
| Git (Git for Windows) | MSYS2 `/dev/null` 设备对象被阻止 | 白名单绕过 |
| UWP/Store 应用 | COM 激活 + Package Identity 要求 | 自动绕过 |

---

## 9. 设置 UI

### 9.1 安全设置页面

位于 Settings → 安全（盾牌图标），包含：

1. **启用工具沙箱** — 开关控制 AppContainer 是否生效
2. **免沙箱应用白名单** — 标签编辑器
   - 显示当前白名单应用名称
   - 点 × 删除，输入框 + 回车添加
   - 输入验证：仅允许 `[a-z0-9_-]`
   - 改了即时生效（通过签名文件通知 preload）
3. **沙箱文件目录权限** — 目录列表管理器
   - 分为 **读写 (RW)** 和 **只读 (RO)** 两组
   - 系统默认目录以半透明 + `系统` 标签显示，不可删除
   - 用户自定义目录带 × 按钮可删除
   - 点击 "+ 添加文件夹" 弹出系统文件夹选择对话框
   - 添加时通过 `grantDirAsync()` 异步设置 ACL，不阻塞 UI
   - 同一目录只能有一种权限；如已在另一列表中，自动迁移
   - 提示文字说明上下级目录优先级规则

### 9.2 IPC 接口

| IPC Channel | 方向 | 说明 |
|-------------|------|------|
| `sandbox:get-status` | renderer → main | 获取沙箱状态（含全部 RW/RO 目录） |
| `sandbox:set-enabled` | renderer → main | 启用/禁用沙箱 |
| `sandbox:get-external-apps` | renderer → main | 获取白名单列表 |
| `sandbox:set-external-apps` | renderer → main | 设置白名单列表 |
| `sandbox:apply-external-apps` | renderer → main | 应用白名单（已为 no-op） |
| `sandbox:get-user-dirs` | renderer → main | 获取用户自定义目录 `{rw, ro}` |
| `sandbox:add-user-dir` | renderer → main | 弹出文件夹选择器并添加 |
| `sandbox:remove-user-dir` | renderer → main | 删除用户自定义目录 |
| `sandbox:provision` | renderer → main | 全量 provision（异步） |

### 9.3 应用审批弹窗

当 AI 尝试启动未知应用时弹出：

```
┌───────────────────────────────────┐
│  MicroClaw 沙箱授权                  │
│                                   │
│  AI 助手正在尝试启动 "notepad"       │
│  此应用不在沙箱白名单中              │
│  需要在沙箱外运行。                  │
│                                     │
│  [拒绝]  [允许一次]  [始终允许]      │
└─────────────────────────────────────┘
```

---

## 10. 环境变量一览

| 变量 | 设置位置 | 用途 |
|------|---------|------|
| `COMSPEC` | main.ts → gwEnv | 设为 AppContainerLauncher.exe |
| `OPENCLAW_ORIGINAL_COMSPEC` | main.ts → gwEnv | 保存真实 cmd.exe 路径 |
| `OPENCLAW_SANDBOX_BYPASS` | main.ts → gwEnv | 启动时 bypass，listen 后移除 |
| `OPENCLAW_SANDBOX_NAME` | main.ts → gwEnv | AC profile 名 (MicroClaw) |
| `OPENCLAW_SANDBOX_CAPS` | main.ts → gwEnv | AC capabilities |
| `OPENCLAW_SANDBOX_DIRS_RW` | main.ts → gwEnv | RW 目录列表 |
| `OPENCLAW_SANDBOX_DIRS_RO` | main.ts → gwEnv | RO 目录列表 |
| `OPENCLAW_SANDBOX_HMAC_KEY` | main.ts → gwEnv | 白名单文件 HMAC 密钥 |
| `OPENCLAW_AC_EXTERNAL_APPS` | main.ts → gwEnv | 白名单（fallback，文件优先） |
| `OPENCLAW_NO_RESPAWN` | main.ts → gwEnv | 阻止 AC 内重生 |

---

## 11. 已知限制与注意事项

1. **`--force` 已移除**: gateway 的 `--force` 标志调用 `exec("netstat")`，通过 COMSPEC 进入 AC，返回错误结果导致 gateway 自杀循环。改为依赖 `CleanStaleLockFiles()` 和 Job Object。

2. **SIGUSR1 重启不更新 env**: Gateway 的 in-process restart (SIGUSR1) 不会重载环境变量。白名单变更通过文件系统通信绕过此限制。

3. **Atomics.wait 用于同步等待**: 审批流程中 preload 使用 `Atomics.wait(SharedArrayBuffer, ...)` 做 200ms 同步 sleep。需要 `--experimental-shared-array-buffer`（Node 22+ 默认启用）。

4. **每个 spawn 调用一次 stat**: `getExternalApps()` 每 5 秒最多执行一次 `statSync`（~0.01ms），99% 情况直接返回缓存。

5. **exec() 拦截不完整**: `child_process.exec()` 通过 COMSPEC 拦截而非 preload hook。这意味着 exec() 不经过白名单检查，只经过 AC 的 COMSPEC 模式。
