# OpenClaw Web UI 与 MicroClaw 设置能力差异报告

调研日期：2026-11-03（Asia/Singapore）

用途：产品补齐决策，不是要求照搬 OpenClaw 的全部管理后台。

## 1. 结论摘要

**MicroClaw 已覆盖“安装后选模型、聊天、连接微信、管理本地保护”的主流程，但还不是完整的 OpenClaw 管理客户端。** 最大差距不在主题或图标，而在智能体配置、技能管理、会话策略、扩展管理、可诊断性以及配置变更的统一体验。

需要特别注意三个边界：

1. **有代码不等于正式用户可用。** 技能面板只在开发模式并打开专用开关时出现；定时任务视图没有注册路由；详细用量抽屉没有发现挂载入口。[M1][M4][M5][M10]
2. **缺少界面不等于缺少后端。** 模型变更、会话模型、技能查询、Cron 查询、详细用量已有不同程度的后端/IPC 支撑，补齐成本不同。[M2][M4][M5][M10][M11]
3. **部分差异是 MXC 的安全取舍，不应直接补一个“开启”按钮。** MXC 保护期间，浏览器自动化、MCP、默认网关记忆等被禁用，Cron 和 Hooks 被暂停，其他渠道及插件也受允许列表约束。第一步应展示“为什么不可用”，而非绕过保护。[M12][M13]

建议的补齐顺序：

| 顺序 | 建议 | 为什么先做 |
| --- | --- | --- |
| P0 | 设置中的“实际生效状态 / 被策略限制原因 / 变更影响” | 防止用户把安全策略拒绝误认为功能故障；保护模式不能只看配置值 |
| P0 | 系统诊断页：实际组件版本、启动阶段、失败原因、脱敏诊断包 | 新机器安装、启动和插件问题目前较依赖手工取日志 |
| P0 | 统一配置提交与错误恢复 | 模型路径已有校验与冲突保护，但不能假定全部设置路径都具备同样能力 |
| P0 | 明确隐私保护覆盖范围 | 已证明的自动脱敏位于桌面聊天文本发送路径，不等于全渠道、附件及工具结果的统一出站防护 |
| P1 | 将技能管理产品化 | 已有开发面板和后端，属于高价值的已有能力补入口 |
| P1 | 智能体设置：身份、指令文件、默认模型、工具/技能能力 | 目前偏“选择预置智能体”，缺少完整的可配置个人助手 |
| P1 | 模型回退链、按用途模型、会话/上下文策略 | 不只是“能添加供应商”，还要处理长任务稳定性、成本与模型失效 |
| P1 | 搜索与网页读取的完整控制 | 目前只暴露搜索提供方和 Key；没有搜索/抓取总开关、限额及超时等常用项 |
| P2 | 插件中心、MCP、自动化、更多渠道 | 先完成权限与 MXC 兼容设计，再开放可执行配置 |
| P2/P3 | 远程 Gateway、多设备、语音、云工作环境等 | 与当前 Windows 本地桌面定位有关，不宜按上游功能数量机械追齐 |

不提供“设置覆盖率百分比”：上游有专用页面、动态 Schema 表单和管理操作三个层次，部分页面依赖插件、角色或平台；混成一个百分比会误导。

## 2. 范围、版本与可信度

### 2.1 比较基线

| 项目 | 本次基线 |
| --- | --- |
| MicroClaw 源码 | 当前工作区，HEAD `5793e64`；包含工作区尚未提交的安装修复，不擅自切分支或更新远端 |
| MicroClaw 桌面包声明 | `desktop/package.json` 的版本为 `1.0.0`；不以此代替实际安装包构建身份 |
| 固定的 OpenClaw 版本 | `deployer/openclaw_version.py` 指定 `2026.10.5` |
| 实际检查的 OpenClaw 包 | 本地安装烟测目录中的 `openclaw` npm 包，`package.json` 同样为 `2026.10.5` |
| 该包构建信息 | commit `1b58cb9a1b4f4353e1add63c8506db4d890962e8`；`builtAt: 2026-10-18T17:23:40.943Z` |
| 上游证据 | 该包自带的 `docs/web/control-ui/`、配置参考，以及 `dist/control-ui/assets/` 的页面模块 |
| 在线资料 | OpenClaw 官方 Control UI / Configuration 文档补充核对；在线页面会滚动更新，不将较新版本字段自动算成当前固定版本能力 |

包版本日期和 `builtAt` 不同，报告分别记录，不推断安装时间，也不把在线文档当成本地运行时的精确快照。[V1][O1][O2]

### 2.2 调研方法

- MicroClaw：沿“路由/可见性 → 组件控件 → Store / preload IPC → 主进程或 Gateway 写入”追踪，避免只看文案。
- OpenClaw：以随固定包发布的功能/RPC 参考和设置说明为主，检查打包页面模块确认页面存在；配置字段用随包配置参考定位。
- 区分“专用管理页面”和“通过通用 Schema 编辑的字段”。**某字段在配置参考中出现，不代表每个字段都有精心设计的独立控件。**
- 没有启动用户 Gateway、连接外部供应商或操作真实账号；没有读取用户密钥和真实配置文件。
- 这是源码与随包资料的静态能力审计，不是逐个按钮的实机验收。权限角色、插件安装状态、特定平台入口以及运行时 Schema 的最终表现仍须验收。

状态约定：

| 标记 | 含义 |
| --- | --- |
| 已有 | 正式设置里有对应控件及调用路径，不代表已经完成本次实机验证 |
| 部分 | 只覆盖部分字段、只读状态，或缺少闭环 |
| 设置外已有 | 聊天、侧栏或其他正式入口已提供，不算完全缺失 |
| 隐藏/未接入 | 有代码或 IPC，但生产用户不能正常从当前路由/导航进入 |
| 缺入口 | 当前检查范围未发现正式配置页面；不推断 OpenClaw 后端不支持 |
| 策略限制 | MXC 下明确禁用、暂停或收窄；开放需要安全设计，不只是增加 UI |
| 平台/可选 | 依赖插件、管理员权限、原生宿主或产品定位，不要求默认开放 |

## 3. OpenClaw Web UI 的配置全景

### 3.1 不只是一个 Config 页面

随包功能参考描述的设置导航包括以下几组；菜单会随权限、平台及功能能力变化。[O1][O2]

