# MSIX + AppContainer 沙箱方案研究

> 日期: 2026-03-25
> 状态: **已实现 — Gateway 在 AppContainer 中运行成功**

## 1. 背景

当前 MicroClaw 使用 **Sandboxie-Plus** 做进程沙箱隔离:
- 需要安装第三方软件 (Sandboxie-Plus v1.17.2, ~80MB)
- 通过 `SbieIni.exe` CLI 管理访问规则 (rw/r/deny)
- 独立的 permissions-manager Electron 应用管理规则
- 规则基于目录级的文件系统访问控制

**目标**: 评估用 Windows 原生 **MSIX + AppContainer** 替代 Sandboxie, 实现零第三方依赖的沙箱隔离。

---

## 2. AppContainer 核心概念

### 2.1 什么是 AppContainer

AppContainer 是 Windows 8+ 内置的进程隔离机制, 最初为 UWP/Store 应用设计:

- **默认拒绝**: AppContainer 进程默认无权访问几乎所有用户资源
- **能力声明**: 必须在 manifest 中显式声明所需能力 (Capabilities)
- **强制完整性级别**: AppContainer 以 Low Integrity Level 运行
- **令牌隔离**: 每个 AppContainer 有唯一 SID, 与其他 AppContainer 和桌面应用完全隔离
- **网络隔离**: 默认无网络访问, 需声明 `internetClient` 能力

### 2.2 MSIX 如何启用 AppContainer

MSIX 是 Windows 的现代打包格式:
- 打包为 `.msix` 或 `.msixbundle`
- 安装到 `C:\Program Files\WindowsApps\<PackageFamilyName>\`
- 自动获得 AppContainer 令牌 (Package Identity → AppContainer SID)
- 每个 app 有独立的虚拟化文件系统和注册表

### 2.3 与 Sandboxie 的关键差异

| 特性 | Sandboxie | AppContainer (MSIX) |
|------|-----------|---------------------|
| 隔离层级 | 内核驱动 (重量级) | 内核令牌 (轻量级, OS 原生) |
| 安装要求 | 第三方软件 | Windows 10+ 内置 |
| 规则模型 | 目录级 rw/r/deny | 能力声明 + 文件访问 broker |
| 网络 | 全放行 (默认) | 默认隔离, 需声明 |
| 注册表 | 虚拟化 | 虚拟化 (Package 私有) |
| 文件系统 | 规则控制 | 默认只能访问 Package 目录 + 声明的位置 |
| Loopback 网络 | 允许 | 默认禁止, 需 exemption |
| 子进程继承 | 沙箱内 spawn 自动继承 | AppContainer 令牌自动继承 |

---

## 3. MicroClaw 的架构适配分析

### 3.1 当前进程模型

```
MicroClawDesktop.exe (Electron)
  └─ node.exe openclaw.mjs gateway run --port 18789  (子进程)
       └─ 各种 skill 子进程 (Python scripts, Node scripts, etc.)
```

所有进程都在同一个 Sandboxie box ("MicroClaw") 内运行。

### 3.2 AppContainer 下的进程模型

**MSIX 打包后, 主进程和所有子进程自动继承 AppContainer 令牌。**

这意味着:
- Electron 主进程 → AppContainer
- node.exe gateway → AppContainer (继承)
- skill 子进程 → AppContainer (继承)

✅ **好消息**: 不需要手动给每个子进程设置 AppContainer, 令牌自动继承。

### 3.3 需要解决的关键问题

#### 问题 1: Loopback 网络

AppContainer **默认禁止 loopback** (localhost) 访问。MicroClaw 的核心通信是:

```
Electron ←→ WebSocket localhost:18789 ←→ Gateway
```

**解决方案**:
- **开发阶段**: 使用 `checknetisolation LoopbackExempt -a -n=<PackageFamilyName>` 添加豁免
- **生产阶段**: 在 AppxManifest 声明 `<uap4:LoopbackAccessRules>`:
  ```xml
  <uap4:LoopbackAccessRules>
    <uap4:Rule Direction="out" />
  </uap4:LoopbackAccessRules>
  ```
- **或者**: 使用具名管道 (Named Pipes) 替代 TCP loopback, 但改动较大

#### 问题 2: 文件系统访问

AppContainer 默认只能访问:
- 自己的 Package 目录 (`Windows.ApplicationModel.Package.Current.InstalledLocation`)
- 应用本地数据: `%LocalAppData%\Packages\<PackageFamilyName>\LocalCache\`
- 用户通过 File Picker (broker) 授权的文件

**MicroClaw 需要访问的路径**:

| 路径 | 当前位置 | AppContainer 方案 |
|------|----------|-------------------|
| Node.js + openclaw | `~/.openclaw-node/` | 打包到 MSIX 的 VFS 中, 或放在 LocalCache |
| 配置 / 状态 | `~/.openclaw/` | 迁移到 `LocalCache/openclaw/` |
| Skills | `~/.openclaw/skills/` (managed) | 迁移到 `LocalCache/skills/` |
| 设备密钥 | `~/.openclaw/device-identity.json` | 迁移到 `LocalCache/` |
| Desktop / Downloads | 用户选择 | 通过 BrokerFilesystem 或 broadFileSystemAccess 能力 |

**关键能力声明**:
```xml
<Capabilities>
  <Capability Name="internetClient" />
  <rescap:Capability Name="broadFileSystemAccess" />
