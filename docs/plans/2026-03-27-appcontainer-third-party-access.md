# AppContainer 第三方软件授权研究

**日期**: 2026-03-27

## 研究目标

AppContainer 默认对微软第一方软件（System32 下的 DLL、工具）有开放权限，但第三方软件需要显式授权。研究如何给第三方软件（如 Chrome）授权。

## 核心发现

### 1. 文件系统 ACL — 大多数第三方软件已经可读

`C:\Program Files` 目录默认带有 `ALL APPLICATION PACKAGES:(RX)` ACL（继承），所以 **大多数通过安装程序安装的第三方软件的可执行文件，AppContainer 已经可以读取和执行**。

验证：
```
icacls "C:\Program Files\Google\Chrome\Application\chrome.exe"
→ APPLICATION PACKAGE AUTHORITY\ALL APPLICATION PACKAGES:(I)(RX) ✅
```

### 2. 三类第三方软件的兼容性

| 类别 | 示例 | AppContainer 兼容性 | 原因 |
|------|------|---------------------|------|
| **纯 CLI 工具** | python, node, curl (Windows 原生) | ✅ 可用 | 只需文件系统访问 + 网络能力 |
| **MSYS2/Cygwin 工具** | git (Git for Windows), bash | ❌ 不可用 | MSYS2 运行时尝试访问 `/dev/null`（NT 设备对象），AppContainer 阻止 |
| **复杂 GUI/IPC 应用** | Chrome, Firefox, VS Code | ❌ 不可用 | `CreateNamedPipe` 被内核阻止 |
| **Windows 系统工具** | cmd, powershell, ipconfig, curl | ✅ 可用 | 系统文件默认可访问 |

### 3. 关键限制：命名管道（Named Pipes）

AppContainer 的最大限制是 **不能创建命名管道**（`CreateNamedPipe` 返回 `Access is denied`）。这是内核级别的限制，无法通过 ACL 或环境变量绕过。

Chrome 在 `main()` 之前就调用 Crashpad，Crashpad 调用 `CreateNamedPipe` → 直接崩溃。

尝试的绕过方案（均失败）：
- `--disable-crashpad` — 太晚，管道已创建
- `--crashpad-handler-pid=0` — 无效
- `CHROME_CRASHPAD_PIPE_NAME` 环境变量 — 无效
- `--headless=new` — 无效

### 4. 关键限制：MSYS2 设备仿真

Git for Windows 基于 MSYS2，其运行时在启动时就访问 `/dev/null`（通过 NT 设备管理器路径 `\Device\Null`）。AppContainer 阻止对这些系统设备对象的访问。

```
fatal: could not open '/dev/null' for reading and writing: Permission denied
```

## 实测结果

```
python --version         → ✅ Python 3.12.10
node -e "console.log()" → ✅ Hello_AC_Node_v22.22.2
curl --version           → ✅ curl 8.18.0
curl https://google.com  → ✅ HTTP 200
git --version            → ❌ /dev/null Permission denied
chrome --headless         → ❌ CreateNamedPipe Access denied (Crashpad)
edge --headless           → ✅ DevTools listening on ws://127.0.0.1:9338/...
```

## 授权方法

### A. 简单 CLI 工具（python, node 等）— 只需文件系统 ACL

```bash
# 授予安装目录的读取+执行权限
AppContainerLauncher grant --name MicroClaw --dir "C:\path\to\tool" --access r

# 如果工具需要写入数据目录
AppContainerLauncher grant --name MicroClaw --dir "C:\Users\xxx\AppData\Local\ToolData" --access rw
```

大多数情况下不需要手动授权，因为 Program Files 已经有 ALL APPLICATION PACKAGES ACL。
只有安装到非标准位置（如用户目录）的软件需要。

### B. 复杂应用（Chrome 等）— 需要 Broker 模式

```
┌─────────────────────────────────┐     ┌────────────────────┐
│  AppContainer (sandboxed tool)  │────▶│  Chrome (unsandboxed) │
│  - Playwright Node code         │ WS  │  - DevTools Protocol  │
│  - connect() to browser         │     │  - runs normally      │
└─────────────────────────────────┘     └────────────────────┘
```

**方案：Browser Broker**
1. 在 AppContainer **外部**启动 Chrome（由 gateway 或 launcher 管理）
2. Chrome 暴露 DevTools Protocol 端口（如 `--remote-debugging-port=9222`）
3. 在 AppContainer **内部**的工具代码通过 WebSocket 连接到 Chrome
4. Playwright 原生支持 `browserType.connect(wsEndpoint)` 模式

