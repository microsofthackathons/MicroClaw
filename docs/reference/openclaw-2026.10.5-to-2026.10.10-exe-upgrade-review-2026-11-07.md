# OpenClaw 2026.10.5 → 2026.10.10：MicroClaw EXE 升级评估

日期：2026-11-07，Asia/Shanghai。

范围：面向已有 MicroClaw 用户，发布新的 Windows 安装 EXE，由用户覆盖升级并保留原数据。不是只升级开发机上的全局 npm 包，也不是只替换 Electron EXE。

## 结论

**当前代码不能只改 OpenClaw 版本号就直接打包推送。** 已确认存在版本入口、内置运行时、MXC 审批适配、微信 SDK、本地模型五类发布阻断项；另外必须补上实际运行版本的交付验收，以及独立的 MicroClaw 产品版本和更新清单发布。

已有升级基础可以复用：停止旧进程、校验状态和工作区备份、固定版本 npm 替换、运行目标版本 Doctor、保存中断续修记录、拒绝自动降级。但这些机制尚不能证明 10.10 的真实安装产物和现有业务兼容。

本轮只做静态代码审查和构建资源元数据读取，新增本评估文档。没有修改产品代码、升级本机 OpenClaw、执行 Doctor、读取用户聊天/凭据、构建安装包或发布更新；没有运行测试。

## 1. 已核实的当前基线

| 项目 | 当前情况 | 证据 |
| --- | --- | --- |
| 安装器源码默认目标 | `2026.10.5` | `deployer/openclaw_version.py:10` |
| EXE 构建入口 | 参数白名单仅含 9.3、10.3、10.5，默认 10.5 | `build.ps1:3` |
| 冻结安装器实际目标 | 从打包内 `install-manifest.json.openClawVersion` 读取，覆盖源码默认值 | `deployer/openclaw_version.py:13` |
| 安装清单生成 | 使用 `build.ps1` 的 `$OpenClawVersion` 参数 | `build.ps1:303` |
| MSIX 资源目标 | 从 Python 源码常量读取，和 EXE 清单不是同一个读取入口 | `desktop/scripts/prepare-resources.mjs:12` |
| 产品版本 | 源码为 `1.0.0`；不代表所有已发布用户版本都相同 | `desktop/package.json:3` |
| 内置 OpenClaw | 本地现存 `desktop/resources/openclaw.asar` 内部版本实际为 `2026.10.5` | 只读解出 ASAR 内包元数据核实 |
| 内置依赖 | 同一 ASAR 中 `@openclaw/fs-safe` 为 `0.25.0` | 只读读取包元数据核实 |
| Node 要求 | 上游 10.5、10.10 标签均声明 `>=24.16.0 <25 || >=26.1.0`；本机为 `v26.13.0` | 官方标签 `package.json` 与本机 `node --version` |

Node 最低版本范围没有因本次目标版本改变，但仍需分别核验构建 Node、安装器安装的 Node、桌面内置 `node.exe` 和实际 Gateway 进程使用的 Node。仅本机版本满足要求不代表用户安装产物满足。

## 2. 发布前必须解决的阻断项

### P0-A：版本入口不能分叉

涉及：`build.ps1:3`、`deployer/openclaw_version.py:10`、`scripts/windows/setup-dependencies.ps1`、CI 工作流、版本断言和相关说明。

- 目前直接传入 `-OpenClawVersion 2026.10.10` 会被参数白名单拒绝。
- 只改 Python 默认值仍不够：EXE 清单使用构建参数，冻结后的安装器又以清单为准；MSIX 资源脚本则直接读取 Python 默认值。
- 发版时必须验证源码默认值、构建参数、安装清单、内置包、实际 Gateway 握手版本全部一致。
- `deployer/windows_setup.py` 会把目标版本用于 Parallel 插件以及本地模型插件的版本选择。必须核对相应插件发布包是否存在、是否兼容，不能假设所有插件都有同号 10.10 发行版。