</Capabilities>
```

> ⚠️ `broadFileSystemAccess` 是受限能力 (restricted capability), 上架 Microsoft Store 需要审核。
> 如果不需要上架 Store, 可以 sideload 使用。

#### 问题 3: 注册表访问

Gateway / Skills 通常不需要注册表访问。AppContainer 提供虚拟化注册表, MicroClaw 的注册表需求极少, 这不是障碍。

#### 问题 4: 子进程 spawn

Electron 通过 `child_process.spawn()` 启动 `node.exe` (gateway)。在 MSIX/AppContainer 下:

- ✅ 子进程自动继承 AppContainer 令牌
- ✅ `node.exe` 可以打包在 MSIX 的 VFS 层
- ⚠️ 需要确保 `node.exe` 的路径引用正确 (MSIX 安装路径 vs 原来的 `~/.openclaw-node/`)

#### 问题 5: PATH 和环境变量

MSIX 应用有自己的虚拟环境:
- MSIX 提供 Virtual File System (VFS), 可以将文件映射到标准路径
- 可以在 AppxManifest 中声明 PATH 扩展
- `%LOCALAPPDATA%` 自动重定向到 Package 私有目录

#### 问题 6: Electron + MSIX 兼容性

Electron 官方支持 MSIX 打包:
- `electron-builder` 支持 `appx` target (生成 `.appx`/`.msix`)
- 需要 Windows SDK (用于 `makeappx.exe` 和 `signtool.exe`)
- 需要证书签名 (开发阶段可用自签名证书)

---

## 4. 实施方案

### 4.1 Phase 1: MSIX 打包 (不使用 Store)

#### 4.1.1 修改 electron-builder.yml

```yaml
appId: ai.openclaw.microclaw
productName: MicroClawDesktop
copyright: Copyright © 2026 MicroClaw

directories:
  output: release

win:
  target:
    - target: appx
      arch: [x64]

appx:
  identityName: "OpenClaw.MicroClaw"
  publisher: "CN=MicroClaw Dev, O=MicroClaw, C=CN"
  publisherDisplayName: "MicroClaw"
  applicationId: "MicroClawDesktop"
  displayName: "MicroClaw Desktop"
  languages: ["zh-CN", "en-US"]
  showNameOnTiles: true
  backgroundColor: "#1e1e2e"

extraResources:
  - from: resources/node.exe
    to: node.exe
  - from: resources/openclaw/
    to: openclaw/

files:
  - dist/**/*
  - renderer/dist/**/*
  - assets/**/*
```

#### 4.1.2 创建 AppxManifest 覆盖 (可选细粒度控制)

electron-builder 会自动生成 AppxManifest.xml, 但如果需要额外能力声明, 可以提供自定义模板:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap4="http://schemas.microsoft.com/appx/manifest/uap/windows10/4"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap4 rescap">

  <Identity
    Name="OpenClaw.MicroClaw"
    Publisher="CN=MicroClaw Dev"
    Version="1.0.0.0"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>MicroClaw Desktop</DisplayName>
    <PublisherDisplayName>MicroClaw</PublisherDisplayName>
    <Description>MicroClaw AI Agent Desktop</Description>
    <Logo>assets\microclaw-44x44.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop"
                        MinVersion="10.0.17763.0"
                        MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="zh-CN" />
    <Resource Language="en-US" />
  </Resources>

  <Applications>
    <Application Id="MicroClawDesktop"
                 Executable="MicroClawDesktop.exe"
                 EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="MicroClaw"
        Description="MicroClaw AI Agent"
        BackgroundColor="#1e1e2e"
        Square150x150Logo="assets\microclaw-150x150.png"
        Square44x44Logo="assets\microclaw-44x44.png" />
    </Application>
  </Applications>

  <Capabilities>
    <!-- 网络访问 (出站) -->
    <Capability Name="internetClient" />

    <!-- Loopback 访问 (gateway WebSocket) -->
    <!-- 注意: uap4:LoopbackAccessRules 需要 Windows 10 1809+ -->

    <!-- 广泛文件系统访问 (受限能力, sideload 可用) -->
    <rescap:Capability Name="broadFileSystemAccess" />

    <!-- 如果不用 broadFileSystemAccess, 可以用更细粒度的: -->
    <!-- <uap:Capability Name="documentsLibrary" /> -->
    <!-- <uap:Capability Name="picturesLibrary" /> -->
    <!-- <uap:Capability Name="videosLibrary" /> -->
  </Capabilities>

</Package>
```

