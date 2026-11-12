# Bundled Windows Node and MXC

MicroClaw uses a bundled Windows Node to run OpenClaw's `exec` commands. Its
Sandboxing switch controls whether those commands run through Microsoft
Execution Containers (MXC). Command consent is a separate setting and remains
available when sandboxing is Off.

## Security boundary

| Setting | Windows Node command execution |
|---|---|
| **On** | Upstream Windows Node executes through an attested MXC BaseContainer with the selected read-only/read-write folders and protected-path denies. A failed or uncertain probe does not fall back to host execution. |
| **Off** | Commands run without MXC under the current Windows account. Saved folder grants are retained but do not restrict these commands. |

MXC protects **Windows Node command execution**, not the entire application.
The Gateway, its native filesystem and process tools, plugins, channels, memory,
Cron, Hooks, and Canvas run outside this boundary and retain their configured
behavior. They can access resources independently of the selected MXC folders.
Do not treat the sandbox switch or folder list as a restriction on those
Gateway-hosted features.

MicroClaw defaults to On. Only a probe that positively identifies the Windows
installation as unsupported permits automatic startup with MXC Off and a
disabled switch and warning. Missing, damaged, inconclusive, or contradictory
runtime evidence instead leaves requested protection unavailable and fails
closed. Older `limited-dacl` selections migrate to Full; DACL containment is no
longer offered or automatically selected.

The node connects only to the managed loopback Gateway and has its own device
identity in MicroClaw's user-data directory. Its Gateway credential is passed
over an inherited bootstrap pipe, not in command-line arguments. The helper
checks the exact Gateway process owning the listener before connecting.

## Security settings and live changes

Security settings stage sandboxing, selected folders, and command consent
until **Apply changes** is selected. Folder edits
are saved while Off and take effect on the next successful activation. Applying
multiple settings performs the folder, consent, and mode updates
in order; if a later update fails, earlier successful updates remain saved.

Changing the mode is a live change between MXC and host execution, not a change
to MXC's Open preset. MicroClaw closes its managed ingress, invalidates pending
approvals, revokes the active lease, cancels and drains prior node operations,
and publishes a signed, versioned policy. The native node verifies and
acknowledges the exact policy and recreates the relevant execution capability.
On activation, MicroClaw verifies the attested BaseContainer and readiness
checks before issuing a new active lease and releasing ingress. The Gateway and
node do not restart for a successful live change. A failure is surfaced and
leaves execution locked rather than silently accepting a weaker policy.
The launch screen is shown while turning MXC On; turning it Off keeps the
current page visible.

Live folder and consent updates use the same policy and lease
boundary. Running node commands can be cancelled during an update.
Existing processes are not retroactively moved into or out of
a container.

The 30-second health heartbeat checks the current node, Gateway route, runtime
integrity, generation-bound readiness evidence, and active lease before renewing
the 120-second lease. It does not launch another SDK availability probe or share
an in-flight full-status probe. Full readiness/status checks still probe the SDK,
including startup and activation; the native executor independently checks MXC
availability and revalidates approval, policy, and lease before each command.
Missing or mismatched heartbeat evidence still locks execution. Heartbeat
observations do not replace full readiness results in the UI.

## Folders, CWD, and command consent

The trusted native folder picker maintains separate read-only and read/write
lists. Paths are canonicalized and checked for local, non-reparse directories.
Explicit child folders remain in the list when a parent is added or removed.
For overlapping grants, the most specific selected folder's access applies;
upstream-protected paths remain denied.
A requested working directory must be an existing local
directory without reparse redirection; in Full mode it must also be approved.
An omitted CWD uses isolated scratch. Full mode passes the selected folders and
uses the upstream Windows Node/MXC policy's own protected paths; MicroClaw does
not add a separate protected-folder list. An approved parent can contain an
upstream-protected child, which remains denied; direct grants inside such paths
and volume-root grants are rejected by upstream validation before activation
or a live change. Approving a profile parent can expose other files in that
profile beyond the originally requested file. The default agent workspaces are under
`%USERPROFILE%\OpenClawWorkspaces`; their one-time default parent grant can be
removed or reduced by the user.

In Full mode, `[declare-access]` identifies folders needed by an `exec`
command and can trigger a folder-grant request. Off mode does not request or
enforce those grants. If a conversation contains a stale declaration, its
contents remain bound to command consent but are not checked as MXC folder
paths and do not restrict host execution.

Generated agent guidance also covers permission-denied recovery: when contained
`exec` fails with a filesystem permission error, the agent should use the
reported path to request the smallest necessary directory with `[declare-access]`
and fresh consent. It must check for partial effects before retrying, ask when
the path is unclear, and never broaden grants repeatedly or bypass MXC. This is
agent guidance, not automatic command rewriting or permission granting; existing
workspaces receive the new section on startup without replacing custom guidance.

**Ask when needed** uses the upstream Windows Node command allowlist and asks
for commands that are not already permitted. **Allow always** disables those
command-consent prompts. Neither option adds MXC folder grants. An eligible
per-command **Allow always** decision is recorded using the upstream agent
allowlist; it is not an exact conversation- or CWD-bound grant. Some dynamic
commands are eligible only for a one-use decision.

The Gateway's prepared command, agent, session, CWD, executable identity, and
approval are bound to a one-use proof and revalidated before execution. Legacy
approval data is not upgraded into a broader authorization. A command requesting
a nonempty custom environment is rejected instead of running with unbound
environment values.

