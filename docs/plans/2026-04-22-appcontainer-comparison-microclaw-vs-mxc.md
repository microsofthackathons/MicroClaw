# MicroClaw1P vs MXC — AppContainer 与权限管理全面对比分析

> 日期：2026-04-22  
> 范围：`C:\git2\MicroClaw1P` vs `C:\git2\mxc`

---

## 一、项目定位差异

| 维度 | **MicroClaw1P** | **MXC** |
|------|-----------------|---------|
| 语言 | TypeScript (Electron) + C# (Launcher) + JS (Hooks) | Rust (全栈) |
| 定位 | Agent 桌面应用（聊天 UI + 网关 + 工具执行） | 通用沙箱执行引擎（CLI 工具，可被上层调用） |
| 目标用户 | 终端用户（有 UI 交互） | 开发者/平台（JSON 配置驱动，无 UI） |
| 隔离粒度 | 单一 AppContainer，动态权限授予 | 多后端（AppContainer / BaseContainer / Windows Sandbox / WSL / LXC / MicroVM） |

---

## 二、AppContainer 实现对比

### 2.1 容器创建

| 方面 | **MicroClaw1P** | **MXC** |
|------|-----------------|---------|
| 创建方式 | C# 二进制 (`AppContainerLauncher.exe`)，通过 `CreateAppContainerProfile` | Rust 直接调用 Win32 API (`CreateAppContainerProfile` / `DeriveAppContainerSidFromAppContainerName`) |
| COMSPEC 拦截 | ✅ 设置 `COMSPEC=AppContainerLauncher.exe` 透明拦截所有 `child_process.exec()` | ❌ 不使用 COMSPEC；直接通过 `CreateProcessW` 在 AppContainer 中启动目标命令 |
| LPAC 支持 | ❌ 未实现 | ✅ `leastPrivilege: true` → `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` |
| 自定义 Capability | `internetClient` 等标准项 | 标准项 + 自定义 `AgenticAppContainer` 标记 |

**分析**：

- MicroClaw1P 的 **COMSPEC 拦截**设计非常巧妙——对 OpenClaw Gateway 零侵入，所有 `exec()` 调用自动沙箱化。缺点是仅拦截 shell 命令，无法拦截直接 `spawn()` 或 Node.js 原生 `fs` 操作。
- MXC 的**直接 CreateProcessW** 方式更彻底——目标进程从诞生起就在 AppContainer 内，没有逃逸窗口。但需要调用方显式使用 `wxc-exec`。

### 2.2 文件系统访问控制

| 方面 | **MicroClaw1P** | **MXC** |
|------|-----------------|---------|
| 机制 | **ACL + icacls**（直接修改 NTFS ACL） | **BFS (Broker File System)**（`bfscfg.exe` 策略注入） |
| 粒度 | RW / RO 两级 | RW / RO / Denied 三级 |
| 授权模式 | **动态交互式** — 运行时弹窗询问用户 | **声明式** — 执行前通过 JSON 配置声明 |
| 继承处理 | 手动设置祖先目录遍历权限 + 敏感目录断裂继承 | `--containerinherit` 参数控制子树继承 |
| 回滚 | `revoke` 命令逐条删除 ACL | 事务性回滚——任一路径失败则清理全部 |
| 敏感路径 | ✅ 硬编码保护 `.ssh`/`.gnupg`/`.aws`/`.azure`/`.config/gcloud` | ❌ 无内置敏感路径保护（依赖调用方配置 `deniedPaths`） |

**分析**：

- MicroClaw1P 的 **ACL 方式**简单直接，但修改 NTFS ACL 是重操作，可能需要 UAC 提权（`grantDirElevated`），且清理不完全会留下残余权限。
- MXC 的 **BFS 方式**是内核级策略代理，性能更好且更安全（不修改底层文件系统 ACL），但依赖 `bfscfg.exe` 外部工具。
- MicroClaw1P 的**敏感路径硬保护**是重要的安全特性——三层防护（ACL Shield + fs-hooks + cp-hooks），永不弹窗、永不可覆盖。MXC 缺少此类内置保护。

