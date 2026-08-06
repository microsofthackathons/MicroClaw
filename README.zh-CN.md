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
- **一次安装补齐运行环境**：自动准备 Git、受管 Node.js、OpenClaw Gateway、MicroClaw 桌面端、托管技能和 AppContainer 配置
- **安装完成即可启动**：不需要先手动搭本地 OpenClaw 运行环境

### 真正可用，而不是只装了个壳

- **唯一需要用户自备的是 LLM**：用户提供模型地址、API Key 和模型名，其余栈内组件由 MicroClaw 安装并连接起来
- **首启路径很短**：如果还没有模型配置，应用只会引导填写模型凭据；如果 `.env` 里已有 `MODEL_*`，MicroClaw 还可以自动配置
- **首屏自带推荐任务**：首页不是空白输入框，而是预置了任务卡片和提示词建议，安装后就能直接开始做事
- **能力预装到位**：52 个内置技能加 6 个托管技能，作为默认 Windows 体验的一部分直接可用

### 内建信任

- **动作透明、权限可控**：文件和工具访问需要明确向用户申请，而不是静默放行
- **基于 Windows AppContainer 的沙箱隔离**：在支持的系统上，工具执行运行在操作系统强制边界内
- **Hook 加沙箱，形成纵深防御**：Hook 负责更好的交互体验，真正的安全边界仍由 AppContainer ACL 强制执行
- **敏感路径直接硬拦截**：例如 `.ssh`、云凭据目录等不会只是提醒，而是直接拒绝访问

---

## 项目组成

| 组件 | 路径 | 技术栈 | 说明 |
|---|---|---|---|
| **桌面应用** | `desktop/` | Electron 33 + TypeScript + Vue 3 + Element Plus | 聊天界面、Gateway 生命周期管理、托盘菜单 |
| **AppContainer 沙盒** | `appcontainer/` | .NET 9 + Node.js preload hooks | Windows AppContainer 启动器 + 权限钩子，隔离工具执行 |
| **安装器** | `deploy.py` + `deployer/` | Python 3 + Tkinter | 向导式图形化安装器（可打包为单文件 exe） |
| **技能包** | `skills/` | Markdown + JSON + Python/Node | Office、搜索、浏览器自动化等托管技能 |
| **微信插件** | `plugins/openclaw-weixin/` | TypeScript + OpenClaw Plugin SDK | 微信频道接入 |

---

## 快速开始

MicroClaw 仅支持 **Windows 10/11**。对大多数用户来说，真正需要自己提供的只有大模型连接信息。

### 1. 安装

> **发布说明：**MicroClaw 的 GitHub Release 页面**不提供预编译的安装包**。请从本仓库拉取源代码后，自行运行下面的 `build.ps1` 构建。详见 [发布策略](#发布策略)。

从源码构建安装器后运行：

> **构建前置依赖**（仅运行 `build.ps1` 时需要）：**Node.js 22+** 与 **Python 3.10+**。使用 `pip install -r requirements.txt` 安装 Python 构建依赖（其中包含用于打包安装器 exe 的 PyInstaller）。终端用户运行已打包的 `MicroClawInstaller.exe` **无需** 安装 Python。

```powershell
.\build.ps1                                        # 生成 dist/MicroClawInstaller/MicroClawInstaller.exe
.\dist\MicroClawInstaller\MicroClawInstaller.exe   # 运行安装向导
```

安装器会在一次运行中完成 Windows 侧的主要准备工作：

- Git for Windows（PortableGit → `~/.openclaw-git`）
- Node.js 22+，通过官方签名 `.msi` 以 per-machine 方式安装到 `%ProgramFiles%\nodejs\`（UAC 提权；若该路径已存在 ≥22.16 的系统 Node 则直接复用）
- OpenClaw Gateway（`npm install -g openclaw`）
- 配置 npm 镜像源与 V8 编译缓存
- 安装 MicroClaw 桌面客户端、托管技能、AppContainer 沙箱、微信插件
- 添加 Windows Defender 排除项，创建桌面快捷方式（含一键卸载）

安装完成后，从开始菜单或桌面快捷方式启动 **MicroClaw**。桌面应用会自动拉起 Gateway。

### 2. 只补上你的模型配置

首次启动时，只有在模型尚未配置的情况下才会进入 SetupWizard。这里真正需要用户填写的内容只有：

- Base URL
- API Key
- 模型名

之后你可以在 **设置 → 模型** 中随时添加或修改。凭据由桌面应用本地保存，不需要手动创建配置文件。如果 `.env` 已经包含 `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_NAME`，MicroClaw 可以直接预填甚至自动写入配置。

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
| **沙盒隔离** | Windows AppContainer 沙盒，限制 AI 工具执行环境 |
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

- Node.js 22+
- Python 3.10+ —— 通过 `pip install -r requirements.txt` 安装构建依赖（已包含 PyInstaller）
- .NET 9 SDK（用于构建 AppContainer 启动器）
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
├── appcontainer/                # Windows AppContainer 沙盒（.NET + preload hooks）
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

全新安装会预装官方 Parallel 联网搜索插件，并默认选择无需 API 密钥的 `parallel-free`
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
