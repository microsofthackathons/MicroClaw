# OpenClaw 2026.7.1-1 Upgrade Design

## Summary

MicroClaw will upgrade its pinned OpenClaw npm package from `2026.3.12` to the
exact correction release `2026.7.1-1`. The upgrade will support both new
installations and existing installations, preserve the current directory
layout, and provide local automatic rollback without downloading the old
package again.

This is the minimum production-usable scope. It includes the compatibility
changes required by OpenClaw 2026.7.1-1: its Node.js engine range, Gateway
protocol v4, chat delta format, restart behavior, and public plugin SDK
subpaths.

## Goals

- Pin every stable installation path to exactly `openclaw@2026.7.1-1`.
- Upgrade existing MicroClaw installations from their detected OpenClaw
  version instead of treating any installed version as current.
- Keep using OpenClaw's existing `~/.openclaw` state directory and migration
  behavior.
- Back up the installed OpenClaw package, command shims, and persistent state
  before changing them.
- Automatically restore the previous package and state when installation,
  startup, health checks, or compatibility checks fail.
- Make the desktop client compatible with Gateway protocol v4 and v4 chat
  events.
- Keep the bundled Weixin plugin compatible with the 2026.7.1-1 public plugin
  SDK.
- Preserve AppContainer enforcement for tools executed through the upgraded
  Gateway.

## Non-goals

- Moving OpenClaw state into a MicroClaw-specific state directory.
- Installing multiple OpenClaw versions side by side.
- Adding an OpenClaw version selector to the UI.
- Rolling Node.js back after an OpenClaw rollback.
- Automatically adopting npm `latest`, `beta`, or future OpenClaw tags.
- Redesigning the existing MicroClaw application updater.

## Existing Constraints

The current implementation has the following upgrade blockers:

1. The stable pin is duplicated as `2026.3.12` in the Python installer and
   PowerShell dependency installer.
2. `check_openclaw_windows()` accepts any installed OpenClaw version, so an
   existing user is never upgraded.
3. Node validation accepts `>=22.16.0`, while OpenClaw 2026.7.1-1 requires:

   ```text
   >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0
   ```

4. The dependency installer's offline fallback is Node `22.20.0`, which is not
   accepted by OpenClaw 2026.7.1-1.
5. The desktop Gateway client advertises protocol v3 only. Operator and UI
   clients must advertise protocol v4.
6. Protocol v4 streams `deltaText` and an optional `replace` flag. The renderer
   currently derives streaming text from `payload.message`.
7. MicroClaw implements an in-process restart through an empty
   `config.patch`. OpenClaw now treats this as a no-op and does not restart.
8. The Weixin plugin imports runtime helpers from the root
   `openclaw/plugin-sdk` entry. Those helpers moved to public SDK subpaths.
9. No Gateway-client tests currently cover protocol negotiation or restart
   behavior.

## Directory Policy

The upgrade deliberately preserves current ownership boundaries:

| Path | Owner | Upgrade behavior |
|---|---|---|
| `~/.openclaw` | OpenClaw | Continue as the canonical state directory; snapshot before first 2026.7.1-1 launch |
| `~/.microclaw` | MicroClaw | Store upgrade transaction metadata and backups |
| Current writable npm prefix | Node/npm | Upgrade `node_modules/openclaw` in place |
| `%ProgramFiles%/nodejs` or accepted managed Node path | Node.js | Upgrade forward when outside the supported engine range |
| `%APPDATA%/microclaw` | Electron | Keep settings and sandbox metadata unchanged |
| `~/.openclaw-node` and `%APPDATA%/npm` | Legacy/runtime candidates | Continue detection for existing users; do not introduce a new runtime layout |

Because `~/.openclaw` remains shared with a standalone OpenClaw installation,
the upgrader must refuse to mutate it while an unmanaged Gateway or OpenClaw
process is using the directory. The error identifies the process or occupied
Gateway port and asks the user to stop standalone OpenClaw first. A user who
intentionally points standalone OpenClaw at the same npm prefix will receive
the same package upgrade.

The backup root is:

```text
~/.microclaw/backups/openclaw/<upgrade-id>/
```

The transaction record is:

```text
~/.microclaw/upgrade/openclaw-upgrade.json
```

Only the most recent committed upgrade backup is retained. An active or failed
transaction backup is never pruned automatically.

## Version Policy

The target package is an exact version, not a mutable npm tag:

```text
openclaw@2026.7.1-1
```

Version detection must return the actual installed version and install prefix.
The installer skips OpenClaw installation only when the detected version is
exactly `2026.7.1-1` and its entry file exists.

Node validation implements the upstream engine range exactly. MicroClaw
continues to install a supported Node 22 release by default, with an offline
fallback of at least `22.22.3`. Validation must reject Node 22.22.2 and every
Node 23 release.