### 2.3 网络访问控制

| 方面 | **MicroClaw1P** | **MXC** |
|------|-----------------|---------|
| 机制 | 仅通过 Capability（`internetClient`） | Capability + Windows Firewall 规则 + 代理服务器 |
| 粒度 | 全有或全无 | 精确到 IP/CIDR/主机名 |
| 动态规则 | ❌ | ✅ `allowedHosts[]` / `blockedHosts[]` 精确控制 |
| 代理支持 | ❌ | ✅ 内置代理服务器 + 环境变量注入 |

**分析**：MXC 的网络控制远超 MicroClaw1P，支持 per-host 精确防火墙规则。MicroClaw1P 只有二值控制（有网/无网），无法满足"只允许访问 GitHub API"这类场景。

---

## 三、权限管理模型对比

### 3.1 MicroClaw1P — "交互式动态授权"

```
                  ┌─────────────────────┐
                  │   Agent 执行工具     │
                  └──────┬──────────────┘
                         │
            ┌────────────▼────────────────┐
            │  Layer 1: JS Pre-blocking   │  ← UX，可绕过
            │  (regex 路径提取 + 弹窗)    │
            └────────────┬────────────────┘
                         │
            ┌────────────▼────────────────┐
            │  Layer 2: AppContainer ACL  │  ← 安全边界
            │  (COMSPEC → Launcher.exe)   │
            └────────────┬────────────────┘
                         │ ACCESS_DENIED?
            ┌────────────▼────────────────┐
            │  Layer 3: 异步恢复          │  ← UX
            │  (stderr 扫描 → 弹窗 → ACL)│
            └─────────────────────────────┘
```

**核心特点**：
- **用户在环路中** — 每次新目录访问都弹窗确认
- **渐进式授权** — 从无权限开始，逐步授予
- **TTL 缓存** — 已授权目录缓存，避免重复弹窗
- **审计轨迹** — `sandboxGrantHistory` 记录授权历史

### 3.2 MXC — "声明式预配置"

```
         ┌──────────────────────┐
         │  JSON 配置文件       │
         │  (paths, network,    │
         │   capabilities)      │
         └──────┬───────────────┘
                │
       ┌────────▼────────────────┐
       │  Setup Phase            │
       │  BFS + Firewall + SIDs  │
       └────────┬────────────────┘
                │
       ┌────────▼────────────────┐
       │  CreateProcessW         │
       │  (AppContainer Token)   │
       └────────┬────────────────┘
                │
       ┌────────▼────────────────┐
       │  Teardown               │
       │  (BFS clear + FW clear) │
       └─────────────────────────┘
```

**核心特点**：
- **零交互** — 所有权限在执行前声明
- **事务性** — 设置失败自动回滚
- **一次性** — 每次执行独立，默认执行后清理
- **可组合** — JSON 配置可编程生成

---

## 四、安全保障对比

| 安全属性 | **MicroClaw1P** | **MXC** |
|---------|-----------------|---------|
| **安全边界** | AppContainer ACL（OS 内核） | AppContainer Token + BFS Broker（OS 内核） |
| **最小权限** | ❌ 无 LPAC | ✅ LPAC 支持 |
| **凭证保护** | ✅ 三层硬保护（ACL + fs-hooks + cp-hooks） | ❌ 无内置保护 |
| **Panic 安全** | ❌ JS 层无 catch；C# 有 try/catch | ✅ Rust `catch_unwind` + RAII |
| **资源泄漏防护** | ⚠️ C# using/IDisposable，但 JS 层依赖手动清理 | ✅ 全面 RAII guards（SID、Handle、AttrList） |
| **事务回滚** | ⚠️ ACL 操作非事务性 | ✅ BFS 策略事务回滚 |
| **进程超时** | ✅ 通过 Gateway 管理 | ✅ `WaitForSingleObject` + `TerminateProcess` |
| **UI 隔离** | ❌ 无 | ✅ BaseContainer 支持（剪贴板、注入、桌面隔离） |
| **VM 级隔离** | ❌ 无 | ✅ Windows Sandbox + BaseContainer (Hyper-V) |

