# Shell 命令预阻塞权限检查

**日期**: 2026-03-30  
**状态**: 设计阶段  
**依赖**: AppContainer 沙箱、sandbox-preload.js

---

## 1. 问题

当前权限检查分两套模型：

| 操作类型 | 模型 | 体验 |
|---|---|---|
| **fs 操作**（writeFileSync 等） | **预阻塞** — 写之前拦截，`Atomics.wait` 等用户授权再继续 | ✅ 好 |
| **Shell 命令**（spawn/exec） | **后失败** — 命令在 AppContainer 中跑，Access Denied 后解析 stderr 提取路径，异步通知用户 | ❌ 差 |

Shell 命令的问题：
- 命令已经失败了，需要 AI 重新发起
- 错误信息格式不统一，正则提取路径不可靠
- 有些程序不输出具体路径，只报 "Access denied"
- 用户体验是"失败 → 弹窗 → 授权 → AI 重试"，多了一轮交互

**目标**：让 Shell 命令也能在运行前阻塞，授权后再继续，做到一次成功。

---

## 2. 现有机制对比

### fs 预阻塞（已实现）

```javascript
// sandbox-preload.js 中的 monkey-patch
fsMod.writeFileSync = function(file) {
  if (shouldBlockWrite(file)) {      // ← 写之前检查
    // shouldBlockWrite 内部:
    //   1. 检查路径是否在 RO 目录
    //   2. 检查缓存（已授权/已拒绝）
    //   3. 未知 → requestFilePermission() → Atomics.wait 60s
    //   4. 用户授权 → ACL 更新 → 返回 false
    //   5. 用户拒绝 → throw EACCES
  }
  return _writeFileSync.apply(this, arguments);
};
```

### Shell 后失败（当前）

```javascript
// 命令运行 → 失败 → 解析错误
child.on('exit', function(code) {
  if (code !== 0) {
    var denied = detectAccessDenied(stderr, stdout);
    if (denied) {
      // 异步发送权限请求（不阻塞）
      process.send({ type: 'sandbox-shell-permission-request-async', ... });
      // 用户授权后，需要 AI 重新发起命令
    }
  }
});
```

---

## 3. 方案：命令解析预检查 + 现有后备

### 3.1 核心思路

在 `cp.spawn()` / `cp.spawnSync()` 之前，解析命令字符串提取目标路径，对每个路径调用已有的 `shouldBlockWrite()` 预阻塞机制。

```
                     ┌─────────────────────────────┐
                     │    AI 发出 Shell 命令        │
                     └──────────────┬──────────────┘
                                    │
                     ┌──────────────▼──────────────┐
                     │   extractTargetPaths(cmd)    │
                     │   解析命令，提取目标路径       │
                     └──────────────┬──────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  有未授权的路径？   │
                          └─────┬─────────┬───┘
                                │Yes      │No
                     ┌──────────▼──────┐  │
                     │ shouldBlockWrite │  │
                     │ → Atomics.wait  │  │
                     │ → 用户授权弹窗   │  │
                     │ → ACL 更新      │  │
                     └──────────┬──────┘  │
                                │         │
                     ┌──────────▼─────────▼───────┐
                     │   cp.spawn() 正常运行       │
                     │   AppContainer 已有权限     │
                     │   → 一次成功                │
                     └──────────────┬──────────────┘
                                    │
                     ┌──────────────▼──────────────┐
                     │  [后备] 仍然保留现有的        │
                     │  Access Denied 检测机制       │
                     │  覆盖命令解析遗漏的情况        │
                     └─────────────────────────────┘
```

### 3.2 命令解析器：提取目标路径

