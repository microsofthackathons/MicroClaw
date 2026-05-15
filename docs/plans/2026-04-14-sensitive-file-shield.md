
# Sensitive File Shield — 设计文档

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 敏感文件（SSH 密钥、GPG 密钥环、云凭据等）在任何情况下都不可被沙箱内的 Agent 访问 — 即使所在父目录已被授予 AppContainer SID。同时防止 NTFS ACL 继承把 Container SID 传播到这些文件，避免破坏 OpenSSH 等外部工具的权限检查。

**安全原则:** 敏感文件对沙箱完全不可见、不可读、不可写。不提供任何代理或中转机制。Agent 不需要也不应该接触这些文件。

**Tech Stack:** C# (ContainerManager), TypeScript (Electron main), JavaScript (sandbox hooks)

**设计原则:** 最大化解耦 — 新功能放入独立新模块，现有模块仅做最小改动。每个模块可独立测试。

---

## 设计分析

### 现状

1. `GrantAccess()` 对目录设置 `ContainerInherit | ObjectInherit` ACE
2. NTFS 继承将 ACE 自动传播到所有子文件和子目录
3. `.ssh/id_rsa` 等文件获得了 AppContainer SID → OpenSSH 拒绝使用 ("Permissions too open")
4. `sandbox-permission.js` 的 `shouldBlockRead`/`shouldBlockWrite` 可以拦截 Node.js `fs.*` 调用，但 shell 命令（`type`、`cat`）走 OS 级别，依赖 ACL 来实控
5. 手动清理 SID 后，下次 provision/grant 又会恢复

### 受影响文件类型

| 路径 | 检测方 | 后果 |
|------|--------|------|
| `~/.ssh/id_rsa`, `id_ed25519` 等 | OpenSSH、VS Code Remote | 拒绝使用密钥 ("Permissions too open") |
| `~/.ssh/config` | OpenSSH | 可能忽略配置 |
| `~/.gnupg/` | GPG | 报警密钥环不安全 |
| `~/.aws/credentials` | AWS CLI | 凭据泄露风险 |
| `~/.azure/` | Azure CLI | 凭据泄露风险 |
| `~/.config/gcloud/` | gcloud CLI | 凭据泄露风险 |

---

## 方案：双层硬封锁（ACL Shield + Hook 硬拒绝）

两层防御，互为冗余，确保敏感文件在 OS 层和应用层都不可访问：

### 第一层：ACL Shield（OS 级 — 断开继承并移除 SID）

当 `GrantAccess()` 授权到包含敏感子目录的路径时，自动保护这些子目录。

**原理：**
1. 正常对父目录添加 ACE（带继承）
2. 检测目标目录下是否存在已知敏感子路径
3. 对敏感子目录：`SetAccessRuleProtection(true, true)` ← 断开继承，复制已有 ACE
4. `PurgeAccessRules(containerSid)` ← 从复制出来的显式 ACE 中移除 Container SID
5. 结果：敏感子目录中的文件在 OS 级别对 AppContainer 不可访问，shell 命令（`type`、`cat`）也无法读取

**撤销逻辑：**
调用方在 `RevokeAccess()` 前先调用 `unshield`，恢复敏感子目录的继承设置（`SetAccessRuleProtection(false, false)`），让 ACL 重新跟随父目录。

**CLI 接口（独立命令，不修改现有 grant/revoke 内部逻辑）：**
```
AppContainerLauncher.exe shield --name MicroClaw --dir C:\Users\xxx            # 自动检测并 shield 所有已知敏感子目录
AppContainerLauncher.exe shield --name MicroClaw --dir C:\Users\xxx\.ssh       # 手动 shield 单个目录
AppContainerLauncher.exe unshield --name MicroClaw --dir C:\Users\xxx\.ssh     # 恢复继承
```

### 第二层：Hook 硬拒绝（应用级 — 无条件拦截 fs 操作）

**新建独立模块** `sandbox-sensitive.js`，不修改现有 `sandbox-permission.js`。

对匹配的路径：
- **跳过所有权限缓存和 IPC 请求逻辑**
- **直接返回 deny，不弹出任何权限对话框**
- 用户无法通过 UI 授权访问这些路径