---

## 五、关键实现细节

### 5.1 MicroClaw1P — 沙箱 Hook 架构

**入口**：`appcontainer/sandbox-preload.js`（通过 `NODE_OPTIONS="--require <path>"` 加载）

| 模块 | 职责 |
|------|------|
| `sandbox-preload.js` | 入口，注册所有 hooks |
| `sandbox-cp-hooks.js` | 拦截 `child_process`，正则提取路径，Pre-blocking 弹窗 |
| `sandbox-fs-hooks.js` | 拦截 30+ `fs` 方法，检查路径权限 |
| `sandbox-permission.js` | TTL 缓存 + IPC 权限请求 + 响应文件轮询 |
| `sandbox-sensitive.js` | 硬编码凭证目录保护（永不弹窗，永不可覆盖） |
| `sandbox-state.js` | 共享状态：安全路径、目录列表、白名单 |
| `path-extraction.js` | Shell 命令路径提取正则（PowerShell / cmd / Python / .NET） |

**安全命令白名单**（跳过沙箱，无性能损耗）：`ping`、`hostname`、`whoami`、`ipconfig` 等诊断工具。

**外部应用白名单**（跳过 AppContainer，需 COM/RPC/Named Pipe 访问）：`outlook`、`excel`、`word`、`powerpoint` 等 Office 应用。

### 5.2 MXC — Rust 执行流水线

**入口**：`wxc-exec` CLI (`src/wxc/src/main.rs`)

| 阶段 | 调用 | 说明 |
|------|------|------|
| 解析 | `Cli::parse()` | JSON / Base64 配置 |
| 验证 | `validate_request()` | 空脚本检查 |
| SID 创建 | `CreateAppContainerProfile` | 容器配置文件创建 |
| BFS 策略 | `FileSystemBfsManager.configure()` | 文件系统白名单/黑名单 |
| 网络策略 | `NetworkManager.start()` | 防火墙 + 代理 |
| 执行 | `CreateProcessW` | AppContainer Token 进程 |
| 等待 | `WaitForSingleObject` | 可超时强制终止 |
| 清理 | `stop_all()` + `remove_configuration()` | 防火墙 + BFS 回滚 |
| 释放 | Rust Drop traits | SID / Handle / AttrList RAII 清理 |

**RAII Guards**：
- `CapabilitySidGuard` — 能力 SID 指针释放
- `AttrListGuard` — 进程线程属性列表释放
- `OwnedHandle` / `SendOwnedHandle` — 跨线程 Handle 安全传输与释放
- `NetworkManager::Drop` — COM 反初始化 + WSA 清理

### 5.3 MXC — 多后端支持

| 后端 | 隔离级别 | 状态 | 适用场景 |
|------|---------|------|---------|
| **AppContainer** | 进程级 | 稳定 | 默认后端，轻量高效 |
| **BaseContainer** | Hyper-V | 实验性 (0.5+) | UI 隔离、剪贴板隔离 |
| **Windows Sandbox** | VM 快照 | 实验性 | 一次性隔离执行，自动清理 |
| **WSL Container** | Linux 容器 | 实验性 | Linux 工具链执行 |
| **LXC** | Linux 原生 | 稳定 (Linux) | 原生容器隔离 |
| **MicroVM** | Nanvix 微内核 | 实验性 | 超轻量 VM 隔离 |

---

## 六、MXC 配置示例

### 基本 AppContainer 执行
```json
{
  "version": "0.4.0-alpha",
  "containment": "appcontainer",
  "process": {
    "commandLine": "python -c \"print('Hello')\"",
    "timeout": 30000
  }
}
```

