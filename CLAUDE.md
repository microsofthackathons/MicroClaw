# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MicroClaw is a Windows desktop application that packages the OpenClaw open-source Agent framework. It includes an Electron chat UI, a local OpenClaw Gateway, 52+ built-in skills, 7 managed skills, an AppContainer-based tool sandbox, a WeChat plugin, and a Teams bot integration.

## Build & Development Commands

### Full Build (PowerShell)
```powershell
.\build.ps1
```
Cleans artifacts → builds desktop + permissions-manager in parallel → creates portable ZIPs → packages installer EXE via PyInstaller.

### Desktop App (Electron + Vue 3)
```bash
cd desktop
npm install          # also runs postinstall for renderer/
npm run dev          # launches Vite dev server + Electron concurrently
npm run build        # tsc + vite build
npm run pack         # build + electron-builder --win --dir
```

### Permission Manager (Electron + Vue 3)
```bash
cd permissions-manager
npm install
npm run dev
npm run pack
```

### Installer (Python)
```bash
python deploy.py     # or double-click launch.bat
```

### Tests (Vitest)
```bash
cd desktop
npm run test              # run all main-process tests (vitest, node env)
npm run test:watch        # watch mode
npm run test:coverage     # with coverage

cd desktop/renderer
npm run test              # run all renderer tests (vitest, jsdom env)
npm run test:watch
```
Test files live alongside source with `.test.ts` suffix. Main process tests use `node` environment (vitest.config.ts). Renderer tests use `jsdom` environment (vite.config.ts).

To run a single test file:
```bash
cd desktop && npx vitest run src/constants.test.ts
cd desktop/renderer && npx vitest run src/stores/sessions.test.ts
```

### Lint & Format (root)
```bash
npm run lint            # ESLint across all JS/TS packages
npm run format          # Prettier --write . (root invocation; honours .prettierignore)
npm run format:check    # Prettier --check . (used by CI)

# Python (after one-time `python -m pip install "ruff>=0.14.0"`):
ruff check .            # lint
ruff format .           # auto-fix formatting
ruff format --check .   # CI parity
```
Prettier config: `.prettierrc.json`. Ignored: `.prettierignore` (excludes `**/*.md`, lockfiles, build outputs, Python/C#/PowerShell, binary assets). ESLint and Prettier are coordinated via `eslint-config-prettier` (wired last in each `eslint.config.mjs`). Ruff config: `pyproject.toml` (`[tool.ruff]` section).

## Architecture

### Two Electron Apps

1. **Desktop App** (`desktop/`) — Main chat interface + gateway lifecycle
   - Main process: `desktop/src/` (TypeScript, compiled to CommonJS via tsc → `dist/`)
   - Renderer process: `desktop/renderer/` (Vue 3 + Element Plus + Pinia, built by Vite)
   - tsconfig targets ES2022 with CommonJS modules, strict mode

2. **Permission Manager** (`permissions-manager/`) — Sandboxie configuration GUI
   - Same Electron + Vue 3 structure as desktop

### Desktop Main Process Key Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Electron lifecycle, IPC handler registration, gateway spawn/monitoring |
| `gateway-client.ts` | WebSocket JSON-RPC client to OpenClaw Gateway |
| `gateway-manager.ts` | Spawns/monitors/restarts the gateway child process |
| `skill-integrity.ts` | SHA-256 hashing + Ed25519 signing for skill tamper detection |
| `device-identity.ts` | Ed25519 keypair generation for device authentication |
| `path-resolver.ts` | Resolves OpenClaw state dir, Node path, entry point |
| `preload.ts` | Context-isolated IPC bridge exposing `window.openclaw` API |
| `tray.ts` | System tray icon and menu |
| `constants.ts` | All shared magic numbers (ports, timeouts, intervals) |

### Renderer Architecture

- **Pinia stores**: `chat.ts`, `gateway.ts`, `sessions.ts`, `agents.ts`, `channels.ts`, `tasks.ts`
- **Views**: `ChatView`, `HomeView`, `SettingsView`, `SetupWizard`, `ChannelsView`, `PluginsView`, `TasksView`
- **Path alias**: `@` maps to `renderer/src/`
- **i18n**: English + Chinese support

### IPC Namespace Convention

IPC handlers follow a `namespace:action` pattern exposed via `preload.ts`:
- `gateway:get-port`, `gateway:restart`, `gateway:get-status`
- `config:read`, `config:write`, `config:is-configured`
- `skills:list`, `skills:integrity-check`, `skills:generate-snapshot`
- `settings:get`, `settings:set`
- `chat:send`, `chat:abort`

### Gateway Communication Protocol

WebSocket JSON-RPC over `ws://127.0.0.1:18789`:
```
→ { type: "req", id, method: "connect", params }    (handshake with Ed25519 auth)
← { type: "res", id, ok: true, payload }
→ { type: "req", id, method: "chat.send", params }
← { type: "event", event: "chat", payload: { state: "delta"|"final"|"aborted"|"error" } }
```

### Installer (Python)

`deploy.py` + `deployer/` — Tkinter multi-page wizard:
- `config.py`: Configuration management (.env loading, YAML config)
- `skill_catalog.py`: Catalog of 52 bundled + 7 managed skills with platform compatibility
- `skill_manager_ui.py`: Graphical skill selector dialog
- `windows_setup.py`: Node.js download, npm install, OpenClaw setup
- `logger.py`: Thread-safe logger with in-memory ring buffer

### Managed Skills (`skills/`)

Custom skills installed to `~/.openclaw/skills/`. Each skill has `SKILL.md` (metadata) + `_meta.json` + implementation scripts. Skills include Office suite (Excel, PowerPoint, Word), browser automation (Playwright), and Bing search variants.

## Configuration

- `.env` (gitignored): `MODEL_API_KEY`, `MODEL_BASE_URL`, `MODEL_NAME`, `BRAVE_API_KEY`
- `openclaw.json`: Auto-generated by installer — gateway port, skill allowlists, model config
- Node.js installed via the official signed `.msi` to `%ProgramFiles%\nodejs\` (per-machine, UAC-elevated; override with `OPENCLAW_NODE_DIR`); existing system Node ≥22.16 at a standard path is reused as-is; OpenClaw state dir at `%APPDATA%/openclaw`

## Key Constants (desktop/src/constants.ts)

- Gateway port: `18789`
- Health check interval: `10s`
- Gateway ready timeout: `60s`
- WS request timeout: `30s`
- WeChat login timeout: `180s`

## Prerequisites

- Node.js 22+ (build.ps1 auto-detects `%ProgramFiles%\nodejs\`, the per-user `%LocalAppData%\Programs\nodejs\`, or the legacy `~/.openclaw-node/`)
- Python 3.10+ (for installer and PyInstaller packaging)
- Windows 10/11 (Electron apps are Windows-only builds)