验收：不允许出现“清单写 10.10，EXE 内装 10.5”或“EXE 与 MSIX 的目标不同”。

### P0-B：旧内置 ASAR 会优先于新装的 npm 包

涉及：`desktop/electron-builder.yml:71`、`desktop/src/path-resolver.ts:136`、`desktop/src/bundled-runtime.ts`、`desktop/src/runtime-archive.ts`、`desktop/package.json:16`。

已确认的链路：

```text
build.ps1
  → prepare-packaged-resources：Windows Node + 微信资源
  → pack:prepared：打包 Electron
  → electron-builder 纳入 resources/openclaw.asar

桌面启动
  → 优先解析内置 openclaw.asar
  → 再考虑安装器安装的 ~/.openclaw-node 或全局 npm OpenClaw
```

`prepare-packaged-resources` 不负责生成新的 OpenClaw ASAR；生成 ASAR 的是另一条 `prepare-resources` 路径。本地现存 ASAR 实际仍为 10.5。

因此，仅升级安装器的 npm 目标可能造成：安装器把外部运行时升成 10.10，桌面却仍从内置 10.5 启动。缓存重建开关也不能代替缺失的资源生成步骤。

必须明确资源策略：若 EXE 携带内置核心，就在打包前生成并验明 10.10 的 Node/OpenClaw 资源；若 EXE 设计为只使用安装器安装的核心，则应明确避免混入并优先加载旧 ASAR，不能靠构建机器上“恰好没有这个文件”。

注意：现有 `prepare-resources.mjs` 会重新准备整个资源目录，并涉及网络安装和其他资源准备，不应未经评估就直接在生产工作目录执行。

### P0-C：MXC 审批适配明确拒绝 10.10

涉及：`desktop/src/openclaw-approval-replay-compat.mjs:53`、`desktop/src/openclaw-approval-replay-compat.mjs:1976`、`desktop/src/main.ts:6358`。

- 该适配器使用已验证版本对应的编译模块名、SHA-256 和源码变换点，不是通用跨版本补丁。
- 当前版本表没有 10.10；`validatePinnedOpenClawApprovalPackage()` 对未支持版本直接抛错。
- 在启用对应 MXC 审批或相关启动预加载路径时，未知版本会导致预加载失败，而不仅是某个按钮不可用。
- 适配范围还涉及 node 调用、执行审批、命令宿主约束、cron、hooks、canvas 等能力，不能只验证一次普通聊天。

必须以官方 npm 实际发行包审核变换点和安全语义，决定哪些兼容逻辑仍需要保留，再加入验证过的 10.10 描述。不能只改 `EXPECTED_VERSION`、机械更新哈希，或取消未知版本拒绝和哈希校验。

### P0-D：微信宿主 SDK 是精确匹配

涉及：`plugins/openclaw-weixin/package.json`、`desktop/scripts/prepare-weixin-plugin-resource.mjs:162`、`desktop/src/weixin-plugin-convergence.ts:10`、`desktop/src/weixin-plugin-convergence.ts:186`、`deployer/windows_setup.py:4118`。

- 当前微信插件为 `@tencent-weixin/openclaw-weixin@2.4.6`，MicroClaw 自有 SDK 兼容声明固定为 10.5。
- 资源准备脚本、运行时 manifest 校验、宿主校验和安装器检查都有对应约束。
- 虽然插件的普通 peer 范围写得更宽，MicroClaw 的实际宿主校验仍要求 `packageJson.version === manifest.sdkCompatibility`，10.10 不会因此自动通过。

需要针对 10.10 重新验证 SDK exports、编译后的插件资源、依赖清单及来源校验，再同步兼容声明。升级回归必须保留已有账号、启用/禁用状态、allowlist 与配对策略；覆盖收发消息、媒体和远程审批，不应默认要求用户重新扫码。

### P0-E：本地模型版本判断和固定来源不支持 10.10

