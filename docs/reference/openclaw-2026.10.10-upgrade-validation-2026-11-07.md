# OpenClaw 2026.10.10 升级验收记录

日期：2026-11-07。MicroClaw 产品版本：1.0.0 → 1.0.1；内置核心：2026.10.5 → 2026.10.10。

2026-11-09 补充：本报告记录历史构建与回归，不覆盖后续轻量备份、自动 Doctor 移除及 Gateway 编译缓存/PID 修复。最新备份策略见 `docs/plans/2026-11-09-lightweight-upgrade-backup.md`；历史通过数不代表当前提交已完整重测。

## 交付与范围

- 实施计划：`docs/plans/2026-11-07-openclaw-10.10-upgrade.md`。
- 升级分析：`docs/reference/openclaw-2026.10.5-to-2026.10.10-exe-upgrade-review-2026-11-07.md`。
- 新安装包已生成，真实冻结载荷的核心数据/桌面覆盖迁移测试通过；签名与完整 Windows 图形安装仍是独立发布门禁。
- 未上传、发布或推送到线上更新渠道；未提交 Git，也未改变现有分支。

## 新安装包

- 隔离构建成功，用时约 9.29 分钟，最终自解压内容与构建载荷的完整文件集哈希一致。
- 验收输入：`build/openclaw-10.10-upgrade/target-10.10/MicroClawSetup.exe`。
- 交付副本：`dist/openclaw-2026.10.10/MicroClawSetup.exe`，附带 `install-manifest.json`、`artifact.json` 和 `SHA256SUMS.txt`，复制后哈希一致。根目录下原有的旧版 `dist/MicroClawSetup.exe` 未被冒充为新版。
- 产品版本：`1.0.1.0`；清单目标核心：`2026.10.10`。
- 大小：`749219883` 字节（约 714.5 MiB）。
- EXE SHA-256：`745c2cb34047a9d242fb4b62768511cbaddbdeeb33ffc680138f2678afdcb732`。
- 内置桌面归档 SHA-256：`78b5f3f15aa7307fcc9ebcb25a5d419af2dbfce6e861629e1c8ba551dbaeb9db`。
- Authenticode：**NotSigned**。本机未配置 Trusted Signing，因此这是未签名验收包，不能把构建成功称为已通过签名发布门禁。
- 原始记录：`build/openclaw-10.10-upgrade/target-10.10/artifact.json`、`build/openclaw-10.10-upgrade/build-exe.log`。

## 输入来源

| 输入 | 确认方式 |
| --- | --- |
| 10.5 基线 EXE | 保留原 `dist/MicroClawSetup.exe`，提取真实 PyInstaller 载荷；SHA-256 为 `bcf515c68deb9419f46e9591a7344600a8e40ae588252c61cc7b8af6bb45fa01` |
| 10.10 核心 | 官方 release 绑定的 Actions npm 产物；SHA-256 为 `e811c18281812a409e29a681ada7faf7100560020e144fbdf18889fab2c7cf06`，与发行清单一致 |
| Node | 打包资源实际执行版本检查，要求 `>=24.16.0 <25 || >=26.1.0`；本次使用 26.13.0 |
| 本地模型 provider | 继续固定已审核的 2026.10.5；与 10.10 真实 Gateway 的安装、热加载和模型下载确认流程已通过，未下载权重 |
| 微信 | 2.4.6 源码不变，宿主 SDK 精确声明更新到 2026.10.10，保留来源、文件树和 exports 校验 |

官方归档、元数据与原始包保存在 `build/openclaw-10.10-upgrade/artifacts/`，不提交到 Git。
测试与构建使用可访问的华为 npm 镜像，核心包 integrity 已另行核对，不以镜像自述替代官方清单。

## 已完成的适配

1. 安装器、构建、CI、微信 SDK、桌面产品版本与锁文件统一升级。
2. 打包前后检查 ASAR 内真实核心版本和内置 Node；不再附带可能覆盖新 ASAR 的旧核心目录。
3. EXE 与 MSIX 统一资源准备入口；保留活动资源，不强制删除运行中的原生文件。
4. 10.10 的 14 个安全适配模块使用真实发行包原始 SHA-256，保留未知源码拒绝、权限校验和单次审批语义。
5. 适配 10.10 worker Cron 调度、带 signal 的更新 API、新审批与 hooks 模块；调度启动成功后才回执恢复围栏。
6. 安装器验证桌面真正解出的核心版本必须等于目标，而非只验证全局 npm 或非空版本。
7. 继续沿用备份 → 校验 → npm 固定版本 → Doctor → 校验 → 提交；Doctor 失败保留恢复事务，不自动降级数据库。

## 自动回归记录