| 领域 | 页面/入口 | 可以配置或管理什么 | 类型 |
| --- | --- | --- | --- |
| 个人与呈现 | Profile、Appearance、Notifications | 个人身份、头像、语言、主题、字体、字号、聊天显示、通知偏好；部分个人身份能力需要对应身份服务 | 专用页面 + 用户偏好 |
| Gateway 连接 | Gateway | 此客户端连接的 URL、Gateway secret、默认会话，以及连接与宿主状态 | 专用页面；客户端连接与服务端配置分开 |
| 消息接入 | Channels、Communications | 渠道状态、支持的登录/配对、渠道配置、共享消息策略 | 专用页面 + Schema；依赖渠道插件 |
| 语音 | Talk | 语音相关配置；麦克风等原生设备能力依赖宿主 | 专用/平台相关 |
| 多设备 | Devices | 已配对设备与节点、在线状态、角色、令牌、能力、配对处理与移除 | 专用管理页面 |
| 智能体 | Agents | 身份、模型及回退链、工作区文件、Tools、Skills、Channels、Automations、Memory | 按智能体作用域的专用页面 |
| 模型 | Models、provider/setup 流程 | 提供方连接、认证状态、模型可用性、全局默认/工具用途模型、回退、思考/快速模式；有数据时展示额度/计费 | 专用页面 + Schema |
| 技能 | Skills、Skill Workshop | 技能状态、启停、安装、API Key；工作坊为额外创作入口 | 专用页面；安装能力有条件 |
| 扩展 | Plugins | 本地插件清单、启停、安装/移除、目录发现及插件自身配置 | 专用管理页面 + 插件 Schema |
| MCP | MCP | `mcp.servers` 的传输、认证、过滤、超时、启停、增删 | 专用页面 + Schema；配置存在不等于连接成功 |
| 记忆 | Memory、Memory import | 记忆状态/配置、部分记忆导入与诊断 | 专用/插件相关 |
| 自动化 | Automation / Automations | Cron 任务增改、启停、手动运行、任务/运行历史筛选 | 专用管理页面，不只是 cron 表达式输入框 |
| 权限与安全 | Security、Secrets、Approvals | 网关认证、工具/执行策略、密钥及环境项、待审批和已决审批历史 | 专用页面 + Schema；权限受控 |
| 实验与基础设施 | Labs、Infrastructure、Advanced | 工具实验功能、宿主/网络等高级配置、通用配置编辑 | 专用摘要 + Schema |
| 运维 | Debug、Logs、About / Updates | 状态/健康/模型快照、事件与诊断、实时日志筛选导出、版本检查及更新进度 | 运维页面；更新方式依安装类型而定 |
| 设置外管理 | Sessions、Usage、Activity、Meetings 等 | 会话元数据/覆盖项、用量筛选与导出、活动及会议记录 | 不是全部属于“设置”，比较时单列 |

实际打包产物还含 `cloud-workers-page`、`worktrees-page`、`terminal-page`、`dashboards-page`、`portals-page` 等模块。**模块存在只能证明包内含实现，不能证明当前角色、平台或插件条件下都会显示。** 这些扩展工作台不作为 MicroClaw 的默认必补清单。[O4]

### 3.2 通用配置能覆盖哪些域

OpenClaw 通过 `config.schema` / `config.schema.lookup` 生成字段标题、描述、基础/高级分层、插件与渠道表单；对于允许安全往返编辑的快照，还提供原始配置编辑。下面是配置域清单，不是承诺每一字段都有专用 UI。[O1][O3]

| 配置域 | 代表路径/内容 | MicroClaw 比较时应关注什么 |
| --- | --- | --- |
| 模型连接与目录 | `models.providers`、认证资料、模型元数据 | 能编辑已有自定义连接，但新建入口不完整；认证、目录和模型参数不能混成一个状态 |
| 全局及用途模型 | `agents.defaults.model`、`utilityModel`、`imageModel`、`pdfModel`、`mediaModels` | 主模型之外还有有序回退及按用途选择 |
| 智能体工作区 | `agents.defaults.workspace`、`cwd`、`repoRoot`、引导文件及上下文预算 | 工作目录与文件授权是两回事 |
| 运行策略 | heartbeat、compaction、context pruning、流式输出、并发与运行限制 | 长会话稳定性、成本与后台行为 |
| 多智能体 | `agents.entries`、`multiAgent` 及绑定 | 全局默认、智能体覆盖、渠道绑定分开显示 |
| 会话 | `session.*` | 会话隔离、身份链接、重置、共享与保留策略 |
| 消息与语音 | `messages.*`、`talk.*` | 消息队列、回复呈现、语音输入/输出；不是全部 Windows 桌面必需 |
| 渠道 | `channels.*`、`commands.*` | 私聊/群聊访问、配对、提及规则、多账号、指令权限 |
| 工具总策略 | `tools.*`、按模型/发送者覆盖 | 预设与 allow/deny、生效预览、不同执行边界 |
| 执行命令 | `tools.exec`、审批策略 | 宿主、节点、审批与允许列表；不能替代 MXC 文件边界 |
| 搜索与抓取 | `tools.web.search`、`tools.web.fetch` | 启停、提供方、结果/字数/响应体限制、超时及缓存 |
| 浏览器 | `browser.*` | 浏览器配置、连接/配置文件、远程控制相关设置 |
| 技能 | `skills.*`、智能体技能选择 | 全局启用与某智能体可见范围不同 |
| 插件 | `plugins.*`、各插件配置 Schema | 安装代码、启用插件、授权能力是不同操作 |
| MCP | `mcp.servers` | stdio / Streamable HTTP / SSE、认证、工具过滤与证书等 |
| 记忆 | `memory.*`、记忆插件配置 | 搜索、引用、索引、记忆插件；区分聊天记录 |
| 自动化与事件 | `cron.*`、`hooks.*` | 定时、投递、失败告警、Webhook 和 Gmail 等可选集成 |
| Gateway 服务 | `gateway.*` | 绑定、端口、认证、TLS、远程/节点、Control UI、HTTP 接口、重载 |
| UI 与设备 | `ui.*`、`desktop.*`、`gateway.controlUi.*` | 前端偏好与服务器公开面、安全项分开 |
| 环境与凭据 | `env.*`、`secrets.*`、认证存储、`$include` | SecretRef、环境替换、配置拆分，不能当普通字符串覆盖 |
| 日志与可观测 | `audit.*`、`logging.*`、`diagnostics.*`、`telemetry.*` | 日志级别、审计、诊断和遥测应单独解释 |
| 基础设施/更新 | `update.*`、`discovery.*`、ACP、云工作环境、存储等 | 依部署场景选做，不应塞进普通用户的首屏 |

配置参考中示例 Key 的层级也会演进。例如随包文档把搜索提供方凭据说明放在插件配置下，而当前 MicroClaw 搜索面板写入 `tools.web.search`。这里不据文档单独判定故障，建议把**当前运行时 Schema 校验和真实搜索验证**列为兼容性验收项，避免继续按过时字段扩展。[O3][M1]

### 3.3 容易忽略的“配置编辑能力”

上游的差异不只是字段多，还包括：[O1][O2]

- 设置搜索覆盖页面及字段；基础项先展示，高级项折叠。
- 区分全局配置、选中智能体、当前客户端/用户偏好。
- 表单显示有效默认值；原始编辑有安全往返限制，不能简单理解为无条件 JSON 文本框。
- 保存/应用走验证，使用 base hash 防止覆盖其他客户端修改。
- 保存失败保留草稿，提供原因、重试、放弃并重新加载；连接切换时不把草稿写入另一个 Gateway。
- 处理密钥遮罩、SecretRef 和空值，防止把占位符或对象误写成字符串。
- 明确需要重启的操作和结果；更新也有确认及运行版本核对。

## 4. MicroClaw 当前正式设置盘点

### 4.1 七个正式分区

当前生产菜单是：**通用、用量、模型、频道、安全、隐私、关于**。`/settings/:section?` 的有效分区白名单与此一致；技能只有开发条件满足时加入。[M1][M4]