OpenClaw's normal Windows CMD translation is retained. MicroClaw has narrow
transport handling for CMD executable quoting and for eligible PowerShell
filesystem operations whose approved paths need initialization inside MXC;
these do not add folder grants or replace the upstream executor.

Other PowerShell commands started from private scratch can fail to initialize
the Windows filesystem provider. For those commands, use an already approved
working directory or include the required provider initialization in the
command submitted for approval, for example:

```powershell
powershell.exe -NoProfile -Command "New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) -Scope Script -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'MicroClawCwd:\' -ErrorAction Stop; & 'C:\Windows\System32\hostname.exe'"
```

MicroClaw does not silently rewrite arbitrary approved scripts or broaden
their folder grants.

## Restored Gateway capabilities

Sandboxing no longer replaces the user's normal Gateway tool, plugin, channel,
Cron, or Hooks configuration with an MXC-only allowlist. `exec` remains routed
to the bundled Windows Node for consent and, when On, MXC execution. Gateway
features still obey their own configuration and run outside MXC.

Enabling a plugin does not create a restrictive plugin allowlist when none was
configured. An existing allowlist is preserved; if it excludes the bundled
`browser` plugin, the Gateway's browser tool is unavailable until that plugin
is explicitly enabled. Browser control is a Gateway capability outside MXC,
not the Windows Node command-execution sandbox.

Web-search settings remain available in either mode. When a selected provider
needs its OpenClaw plugin, MicroClaw installs or enables the plugin matching the
running Gateway version, applies the search configuration, and verifies its
live activation without restarting the Gateway. Fresh installations do not
select a search provider or install a search plugin by default. If search is
not configured or was disabled, use **Enable search** in Settings to activate the selected
provider; opening Settings alone does not enable it. Provider API keys are
saved in the selected OpenClaw plugin's `webSearch` configuration. The Gateway
may leave a provider unloaded until it is selected. If activation cannot be
confirmed after the configuration is applied, the app reports that the
settings may already have been saved. The installer migrates legacy Brave and
Tavily keys into their plugin configuration and defers missing plugin setup
until the desktop is ready. Explicitly disabled search plugins are not
re-enabled by that background setup.

If no Gateway configuration exists, the initial model setup is shown before
Gateway startup. Its first save pins command routing to the bundled node and
starts the managed services. An existing unreadable configuration is not
replaced as if it were a new installation.

Installations previously paused by MicroClaw's old MXC Cron gate use a one-time
resume fence so occurrences missed during the historical pause are not
replayed. This migration does not pause new schedules.

WeChat media follows the normal channel paths. During a security transition,
MicroClaw fences its WeChat ingress and delivery until the current signed
generation is active; a stale or missing release record fails closed. For an
eligible single authenticated account, enabling MXC may enroll that exact
owner for experimental remote approval. Approval details can include command
text, arguments, and paths and are sent through WeChat. The owner binding,
source conversation, challenge, and current policy are revalidated; replacing
or disabling the owner invalidates outstanding challenges.

## Canvas

Canvas uses **unmodified stock OpenClaw routing in both MXC On and Off**.
The bundled Windows Node advertises and dispatches system commands only;
Canvas never runs through it. The Gateway compatibility preload does not
patch Canvas registration, tool actions, or node eligibility.

The pinned OpenClaw Canvas plugin requires a connected, eligible macOS node
advertising `canvas.present`. Without one, the stock tool reports that no
eligible Canvas panel is available. MicroClaw does not provide a replacement
local Canvas window or silently redirect the request. Existing Canvas plugin
configuration and explicit command permissions for other nodes are preserved.

The retired local Canvas host and Trusted Canvas media hosts controls are no
longer packaged or used. Legacy saved media-host values are inert; media
handling follows the selected stock Canvas node's implementation and policy.
Changing MXC mode, folders, or consent does not manage that node's surfaces.
This does not change `exec`: it still uses the bundled Windows Node for consent
in both modes and MXC containment when On.

## Packaging and provenance

The Windows Node source is pinned by
`third_party\openclaw-windows-node\PROVENANCE.json`; the current integration
uses upstream revision `f0592215f27100d9ecece33d3069daac76a4125c` and
`Microsoft.Mxc.Sdk` 1.0.1. `desktop\scripts\prepare-windows-node-resources.mjs`
publishes the host and upstream fixed file worker for the selected
Windows architecture. It verifies SDK assets, creates a manifest-addressed
worker payload, and records the host hash in `RUNTIME.json`.
The `microclaw.windows-node-exec.v2` runtime contract requires the upstream
folder-policy validation helper and rejects older bundles. The SDK is embedded
in the single-file host.
The packaging/signing steps update hashes after signing and verify the resulting
payload rather than accepting an unsigned or modified substitute.

The pinned OpenClaw Gateway compatibility preload is version- and digest-bound.
It supplies MicroClaw's approval-proof compatibility without
modifying the installed OpenClaw package; an unsupported package or changed
patch point fails explicitly. The supported Gateway pin and Node requirements are
defined in `deployer\openclaw_version.py`.

For development, run `npm run dev` from `desktop`. Prepare packaged native
resources with `npm run prepare-windows-node-resources`; use `.\build.ps1` from
the repository root for the full Windows package and installer.
