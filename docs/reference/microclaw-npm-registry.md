# MicroClaw 专用 npm 源

构建、安装器与 Gateway 的 npm 子进程使用同一来源策略。安装器不再执行用户级 `npm config set registry/prefix`，也不在回滚时把用户的源重置为 npm 官方源。既有用户 `.npmrc` 的认证、代理和证书设置仍可被 npm 正常读取。

## 配置与优先级

运行时按以下优先级选择：

1. 进程变量 `MICROCLAW_NPM_REGISTRY`。
2. `<MicroClaw 安装目录>/install-state/npm-registry.json`。
3. 旧安装清单 `install-state/install-manifest.json` 的 `npmRegistry` 字段，用于兼容旧安装。
4. 随桌面包携带的 `resources/npm-registry.json`。
5. 开发环境的 `deployer/assets/npm-registry.json`，当前通用默认值是华为 npm 镜像。

应用专用文件示例：

```json
{
  "schema": 1,
  "registry": "https://your-approved-npm.example/Team/Feed/npm/"
}
```

URL 不接受内嵌用户名、密码、查询参数或片段；认证继续采用 npm 支持的按源绑定配置。源 URL 的路径大小写予以保留。

安装器还接受显式 `npm.registry` 配置，其优先级在进程变量之后、已保存的应用源之前。安装结果写回应用源和安装清单；如使用显式批准的备用源，记录实际成功的源。

完整构建也遵循 `MICROCLAW_NPM_REGISTRY`；兼容旧构建变量 `MSIX_NPM_REGISTRY`。构建包装器只为本次构建及其子进程设置 npm 环境，成功或失败后均恢复原进程环境。单独运行的开发者 npm 命令继续使用开发者自己的配置，仓库 `.npmrc` 不再强制覆盖它。

```powershell
# 仅此进程的企业构建示例，不修改全局 npm 配置
$env:MICROCLAW_NPM_REGISTRY = 'https://packagefeedproxy.microsoft.io/npm/'
.\build.ps1
```

微软地址是本仓库原有说明中的 npm 代理，仅适用于获准使用它的环境，不能将现有 PyPI 地址当作 npm 源。

## 传递和边界

Gateway 环境中显式设置 `npm_config_registry`，删除同一设置的大小写变体，确保 `npm view`、`npm pack` 和依赖安装不被其他通用 registry 环境覆盖。主进程实际 Gateway 启动路径与旧 GatewayManager 均使用相同适配器。

`replace-registry-host` 使用 `npmjs`：重写 npm 官方包地址，同时保留企业源返回的其他文件端点。此前的 `always` 会把微软源返回的 Azure 下载地址改成包代理主机，导致 404。

安装器默认只尝试选定源。部署方可显式设置 `npm.fallback_registries`，按给定顺序尝试这些批准的来源；不自动追加或测速切换到公共源。Node/Git 二进制镜像的选择与 npm 包源相互独立。

本功能控制 npm 包来源，不代表所有外部服务都会改走 npm 镜像。OpenClaw 独立的 ClawHub/签名目录服务、搜索服务本身仍是各自的网络端点。

## 本机验证（2026-11-13）

- 已写入本机 MicroClaw 专用源文件，选用微软 npm 代理；没有改写用户 `.npmrc`。
- 使用当前 OpenClaw 2026.10.10 的实际 npm 元数据和打包函数，查询并下载 `@openclaw/parallel-plugin@2026.10.10`。
- 下载包的 SHA-512 与元数据一致；另在独立目录验证依赖安装，关闭包生命周期脚本。
- 实际请求域名是微软 npm 代理和它返回的 Azure Artifacts 文件 CDN；未使用被拦的 npmmirror。
- 测试前后用户 `.npmrc` 的 SHA-256 一致。完整摘要在 `build/reports/npm-registry-unification/latest-evidence.json`。
- 240 项相关 Python 测试、6 项桌面测试及新增 TypeScript 文件的 ESLint 检查通过；构建资源相关 Node 测试此前也已通过。
- `npm run pack:prepared` 通过，生成 `desktop/release/win-unpacked`；已核对打包后的源配置、Gateway 适配器与 PowerShell 辅助脚本。记录见 `build/reports/npm-registry-unification/package-evidence.json`。尚未重新构建完整安装器或替换当前安装的 EXE。

这证明了源配置经 OpenClaw SDK 到 npm 子进程的真实传递和下载；尚不能当作搜索插件 UI 激活或实际搜索质量已验证。已安装的旧桌面版本需要更新后，才会使用新增的自动读取逻辑。