| 测试 | 当前结果 | 证据 |
| --- | --- | --- |
| 相关安装器/升级回归 | 220 项通过 | `build/openclaw-10.10-upgrade/python-related-tests.log` |
| 安全兼容层、本地模型服务、微信收敛 | 222 项通过，实际 10.10 包参与，没有缺包跳过 | `build/openclaw-10.10-upgrade/desktop-tests.log` |
| 本地模型真实安装/热加载/下载确认 | 通过；不下载权重 | `build/openclaw-10.10-upgrade/desktop-real-tests.log`；其中早期 Cron 语法冲突已修复，后续 222 项回归通过 |
| 资源发布及陈旧核心拒绝 | 13 项通过 | `build/openclaw-10.10-upgrade/prepared-resource-tests.log` |
| TypeScript | 通过 | `build/openclaw-10.10-upgrade/typecheck-final.log` |
| Python 完整回归 | 486 项执行：478 通过、3 个既有测试框架失败、5 项 NSIS 测试因未指定编译器跳过 | `build/openclaw-10.10-upgrade/python-all-tests-final.log` |
| NSIS 自解压真实运行 | 显式指定已安装编译器后，5 项补验全部通过 | `build/openclaw-10.10-upgrade/nsis-runtime-tests.log` |
| 相关 TypeScript ESLint | 通过 | `build/openclaw-10.10-upgrade/eslint-related.log` |
| 微信完整打包运行时 | 20 项通过 | `build/openclaw-10.10-upgrade/weixin-runtime-tests.log` |
| EXE 冻结载荷覆盖迁移 | 1 项真实集成测试通过，0 跳过，用时 1072.30 秒 | `build/openclaw-10.10-upgrade/exe-migration-test.log` |
| 相关 Python Ruff / 格式 | 通过 | `build/openclaw-10.10-upgrade/ruff-related.log` |

已知既有问题：`test_installer_stub.InstallerArchiveTests` 的三个测试仅截取 `build.ps1` 片段，
没有提供该片段依赖的 `Start-BuildStage` 函数。HEAD 中原本已存在此调用；本次不修改无关的测试框架。

## 安装迁移验收方法

本机正在运行的原生资源有文件锁，因此构建在独立源码快照
`build/openclaw-10.10-upgrade/build-source/` 进行，不停止当前 MicroClaw，也不覆盖活动原生目录。
快照包括当前工作区源码和固定原生子模块；沿用相同版本的依赖，不带入真实用户配置。

测试入口：

- `scripts/verify_exe_upgrade_stage.py`：从 `/EXTRACT_ONLY` 解出的 EXE 读取冻结的 `deployer` 模块，执行真实安装器的数据/桌面步骤。
- `desktop/src/exe-upgrade-migration.integration.test.ts`：使用上述安装结果中真正的桌面 Node、内置核心和兼容预加载，连接实际 Gateway 验证迁移。

固定的隔离目录为 `build/openclaw-10.10-upgrade/installed-migration/`，必须具有显式标记文件。
安装器 Node prefix、桌面、状态、HOME、AppData 和临时文件均重定向到该目录；检测到目录外旧安装则拒绝继续。
进程清单仅包含测试进程，绝不停止目录外的用户实例。

验收顺序：

1. 使用 10.5 EXE 冻结载荷安装旧核心和桌面。
2. 用旧版实际 Gateway 写入会话与消息、配置、禁用定时任务、工作区/附件/凭据/模型缓存样本。
3. 停止测试 Gateway，用新 EXE 冻结载荷在同一用户目录覆盖安装。
   在真实 npm 替换完成后的 Doctor 调用边界注入一次非零退出，检查保留备份/恢复事务；重试须仅执行真实 Doctor，不重复 npm 替换。
4. 检查升级事务完成、备份实际存在且 SHA-256 与记录一致。
5. 启动内置 10.10 Gateway，验证历史记录、配置和定时任务，逐一比对文件内容。
6. 验证新消息可写入、重启后仍可读；重复同版本安装，再次确认历史与备份不被替换。
7. 验证实际启动兼容预加载后的 Cron 恢复回执。

### 最终结果

- 10.5 真实冻结载荷安装：已通过；记录为 `installed-migration/installed-2026.10.5.json`。
- 新 EXE 生成、自解压一致性和目标清单校验：已通过。
- 旧版 Gateway 最初冷启动超过 180 秒测试等待时间；补充实时日志、安装环境预加载/不重生设置，并允许冷启动等待后，旧版历史消息和禁用定时任务的写入/读取已通过。初次超时日志保留为 `exe-migration-attempt1.log`，不是迁移成功证据。
- 第二次尝试发现测试进程的 `VITEST=true` 会使 OpenClaw 官方运行时主动隐藏机器可读输出，导致备份 JSON 为空。已在外部进程边界清除测试标记和敏感环境变量，统一 UTF-8，并保存原始 stdout/stderr；未放宽正式安装器的严格备份解析/验证。独立备份探针返回 `verified: true`，随后真实冻结安装器的备份步骤也已通过。失败日志保留为 `exe-migration-attempt2.log`。
- 覆盖迁移、Doctor 失败恢复、重启和同版重复安装：全部通过。最终 Gateway 实际返回 `2026.10.10`。