#### 4.1.3 关于 `runFullTrust` vs 纯 AppContainer

**重要抉择**:

MSIX 打包的桌面应用有两种运行模式:

| 模式 | 隔离级别 | 说明 |
|------|----------|------|
| **Full Trust + Package Identity** | 中等 | 保留桌面应用权限, 但有 Package Identity (可用 Windows 通知等) |
| **AppContainer (真正隔离)** | 强 | 和 UWP 一样的沙箱, 默认无权访问文件系统 |

`EntryPoint="Windows.FullTrustApplication"` = Full Trust 模式, **不是真正的 AppContainer 沙箱**。

要获得 **真正的 AppContainer 隔离**, 需要:

**方案 A: 使用 Desktop Bridge (centennial) + AppContainer capability**

在 AppxManifest 中声明:
```xml
<Application Id="MicroClawDesktop"
             Executable="MicroClawDesktop.exe"
             EntryPoint="Windows.FullTrustApplication"
             desktop4:SupportsMultipleInstances="false"
             uap10:TrustLevel="appContainer"
             uap10:RuntimeBehavior="packagedClassicApp">
```

> `uap10:TrustLevel="appContainer"` 是关键。这会让桌面应用 (Win32/Electron) 以 AppContainer 模式运行。
> 需要 Windows 10 2004+ (build 19041+)。

**方案 B: 手动创建 AppContainer 令牌启动子进程**

保持 Electron 主进程 Full Trust, 但用 Windows API 创建 AppContainer 并在其中启动 gateway:

```
MicroClawDesktop.exe (Full Trust, 非 AppContainer)
  └─ CreateProcess (as AppContainer)
       └─ node.exe gateway run  (AppContainer 内)
            └─ skill 子进程 (继承 AppContainer)
```

这种方式更灵活:
- UI 进程保持完整权限 (方便创建窗口、系统托盘、快捷键等)
- 仅 gateway + skills 在 AppContainer 沙箱中
- 更接近当前 Sandboxie 的隔离模型 (只隔离 AI 执行部分)

---

### 4.2 推荐方案: 方案 B — 混合模式

**理由**:
1. 更接近当前架构 (Electron 在外, gateway 在沙箱内)
2. 不需要 MSIX 签名/安装的复杂流程 (至少第一阶段)
3. 可以比 Sandboxie 更灵活地控制权限
4. 不依赖第三方软件

#### 4.2.1 实现简图

```
┌─────────────────────────────────────────────┐
│  MicroClawDesktop.exe (Electron, Full Trust) │
│                                              │
│  ┌─────────────────────────────────┐         │
│  │  gateway-manager.ts             │         │
│  │  spawn → CreateAppContainer()   │──────┐  │
│  │         + CreateProcess()       │      │  │
│  └─────────────────────────────────┘      │  │
│                                            │  │
│  WebSocket ←→ localhost:18789             │  │
└────────────────────────────────────┬───────┘  │
                                     │          │
                    ┌────────────────▼──────────▼──┐
                    │  AppContainer "MicroClaw"     │
                    │                               │
                    │  node.exe gateway run         │
                    │    └─ skill 子进程            │
                    │                               │
                    │  可访问:                      │
                    │  - Package 数据目录            │
                    │  - 声明的 Capabilities         │
                    │  - Loopback (需豁免)           │
                    │                               │
                    │  不可访问:                     │
                    │  - 用户文件 (除非 broker 授权) │
                    │  - 注册表                      │
                    │  - 其他进程                    │
                    └───────────────────────────────┘
```