### 精确网络控制 + 文件系统隔离
```json
{
  "appContainer": {
    "capabilities": ["internetClient"],
    "leastPrivilege": true
  },
  "network": {
    "enforcementMode": "firewall",
    "defaultPolicy": "block",
    "allowedHosts": ["api.github.com", "140.82.121.0/24"]
  },
  "filesystem": {
    "readwritePaths": ["C:\\temp\\sandbox"],
    "readonlyPaths": ["C:\\Users\\user\\Documents"],
    "deniedPaths": ["C:\\Windows\\System32"]
  }
}
```

---

## 七、优劣势总结

### MicroClaw1P 优势

| 编号 | 优势 | 说明 |
|------|------|------|
| S1 | **用户体验** | 交互式权限弹窗，用户始终知道 Agent 在请求什么权限，可逐个审批 |
| S2 | **零侵入 COMSPEC 拦截** | 不需要修改 Gateway 代码，透明沙箱化 |
| S3 | **敏感凭证硬保护** | `.ssh`/`.gnupg`/`.aws` 等目录三层防护，永不可覆盖——关键安全差异化 |
| S4 | **异步恢复机制** | 即使 Pre-blocking 遗漏，Post-exec 检测仍能发现并恢复 |
| S5 | **渐进式信任** | 从零权限开始，用户逐步授予，最小化攻击面 |
| S6 | **审计历史** | `sandboxGrantHistory` 提供可追溯性 |

### MicroClaw1P 劣势

| 编号 | 劣势 | 说明 |
|------|------|------|
| W1 | **单一隔离后端** | 仅 AppContainer，无 VM 级或容器级隔离选项 |
| W2 | **网络控制粗糙** | 仅有/无网络二值控制，无精确 host/IP 防火墙规则 |
| W3 | **无 LPAC** | 未使用 Least Privilege AppContainer，权限基线偏高 |
| W4 | **ACL 操作非事务性** | `grant` 若中途失败，可能遗留部分 ACL 修改 |
| W5 | **JS 安全层可绕过** | 正则提取路径可被精心构造的命令绕过（虽有 OS 层兜底） |
| W6 | **资源清理依赖手动逻辑** | JS 层无 RAII，需显式清理；异常路径可能遗漏 |
| W7 | **无 `deniedPaths`** | 不能显式黑名单特定路径（敏感目录除外） |
| W8 | **无进程级超时强制终止** | 依赖 Gateway 管理，Launcher 无独立 `TerminateProcess` 逻辑 |

### MXC 优势

| 编号 | 优势 | 说明 |
|------|------|------|
| S1 | **多后端隔离** | 六种隔离后端，覆盖进程级到 VM 级 |
| S2 | **精确网络控制** | per-host 防火墙 + 代理服务器 |
| S3 | **Rust RAII 内存安全** | 零泄漏保障，panic 也能安全清理 |
| S4 | **事务性策略管理** | BFS 设置失败自动全量回滚 |
| S5 | **LPAC 支持** | 最小权限 AppContainer |
| S6 | **三级文件权限** | RW / RO / Denied 完整模型 |
| S7 | **声明式配置** | JSON 驱动，可编程、可复现、可版本化 |

### MXC 劣势

| 编号 | 劣势 | 说明 |
|------|------|------|
| W1 | **无内置凭证保护** | `.ssh`/`.gnupg` 等路径没有硬保护 |
| W2 | **无交互式授权** | 运行前必须声明所有权限，无法动态请求 |
| W3 | **无审计 UI** | 日志仅在内存/控制台，无持久化审计轨迹 |
| W4 | **依赖外部工具** | BFS 需要 `bfscfg.exe`，增加部署复杂度 |
| W5 | **无 Post-exec 恢复** | 权限不足导致失败时只能重新配置后重试 |

---

## 八、MicroClaw1P 可借鉴与改进建议

### 8.1 可从 MXC 借鉴的方面