## Upgrade Transaction

### Transaction manifest

The transaction manifest is written atomically through a temporary file and
contains:

- schema version;
- transaction ID;
- installer process ID;
- source and target OpenClaw versions;
- npm prefix and package entry path;
- state directory;
- backup directory;
- command shim paths;
- current phase;
- creation and update timestamps;
- whether a previous package existed;
- validation results.

Manifest paths must be canonicalized and validated against the detected npm
prefix, `~/.openclaw`, and `~/.microclaw/backups/openclaw`. Recovery code must
reject a manifest that attempts to restore outside these roots.

The supported phases are:

```text
backing-up
installing
verifying
committed
rolling-back
rolled-back
rollback-failed
```

### Backup

Before changing OpenClaw, the installer stops the Gateway and waits for its
port to be released. It then copies:

- the current `node_modules/openclaw` package directory;
- `openclaw`, `openclaw.cmd`, and `openclaw.ps1` shims that exist under the
  detected prefix;
- the complete `~/.openclaw` persistent state.

State exclusions are intentionally narrow:

- `compile-cache/`;
- `logs/`;
- `*.log` files.

Generic `cache/` directories and the complete `sandbox/` directory must not be
excluded without an upstream ownership review because they may contain
recoverable user or agent data.

Installer downloads and staging files live outside `~/.openclaw` and therefore
do not require state-backup exclusions.

The backup is complete only after a manifest of copied files and sizes has been
written. Installation does not begin after a partial backup.

### Installation

For a new installation:

1. Snapshot an existing `~/.openclaw` directory when present, even when no
   OpenClaw package is installed.
2. Ensure a supported Node version.
3. Install `openclaw@2026.7.1-1` into the selected writable npm prefix.
4. Write the OpenClaw configuration and install the Weixin plugin.
5. Run validation.

For an existing installation:

1. Detect the installed OpenClaw version and prefix.
2. Return success without mutation when the exact target is healthy.
3. Refuse the upgrade when an unmanaged OpenClaw process is using the shared
   state directory.
4. Stop the managed Gateway and create the transaction backup.
5. Upgrade Node when required.
6. Install `openclaw@2026.7.1-1` into the same prefix.
7. Reapply MicroClaw configuration and Weixin plugin registration in the
   existing state directory.
8. Run validation before committing the transaction.

Node is not rolled back. Every accepted replacement Node version remains
compatible with the previous pinned OpenClaw version.

## Validation and Commit

An installation is committed only after all checks pass:

1. The installed npm package reports exactly `2026.7.1-1`.
2. The expected `openclaw.mjs` or supported entry file exists.
3. The Gateway process starts and `/health` returns HTTP 200 within the
   configured readiness timeout.
4. The desktop client completes a protocol v4 challenge and authenticated
   handshake.
5. `config.get`, `agents.list`, `channels.list`, and `cron.list` return
   successful RPC responses.
6. The Weixin plugin loads without an SDK export or registration error.
7. AppContainer remains enabled when configured and a sandbox smoke command
   executes through the sandbox path.

After validation, the transaction becomes `committed`. The previous committed
backup is pruned only after the new manifest is durable.

## Automatic Rollback

Any exception during installation or validation starts rollback:

1. Mark the transaction `rolling-back`.
2. Stop the Gateway and wait for the port to be released.
3. Move the failed OpenClaw package and state under the transaction backup's
   `failed/` directory for diagnostics.
4. Restore the previous package directory and command shims from local backup.
5. Restore `~/.openclaw` from the state snapshot.
6. Start the previous Gateway.
7. Require its `/health` check to pass.
8. Mark the transaction `rolled-back`.

Rollback never depends on npm, a registry, or the network.

If the installer or machine exits during an active transaction, the next
installer run resumes rollback. The desktop checks the transaction before
starting the Gateway. When the recorded installer process is still alive, the
desktop reports that an upgrade is in progress and does not start the Gateway.
When the owner process is no longer alive, the desktop performs the same
path-validated restore or blocks Gateway startup if recovery cannot be
completed.

If rollback fails, the transaction becomes `rollback-failed`. MicroClaw must
not launch a partially restored Gateway. The UI or installer reports the
failed phase, backup path, and explicit manual recovery commands.

## Gateway Protocol Changes

The Gateway client advertises:

```json
{
  "minProtocol": 3,
  "maxProtocol": 4
}
```

The range allows OpenClaw 2026.7.1-1 to negotiate protocol v4 while preserving
desktop compatibility with the protocol-v3 Gateway restored by automatic
rollback. The client continues to wait for and sign the `connect.challenge`
nonce. The existing v2 device-auth signature payload remains supported by
OpenClaw 2026.7.1-1 and does not need to change.

