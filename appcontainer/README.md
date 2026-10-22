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
| `sandbox-preload.js` | **Entry point** — external app whitelist (HMAC-verified), loads all modules, activates tool enforcement immediately |
| `sandbox-host-runtime.js` | Canonical-path- and SHA256-verified control-plane import bridge; exposes only read-only boot and process-creation identity probes |
| `sandbox-state.js` | Shared state: RO/RW directory lists, safe path detection, `isBlockedPath`/`isReadBlockedPath` |
| `sandbox-permission.js` | Permission request logic: `shouldBlockWrite`/`shouldBlockRead`, sync IPC dialogs, TTL caches, async pending tracking |
| `sandbox-sensitive.js` | **Sensitive path detection** — standalone module, single source of truth for protected directories (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gcloud`). Hard-denies access without IPC or dialogs. Does not depend on `sandbox-permission.js` or `sandbox-state.js` |
| `sandbox-fs-hooks.js` | Monkey-patches `fs` and `fs/promises` — blocks unauthorized reads/writes with permission prompts. Sensitive paths are checked first via `sandbox-sensitive.js` wrapper |
| `sandbox-cp-hooks.js` | Monkey-patches `child_process` — routes shells through AppContainer, pre-blocks paths (including sensitive path detection), detects access-denied in output, blocks `declare-access` for sensitive dirs |
| `path-extraction.js` | Pure functions: extracts file paths from shell command text (PowerShell, cmd, Python patterns) |

**Entry point**: `sandbox-preload.js` — the only file referenced in `NODE_OPTIONS`.

### Activation Modes

- **Gateway and workers**: Tool sandbox enforcement is active immediately, including before HTTP readiness. There is no startup bypass window.
- **Trusted control plane**: Verified OpenClaw control-plane bundles receive a restricted child-process adapter based on their canonical paths and loaded source hashes, not the package version. There is no runtime version whitelist. Their exact boot-identity query uses a fixed system PowerShell executable, arguments, environment, and timeout on the host. Process creation times use the read-only native Windows API, with a fixed PowerShell fallback accepting only a validated integer PID. Unknown modules and other commands still use the normal sandboxed child-process API. Agent/plugin imports never receive this adapter, even for the same query text.
- **Internal SQLite workers**: Existing canonical-path, argument, and state-directory checks continue to constrain their host-runtime access. This bridge does not grant a general shell exemption or change database access scope.

OpenClaw's internal SQLite snapshot integration recognizes both the 2026.9.x
`openclaw-sqlite-readonly-<pid>-<uuid>` directory format and the 2026.10.2/10.3
`openclaw-sqlite-readonly-v2-<uuid>` format under `%LOCALAPPDATA%\openclaw`.
The internal worker exception still requires the exact Node executable, worker
path, trusted runtime caller, supported mode, and a canonical database path
inside the OpenClaw state directory. Redirected or malformed staging roots are
rejected; this does not allow arbitrary Node commands outside the sandbox.
Scoped SQLite sessions validate each IPC request before the runtime handles it;
database requests must stay inside the canonical state directory. The separate
state-ownership reader is restricted to its exact worker, caller, and database
argument. Worker-thread startup uses the package root captured from the desktop
when Node has not initialized the worker's entry arguments yet.

The installer grants read-only access to the actual OpenClaw npm installation
prefix, which may differ from the Node.js directory. Ancestor grants use numeric
SIDs and metadata/traverse rights only. Required grants allow up to five minutes
for Windows ACL propagation. If a shared system directory cannot be changed,
installation must still prove that sandboxed Node can read the installed runtime
and create/remove a file in the sandbox workspace; it fails if that check fails.
Direct Node script arguments retain quoting around paths with spaces. This
prevents startup probes such as `npm root -g` from requesting access to a
nonexistent `C:\Program` path while still inspecting the complete file path.

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

The JS files don't need building — the bundled Node.js runtime loads them directly through `--require`, without transpilation.

## Startup Preparation

Startup still reads and verifies the current ACLs before launching Gateway. Grants
and sensitive-directory shields write the DACL only when it actually changes;
unchanged permissions do not need another inheritance propagation or invalidate
OpenClaw's file inventory. Permission upgrades, downgrades, and removed shields
are checked again rather than trusting a cached setup marker.

The runtime's fixed Windows boot-identity query is handled as an internal read-only
probe. A module-loader bridge verifies the pinned control-plane source before
providing that capability, independently of call-stack depth and worker entry
points. There is no global command-text or call-stack exemption in the tool hooks.
It uses the absolute system PowerShell executable and a fixed system module path,
not a caller-supplied executable, environment, or working directory. Modified
scripts and ordinary agent shell commands retain the normal sandbox checks.

Desktop-managed Gateways also set `OPENCLAW_NO_AUTO_UPDATE=1`: MicroClaw's own
update checker remains responsible for the packaged application/runtime. The
upstream Gateway must not separately probe global npm/pnpm installation owners
or self-update a runtime owned by the installer.

Verified internal SQLite workers inherit the compile-cache directory captured at
Gateway startup, so repeated snapshots can reuse V8 bytecode. Caller-provided
cache paths, `NODE_OPTIONS`, and `NODE_PATH` are not forwarded to these workers.

Desktop logs include `sandbox-timing` for individual provisioning commands and
`startup-timing` boundaries for configuration, provisioning, stale ACL cleanup,
and state hardening. The boot probe reports its own elapsed milliseconds.

Run the isolated Windows ACL regression with an installed SDK target:

```powershell
$env:MICROCLAW_DOTNET_TEST_TARGET = 'net10.0-windows'
python -m unittest tests.test_appcontainer_acl
```

The test changes ACLs only in a temporary project build directory. It does not
create an AppContainer profile or change the installed application's permissions.

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
