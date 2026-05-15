# 应用白名单路径验证：防止 exe 改名绕过沙箱

**日期**: 2026-03-30  
**状态**: 设计阶段  
**依赖**: AppContainer 沙箱、sandbox-preload.js 应用拦截

---

## 1. 问题

当前白名单按 **exe 名称** 过滤（`['excel', 'chrome', 'outlook', ...]`）。

攻击向量：恶意程序把自己重命名为 `excel.exe`，即可绕过沙箱以非沙箱方式运行。

---

## 2. 解决方案：名字 + 路径验证 + 签名验证

不依赖硬编码安装目录（用户可能装在自定义路径），而是利用 Windows 自带的注册表和签名机制。

### 2.1 层级防护

| 层级 | 检查方式 | 开销 | 防护场景 |
|---|---|---|---|
| 1. 名字匹配 | `externalApps.includes(name)` | 0ms | 基础过滤 |
| 2. 注册表路径验证 | 实际路径 === App Paths 注册表路径 | ~1ms（缓存后 0ms） | 恶意 exe 改名为已知应用名 |
| 3. 数字签名验证 | Authenticode 签名检查 | ~50-100ms | 恶意 exe 放到了正确安装目录下 |

---

## 3. 层级 2：App Paths 注册表路径验证

### 3.1 原理

Windows 在 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` 维护了一个 **exe 名 → 完整路径** 的映射。这是 Windows 自己解析应用名的官方机制（"运行"对话框、`ShellExecute` 都用它）。

**关键点：不管用户把应用安装到哪个目录**，安装器都会在注册表写入正确路径，所以不需要硬编码 `Program Files`。

### 3.2 实测数据

```
excel.exe   → C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE     (exists: true)
chrome.exe  → C:\Program Files\Google\Chrome\Application\chrome.exe          (exists: true)
outlook.exe → C:\Program Files\Microsoft Office\Root\Office16\OUTLOOK.EXE   (exists: true)
winword.exe → C:\Program Files\Microsoft Office\Root\Office16\WINWORD.EXE   (exists: true)
msedge.exe  → C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe  (exists: true)
powerpnt.exe→ C:\Program Files\Microsoft Office\Root\Office16\POWERPNT.EXE  (exists: true)
code.exe    → C:\Program Files\Microsoft VS Code\Code.exe                    (exists: true)

Total registered apps: 20
```

### 3.3 读取方式（Node.js）

```javascript
const { execSync } = require('child_process');

