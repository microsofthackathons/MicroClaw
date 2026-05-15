# AppContainer Tool Execution Sandbox — 实现文档

**日期**: 2026-03-26  
**分支**: `feature/appcontainer`  
**状态**: spawn 拦截验证通过，ACL 权限待完善

---

## 1. 目标

让 AI agent 执行的 shell 命令（PowerShell、cmd、bash 等）运行在 Windows AppContainer 沙箱内，限制其文件系统访问（无法读取 SSH 密钥、Git 凭据等），同时不影响 gateway 本身的正常运行。

## 2. 架构

```
用户聊天 → AI agent 决定执行命令
                  ↓
   Gateway (node.exe, 正常进程, 不在 AC)
     → child_process.spawn('powershell', ['-Command', '...'])
                  ↓
   sandbox-preload.js 拦截 spawn
     → 替换为 spawn('AppContainerLauncher.exe',
         ['run', '--name', 'MicroClaw', '--exe', 'powershell', ...])
                  ↓
   AppContainerLauncher.exe (C#/.NET 9)
     → CreateProcessW + SECURITY_CAPABILITIES
     → powershell.exe 运行在 AppContainer 沙箱内
     → 敏感文件不可访问 ✅
```

### 为什么 Gateway 不直接运行在 AppContainer 里

尝试过，但 gateway 启动后 event loop 卡死：
- `spawnSync("netstat")` → EPERM
- `process.kill(pid, 0)` → EPERM（被误判为进程存活 → 死循环）
- 各种 sidecar 初始化中的同步操作全部失败

详见 [event loop investigation](2026-03-26-appcontainer-event-loop-investigation.md)。

## 3. 核心组件

### 3.1 sandbox-preload.js

**加载方式**: `NODE_OPTIONS="--require c:/git/microclaw/appcontainer/sandbox-preload.js"`

> 路径必须用正斜杠 `/`。反斜杠 `\` 在 `NODE_OPTIONS` 中被当作转义符，导致 `MODULE_NOT_FOUND`。

**Monkey-patch 的方法**:
- `child_process.spawn` / `spawnSync`
- `child_process.execFile` / `execFileSync`
- `child_process.exec` / `execSync`（通过 COMSPEC 间接拦截）

**拦截名单** (去掉路径和 .exe 后缀，小写匹配):
```
cmd, powershell, pwsh, bash, sh, wsl, python, python3, node
```

**延迟激活**:

| 阶段 | sandboxActive | 说明 |
|------|:---:|------|
| 启动 (0~5s) | `false` | BYPASS=1，startup 命令正常执行 |
| HTTP listen + 3s | `true` | hook `http.Server.prototype.listen` 触发 |
| Worker 进程 | `true` | BYPASS 已被父进程删除，立即激活 |

**stripShell()**: 当 spawn 选项包含 `shell: true` 时移除，防止 Node.js 再用 COMSPEC 包装一层导致双重 AppContainer 嵌套。

### 3.2 AppContainerLauncher.exe

**语言**: C# / .NET 9, win-x64

**两种调用模式**:

**A) spawn 拦截模式** (preload 重写参数):
```
AppContainerLauncher.exe run \
  --name MicroClaw \
  --exe "C:\Program Files\PowerShell\7\pwsh.exe" \
  --no-window \
  --cap internetClient \
  -- -Command "Get-Process"
```

**B) COMSPEC 模式** (exec() 走 COMSPEC):
```
AppContainerLauncher.exe -c "dir /b"
  → 检测到 -c 参数
  → 转换为: cmd.exe /d /s /c "dir /b" 在 AC 内执行
  → BYPASS=1 时直接转发给原始 cmd.exe