涉及：`desktop/src/local-model-service.ts:200`、`desktop/src/local-model-service.ts:206`、`desktop/src/local-model-service.ts:213`、`desktop/src/openclaw-local-model-compat.mjs:10`。

- `supportsLocalModelGatewayVersion()` 当前仅允许特定 10.2/10.3/10.5 和部分 9.x 宿主，10.10 会被判为不支持。
- `providerVersionForGateway()` 对非 10.5 宿主会选择旧 provider 分支；仅放宽宿主白名单可能引入错误的 provider 选择。
- provider 版本、入口源码哈希、配置模块名和配置源码哈希另有固定约束，不能仅修改 UI 的支持列表。

必须选定一个真实发布且验证兼容的 provider，检查 setup/wizard RPC、精确模型选择、下载许可、既有缓存复用、热加载和模型路由。保留 ModelScope 来源限制、下载哈希和“不自动替用户选择其他模型”的行为。

`openclaw-state-owner-compat.mjs` 的旧版本适配和 `openclaw-fs-safe-compat.mjs` 的依赖版本适配也需要单独审核。版本不适用时不应强行套用；本地 ASAR 实际 fs-safe 已是 0.25.0，不能仅因为存在固定 0.8.5 的兼容脚本，就认定当前运行时在使用该旧依赖。

## 3. 升级事务与数据迁移注意事项

### 3.1 当前真正执行的是受控 npm 升级

以现有代码为准，`deployer/windows_setup.py:2276` 的流程是：

```text
停止旧桌面/Gateway，检查运行进程与事务锁
  → 原版本 backup create --verify --json
  → 核实完整 state/workspace 备份计划并保存 SHA-256
  → 在原 npm prefix 安装精确目标版本
  → 目标版本 doctor --fix --non-interactive
  → 验证目标安装包版本和停止状态
  → 安装/备份 MicroClaw 托管文件，完成桌面安装与配置
```

这条路径不依赖旧版本 `openclaw update`。`docs/reference/openclaw-official-upgrade-test.md` 仍有历史流程描述，不能直接拿旧文档当作本次发版操作步骤；实现完成后需同步修正文档。

### 3.2 核心迁移失败与托管文件回滚是两回事

- npm/Doctor 阶段保留经过校验的数据备份和中断记录，重跑同一目标安装器续修，不自动恢复旧核心或旧数据。
- 后续 `prepare_openclaw_upgrade()` 建立的是 `MANAGED_STATE` 事务，主要覆盖 MicroClaw 托管的配置、桌面、插件等选定文件，不能当作已经具备完整的旧核心/数据库自动回滚。
- 官方 10.10 兼容说明提到 agents schema 从 20 迁移至 22、usage schema 从 25 迁移至 27；新触发器/事件还可能涉及旧版本不能识别的存储。不能假设把旧 EXE 覆盖回来就能安全读取新数据。
- 真正的人工回退必须停止新进程，按验证过的方案配套恢复旧核心和升级前数据；升级后的新增数据需要另行保全。不能静默用旧快照覆盖用户新增消息。

### 3.3 必须保留现有安全拒绝条件