| 分区 | 已有控件/动作 | 状态及边界 |
| --- | --- | --- |
| 通用 | 开机启动、最小化到托盘；浅色/深色/跟随系统；Gateway 连接状态、重启；网关日志导出 | 语言下拉有实现但 `v-show="false"`，不是用户可用的语言设置；没有完整 Gateway 参数表单 |
| 用量 | 刷新；花费、30 天会话/消息/输入输出 Token、缓存读取、总 Token、工具调用；按模型汇总 | 主要为只读汇总。预算条模板存在，但当前后端返回 `maxBudget: null`，不能算预算功能 |
| 模型 | 全局默认模型；千问、MiniMax 连接；已有自定义提供方的编辑/移除；模型目录刷新和可用性提示 | 已有自定义连接的编辑器含 ID、Base URL、API Key、模型名和三种协议；全新配置没有通用“新增自定义提供方”入口，不能算完整自定义接入闭环 |
| 模型：本地 | 官方 llama.cpp 组件安装、候选模型准备/下载、操作状态及激活；连接移除 | 这是已有能力，不应在差距表写成“缺本地模型”；高级运行参数另论 |
| 模型：联网搜索 | Parallel（免 Key）、Brave、Tavily；当前提供方、对应 Key、保存 | 没有完整的 search/fetch 控制。页面提示称保存后重启，但当前保存函数本身未显式请求重启，应按运行时实际行为统一提示 |
| 频道 | 微信状态、二维码登录/取消、断开、查看消息；其他渠道连接状态卡片 | 其他渠道卡片不是渠道配置向导；微信有单账号一致性与状态恢复逻辑，不能算通用多账号管理 |
| 安全 | MXC 保护开关和状态、不可用/失败原因、验证信息、有限隔离说明；批准目录的只读/读写、增删和转换 | 文件夹改动是草稿，明确应用后执行安全转换；可暂存上一份策略恢复，不是点完立刻放权 |
| 安全：命令 | 记住的精确命令、工作目录/声明访问/会话代理作用域、创建/最后使用；逐条或全部撤销 | 当前模板在非有限隔离分支显示；不是全部历史审批记录，也不是 OpenClaw exec 通配允许列表 |
| 隐私 | 基础/严格模式；手机号、身份证、银行卡、邮箱、API Key 五类检测开关；敏感文件模式说明；清除全部聊天记录 | 已有桌面聊天文本脱敏。敏感文件列表是静态说明而非可编辑规则；覆盖范围需独立验收 |
| 关于 | 版本文案、检查更新、更新状态和发布说明、打开下载入口、许可与隐私链接 | 当前显示版本使用翻译文案 `版本 1.0.0`；没有实际 Gateway/Node/插件/构建身份总览；不是上游式原地更新控制台 |

对应默认应用偏好：开机启动为关、最小化到托盘为关、主题为浅色、隐私为基础。此处是代码默认值，不表示某用户机器当前设置。[M15]

### 4.2 不能误算成“完全没有”的能力

| 能力 | 已有位置 | 正确结论 |
| --- | --- | --- |
| 当前会话切换模型 | 聊天模型选择器及会话模型服务 | 设置外已有；缺的是更完整的默认/回退/用途策略，不是没有切模型 |
| 会话管理 | 侧栏新建、切换、置顶；主会话重置、其他会话删除 | 基础管理已有；保留/压缩/隔离策略缺入口 |
| 多智能体 | 头像列表切换，智能体目录添加/删除预置项 | 不是单智能体应用；但“自定义智能体”标签目前是空态，没有配置编辑器 |
| 技能管理 | `SkillsDevPanel`，技能状态和按智能体/全局开关相关 IPC | 隐藏于开发条件，不是正式设置能力；不是完全从零做后端 |
| Cron | `TasksView`、任务 Store、`cron.list` IPC | 视图没有注册路由，IPC 只有查询；不能说正式支持完整定时任务管理 |
| 详细用量 | `UsagePanel`、`getDetailedStats` IPC | 有组件和后端，但未发现正式挂载/打开入口；不是设置页已支持任意筛选 |
| 插件 | `/plugins` 路由 | 当前页面只复用微信连接卡，不能凭名字算通用插件中心 |
| 命令审批 | 全局 `PermissionDialog` 和 MXC 审批链路 | 实时审批已有；仍缺完整审批历史与解释中心 |
| 微信远程审批 | MXC 微信远程审批相关主进程/原生契约 | 已有实现，不计成“完全缺失”；本报告不将其等同于通用多设备授权后台 |
| 配置冲突保护 | 模型提交路径的 expected config、Gateway `baseHash`、连接代际及保存结果检查 | 已有专门实现；缺的是把可靠性模式覆盖其他设置，而非全部没有校验 |
| 旧模型设置向导 | `/setup` 的 Base URL、Key、协议和 reasoning effort 表单 | 不再启动时自动展示，App 初始化还会从该路径跳回聊天；不能据此认定正式设置有完整协议/思考等级入口 |

**自定义提供方的入口是一个实际产品缺口。** `providerCards` 只从预置项和已配置模型生成卡片；模型选择对话框的 family 列表没有新建 custom 项，但仍保留已有 custom 的编辑代码。现有测试也明确断言：空配置不显示兼容 API 入口，已有 custom 连接可编辑。不能把“旧连接可编辑”写成“用户可自由新增任意提供方”。[M2][M16]

## 5. 逐项差异矩阵

上游列的“页面”指专用交互，“Schema”指通用配置编辑覆盖的领域；依赖插件/管理员能力的项不保证每次连接都显示。优先级是产品建议，不是发现故障的严重级别。

### A. 基础体验与配置可发现性

证据：[O1][O2][M1][M15][M16]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| A01 | 界面语言 | Appearance 中可选择语言 | 隐藏：语言控件 `v-show="false"`；中英文资源已有 | P2：明确是否恢复，而非重做国际化 |
| A02 | 浅色/深色/跟随系统 | Appearance | 已有 | 保持，不算缺口 |
| A03 | 字体、字号、聊天宽度等 | Appearance 有细分项 | 缺入口 | P2：优先字号/可读性，不必先做主题市场 |
| A04 | 自定义强调色/主题导入 | 有主题和强调色配置 | 缺正式入口；保存 accent 字段不等于有完整用户能力 | P3：非核心 |
| A05 | 通知偏好 | 独立 Notifications 入口 | 未发现正式设置入口 | P2：至少任务完成、审批等待、失败通知 |
| A06 | 聊天发送快捷键等行为 | Appearance / Chat 偏好 | 没有发现对应配置控件 | P2：不等于当前不能发送或换行 |
| A07 | 设置搜索和高级项分层 | 搜索页面及字段，基础/高级分层 | 缺入口 | P1：能力增长前先建立查找方式 |
| A08 | 作用域、默认值和变更反馈 | 全局/智能体/用户偏好明确，带失败草稿恢复 | 部分：模型区分默认/会话，目录有草稿，其余分散 | P0：统一“保存了什么、哪里生效” |

### B. 模型与提供方

证据：[O1][O2][O3][M1][M2][M11][M16]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| B01 | 预置提供方连接 | 模型连接流程 | 已有千问、MiniMax；不是全量提供方目录 | 保持现有简化流程 |
| B02 | 新增任意自定义提供方 | 提供方/高级配置 | 部分：已有连接可编辑，新建 custom 卡片入口缺失 | P1：若产品允许第三方接入，应补正式“兼容 API”入口 |
| B03 | OpenAI Chat / Responses / Anthropic 协议 | 提供方配置/Schema | 部分：底层和已有 custom 编辑器支持三种；新建入口不完整 | P1：和 B02 一起验收，不只看协议枚举 |
| B04 | OAuth/订阅账号、多认证资料 | 按已安装提供方插件提供连接方法 | 部分/内部：GitHub Copilot 需内部启动参数；非正式默认能力 | P2：按商业支持范围决定，不默认恢复内部入口 |
| B05 | 默认模型 | Models | 已有 | 保持全局默认与会话选择分离 |
| B06 | 当前会话模型 | Chat / Sessions | 设置外已有 | 不计为缺失 |
| B07 | 每智能体默认模型编辑 | Agents / Models 作用域 | 可读取已有覆盖并提示，但缺完整智能体模型编辑页 | P1：显示继承来源及覆盖，避免改全局却不生效 |
| B08 | 有序故障回退链 | 全局默认及 Agent 页面 | 缺正式编辑器；删除模型时的替代处理不等于回退链 | P1：排序、移除、检测可用性和最近回退原因 |
| B09 | 工具用途/图片/PDF/媒体模型 | 用途模型配置，部分在专用控件，部分 Schema | 缺入口 | P1/P2：先 utility，再根据工具支持开放媒体用途 |
| B10 | Thinking / fast / verbose 等默认行为 | 模型默认与 Agent 配置 | 缺当前正式设置入口；旧 `/setup` 有 effort，不算完整覆盖 | P1：只展示模型声明支持的选项 |
| B11 | 上下文、输出限制、请求参数/Headers | 高级提供方和模型 Schema | 没有完整高级编辑器 | P2：按 Schema 暴露白名单，不给所有模型强塞相同参数 |
| B12 | 本地模型安装、下载、激活 | 依提供方和安装环境 | 已有 llama.cpp 组件及模型流程 | 不计缺失；另做本地运行故障诊断 |
| B13 | 认证/模型可用性/供应商额度 | 模型页分开呈现；额度仅供应商提供时可用 | 部分：目录、可用性和错误已有，缺统一额度/认证资料视图 | P2：区分“连接已保存”和“模型可实际调用” |