**原理：**
1. `sandbox-sensitive.js` 作为独立模块，导出 `isSensitivePath(filePath)` 和 `throwSensitiveDenied(filePath)`
2. `sandbox-fs-hooks.js` 在调用 `shouldBlockWrite` / `shouldBlockRead` **之前**先检查 `isSensitivePath`
3. 如果匹配敏感路径 → 直接抛出专用错误，不进入 permission 模块
4. `sandbox-permission.js` 完全不修改

**为什么需要两层：**
- ACL Shield 保护 shell 命令（`type`、`cat`、`Get-Content`）—— 这些绕过 Node.js hooks
- Hook 硬拒绝保护 Node.js `fs.*` 调用 —— 即使 ACL Shield 因时序问题（新建目录尚未 shield）未生效，也能兜底
- 两层互为冗余：任一层失效，另一层仍然阻止访问

**默认敏感路径清单（硬编码 + 可配置）：**
```
.ssh
.gnupg
.aws
.azure
.config/gcloud
```

### ~~已废弃方案~~

以下方案在之前的设计中曾被考虑，但已明确废弃：

- **~~SSH Agent 代理~~**：通过 named pipe 让沙箱内间接完成 SSH 认证 → **废弃原因**：Agent 不需要执行 SSH 认证，沙箱内的 git 操作应使用 HTTPS 或用户在沙箱外自行操作
- **~~IPC Read-Proxy~~**：通过 IPC 在沙箱外读取敏感文件内容并返回给沙箱 → **废弃原因**：这实质上绕过了保护，违背"敏感文件不可访问"的安全原则

---

## 模块边界与依赖关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        C# (AppContainer)                        │
│                                                                 │
│  ContainerManager.cs         Program.cs                         │
│  ┌──────────────────┐       ┌──────────────────────────┐       │
│  │ GrantAccess()     │       │ grant [--shield-sensitive]│       │
│  │ RevokeAccess()    │       │ shield                   │       │
│  │ (不修改)          │       │ unshield                 │       │
│  ├──────────────────┤       │                          │       │
│  │ ShieldPaths() NEW │◄──────│ (调用方组合，非内部集成)  │       │
│  │ UnshieldPath() NEW│       └──────────────────────────┘       │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   TypeScript (Electron main)                     │
│                                                                 │
│  tool-sandbox.ts                sensitive-shield.ts (NEW)       │
│  ┌──────────────────┐          ┌──────────────────────┐        │
│  │ grantDirAsync()   │──call──▶│ shieldIfNeeded()     │        │
│  │ revokeDirAsync()  │──call──▶│ unshieldIfNeeded()   │        │
│  │ provisionAsync()  │──call──▶│ shieldAll()          │        │
│  │ (最小改动:        │          │ shouldShield()       │        │
│  │  仅添加import和   │          │ DEFAULT_SENSITIVE    │        │
│  │  在hook点调用)    │          └──────────────────────┘        │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   JavaScript (sandbox hooks)                     │
│                                                                 │
│  sandbox-fs-hooks.js          sandbox-sensitive.js (NEW)        │
│  ┌──────────────────┐        ┌──────────────────────────┐      │
│  │ write ops hooks   │──pre──▶│ isSensitivePath()        │      │
│  │ read ops hooks    │  check │ throwSensitiveDenied()   │      │
│  │ (最小改动:        │        │ SENSITIVE_DIRS           │      │
│  │  hook前先检查)    │        └──────────────────────────┘      │
│  └──────────────────┘                                           │
│                                                                 │
│  sandbox-permission.js                                          │
│  ┌──────────────────┐                                           │
│  │ shouldBlockRead() │  ← 完全不修改                             │
│  │ shouldBlockWrite()│                                          │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

**解耦要点：**
1. `ContainerManager.cs`：`GrantAccess()` / `RevokeAccess()` 不修改。`ShieldSensitivePaths()` / `UnshieldPath()` 作为独立静态方法，由 CLI 命令或调用方组合使用
2. `sandbox-permission.js`：完全不修改。敏感路径逻辑不侵入权限系统
3. **新文件** `sandbox-sensitive.js`：敏感路径检测的单一真相源（Single Source of Truth），独立可测
4. **新文件** `sensitive-shield.ts`：TypeScript 侧的 shield 编排逻辑，独立可测
5. `sandbox-fs-hooks.js`：最小改动 — 仅在现有 shouldBlock 检查前插入一行 `isSensitivePath` 前置检查
6. `tool-sandbox.ts`：最小改动 — 仅 import `sensitive-shield.ts` 并在 grant/revoke/provision 的 hook 点调用