- 发现比目标更高版本时拒绝自动降级。
- 待修复事务目标与新 EXE 目标不一致时，保留原备份和记录，并明确提示先用原目标安装器续修。
- 自定义 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_HOME` 不符合自动迁移范围时，在替换前拒绝并提示人工处理；自定义 workspace 与自定义 state 不是同一个限制。
- 备份失败、校验不通过、磁盘不足、旧进程未退出时，不进入破坏性替换，不为“继续安装”跳过这些检查。

## 4. 当前成功判定不足以证明交付成功

涉及：`deployer/windows_setup.py:2896`、`deployer/windows_setup.py:3068`、`deployer/webview_bridge.py:735`。

- 主安装流程最后调用版本校验并提交事务，版本校验检查的是检测到的安装包，不是桌面实际加载的内置运行时。
- 即使另行调用现有 `/health` 检查，它也只确认 HTTP 200，不核实正在运行的 Gateway 版本和关键功能。

所以发布验收必须启动从最终 EXE 安装出来的真实桌面，读取 Gateway 握手返回的版本并核对 10.10、实际进程路径与使用的 Node，同时完成聊天和关键插件操作。安装器显示“成功”、源码版本正确、某个端口健康、单元测试全绿，均不能单独替代这一步。

应优先增加隔离的发布集成验收，不应未经设计就让每次普通安装额外启动多个 Gateway 或重复 Doctor。

## 5. 用户升级分发不是只上传一个文件

### 5.1 MicroClaw 产品版本必须独立递增

`desktop/src/update-checker.ts:114` 只比较更新清单的 `version` 与 `app.getVersion()`；`openclawVersion` 只是附带字段，不参与是否有更新的判断。

因此，必须选定高于已发布产品版本的 MicroClaw 版本，并同步产品包、EXE 文件属性、发布 tag 和清单。只把 `openclawVersion` 改成 10.10，用户可能仍看到“已是最新版本”。本轮不替用户擅自确定新的产品版本号。

### 5.2 当前更新入口是手动下载，不是静默自动更新

`desktop/src/constants.ts:110` 指向 `https://microclaw.microsoft.com/releases/latest.json`。设置页检查后通过 `openExternal(downloadUrl)` 打开下载链接；当前不是自动下载、校验、关闭旧程序、运行安装器并重启的完整更新器。

当前 GitHub Release 工作流上传安装 EXE，仓库内未见它同步生成并发布上述 `latest.json` 的步骤。如果清单由外部服务维护，需要把该服务纳入本次发布流程，不能把 GitHub 上传成功等同于用户收到升级提示。

### 5.3 发布正确的产物

- 面向普通用户的单文件入口是 `dist/MicroClawSetup.exe`：NSIS 封装 Python 安装器及桌面载荷，运行完整安装/升级流程。
- 不应仅把 `MicroClawDesktop.exe` 或 electron-builder 单独生成的桌面安装包当成完整的核心升级包。
- 若仍同时发布 MSIX，需独立核验其内置核心、Node 和资源，并避免 EXE/MSIX 目标版本分叉；Store 管理的更新不走普通手动下载分支。
- 单文件 EXE 不等于完全离线：现有安装器仍可能下载 Git、Node、npm 核心和插件。需测试受支持网络、镜像、代理及企业 TLS 条件。
- 正式推送应校验最终 EXE 的 Authenticode 签名和 SHA-256，并先放置不可变安装文件，再更新清单。现有工作流在未配置签名时只警告并仍可产出安装包，生产发布应有明确放行要求。

## 6. 必须完成的回归矩阵

以下是待执行验收，不是本轮已通过的测试。

| 场景 | 核验重点 |
| --- | --- |
| 全新 Windows 安装 | 用户无需 Python；Node、核心、微信、桌面全部来自目标产物；最终 Gateway 为 10.10 |
| 正常 10.5 → 10.10 | 有真实历史、配置、API 设置、workspace、技能和附件的隔离用户快照；升级后保留并可使用 |
| 已有微信账号 | 登录状态、禁用策略、配对和 allowlist 保留；文本/媒体收发及远程审批正常 |
| 本地模型用户 | 未安装 provider 首装、已安装升级、已有权重缓存、精确选择、取消、热加载和原模型路由 |
| MXC / Windows Node | 显式许可、拒绝、一次性审批、不可伪造/重放、目录隔离、不降级到错误执行宿主 |
| cron / hooks / canvas | 旧任务、启动恢复、暂停围栏、禁止未获授权的执行、副作用和节点能力 |
| 会话和 Agent | 历史读写、流式回复、停止、重连、会话与 Agent 归属、附件、后台任务和用量统计 |
| 同版本重装 | 10.10 重装保持幂等；正常完成后不重复 Doctor；未完成的迁移仍按记录续修 |
| 强制中断 | 分别在备份、npm 替换、Doctor、桌面替换、配置写入后中断；保留证据并可续修 |
| 异常输入 | 备份篡改、事务锁冲突、另一目标的待修复记录、自定义 state、较新版本、磁盘不足 |
| Windows 真实环境 | 普通用户权限、中文/空格路径、AV/WDAC 环境、文件占用、长路径、冷启动 |
| 网络失败 | 镜像尚未同步、代理/TLS、下载中断、断网重试；不因此放宽哈希或证书验证 |
| 最终 EXE | 从最终签名 EXE 安装，不以开发环境或 `win-unpacked` 替代；记录进程路径及握手版本 |
| 用户发现更新 | 新产品版本触发检查；清单链接下载到正确签名文件；原用户覆盖升级成功 |

