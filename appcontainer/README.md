# AppContainer Sandbox

Windows AppContainer-based sandbox for isolating tool execution in OpenClaw. Consists of two parts: a .NET launcher that runs processes inside AppContainer, and Node.js preload modules that intercept file/process operations to enforce permissions.

## Architecture

```
Gateway (Node.js)
  │
  ├─ NODE_OPTIONS="--require sandbox-preload.js"
  │    └─ Hooks fs.*, child_process.* → permission checks
  │
  └─ COMSPEC=AppContainerLauncher.exe
       └─ Every exec() runs cmd.exe inside AppContainer
            └─ OS-level ACL enforcement (can't bypass from JS)
```

Two layers of enforcement:
- **JS layer** (preload modules): Pre-blocks known-bad paths before execution, prompts user via IPC dialog
- **OS layer** (AppContainer + ACL): Blocks all unauthorized access regardless of JS-layer decisions
- **Sensitive path shield**: Hard-denies access to credential directories (`.ssh`, `.azure`, etc.) — no permission dialog, no override

## Files

### .NET Launcher

| File | Purpose |
|------|---------|
| `AppContainerLauncher.csproj` | .NET 9 project targeting `win-x64` |
| `Program.cs` | CLI entry point — COMSPEC mode (intercepts `exec()`), plus `grant`/`revoke`/`run`/`shield`/`unshield`/`check` subcommands |
| `ContainerManager.cs` | AppContainer profile management, ACL grants/revokes, sensitive path shielding, process creation with `SECURITY_CAPABILITIES` |
| `NativeMethods.cs` | P/Invoke declarations for `userenv.dll`, `advapi32.dll`, `kernel32.dll` |
| `provision-appcontainer.ps1` | PowerShell script for initial AppContainer setup |

**Entry point**: `Program.cs` — invoked either as COMSPEC (`/d /s /c "command"`) or via CLI subcommands.

### Node.js Preload Modules

Loaded via `NODE_OPTIONS="--require sandbox-preload.js"` into the Gateway process.

| File | Purpose |
|------|---------|
| `sandbox-preload.js` | **Entry point** — external app whitelist (HMAC-verified), loads all modules, handles delayed activation |
| `sandbox-state.js` | Shared state: RO/RW directory lists, safe path detection, `isBlockedPath`/`isReadBlockedPath` |
| `sandbox-permission.js` | Permission request logic: `shouldBlockWrite`/`shouldBlockRead`, sync IPC dialogs, TTL caches, async pending tracking |
| `sandbox-sensitive.js` | **Sensitive path detection** — standalone module, single source of truth for protected directories (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gcloud`). Hard-denies access without IPC or dialogs. Does not depend on `sandbox-permission.js` or `sandbox-state.js` |
| `sandbox-fs-hooks.js` | Monkey-patches `fs` and `fs/promises` — blocks unauthorized reads/writes with permission prompts. Sensitive paths are checked first via `sandbox-sensitive.js` wrapper |
| `sandbox-cp-hooks.js` | Monkey-patches `child_process` — routes shells through AppContainer, pre-blocks paths (including sensitive path detection), detects access-denied in output, blocks `declare-access` for sensitive dirs |
| `path-extraction.js` | Pure functions: extracts file paths from shell command text (PowerShell, cmd, Python patterns) |

**Entry point**: `sandbox-preload.js` — the only file referenced in `NODE_OPTIONS`.

### Activation Modes

- **Main gateway** (`OPENCLAW_SANDBOX_BYPASS=1`): Sandbox activates on the next tick after HTTP server starts listening. Pre-listen startup commands (netstat, etc.) run with bypass; once the server is ready, the sandbox activates before any incoming requests are processed.
- **Forked workers** (bypass absent): Sandbox active immediately.

## How Permission Requests Work

```
1. Gateway calls exec("powershell -Command Get-ChildItem C:\secret")
2. sandbox-cp-hooks extracts path "C:\secret" from command text
3. sandbox-permission checks: not in RW/RO dirs, not safe → blocked
4. Sync IPC to Electron main process → renderer shows dialog
5. User decides: Deny / Allow Once / Grant RO / Grant RW
6. If granted: main process runs icacls to set ACL, writes response file
7. Preload reads response, unblocks, command runs in AppContainer
```

If pre-blocking misses it (e.g. path only known at runtime), the fallback catches access-denied from stderr after execution and sends an async permission request.

## Sensitive Path Shield

Credential directories (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gcloud`) are permanently blocked — even when the parent directory has been granted access. No permission dialog is shown, and the restriction cannot be overridden by the user.

**Three enforcement layers:**

| Layer | Blocks | Mechanism |
|-------|--------|-----------|
| ACL Shield (OS) | Shell commands (`type`, `cat`, `Get-Content`) | `ContainerManager.ShieldSensitivePaths()` breaks ACL inheritance and removes Container SID from sensitive subdirs |
| fs-hooks (JS) | `fs.readFile`, `fs.writeFile`, etc. | `sandbox-sensitive.js` → `isSensitivePath()` checked before `shouldBlockRead`/`shouldBlockWrite` |
| cp-hooks (JS) | `spawn`, `exec`, `declare-access` | `hasSensitivePaths()` in pre-block + `tryInlineDeclareAccess` blocks execution when declared paths are sensitive |

**CLI commands:**
```
AppContainerLauncher.exe shield --name MicroClaw --dir C:\Users\xxx        # Shield all sensitive subdirs
AppContainerLauncher.exe unshield --name MicroClaw --dir C:\Users\xxx\.ssh # Restore inheritance
AppContainerLauncher.exe grant --name MicroClaw --dir C:\Users\xxx --shield-sensitive  # Grant + auto-shield
```

**Error message** (agent-facing): `DENIED: "<path>" is inside a protected sensitive directory (.ssh, .gnupg, .aws, .azure, etc.) and cannot be accessed by the sandbox. This restriction is permanent and cannot be overridden.`

**Orchestration** (Electron main process via `sensitive-shield.ts`):
- After every ACL grant → `shieldIfNeeded()` breaks inheritance on sensitive subdirs
- Before every ACL revoke → `unshieldIfNeeded()` restores inheritance
- On app startup → `shieldAll()` ensures protection is in place

## Build

```powershell
cd appcontainer
dotnet publish -c Release -r win-x64 --self-contained
```

Output: `bin/Release/net9.0-windows/win-x64/AppContainerLauncher.exe`

The JS files don't need building — they're plain ES5 (no transpilation) for maximum compatibility with `--require`.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `COMSPEC` | Set to `AppContainerLauncher.exe` path to intercept all `exec()` calls |
| `OPENCLAW_SANDBOX_BYPASS` | `1` = delayed activation mode (main gateway) |
| `OPENCLAW_SANDBOX_NAME` | AppContainer profile name (default: `MicroClaw`) |
| `OPENCLAW_SANDBOX_CAPS` | Comma-separated capabilities (default: `internetClient`) |
| `OPENCLAW_SANDBOX_DIRS_RW` | Comma-separated directories with read-write access |
| `OPENCLAW_SANDBOX_DIRS_RO` | Comma-separated directories with read-only access |
| `OPENCLAW_SANDBOX_HMAC_KEY` | Secret key for verifying external apps whitelist file |
| `OPENCLAW_SANDBOX_PERMISSION_TIMEOUT` | Timeout in ms for permission dialogs (0 = wait forever) |
