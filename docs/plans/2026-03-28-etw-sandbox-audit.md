# ETW 沙箱运行时审计方案

> 状态：提案  
> 日期：2026-03-28  
> 前置：AppContainer 沙箱已投产

## 目标

在 AI Agent 执行脚本期间，实时监测脚本实际使用了哪些系统资源（文件、网络、进程），生成结构化审计报告。覆盖所有语言（Python、Node.js、PowerShell 等），无需修改被监测脚本。

## 背景

当前沙箱架构（AppContainer + sandbox-preload.js）已经做到了：

- 文件系统 ACL 白名单（只有授权目录可访问）
- 网络限制（仅 `internetClient` 出站）
- 外部应用审批（白名单 + IPC 审批流程）
- 子进程拦截（通过 `child_process` hook）

**缺失的是可见性**：我们知道"允许了什么"但不知道"实际发生了什么"。无法回答：

- 脚本读写了哪些文件？
- 脚本连接了哪些远程服务器？
- 有哪些被 AppContainer 拒绝的访问尝试？

## 方案：ETW 内核级追踪

ETW (Event Tracing for Windows) 是 Windows 内核内置的追踪机制，零拷贝、低开销（< 1% CPU）。Process Monitor 就是基于 ETW 实现的。

### 架构

```
Agent 请求执行脚本
       │
  ToolSandbox (Electron)
       │
  AppContainerLauncher.exe run --name MicroClaw --audit "cmd /c python script.py"
       │
  ┌─────────────────────────────────────────┐
  │  1. 创建 ETW RealTime Session           │
  │  2. 订阅 Kernel Provider (文件/网络/进程)│
  │  3. CreateProcessW() in AppContainer     │
  │  4. 实时过滤：只保留 Job Object 内 PID   │
  │  5. 进程退出 → 停止 Session              │
  │  6. 输出审计报告到 stderr (JSON)         │
  └─────────────────────────────────────────┘
       │
  Electron 主进程解析报告 → 展示/存储
```

### 可监测事件

#### 1. 文件系统 (`Microsoft-Windows-Kernel-File`)

| 事件 | 捕获信息 | 用途 |
|------|---------|------|
| Create/Open | 路径、访问模式（读/写/删除） | 知道脚本打开了哪些文件 |
| Read | 路径、偏移量、字节数 | 了解读取量 |
| Write | 路径、偏移量、字节数 | 了解写入量 |
| Delete | 路径 | 检测删除操作 |
| Rename | 原路径 → 新路径 | 检测移动/重命名 |

示例：

```
[file] READ   C:\Users\hasu\.openclaw\sandbox\data.csv
[file] WRITE  C:\Users\hasu\.openclaw\sandbox\output.xlsx
[file] DENIED C:\Users\hasu\Documents\secret.docx
```

#### 2. 网络 (`Microsoft-Windows-Kernel-Network`)

| 事件 | 捕获信息 | 用途 |
|------|---------|------|
| TCP Connect | 目标 IP:Port | 知道连了哪些服务器 |
| UDP Send | 目标地址 | 检测 DNS 查询等 |
| TCP Accept | 源地址 | 检测监听行为（通常被 AppContainer 阻止） |

示例：

```
[net] TCP CONNECT 142.250.80.46:443  (googleapis.com)
[net] TCP CONNECT 127.0.0.1:18789    (localhost gateway)
```

#### 3. 进程 (`Microsoft-Windows-Kernel-Process`)

| 事件 | 捕获信息 | 用途 |
|------|---------|------|
| ProcessStart | 命令行、PID、父PID | 追踪完整子进程链 |
| ProcessStop | 退出码 | 执行结果 |

示例：

```
[proc] START  pid=12340  python.exe script.py
[proc] START  pid=12345  cmd.exe /c curl https://example.com
[proc] STOP   pid=12345  exit=0
```

### PID 过滤

现有代码已使用 Job Object 管理沙箱进程。ETW 事件包含 PID，过滤逻辑：

1. 记录沙箱主进程 PID
2. 监听 ProcessStart，若父 PID 在 Job 内 → 加入追踪集合
3. 文件/网络事件：仅保留追踪集合内 PID 的事件，丢弃系统噪音

