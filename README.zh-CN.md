# 🦞 MicroClaw

[English](README.md)

**MicroClaw** 的目标是让 [OpenClaw](https://github.com/openclaw) 在 Windows 上做到“装好就能用”。它把桌面客户端、本地 Gateway、运行时、预装技能和带权限控制的沙箱整合成一个熟悉、低摩擦的安装体验，让用户尽快进入真实任务。你只需要提供大模型连接信息，Windows 侧运行环境、桌面应用和信任边界都由 MicroClaw 预置完成。

> [!WARNING]
> **AI 与安全声明**
> MicroClaw 是一个由 Microsoft 发起的实验性开源项目，为用户已安装在设备上的开源 [OpenClaw](https://github.com/openclaw) 软件提供安全执行环境和用户界面。MicroClaw **不是** AI 服务，不包含 AI 模型，也不会代替用户生成或修改用户提示、响应或任何 AI 生成的内容。
>
> 所有 AI 任务（包括推理和内容生成）均由 OpenClaw 软件使用你所选择的 AI 模型完成，通过你自己的 API Key 和凭据访问。AI 生成的内容可能不正确，AI 不是人类，也没有人格。沙箱限制了 OpenClaw 可以访问的资源，但无法阻止 OpenClaw 或 LLM 在你已授予的权限范围内执行操作。你有责任在提交前审查所有提示，并且不要运行来自不受信任来源的提示。
>
> 📄 完整免责声明请参见 [DISCLAIMER.md](DISCLAIMER.md)，包括提示注入风险、沙箱范围及责任限制。

## 为什么是 MicroClaw

MicroClaw 的设计重点，是把 OpenClaw 在 Windows 上常见的安装和配置摩擦尽量消掉。用户不需要手动拼装 Node.js、OpenClaw、本地配置、技能和沙箱，而是通过一次安装把这些部分连起来。

### 即装即用

- **熟悉的 Windows 安装流程**：带桌面快捷方式、开始菜单入口和一键卸载
- **一次安装补齐运行环境**：自动准备 Git、受管 Node.js、OpenClaw Gateway、MicroClaw 桌面端、托管技能和原生 MXC 组件
- **安装完成即可启动**：不需要先手动搭本地 OpenClaw 运行环境

### 真正可用，而不是只装了个壳

- **唯一需要用户自备的是 LLM**：用户提供模型地址、API Key 和模型名，其余栈内组件由 MicroClaw 安装并连接起来
- **首启路径很短**：如果还没有模型配置，应用只会引导填写模型凭据；如果 `.env` 里已有 `MODEL_*`，MicroClaw 还可以自动配置
- **首屏自带推荐任务**：首页不是空白输入框，而是预置了任务卡片和提示词建议，安装后就能直接开始做事
- **能力预装到位**：52 个内置技能加 6 个托管技能默认可用；专家智能体按需安装自己的专属技能

### 内建信任

- **动作透明、权限可控**：文件和工具访问需要明确向用户申请，而不是静默放行
- **MXC 是唯一的工具执行沙箱**：明确选择 Full 或 Limited；不再提供旧 AppContainer 后端
- **关闭即不使用沙箱**：MXC Off 时，工具直接使用当前 Windows 账号的权限执行
- **原生模式边界**：Full 强制独占目录权限上限；Limited 采用附加授权，并在激活前评估环境访问权限

---

## 项目组成

| 组件 | 路径 | 技术栈 | 说明 |
|---|---|---|---|
| **桌面应用** | `desktop/` | Electron 33 + TypeScript + Vue 3 + Element Plus | 聊天界面、Gateway 生命周期管理、托盘菜单 |
| **原生 MXC 主机** | `windows-node-host/` + `third_party/openclaw-windows-node/` | .NET + MXC SDK | 精确命令审批及 Full/Limited 原生隔离 |
| **安装器** | `deploy.py` + `deployer/` | Python 3 + Tkinter | 向导式图形化安装器（可打包为单文件 exe） |
| **技能包** | `skills/` | Markdown + JSON + Python/Node | Office、搜索、浏览器自动化等托管技能 |
| **微信插件** | `plugins/openclaw-weixin/` | TypeScript + OpenClaw Plugin SDK | 微信频道接入 |

---

## 快速开始

MicroClaw 仅支持 **Windows 10/11**。对大多数用户来说，真正需要自己提供的只有大模型连接信息。

### 1. 安装

> **发布说明：**MicroClaw 的 GitHub Release 页面**不提供预编译的安装包**。请从本仓库拉取源代码后，自行运行下面的 `build.ps1` 构建。详见 [发布策略](#发布策略)。

从源码构建安装器后运行：

> **构建前置依赖**（仅运行 `build.ps1` 时需要）：**Node.js 26.1+（推荐）** 或 **24.x 系列的 24.16+**，以及 **Python 3.10+**。OpenClaw **2026.10.5** 要求 `>=24.16.0 <25 || >=26.1.0`，不再支持 Node 22 和 25。使用 `pip install -r requirements.txt` 安装 Python 构建依赖（其中包含用于打包安装器 exe 的 PyInstaller）。终端用户运行已打包的 `MicroClawInstaller.exe` **无需** 安装 Python。

```powershell
.\build.ps1                                        # 生成 dist/MicroClawInstaller/MicroClawInstaller.exe
.\dist\MicroClawInstaller\MicroClawInstaller.exe   # 运行安装向导
```

安装器会在一次运行中完成 Windows 侧的主要准备工作：

- Git for Windows（PortableGit → `~/.openclaw-git`）
- Node.js 26，通过官方签名 `.msi` 以 per-machine 方式安装到 `%ProgramFiles%\nodejs\`（UAC 提权；若该路径已存在受支持的系统 Node 则直接复用；支持范围为 `>=24.16.0 <25 || >=26.1.0`，下载回退版本为 `26.1.0`）
- OpenClaw Gateway，默认 `stable` 通道固定为 **2026.10.5**（`npm install -g openclaw@2026.10.5`）
- 配置 npm 镜像源与 V8 编译缓存
- 安装 MicroClaw 桌面客户端、托管技能及 Windows 沙箱组件；微信插件不随安装包捆绑，也不会自动安装
- 添加 Windows Defender 排除项，创建桌面快捷方式（含一键卸载）

安装完成后，从开始菜单或桌面快捷方式启动 **MicroClaw**。桌面应用会自动拉起 Gateway。

升级已有安装时，请重新运行 MicroClaw 安装器，继续使用事务备份、验证和失败回滚流程；旧版依赖脚本会拒绝直接覆盖升级 OpenClaw。旧配置中的 Node 22/23/25 会迁移到受支持的版本线。升级回滚会保留更新后的既有 Node 目录，避免连同已恢复的 OpenClaw 包一起删除。`stable` 是精确版本锁定，不会随 npm 的 `latest` 自动变化。

### 2. 只补上你的模型配置

首次启动时，只有在模型尚未配置的情况下才会进入 SetupWizard。这里真正需要用户填写的内容只有：

- Base URL
- API Key
- 模型名

之后你可以在 **设置 → 模型** 中随时添加或修改。凭据由桌面应用本地保存，不需要手动创建配置文件。如果 `.env` 已经包含 `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_NAME`，MicroClaw 可以直接预填甚至自动写入配置。

#### 内部提供商测试

GitHub Copilot 默认关闭，不显示在首次配置、模型设置和模型选择器中，桌面端也会拒绝其登录和模型选择请求。已有凭据和配置会保留，但关闭时不能用于桌面聊天。内部测试可在启动 MicroClaw **之前**，在进程环境中设置 `MICROCLAW_INTERNAL_GITHUB_COPILOT=1`，开发版和打包版均适用。请先完全退出已有应用实例；此开关不是持久化的用户设置，重启后才会生效。纯浏览器开发模式仍保持关闭。

```powershell
$env:MICROCLAW_INTERNAL_GITHUB_COPILOT = '1'
& "$HOME\.microclaw\MicroClawDesktop.exe"
```

删除该环境变量并完全重启应用，即可再次关闭此内部功能。其他云端和本地模型提供商不受影响。

#### 本地模型（实验性）

**设置 → 模型** 以统一卡片展示云端提供商和“本地模型”（llama.cpp）；已有自定义 API 连接仍可管理，但总览不再提供“添加兼容 API”按钮或未配置的占位卡片。点击“管理”在原卡片中展开连接编辑。这里保存连接不切换默认模型，也不发送 AI 测试消息；初次配置仍保留原有引导流程。默认模型单独选择。

提供商卡片通过向下/向上箭头展开和收起。内嵌编辑器直接展示字段，不再重复提供商标题、配置说明和关闭按钮。千问/MiniMax 仅使用模型下拉框，不再在表单上方另列已保存模型及逐条 Edit/Remove 按钮；已有配置仍然保留。“获取 API 密钥”放在千问/MiniMax 表单的 API Key 输入框右侧，分别打开[百炼北京地域 API Key 控制台](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)和[MiniMax 接口密钥控制台](https://platform.minimax.cn/user-center/basic-information/interface-key)。模型下拉框排在 API Key 之后，右侧提供刷新图标。

填写非空凭据并成功完成带认证的只读 `GET /models` 请求之前，千问/MiniMax 模型下拉框保持禁用。下拉列表只使用接口实际返回的模型 ID，不使用静态预设兜底；单个模型能否调用仍取决于服务商权限和额度。修改 Key 或地址会立即使旧列表失效，过期响应会被丢弃，可点击“刷新模型列表”重试。认证失败、脱敏 Key、空目录或不支持的接口均明确提示。获取目录不会保存配置、重启 Gateway 或发送推理请求。新建 MiniMax 连接使用官方文档的 `https://api.minimax.cn/v1`，已有保存地址不会被自动改写。

提供商表单、默认模型选择器和聊天选模菜单共享已配置千问/MiniMax 连接的完整实时目录，后两处不再仅列出曾经保存过的模型。同一连接刷新后，三处同步更新；尚未保存的密钥使用独立的内存目录。目录获取失败时明确报错，默认/聊天菜单保留已保存项，但不将其冒充完整实时目录。

完整目录也包含不能通过普通聊天接口调用的模型。已知的实时、向量、重排序、语音和媒体生成系列在三处仍可见，但会标明原因并禁用选择；主进程也会阻止选择及已有会话继续调用这些型号。例如 [Qwen3.8-Omni-Flash-Realtime 要求实时传输接口](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime)，不能使用当前聊天接口。兼容性检查不代表账号拥有调用权限：HTTP 403 或上游统一处理后的访问拒绝会提示服务商访问问题，不再一律认定为 Key 无效；需在服务商控制台检查型号权限、地域和计费设置。

选择实时目录中尚未注册的聊天型号时，先用已保存的服务商凭据核验，再通过带版本保护的 Gateway patch 仅注册该型号，并等待应用完成后切换；不重启、不推理、不修改密钥、不放宽模型权限策略。默认选择器仅改变默认模型，聊天选择器仅改变当前会话。同一连接仅修改模型并保存，也使用热注册路径，不改变默认或会话模型；真正修改 API Key 或地址仍走连接更新流程。

每个托管提供商表单最后保存的型号会单独记在桌面偏好中，重开表单不会跳回第一个已注册型号；此偏好不改变默认模型或任何会话。分组选择器通过真实 Element Plus 弹层提供带名称的对话框和展开状态，不增加重复的可见标题。

聊天输入框旁的模型按钮支持搜索完整云端实时目录、已保存的自定义连接，以及 **Qwen3.5 4B Q4_K_M**、**Qwen3.5 9B Q4_K_M** 两个托管本地预设，通过 OpenClaw 会话覆盖设置**只切换当前会话**。新建对话的会话标识会明确携带所选智能体的归属（包括主智能体），多智能体配置下也可在第一条消息发送前选模。“使用智能体默认模型”仅清除此会话覆盖，不修改智能体或全局默认值、回退模型及其他会话。首次选择会展示精确模型大小、缺少的嵌入模型、运行时预留磁盘及 CPU/GPU 模式，明确确认后才下载，准备成功后才切换；失败或取消保留原模型。已准备的模型直接切换，在原选模控件显示“切换中…”，不再闪现准备弹窗，也不运行设置或 AI 测试。需要准备、发生错误或恢复中断操作时，仍保留可阅读和操作的弹窗。

聊天选模菜单和 **设置 → 模型 → 默认模型** 共用可折叠的提供商分组，默认只展开各自当前所选模型所属的提供商。点击分组标题或使用 Enter、空格键即可展开/收起；搜索自动展开匹配分组，清空后恢复之前的折叠状态。折叠仅改变列表显示，不切换模型、不改配置、不触发下载。设置中的选择仍修改全局默认模型，聊天中的选择仍只影响当前会话。

聊天选模首次读取清单时在按钮上显示“读取模型中…”，清单完整后再展开。之后再次打开时保留上次的列表和文件状态，在后台刷新后一次性更新，不再分批清空、补入提供商而导致面板反复变高或跳动。首次读取期间关闭或移开按钮焦点，不会在读取完成后突然弹出菜单。

切换已有云端**默认模型**时，通过带版本保护的 `config.patch` 更新，并等待 Gateway 确认应用该版本，不再无条件重启整个 Gateway。仅更改默认主模型，保留回退模型、模型权限策略、凭据以及 Agent 和会话覆盖。Copilot 选模和清单读取使用已准备的模型元数据，不触发完整提供商发现。拒绝、结果不明或仍在应用时会明确报错，不自动重试或回滚；若上游明确要求重启，也不会误报为热切换成功。

会话选模结果不明时，聊天选模菜单和模型设置中会提供恢复入口，避免所有对话一直被锁住。请求已明确结束，或原受管网关进程已确认停止时，可以通过重新读取状态恢复；否则需明确确认“重启网关并恢复”，确认原进程停止后接受已保存的状态，不重发切换请求、不回滚、不删除历史。仅 WebSocket 重连或模型值碰巧相同，不能证明旧写入已结束。普通模型切换仍不重启网关。

可选的**真实服务商/Gateway**冒烟测试（不是桌面 UI 测试）：将 `MICROCLAW_TEST_OPENCLAW_ENTRY` 指向已安装的 `openclaw.mjs`，将 `MICROCLAW_TEST_LIVE_QWEN_CONFIG` 指向包含已授权千问 Key 的配置，然后在 `desktop` 运行 `npx vitest run src\provider-model-live.integration.test.ts`。测试使用隔离临时状态切换默认/会话模型，向 Qwen3.8 Max 和 Flash 发出简短真实请求，配置 512 token 输出预算。它可能消耗额度或产生服务商费用，未同时设置两个变量时跳过；不会改写传入配置，也不会操作桌面窗口或键鼠。

不打断桌面的自动化可在启动安装器或客户端时设置仅限该进程的环境变量 `MICROCLAW_BACKGROUND=1`：安装器不激活窗口，客户端启动使用 `showInactive`，并保持渲染器后台计时器可用。正常启动行为不变。此模式不会关闭沙箱，也不授权控制用户键鼠；自动化应使用应用内部操作，并确认没有激活窗口。安装器窗口标题为 **MicroClaw Setup**，与客户端明确区分。

安装器不再安装或启用官方 llama.cpp provider。用户在 **设置 → 模型 → 本地模型** 中点击 **启用**，审阅官方组件并明确确认后，才会安装或启用提供商。仅打开设置不会安装组件或下载模型；模型权重和推理运行时仍需首次使用时另行确认。升级保留已有本地提供商及用户明确禁用的插件策略。组件安装并启用后，本地卡片即显示“已连接”，不取决于模型是否下载；它表示提供商可用，不是推理健康检查。

OpenClaw 固定版本未变化时，桌面更新只刷新托管文件，不在轻量回滚快照之外重复迁移数据库。运行时升级仍执行完整迁移；两种路径都必须等待安装后的桌面与 Gateway 就绪，才会提交安装。

- 打开模型设置只读取已有配置、小型路由配置和两个固定缓存文件的元数据。插件状态刷新不查询 ClawHub，不扫描硬件、不推理、不下载；只有用户明确审阅或安装组件时才查找在线安装来源。
- 模型列表显示“已下载 / 未下载”或未知状态。文件缺失时进入首次准备流程，不会立即切换当前模型；取消准备后保留的完整缓存可复用。浏览不会读取 GGUF 内容或扫描缓存目录，已有外部服务连接仍单独保留。
- 点击 **下载并选用** 后立即显示进度及 Gateway 当前的下载/运行组件安装消息，不再停留在确认页，也不能重复提交确认。准备失败会明确显示原因；重试时复用完整且通过哈希验证的缓存，不重复下载模型。
- **选用模型不再运行“Test AI connection”或工具调用测试。** 点击“开始使用”后，通过带版本保护的 `config.patch` 保存选择，再只读核对配置是否生效，不生成测试回复或读取临时文件。连接、模型和工具兼容性问题在实际聊天时提示。配置校验、并发写入保护和沙箱权限不变；“已选用”不表示模型能力已经验证。
- **托管模型**：4B 排在前面作为轻量选择，9B 资源要求更高，CPU 推理可能较慢。选 4B 就只准备 4B，不会自动换成 9B。OpenClaw 继续负责硬件准入、下载哈希、运行时安装和取消。MicroClaw 对指定 2026.9.3 provider 应用版本/源文件哈希固定的内存适配，为官方向导增加精确选择并保留已有模型路由；源码或确认回执不匹配时明确拒绝，不修改已安装的 OpenClaw 文件。
- **连接已有服务**：展开“高级选项与说明”，接入自行运行在 `localhost`、`127.0.0.1` 或 `::1` 的 llama-server，仅在服务要求时填写密钥。MicroClaw 不接管或停止该服务。
- 切换模型会保留云端及本地连接，不新增自动云端兜底。已有 OpenClaw fallback、agent 或会话模型覆盖仍需单独检查。本地推理不代表联网技能可以离线运行。
- 本地向导未结束时仍可打开云端设置。只有实际保存或切换模型时，才会询问是否先取消冲突的本地配置；拒绝后保持原状。本地模型未配置的目录项仅限这两个固定预设，其他已有连接仍保留；本地连接管理放在高级选项中。
- 集成会检查 Gateway 的公开设置接口，支持 OpenClaw 2026.10.2、2026.10.3 或 2026.9.x 中的 2026.9.3 及以上版本。内置官方目录没有该插件时，MicroClaw 核对 ClawHub 官方包身份并请求固定版本 `@openclaw/llama-cpp-provider@2026.9.3`，不追随浮动最新版。下载、运行时依赖与 GPU 支持仍以官方插件为准。
- 实际配置写入仍受 Windows Node + MXC、当前回复和未结束配置操作的保护。准备本地模型本身不再阻止已有聊天，真正应用模型变更时仍会保护当前请求。断线后恢复原操作，不重复启动；OpenClaw 正在完成受保护步骤时可能暂不接受取消。

**Windows 兼容处理：**MicroClaw 为受支持 OpenClaw 中的指定 `fs-safe@0.8.5` 依赖回移了[上游 Windows 文件打开时间戳修复](https://github.com/openclaw/fs-safe/commit/6ae2e2e5086f2c48b813f78cb65fd787c9879a3f)，并补充复制后 `ctime` 延迟更新的收尾处理：仅允许身份、大小和修改时间不变的单链接普通文件进入复核，且内容必须与复制时记录的 SHA-256 一致。复核采用固定大小缓冲区，核对打开的文件句柄和路径，并在删除授权后再次比对完整身份。真实修改仍报错，硬链接别名不使用该例外。预加载模块核对版本及移动、清理两个模块的 SHA-256 后，仅在内存中应用修复，不修改已安装的 OpenClaw 文件。其他依赖版本保持原样；修改过的 0.8.5 源码会被明确拒绝。这些检查只在文件移动时执行，不会在打开模型设置时读取模型内容。

固定版本的 llama.cpp 适配还会对 Windows 运行组件目录发布时的短暂占用（`EPERM`、`EACCES`、`EBUSY`）最多重试五次，累计等待 3.1 秒。每次重试均核对原目录身份，并要求目标仍不存在。持续失败仍明确报错；压缩包哈希、安装前后版本校验、取消和沙箱保护均不改变。

OpenClaw 10.2 从状态目录的 `tmp/plugin-captures` 加载不可变插件副本时，精确模型选择适配仍会生效。原插件和副本的身份、源码必须匹配固定版本的校验值；路径重定向会被拒绝，不改写已安装插件文件，也不跳过模型身份和下载确认。

官方插件安装和真正的 Electron 桌面引导已在 Windows 上推进到下载确认步骤；完整准备流程也已使用 4B/embedding 缓存的独立副本及新安装的运行组件验证，不进行推理或承诺推理速度。不会自动下载 GGUF 模型文件。自行管理的本地服务也可继续使用原有“其他模型”中的 OpenAI 兼容接口配置。

CPU 模式处理较长的初始上下文时可能需要更多时间。Gateway 仍连接时，界面会延长有限等待并核对历史回复，不会仅凭一段时间没有输出就判断模型断网。成功回复会清除这种等待提示，但真实的模型接口错误仍会保留。

开发者可按需检查已安装的 OpenClaw：

```powershell
$env:MICROCLAW_TEST_OPENCLAW_ENTRY = 'C:\path\to\openclaw\openclaw.mjs'
npm --prefix desktop test -- src/local-model-gateway.integration.test.ts
```

额外设置 `MICROCLAW_TEST_INSTALL_LOCAL_PROVIDER=1` 会在一次性状态目录安装官方插件并推进到模型下载确认步骤，检查取消流程，不会同意模型下载或修改用户的 OpenClaw 配置。运行 `src/openclaw-fs-safe-compat.test.ts` 时，可将 `MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR` 指向 OpenClaw 安装目录，核验两个指定模块及已安装文件内容未被修改；再设置 `MICROCLAW_TEST_LOCAL_PLUGIN_DIR` 指向已有官方插件目录，可离线执行 100 次复制/清理并检查并发修改的源文件仍被保留。`src/openclaw-fs-safe-cleanup.test.ts` 无需已安装运行时即可覆盖时间戳、内容、路径及授权竞态。

也可将 `MICROCLAW_TEST_LOCAL_PLUGIN_DIR` 指向已有的官方 llama.cpp 插件目录，在一次性 Gateway 和拒绝全部推理请求的本地端点上检查直接选用流程。该检查要求配置切换成功且推理请求数为零，不改动用户当前模型。

设置 `MICROCLAW_TEST_OPENCLAW_ENTRY` 和 `MICROCLAW_TEST_LOCAL_PLUGIN_DIR` 后，运行 `npm --prefix desktop test -- src/local-model-preparation.integration.test.ts` 可通过真实插件加载器检查精确模型下载确认，再取消操作；不设置 `MICROCLAW_TEST_LOCAL_CACHE` 时不会下载模型或运行推理。

完整准备检查还需将 `MICROCLAW_TEST_LOCAL_CACHE` 指向包含固定 4B 和 embedding 文件的缓存，再运行 `npm --prefix desktop test -- src/local-model-preparation.integration.test.ts`。它将模型文件复制到一次性状态目录，要求确认回执中的模型和 embedding 下载量均为零，再安装、校验官方运行组件。运行组件压缩包可能需要下载，但不下载模型权重，不选用模型、不推理，也不改变原缓存或用户配置。

### 3. 安装完就能开始做事

默认首页不是空白状态，而是自带每日资讯、桌面整理、出行助手等推荐任务卡片，以及一组常见提示词建议。内置技能和托管技能已经安装好，只有在某些特定工作流需要接入外部服务时，才需要额外补充对应服务自己的 API 凭据。

---

## 卸载

**一键卸载** — 双击桌面上的 **Uninstall MicroClaw** 快捷方式（或运行 `MicroClawInstaller.exe --uninstall`）。此操作会移除桌面应用、技能、沙箱配置、快捷方式，以及安装器安装的 Node.js / Git / OpenClaw 依赖。

---

## 桌面应用

Electron 桌面应用是用户的主要交互入口：

- **聊天界面**：基于 Vue 3 + Element Plus，支持多会话
- **Gateway 管理**：自动启动/重启本地 OpenClaw Gateway
- **WebSocket 通信**：JSON RPC 协议，Ed25519 设备认证
- **技能完整性检测**：启动时 SHA-256 校验所有技能文件，Ed25519 验签
- **系统托盘**：后台运行，状态指示

开发模式：

```bash
cd desktop
npm install
npm run dev
```

---


## 技能系统

### 内置技能（52 个）

随 OpenClaw 一同安装，通过 `skills.allowBundled` 白名单控制启用。涵盖：

| 类别 | 技能示例 |
|---|---|
| 生产力 | obsidian, notion, trello, slack, discord, things-mac |
| AI / 编码 | coding-agent, gh-issues, oracle, skill-creator |
| 通信 | bluebubbles, wacli, voice-call |
| 智能家居 | openhue, blucli, sonoscli, eightctl |
| 媒体 | spotify-player, songsee, video-frames |
| 工具 | weather, healthcheck, session-logs |
| 语音 | openai-whisper, sherpa-onnx-tts, sag |

### 托管技能（6 个）

安装到 `~/.openclaw/skills/`，包含本项目定制的高级技能：

| 技能 | 说明 |
|---|---|
| excel-xlsx | Excel 工作簿创建与编辑 |
| powerpoint-pptx | PowerPoint 演示文稿创建与编辑 |
| word-docx | Word 文档创建与编辑 |
| officecli | Office 文档 CLI 工具（创建/编辑 .docx/.xlsx/.pptx） |
| desktop-organizer | 扫描并整理 Windows 桌面文件 |
| security-practice | AI Agent 行为安全规范（红线/黄线规则、安装审计协议） |

### 智能体专属技能

专属技能只作为桌面安装包中的休眠资源存在；添加对应专家智能体时才会安装：

| 智能体 | 技能 | 说明 |
|---|---|---|
| 灵感创客 | rednote-publisher | 生成分阶段选题、素材集合和可发布的小红书图文包 |

---

## 微信插件

`plugins/openclaw-weixin/` — 将 OpenClaw 接入微信：

- 扫码登录，无需用户名密码
- 多账号 + 发送者隔离
- 支持文字、图片、视频、文件消息
- 长轮询消息更新

---

## 安全特性

| 机制 | 说明 |
|---|---|
| **技能完整性校验** | SHA-256 哈希 + Ed25519 签名，启动时检测所有技能文件是否被篡改 |
| **设备认证** | 每台设备生成 Ed25519 密钥对，Gateway 连接时签名认证 |
| **技能白名单** | `allowBundled` / `allowManaged` 控制可用技能范围 |
| **沙盒隔离** | 原生 MXC Full/Limited；明确关闭后不使用执行沙箱 |
| **本地 Gateway** | 仅绑定 loopback，不接受远程连接 |

---

## 构建

完整构建流程（PowerShell）：

```powershell
.\build.ps1
```

该脚本依次执行：

1. 构建桌面应用（`desktop/` → Electron Builder）
2. 创建便携版 zip 包（`dist/microclaw-portable.zip`）
3. 打包安装器 exe（PyInstaller → `dist/MicroClawInstaller.exe`）

### 前置条件

- Node.js 26.1+（推荐），或 24.x 系列的 24.16+
- Python 3.10+ —— 通过 `pip install -r requirements.txt` 安装构建依赖（已包含 PyInstaller）
- .NET SDK（原生 Windows Node + MXC 主机，版本以固定项目为准）
- .NET 10 SDK（用于构建内置 Windows Node 主机）
- npm 依赖已安装（`cd desktop && npm install`）

---

## 项目结构

Windows 侧运维脚本现在统一放在 `scripts/windows/` 下。仓库根目录保留 `.bat` 和 `.ps1` 兼容包装层，因此现有命令仍可继续使用。

```
├── deploy.py                    # 稳定安装器入口（Tkinter GUI）
├── deployer/
│   ├── config.py                # 配置管理（.env + YAML）
│   ├── logger.py                # 线程安全日志 + 内存环形缓冲
│   ├── skill_catalog.py         # 52 内置 + 6 托管技能目录
│   ├── skill_manager_ui.py      # 技能选择器对话框
│   └── windows_setup.py         # Windows 安装逻辑（Node/npm/OpenClaw）
├── desktop/                     # Electron 桌面应用
│   ├── src/                     # 主进程（TypeScript）
│   └── renderer/                # Vue 3 渲染进程
├── windows-node-host/           # 原生 MXC 执行及精确命令审批
├── skills/                      # 托管技能定义
├── plugins/openclaw-weixin/     # 微信频道插件
├── scripts/
│   ├── windows/                 # Windows 侧规范脚本目录
│   └── generate-skill-snapshot.js
├── docs/
│   ├── architecture/            # 仓库结构与架构决策
│   ├── plans/                   # 规划文档
│   └── reference/               # 设计与配置参考文档
├── build.ps1                    # 一键构建脚本
├── launch.bat                   # 兼容包装层 -> scripts/windows/launch.bat
├── setup.bat                    # 兼容包装层 -> scripts/windows/setup.bat
├── setup-dependencies.ps1       # 兼容包装层 -> scripts/windows/setup-dependencies.ps1
├── uninstall.bat                # 兼容包装层 -> scripts/windows/uninstall.bat
├── uninstall-dependencies.ps1   # 兼容包装层 -> scripts/windows/uninstall-dependencies.ps1
├── start-gateway.cmd            # 手动启动 Gateway
├── MicroClawDeployer.spec       # PyInstaller 打包配置
└── requirements.txt             # Python 依赖
```

更完整的结构规则和长期迁移目标见 [docs/architecture/repository-layout.md](docs/architecture/repository-layout.md)。

## 配置说明

普通用户在**桌面应用 设置**里完成所有配置即可：模型、Brave API Key、技能白名单等。运行时配置存于 `~/.openclaw/openclaw.json`，如有需要可手动编辑。

全新安装会预装与默认 OpenClaw 运行时同版的官方 Parallel 联网搜索插件（固定为 **2026.10.5**），并默认选择无需 API 密钥的 `parallel-free`
提供商，因此安装后即可直接使用联网搜索。升级时会保留可用的联网搜索提供商；未配置 API 密钥
的 Brave 或 Tavily 会自动回退到 Parallel。之后也可在**设置**中修改。

开发者/批量部署可通过 `.env` 预置凭据（`MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME` / `MODEL_API_FORMAT` / `MODEL_REASONING_EFFORT` / `BRAVE_API_KEY`），详见 [.env.example](.env.example)。运行 `python deploy.py` 时读仓库根目录的 `.env`；运行打包后的 `MicroClawInstaller.exe` 时读与 exe 同目录的 `.env`。

## 系统要求

- Windows 10/11
- Python 3.10+（仅运行安装器需要）
- 网络连接（支持中国大陆镜像源）
- 可选：Microsoft Edge（浏览器技能）

## 发布策略

MicroClaw 的 GitHub Release 页面有意**只提供源码**，不会发布任何预构建的安装包（`MicroClawInstaller.exe`、portable zip 或其他打包产物）。用户需克隆仓库并自行运行 `build.ps1` 生成安装器。这样可以保证分发渠道透明、可审计——你运行的任何二进制都是你从可检阅的源码亲手构建出来的。

如果你 fork 本项目，除非你愿意承担代码签名、恶意软件扫描、供应链证明等责任，建议保持同样的发布策略。

## License

MIT