```javascript
function extractTargetPaths(command) {
  var paths = [];
  var patterns = [
    // === PowerShell 写入操作 ===
    // Out-File -FilePath "C:\path\file.txt"
    /Out-File\s+(?:-FilePath\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // Set-Content / Add-Content
    /Set-Content\s+(?:-Path\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    /Add-Content\s+(?:-Path\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // New-Item -Path "C:\path\file.txt"
    /New-Item\s+(?:-Path\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // Copy-Item ... -Destination "C:\path"
    /Copy-Item\s+.+?\s+(?:-Destination\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // Move-Item ... -Destination "C:\path"
    /Move-Item\s+.+?\s+(?:-Destination\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // Remove-Item "C:\path"
    /Remove-Item\s+(?:-Path\s+)?(?:-Recurse\s+)?(?:-Force\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,
    // Rename-Item
    /Rename-Item\s+(?:-Path\s+)?["']?([a-zA-Z]:\\[^"'\s|;>]+)/gi,

    // === cmd 操作 ===
    // 重定向 > 或 >>
    />\s*["']?([a-zA-Z]:\\[^"'\s|;]+)/g,
    />>\s*["']?([a-zA-Z]:\\[^"'\s|;]+)/g,
    // copy/move/del
    /\bcopy\s+.+?\s+["']?([a-zA-Z]:\\[^"'\s|;]+)/gi,
    /\bmove\s+.+?\s+["']?([a-zA-Z]:\\[^"'\s|;]+)/gi,
    /\bdel\s+["']?([a-zA-Z]:\\[^"'\s|;]+)/gi,
    /\bmkdir\s+["']?([a-zA-Z]:\\[^"'\s|;]+)/gi,

    // === Python ===
    // open("C:\path\file", "w")
    /open\s*\(\s*["']([a-zA-Z]:\\[^"']+)["']\s*,\s*["'][waxWAX]/g,
    // shutil.copy(..., "C:\path")
    /shutil\.(?:copy|move)\s*\(.+?,\s*["']([a-zA-Z]:\\[^"']+)/g,

    // === Node.js ===
    // fs.writeFileSync("C:\path")
    /fs\.(?:writeFileSync|appendFileSync|copyFileSync)\s*\(\s*["']([a-zA-Z]:\\[^"']+)/g,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var pat = new RegExp(patterns[i].source, patterns[i].flags);
    var m;
    while ((m = pat.exec(command)) !== null) {
      if (m[1]) paths.push(m[1].replace(/["']+$/g, ''));
    }
  }

  return deduplicate(paths);
}
```

### 3.3 Spawn 拦截集成

```javascript
var _spawn = cp.spawn;
cp.spawn = function(cmd, args, opts) {
  // 只对 shell 命令做预检查
  if (isSandboxActive && isShellCommand(cmd, args, opts)) {
    var fullCmd = buildFullCommand(cmd, args, opts);
    var targetPaths = extractTargetPaths(fullCmd);

    for (var i = 0; i < targetPaths.length; i++) {
      var p = targetPaths[i];
      // 复用已有的 shouldBlockWrite 逻辑
      // 内部会: 检查缓存 → 发 IPC → Atomics.wait → 用户授权 → ACL 更新
      if (shouldBlockWrite(p)) {
        // 用户拒绝了这个路径
        // 选项 A: 让命令继续跑，会在 AppContainer 中失败（保持现有行为）
        // 选项 B: 直接返回一个失败的子进程（快速失败）
      }
    }
  }

  return _spawn.apply(this, arguments);
};
```

### 3.4 spawnSync 的处理

```javascript
var _spawnSync = cp.spawnSync;
cp.spawnSync = function(cmd, args, opts) {
  if (isSandboxActive && isShellCommand(cmd, args, opts)) {
    var fullCmd = buildFullCommand(cmd, args, opts);
    var targetPaths = extractTargetPaths(fullCmd);

    for (var i = 0; i < targetPaths.length; i++) {
      // shouldBlockWrite 本身就是同步的（Atomics.wait）
      // 与 spawnSync 的同步模型完全兼容
      shouldBlockWrite(targetPaths[i]);
    }
  }

  return _spawnSync.apply(this, arguments);
};
```