### C. 智能体、会话与上下文

证据：[O1][O3][M3][M6][M7][M16]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| C01 | 智能体列表与切换 | Agents / 切换器 | 设置外已有 | 不计缺失 |
| C02 | 添加/删除预置智能体 | Agents 管理 | 设置外已有目录及添加/删除 | 不计成完全没有多智能体 |
| C03 | 创建自定义智能体 | Agents 创建流程 | 缺入口：“自定义智能体”标签是空态 | P1：和身份/工作区配置组成闭环 |
| C04 | 名字、头像、身份、角色说明 | Agent Overview / Files | 主要来自目录，无完整编辑器 | P1：避免把全局品牌头像当智能体身份配置 |
| C05 | 指令/工作区文档编辑 | Files，可创建缺失的可选文档，冲突保护 | 缺入口 | P1：先支持受管文件和版本冲突；不要任意编辑本地路径 |
| C06 | 工作区、cwd、repoRoot | Agent Schema | 缺用户配置入口，部分由应用准备 | P1/P2：与文件授权分开展示 |
| C07 | 有效工具/技能能力预览 | Agent Tools / Skills、有效工具预览 | 部分：开发技能状态、MXC 状态可查，无统一按 Agent 预览 | P1：解释“配置启用但此 Agent 不可用”的原因 |
| C08 | 新建、置顶、删除/重置会话 | Chat / Sessions | 设置外已有基础操作 | 不计缺失 |
| C09 | 会话模型之外的覆盖项 | Sessions 管理和聊天控制 | 部分：模型已有，思考/输出等没有完整管理 | P1/P2：与模型能力匹配 |
| C10 | 会话隔离、身份链接、重置策略 | `session.*` Schema | 缺入口 | P1/P2：优先跨渠道身份与隔离解释 |
| C11 | 历史保留、过期、维护策略 | Session 配置/管理 | 缺入口；仅清空/单会话删除并不等价 | P1：保留天数、清理预览、影响范围 |
| C12 | 压缩、上下文裁剪、预算 | Agent 高级 Schema | 缺入口 | P1：先做可理解的自动/限制设置与有效值展示 |
| C13 | Heartbeat、系统 Agent、并发等 | Agent / 高级配置 | 缺入口，部分后台行为受 MXC 约束 | P2：先定义允许后台执行的信任边界 |
| C14 | 历史导出/迁移/记忆导入 | 不同导出/导入入口，能力依数据类型 | 缺统一用户入口；不能把清除历史算导入导出 | P2：先做会话导出，记忆导入另按策略评估 |

### D. 技能、插件、MCP 与记忆

证据：[O1][O2][O3][M4][M8][M12][M13]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| D01 | 正式技能列表与状态 | Skills | 隐藏：开发面板已有状态、缺依赖原因等 | P1：低成本产品化，不止解除 DEV 条件 |
| D02 | 按智能体选择技能、全局启停 | Skills / Agent | 隐藏：已有对应交互和 IPC | P1：显示全局关闭、Agent 未选择、策略阻断等不同原因 |
| D03 | 安装技能/依赖 | Skills 安装能力，受环境限制 | 无通用用户闭环；预置/随智能体安装不等价 | P2：来源审核、安装执行权限和失败恢复先行 |
| D04 | 技能 API Key / env | Skills / Schema | 缺正式用户编辑器 | P2：复用凭据入口，避免每个技能复制明文 Key |
| D05 | 技能文件完整性告警 | 具体机制依产品实现 | 设置外已有启动/运行中完整性告警及信任流程 | 属于 MicroClaw 已有强化，需保留 |
| D06 | 通用插件清单、状态、版本 | Plugins | 缺入口：`/plugins` 当前只显示微信 | P1：先做只读清单和故障说明 |
| D07 | 插件安装/升级/移除、启停 | Plugins，受安装策略与权限限制 | 缺通用 UI；MXC 下还受允许列表限制 | P2：不得绕过插件准入及保护策略 |
| D08 | 插件自己的配置表单 | 插件 Schema / 自定义 UI | 缺通用入口 | P2：Schema 白名单、敏感字段及版本兼容 |
| D09 | MCP Server 增改、传输、认证、工具过滤 | MCP 页面及 `mcp.servers` | 缺入口 + MXC 下禁用 | P2：默认先只读说明；启用需要独立安全方案 |
| D10 | 记忆搜索/索引/引用/导入 | Memory / Schema / 插件入口 | 缺入口 + MXC 下默认记忆插件/槽位禁用 | P2：不是加个“记忆开启”即可；与聊天记录分开 |

### E. 渠道与自动化

证据：[O1][O3][M3][M5][M8][M12][M13]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| E01 | 微信账号登录、断开、状态和消息入口 | 由对应渠道插件决定；不假定上游默认内置相同微信插件 | 已有专门流程 | MicroClaw 的本地化能力，不计缺口 |
| E02 | 其他渠道配置向导 | Channels / 插件 Schema | 部分：只读状态卡；MXC 下非微信渠道被关闭 | P2：先声明支持范围和受限原因，再选择渠道接入 |
| E03 | 多账号管理 | 通用渠道多账号模式，具体依插件 | 微信单账号一致性约束，无通用账号管理 | P2/P3：若要多账号，需修改底层契约，不只是加列表 |
| E04 | 私聊/群聊访问、配对、提及规则 | 渠道配置/Schema，具体字段依插件 | 缺通用用户配置入口 | P1/P2：只展示当前插件真正支持的字段 |
| E05 | 渠道 → 智能体/模型路由 | Agent Channels、绑定及 Schema | 缺用户管理入口 | P1/P2：先明确当前微信会话归属，不强开受限渠道 |
| E06 | 渠道诊断与错误解释 | Channels 状态及诊断 | 部分：微信状态恢复较完整，其他渠道较简略 | P1：显示缺配置、未装插件、保护禁用、连接失败的区别 |
| E07 | 定时任务列表、运行状态 | Automations / Run history | 隐藏/未接入：只读视图无路由；MXC 下暂停 | P1：先给正式只读列表和暂停解释 |
| E08 | 新建/编辑/启停/删除定时任务 | 专用 CRUD 页面 | 缺 UI/对应通用 IPC；MXC 下明确阻断相关方法 | P2：安全边界先行，不直接开放 `cron.*` |
| E09 | 手动运行、跨任务运行历史、失败告警 | Automations / `cron.*` | 缺正式管理页；保护期间不得偷偷运行 | P2：需任务审计、投递目标和执行身份 |
| E10 | Hooks/Webhook、重试及映射 | 高级 Schema，部分与自动化关联 | 缺入口 + MXC 下暂停 | P2/P3：先只读状态；不能让事件从非受控入口进入 |
| E11 | Gmail 等事件接入 | 配置参考和可选集成 | 缺通用入口 | P3：按目标用户需求，不当默认缺陷 |