最终机器可读结果：`build/openclaw-10.10-upgrade/installed-migration/migration-result.json`。

| 验收点 | 结果 |
| --- | --- |
| 旧版产生的会话和消息 | 升级后可读，重启及同版覆盖后仍可读 |
| 配置 | 工作区路径、heartbeat 禁用和技能禁用状态保留 |
| 定时任务 | 旧版创建的禁用提醒保留，名称和内容可读，没有触发执行 |
| 文件 | 工作区、附件、模型缓存和凭据样本的内容逐项一致，结果 JSON 留存 SHA-256 |
| 新数据 | 10.10 写入的新消息在重启、同版覆盖后仍可读 |
| Doctor 故障恢复 | 真实备份和 npm 替换后注入一次非零退出，事务保留；重试只执行真实 Doctor，不重复 npm |
| 同版覆盖 | 成功，官方升级命令列表为空，原备份摘要未变 |
| Cron 安全兼容 | 实际运行打包的兼容预加载，调度启动后的恢复回执已生成 |

本次状态备份位于：
`installed-migration/home/.microclaw/backups/openclaw-package/20261107T131513Z-01ab7712/state.tar.gz`
（相对 `build/openclaw-10.10-upgrade/`）。
SHA-256 为 `5862d5278f22bcbe01b88081a99bbf2880145a328cfeb2e20a24d18dfe369ccd`，
与实际文件重新计算值一致；事务最终状态为 `complete`。
这里的失败恢复是继续修复，不是自动降级或把旧数据库覆盖回新核心。

### 测试环境的预期警告

测试不启动完整桌面 UI 的后台组件准备流程，也不配置真实账号或 embeddings API 密钥。
因此 Doctor 会报告 Parallel 可选组件尚未准备、记忆搜索缺少 API 密钥，以及工作区缺少 memory 模板。
这些警告不能解读为相应业务已验收；本次验证的是核心数据迁移、配置/文件保留及本地 Gateway 读写。
正式推送前还应在完整桌面安装测试中检查搜索组件的延迟准备、微信登录态和实际模型调用。

## 复验方式

从仓库根目录运行，要求两版 EXE 的 `/EXTRACT_ONLY` 载荷已存在。
每次使用新的隔离目录，不要把已升级到 10.10 的目录重新当作 10.5 基线；命令不应指向真实用户 HOME。

```powershell
$root = (Get-Location).Path
$fixture = Join-Path $root ("build/openclaw-10.10-upgrade/migration-" + [guid]::NewGuid().ToString('N'))
$baseline = Join-Path $root 'build/openclaw-10.10-upgrade/baseline-10.5/payload'
$target = Join-Path $root 'build/openclaw-10.10-upgrade/target-10.10/payload'
New-Item -ItemType Directory -Path $fixture | Out-Null
New-Item -ItemType File -Path (Join-Path $fixture '.microclaw-upgrade-fixture') | Out-Null
& .\.venv\Scripts\python.exe .\scripts\verify_exe_upgrade_stage.py `
  --payload $baseline --fixture $fixture --version 2026.10.5 `
  --port 29451 --node (Get-Command node.exe).Source
if ($LASTEXITCODE -ne 0) { throw 'Baseline installation failed' }
$env:MICROCLAW_TEST_UPGRADE_FIXTURE = $fixture
$env:MICROCLAW_TEST_UPGRADE_TARGET_PAYLOAD = $target
Push-Location desktop
try {
  & .\node_modules\.bin\vitest.cmd run src/exe-upgrade-migration.integration.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Migration verification failed' }
} finally {
  Pop-Location
  Remove-Item Env:MICROCLAW_TEST_UPGRADE_FIXTURE
  Remove-Item Env:MICROCLAW_TEST_UPGRADE_TARGET_PAYLOAD
}
```

确认 Vitest 实际执行了 1 项测试，而不是因未设置环境变量而跳过。
最终判据是测试成功退出，以及对应目录生成 `migration-result.json`；不能以存在旧日志或单个 HTTP 200 判定通过。

## 发布门禁与限制

目录隔离不等于系统隔离。本次自动测试不执行真实 HKCU/PATH、Defender、快捷方式和图形安装 UI；
不能称为完整 Windows 用户点击安装验收。这部分须使用独立 Windows VM 或专用测试账号补验。

真实插件账号和模型权重仅保留，不在此测试中联网登录或运行模型；模拟样本的文件保留不等于所有第三方账号业务都已验证。
签名状态、最终安装包 SHA-256、下载链接与线上升级清单应在发布前单独核对。
构建包含工作区原有的其他未提交改动；本次只审核升级相关修改，发布前需确认整包改动范围。
任何数据库回退都须停机后恢复升级前完整备份，不应让旧核心直接打开升级后的数据库。