可复用的现有测试包括：

- `tests/test_openclaw_version.py`、`tests/test_official_openclaw_update.py`、`tests/test_openclaw_package_upgrade.py`、`tests/test_openclaw_upgrade.py`。
- `tests/test_installer_runtime.py`、`tests/test_installer_stub.py`、`tests/test_build_cache.py`。
- `desktop/src/openclaw-approval-replay-compat.test.ts`、`desktop/src/weixin-plugin-convergence.test.ts`、`desktop/src/openclaw-upgrade-recovery.test.ts`、`desktop/src/local-model-service.test.ts`。
- 真实 provider/运行时集成测试必须提供对应 10.10 夹具并确认实际执行；例如 `local-model-preparation.integration.test.ts` 缺少环境变量时会跳过，不能把跳过算通过。

## 7. 建议实施与放行顺序

补充：评估期间工作区出现其他进行中的连接器、主进程和界面改动，本轮没有修改或清理它们。正式打包前必须确认发布范围并冻结构建快照，不能把尚未验收的并行工作无意带进用户升级包，也不能为获得干净目录而直接重置当前工作区。以上源码行号对应审查时的快照，后续并行编辑可能使行号变化。

1. 先核实官方 10.10 npm 包与插件产物、来源完整性、Node 和原生依赖，保存可复现的干净资源。
2. 适配 MXC、微信、本地模型及必要的旧版本兼容层，保持未知版本/源码拒绝与来源校验。
3. 统一各入口的版本策略，决定 EXE 是否携带内置核心，并加入清单、ASAR、实际运行版本的一致性验收。
4. 更新真实 10.10 夹具和版本断言，再做针对性测试、全量回归、旧用户快照升级与中断恢复测试。
5. 确定新的 MicroClaw 产品版本；从干净构建资源打出完整 EXE，核验内部版本、签名、SHA-256 和最终安装行为。
6. 内测/小范围发布安装包，观察安装失败、首启失败、实际版本、数据可用性和插件问题；备份仍保留可取证。
7. 再更新正式用户清单和发布说明，明确数据备份位置、失败续修方式和降级限制。发布说明只承诺 MicroClaw 已接入并验证的能力，不把上游 Web UI 的新增按钮自动算作本产品功能。

## 8. 上游资料与未完成验证

官方资料：

- 10.10 发布与兼容说明：`https://docs.openclaw.ai/releases/2026.10.10`。
- 10.5 源码标签元数据：`https://raw.githubusercontent.com/openclaw/openclaw/v2026.10.5/package.json`。
- 10.10 源码标签元数据：`https://raw.githubusercontent.com/openclaw/openclaw/v2026.10.10/package.json`。

本轮访问官方 npm 元数据时，沙箱内先遇到 DNS 错误；经批准的联网重试以及系统 HTTPS 客户端均遇到 TLS 握手失败，没有关闭证书校验。因此没有下载、校验或启动官方 10.10 npm 实际发行包，也没有验证目标插件包是否存在及其编译模块哈希。

源码标签中的 Node 要求和公开发布说明可以作为评估依据，但不能代替最终 npm 发行包的完整性与兼容性验收。本文中的确定性阻断项来自现有 MicroClaw 代码和本地已存在资源；10.10 的真实运行、插件兼容和升级成功率仍需实施后测试。
