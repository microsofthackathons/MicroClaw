# AppContainerLauncher stdout 管道修复

**日期**: 2026-03-31  
**状态**: 待实施  
**优先级**: P2（不影响生产环境）  
**依赖**: AppContainer 沙箱

---

## 1. 问题

`AppContainerLauncher run --no-window` 执行子进程时，**stdout 没有输出**，stderr 正常。

### 复现

```powershell
$launcher = "AppContainerLauncher.exe"
& $launcher run --name MicroClaw --exe "C:\Program Files\PowerShell\7\pwsh.exe" `
  --cap internetClient --no-window -- `
  -NoProfile -NonInteractive -Command `
  "[Console]::Error.WriteLine('stderr test'); [Console]::Out.WriteLine('stdout test')"
```

**预期输出**：
```
stderr test
stdout test
```

**实际输出**：
```
stderr test
```
（stdout 的内容丢失）

### 影响范围

| 场景 | 是否受影响 |
|---|---|
| 终端直接运行 launcher 测试 | ✅ 受影响 |
| 从 Node.js child_process 调用 | ❌ **不受影响**（Node 自己创建管道） |
| gateway 中 agent 执行命令 | ❌ **不受影响** |
| 安装器调用 | ❌ 不受影响（不用 stdout） |

---

## 2. 根因分析

`ContainerManager.cs` 第 357-361 行：

```csharp
si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
```

当前实现直接把 launcher 自身的标准 handle 传给 AppContainer 子进程。

问题在于 `CREATE_NO_WINDOW` 标志 + AppContainer 安全模型的组合下，Windows 不分配新的控制台给子进程。stdout 的控制台 handle 对 AppContainer 子进程不可写（安全性限制），但 stderr handle 可能因为不同的内核对象类型而仍然可用。

### 为什么 Node.js 不受影响

Node.js 的 `child_process.spawn/spawnSync` 在调用 `CreateProcess` 之前，会自己创建匿名管道（`CreatePipe`），把管道的 write 端作为子进程的 stdout/stderr handle。管道 handle 没有控制台的安全限制。

---

## 3. 修复方案

### 3.1 匿名管道转发

在 `ContainerManager.Run()` 中创建匿名管道，替代 `GetStdHandle`：

```csharp
// 创建 stdout 管道
CreatePipe(out var stdoutRead, out var stdoutWrite, ref sa, 0);
SetHandleInformation(stdoutWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
// stderr 管道（可选，目前 stderr 工作正常）
// CreatePipe(out var stderrRead, out var stderrWrite, ref sa, 0);

si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
si.StartupInfo.hStdOutput = stdoutWrite;  // 管道写端 → 子进程
si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);  // stderr 保持不变

// CreateProcess 之后，关闭 write 端（launcher 不需要）
CloseHandle(stdoutWrite);

// 启动后台线程从 stdoutRead 读取并转发到 Console.Out
Task.Run(() => {
    var buf = new byte[4096];
    int n;
    using var stream = new FileStream(stdoutRead, FileAccess.Read, 4096, false);
    while ((n = stream.Read(buf)) > 0)
        Console.Out.Write(Encoding.UTF8.GetString(buf, 0, n));
});
```

### 3.2 需要的 P/Invoke

```csharp
[DllImport("kernel32.dll", SetLastError = true)]
static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe,
    ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

[DllImport("kernel32.dll", SetLastError = true)]
static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

const uint HANDLE_FLAG_INHERIT = 1;
```

### 3.3 注意事项

- 管道读取需要在独立线程中进行，避免阻塞 `WaitForExit`
- 如果 stderr 将来也出问题，可以同样用管道替代
- `SafeFileHandle` 用法需要确保正确释放
- 需要重新编译 `AppContainerLauncher.exe` 并发布新的二进制

---

## 4. 测试计划

1. 编译修改后的 launcher
2. 运行 `Write-Output 'hello'` → 验证 stdout 输出
3. 运行 `Get-ChildItem C:\a` → 验证 PowerShell cmdlet 输出
4. 运行 agent 命令 → 验证不影响 gateway 正常流程
5. 运行 `[Console]::Error.WriteLine('err')` → 验证 stderr 仍然正常