#### 4.2.2 Win32 API 调用 (通过 N-API / FFI)

创建 AppContainer 需要调用 Windows API:

```c
// 1. 创建 AppContainer Profile
HRESULT CreateAppContainerProfile(
    PCWSTR pszAppContainerName,   // "MicroClaw"
    PCWSTR pszDisplayName,        // "MicroClaw Gateway"
    PCWSTR pszDescription,        // "Sandboxed AI agent gateway"
    PSID_AND_ATTRIBUTES pCapabilities, // 能力列表
    DWORD dwCapabilityCount,
    PSID *ppSidAppContainerSid   // 输出: AppContainer SID
);

// 2. 用 AppContainer 令牌启动进程
BOOL CreateProcess(
    ...,
    STARTUPINFOEX si  // si.lpAttributeList 包含:
                      //   PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
                      //     → SecurityCapabilities.AppContainerSid
);
```

**Node.js 实现方式**:

1. **方式 A**: 编写 C++ N-API addon (最可靠)
2. **方式 B**: 使用 `node-ffi-napi` (纯 JS 调用 Win32 API)
3. **方式 C**: 编写一个小的 C++/C# launcher.exe, Electron 调用它来启动沙箱进程

推荐 **方式 C**, 因为:
- 不需要在 Electron 主进程引入 native addon 的编译复杂性
- C# 实现最简洁 (P/Invoke)
- 可以作为独立可执行文件测试

#### 4.2.3 C# Launcher 实现草案

```csharp
// AppContainerLauncher.exe
// 用法: AppContainerLauncher.exe --name MicroClaw
//         --exe "C:\path\to\node.exe"
//         --args "openclaw.mjs gateway run --port 18789"
//         --capability internetClient
//         --allow-dir "C:\Users\xxx\.openclaw"
//         --allow-dir "C:\Users\xxx\Downloads"

using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

class Program
{
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        IntPtr capabilities,    // PSID_AND_ATTRIBUTES
        uint capabilityCount,
        out IntPtr sidPtr);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out IntPtr sidPtr);

    // 主要步骤:
    // 1. CreateAppContainerProfile("MicroClaw", ...)
    // 2. 为沙箱目录设置 ACL (允许 AppContainer SID 访问)
    // 3. CreateProcess with SECURITY_CAPABILITIES
    // 4. 等待进程退出
    // 5. (可选) DeleteAppContainerProfile
}
```

#### 4.2.4 文件系统 ACL 配置

AppContainer 通过 **DACL** (Discretionary Access Control List) 控制文件访问:

```csharp
// 为指定目录添加 AppContainer SID 的访问权限
void GrantAccess(string directoryPath, SecurityIdentifier appContainerSid,
                 FileSystemRights rights)
{
    var dirInfo = new DirectoryInfo(directoryPath);
    var security = dirInfo.GetAccessControl();
    security.AddAccessRule(new FileSystemAccessRule(
        appContainerSid,
        rights,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None,
        AccessControlType.Allow));
    dirInfo.SetAccessControl(security);
}
```

**需要设置 ACL 的目录**:

| 目录 | 权限 | 说明 |
|------|------|------|
| `~/.openclaw/` | ReadWrite | 配置、状态、日志 |
| `~/.openclaw-node/` | ReadOnly | Node.js + openclaw (只需执行) |
| `~/.openclaw/skills/` | ReadWrite | 托管技能 |
| 用户授权目录 | ReadWrite | 用户通过 permissions manager 添加 |
| `%TEMP%\openclaw\` | ReadWrite | 临时文件 |

这等效于当前 Sandboxie 的 `OpenFilePath`/`ReadFilePath`/`ClosedFilePath` 规则模型。

#### 4.2.5 Loopback 网络

AppContainer 默认禁止 loopback。有两种解法:

1. **运行时豁免** (推荐, 不需要管理员权限):
   ```powershell
   # 查询 AppContainer SID
   checknetisolation LoopbackExempt -a -p=S-1-15-2-...
   ```

2. **代码方式** (在 launcher 中调用):
   ```csharp
   [DllImport("api-ms-win-net-isolation-l1-1-0.dll")]
   static extern uint NetworkIsolationSetAppContainerConfig(
       uint dwNumPublicAppCs,
       SID_AND_ATTRIBUTES[] appContainerSids);
   ```

3. **Named Pipe 替代**: 将 `localhost:18789` 改为 Named Pipe
   - 需要修改 gateway 和 Electron 的通信协议
   - AppContainer 可以访问具名管道 (需设置 ACL)
   - 改动较大, 不推荐第一阶段

---

### 4.3 Phase 2: MSIX 打包 (完整方案)

如果后续需要完整的 MSIX 分发, 可以在 Phase 1 基础上:

1. 用 `electron-builder` 生成 `.appx` 包
2. 或用 MSIX Packaging Tool 将 Phase 1 的可执行文件打包
3. 添加 AppxManifest 声明所有需要的 Capabilities
4. 配置 `uap10:TrustLevel="appContainer"` 让整个包在 AppContainer 中运行
5. 自签名证书用于 sideload, 企业证书用于内部分发

#### 4.3.1 签名要求

| 场景 | 签名要求 |
|------|----------|
| 开发/测试 | 自签名证书, 需手动安装到 "Trusted People" |
| 企业内部 sideload | 企业 CA 签名, 或 App Installer + sideload 策略 |
| Microsoft Store | Microsoft 签名, 需审核 |

开发阶段创建自签名证书:
```powershell
# 创建测试证书
New-SelfSignedCertificate -Type Custom `
  -Subject "CN=MicroClaw Dev, O=MicroClaw, C=CN" `
  -KeyUsage DigitalSignature `
  -FriendlyName "MicroClaw Dev Cert" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3",
                    "2.5.29.19={text}")
```