### 输出格式

审计报告通过 stderr 输出，格式为单行 JSON（`[sandbox-audit]` 前缀）：

```json
{
  "duration_ms": 3420,
  "files": {
    "read": ["~/.openclaw/sandbox/data.csv"],
    "write": ["~/.openclaw/sandbox/output.xlsx"],
    "denied": ["~/Documents/secret.docx"]
  },
  "network": [
    { "proto": "tcp", "dest": "142.250.80.46:443", "bytes_sent": 1024 }
  ],
  "processes": [
    { "exe": "python.exe", "args": "script.py", "exit_code": 0 }
  ]
}
```

## 实现

### 依赖

NuGet 包 `Microsoft.Diagnostics.Tracing.TraceEvent`，纯 .NET 库，直接在 `ContainerManager.cs` 中使用。

注意：Kernel Provider 需要管理员权限。AppContainerLauncher 的 `setup` 命令已经需要管理员权限，可以在该阶段注册 ETW session，或在首次 `--audit` 时请求提权。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `appcontainer/ContainerManager.cs` | 新增 `SandboxAuditor` 类，在 `RunInContainer()` 前后启停 ETW session |
| `appcontainer/Program.cs` | `run` 命令增加 `--audit` 开关 |
| `appcontainer/AppContainerLauncher.csproj` | 添加 TraceEvent NuGet 依赖 |
| `desktop/src/tool-sandbox.ts` | 解析 stderr 中的 `[sandbox-audit]` JSON 行 |
| 渲染进程（可选） | 新增"权限活动"面板展示审计结果 |

核心 C# 代码约 200–300 行。Electron 端仅需解析 JSON。

### 伪代码

```csharp
// ContainerManager.cs 新增
class SandboxAuditor : IDisposable
{
    private TraceEventSession _session;
    private HashSet<int> _trackedPids = new();
    private AuditReport _report = new();

    public void Start(int rootPid)
    {
        _trackedPids.Add(rootPid);
        _session = new TraceEventSession("MicroClaw-Sandbox-Audit");

        _session.EnableKernelProvider(
            KernelTraceEventParser.Keywords.FileIO |
            KernelTraceEventParser.Keywords.NetworkTCPIP |
            KernelTraceEventParser.Keywords.Process
        );

        _session.Source.Kernel.FileIORead  += e => OnFileEvent(e, "read");
        _session.Source.Kernel.FileIOWrite += e => OnFileEvent(e, "write");
        _session.Source.Kernel.TcpIpConnect += OnNetworkConnect;
        _session.Source.Kernel.ProcessStart += OnProcessStart;
        _session.Source.Kernel.ProcessStop  += OnProcessStop;

        Task.Run(() => _session.Source.Process());  // 后台消费事件
    }

    private void OnFileEvent(FileIOReadWriteTraceData e, string op)
    {
        if (!_trackedPids.Contains(e.ProcessID)) return;
        _report.AddFile(op, e.FileName);
    }

    private void OnProcessStart(ProcessTraceData e)
    {
        if (_trackedPids.Contains(e.ParentID))
            _trackedPids.Add(e.ProcessID);
    }

    public AuditReport Stop()
    {
        _session.Stop();
        return _report;
    }
}
```

## 性能

- ETW 是内核级零拷贝机制，事件从内核缓冲区直接映射到用户态
- 仅在沙箱进程存活期间开启 session
- PID 过滤在消费端完成，内核侧无额外负担
- 实测 overhead 通常 < 1% CPU
- 可通过调整 `BufferSizeMB` 和 `BufferQuantityMB` 控制内存占用

## 后续扩展

- **权限预警**：检测到敏感操作（大量文件写入、连接未知 IP）时弹出通知
- **持久化审计日志**：将报告存储到 `~/.openclaw/audit/`，支持历史查询
- **权限趋势**：统计每个 skill 的权限使用模式，自动收紧 ACL
- **阻断模式**：从"仅监测"升级为"实时阻断"，在检测到异常时终止沙箱进程