---

## 4. 覆盖率分析

### 能预检查的场景（命令解析可提取路径）

| 命令 | 示例 | 路径提取 |
|---|---|---|
| PowerShell Out-File | `"hello" \| Out-File C:\Users\x\file.txt` | ✅ |
| PowerShell Set-Content | `Set-Content -Path "C:\doc\a.txt" -Value "..."` | ✅ |
| PowerShell Copy-Item | `Copy-Item src.txt -Destination C:\doc\dst.txt` | ✅ |
| cmd 重定向 | `echo hello > C:\Users\x\file.txt` | ✅ |
| cmd copy/move | `copy file.txt C:\Users\x\backup\` | ✅ |
| Python open(w) | `python -c "open('C:\\doc\\f.txt','w').write('x')"` | ✅ |
| Node.js fs.write | `node -e "fs.writeFileSync('C:\\doc\\f.txt','x')"` | ✅ |

### 无法预检查的场景（需要后备机制）

| 场景 | 原因 |
|---|---|
| 路径由变量/表达式生成 | `$p = Join-Path $dir "file.txt"; Set-Content $p "x"` |
| 调用外部程序写文件 | `ffmpeg -i in.mp4 C:\out.mp4`（无法穷举所有程序） |
| 多层脚本调用 | `python script.py`（script.py 内部写文件） |
| 管道到外部程序 | `curl ... \| python -c "..."` |

这些场景由**现有的 Access Denied 后备检测**覆盖。

### 预期覆盖率

根据 AI agent 的典型命令模式（PowerShell 操作、文件重定向是主要场景），预检查可覆盖约 **70-80%** 的文件写入操作。

---

## 5. 与远程权限审批的配合

预阻塞 + 远程审批结合后的完整流程：

```
AI 发出 Shell 命令（来自微信用户）
  │
  ├─ extractTargetPaths() 提取路径
  │
  ├─ shouldBlockWrite() 检查每个路径
  │   │
  │   ├─ 已有缓存（之前授权过）→ 直接放行
  │   │
  │   └─ 未授权 → requestFilePermission()
  │       │
  │       ├─ 检测会话来源 = 微信
  │       │   → 发微信消息 "需要写入 C:\xxx，回复 Y/N"
  │       │   → Atomics.wait 等待用户微信回复
  │       │
  │       └─ 会话来源 = 本地
  │           → 弹本地对话框
  │           → Atomics.wait 等待用户点击
  │
  ├─ 用户授权 → ACL 更新 → spawn 执行 → 一次成功
  │
  └─ [后备] Access Denied 检测（覆盖遗漏路径）
```

---

## 6. 实现计划

### P0 — 核心功能
1. 实现 `extractTargetPaths()` 命令解析器
2. 在 `cp.spawn` / `cp.spawnSync` 拦截中增加预检查
3. 复用已有的 `shouldBlockWrite()` + `requestFilePermission()` 机制
4. 保留现有 Access Denied 后备检测

### P1 — 增强覆盖
5. 扩展正则模式：覆盖更多 PowerShell/cmd/Python 命令变体
6. 支持相对路径解析（结合 cwd 拼接）
7. 目录级别预检查（如果目录整体未授权，直接预阻塞）

### P2 — 高级方案（可选）
8. 扩展 `AppContainerLauncher.exe` 增加 `check` 子命令，使用 Win32 `AccessCheck()` API
9. ETW FileIO 实时监控 + 进程暂停/恢复（最彻底但最复杂）

---

## 7. 性能影响

| 阶段 | 开销 |
|---|---|
| `extractTargetPaths()` 正则匹配 | < 1ms（字符串操作） |
| `shouldBlockWrite()` 缓存命中 | < 0.1ms |
| `shouldBlockWrite()` 缓存未命中 → 用户交互 | 阻塞等待用户响应（不超过 60s） |
| 总增加延迟（无阻塞时） | < 2ms，可忽略 |