---

## 5. 代码修改清单

### 5.1 新增文件

| 文件 | 说明 |
|------|------|
| `appcontainer/AppContainerLauncher.csproj` | C# launcher 项目 |
| `appcontainer/Program.cs` | AppContainer 创建 + 进程启动逻辑 |
| `appcontainer/AclManager.cs` | 文件系统 ACL 管理 |
| `desktop/src/appcontainer-manager.ts` | 替代/补充 sandbox-config.ts |

### 5.2 修改文件

| 文件 | 修改 |
|------|------|
| `desktop/src/gateway-manager.ts` | spawn 改为调用 AppContainerLauncher.exe |
| `desktop/electron-builder.yml` | 添加 appx target + AppContainerLauncher.exe 资源 |
| `deployer/windows_setup.py` | AppContainer 方案的安装步骤 (替代 Sandboxie) |
| `permissions-manager/src/sandbox-config.ts` | ACL 管理替代 SbieIni 管理 |
| `build.ps1` | 添加 C# launcher 编译步骤 |

### 5.3 可删除/可选

| 文件 | 说明 |
|------|------|
| `Sandbox/Sandboxie-Plus-x64-v1.17.2.exe` | 不再需要 Sandboxie |
| Sandboxie 相关安装逻辑 | deploy.py 中的 Sandboxie checkbox + 安装步骤 |

---

## 6. 实施路线图

### Phase 1: AppContainer Launcher MVP (推荐先做)

1. **编写 C# AppContainerLauncher.exe**
   - 创建/管理 AppContainer profile
   - 设置目录 ACL
   - 在 AppContainer 中启动 node.exe gateway
   - 配置 loopback 豁免
   - 等待进程退出, 传递 exit code

2. **修改 gateway-manager.ts**
   - 检测 AppContainer launcher 是否可用
   - 如果可用, 通过 launcher 启动 gateway
   - 保持 fallback 到直接 spawn (向后兼容)

3. **修改 permissions-manager**
   - 新增 `appcontainer-config.ts`
   - 通过 ACL 管理目录访问权限 (替代 SbieIni)
   - UI 保持不变 (目录列表 + rw/r/deny)

4. **测试验证**
   - 验证 gateway 能正常启动和通信
   - 验证 skills 能正常执行
   - 验证文件访问隔离有效
   - 验证网络隔离有效

### Phase 2: MSIX 打包 (后续)

1. 配置 electron-builder appx target
2. 创建 AppxManifest 模板
3. 自签名证书 + sideload 流程
4. 更新部署脚本

### Phase 3: 精细化 (后续)

1. 可配置的 Capability 集 (参考 Sandboxie 规则模型)
2. 运行时 ACL 动态修改 (不需重启 gateway)
3. 审计日志 (哪些访问被拒绝)
4. 备选: Windows Sandbox API (Windows 11 24H2+)

---