---

## 实现计划

### Task 1: ContainerManager.cs — 添加 ShieldSensitivePaths / UnshieldPath 独立方法

**Files:**
- Modify: `appcontainer/ContainerManager.cs`

添加独立的 shield/unshield 静态方法。**不修改 `GrantAccess()` 和 `RevokeAccess()`**，保持它们的职责单一。

```csharp
/// <summary>Known-sensitive subdirectories whose ACLs must not inherit AppContainer SID.</summary>
private static readonly string[] DefaultSensitiveDirs = {
    ".ssh", ".gnupg", ".aws", ".azure",
    Path.Combine(".config", "gcloud"),
};

/// <summary>
/// Break ACL inheritance on sensitive subdirectories and remove the
/// AppContainer SID, so that the sandbox process cannot access these
/// files at all and external tools (OpenSSH, GPG) ACLs stay clean.
/// 
/// This is a standalone operation — does NOT modify GrantAccess/RevokeAccess
/// internals. The caller is responsible for orchestrating the call sequence.
/// </summary>
public static List<string> ShieldSensitivePaths(string containerName, string parentDir, string[]? extraDirs = null)
{
    string sidStr = EnsureProfile(containerName);
    var sid = new SecurityIdentifier(sidStr);
    var shielded = new List<string>();
    var dirsToCheck = DefaultSensitiveDirs.AsEnumerable();
    if (extraDirs != null) dirsToCheck = dirsToCheck.Concat(extraDirs);

    foreach (var rel in dirsToCheck)
    {
        var fullPath = Path.Combine(parentDir, rel);
        if (!Directory.Exists(fullPath)) continue;

        var info = new DirectoryInfo(fullPath);
        var security = info.GetAccessControl();

        // Step 1: Break inheritance, copy existing inherited ACEs as explicit
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: true);

        // Step 2: Remove all explicit rules for this Container SID
        security.PurgeAccessRules(sid);

        info.SetAccessControl(security);
        shielded.Add(fullPath);
    }
    return shielded;
}

/// <summary>
/// Restore ACL inheritance on a previously-shielded directory.
/// Standalone operation — call before RevokeAccess to clean up.
/// </summary>
public static void UnshieldPath(string dirPath)
{
    if (!Directory.Exists(dirPath)) return;
    var info = new DirectoryInfo(dirPath);
    var security = info.GetAccessControl();
    security.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
    info.SetAccessControl(security);
}

/// <summary>
/// Get the default list of sensitive directory names.
/// Exposed for CLI and testing.
/// </summary>
public static string[] GetDefaultSensitiveDirs() => DefaultSensitiveDirs;
```

**Commit:** `feat(sandbox): add standalone ShieldSensitivePaths / UnshieldPath methods`

---

### Task 2: Program.cs — 添加独立 CLI 命令

**Files:**
- Modify: `appcontainer/Program.cs`

添加 `shield` 和 `unshield` 作为**独立的顶级命令**。`grant` 命令增加 `--shield-sensitive` 便捷标志（语法糖，内部分别调用 GrantAccess + ShieldSensitivePaths）。

```
shield   --name NAME --dir PATH [--extra .foo,.bar]   # shield一个父目录下的敏感子目录，或直接 shield 指定目录
unshield --name NAME --dir PATH                        # 恢复继承
grant    --name NAME --dir PATH [--shield-sensitive]   # grant 后自动 shield（便捷组合）
```

**`--shield-sensitive` 的实现**：在 grant 完成后，在 CmdGrant 函数中追加调用 `ContainerManager.ShieldSensitivePaths(name, dir)`。这是 CLI 层面的组合，不是 GrantAccess 的内部集成。

```csharp
// In CmdGrant, after GrantAccess completes:
if (shieldSensitive && Directory.Exists(dir))
{
    var shielded = ContainerManager.ShieldSensitivePaths(name, dir);
    foreach (var s in shielded)
        Console.Error.WriteLine($"[grant] Shielded sensitive dir: {s}");
}
```

