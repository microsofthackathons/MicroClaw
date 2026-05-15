# AppContainer Gateway Event Loop Investigation

**Date**: 2026-03-25 ~ 2026-03-26  
**Branch**: `feature/appcontainer`  
**Status**: Gateway event loop blocks inside AppContainer — root cause narrowed but not fully resolved

---

## Goal

Replace Sandboxie with Windows native AppContainer for sandboxing the OpenClaw gateway process.

## Architecture Overview

```
External Client ──→ Launcher (C#, outside AC) ──→ Relay ←── ac-relay.js (inside AC) ──→ Gateway (inside AC)
                     │                              │
                     ├─ TcpRelay: listens on 18790  │
                     └─ Job Object: kills child     └─ Pool of outbound TCP connections
```

AppContainer blocks **all inbound loopback** (even with `checknetisolation LoopbackExempt`), so we use a reverse TCP relay where the AppContainer process makes **outbound** connections to the Launcher.

## What Works ✅

| Component | Status | Evidence |
|-----------|--------|----------|
| AppContainerLauncher.exe (C#) | ✅ | CreateProcessW + SECURITY_CAPABILITIES + Job Object |
| AppContainer profile + ACLs | ✅ | node.exe runs, reads files, writes to .openclaw |
| Simple HTTP server in AC | ✅ | `LISTEN_OK`, binds port, responds to relay |
| TCP reverse relay (TcpRelay.cs) | ✅ | Listens on public port, accepts pool connections |
| ac-relay.js standalone process | ✅ | GO signal → connects to gateway → pipes data |
| Simple relay end-to-end | ✅ | `STATUS:200 BODY:RELAY_OK` via relay |
| Gateway outside AC | ✅ | `STATUS:200 BODY:{"ok":true,"status":"live"}` |
| Gateway `--help` in AC | ✅ | Full help text printed, exits cleanly |
| Gateway banner + listen in AC | ✅ | Banner prints, port binds (netstat LISTENING) |

## What Fails ❌

| Issue | Details |
|-------|---------|
| Gateway HTTP responses in AC | Gateway binds port but **never responds** to HTTP requests |
| Event loop after startup | Blocks permanently after printing banner/listen message |
| `[AC-DIAG]` instrument patches | console.log overridden by pino; console.error not captured by Launcher |

## Root Cause Analysis

### The Problem

When OpenClaw gateway runs inside AppContainer, its Node.js event loop **blocks permanently** after the HTTP server binds its port. The server accepts TCP connections (netstat shows ESTABLISHED) but never processes them — `request` event callbacks never fire.

### Why Simple HTTP Servers Work

Simple inline HTTP servers (`-e "require('http').createServer(...)..."`) have a **clean event loop** — they only do `createServer` + `listen` + `setTimeout`. No module loading, no config reading, no child process spawning.

### Why Gateway Fails

The real gateway does extensive post-listen initialization:

```
1. logGatewayStartup()                    ← "🦞 OpenClaw" banner printed
2. scheduleGatewayUpdateCheck()           ← May hit network (outbound OK in AC)
3. startGatewayTailscaleExposure()        ← Skipped if tailscaleMode="off"
4. startGatewaySidecars()                 ← ⚠️ LIKELY BLOCKER
   ├── cleanStaleLockFiles()              ← Uses fs operations
   ├── startBrowserControlServer()        ← May spawn Playwright/browser
   ├── startGmailWatcherWithLogs()        ← Network + hooks
   ├── loadInternalHooks()                ← Dynamic imports
   ├── startChannels()                    ← Channel plugin initialization
   └── startPluginServices()              ← Plugin lifecycle
5. startGatewayConfigReloader()           ← fs.watch + hot reload
```

Key suspects in `startGatewaySidecars()`:
- **`startBrowserControlServerIfEnabled()`** — dynamically imports `server-oNCflMjY.js`, which may attempt to launch a browser subprocess. `spawnSync` → EPERM in AC.
- **`startChannels()`** — initializes channel plugins that may spawn child processes or make network calls that fail silently and block.
- **`cleanStaleLockFiles()`** — calls `spawnSync` for process detection → EPERM.
- **Any `process.kill(pid, 0)`** — returns EPERM (not ESRCH) in AC, causing stale-process detection to believe processes are alive → retry loops with `Atomics.wait()` → event loop block.

### AppContainer-Specific Behaviors Causing Issues

| Behavior | Normal | AppContainer |
|----------|--------|-------------|
| `spawnSync("netstat")` | Works | **EPERM** |
| `process.kill(pid, 0)` for dead PID | ESRCH | **EPERM** (treated as "alive") |
| `realpath(path)` on dirs w/o ACL | Works | **EPERM** |
| Inbound loopback TCP | Works | **Blocked** (even with exemption) |
| Outbound loopback TCP | Works | **Works** ✅ |
| `os.tmpdir()` | System TEMP | Redirected to `Packages/microclaw/AC/Temp` |
| `mkdirSync(tempDir)` | Works | **May fail** if parent dir not writable |
| Child process creation | Works | **EPERM** |

### Why It Worked Once (Edge Browser Test)

Earlier in the investigation, a gateway started without `--force` and without relay appeared to respond. This was likely:
1. Gateway was running **outside AppContainer** at that time (direct node launch for baseline testing), OR
2. The AppContainer gateway happened to complete its initialization before the blocking operation kicked in (race condition with async initialization), OR
3. A different code path was taken because certain config/state files didn't exist yet

## Attempted Solutions

### 1. Remove `--force` Flag ✅ (Partial)
- `--force` calls `spawnSync("netstat")` → EPERM → hangs
- Removing `--force` avoids this specific path
- **Result**: Gateway starts but event loop still blocks from other sync operations

### 2. Skip Capabilities / All Capabilities ❌
- Tried all 12 well-known capabilities
- **Result**: No effect on event loop blocking

### 3. `--require` Relay Injection ❌
- Injected `ac-relay.js` via `NODE_OPTIONS="--require ..."`
- **Result**: Relay callbacks never execute because they share gateway's blocked event loop

### 4. Standalone Relay Process ✅ (Architecture Works)
- Separate `node.exe ac-relay.js` process with its own event loop
- **Result**: Relay works perfectly (GO signals, pool management, data forwarding)
- But gateway still doesn't respond to forwarded requests

### 5. Skip Browser Control + Channels ❌
- Set `OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1` and `OPENCLAW_SKIP_CHANNELS=1`
- **Result**: Still no response — blocking happens elsewhere

### 6. Diagnostics via `console.log` / `console.error` ❌
- Patched `gateway-cli-*.js` with `[AC-DIAG]` markers
- **Result**: Never visible — `console.log` overridden by pino logger, `console.error` not captured by Launcher's stdout/stderr pipe

### 7. Diagnostics via `appendFileSync` (Incomplete)
- Attempted file-based diagnostics
- **Result**: Patches got corrupted by chained string replacements; needs clean re-patch

## Architecture Components Built

### AppContainerLauncher.exe (C# / .NET 9)
- `ContainerManager.cs`: CreateProcessW with SECURITY_CAPABILITIES, Job Object, ACL management
- `NativeMethods.cs`: Win32 P/Invoke declarations
- `Program.cs`: CLI with `run`, `grant`, `revoke`, `delete`, `setup`, `loopback` commands
- `TcpRelay.cs`: TCP reverse relay (public port ↔ pool ↔ AC outbound)
- `ac-relay.js`: Standalone Node.js relay process for AppContainer

### Desktop Integration (TypeScript)
- `main.ts` + `gateway-manager.ts`: AppContainer detection, `--relay-port`, no `--force` in AC mode

### Deployer Integration (Python)
- `windows_setup.py`: `provision_appcontainer()`, `_uninstall_appcontainer()`
- `deploy.py`: Wire provisioning into install flow

### Build Pipeline
- `build.ps1`: dotnet publish step before electron-builder

## Git Commits (feature/appcontainer)

1. `feat: integrate AppContainer sandbox into gateway launch`
2. `feat: complete AppContainer end-to-end integration`
3. `fix: AppContainer provisioning and build pipeline`
4. `fix: add Job Object to kill child node.exe when launcher exits`
5. `feat: TCP reverse relay for AppContainer gateway`
6. `fix: standalone relay process instead of --require injection`

## Recommended Next Steps

### Option A: Gateway Outside AC + Tool Execution in AC (Recommended)
- Gateway runs normally outside AppContainer (verified working)
- Only sandbox AI agent's tool/command execution via `AppContainerLauncher.exe run`
- No relay needed, no event loop issues
- Requires configuring gateway's shell command wrapper

### Option B: Fix Event Loop Blocking (Hard)
- Need to identify exact blocking operation via file-based diagnostics
- May require patching gateway dist to add `try/catch` around sync operations
- Or setting many `OPENCLAW_SKIP_*` env vars to disable all AC-incompatible features

### Option C: Stdio Proxy (Complex)
- Replace TCP relay with stdin/stdout communication
- Launcher acts as HTTP proxy, forwards bytes via pipes
- Avoids all loopback networking issues
- Requires significant C# and gateway-side changes
