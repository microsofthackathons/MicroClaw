# Hooks-Only Sandbox Mode (No AppContainer)

> **Status**: Proposed
> **Date**: 2026-04-08
> **Related**: sandbox toggle persistent, capabilities config

## Motivation

Currently the sandbox toggle is all-or-nothing: ON = AppContainer + hooks, OFF = nothing. Users may want an intermediate mode:

- **Keep hooks**: Pre-block path checks, permission dialogs, access-denied detection
- **Disable AppContainer**: No COMSPEC replacement, no ACL grants, no provisioning

Use cases:
- Debugging: isolate whether issues are from AppContainer or hook logic
- Performance: AppContainer adds overhead (process creation, ACL checks)
- Compatibility: some tools don't work inside AppContainer (COM, DCOM, etc.)

## Architecture

```
Current:
  Sandbox ON  → COMSPEC=Launcher + preload hooks + AppContainer ACLs
  Sandbox OFF → nothing (no hooks, no protection)

Proposed:
  Sandbox ON  → Full mode (COMSPEC=Launcher + hooks + ACLs)
  Hooks Only  → preload hooks + permission dialogs, NO AppContainer
  Sandbox OFF → nothing
```

## Feasibility Analysis

### What works unchanged (no code changes needed)

| Component | Why it works |
|-----------|-------------|
| `shouldBlockWrite` / `shouldBlockRead` | Pure path-level checks against `_roDirs`/`_rwDirs` env vars — no AppContainer dependency |
| Permission request IPC flow | `requestFilePermission()` / `requestShellPermission()` use `process.send()` + response file polling — independent of AppContainer |
| Pre-block path extraction | `preBlockShellCommand()` → `extractWritePaths/ReadPaths` → permission check — all pure logic |
| Access-denied detection | `detectAccessDenied()` just parses stderr text — works regardless of sandbox mode |
| External app whitelist | HMAC-signed file read by preload — no AppContainer interaction |
| Permission caches | In-memory TTL caches in `sandbox-permission.js` — completely independent |

### What needs changes (~5 locations)

#### 1. Preload entry gate — `sandbox-preload.js`

**Current**: Only loads if `COMSPEC` contains "AppContainerLauncher"
```javascript
var isLauncherConfigured = LAUNCHER && /AppContainerLauncher/i.test(LAUNCHER);
if (isLauncherConfigured) { /* install all hooks */ }
```

**Change**: Also load if hooks-only flag is set
```javascript
var isHooksOnly = process.env.OPENCLAW_SANDBOX_HOOKS_ONLY === '1';
if (isHooksOnly || isLauncherConfigured) { /* install all hooks */ }
```

#### 2. CP hooks — `sandbox-cp-hooks.js`

**Current**: Routes shell commands through `S.LAUNCHER` (AppContainerLauncher)
```javascript
var child = _spawn.call(this, S.LAUNCHER, la, co);  // Launch in AppContainer
```

**Change**: In hooks-only mode, run commands directly (no launcher redirect) but STILL apply pre-blocking
```javascript
if (hooksOnly) {
  // Pre-block still runs (permission dialogs)
  var _denied = preBlockShellCommand(cmd, args);
  if (_denied) { /* block */ return fakeChild; }
  // Run directly — no AppContainer
  return _spawn.apply(this, arguments);
} else {
  // Full mode — route through AppContainerLauncher
  var child = _spawn.call(this, S.LAUNCHER, la, co);
}
```

This needs to be applied to all 4 hook sites: `spawn`, `spawnSync`, `execFile`, `execFileSync`. Also `exec` and `execSync` (which already run directly but need pre-block).

#### 3. Gateway env — `tool-sandbox.ts` `getGatewayEnv()`

**Current**: Sets `COMSPEC = this.launcherPath`

**Change**: In hooks-only mode, don't set COMSPEC to launcher, but still pass dir lists and set the hooks-only flag
```typescript
if (this.hooksOnly) {
  env.OPENCLAW_SANDBOX_HOOKS_ONLY = "1";
  // DON'T set COMSPEC — keep normal cmd.exe
} else {
  env.COMSPEC = this.launcherPath;
}
// Permission dirs always needed
env.OPENCLAW_SANDBOX_DIRS_RW = ...
env.OPENCLAW_SANDBOX_DIRS_RO = ...
```