## 7. 技术风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Loopback 访问受限 | Gateway 通信失败 | 使用 checknetisolation 豁免或 Named Pipe |
| node.exe 在 AppContainer 内行为异常 | Gateway 崩溃 | 充分测试, 检查 node 依赖的 Win32 API |
| ACL 设置需要适当权限 | 安装失败 | Launcher 以普通用户运行, ACL 设置在安装时做 |
| Skills 需要访问未授权路径 | Skill 执行失败 | 提供清晰的错误信息 + 权限管理 UI |
| 某些 npm 包使用 native addon | 编译/加载失败 | 测试主要 skills 的兼容性 |
| Windows 版本要求 | 旧系统不支持 | 最低要求 Windows 10 2004 (build 19041) |
| AppContainer 无法运行特权操作 | 某些 skill 功能受限 | 通过 broker 或 out-of-sandbox helper 处理 |

---

## 8. 与当前 Sandboxie 方案的迁移策略

保持 **兼容期**:

1. 安装时提供选择: Sandboxie / AppContainer / 无沙箱
2. AppContainer 方案检测 Windows 版本 ≥ 19041
3. 低版本 Windows 降级到 Sandboxie
4. 两种方案共用 permissions-manager UI (后端切换)

```typescript
// desktop/src/sandbox-backend.ts
export interface SandboxBackend {
  isAvailable(): Promise<boolean>;
  start(exe: string, args: string[]): Promise<ChildProcess>;
  setDirectoryAccess(dir: string, level: 'rw' | 'r' | 'deny'): Promise<void>;
  removeDirectoryAccess(dir: string): Promise<void>;
  listRules(): Promise<DirectoryRule[]>;
}

export class SandboxieBackend implements SandboxBackend { ... }
export class AppContainerBackend implements SandboxBackend { ... }
export class NullBackend implements SandboxBackend { ... }  // 无沙箱
```

---

## 9. 快速验证方案 (PoC)

不写任何代码, 快速验证 AppContainer 方案是否可行:

### 步骤 1: 手动创建 AppContainer 并运行 node.exe

```powershell
# 使用 PowerShell + C# interop 快速测试
# 需要以管理员身份运行

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AppContainer {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr sidPtr);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out IntPtr sidPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool ConvertSidToStringSid(
        IntPtr sid,
        out string stringSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(
        string appContainerName);
}
"@

# 创建 AppContainer
$sid = [IntPtr]::Zero
$hr = [AppContainer]::CreateAppContainerProfile(
    "MicroClawTest",
    "MicroClaw Test Container",
    "Testing AppContainer for MicroClaw gateway",
    [IntPtr]::Zero, 0,
    [ref]$sid)

if ($hr -eq 0) {
    $sidStr = ""
    [AppContainer]::ConvertSidToStringSid($sid, [ref]$sidStr)
    Write-Host "AppContainer SID: $sidStr"
} elseif ($hr -eq -2147024713) {  # HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
    Write-Host "AppContainer already exists, deriving SID..."
    [AppContainer]::DeriveAppContainerSidFromAppContainerName(
        "MicroClawTest", [ref]$sid)
    $sidStr = ""
    [AppContainer]::ConvertSidToStringSid($sid, [ref]$sidStr)
    Write-Host "AppContainer SID: $sidStr"
}

# 为目录设置 ACL
$acl = Get-Acl "$env:USERPROFILE\.openclaw"
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    (New-Object System.Security.Principal.SecurityIdentifier($sidStr)),
    "FullControl",
    "ContainerInherit,ObjectInherit",
    "None",
    "Allow")
$acl.AddAccessRule($rule)
Set-Acl "$env:USERPROFILE\.openclaw" $acl

Write-Host "ACL set. Now use a tool like RunInAppContainer to test."
```

### 步骤 2: 使用开源工具测试