`ChatEventPayload` adds:

```ts
deltaText?: string;
replace?: boolean;
```

For a delta event:

- append `deltaText` when `replace` is false or absent;
- replace the accumulated stream with `deltaText` when `replace` is true;
- retain `message` support only as a compatibility fallback.

Final, aborted, and error events continue to use their final `message` and
error fields.

## Gateway Restart Changes

The empty `config.patch` restart workaround is removed. All MicroClaw restart
callers use one desktop-owned hard-restart operation:

1. stop the WebSocket client;
2. terminate the managed Gateway process tree;
3. wait until the configured port is free;
4. spawn the Gateway with the current environment and sandbox settings;
5. wait for health and reconnect the WebSocket client.

This operation is reused by manual restart, health recovery, plugin activation,
Weixin login/disconnect, and sandbox setting changes. No caller may treat a
successful no-op RPC as proof that a restart occurred.

## Weixin Plugin SDK Migration

Root SDK types that remain public may stay on `openclaw/plugin-sdk`. Runtime
helpers move to their 2026.7.1-1 public subpaths:

| Helper | Public subpath |
|---|---|
| `buildJsonChannelConfigSchema` | `openclaw/plugin-sdk/channel-config-schema` |
| `normalizeAccountId` | `openclaw/plugin-sdk/account-core` |
| `withFileLock` | `openclaw/plugin-sdk/file-lock` |
| `createTypingCallbacks` | `openclaw/plugin-sdk/channel-outbound` |
| `resolveSenderCommandAuthorizationWithRuntime` | `openclaw/plugin-sdk/command-auth` |
| `resolveDirectDmAuthorizationOutcome` | `openclaw/plugin-sdk/command-auth` |
| `resolvePreferredOpenClawTmpDir` | `openclaw/plugin-sdk/temp-path` |
| `stripMarkdown` | `openclaw/plugin-sdk/text-chunking` |

The migration does not replace these helpers with local copies.

OpenClaw 2026.7.1-1 no longer accepts a custom `gateway.disconnect` callback.
MicroClaw already owns Weixin disconnection through its desktop IPC and state
cleanup, so the obsolete plugin callback is removed. The plugin exports its
Zod configuration through `buildJsonChannelConfigSchema` to avoid coupling a
third-party Zod instance to OpenClaw's bundled schema types.

## Error Handling

- Version, prefix, backup, install, restore, and health errors are surfaced
  with the failed phase and actionable path information.
- Invalid version output is an error, not an implicit "installed" result.
- A backup failure prevents installation.
- A validation failure triggers rollback.
- A rollback failure blocks Gateway startup.
- Registry mirror failure may retry through another configured registry for
  the target installation, but rollback never uses a registry.
- Existing unrelated user files are not deleted.

## Testing

### Installer unit tests

- Exact target version is skipped.
- `2026.3.12`, `2026.7.1`, and `2026.7.1-2` are not treated as
  `2026.7.1-1`.
- Supported and unsupported Node range boundaries are correct.
- A missing or malformed npm version result fails explicitly.
- Backup manifests reject paths outside approved roots.
- Partial backups prevent installation.
- Interrupted phases select rollback.
- Package, shim, and state restoration reproduce the original files.
- Rollback failure remains blocking and preserves diagnostics.

### Desktop main-process tests

- Protocol v4 connect parameters are emitted.
- A challenge nonce is included in device authentication.
- `deltaText` append and `replace` behavior is correct.
- The legacy `message` delta fallback remains supported.
- All restart callers use the hard-restart operation.
- An active upgrade transaction is recovered before Gateway startup.

### Weixin plugin tests

- Type-check against the exact OpenClaw 2026.7.1-1 SDK.
- Plugin registration succeeds.
- Account normalization, file locking, authorization, temporary paths, and
  Markdown stripping resolve from public subpaths.

### Windows integration matrix

1. Fresh installation.
2. Upgrade from the current `2026.3.12` pin.
3. Forced npm installation failure.
4. Forced Gateway health or protocol failure.
5. AppContainer-enabled chat/tool smoke test.

Each failure case must prove that the previous Gateway starts successfully
with the restored state.

## Acceptance Criteria

- New installations run OpenClaw `2026.7.1-1`.
- An existing `2026.3.12` installation is upgraded rather than skipped.
- The desktop connects through protocol v4 and streams chat text correctly.
- Manual, health, plugin, Weixin, and sandbox restarts produce an actual
  process replacement.
- The Weixin plugin loads and completes its existing automated tests against
  the target SDK.
- Simulated install and validation failures restore the old package and state
  without network access.
- An interrupted transaction is recovered before the Gateway starts.
- The existing `~/.openclaw` state location remains unchanged.
- No mutable npm tag is used for production installation.