#### 4. ACL grant on permission approve — `main.ts` `grantAndVerifyAcl()`

**Current**: Calls AppContainerLauncher to run `icacls` and set ACLs

**Change**: In hooks-only mode, skip ACL grant entirely (just update settings + in-memory caches)
```typescript
if (toolSandbox.isHooksOnly()) {
  // No ACL to set — just acknowledge the grant
  return true;
}
```

#### 5. Provisioning — `main.ts` startup

**Current**: Calls `toolSandbox.provisionAsync()` to create AppContainer profile + ACLs

**Change**: Skip provisioning if hooks-only

## ACL Consistency Problem

### The Issue

When switching between modes:

```
1. User enables full sandbox → ACLs are granted for directories A, B, C
2. User switches to hooks-only → ACLs for A, B, C still exist on filesystem
3. User grants permission for directory D in hooks-only mode → no ACL set
4. User switches back to full sandbox → D has no ACL → access denied!
```

Also in reverse:
```
1. User in hooks-only mode grants A, B, C → no ACLs set
2. User switches to full sandbox → A, B, C have no ACLs → all fail
```

### Solution

**On switching to full sandbox mode, reconcile ACLs:**

When `sandboxEnabled` changes from hooks-only (or off) to full mode:

1. Read `sandboxUserDirsRW` and `sandboxUserDirsRO` from settings
2. For each dir, call `grantAndVerifyAcl()` to ensure ACL matches
3. Run `cleanupStaleAcls()` to remove any stale entries

This is exactly what `provisionAsync()` + the startup ACL setup already does. The existing startup flow handles this naturally — when the user re-enables full sandbox, `startGateway()` calls `toolSandbox.provisionAsync()` which re-provisions everything.

**Additional safety**: The `grantHistory` in settings tracks all ever-granted paths. On startup with full sandbox, iterate through all configured dirs and verify/repair ACLs.

### Why it's not a big problem

The settings store (`sandboxUserDirsRW`/`sandboxUserDirsRO`) is always the source of truth. ACLs are just "physical enforcement" that can be re-applied at any time. The existing startup reconciliation code already handles ACL gaps.

## UI Changes

### Option A: Three-state toggle
```
Sandbox: [OFF] [Hooks Only] [Full (AppContainer)]
```
- Requires `el-radio-group` instead of `el-switch`
- More explicit but more complex UI

### Option B: Main toggle + sub-toggle (recommended)
```
Enable sandbox            [ON/OFF]
  ├ Enable AppContainer   [ON/OFF]  (only when sandbox enabled)
  ├ Allow network access  [ON/OFF]
  ├ External apps ...
  └ Directory permissions ...
```
- `sandboxEnabled` controls hooks
- New `sandboxAppContainer` controls AppContainer layer
- AppContainer toggle grayed out when sandbox is off

### Settings store changes
```typescript
sandboxEnabled: boolean;        // existing — controls hooks
sandboxAppContainer: boolean;   // NEW — controls AppContainer (default: true)
sandboxCapabilities: string[];  // existing
```

## Complexity Assessment

| Area | Changes | Difficulty |
|------|---------|-----------|
| `sandbox-preload.js` | 1 line (gate check) | Trivial |
| `sandbox-cp-hooks.js` | ~20 lines (4 hook sites + hooksOnly check) | Medium |
| `tool-sandbox.ts` | ~10 lines (getGatewayEnv + getPreloadPath + new flag) | Easy |
| `main.ts` | ~15 lines (grantAndVerifyAcl + provisioning skip) | Easy |
| `SettingsView.vue` | ~10 lines (new toggle, grayed-out logic) | Easy |
| `i18n` | 4 strings (en + zh) | Trivial |
| **Settings migration** | Handle upgrade from old settings format | Easy |
| **ACL reconciliation** | Already handled by startup flow | None |
| **Total** | ~60 lines of code changes | **Low-Medium** |

## Recommendation

Feasible and low-risk. The permission system (path checks, IPC dialogs, caches) is **already fully decoupled from AppContainer** — it works purely on env-var-configured directory lists and IPC. The main work is:

1. Adding a second gate in the preload entry
2. Skipping launcher routing in cp-hooks (but keeping pre-block)
3. Skipping ACL grants in permission response handler

ACL consistency is a non-issue because the existing startup reconciliation flow re-applies all ACLs when full mode is re-enabled.
