# Experimental bundled Windows Node + MXC sandbox

This branch implements the Windows execution-host experiment for
[security framework issue #202](https://github.com/microsofthackathons/MicroClaw/issues/202).
It remains independent of the Docker and direct-MXC experiments.

## Architecture and boundary

```text
MicroClaw Electron
  -> app-owned loopback OpenClaw Gateway
  -> bundled MicroClaw Windows Node Host
  -> attended V2-style approval over a per-launch named pipe
  -> official @microsoft/mxc-sdk@0.7.0 wxc-exec.exe
  -> MXC-contained child process
```

OpenClaw Companion, its tray UI, setup code, and local MCP endpoint are not used. The helper has a
separate device identity under MicroClaw's user-data directory and accepts only loopback WebSocket
Gateway endpoints. The Gateway credential is sent once over the helper's stdin; it is never placed
in argv, renderer state, logs, prompts, or contained-child environments.
The managed Gateway PID is also passed in bootstrap metadata. Before every credential-bearing
handshake or reconnect, the helper verifies that this exact process still owns the IPv4 loopback
listener; MicroClaw stops and recreates the helper for each Gateway generation.

The helper advertises only `system.run`, `system.run.prepare`, `system.which`, and
`system.run.cwd-policy`. It contains no host command runner and cannot fall back when MXC is absent
or fails. Network, clipboard, input injection, MCP, screen, camera, canvas, browser, location, and
speech capabilities are absent. `allowWindowsUi=true` is required for PowerShell compatibility with
MXC 0.7; it does not activate any UI capture or input capability.

Gateway-native file/process tools remain removed from the agent surface. The policy pins `exec` to
the app-owned node and denies the runtime/filesystem/plugin groups. An empty OpenClaw allowlist is
unrestricted, so the pre-attestation state uses a non-tool lock sentinel. The Gateway node-command
policy allowlists exactly the four bundled commands above. MicroClaw pairs/reapproves only the exact
app-owned device identity and does not expose manual node selection, even if another Windows
Companion is connected.

## CWD and durable approval contract

The exact attestation contract is `microclaw.windows-cwd.v1`. A supplied CWD must:

- be an existing local drive-qualified directory;
- reject UNC, device, NT object-manager, junction, symlink, and other reparse components;
- resolve to the same final case-insensitive Windows path;
- be equal to or below one canonical global RO/RW root;
- not overlap a protected credential, OpenClaw state, SSH, cloud, or browser-profile root.

CWD inherits the matched root's access; it never creates a grant. Omitted CWD binds approval to
`isolated-scratch:v1` and launches in a per-run writable scratch directory. Durable entries use
schema 2 and bind canonical executable path, executable SHA-256, exact argv, and canonical CWD (or
the scratch semantic). Legacy or CWD-unbound entries never match. Policy, executable identity,
reparse state, root membership, and the exact CWD binding are revalidated immediately before
launch. Delete-denying directory handles retain every approved-root/CWD path component through MXC
completion, preventing a validated directory from being replaced by a junction during launch.

Approval presentation is owned by MicroClaw Security settings. The helper connects to a random
per-launch Windows named pipe, displays executable, exact argv, agent, and canonical CWD, and
supports Deny, Allow once, and Allow always. If the attended IPC is absent or times out, execution
is denied. Responses are bound to the exact request ID. The approved executable is held under a
read-only handle that denies write/delete sharing from pre-approval hashing through MXC completion.
Runs are serialized, so attended approvals cannot overlap, and each contained child inherits
`TEMP`/`TMP`/`TMPDIR` pointing at its own writable scratch grant.

## Packaging and provenance

`openclaw/openclaw-windows-node` is pinned as a submodule at
`fc9add75eda78daf548d80a55ffb64e63b159961`. The headless project references its plain
`OpenClaw.Shared` transport/identity/MXC contracts without importing Companion WinUI code.
MicroClaw's stricter command capability, CWD policy, approval identity, and no-fallback runner live
in `windows-node-host/`.

`@microsoft/mxc-sdk` is lockfile-pinned to `0.7.0`. Resource staging validates the official
architecture-specific `wxc-exec.exe` SHA-256 before copying the complete matching x64/ARM64 runtime
layout unchanged. Package architecture is mandatory rather than inferred from the build machine,
and a runtime manifest is checked again by the app. Development resources, portable/NSIS extra
resources, and MSIX preparation all use the same staging script.

MXC 0.7.0's official `wxc-host-prep.exe` is affected by
[`microsoft/mxc#648`](https://github.com/microsoft/mxc/issues/648): its
`prepare-system-drive` path writes the merged root DACL with `SetNamedSecurityInfoW`, which can
normalize existing descendant ACLs across the volume. MicroClaw therefore must not use that binary
for system-drive preparation. The official MXC directory remains byte-for-byte unchanged, including
that helper because its separate null-device operation is unaffected.

For system-drive preparation only, MicroClaw builds `microclaw-mxc-host-prep.exe` from the minimal
managed-code port in `third_party/mxc-host-prep-patch/`. It is pinned to draft upstream PR
[`microsoft/mxc#649`](https://github.com/microsoft/mxc/pull/649), commit
`695c2b89c6142090a098ec4484f49aff8157f0b3`. Prepare and precise unprepare write only the named root
with `SetFileSecurityW`; runtime MXC grants still use the official implementation and behavior.
The derived helper supports no null-device or other MXC operation. It is a MicroClaw-built artifact,
not an official or Microsoft-signed MXC binary, and remains eligible for MicroClaw product signing.
Staging pins the .NET runtime, checks architecture-specific hashes for both official binaries and
the unsigned MicroClaw-built helper, and records origin, operations, revision, and hashes in
`RUNTIME.json`. Electron's `afterSign` hook replaces only the helper's manifest hash with the final
signed package hash; this avoids both excluding the MicroClaw-owned executable from product signing
and rejecting the package because Authenticode changed its bytes.

## Readiness and activation transaction

Readiness requires the exact CWD attestation payload, selected app-owned node identity, connected
and paired node state, strict locked/effective Gateway tools, MXC tier, contained `hostname.exe`,
contained PowerShell, and denied-access proof. `appcontainer-dacl` is accepted with a degraded
containment warning.

The pinned OpenClaw 2026.7.1-1 Gateway can block its event loop for more than a minute during
startup. Pairing therefore remains generation-bound and locked for up to five minutes while the
helper reconnects; timeout or a Gateway-generation change stops the helper. Transient inability to
query effective tools is recorded as unverified and does not kill an otherwise statically locked
Gateway; confirmed drift still stops it.

Local non-elevated proof reached the exact app-owned node, validated
`microclaw.windows-cwd.v1`, verified an empty locked effective-tool surface, and proved that
`C:\Windows` is rejected as a protected/unapproved CWD. The attended one-time approval reached
official MXC for `cmd.exe`, but the contained child failed with `Access is denied` on this
`appcontainer-dacl` machine. PowerShell therefore did not run. The mode remains diagnostic-only and
host fallback remains impossible.

The pinned Gateway also has no atomic way to quarantine channel and scheduled ingress while an
active exec-only policy starts and is attested. Starting active and checking afterward would expose
a pre-attestation execution window, so MicroClaw deliberately does not perform that transition.
Unlocking requires either an upstream atomic ingress-quarantine primitive or an independently
attested activation gate in the bundled helper. Until then, even a fully passing smoke remains
diagnostic-only.

No elevation or host-wide `prepare-system-drive` / `prepare-null-device` action is performed by
build, staging, or validation. The next live step requires fresh explicit consent for two narrow
operations: use the MicroClaw-built helper for `prepare-system-drive --target C:\`, and use the
unchanged official helper only for `prepare-null-device --json`. MicroClaw, Electron, Gateway, the
node host, and any shell remain non-elevated.