### F. 工具、安全、凭据与隐私

证据：[O1][O3][M1][M7][M9][M12][M13][M14]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| F01 | 搜索提供方与 Key | 搜索/插件配置 | 已有三个搜索选择 | 保留简洁流程，验收真实字段契约 |
| F02 | 搜索总开关、自动路由 | Search / Schema | 缺正式开关；选择提供方不等于开关 | P1：显示当前 Agent/模型实际采用的路线 |
| F03 | 搜索结果数、超时、缓存等 | `tools.web.search` Schema | 缺入口 | P1/P2：先常用限制，再高级字段 |
| F04 | 网页抓取开关、字数/响应体/超时限制 | `tools.web.fetch` Schema | 缺入口，web_fetch 本身在 MXC 允许范围内有约束 | P1/P2：避免“搜索设置”误导为覆盖全部联网 |
| F05 | 浏览器配置/自动化 | Browser / 高级设置 | 缺入口 + MXC 下禁用 | P2：需独立隔离和授权方案 |
| F06 | 工具 profile、按 Agent/提供方允许拒绝与有效预览 | Tools / Schema / Agents | 部分：MXC 固定策略，不是通用工具编辑器 | P1 先只读预览；P2 再做受限可编辑层 |
| F07 | 实时命令审批 | Approvals / 行内请求 | 设置外已有 PermissionDialog；支持拒绝/一次/符合条件的记住 | 不计缺失 |
| F08 | 记住的命令撤销 | Exec approvals 管理 | 已有 MXC 精确命令记录及撤销，部分模式不显示该区 | 保留其精确作用域，不替换为宽泛命令白名单 |
| F09 | 全部已决审批历史/筛选 | Approvals 有 30 天历史及来源归属 | 缺正式历史页；当前记录只代表持久授权，不代表所有审批 | P1：显示请求、决定、来源、原因和时间 |
| F10 | 文件系统保护与批准目录 | 上游 sandbox/exec 策略的模型不同 | 已有 MXC、只读/读写目录、事务应用和恢复 | MicroClaw 强项；不能强行一一对映上游开关 |
| F11 | 跨功能保护状态说明 | 上游按工具/安全页展示不同信息 | 部分：已有 MXC 说明/状态，缺持续可查的全功能矩阵 | P0：在功能页就地显示限制和安全下一步 |
| F12 | 密钥、环境变量、SecretRef 管理 | Secrets 与 Schema，能力由 Gateway 广告 | 部分：模型/搜索单独录 Key，没有统一凭据中心 | P2：遮罩、不回读保存后的密钥、按引用复用 |
| F13 | 出站文本 PII 脱敏 | 不把上游 Secrets 等同于全量 DLP | MicroClaw 已有严格模式及五类文本扫描；覆盖范围有限 | P0：写清只证明了桌面聊天文本路径；不得宣传全链路保护 |
| F14 | 敏感文件模式与读取保护 | 与上游工具/审批/沙箱策略分开比较 | 部分：UI 显示固定模式；未见可编辑规则或该列表的独立执行开关 | P0 验证承诺与执行链路，P2 再考虑规则编辑器 |
| F15 | 屏幕/相机/位置/语音权限 | Devices / 原生设备设置；平台相关 | MXC 下对应能力受限；无通用用户页 | 平台/可选，不能作为普通 Windows 设置页必补 |

### G. Gateway、运维、用量与配置基础设施

证据：[O1][O2][O3][M1][M10][M11][M14][M15]。

| ID | 能力 | OpenClaw Web UI | MicroClaw 当前 | 建议 |
| --- | --- | --- | --- | --- |
| G01 | 连接状态、重启 | Gateway / Debug | 已有简版状态和重启 | 保留并补分阶段失败说明 |
| G02 | 客户端连接远程 Gateway | Gateway URL、secret、默认会话 | 缺正式连接编辑器；当前应用自管本地服务 | P3 或专家模式，不应破坏本地托管假设 |
| G03 | 服务端绑定、认证、TLS、网络公开面 | Gateway Schema | 缺用户编辑页；底层部分由应用管理 | P2/P3：默认只读；危险公开面不得随意改 |
| G04 | 节点/设备配对、令牌、能力清单 | Devices | 部分：应用自有 Windows Node 诊断，不是通用节点后台 | P2：先本机只读，远程配对另案 |
| G05 | 健康、启动阶段、配置/插件失败诊断 | Debug / Gateway / Systems | 部分：有日志及 MXC 状态，缺统一诊断页 | P0：新机器可用性和支持成本优先 |
| G06 | 实时日志、级别筛选、完整导出 | Logs / `logs.tail` | 部分：导出当前 renderer 缓存，超过 600 条后裁到最后 500 条 | P1：补文件日志来源、时间窗、筛选与脱敏诊断包 |
| G07 | 实际组件版本与构建身份 | About / Updates / 系统状态 | 部分：关于页固定版本文案；无 Gateway、Node、插件、构建身份总览 | P0：显示真实值和“不确定/无法读取”，不猜版本 |
| G08 | 更新策略、执行/重启、更新状态 | Updates，具体支持依安装方式 | 部分：桌面检查更新和下载链接，不是 Gateway 原地更新控制台 | P2：遵循 MicroClaw 受管整包升级，不照搬 `update.run` |
| G09 | 最近用量和按模型花费 | Usage | 已有 30 天汇总及人民币显示 | 不计缺失；标明统计口径和估算属性 |
| G10 | 日期/Agent/会话筛选、详情和导出 | Usage 的筛选、会话详情、CSV/JSON 导出 | 隐藏/未接入：详细后端及抽屉已有，正式设置未覆盖 | P1：先复用数据层，不把未挂载组件当可用页面 |
| G11 | 预算上限和强制停用 | 不能从 Usage 统计反推具有预算强制执行 | MicroClaw 当前后端 `maxBudget: null`，没有预算设置闭环 | 独立产品需求，不计成已确认的上游对齐缺口 |
| G12 | 全域 Schema 表单/安全原始编辑 | Advanced / `config.schema*`；原始编辑有条件 | 缺专家编辑器，且 config 写入有应用白名单/MXC 限制 | P2：先只读检视，不能把通用写接口直接暴露 |
| G13 | 保存验证、并发冲突、草稿、恢复 | 统一配置编辑工作流 | 部分：模型路径较完善；搜索及应用偏好路径不同 | P0：统一基础设施，不能宣称所有写入都无保护 |
| G14 | 审计/日志级别/遥测配置 | Schema 及安全/诊断相关页面 | 缺统一设置入口 | P2：区分是否采集、去向、保留期和导出敏感性 |

## 6. 最重要的边界与风险

### 6.1 MXC 下“保存配置”不等于“能力可以运行”

当前 MXC Gateway 策略会覆盖工具与插件的有效状态。至少有以下明确约束：[M12][M13]