**Commit:** `feat(sandbox): add shield/unshield CLI commands and --shield-sensitive flag`

---

### Task 3: sandbox-sensitive.js — 新建独立敏感路径模块

**Files:**
- Create: `appcontainer/sandbox-sensitive.js`

**新建独立模块**，作为沙箱内敏感路径检测的单一真相源。不依赖 `sandbox-permission.js` 或 `sandbox-state.js` 中的任何逻辑。

```javascript
/**
 * sandbox-sensitive.js — Sensitive path detection and blocking.
 *
 * Standalone module. Single source of truth for which paths are
 * considered sensitive and must never be accessed by the sandbox.
 * Does NOT depend on sandbox-permission.js or sandbox-state.js.
 */
'use strict';

var path = require('path');

// ── Default sensitive directories (relative to user home) ──

var SENSITIVE_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  path.join('.config', 'gcloud'),
];

var _home = (process.env.USERPROFILE || process.env.HOME || '').toLowerCase();
var _resolvedSensitive = _home
  ? SENSITIVE_DIRS.map(function(d) { return path.join(_home, d).toLowerCase(); })
  : [];

/**
 * Check if a file path is under a sensitive directory.
 * Pure function, no side effects, no IPC, no caching.
 */
function isSensitivePath(filePath) {
  if (!_home || !filePath) return false;
  var resolved;
  try { resolved = path.resolve(String(filePath)).toLowerCase(); } catch { return false; }
  for (var i = 0; i < _resolvedSensitive.length; i++) {
    var s = _resolvedSensitive[i];
    if (resolved === s || resolved.indexOf(s + path.sep) === 0) return true;
  }
  return false;
}

/**
 * Create an Error for sensitive path access denial.
 * Message is distinct from normal permission denial to prevent
 * the agent from retrying or requesting permission.
 */
function throwSensitiveDenied(filePath) {
  var err = new Error(
    'DENIED: "' + filePath + '" is inside a protected sensitive directory ' +
    '(.ssh, .gnupg, .aws, etc.) and cannot be accessed by the sandbox. ' +
    'This restriction is permanent and cannot be overridden.'
  );
  err.code = 'SENSITIVE_PATH_DENIED';
  return err;
}

module.exports = {
  SENSITIVE_DIRS: SENSITIVE_DIRS,
  isSensitivePath: isSensitivePath,
  throwSensitiveDenied: throwSensitiveDenied,
};
```

**Commit:** `feat(sandbox): add standalone sandbox-sensitive.js module`

---

### Task 4: sandbox-fs-hooks.js — 最小改动，前置敏感路径检查

**Files:**
- Modify: `appcontainer/sandbox-fs-hooks.js`

在 `install(fsMod)` 函数开头引入 `sandbox-sensitive.js`，在每个 write/read hook 的 `shouldBlockWrite`/`shouldBlockRead` 检查**之前**先检查 `isSensitivePath`：

```javascript
var sensitive = require(path.join(__dirname, 'sandbox-sensitive.js'));

// 在每个 hook 中，现有的 shouldBlockWrite 检查前添加：
if (sensitive.isSensitivePath(file)) { throw sensitive.throwSensitiveDenied(file); }
```

**改动量**：每个 hook 函数增加一行前置检查。不修改任何现有的 `shouldBlockWrite` / `shouldBlockRead` 逻辑。`sandbox-permission.js` 完全不改。

**Commit:** `feat(sandbox): wire sensitive path check into fs hooks`

---

### Task 5: sensitive-shield.ts — 新建独立 TS 模块

**Files:**
- Create: `desktop/src/sensitive-shield.ts`

**新建独立模块**，负责从 Electron 主进程侧编排 shield/unshield 操作。不直接操作 ACL，仅通过 CLI 调用 `AppContainerLauncher.exe`。