可以用 [appjaillauncher-rs](https://github.com/nicecoolwinter/appjaillauncher-rs) 或者自行编写小工具启动进程。

### 步骤 3: 验证 loopback

```powershell
checknetisolation LoopbackExempt -a -p=$sidStr
# 然后在 AppContainer 内测试 localhost 连接
```

---

## 10. 总结

| 维度 | 建议 |
|------|------|
| **推荐方案** | Phase 1: 方案 B (混合模式), Electron 外 + Gateway 内 AppContainer |
| **实现语言** | C# (.NET) 的 launcher 最简洁; 备选 C++/Rust |
| **最低 Windows** | Windows 10 Version 2004 (Build 19041) |
| **与 Sandboxie 共存** | 是, 通过 SandboxBackend 接口抽象 |
| **需要管理员权限** | 创建 AppContainer profile: 否; 设置 ACL: 否 (用户自己的目录); loopback 豁免: 是 (首次) |
| **预计 Phase 1 工作量** | C# launcher + gateway-manager 修改 + 基本测试 |

---

## 11. PoC 验证结果 (2026-03-25 实测)

### 11.1 已实现的 AppContainerLauncher

位于 `appcontainer/` 目录, .NET 9 C# 项目, 支持以下命令:

| 命令 | 说明 |
|------|------|
| `check` | 检测 OS 是否支持 AppContainer |
| `sid --name NAME` | 获取/创建 AppContainer profile |
| `run --name NAME --exe PATH [--cap CAP]... [--workdir DIR] [--] args` | 在 AppContainer 中运行进程 |
| `grant --name NAME --dir PATH [--access rw\|r]` | 授予目录访问 ACL |
| `revoke --name NAME --dir PATH` | 撤销目录访问 |
| `setup --name NAME` | (需管理员) 设置 C:\ 和 C:\Users 的 traverse ACL |
| `loopback --name NAME [--remove]` | 管理 loopback 网络豁免 |
| `delete --name NAME` | 删除 AppContainer profile |

### 11.2 测试结果

#### ✅ 已验证成功

| 测试项 | 结果 | 说明 |
|--------|------|------|
| OS 支持检测 | PASS | Build 26200, 满足 ≥19041 要求 |
| AppContainer profile 创建 | PASS | SID: S-1-15-2-727953019-... |
| cmd.exe 在 AppContainer 内运行 | PASS | 输出正常 |
| Node.js v22 在 AppContainer 内运行 | PASS | `console.log` 正常输出 |
| 文件系统隔离 | PASS | 访问未授权目录 (Documents) → EPERM |
| 目录 ACL 授权 | PASS | grant rw 后可读写 |
| HTTP 服务器在 AppContainer 内监听 | PASS | node `http.createServer` 正常 listen |
| **出站 loopback 连接** | **PASS** | AppContainer → 外部 localhost 服务 ✅ |

#### ❌ 未通过 (需处理)

| 测试项 | 结果 | 原因 | 解决方案 |
|--------|------|------|----------|
| 入站 loopback 连接 | FAIL | AppContainer 阻止外部连接到内部监听端口 | **反转通信方向** (见 11.3) |
| Named Pipe 跨边界 | FAIL | 同上, AppContainer 阻止入站连接 | 同上 |
| 加载 .js 文件 | FAIL | Node `realpathSync` 遍历到 `C:\`, 被 EPERM | 需管理员运行 `setup` 命令设置 C:\ ACL |

### 11.3 网络架构调整 — 反转通信方向

核心发现: **AppContainer 出站连接正常, 入站连接被阻止。** 即使添加了 loopback exemption (`checknetisolation`), 也无法从外部连接到 AppContainer 内的服务器。

**当前架构** (不可行):
```
Electron (外) ──WebSocket──→ Gateway:18789 (AppContainer 内, 监听)
                              ↑ 入站, 被阻止
```

**调整后架构** (可行):

**方案 A: 反转 WebSocket 方向**
```
Electron (外, 监听 :18789) ←──WebSocket──── Gateway (AppContainer 内, 连接出)
                               ↑ 出站, 允许
```
- Electron 启动 WebSocket 服务器
- Gateway 在 AppContainer 内启动后, 主动连接到 Electron
- 改动: gateway-client.ts 变成 gateway-server.ts

**方案 B: stdio IPC**
```
Electron (外)
  └─ AppContainerLauncher.exe
       └─ node.exe gateway  ←──stdin/stdout──→ Electron
```
- 通过 stdin/stdout 管道通信 (已由 launcher 继承)
- 不经过网络层, 完全无网络隔离问题
- 改动: gateway 通信协议从 WebSocket 改为 stdio JSON-RPC

**方案 C: 管理员首次设置 + 原架构**
```
(首次安装, 管理员权限)
  → checknetisolation LoopbackExempt -a  (未验证是否有效)
  → icacls C:\ /grant AppContainerSID:R  (已验证需管理员)

之后:
Electron (外) ──WebSocket──→ Gateway:18789 (AppContainer 内)
```
- 需要管理员权限做首次设置 (当前安装器已有 Sandboxie 安装步骤)
- 风险: loopback exemption 可能在管理员下仍不工作

**推荐: 方案 B (stdio IPC)**, 理由:
1. 零网络依赖, 完全绕过 AppContainer 网络隔离
2. 不需要管理员权限
3. 架构更简洁 (进程间直接通信)
4. 与当前 Electron spawn gateway 子进程的模型一致

### 11.4 文件加载问题的解决方案

Node.js 加载 `.js` 文件时, `realpathSync()` 遍历所有父目录直到驱动器根 (`C:\`), 需要每个目录的 `lstat` 权限。

**方案 1: 安装时管理员设置** (推荐)
```
AppContainerLauncher setup --name MicroClaw
```
- 为 `C:\` 和 `C:\Users` 添加最小权限 (ListDirectory + ReadAttributes)
- 安装器已有管理员步骤 (Defender 排除, PATH 修改等), 可复用

**方案 2: 环境变量 + -e 引导**
```
node -e "process.chdir('/path/to');require('./openclaw.mjs')"
```
- 不完全可靠, `require` 内部仍会 `realpathSync`

**方案 3: stdin 引导** (配合 stdio IPC 方案)
```
echo 'require("./openclaw.mjs")' | node --input-type=commonjs -
```
- 避免文件路径解析
- 但 ESM 模块可能不支持

### 11.5 结论

| 维度 | 可行性 |
|------|--------|
| **进程隔离** | ✅ 完全可行, 和 Sandboxie 等效 |
| **文件系统隔离** | ✅ 完全可行, ACL 模型更精细 |
| **网络通信** | ✅ inbound loopback 在 loopback exemption 下可用 |
| **文件路径解析** | ✅ `--preserve-symlinks` 绕过 `realpathSync`, 无需管理员 |
| **子进程继承** | ✅ 自动继承 AppContainer 令牌 |
| **Node.js 兼容性** | ✅ v22 正常运行 |

**总体结论: AppContainer 方案完全可行, 无需修改通信架构。**

---

## 12. 实现完成 (2026-03-25)

### 12.1 关键发现 — 11.x 中的问题全部解决

| 原始问题 | 最终解决方案 |
|----------|-------------|
| 入站 loopback 被阻止 | `checknetisolation LoopbackExempt -a` 对 "MicroClaw" 容器有效, 入站连接正常 |
| .js 文件加载 `EPERM: lstat 'C:\'` | `--preserve-symlinks --preserve-symlinks-main` 绕过 `realpathSync` |
| openclaw 尝试 respawn 被 EPERM | `OPENCLAW_NO_RESPAWN=1` 环境变量禁用 respawn |

### 12.2 验证: Gateway 在 AppContainer 中运行

```
$ AppContainerLauncher.exe run --name MicroClaw \
    --exe node.exe --workdir <openclaw-dir> --cap internetClient \
    -- --preserve-symlinks --preserve-symlinks-main openclaw.mjs \
    gateway run --port 18791 --bind loopback --force --allow-unconfigured

→ Gateway 监听 127.0.0.1:18791  ✅
→ 外部 TCP 连接成功              ✅
→ HTTP GET /health → 200 OK     ✅
→ {"ok":true,"status":"live"}    ✅
```

### 12.3 集成代码

| 文件 | 修改内容 |
|------|----------|
| `desktop/src/main.ts` | 新增 `resolveAppContainerLauncher()`, 启动 gateway 时自动使用 AppContainer |
| `desktop/src/gateway-manager.ts` | 新增 `getAppContainerLauncherPath()`, 支持 AppContainer 模式 |
| `deployer/windows_setup.py` | 新增 `provision_appcontainer()` 方法 |
| `appcontainer/provision-appcontainer.ps1` | 首次安装配置脚本 |

### 12.4 启动流程

```
1. Electron app 启动
2. resolveAppContainerLauncher() 查找 AppContainerLauncher.exe
3. 如果找到 → 通过 launcher 启动 gateway (in AppContainer)
4. 如果未找到 → 降级到直接 spawn node.exe (无沙箱, 兼容旧版)
5. Gateway 在 AppContainer 内启动, 监听 loopback
6. Electron 通过 WebSocket 连接到 Gateway (与原架构相同)
```

### 12.5 安装阶段 (provision)

首次安装时运行 `provision-appcontainer.ps1` (或 deployer 的 `provision_appcontainer()`):
1. 创建 AppContainer profile "MicroClaw"
2. 授予 `~/.openclaw-node` 只读 ACL
3. 授予 `~/.openclaw-node/node_modules` 只读 ACL
4. 授予 `~/.openclaw` 读写 ACL
5. 授予 Temp 目录读写 ACL
6. 添加 loopback 网络豁免

**不需要管理员权限** (C:\ traverse ACL 不再需要, 由 `--preserve-symlinks` 解决)。