function buildAppPathsCache() {
  const regOut = execSync(
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths" /s',
    { encoding: 'utf8' }
  );
  const cache = {};
  let currentApp = null;
  for (const line of regOut.split('\r\n')) {
    const appMatch = line.match(/App Paths\\(.+)/i);
    if (appMatch) currentApp = appMatch[1].trim().toLowerCase();
    const valMatch = line.match(/\(Default\)\s+REG_SZ\s+(.+)/i);
    if (valMatch && currentApp) {
      cache[currentApp] = valMatch[1].trim().replace(/^"|"$/g, '');
      currentApp = null;
    }
  }
  return cache;
}
```

- 单次 `reg query /s` 毫秒级拿到全部注册应用
- 启动时构建一次缓存即可，后续查询 O(1)

### 3.4 验证逻辑

```typescript
function verifyAppPath(actualPath: string, appName: string): boolean {
  const registeredPath = appPathsCache[appName.toLowerCase()];
  if (!registeredPath) return false; // 未注册的应用 → 不信任
  
  return path.normalize(actualPath).toLowerCase() ===
         path.normalize(registeredPath).toLowerCase();
}
```

### 3.5 覆盖范围

| 应用来源 | App Paths 是否有记录 |
|---|---|
| MSI/exe 安装器（Office、Chrome、VS Code） | ✅ 有 |
| Microsoft Store (MSIX/AppX) | ❌ 无（但已通过 `shell:AppsFolder` 机制自动放行） |
| 便携版 (Portable) | ❌ 无 |
| 用户自定义安装目录 | ✅ 有（安装器写注册表时用的是实际路径） |

---

## 4. 层级 3：数字签名验证（Authenticode）

### 4.1 原理

正规应用的 exe 文件带有发行商的 Authenticode 数字签名。即使攻击者把恶意 exe 放到了正确的安装目录下，签名验证也能识别。

### 4.2 实现方式

**方式 A：PowerShell（简单，~50-100ms）**

```typescript
function verifyAppSignature(exePath: string): { valid: boolean; signer: string } {
  try {
    const result = execSync(
      `powershell -NoProfile -c "(Get-AuthenticodeSignature '${exePath}').SignerCertificate.Subject"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return {
      valid: result.includes('O=Microsoft Corporation') || result.includes('O=Google LLC'),
      signer: result
    };
  } catch {
    return { valid: false, signer: '' };
  }
}
```

**方式 B：WinVerifyTrust API（更快，~10ms，需 C++ addon 或 FFI）**

```c
// 通过 AppContainerLauncher.exe 扩展一个 verify 子命令
LONG status = WinVerifyTrust(NULL, &policyGUID, &trustData);
// TRUST_E_NOSIGNATURE, TRUST_E_BAD_DIGEST, S_OK
```

### 4.3 已知签名者白名单

```typescript
const TRUSTED_SIGNERS = [
  'O=Microsoft Corporation',    // Office, Edge, VS Code
  'O=Google LLC',               // Chrome
  'O=Mozilla Corporation',      // Firefox
  'O=Adobe Inc.',               // Acrobat
];
```

### 4.4 性能考虑

| 方式 | 首次调用 | 缓存后 |
|---|---|---|
| PowerShell `Get-AuthenticodeSignature` | ~50-100ms | 可缓存到 Map |
| C++ `WinVerifyTrust` | ~10ms | 可缓存到 Map |

签名验证结果可以按 `(filePath, mtime)` 缓存，同一个文件不需要重复验证。

---

## 5. 综合验证流程

```
AI 命令要启动 "excel.exe"
  │
  ├─ 1. 名字在白名单中？ ──No──→ 走审批流程（弹窗/微信）
  │     Yes
  │
  ├─ 2. 解析实际 exe 路径
  │     (从命令中提取，或通过 App Paths 注册表查询)
  │
  ├─ 3. 路径 === App Paths 注册表路径？ ──No──→ 拒绝 + 警告日志
  │     Yes
  │
  ├─ 4. [可选] 数字签名有效？ ──No──→ 拒绝 + 警告日志
  │     Yes
  │
  └─ 5. 绕过沙箱，正常启动
```

---

## 6. 其他获取已安装应用的辅助方式

除 App Paths 外，还有互补手段可用于发现和解析应用：

### 6.1 Uninstall 注册表

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
```

- 可获取 `DisplayName`、`InstallLocation`、`Publisher`
- 实测有 343 个程序记录有 `InstallLocation`
- 缺点：只有安装目录，不是 exe 完整路径

### 6.2 `where.exe`（PATH 搜索）

```bash
where excel.exe    # 从 PATH 环境变量搜索
```

- 适合命令行工具（node、python、git）
- GUI 应用通常不在 PATH 中

### 6.3 WMI / CIM

```powershell
Get-CimInstance Win32_Product | Select Name, InstallLocation
```

- 最全面但**非常慢**（几十秒），不推荐在运行时使用

---

## 7. 实现建议

### P0 — 最小改动
- 在 `sandbox-preload.js` 的 `getExternalApps()` 旁新增 `buildAppPathsCache()`
- 在 app bypass 判断处增加路径验证
- 启动时构建一次缓存

### P1 — 增强安全
- 首次批准应用时记录签名信息
- 后续调用验证签名一致

### P2 — 可选
- 扩展 `AppContainerLauncher.exe` 增加 `verify` 子命令调用 `WinVerifyTrust`
- 把签名验证结果写入 HMAC 签名的白名单文件