```typescript
/**
 * sensitive-shield.ts — Shield orchestration for sensitive paths.
 *
 * Standalone module. Does NOT import or depend on tool-sandbox.ts.
 * Communicates with AppContainerLauncher.exe via CLI commands.
 */
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Default sensitive subdirectories (relative to user home). */
export const DEFAULT_SENSITIVE_DIRS = [
    ".ssh", ".gnupg", ".aws", ".azure",
    path.join(".config", "gcloud"),
];

/**
 * Determine if a granted directory could contain sensitive paths
 * that need shielding. Returns true when granting home dir or
 * any ancestor of home.
 */
export function shouldShield(dir: string): boolean {
    const home = (process.env.USERPROFILE || "").toLowerCase();
    if (!home) return false;
    const norm = path.resolve(dir).toLowerCase();
    return norm === home || home.startsWith(norm + path.sep);
}

/**
 * Run shield on a directory after grant. Calls
 * `AppContainerLauncher.exe shield --name <name> --dir <dir>`.
 */
export async function shieldIfNeeded(
    launcherPath: string,
    containerName: string,
    dir: string,
): Promise<string[]> {
    if (!shouldShield(dir)) return [];
    const { stderr } = await execFileAsync(launcherPath, [
        "shield", "--name", containerName, "--dir", dir,
    ]);
    // Parse shielded paths from stderr output
    const shielded: string[] = [];
    for (const line of stderr.split("\n")) {
        const m = line.match(/Shielded sensitive dir: (.+)/);
        if (m) shielded.push(m[1].trim());
    }
    return shielded;
}

/**
 * Run unshield on known sensitive subdirectories before revoke.
 */
export async function unshieldIfNeeded(
    launcherPath: string,
    containerName: string,
    dir: string,
): Promise<void> {
    if (!shouldShield(dir)) return;
    const home = process.env.USERPROFILE || "";
    for (const rel of DEFAULT_SENSITIVE_DIRS) {
        const fullPath = path.join(home, rel);
        try {
            await execFileAsync(launcherPath, [
                "unshield", "--name", containerName, "--dir", fullPath,
            ]);
        } catch { /* non-fatal: dir may not exist */ }
    }
}

/**
 * Shield all known sensitive paths. Call during app startup
 * (after provisioning) to ensure protection is in place.
 */
export async function shieldAll(
    launcherPath: string,
    containerName: string,
): Promise<string[]> {
    const home = process.env.USERPROFILE;
    if (!home) return [];
    return shieldIfNeeded(launcherPath, containerName, home);
}
```

**Commit:** `feat(sandbox): add standalone sensitive-shield.ts module`

---

### Task 6: tool-sandbox.ts — 最小改动，接入 shield 模块

**Files:**
- Modify: `desktop/src/tool-sandbox.ts`

仅添加 import 和在三个 hook 点调用 `sensitive-shield.ts`：

**Hook 1 — grant 后自动 shield：**
```typescript
// In grantDirAsync(), after successful grant:
import { shieldIfNeeded } from "./sensitive-shield";
await shieldIfNeeded(this.launcherPath, this.containerName, dir);
```

**Hook 2 — revoke 前先 unshield：**
```typescript
// In revokeDirAsync(), before revoke:
import { unshieldIfNeeded } from "./sensitive-shield";
await unshieldIfNeeded(this.launcherPath, this.containerName, dir);
```

**Hook 3 — provision 后补 shield：**
```typescript
// In provisionAsync(), after all grants complete:
import { shieldAll } from "./sensitive-shield";
await shieldAll(this.launcherPath, this.containerName);
```

**改动量**：添加 1 个 import + 3 行函数调用。不添加任何逻辑到 `tool-sandbox.ts` 本身。

**Commit:** `feat(sandbox): wire sensitive-shield into tool-sandbox hook points`

---

### Task 7: Settings UI — 敏感路径排除清单

**Files:**
- Modify: `desktop/renderer/src/views/SettingsView.vue`（或对应的 sandbox 设置区域）

在 Sandbox 设置区域增加：
- 「敏感路径排除」列表（默认显示 `.ssh`、`.gnupg`、`.aws`、`.azure`、`.config/gcloud`）
- 用户可添加/删除自定义路径
- 存储到 `settings.sandboxShieldedDirs`
- 提供"重新 Shield"按钮，处理在 grant 之后新建的敏感目录

**Commit:** `feat(ui): add sensitive path exclusion list to sandbox settings`

---