| 能力 | MXC 下的现状 | UI 应如何表现 |
| --- | --- | --- |
| 网关原生 read/write/edit/apply_patch | 禁用，文件操作不能从这里绕过隔离 | 显示改由受控 Windows Node 命令执行，不给一键恢复原生工具 |
| 命令 exec | 应用自有节点、MXC 和命令审批 | 展示批准目录、声明访问、命令作用域和当前验证状态 |
| 浏览器自动化、MCP | 禁用 | 可以先查看配置，但明确“受保护模式限制，未运行” |
| 默认网关记忆插件/槽位 | 禁用，memory slot 为 `none` | 区分聊天历史与记忆；不要把“历史存在”显示成“记忆已启用” |
| Cron | 保留但暂停，相关变更/运行方法受阻断；错过的任务不补跑 | 列出 requested/effective 状态及原因，不显示假启用 |
| Hooks / Webhook | 暂停，内部事件不重放；Webhook 可能返回 503 | 禁止“保存成功即启用”的暗示 |
| 其他渠道 | 当前策略仅按允许条件保留微信 | 对原配置保留与实际启用分别说明，不删除用户原配置来伪造一致 |
| 插件 | 允许列表内的画布、微信及选中的模型提供方插件等 | 安装、已配置、允许、有效启用四个状态分开 |
| web_search / HTTP(S) web_fetch | 在受控范围内仍可用 | 搜索设置可以优先补，但应遵守实际网络和提供方规则 |
| 画布 | 只保留审查过的 A2UI 能力；非通用浏览器/脚本环境 | 不将“画布可用”当成“任意导航和脚本可用” |

建议所有涉及执行的设置至少展示：**用户期望值、当前有效值、限制来源、受影响 Agent/会话、是否需重启/重新验证**。这是比补大量可点击开关更先要解决的问题。

### 6.2 当前配置写入并非同一种安全语义

- 模型配置有专门提交路径：检查 expected config、Gateway hash、当前连接代际、Schema 应用结果及生效确认。此能力应复用，不应推倒重做。[M11]
- 普通 `config:write` 有顶层字段白名单，MXC 开启时会拒绝；expected config 参数可选，不是所有调用都带冲突条件。[M7]
- 搜索保存会重新构造 `tools.web.search`，普通路径没有传 expected config；未来加入高级 search 字段时，必须防止保存提供方/Key 时清掉其他已有字段。[M1][M7]
- 搜索保存目前仍走这条普通 `config:write` 路径。因此 MXC desired 开启时，该保存调用会被主进程拒绝；补搜索配置需要专门的受控变更路径，而不是要求用户关闭保护。[M1][M7]
- 当前通用写入白名单没有覆盖所有上游配置域，例如 `session`、`messages`、`env`、`auth`、`secrets`、`update` 的新改动不能直接经此接口透传；已有未变更字段可以保留。新增表单前须设计对应后端契约。[M7]
- 应用偏好写入的是 Electron settings store，与 OpenClaw 配置不是同一文件、同一验证流程。[M15]
- 应用偏好与 Gateway 配置应使用不同适配器，但提供一致的草稿、错误、重试、生效状态和审计体验。

### 6.3 隐私不能只依据 UI 文案认定覆盖完整

已确认：严格模式在桌面 `chat` Store 发送文本前调用五类 PII 扫描与脱敏。附件处理是另一条路径；微信消息、工具返回、自动化等也不能仅凭该文本处理分支推断已经覆盖。[M9]

敏感文件模式在设置页是一段静态文字。本次未证明 `.env`、密钥、证书等**每一种读取路径**都依据这份列表弹确认，因此报告不把它当作已验证的全局文件内容防泄漏能力。MXC 本身的文件边界又是另一层控制，两者不能混为一谈。[M1][M12]

建议先做覆盖范围说明与针对性验收，再决定是否建设主进程/网关统一出站防护和可编辑规则；不要先扩大“严格模式能保护一切”的承诺。

### 6.4 不建议优先照搬的项目

- 上游浏览器 favicon、完整主题导入市场：桌面形态收益较低，先解决字体和字号。
- 原生 macOS/iOS 的设备权限、唤醒词、后台语音：平台不同，单独规划。
- 外部 CLI 会话发现、Meetings、Portals、Cloud Workers、复杂 Worktree 工作台：属于产品边界扩展，不是当前设置页漏了一行。
- 直接运行上游 `update.run`：MicroClaw 还有固定运行时、插件准入、原生宿主、完整性与安装事务，应遵循整包升级契约。
- 无限制原始 JSON 编辑器、任意 MCP/插件启动：可能破坏应用安全承诺，不能作为“最快补齐配置”的捷径。

## 7. 建议实施路线与验收标准

以下工作量仅为相对复杂度：S 为局部页面/适配，M 为跨 UI 与 IPC 的完整闭环，L 为涉及执行或安全契约的新能力；**不是人天估算，也不是交付承诺**。

### 7.1 第一步：先把“已配置、允许、生效、失败”讲明白

| 工作包 | 优先级 / 复杂度 | 建议交付 | 核心验收 |
| --- | --- | --- | --- |
| R01 有效能力与状态中心 | P0 / M | 每个 Agent/功能显示来源、期望状态、有效状态、策略阻断原因 | MXC 下 MCP/记忆禁用、Cron/Hooks 暂停、搜索可用范围与界面一致；不出现假启用 |
| R02 版本与诊断 | P0 / M | 实际桌面版本、构建身份、Gateway/Node/关键插件版本、当前启动阶段和失败摘要；脱敏导出 | 新机器无需手工拼日志即可给出可分析包；没有读到的版本显示未知，不复用硬编码文案 |
| R03 统一变更管线 | P0 / L | 用现有模型变更经验建立按域受控的读取/校验/提交/确认接口 | 保留未知字段、解决并发冲突、密钥不回显；保护模式不能被通用 JSON 或 RPC 绕过 |
| R04 隐私保护说明与覆盖验收 | P0 / M | 明确桌面文本、附件、工具结果、微信、后台任务各自覆盖情况 | 产品文案不超过已验证范围；敏感文件说明有真实执行证明或明确边界 |

R03 不应阻塞全部只读页面：版本、技能状态、插件清单、被策略暂停的任务列表可以先交付。涉及可执行配置的写入仍必须通过安全门。

### 7.2 第二步：优先产品化已有基础

| 工作包 | 优先级 / 复杂度 | 建议交付 | 核心验收 |
| --- | --- | --- | --- |
| R05 正式技能管理 | P1 / M | 选择 Agent、技能清单、全局/Agent 启停、依赖/策略原因、刷新 | 打包版本有正常入口；全局停用/Agent 未选/缺依赖/MXC 禁用原因分开 |
| R06 智能体设置一期 | P1 / L | 自定义创建、身份、受管指令文件、默认模型、工具/技能有效预览 | Agent 作用域不串；预置/自定义可辨；写文件冲突不静默覆盖 |
| R07 模型策略与接入补齐 | P1 / M-L | 明确是否恢复新增兼容 API；有序回退链、utility、思考等支持项 | 新用户可完成产品宣称支持的接入；全局/Agent/会话继承可解释；失效模型有恢复路线 |
| R08 搜索/抓取设置 | P1 / M | search/fetch 启停和必要限制；当前路径/提供方状态 | 在保护开启时能完成被允许的变更；保存不丢高级字段；真实请求验证协议与凭据路径 |
| R09 会话与用量管理 | P1 / M-L | 历史保留/清理预览、常用上下文策略；日期/Agent/模型筛选、会话导出 | 清理前说明数据范围；统计不混用过期查询结果；设置与本次有效值一致 |
| R10 审批与活动历史 | P1 / M | 最近审批、来源、决定、原因、持久授权关联 | “本次允许”“记住精确命令”“批准整个目录”不能混为一类 |

技能管理并非直接移除一行 DEV 条件就完成：还需要正式权限、失败状态、能力降级、布局、文案和打包验收。自定义提供方入口也应先确认原先隐藏它的产品意图，再恢复。

### 7.3 第三步：按场景扩展，而不是追求全量一致