```

**核心 Win32 API 调用链**:
1. `CreateAppContainerProfile` → 获取 SID
2. `SECURITY_CAPABILITIES` + capability SID 数组
3. `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute`
4. `CreateProcessW` (EXTENDED_STARTUPINFO_PRESENT + 继承 stdio handles)
5. `CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` → 防止僵尸进程
6. `WaitForSingleObject` → 等待子进程退出

### 3.3 desktop/src/main.ts — Electron 集成

启动 gateway 时注入沙箱环境变量:
```typescript
const gwEnv = {
  COMSPEC: launcherPath,                    // → AppContainerLauncher.exe
  OPENCLAW_SANDBOX_BYPASS: "1",             // 启动阶段 bypass
  OPENCLAW_SANDBOX_NAME: "MicroClaw",       // AC profile 名称
  OPENCLAW_SANDBOX_CAPS: "internetClient",  // 网络能力
  OPENCLAW_ORIGINAL_COMSPEC: "cmd.exe",     // 原始 COMSPEC（bypass 用）
  OPENCLAW_SANDBOX_DIRS_RW: "...",          // 允许读写的目录
  OPENCLAW_SANDBOX_DIRS_RO: "...",          // 允许只读的目录
  NODE_OPTIONS: "... --require c:/.../sandbox-preload.js",
};
```

### 3.4 desktop/src/tool-sandbox.ts — ToolSandbox 类

封装 provision、exec、IPC 状态查询:
- `provision()` — 创建 AC profile、设置 ACL、loopback 豁免
- `getGatewayEnv()` — 生成上述环境变量
- `getPreloadPath()` — 返回 sandbox-preload.js 路径
- `execShell()` / `execNode()` — 直接 API (供 IPC 使用)
- `getStatus()` — 供前端显示沙箱状态

## 4. 遇到的问题与解决

| # | 问题 | 根因 | 解决 |
|---|------|------|------|
| 1 | Gateway 启动崩溃 | `NODE_OPTIONS --require` 路径 `c:\git\...` 反斜杠被吃 | 转为 `c:/git/...` |
| 2 | PowerShell 不在 AC | 只劫持了 COMSPEC (exec)，spawn 未拦截 | monkey-patch spawn/spawnSync/execFile |
| 3 | Worker 进程不沙箱 | preload 只在 BYPASS=1 时激活; worker 继承已删除的 env | bypass 不存在 → 立即激活 |
| 4 | shell:true 双重包装 | Node.js 内部再用 COMSPEC 包一层 | stripShell() 移除 |
| 5 | Gateway 无限重启 | `postSpawnRestartDone` 每次重置为 false | 只首次为 false |
| 6 | pwsh.exe 执行失败 | AC 没有 `C:\Program Files\PowerShell\7\` 读取 ACL | **待修复**: 需要 grant 该目录 |

## 5. 验证结果

**sandbox-preload 拦截成功**:
```
[sandbox-preload] Loaded (main) - waiting for HTTP listen
[sandbox-preload] Sandbox activated - shell spawns now sandboxed
[sandbox] spawn: pwsh.exe -> AC
[sandbox-diag] spawn: cmd=C:\Program Files\PowerShell\7\pwsh.exe isShell=true active=true shell=false
```

**独立测试通过** (不经过 MicroClaw):
```
Before listen: powershell 正常执行 (bypass)  ✅
After activation: powershell → AppContainer   ✅
SSH key read: BLOCKED (exit 1)                ✅
Git credential read: BLOCKED (exit 1)         ✅
Temp dir write: ALLOWED                       ✅
```

## 6. 待完成

- [ ] 给 `C:\Program Files\PowerShell\7\` 授予 AppContainer 只读 ACL
- [ ] 给 `C:\Windows\System32\` (cmd.exe, Windows PowerShell) 授予 traverse ACL (需要管理员)
- [ ] 移除 sandbox-preload.js 中的 `[sandbox-diag]` 诊断日志
- [ ] 测试 Python、Node.js 等其他拦截的可执行文件
- [ ] 前端 UI 显示沙箱状态 (sandbox:get-status IPC 已就绪)

## 7. 文件清单

| 文件 | 说明 |
|------|------|
| `appcontainer/sandbox-preload.js` | NODE_OPTIONS --require 注入, spawn/exec 拦截 |
| `appcontainer/Program.cs` | CLI: run/grant/revoke/setup/loopback + COMSPEC 模式 |
| `appcontainer/ContainerManager.cs` | CreateProcessW + ACL + Job Object |
| `appcontainer/NativeMethods.cs` | Win32 P/Invoke 声明 |
| `desktop/src/tool-sandbox.ts` | ToolSandbox 类 |
| `desktop/src/main.ts` | 沙箱初始化 + gateway env 注入 + IPC handlers |
| `desktop/src/gateway-manager.ts` | 同上 (独立模式) |
| `desktop/src/preload.ts` | sandbox API 暴露给渲染进程 |
| `desktop/electron-builder.yml` | 打包 AppContainerLauncher.exe + sandbox-preload.js |
| `deployer/windows_setup.py` | 安装时 provision_appcontainer() |
| `build.ps1` | dotnet publish + 拷贝 sandbox-preload.js |

## 8. Git 提交历史 (feature/appcontainer)

1. `feat: integrate AppContainer sandbox into gateway launch`
2. `feat: complete AppContainer end-to-end integration`
3. `fix: AppContainer provisioning and build pipeline`
4. `fix: add Job Object to kill child node.exe when launcher exits`
5. `feat: TCP reverse relay for AppContainer gateway`
6. `fix: standalone relay process instead of --require injection`
7. `refactor: gateway runs outside AppContainer, keep Launcher for tool sandbox`
8. `feat: implement AppContainer tool execution sandbox` (COMSPEC 方案)
9. `fix: intercept spawn/execFile for AppContainer tool sandbox`
10. `fix: NODE_OPTIONS --require path backslash escaping`
11. `fix: sandbox preload worker support + shell:true + restart loop`
12. `diag: add [sandbox-diag] logging for spawn interception`
