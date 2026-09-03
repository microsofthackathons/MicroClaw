# Experimental bundled Windows Node + MXC sandbox

This branch implements the Windows execution-host experiment for
[security framework issue #202](https://github.com/microsofthackathons/MicroClaw/issues/202).
It remains independent of the Docker and direct-MXC experiments.

## Architecture and boundary

```text
MicroClaw Electron
  -> app-owned loopback OpenClaw Gateway
  -> bundled MicroClaw Windows Node Host
  -> exact proof-only startup probes or attended normal-command approval
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

The helper advertises only `system.run`, proof-only `system.run.readiness`, `system.run.prepare`,
`system.which`, and `system.run.cwd-policy`. It contains no host command runner and cannot fall back
when MXC is absent or fails. Network, clipboard, input injection, MCP, screen, camera, canvas,
browser, location, and speech capabilities are absent. `allowWindowsUi=true` is required for
PowerShell compatibility with MXC 0.7; it does not activate any UI capture or input capability.

Gateway-native file/process tools remain removed from the agent surface. The policy pins `exec` to
the app-owned node and denies the runtime/filesystem/plugin groups. An empty OpenClaw allowlist is
unrestricted, so the pre-attestation state uses a non-tool lock sentinel. The Gateway node-command
policy allowlists exactly the five bundled commands above. MicroClaw pairs/reapproves only the exact
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
`isolated-scratch:v1` and launches in a per-run writable scratch directory. The node re-hashes the
executable through its held handle; policy, reparse state, root membership, exact CWD binding, and
declared access are revalidated immediately before launch. Delete-denying directory handles retain
every approved-root/CWD path component through MXC completion, preventing a validated directory
from being replaced by a junction during launch.

Settings > Security presents this global policy as separate Read-only and Read/write lists. Folder
selection uses Electron's trusted native directory picker. Equal paths are deduplicated, redundant
nested grants are collapsed, and a narrower RW root under a broader RO root remains explicit. While
MXC is enabled, edits remain a renderer draft and cannot mutate live ACLs or settings. **Apply changes
and reactivate** performs one serialized fail-closed transaction: lock ingress, reject pending
approvals, revoke proof/lease state, validate the complete draft, stop the exact generation, apply
and atomically persist the same `sandboxUserDirsRO`/`sandboxUserDirsRW` policy, attest and smoke a
locked generation, attest and smoke a fresh active generation, mint its lease, verify the effective
route, then release ingress. The fixed smokes use internal one-use readiness proofs and never enter
the user approval queue. Cancellation or any failure leaves execution locked and retains the
attempted draft and previous policy for explicit retry or revert; MicroClaw never silently restores
old active execution. Folder preparation that requires elevation fails locked without opening an
elevation prompt. UNC, device-namespace, missing, reparse, final-target-changing, and protected
credential/state/browser roots are rejected before persistence.

The normal active route has one visible Gateway/MicroClaw prompt. It displays executable, exact argv,
agent/session scope, canonical CWD, and declared folder use, and offers Deny, Allow once, and eligible
Allow always. MicroClaw resolves both allow choices upstream as one-use; it never delegates durable
authority to the Gateway or node. The Gateway then mints a fresh 15-second, one-use HMAC proof bound
to the exact generation, node, policy fingerprint, prepared plan, executable path/content hash, CWD,
declarations, agent, and session. The node silently accepts only that proof after recapturing the
held executable identity. Direct `node.invoke`, malformed, stale, replayed, or concurrent reuse is
denied. Fixed readiness commands use a separate HMAC contract bound to the transition ID, Gateway
generation, node, policy, probe kind, exact prepared executable path/content hash, argv, isolated
scratch CWD, empty declarations, short expiry, and one-use consumption. Only
`system.run.readiness` accepts that proof; ordinary `system.run`, including identical hostname or
PowerShell argv after startup, still requires the normal visible approval. Each contained child
inherits `TEMP`/`TMP`/`TMPDIR` pointing at its own writable scratch grant.

Optional `[declare-access]ro:<path>;rw:<path>[/declare-access]` metadata is accepted only on leading
metadata lines (with an optional `#`, `REM`, or `::` comment prefix). It can describe only canonical
paths already covered by the global folder policy and cannot upgrade RO to RW. The helper removes
the metadata line from the executable shell payload, binds approval to the cleaned argv, and carries
a canonical declaration only in the approved plan's display preview. Every configured approved root
is passed into every MXC invocation as a global RO/RW grant; declaration metadata validates and
communicates intended use but never grants or changes access. MicroClaw renders it as separate
localized declared folder use and clean command text, and explains that approval authorizes the
command itself inside MXC. `Allow always` stores a versioned MicroClaw-owned exact record under the
protected Windows-node state directory: canonical executable path and SHA-256, exact argv and
command, canonical CWD or scratch semantic, normalized declarations, agent/session, policy
fingerprint, and plan contract. Writes are atomic and replace exact duplicates. Legacy, malformed,
unbound, policy-stale, hash-stale, path-stale, or scope-mismatched records authorize nothing.
Security settings shows creation/last-use details and supports individual or complete revocation. A
valid exact match suppresses the visible prompt but still receives a fresh one-use Gateway proof and
full node launch-time revalidation. It never changes configured folder grants.
An unlisted declaration, or an RW declaration covered only by RO policy, is rejected before the
command-approval prompt with localized remediation to change Settings > Security and retry. Omitting
declaration metadata never expands the MXC policy: only the configured global roots are emitted, and
an operation outside them receives the container's normal access-denied result.

## Packaging and provenance

`openclaw/openclaw-windows-node` is pinned as a submodule at
`fc9add75eda78daf548d80a55ffb64e63b159961`. The headless project references its plain
`OpenClaw.Shared` transport/identity/MXC contracts without importing Companion WinUI code.
MicroClaw's stricter command capability, CWD policy, approval identity, and no-fallback runner live
in `windows-node-host/`. The bundled host binds itself and every inherited MXC child to a
kill-on-close Windows Job, so a host crash or forced stop cannot leave an agent-controlled
`wxc-exec` or contained descendant running. Electron keeps the bootstrap pipe open as an
owner-lifetime signal; an Electron exit closes the pipe, exits the host, and closes the Job.

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
and rejecting the package because Authenticode changed its bytes. The helper build disables
repository-HEAD suffixes in its informational version so its pinned unsigned hash remains
reproducible across MicroClaw commits.

## Readiness and activation transaction

The helper also enforces `microclaw.windows-activation.v1`: an HMAC-SHA256 lease bound to the exact
Gateway generation, helper policy fingerprint, mode, and expiry. Its per-generation key is delivered
only through inherited stdin. A diagnostic lease admits only the fixed `hostname.exe` and PowerShell
probe declarations; the denied-CWD check fails at canonical CWD policy before launch. An active
lease admits the normal attended `system.run` path. The helper checks the lease before authorization
and again immediately before MXC launch.

MicroClaw remembers the selected security mode. When Windows Node + MXC is off, startup follows the
normal Gateway/chat-ready path without starting the bundled node. When it is on, the loading screen
remains visible while MicroClaw automatically starts every Gateway generation locked and runs the
same secure readiness and activation sequence. Fixed readiness probes are internally authorized by
the current serialized lifecycle and produce no permission dialog; this authority cannot be used by
agent commands. Readiness requires the exact CWD/activation attestation payload, selected app-owned
node identity, paired and connected state, strict no-fallback settings, current-generation effective
tools, MXC tier, contained `hostname.exe`, contained PowerShell, and denied-access proof.
`appcontainer-dacl` is accepted with a prominent degraded-containment warning.

Every MicroClaw-owned `chat.send` path, including startup warm-up and generated session titles,
passes through the same current-generation active-ingress gate. Locked or attesting startup skips
warm-up without queuing or replaying it; warm-up can run only after final activation release.

Activation is an automatic fail-closed transaction:

1. Attest the locked generation and its smoke record.
2. Stop the Gateway and reject, rather than queue, MicroClaw chat sends.
3. Write an active policy that exposes only node-pinned `exec` and disables configured channels,
   webhooks, internal hooks, cron, plugin loading, and plugin entries.
4. Start a new managed loopback Gateway generation and pair the exact bundled node.
5. Verify the node declaration, CWD contract, strict helper policy, and effective `exec`-only tool
   inventory.
6. Repeat all contained smokes for the active generation under a diagnostic lease.
7. Issue an active lease, perform a final attestation, then release MicroClaw chat ingress.

Any restart, disconnect, timeout, policy/tool drift, missing or expired lease, helper failure, or
attestation error revokes the lease, clears the smoke proof, rewrites the locked policy, and stops
the managed Gateway. Configuration and restart operations that could invalidate an active
transaction are rejected while this mode is enabled. External channel, hook, cron, and plugin
entry points remain disabled, and inventory APIs return no active ingress. The loading screen shows
the failed MXC phase and recovery detail;
the user may retry the same serialized transaction or turn MXC off. Toggling either direction
returns to loading immediately, rejects chat during the transition, and releases ingress only after
the selected route is ready. Security settings keep the protection state, actionable failures,
folder policy, and remembered-command controls visible. Read-only node identity, policy lifecycle,
generation, lease, containment tier, contracts, fingerprints, and readiness evidence are grouped
under a **Technical details** disclosure that starts collapsed whenever Settings is opened. The page
does not expose separate refresh, smoke, or activation buttons.

The Gateway can block its event loop for more than a minute during startup. Pairing therefore
remains generation-bound and locked for up to five minutes while the helper reconnects; timeout or
a Gateway-generation change stops the helper. Transient inability to query effective tools is
recorded as unverified and does not kill an otherwise statically locked Gateway; confirmed drift
still stops it.

OpenClaw 2026.7.1-1 bound a node approval request to a persisted operator device but omitted that
identity when replaying the approved `node.invoke system.run`, causing
`approval id not valid for this device`. OpenClaw 2026.8.2 includes the upstream fix from
[openclaw/openclaw#103886](https://github.com/openclaw/openclaw/pull/103886), commit
`7a38f140a2cf2c99dd08f92db3ea1b291d5b10c4`. MXC mode still enables a MicroClaw-owned Node load
hook for the one-use approval proof and prepared-plan identity extensions. The installed OpenClaw
package is not modified. The hook requires OpenClaw `2026.8.2` and exact SHA-256 hashes for the
affected compiled modules; any version, hash, or source-shape mismatch prevents the managed Gateway
from starting.

The same pinned Gateway binds approval registration and replay to the prepared plan's exact argv,
CWD, agent, and session. The bundled host therefore returns the canonical
`{ plan: { argv, commandText, cwd, agentId, sessionKey } }` response and copies `sessionKey` from the
inner `system.run.prepare` parameters, not the node envelope. Dropping it makes registration fall
back to the chat session while replay normalizes the plan to `null`, which the Gateway correctly
rejects as `approval id does not match request`.

After explicit consent, the MicroClaw-built system-drive helper and the official MXC null-device
helper both completed successfully. Non-elevated probing reports `appcontainer-dacl` with no host-
preparation warning. Live locked-generation proof reached the exact bundled node and official
`wxc-exec.exe`; protected `C:\Windows` CWD denial, `cmd.exe -> hostname.exe`, and PowerShell child
execution all pass under transition-bound internal one-use proofs with no durable approval, user
prompt, or host fallback. Ordinary agent execution retains the visible approval contract.
The active transaction also passed end to end: MicroClaw reported chat disconnected before release,
started a new Gateway generation, re-attested the exact node and `exec`-only tool surface, repeated
all three smokes, issued and renewed the generation-bound active lease, then reported chat connected.
The active config had channels, webhooks, internal hooks, cron, plugins, and every plugin entry
disabled; channel and cron inventories were empty, and a direct Gateway restart request was rejected.

The accepted product boundary is MicroClaw-controlled ingress. The activation lease prevents
MicroClaw's helper from executing before MicroClaw releases the verified generation, and the
managed configuration disables MicroClaw-known external ingress. The pinned upstream Gateway does
not provide an atomic quarantine for ingress independently configured outside MicroClaw. Such
upstream ingress is explicitly out of scope and must not share this app-owned Gateway.

MicroClaw never elevates Electron, the Gateway, the node host, a shell, or arbitrary commands. Host
preparation is not automatic; any future preparation or rollback requires a separate, explicit
consent for the narrowly scoped helper operation.