| 工作包 | 建议 | 前置条件 |
| --- | --- | --- |
| 通用插件管理 | P1 先清单和诊断；P2 再安装/升级/移除及 Schema 设置 | 插件来源、签名/完整性、能力声明、准入、回滚及 MXC 允许规则 |
| MCP | P2；先只读可发现性，后考虑执行 | 传输与凭据、工具过滤、执行身份、MXC 边界和审计 |
| 自动化 | P1 先只读与暂停原因；P2 再 CRUD/运行 | 执行身份、审批、人不在场时的权限、投递目标和保护期行为 |
| 更多渠道 | P2/P3；明确优先支持哪一个 | 单账号/多账号模型、身份/会话路由、配对、访问控制、后台接入约束 |
| 专家配置检视 | P2；先只读和搜索，再有限域编辑 | 实时 Schema、角色能力、路径白名单、SecretRef、冲突和恢复 |
| 远程 Gateway / 多节点 | P3 或独立模式 | 应用目前自管本地服务的假设、凭据存储、来源信任和设备配对 |
| 语音/媒体/云工作环境 | 按明确用户场景立项 | 平台、插件、费用、数据去向和独立隔离方案 |

### 7.4 后端复用地图

| 领域 | 可以复用 | 还缺什么 |
| --- | --- | --- |
| 技能 | 状态/全局启停/Agent 选择 IPC，完整性机制 | 正式入口、权限与有效状态统一、依赖安装/凭据闭环 |
| 模型 | Provider 编辑器、本地模型服务、会话模型、专用配置应用服务 | 新建 custom 的产品入口、回退/用途/行为 UI、按 Agent 策略 |
| 用量 | summary 和 detailed IPC，已有数据变换及快照层 | 真正挂载的正式页面、筛选与导出、错误/查询代际处理 |
| Cron | `cron.list` 和 MXC 暂停标注 | 正式路由；变更/运行 IPC 尚无通用暴露，且策略禁止，不能只接前端 |
| 插件 | 微信专门接口、现有运行时与插件准入 | 通用受控清单/变更适配器，不是改 `/plugins` 标题即可 |
| 会话策略 | 基础会话操作和 Gateway 能力 | 新的白名单化设置契约、作用域和生效确认 |
| 专家配置 | 部分 config 读取与模型提交经验 | 动态 Schema、权限/路径约束、安全原始往返、统一草稿 |

## 8. 建议的设置信息架构

不建议照搬上游二十多个后台页面。可以保留桌面应用的简洁入口，逐步收敛为以下八组；这是设计建议，本次没有修改 UI。

| 一级组 | 二级内容 | 面向谁 |
| --- | --- | --- |
| 通用 | 启动/托盘、语言、主题、字号、通知、聊天交互 | 所有用户 |
| 模型 | 提供方连接、默认与回退、思考/用途、本地模型 | 所有用户；参数进高级区 |
| 智能体与技能 | Agent 身份/指令/工作区、技能、有效能力 | 所有用户 |
| 连接 | 微信、其他受支持渠道、账号/身份路由；高级远程连接另设条件 | 普通用户 + 专家 |
| 自动化 | 任务、运行历史、暂停原因、受控新建 | 可只读起步；受安全能力约束 |
| 安全与隐私 | MXC、批准目录、命令授权、审批历史、凭据、保护范围 | 所有用户；危险项明确分层 |
| 用量 | 概览、筛选、会话/模型明细、导出 | 所有用户 |
| 系统 | 实际版本、组件/插件状态、健康、日志、更新、关于；高级只读配置 | 支持排障；编辑需额外授权 |

联网搜索可从“模型页的一段 Key 表单”迁入“智能体与技能 → 工具 → 联网”，但旧入口应保留跳转，避免让已有用户找不到。普通用户只看常用项，专家项应可搜索，不靠记住隐藏 URL。

任何受限入口都不应只留一个不可点的灰色开关：应解释限制来源、是否仅当前 Agent 受限，以及安全下一步。**“去关闭 MXC”不应成为默认建议。**

## 9. 验收清单

后续每个功能应同时覆盖普通模式和适用的保护模式，不只测空白配置的 happy path。

1. **全新安装**：没有任何提供方时，能从正式入口完成承诺支持的连接；若不支持自定义，要明确说明，不让旧向导承担隐藏功能。
2. **已有自定义连接**：更新应用后仍能编辑；Base URL、模型、协议和凭据引用不被预设表单破坏。
3. **模型能力差异**：无思考等级的模型不显示猜测的选项；模型失效、认证缺失、目录失败的恢复提示不同。
4. **作用域**：改全局不偷偷改会话覆盖；切换 Agent 时未完成的提交仍绑定原目标，显示有效值来源。
5. **并发写入**：另一客户端/配置文件已变化时拒绝静默覆盖；草稿可修改、重试或安全放弃。
6. **未知/高级字段**：已有插件配置、Header、搜索限制、SecretRef 等不会因为保存简单字段而丢失。
7. **MXC 生效**：页面展示 requested/effective 区别；任务/Hook 不从其他入口偷跑；不能通过原始编辑、MCP 或插件变更绕过保护。
8. **目录和命令授权**：全局目录放权、一次命令、持久精确命令三种影响明确；变更失败时有恢复及撤销。
9. **搜索变更**：启用保护时允许的配置能通过受控路径提交；提供方/凭据保存后真实验证；热加载/重启提示与实际一致。
10. **技能产品化**：打包正式版显示；全局停用、Agent 未选择、缺依赖和策略阻断分别解释。
11. **隐私**：用合成测试数据分别检查桌面文本、附件、工具结果、微信和后台任务；明确哪些已保护、哪些未覆盖，不使用真实个人信息做验收。
12. **用量与历史**：筛选/导出范围一致，数据加载失败不混入别的查询结果；历史删除说明影响范围，不暗示能撤回已发给模型的数据。
13. **新机器排障**：启动失败时可看到具体阶段和实际组件身份；诊断包覆盖安装/桌面/Gateway 相关时间窗，并验证不泄露 Key、token 或个人内容。
14. **升级兼容**：对固定版本及候选升级版本检查 Schema 和插件能力变化；新增上游字段不应默认为可由 MicroClaw 任意写入。

## 10. 尚需产品决策与动态验证的事项

- **提供方开放策略**：只主推少量预设，还是正式支持任意兼容 API？现有代码和测试看得出曾主动收窄新建入口，恢复需要产品确认，不应直接称为回归 bug。
- **安全默认值与专家能力**：MXC 是默认承诺还是可选模式？在此确定前，不宜承诺 MCP/浏览器/自动化的开放日期。
- **更多渠道**：先做哪个渠道、多账号是不是刚需、跨渠道身份如何映射？不能只从上游有多少插件推导优先级。
- **隐私目标**：只是桌面输入的便利脱敏，还是全渠道 DLP？这两者后端工作量和安全承诺完全不同。
- **待动态验证**：当前 Runtime 的 live Schema 与插件 metadata、各角色可见入口、搜索凭据字段与生效行为、保护状态下的 UI 提交错误、敏感文件各读取路径。
- **未做的事**：本次没有安装插件、升级 OpenClaw、修改设置、启动真实 Gateway、执行新构建，也没有修改功能代码或提交 Git。

## 11. 证据索引

本节给出可复核的本机源码位置。行号是调研时的起始定位；后续代码改动可能造成位移。`build` 下的运行时快照是本机证据，通常不随 Git 文档发布；阅读者应使用同版本发行包复核，而非把本机路径当公共链接。

### [V1] 版本与快照