| 编号 | 建议 | 优先级 | 复杂度 | 说明 |
|------|------|--------|--------|------|
| **B1** | **增加 LPAC 支持** | 🔴 高 | 低 | 在 `AppContainerLauncher.exe` 中添加 `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` 属性，进一步收紧权限基线 |
| **B2** | **增加精确网络控制** | 🔴 高 | 中 | 引入 Windows Firewall 规则，支持 `allowedHosts[]` / `blockedHosts[]`，替代简单的 `internetClient` 二值控制 |
| **B3** | **增加 `deniedPaths` 支持** | 🟡 中 | 低 | 除了内置敏感目录外，允许用户显式配置黑名单路径 |
| **B4** | **ACL 操作事务化** | 🟡 中 | 中 | 参考 MXC 的 BFS 回滚模式，在 `grant` 多个路径时任一失败则回滚已授予的权限 |
| **B5** | **增加进程超时强制终止** | 🟡 中 | 低 | 在 `AppContainerLauncher.exe` 中增加 `WaitForSingleObject` + `TerminateProcess` 逻辑 |
| **B6** | **考虑 BFS 替代 ACL** | 🟢 低 | 高 | BFS 是更轻量、更安全的文件系统隔离方式——不修改底层 ACL，减少残余权限风险。需评估 `bfscfg.exe` 可用性 |
| **B7** | **资源清理 RAII 化** | 🟡 中 | 中 | C# 层增加 `IDisposable` 覆盖所有 SID/Handle 资源；JS 层增加 `try/finally` 保障清理 |

### 8.2 MicroClaw1P 应保留的独有特色

| 编号 | 特色 | 说明 |
|------|------|------|
| **K1** | COMSPEC 透明拦截 | MXC 无此设计，零侵入方式非常适合 Agent 场景 |
| **K2** | 三层敏感凭证保护 | MXC 完全缺失，ACL Shield + fs-hooks + cp-hooks 是关键安全差异化 |
| **K3** | 交互式渐进授权 | Agent 场景下用户感知和控制力是核心需求 |
| **K4** | 异步恢复机制 | 防御纵深的重要环节，确保 Pre-blocking 遗漏后仍有兜底 |
| **K5** | 审计历史 | `sandboxGrantHistory` 提供可追溯性 |

### 8.3 自身可改进之处（非 MXC 借鉴）

| 编号 | 改进 | 说明 |
|------|------|------|
| **I1** | **权限弹窗超时自动拒绝** | 当前 60 秒超时，应确保超时后默认拒绝而非静默失败 |
| **I2** | **ACL 验证重试上限** | `verifyAclPropagation` 重试 3 次，应增加最大等待时间上限 |
| **I3** | **正则路径提取对抗性测试** | `path-extraction.js` 的正则可被绕过，应增加 Unicode 路径、UNC 路径、符号链接等测试用例 |
| **I4** | **权限一键撤销** | 提供"撤销所有已授权目录"的 UI 操作，而非逐个 revoke |
| **I5** | **沙箱状态持久化恢复** | Electron 崩溃重启后，应从 settings 恢复已授权目录列表，避免 ACL 孤儿 |

---

## 九、总结

两个项目针对**不同场景**做出了截然不同的设计选择：

- **MXC** 是一个**基础设施级**沙箱引擎，追求隔离强度和多后端支持，以声明式 JSON 配置驱动，适合平台/编排层使用。其 Rust 实现提供了出色的内存安全和资源管理保障。

- **MicroClaw1P** 是一个**面向用户的** Agent 应用，追求用户可控性和渐进式信任，以交互式弹窗驱动权限授予。其 COMSPEC 拦截和敏感凭证硬保护是独特优势。

**最高优先级改进建议**：

1. **B1 — 增加 LPAC 支持**（高优先级 / 低复杂度）：投入产出比最高，仅需在 C# Launcher 中添加一个进程属性即可显著收紧权限基线。
2. **B2 — 精确网络控制**（高优先级 / 中复杂度）：引入 Windows Firewall per-host 规则，解决当前"全有全无"的网络控制短板。

这两项改进能显著提升安全基线，且不破坏现有的交互式授权模式。