### Task 8: 测试

**Files:**
- Create: `desktop/src/sensitive-shield.test.ts` — 独立测试 `sensitive-shield.ts`
- Create: `appcontainer/sandbox-sensitive.test.js` — 独立测试 `sandbox-sensitive.js`
- Modify: `desktop/src/sandbox-logic.test.ts` — 仅添加 tool-sandbox 集成点的调用顺序验证

**`sensitive-shield.test.ts`（独立测试）：**
- `shouldShield()` 对各种路径的判断（home dir、parent of home、unrelated dir）
- `DEFAULT_SENSITIVE_DIRS` 默认值验证
- `shieldIfNeeded()` 和 `unshieldIfNeeded()` 的 CLI 调用参数验证（mock execFile）

**`sandbox-sensitive.test.js`（独立测试）：**
- `isSensitivePath()` 正向匹配：`~/.ssh/id_rsa`、`~/.aws/credentials`、`~/.gnupg/secring.gpg`
- `isSensitivePath()` 反向匹配：`~/Documents`、`~/code/.ssh-keys`（不在 home 下的 .ssh）
- `throwSensitiveDenied()` 返回的 Error 包含 `code: 'SENSITIVE_PATH_DENIED'`
- 无副作用验证：确认 `isSensitivePath` 不触发任何 IPC、不修改任何状态

**`sandbox-logic.test.ts`（最小扩展）：**
- grant + shield 调用顺序验证
- revoke 前 unshield 调用顺序验证
- provision 后 shieldAll 调用验证

**Commit:** `test: add sensitive file shield unit tests`

---

## 优先级

| Phase | 任务 | 效果 |
|-------|------|------|
| **Phase 1** | Task 1-4, 8 | 核心保护：ACL Shield (C#) + Hook 硬拒绝 (JS)，两个独立新模块 |
| **Phase 1.5** | Task 5-6 | 接线：最小改动接入 tool-sandbox.ts，自动化 shield/unshield |
| **Phase 2** | Task 7 | 用户可视化配置 + 自定义路径 |

## 安全模型总结

```
敏感文件访问请求路径：

Node.js fs.*  →  sandbox-fs-hooks  →  sandbox-sensitive.isSensitivePath?
                                       →  YES  →  throwSensitiveDenied()（不弹窗、不走 permission）
                                       →  NO   →  正常走 shouldBlockWrite/Read → IPC 权限请求

Shell (type/cat)  →  OS 内核 →  ACL 检查 →  无 Container SID（被 shield 移除）→  Access Denied
```

**关键安全保证：**
1. 敏感路径在 OS 级别无 SID → shell 命令无法访问
2. 敏感路径在 Hook 级别硬拒绝 → Node.js fs.* 无法访问
3. 不弹出权限对话框 → 用户不会被误导授权
4. 不提供任何代理/中转 → 没有绕过路径
5. 外部工具（OpenSSH、GPG）ACL 干净 → 正常工作

## 注意事项

1. **幂等性**：多次 shield 同一目录不应出错（已断开继承时 `SetAccessRuleProtection` 是幂等的）
2. **顺序依赖**：必须先 `GrantAccess()` 再 `ShieldSensitivePaths()`，因为 shield 需要继承先传播下去才能断开。调用方（`tool-sandbox.ts` / CLI `--shield-sensitive`）负责保证顺序
3. **新建密钥**：用户在 grant 之后新建 `.ssh/` 目录时，该目录会自动继承父目录 ACE。`provisionAsync()` 每次启动时重新检测并 shield，Settings 中提供"重新 Shield"按钮
4. **不影响现有授权**：shield 只影响敏感子目录，父目录和其他子目录的权限不变
5. **错误消息**：`sandbox-sensitive.js` 返回带 `code: 'SENSITIVE_PATH_DENIED'` 的 Error，与普通权限拒绝 (`EACCES`) 区分，便于 Agent 识别
6. **现有模块零修改**：`ContainerManager.GrantAccess()`、`ContainerManager.RevokeAccess()`、`sandbox-permission.js` 完全不修改，降低回归风险
7. **独立可测**：`sandbox-sensitive.js` 和 `sensitive-shield.ts` 各自有独立测试文件，不依赖集成环境