这也是 Playwright 的 "Browser Server" 模式的工作方式。

### C. MSYS2 工具（git 等）— 需要特殊处理

选项：
1. **使用原生 Windows 替代品**：如 `libgit2` 而非 Git for Windows
2. **在 AppContainer 外运行**：通过 RPC/pipe 代理 git 命令
3. **接受限制**：MicroClaw 的 tool sandbox 主要用于 AI 工具调用，可能不需要 git

## 下一步：Browser Broker 实现方案

如果要实现 Chrome/浏览器的 broker 模式：

1. **Launcher 新增 `browser-broker` 命令**
   - 在非 AC 环境启动 Chrome
   - `--remote-debugging-port=0`（自动选端口）
   - 返回 WebSocket URL

2. **sandbox-preload.js 拦截浏览器启动**
   - 检测到 chrome/chromium/msedge 可执行文件时
   - 不走 AppContainer，改为连接到 broker
   - 通过环境变量传递 broker 的 WebSocket URL

3. **tool-sandbox.ts 管理 broker 生命周期**
   - 按需启动/停止浏览器 broker
   - 超时自动关闭

## 关键发现：Edge 在 AppContainer 中可以启动！

**Chrome 不行，但 Edge 可以。**

Edge 是微软自家产品，其 Crashpad 行为做了 AppContainer 兼容处理（或替换为其他崩溃上报机制）。
实测 Edge 在 AppContainer 中成功启动并打开了 DevTools Protocol：

```
DevTools listening on
ws://127.0.0.1:9338/devtools/browser/f199afda-74e2-481f-af62-c69a33337ce3
```

### Edge 在 AC 中的启动参数

```bash
AppContainerLauncher run --name MicroClaw \
  --exe "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
  --cap internetClient --cap internetClientServer --cap privateNetworkClientServer \
  -- --no-sandbox --headless=new --disable-gpu \
  --remote-debugging-port=9338 \
  --user-data-dir=<writable-temp-dir> \
  --no-first-run --no-default-browser-check \
  --disable-features=NetworkServiceSandbox,msEdgeOneAuth \
  about:blank
```

### AC 中 Edge 的非致命错误（不影响运行）

1. `CoCreateInstance of Elevator failed` — 自动更新检查失败，无影响
2. `Failed to grant sandbox access to cache directory` — Edge 自己的网络子进程沙箱 ACL 设置失败（因为 AC 内不能修改 ACL）。用 `--disable-features=NetworkServiceSandbox` 可缓解
3. `msEdgeOneAuth` — Edge 登录模块，headless 用不到

### Playwright 使用方式

Playwright 原生支持通过 `connect()` 连接到已启动的浏览器：

```javascript
// 在 AppContainer 内启动 Edge
const browser = await chromium.connectOverCDP('http://127.0.0.1:9338');
// 或 Playwright 直接启动（channel: 'msedge' 走 Edge 而非 Chrome）
const browser = await chromium.launch({ channel: 'msedge' });
```

## 对现有架构的影响

当前 sandbox-preload.js 中的 `SHELL_NAMES_SET` 只拦截 shell 执行器（cmd, powershell, python, node 等），不拦截 chrome.exe/msedge.exe。

对于 Playwright 场景：Playwright 直接调用 `child_process.spawn('chrome', ...)` — 这不在 SHELL_NAMES_SET 中，所以**当前不会被 AppContainer 拦截**。浏览器会以当前进程的权限运行（而不是 AppContainer 内部）。

### 当前实际行为
- Gateway 在 AppContainer **外部**运行
- sandbox-preload.js 只拦截 SHELL_NAMES_SET 中的可执行文件
- chrome.exe/msedge.exe 不在 SHELL_NAMES_SET 中
- **所以浏览器实际上已经在 AppContainer 外运行了** ✅

### 如果要在 AC 内启动浏览器
- **Edge: 直接可行** — 加 `--no-sandbox` + `--disable-features=NetworkServiceSandbox`
- **Chrome: 不可行** — Crashpad 的 `CreateNamedPipe` 是内核级阻断，无法绕过
- **替代方案**: 将 `msedge` 加入 SHELL_NAMES_SET，或实现 Browser Broker 模式
