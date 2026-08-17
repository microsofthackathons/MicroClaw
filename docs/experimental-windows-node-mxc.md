# Experimental Windows Node + MXC sandbox

This branch contains a proof of concept for the security framework tracked by
[issue #202](https://github.com/microsofthackathons/MicroClaw/issues/202). It is independent of
the Docker sandbox experiment and does not replace MicroClaw's existing AppContainer mode.

## Boundary

MicroClaw and its managed OpenClaw Gateway remain on the host. Agent-controlled commands use
the normal Gateway WebSocket route to one explicitly selected local Windows node:

```text
agent exec -> managed Gateway -> node.invoke system.run -> Windows Node V2 approval -> MXC
```

Local MCP is not used. The Gateway agent policy is an explicit `allow: ["exec"]` allowlist,
with code mode disabled and `exec.host` pinned to the selected stable node ID. This removes
Gateway-host `read`, `write`, `edit`, `apply_patch`, `process`, browser, plugin, MCP, and other
tool schemas from the agent path. MicroClaw verifies the session-scoped `tools.effective`
inventory before considering the mode effective.

The mode is mutually exclusive with MicroClaw AppContainer. Enabling it first installs a locked
policy with a non-tool sentinel allowlist (an empty OpenClaw allowlist is unrestricted). Direct
operator diagnostics can still inspect the node and run the explicit smoke, but channel and chat
agents have no execution surface. The branch generates and schema-validates the intended exec-only
policy, but does not activate it: pinned Gateway APIs cannot atomically quarantine channel and
scheduled ingress while a newly started active Gateway is attested. Agent roster changes are
blocked while the mode is desired.

When the mode is desired but any proof fails, chat execution is denied rather than falling back
to the host. An already-running external Gateway is never reused for this mode.

## Required Windows Companion state

The integration targets `openclaw/openclaw-windows-node` commit
`fc9add75eda78daf548d80a55ffb64e63b159961`. That build has no remote sandbox-settings API, so
the operator must configure its Sandbox page and MicroClaw reads the effective local settings
from `%APPDATA%\OpenClawTray\settings.json`.

Required settings:

- node mode and system tools enabled;
- MXC enabled and host fallback blocked when MXC is unavailable;
- outbound network disabled and clipboard set to `None`;
- local MCP, canvas, screen, camera, location, browser proxy, STT, and TTS disabled;
- `Allow Windows UI APIs` enabled for PowerShell/pwsh compatibility with MXC 0.7.

`Allow Windows UI APIs` is a compatibility relaxation. It does not enable screen capture,
input injection, canvas, camera, microphone, browser, location, or speech capabilities.
Windows Node continues to force input injection off and to deny its settings directory,
SSH roots, browser profiles, PowerShell history, and other sensitive roots.

For an unpackaged release, MicroClaw detects:

```text
%LOCALAPPDATA%\OpenClawTray\OpenClaw.Tray.WinUI.exe
%LOCALAPPDATA%\OpenClawTray\tools\mxc\<x64|arm64>\wxc-exec.exe
```

Custom/dev/MSIX layouts must launch MicroClaw with `OPENCLAW_TRAY_DATA_DIR` and
`OPENCLAW_WXC_EXEC` pointing at the matching pinned installation. MicroClaw does not install,
elevate, or make host-wide changes.

## Readiness

The Security page reports desired/effective state, connection and pairing, declared commands,
strict fallback state, effective folder grants, MXC tier, DACL augmentation, durable approval
state, and smoke results.

`wxc-exec --probe` is necessary but not sufficient. The explicit smoke invokes contained
`hostname.exe` through `cmd.exe`, then contained Windows PowerShell, through the selected node.
`0xC0000142`, DLL initialization failures, access-denied results, timeouts, approval failures,
and sandbox-unavailable results are classified as unusable. `appcontainer-dacl` is accepted
with a prominent degraded-containment warning.

No environment is supplied to smoke commands, and Windows Node rejects custom command
environments while MXC is active. The smoke must be repeated when the selected node, relevant
Windows Companion settings, or MXC tier changes.

## Upstream blocker

The pinned Windows Node validates `cwd` only as a nonblank string. It does not canonicalize it
through reparse points, restrict it to configured folder grants, or include it in durable
approval identity. MXC also grants an otherwise-unlisted explicit cwd read-only access. A
durable executable+argv approval can therefore be reused with another cwd.

MicroClaw cannot safely repair this at the Gateway config layer because it cannot intercept or
rewrite the node's approved `system.run` payload. This proof of concept consequently remains
fail-closed unless the selected node declares `system.run.cwd-policy`, representing an upstream
implementation that:

1. resolves cwd to a canonical local path and rejects network/reparse escapes;
2. requires it to be inside one configured RO/RW folder and preserves that access level;
3. binds canonical cwd into durable approval identity;
4. revalidates cwd and the folder grant immediately before process launch; and
5. rejects durable approval for cwd/relative-path-sensitive commands until those guarantees
   are available.

Even after that declaration exists, activation requires an upstream Gateway
quarantine/attestation mechanism that keeps channel and scheduled ingress disabled until the
active `tools.effective` inventory and all mutable Windows Node/MXC state have been verified.
Without an atomic mechanism, an active Gateway could accept work between startup and the
verification RPC. This branch therefore never transitions the managed Gateway from locked to
active.

The smaller acceptable upstream patch is to reject `AllowAlways` whenever caller-supplied cwd
is nonempty, but approved-root canonicalization is still required before this MicroClaw mode
can become effective.