- 固定版本：`C:/Users/angnuoli/Documents/project/MicroClaw/deployer/openclaw_version.py:17`
- 桌面包声明：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/package.json:1`
- 运行时包身份：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/package.json:1`
- 运行时构建身份：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/dist/build-info.json:1`

### [O1] 随包 Control UI 功能与 RPC 参考

- `C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/web/control-ui/feature-reference.md:15`
- 重点：渠道/会话/记忆在 39；Cron/插件/技能/设备/审批在 52；Config 在 62；Usage 在 95；Debug/日志/更新在 118。

### [O2] 随包设置说明

- `C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/web/control-ui/settings.md:11`
- 重点：语言 149；外观 160；插件 237；更新 347；设置保存 394；MCP 605。

### [O3] 随包配置域与字段参考

- 总目录、Schema 与 advanced 语义：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/configuration-reference.md:10`
- 模型与回退/用途：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-agents/models.md:12`
- 心跳/压缩/裁剪：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-agents/heartbeat-compaction-and-streaming.md:12`
- 会话：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-agents/sessions.md:12`
- 工作区及上下文预算：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-agents/workspace-and-bootstrap.md:12`
- 搜索/抓取/执行：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-tools/built-in-tools.md:12`
- 工具策略：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-tools/tool-policy.md:12`
- MCP、技能、插件：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-extensions.md:14`
- 渠道：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-channels.md:10`
- 服务端、网络、重载：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-gateway.md:14`
- 凭据/环境/SecretRef：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/docs/gateway/config-secrets-env.md:14`
- 事件与运维：同目录 `config-hooks.md`、`config-automation.md`、`config-observability.md`，均从 14 起进入对应配置域。

### [O4] 打包 UI 页面模块交叉检查

- 目录：`C:/Users/angnuoli/Documents/project/MicroClaw/build/installer-runtime-smoke/appdata/microclaw/runtime/openclaw/node_modules/openclaw/dist/control-ui/assets`
- 观察到 `agents-page-D6PguA6U.js`、`model-providers-page-CaeeqVMA.js`、`config-page-BNTYihrC.js`、`plugins-page-BhRhBwZY.js`、`skills-page-CGQFaCMG.js`、`secrets-page-D5le3iZo.js`、`approvals-page-BtR8fZI1.js`、`devices-page-Bmw2y6-8.js`、`debug-page-DsAXxkGW.js`、`logs-page-DyFfu4uJ.js`、`usage-page-DTN0jUge.js` 等。
- Schema 分组/高级分层实现也存在于 `config-form.tiers-DoasQItR.js`。这些是编译模块，不能替代运行时权限/功能的动态确认。

### [M1] 正式设置与搜索写入

- 页面及菜单：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.vue:25`
- 各分区起点：用量 101、模型 223、频道 480、安全 489、隐私 820、关于 934；菜单在 1919。
- 搜索提供方列表 1780；搜索持久化 2379；关于检查更新 2430；日志导出 2470。

### [M2] 提供方、本地模型、内部能力

- 提供方卡片/已有自定义连接来源：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.vue:1631`
- 提供方编辑器：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/ModelSetupDialog.vue:225`
- family 列表与 custom 兼容代码：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/ModelSetupDialog.vue:509`
- 预设：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/utils/managed-model-providers.ts:23`
- 本地模型：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/LocalModelSetupDialog.vue:1`
- 内部 Copilot 参数：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/preload.ts:15`

### [M3] 渠道与微信

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/ChannelsView.vue:1`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/WeixinConnectionCard.vue:318`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/stores/channels.ts:11`

### [M4] 技能的开发门控与已有 API

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.vue:1046`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/skills/SkillsDevPanel.vue:1`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/preload.ts:76`

### [M5] 路由与定时任务残存实现

- 当前路由表：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/router.ts:5`
- 未注册视图：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/TasksView.vue:1`
- 查询 Store：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/stores/tasks.ts:15`
- 仅查询 IPC：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/preload.ts:204`

### [M6] 智能体已有能力与空态

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/AgentMarketView.vue:26`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/stores/agents.ts:82`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/SidePanel.vue:6`

### [M7] 普通配置写入与白名单

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/main.ts:6938`
- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/config-write-policy.ts:3`

### [M8] 插件页现状与完整性流程

- 仅微信的插件页：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/PluginsView.vue:1`
- 技能完整性提示：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/App.vue:94`
- 运行中完整性订阅：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/App.vue:630`

### [M9] 已确认的隐私执行路径

- 桌面聊天出站文本：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/stores/chat.ts:1258`
- 检测实现：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/utils/pii-scanner.ts:84`
- 开关转换：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/utils/privacy-settings.ts:12`

### [M10] 用量：正式汇总与未挂载详情

- 汇总：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/main.ts:8377`
- 预算返回值：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/main.ts:8426`
- 详细统计接口：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/preload.ts:345`
- 详细抽屉：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/UsagePanel.vue:1`
- 抽屉状态：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/composables/useUsagePanel.ts:1`
- 全局引用检查未发现该组件被其他生产组件挂载，也未发现 composable 被正式导航调用；此结论来自引用搜索，不是只看文件名。

### [M11] 模型专用配置应用能力

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/model-config-application.ts:63`
- 保护模式模型变更：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc-model-config.ts:77`

### [M12] MXC 有效工具与插件策略

- 工具策略：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc.ts:668`
- 覆盖渠道、Hooks、Cron、插件与 memory slot：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc.ts:698`
- 限制说明契约：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc-disclosure.ts:42`
- 对应中文告知：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/i18n/zh-CN.ts:358`

### [M13] 暂停与授权作用域

- Cron 阻断与暂停标注：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc-cron.ts:5`
- 批准目录与草稿操作：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.vue:617`
- 精确命令授权列表：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.vue:747`
- 微信远程审批相关实现：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/windows-node-mxc-weixin-remote-approval.ts:1`

### [M14] 实时审批与日志范围

- `C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/PermissionDialog.vue:11`
- 日志缓冲裁剪：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/stores/gateway.ts:18`

### [M15] 应用偏好持久化与版本文案

- settings store 默认值和可写键：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/main.ts:467`
- 偏好写入及系统开机启动：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/src/main.ts:8609`
- 固定版本文案：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/i18n/zh-CN.ts:570`
- 主题/强调色初始化：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/App.vue:604`

### [M16] 新建 custom 与旧向导的可见性证据

- 空配置不提供兼容 API、已有 custom 仍可编辑的测试：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SettingsView.models.test.ts:290`
- 旧协议/思考等级表单：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/views/SetupWizard.vue:20`
- 不自动展示旧向导：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/App.vue:2`
- 旧路径初始化重定向：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/App.vue:617`
- 会话置顶/删除/重置入口：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/SidePanel.vue:101`
- 聊天模型选择器：`C:/Users/angnuoli/Documents/project/MicroClaw/desktop/renderer/src/components/chat/ChatModelPicker.vue:1`

### 官方在线补充资料

以下为滚动更新页面，仅用于导航与后续复核；本报告版本基线仍以 [V1] 的本地发行包为准。

- Control UI：`https://docs.openclaw.ai/web/control-ui`
- Settings：`https://docs.openclaw.ai/web/control-ui/settings`
- 功能与 RPC 参考：`https://docs.openclaw.ai/web/control-ui/feature-reference`
- 配置说明：`https://docs.openclaw.ai/gateway/configuration`
- 配置参考：`https://docs.openclaw.ai/gateway/configuration-reference`

## 12. 最终建议

**优先把 MicroClaw 做成“安全边界可理解、配置结果可确认、出了问题可诊断”的客户端，再补成通用管理台。**

第一批最值得做的是：有效能力/诊断与配置基础设施、正式技能管理、智能体配置、模型策略及新增自定义接入、会话和搜索管理。MCP、浏览器、更多渠道与自动化并非无价值，而是与 MXC 信任边界高度耦合，应该作为有明确安全前置条件的第二批，而不是通过新增开关直接放行。
