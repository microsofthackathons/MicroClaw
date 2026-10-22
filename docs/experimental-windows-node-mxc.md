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
     -> authenticated managed Canvas child
     -> pinned native A2UI surface
```

OpenClaw Companion, its tray UI, setup code, and local MCP endpoint are not used. The helper has a
separate device identity under MicroClaw's user-data directory and accepts only loopback WebSocket
Gateway endpoints. The Gateway credential is sent once over the helper's stdin; it is never placed
in argv, renderer state, logs, prompts, or contained-child environments.
The managed Gateway PID is also passed in bootstrap metadata. Before every credential-bearing
handshake or reconnect, the helper verifies that this exact process still owns the IPv4 loopback
listener; MicroClaw stops and recreates the helper for each Gateway generation.

The helper advertises the five reviewed system commands plus the exact Canvas Phase 1 command set
documented below. It contains no host command runner and cannot fall back
when MXC is absent or fails. Contained commands receive unrestricted public outbound network access
through MXC's `internetClient` capability, without a host fallback or host allowlist. Clipboard,
input injection, MCP, screen, camera, browser, location, and speech capabilities are absent.
`allowWindowsUi=true` is required for PowerShell compatibility with MXC 0.7; it does not activate
any screen capture or input capability.

MicroClaw exposes three explicit requested states:

| Requested state | Accepted MXC tier | Filesystem boundary |
|---|---|---|
| **Full containment** | `base-container` or `appcontainer-bfs` only | Selected RO/RW roots are a strict, exclusive capability ceiling |
| **Limited containment (DACL)** | `appcontainer-dacl` only | Selected roots are additive ACL grants; ambient Windows ACL access can remain |
| **Off** | No bundled MXC host | Restore the remembered standard sandbox route; it may be unsandboxed if that setting is off |

Every explicit user transition from Off to Full or Limited, and every explicit switch between Full
and Limited, first opens an in-app capability-disclosure consent dialog for the target mode. The
dialog appears before backend preflight, requested-mode persistence, Gateway or Node shutdown,
configuration rewriting, or any other lifecycle side effect. Canceling with the button, close
control, Escape, or backdrop leaves the requested and effective mode, persisted configuration,
Gateway readiness, and visible mode selection unchanged. Accepting continues the existing
transition once; Limited still requires its separate additive-DACL warning acknowledgement.
MicroClaw does not offer a "don't ask again" option and repeats the disclosure for every explicit
enable or Full/Limited switch. Internal refresh, relock, startup recovery, and fail-closed repair do
not prompt because they do not represent a new user-selected capability boundary.

Full containment is the security contract established by
[#224](https://github.com/microsofthackathons/MicroClaw/pull/224). It rejects DACL augmentation,
sets `fallback.allowDaclMutation=false`, and preserves the exact RO/RW ceiling, denied-root
precedence, and out-of-root denial invariants.

Limited containment is a separate, explicitly acknowledged threat model. It accepts only a
probe-attested `appcontainer-dacl` tier and sets `fallback.allowDaclMutation=true` for the reviewed
MXC DACL path. AppContainer process isolation, contained public outbound networking, clipboard
denial, input-injection denial, pinned-node execution, and strict no-host-fallback remain enforced.
However, Windows ACLs
may already allow the contained identity to access user folders outside the selected grants.
Selected RO/RW folders therefore **add access** and are not an exclusive allowlist; a read-only
selection cannot reduce a broader pre-existing ACL. MicroClaw never automatically changes Full to
Limited after an OS update, probe change, startup failure, or settings migration.

Gateway-native file/process tools remain removed from the agent surface in both Full and Limited
mode. The active Gateway surface is exactly `exec`, `web_search`, `web_fetch`, `message`, and the
reviewed `canvas` tool;
`exec` is pinned to the app-owned node, and `message` can reach only the requested WeChat channel.
The pinned OpenClaw `web_fetch` implementation is startup-attested to accept only HTTP(S), so
`file:` and other local URL schemes remain rejected. The policy keeps `group:fs` denied, including
at least the native `read`, `write`, `edit`, and `apply_patch` tools. Native Gateway filesystem
tools execute on the Windows host and would bypass Windows Node/MXC. Local file access must use
MXC-contained Windows Node `exec` or the MicroClaw WeChat media broker. MXC Off restores the user's
backed-up original tool policy.

## Canvas Phase 1

Canvas Phase 1 is available only while Full or Limited MXC is **Active**. It is a Windows Node UI
capability, not an MXC-contained `system.run` child. The same Gateway generation, policy
fingerprint, node identity, and signed active lease gate every Canvas command and action. The
bundled node launches a dedicated authenticated child that reuses the pinned native WinUI A2UI
router, component renderers, action bridge, and managed-surface snapshot implementation. The
standalone child constructs its window shell programmatically instead of loading the Companion
window XAML, so it does not activate unrelated Companion resources or capabilities. It does not
launch OpenClaw Companion or the legacy WebView Canvas.

The exact node command set is:

- `canvas.present`
- `canvas.hide`
- `canvas.snapshot`
- `canvas.caps`
- `canvas.a2ui.push`
- `canvas.a2ui.pushJSONL`
- `canvas.a2ui.reset`
- `canvas.a2ui.dump`

The agent-facing `canvas` tool maps only to the eight reviewed operations: `present`, `hide`,
`snapshot`, `caps`, `a2ui_push`, `a2ui_push_jsonl`, `a2ui_reset`, and `a2ui_dump`.
`canvas.navigate` and `canvas.eval` are neither advertised nor accepted. Presentation opens only
the managed native A2UI
shell: URL, HTML, file URI, UNC, absolute/relative local path, `javascript:`, arbitrary `data:`,
and unknown-scheme navigation are unavailable. A2UI pushes must be inline; `jsonlPath` is rejected.
Phase 1 media is restricted to bounded base64 inline PNG/JPEG/WebP image payloads. HTTPS media hosts
and staged local artifacts are intentionally deferred rather than widening the filesystem boundary.
Multiple surfaces are presented in a simple stacked layout in Phase 1. Tabbed surface chrome is
deferred because the unpackaged standalone host cannot reliably activate the pinned `TabView`
resource stack. This presentation limitation does not change the command, action, media, lease, or
snapshot boundaries.

Only `click`, `submit`, `confirm`, and `cancel` A2UI callbacks are forwarded. They re-enter the
normal Gateway as `agent.request` events after immediate lease and identity revalidation; they do
not directly invoke process, filesystem, config, Cron, Hooks, plugin, MCP, browser, screen, camera,
or node commands. Each surface is bound to the agent session that created it; a different session
cannot update, delete, or receive actions from that surface. There is no offline action queue or
relock replay. Snapshot captures only the managed XAML Canvas surface and returns in-memory image
data; `NodeScreenEnabled` remains false and no arbitrary local path is returned.

Locked startup, transitions, stale generation/policy/node/lease, node loss, or policy drift reject
Canvas before UI work. The broker rechecks immediately before host-side actions. Lease loss closes
the current Canvas and clears its surfaces; subsequent A2UI work remains rejected until a new
current-generation active lease exists. The exact command/action sets, native renderer, executable
hash, complete published Canvas-host code/resource tree hash, and all negative capability flags are
fingerprinted into the same policy and attestation used for activation. Unexpected command, action,
plugin, binary/resource, or local-capability drift relocks fail closed. The Canvas child also binds
to the exact node-host process identity and exits if that parent is lost.

Scheduled tasks keep their stored definitions while MXC is requested, but the effective Gateway
Cron scheduler remains disabled. Cron mutation, scratch-write, and run-now RPCs reject while MXC
is requested. The managed standard Gateway is stopped before the Off-to-MXC containment preflight,
so an already queued occurrence cannot race the transition; if preflight fails, MicroClaw restores
the unchanged standard Gateway before surfacing the failure. The Tasks view keeps listing saved
jobs, shows an MXC pause banner, labels requested-enabled jobs as paused, and leaves user-disabled
jobs disabled. Leaving MXC records a
one-shot durable resume fence; the pinned OpenClaw compatibility preload advances schedules due at
or before that fence, then allows ordinary startup recovery for later due times.
It durably acknowledges completion only after the scheduler resumes, so jobs missed during the
containment interval are not replayed without suppressing later work. OpenClaw heartbeat selection
is a separate agent-default setting rather than this Cron scheduler path and is unchanged.

External webhooks and internal Hooks follow the same requested-versus-effective model. Their
original configuration remains in the MXC backup while the effective Gateway config keeps both
surfaces disabled. A generation- and policy-bound compatibility gate returns HTTP 503 at the
configured (or default) webhook base path before reading a request body or admitting work. The
gate also recognizes bounded percent-decoded forms of the protected path and rejects ambiguous
configured paths rather than permitting a routing mismatch. Internal events are dropped before
listener lookup or handler execution. Neither surface queues paused work, so there is no replay
when MXC is turned Off; only newly arriving requests and events after restoration may run. The
same managed-Gateway stop that suspends Cron before Off-to-MXC preflight also closes these ingress
paths before containment validation, and a failed preflight restores the unchanged standard
Gateway. MicroClaw exposes no Hooks mutation bridge while MXC is requested, generic config writes
and Gateway restarts are blocked, and unreviewed hook plugins remain outside the exact plugin
allowlist. Settings reports the backed-up requested state as paused in both Locked and Active;
the original configuration is restored only after the Off transition. Any drift that enables
either hook surface while Full or Limited is requested fails policy validation and relocks.

The active policy also denies the runtime and plugin tool groups. The requested WeChat channel
plugin may remain loaded, but its long-poll loop does not call `getUpdates` until a release record
matches the current Gateway generation and MXC policy fingerprint. Outbound text and media use the
same dynamic release gate. Relocking removes the record before authorization is revoked, so paused
messages are not consumed and later replayed by MicroClaw. An empty OpenClaw allowlist is
unrestricted, so the pre-attestation tool state uses a non-tool lock sentinel. The Gateway
node-command policy allowlists exactly the five bundled commands above. MicroClaw pairs/reapproves
only the exact app-owned device identity and does not expose manual node selection, even if another
Windows Companion is connected.

Inbound WeChat media is decrypted directly into an app-owned staging root that is injected into the
same Windows Node policy as read-only. Outbound local media is brokered on the native Gateway only
after canonical-path, regular-file, selected-root/staging-root, and reparse-component validation.
Remote HTTP(S) media is downloaded into a broker-owned scratch root before upload. The broker policy
is immutable environment data bound to the Gateway generation and MXC policy fingerprint; a missing,
stale, malformed, or out-of-root policy fails closed without falling back to unrestricted host file
access.

## WeChat remote approval (Experimental)

WeChat remote approval is a default-off choice in the local MXC activation flow, not a standalone
Settings toggle. When MXC is currently Off and WeChat has exactly one authenticated account,
one main-process-owned native prompt offers Disabled, Enabled, and Cancel, defaulting to Disabled.
There is no duplicate renderer WeChat prompt, account selector, or opaque identity block. Cancelling
or closing the native prompt aborts activation before the Gateway or containment state is mutated,
without resetting ordinary runtime readiness. Unrelated MXC capability and Limited-filesystem
disclosures remain. The renderer sends only primitive mode/acknowledgement fields; the main process
derives the exact owner and native consent is the sole enrollment authority. Renderer-supplied
remote approval choices are rejected.

The main process re-reads channel state and account credentials immediately after native consent
and again at the locked transition boundary. An identity change while consent is pending aborts
activation rather than binding a replacement. It accepts only an exact authenticated
QR-login account ID plus its saved WeChat `userId`; a display name is never an identity. The approved
sole identity is atomically added to the account's sender allowlist when necessary, preserving other
explicit ordinary-message senders without granting them remote approval authority. If WeChat is
disabled, unavailable, unauthenticated, or in a legacy multiple-account state, MXC skips the popup
and proceeds with remote approval disabled. Turning MXC Off or replacing the exact identity clears
the owner binding, so a later activation asks again.

The selected configuration is persisted while the Gateway is locked and before the attested active
generation, lease, or ingress release is issued. Active Full/Limited mode switches cannot rebind
remote approval in place. Phase 1 accepts only the selected owner in a one-to-one chat. Group,
forwarded, quoted, ambiguous-account, stale-cursor, and out-of-order forms cannot approve.

Before starting a managed Gateway, the desktop validates and, when necessary, atomically converges
the installed WeChat extension to the packaged, content-hashed compatibility artifact for the
pinned OpenClaw SDK. A same-version extension is not trusted by version alone. The replacement is
staged and validated before an atomic rename, links its OpenClaw peer dependency to the exact
Gateway package, rejects nested or incompatible OpenClaw copies, and rolls back the prior extension
on failure. Account and token state under the separate `openclaw-weixin` state directory is never
part of this replacement.

The product threat model intentionally treats normalized ingress metadata from the allowlisted
`openclaw-weixin` plugin and Gateway as authentic user input: account identity, sender identity,
direct-chat identity, upstream message ID and cursor/order, exact content, and quote/forward/group
metadata. This trust assumption applies to every WeChat command, not only MXC remote approval.
MicroClaw does not require an independent WeChat server signature or immutable upstream lookup.
Compromise of the authenticated WeChat session, the allowlisted plugin, or the Gateway therefore
remains an explicit product risk and is disclosed in the local MXC activation dialog.

Provider message IDs and cursors use canonical nonnegative decimal strings internally. Numeric
JSON literals are preserved from their original source lexemes before floating-point rounding;
already-decoded unsafe numbers, missing fields, invalid decimals, and values beyond uint64 fail
remote-approval validation. Diagnostics report wire types/presence and hashed session-binding
shape, not message contents, credentials, or raw identities. A registered chat-route alias is not
implicitly equivalent to a different prepared execution-session binding.
MXC compatibility diagnostics compare fixed, hashed fields at exec defaults, node prepare
input/output, and the raw approval envelope before normalization. They do not establish route
equivalence or authorize a request.

Remote delivery requires a Gateway-derived approval origin from the already authenticated agent
runtime, not a caller-supplied route alias. It preserves the prepared policy/execution session for
execution and durable approval while separately identifying the originating conversation. The
plugin's actual SDK run-start callback binds that run to the exact inbound provider message ID,
cursor, account, sender, conversation, agent, route, and Gateway generation. The authenticated
origin must also identify the WeChat channel, account, and recipient. Missing or invalid origins,
unregistered runs, and mismatched providers remain local-only with explicit diagnostics; they
never fall back to matching a legacy session key. Completed dispatch callbacks cannot register
another run. No reply syntax or consent capability is upgraded by this binding.
Persisted consent and public account status retain their canonical identity format. Delivery
separately reads the exact, case-sensitive peer from the single authenticated credential record.
The inbound sender, direct conversation, authenticated origin recipient and current credential
peer must match byte-for-byte. The plugin uses that exact peer for its context-token cache and
revalidates it before every prompt, fallback, acknowledgement, reminder and terminal send. A
same-fold peer or alternate cache key is not an identity alias. A changed peer or missing exact
context fails closed without trying another recipient.
Main validates the exact authenticated wire peer both before and after its awaited Gateway route
lookup, then caches the normalized sender and conversation without recanonicalizing them. The
persisted consent identity remains canonical. Owner, consent, client, generation, or security
changes during route resolution reject registration before a source can authorize delivery.
The fixed-field diagnostic collector can also retain main-process source-cache acceptance,
source-validation and route-resolution rejection, approved-origin presence, bound-run hashes,
and typed delivery/rejection reasons. Source peer/account/route fields are fixed hashed descriptors,
not raw identities or alternative lookup keys. Its shared
allowlist rejects arbitrary output; commands, message text, identities, and credentials are not
included in these frames.
Delivery diagnostics use a separate versioned, primitive-only contract with fixed stage/kind/code
values and hashed delivery, challenge, inbound-request and provider-client correlations where
available. Provider HTTP acceptance is not proof that the user saw a phone message. Explicit
malformed provider return codes are unconfirmed failures; an omitted protobuf-default return
code remains supported. No response body, exception text, command, identity or credential enters
these frames, and an unconfirmed send does not cause an automatic retry. Acknowledgement
inbound-request hashes are not guessed approval bindings. Reminders defer to the current prompt's
choices and code, so they do not imply that legacy once-only consent permits durable approval.

Desktop thinking state follows exact Gateway session/run lifecycle events, including external
WeChat runs, rather than requiring a Desktop send. History's authoritative `sessionInfo` active-run
snapshot restores state after switching or reconnecting. Older terminal events and stale snapshots
cannot clear a newer run; lifecycle-only completion clears thinking without inventing a chat turn.
Streamed text and tool evidence remain pending until the actual terminal chat event or
authoritative history owns the output. Failed cancellation reports the error without falsely
clearing authoritative busy state.
The pinned SDK legitimately reports active projected, queued, embedded/approval-wait and
terminal-persistence states without an `activeRunIds` property. Those snapshots preserve explicit
session-local busy state with no invented run ID, while retaining any previously identified run
evidence. Identified snapshots still require consistent, unique nonempty IDs. A valid authoritative
idle snapshot clears unidentified busy state; malformed, wrong-session or stale snapshots cannot.
History hydrates inbound user turns during these active states rather than rejecting the snapshot
before processing its messages.
The Desktop explicitly subscribes to the selected session's transcript and catalog lifecycle
notifications. Only notifications matching the acknowledged selected session reach the renderer,
and the IPC notification contains only its session key. It refreshes authoritative history during
active runs and approval waits, so an inbound phone user turn need not wait for the assistant's
final reply or a separate agent-start event. Subscription rejection is reported rather than
treated as a successful observer.
The Electron sandboxed preload keeps its runtime IPC adapters self-contained: relative runtime
`require` imports are not supported there. Native Electron boundary regressions execute the
emitted preload with the production sandbox defaults and verify bridge exposure plus session
notification subscription and cleanup, rather than relying only on mocked renderer APIs.

Electron main remains the sole approval authority. The WeChat plugin has a generation-local,
token-authenticated named-pipe transport with only two operations: report a normalized inbound
message before agent dispatch, and deliver a desktop-generated system message. It cannot list
pending approvals, read a challenge, choose an approval ID, mutate approval state, mint execution
proofs, or expose the path through the ordinary `message` tool. Exact candidate replies are
intercepted before session recording and agent dispatch. Mixed, malformed, or otherwise ambiguous
challenge-shaped replies are also consumed and fail closed, including when the broker transport is
uncertain. Once an exact-owner prompt is successfully sent, other input in that owner's direct
conversation (including bare digits and invalid text) is consumed before the agent queue, makes
no decision, and receives at most three reminders with a five-second minimum interval. It never
extends the deadline. Outside this delivered pending mode, bare digits remain ordinary chat.
The long-poll loop advances its in-memory server cursor before placing ordinary messages on its
serialized dispatch queue, allowing an exact approval reply to be consumed while the originating
agent run is waiting. It persists the cursor only after the covered ordinary dispatches complete,
so a crash replays rather than drops them.

The reserved plain-text prompt begins `[MicroClaw Security Approval #CODE]`. The code is eight
characters from an unambiguous 32-symbol alphabet (40 bits), generated with `randomBytes`, valid for
at most two minutes, one-use, and limited to three wrong attempts plus a global attempt window.
The actual permission deadline is the earlier of the original 60-second Desktop window and the
Gateway expiry. The phone prompt and Desktop countdown use that same deadline. The prompt
renders authorization-relevant strings exactly and reversibly with JSON string quoting. It does not
trim or NFC-normalize, rewrite user-profile paths, parse and reserialize JSON, convert numeric text,
collapse duplicate keys, redact partial values, or otherwise change code points. It includes the
complete command text, executable canonical path and hash, argv, canonical CWD, declared file
access, agent/session, requested/effective MXC mode, expiry, and exact request reference.
Long approved fields use numbered JSON fragments joined without separators; nothing is hidden,
masked, or truncated.
If those exact fields exceed deterministic request/argument/declaration/line/total limits, contain
control, C0/C1, surrogate, bidi/format/default-ignorable, line/paragraph separator, zero-width,
variation-selector, or similar concealment characters, or appear secret-bearing or ambiguously
redacted, MicroClaw creates no remote challenge and leaves the normal local approval pending.
OpenClaw 2026.10.2 does not carry reliable sensitive-value provenance for every command display
field, so Phase 1 additionally uses a fail-closed structured presentation allowlist. The full
command must exactly reconstruct from the signed argv; executable/CWD/declaration values must be
canonical local paths or fixed structural bindings; and arguments are limited to bounded
parameterless switches, explicitly classified path/enum switch values, boolean literals, and short
relative filenames. Arbitrary positional text or numbers, inline option values, URLs, long opaque
values, credential-semantic names, and every other unknown form remain local-only. A closed
literal PowerShell grammar also covers `New-Item` (File/Directory), `Remove-Item` (including
explicit recursive deletion), `Clear-Content`, `Set-Content`, and `Add-Content`, including the
pinned outer interpreter and one literal nested interpreter. Paths must be literal local paths
covered by an explicit RW declaration. Script expansions, pipelines, extra invocations, unknown
flags, wildcard/device/UNC/ADS paths and arbitrary inline contents are not eligible. Inline
content is limited to the reviewed public primitives `""`, `"0"`, `"1"`, `"true"`, `"false"`,
and `"null"`; other content writes stay local, even when the text happens to be non-secret.
This is intentionally conservative: a non-secret command may still require local approval when its
display sensitivity cannot be proven from the current execution contract.

In Limited-DACL only, the Windows host prepares a versioned public PowerShell filesystem scope
for the closed literal directory-creation and removal forms above (direct Windows PowerShell or
one literal nested Windows PowerShell). Windows PowerShell otherwise normalizes absolute paths
against its default drive and can fail on ungranted ancestors even when the target has the approved
RW rights. The scoped `MicroClawCwd:` PSDrive is rooted at the physical canonical or isolated
working directory; logical `$PWD` becomes `MicroClawCwd:\`. The physical working directory,
original absolute target, C: drive, filesystem grants and ancestor ACLs do not change.

Initialization and immutable original/final argv metadata are generated **before** executable
identity capture and approval. Main independently regenerates them, and the proof binds them.
Execution revalidates the prepared bytes and target, then launches those exact approved argv;
it does not rewrite an approved command. Both phone and Desktop disclose the scope and retain
the complete executed command. Original command output, errors and exit status are preserved;
initialization failure exits 125 without executing the operation. Reparse targets are rejected.
Arbitrary scripts, encoded/file/interactive/profile/relative forms and other unsupported commands
retain their existing behavior and approval rules; this is not a general PowerShell script rewrite.

- `1 CODE` approves the exact first/current request once.
- `2 CODE` saves the same exact conversation-scoped durable approval available on the Desktop,
  only when that exact request is eligible.
- `3 CODE` denies the exact request.

The current provider has no authenticated outgoing message timestamp/cursor fence. Incoming
provider time compared with local delivery time cannot prove that a bare digit was authored after
the prompt. Therefore the displayed syntax always requires the request code; timestamps are
diagnostic metadata, never a guessed authorization signal.

The in-memory challenge binds the authenticated sender/account/chat, source message ID and cursor,
agent/session, exact approval IDs and batch, executable canonical path and SHA-256, argv, CWD,
declarations, requested/effective mode, Gateway generation, policy fingerprint, node identity,
active-lease hash, creation/expiry, challenge ID, and code hash. Electron revalidates the current
pending approval, ingress release, Gateway client/generation, policy proof context, and active lease
immediately before the existing `exec.approval.resolve` call. Exact Always resolves the current
Gateway request once and then persists the existing executable/hash/argv/CWD/access/policy/agent/
session identity. Phone-created records additionally bind a hash of the exact native owner consent
epoch and versioned durable capability, so MXC Off/reconsent or account replacement cannot transfer
that authority. Existing native one-use consent remains enabled for once/deny but is never silently
upgraded: `2 CODE` stays unavailable until the user deliberately turns MXC Off and chooses Enabled
in the existing single native prompt. Only that main-owned choice issues the current capability;
renderer-supplied scope markers are rejected. It never grants
all writes/deletes or broadens folders. A failed durable save is explicitly reported as accepted
once, not as a successfully saved Always grant.

First resolution wins across local and remote UI. Local resolution, timeout, relock, Gateway/Node
restart, policy or lease drift, MXC Off, logout/rebind, feature disable/revoke, shutdown, prompt-send
failure, and excessive code attempts invalidate the challenge. Timeout calls the actual Gateway
deny resolver. The authoritative terminal event closes only its matching Desktop request and
invalidates the phone challenge. One safe phone result identifies the accepted decision and origin
(Desktop/WeChat/timeout), explicitly not command execution success. Unknown resolution outcomes
are reported as unconfirmed, never retried or falsely reported as denied. Overlapping requests
retain their original deadlines and receive remote authority one at a time.

Suppression is never silent: typed, hashed diagnostics distinguish source/route, security,
transport and presentation failures, and the Desktop shows phone-delivery/local-only state.
Unsupported or sensitive commands with a verified source get a data-free phone local-only notice
and a terminal result, not leaked contents or a misleading masked consent. A prompt-send failure
leaves the normal local approval pending and is not automatically resent.

WeChat toggle/login/replace/disconnect controls are locked in both channel/plugin views while
MXC is active or transitioning. Main enforces the same guard before writes/spawns/RPC, and
activation cannot cross an in-flight account mutation or unconfirmed login writer. Cancellation
waits for known writers to drain; an unknown writer requires an explicit Gateway stop.

Acknowledgements are system messages and never enter agent history.
An acknowledgement delivery failure does not re-dispatch the consumed approval reply. The plugin
advances its in-memory long-poll cursor while approval is pending, but persists each cursor only
after every ordinary message covered by it has completed dispatch; a restart therefore replays
rather than loses queued messages.
The local JSONL security audit records only timestamps, hashed owner/chat/challenge, hashed approval
and security identifiers, and result/reason; it never records the raw code, account token, challenge
state, secrets, or full command values.

## CWD and approval contract

The exact attestation contract is `microclaw.windows-cwd.v1`. A supplied CWD must:

- be an existing local drive-qualified directory;
- reject UNC, device, NT object-manager, junction, symlink, and other reparse components;
- resolve to the same final case-insensitive Windows path;
- be equal to or below one canonical selected RO/RW root;
- not overlap a protected credential, OpenClaw state, SSH, cloud, or browser-profile root.

CWD inherits the matched root's requested access; it never creates a grant. Omitted CWD binds
approval to `isolated-scratch:v1` and launches in a per-run writable scratch directory. This check
is launch-location validation, not proof that every target file is bounded by the selected roots.
That stronger statement is true only in Full containment. In Limited containment, ambient Windows
ACL access may still permit target-file access elsewhere. The node re-hashes the executable through
its held handle; policy, reparse state, root membership, exact CWD binding, and declared access are
revalidated immediately before launch. Delete-denying directory handles retain every approved-root
/CWD path component through MXC completion, preventing a validated directory from being replaced by
a junction during launch.

Settings > Security presents the mode cards and separate Read-only and Read/write lists. In Full,
these lists define the hard capability ceiling. In Limited, they are labeled as additional grants
and do not claim to override ambient ACLs. Folder selection uses Electron's trusted native directory
picker. Equal paths are deduplicated, redundant nested grants are collapsed, and a narrower RW root
under a broader RO root remains explicit. While MXC is enabled, edits remain a renderer draft and
cannot mutate live ACLs or settings. **Apply changes and reactivate** performs one serialized
fail-closed transaction: lock ingress, reject pending approvals, revoke proof/lease state, validate
the complete draft, stop the exact generation, apply and atomically persist the same
`sandboxUserDirsRO`/`sandboxUserDirsRW` policy, attest and smoke a locked generation, attest and
smoke a fresh active generation, mint its lease, verify the effective route, then release ingress.
Full runs its outside-root denial check plus one deterministic contained execution smoke. Limited
runs only the contained execution smoke because ambient-access assessment, not out-of-root denial,
is its filesystem safety gate. The fixed smokes use internal one-use readiness proofs and never
enter the user approval queue.
Cancellation or any failure leaves execution locked and retains the attempted draft and previous
policy for explicit retry or revert; MicroClaw never silently restores old active execution. Folder
preparation that requires elevation fails locked without opening an elevation prompt. UNC,
device-namespace, missing, reparse, final-target-changing, and protected credential/state/browser
roots are rejected before persistence.

Persistent AppContainer folder ACL ownership is scoped to the exact
`(MicroClaw AppContainer principal, canonical folder, requested RO/RW access)` tuple. Policy
replacement revokes only the MicroClaw principal on changed folders, applies the new tuples in
deterministic parent-before-child order, verifies propagation, and rolls the complete tuple set back
if mutation or persistence fails. The recoverable previous/draft policy retains access levels, while
the grant-history reconciliation removes stale MicroClaw grants on startup. Revocation is
principal-targeted and does not replace the folder DACL, so pre-existing Windows, administrator,
user, or third-party ACEs remain untouched.

The normal active route has one visible Gateway/MicroClaw prompt. It displays executable, exact argv,
agent/session scope, canonical CWD, declared folder use, the attested containment strength, and in
Limited mode the category-only ambient-access summary. Full offers Deny, Allow once, and eligible
Allow always. Limited offers only Deny and Allow once: durable approvals are rejected, including
records created under another mode. MicroClaw resolves allowed executions upstream as one-use; it
never delegates durable authority to the Gateway or node. The Gateway then mints a fresh 15-second,
one-use HMAC proof bound
to the exact generation, node, policy fingerprint, prepared plan, executable path/content hash, CWD,
declarations, agent, and session. The node silently accepts only that proof after recapturing the
held executable identity. Direct `node.invoke`, malformed, stale, replayed, or concurrent reuse is
denied. Fixed readiness commands use a separate HMAC contract bound to the transition ID, Gateway
generation, node, policy, probe kind, exact prepared executable path/content hash, argv, isolated
scratch CWD, empty declarations, short expiry, and one-use consumption. Readiness preparation
performs the mode-bound ambient revalidation first; only after it returns does MicroClaw mint and
immediately dispatch the proof for that single invocation. The helper retains a bounded, one-use
preparation record and revalidates the proof immediately before MXC process launch. Only
`system.run.readiness` accepts that proof; ordinary `system.run`, including identical PowerShell
argv after startup, still requires the normal visible approval. Each contained child inherits
`TEMP`/`TMP`/`TMPDIR` pointing at its own writable scratch grant.

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
valid exact match suppresses the visible prompt in Full mode but still receives a fresh one-use
Gateway proof and full node launch-time revalidation. It never changes configured folder grants.
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
layout unchanged. The published package binaries identify source revision
`0e02a720e32416b151dbcb0a00e3d4ac2b891559`; the runtime manifest records and revalidates that
revision, the binary hash, and the official production build's `tier2_bfs`-disabled contract.
Package architecture is mandatory rather than inferred from the build machine, and the manifest is
checked again by the app before the executable can be probed or launched. Development resources,
portable/NSIS extra resources, and MSIX preparation all use the same staging script.

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
Host-prep prepare/unprepare is idempotent and removes only the exact non-callback
All Application Packages metadata-read ACE tuple that MicroClaw owns. Tests preserve the existing
child DACL byte-for-byte and preserve unrelated or callback ACEs, including ACEs for the same SID.

## Exact-backend host support

MicroClaw does not provision an exact backend by changing host security state. It first validates
the pinned runtime manifest and hashes, then runs `wxc-exec --probe`. Full activation does not start
unless the probe proves `base-container` or `appcontainer-bfs` with no DACL augmentation. Limited
activation does not start unless the same pinned runtime proves exactly `appcontainer-dacl`.

| Probe and host state | Full | Limited | Behavior |
|---|---:|---:|---|
| `base-container`, Base Container API usable | Yes | No | Full may continue with locked-generation attestation |
| `appcontainer-bfs`, BFS compiled in and `bfscfg.exe` present | Yes | No | Full may continue with locked-generation attestation |
| `appcontainer-dacl` | No | Yes | Full remains disabled; Limited requires acknowledgment and ambient assessment |
| Base Container API absent and official MXC 0.7 BFS compiled out | No | Probe-dependent | Show the exact [#228](https://github.com/microsofthackathons/MicroClaw/pull/228) Base Container/BFS prerequisite and remediation; never downgrade Full |
| Probe, version, source revision, or hash mismatch | No | No | Stay fail-closed and require repair of the reviewed runtime |

For MXC 0.7, Tier 1 dynamically requires `processmodel.dll` and
`Experimental_CreateProcessInSandbox`. The API is supplied by Windows, not by the SDK package or
`wxc-host-prep.exe`. MXC maintainers document current Tier 1 availability as Windows Insider-only
in [`microsoft/mxc#693`](https://github.com/microsoft/mxc/issues/693), despite broader SDK
documentation describing Windows 11 24H2 process containment. MicroClaw therefore uses successful
capability probing rather than an edition/build-number allowlist.

Tier 2 is compile-time gated by MXC's `tier2_bfs` feature. Official production 0.7 builds leave that
feature disabled because the BFS path can hang affected Windows 11 25H2 hosts; copying
`bfscfg.exe` onto the machine cannot enable it in the packaged runtime. The official host-prep
utility and MicroClaw's reviewed patch prepare only Tier 3 DACL prerequisites and cannot install
the Base Container API or add BFS support to `wxc-exec.exe`. The minimal upstream requirement for
GA Windows Full containment is an official signed runtime with a reviewed exact backend, plus a
documented supported Windows build/feature matrix. Until one is available, Full remains disabled on
unsupported hosts even when Limited is available.

## Limited ambient-access assessment

Before Limited activation, MicroClaw runs a bounded assessment through the exact pinned Windows
Node host and `wxc-exec` path. It records only a stable category and `denied`, `read`, or
`read-write`; it does not read file contents, enumerate names into output, or expose sensitive
absolute paths in normal UI or logs. The assessed categories are Desktop, Documents, Downloads,
MicroClaw state, the active and roaming OpenClaw state roots, `.ssh`, GnuPG, AWS, Azure,
Kubernetes, Google Cloud, Windows Credentials, PowerShell history, and common Chrome, Edge, Brave,
and Firefox profile roots.

Access to any state, credential, shell-history, cloud, SSH/GnuPG, or browser profile root blocks
activation. Ambient access to Desktop, Documents, or Downloads is a warning and is shown truthfully
as a known Limited-mode capability. An existing sensitive root whose contents cannot be enumerated
is treated as accessible rather than denied. For an absent root, the assessment tests whether the
nearest existing parent can create it; writable parents block activation. The deterministic
category/status result hash is embedded in the fingerprinted host policy. Consequently the
requested strength, effective tier, assessment hash, approval/readiness proofs, activation lease,
and Gateway generation all describe the same attested state.

The host re-runs the assessment at startup and in the serialized readiness/command preparation
immediately preceding every Limited launch. A changed
status or hash, missing result, tier change, restart, or policy change closes ingress, revokes the
lease, and requires a fresh explicit transition. The assessment is enforcement evidence, not a
one-time warning dialog.

An explicit activation performs one main-process containment validation after native consent and
before security configuration or remote-approval persistence. Its result is scoped to that lifecycle
transition and handed to the initial locked Gateway startup; it is not a cross-transition cache.
Host startup and per-command revalidation remain independent fresh checks. All 18 assessment
categories remain sequential, with category/status/elapsed diagnostics, a 30-second per-target
limit and a 180-second helper limit; helper timeout terminates and verifies the process tree.
The renderer waits for actual lifecycle events before gating the ordinary UI, including while the
persisted mode is still Off. Pending/cancelled native consent and pre-start guard rejection leave
readiness unchanged. Validation failure restores the standard runtime before service-ready releases
the loading gate and the original error is shown.

## Readiness and activation transaction

The helper also enforces `microclaw.windows-activation.v1`: an HMAC-SHA256 lease bound to the exact
Gateway generation, helper policy fingerprint, requested containment strength, effective tier,
Limited assessment hash when applicable, mode, and expiry. Its per-generation key is delivered only
through inherited stdin. A diagnostic lease admits only the fixed deterministic PowerShell probe,
which launches the built-in `hostname.exe` child and verifies deterministic marker output from
isolated scratch. Full additionally runs the denied-CWD check at canonical CWD policy before launch;
Limited does not claim that check as a filesystem guarantee. An active
lease admits the normal attended `system.run` path. The helper checks the lease before authorization
and again immediately before MXC launch.

MicroClaw stores a versioned requested mode separately from the attested effective strength. A
legacy enabled boolean migrates conservatively to Full, never Limited; Limited survives migration
only with explicit persisted evidence and an acknowledgment timestamp. When MXC is Off, startup
follows the remembered standard Gateway/sandbox route without starting the bundled node. When Full
or Limited is requested, the loading screen remains visible while MicroClaw closes ingress, proves
the mode-specific backend, then starts every Gateway generation locked and runs the secure
readiness and activation sequence. Fixed readiness probes are internally authorized by the current
serialized lifecycle and produce no permission dialog; this authority cannot be used by agent
commands. Readiness requires the exact CWD/activation attestation payload, selected app-owned node
identity, paired and connected state, strict no-fallback settings, current-generation effective
tools, exact mode/tier agreement, and the mode-specific current smoke record. Full requires the
contained PowerShell/child execution smoke plus outside-root denial. Limited requires the one
contained execution smoke plus the current ambient-assessment hash and category/status result.

Every MicroClaw-owned `chat.send` path, including startup warm-up and generated session titles,
passes through the same current-generation active-ingress gate. Locked or attesting startup skips
warm-up without queuing or replaying it; warm-up can run only after final activation release.

Activation is an automatic fail-closed transaction:

1. Close ingress, validate the pinned runtime provenance/hashes, and prove the exact backend allowed
   by the explicitly requested mode.
2. Start and attest the locked generation and its smoke record.
3. Stop the Gateway and reject, rather than queue, MicroClaw chat sends.
4. Write an active policy that exposes only node-pinned `exec`, reviewed Web/WeChat routing, and
   the exact Canvas tool; disable other channels, webhooks, internal hooks, cron, and plugins.
5. Start a new managed loopback Gateway generation and pair the exact bundled node.
6. Verify the node declaration, requested/effective containment strength, exact tier, CWD contract,
   strict helper policy, Limited assessment hash if applicable, and exact effective tool/Canvas
   command inventory.
7. Repeat the mode-specific contained smoke profile for the active generation under a diagnostic
   lease.
8. Issue an active lease, perform a final attestation, then release MicroClaw chat ingress.

Any restart, disconnect, timeout, policy/tool/tier/assessment drift, missing or expired lease,
helper failure, or attestation error revokes the lease, clears the smoke proof, rewrites the locked
policy, and stops the managed Gateway. A new probe never authorizes a Full-to-Limited downgrade.
Configuration and restart operations that could invalidate an active transaction are rejected while
this mode is enabled. Unreviewed external channels, hooks, cron, and plugins remain disabled. The
loading screen shows the requested mode, attested
effective strength/tier, failed MXC phase, and recovery detail;
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
package is not modified. The hook requires OpenClaw `2026.9.3` and exact SHA-256 hashes for the
affected compiled modules; any version, hash, or source-shape mismatch prevents the managed Gateway
from starting. The 9.3 package uses `.mjs` bundles; its approval replay and plan-normalization
contracts retain the same patch points, including the upstream active-decision check before replay.
The runtime must be Node `>=24.16.0 <25 || >=26.1.0`.
The desktop advertises the `exec-approvals` Gateway capability only while MXC mode is enabled,
so 9.3 routes approval events to its handler without diverting approvals in normal mode.

To verify the hook against an unpacked official `openclaw@2026.9.3` npm package, set
`MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR` to its absolute package directory and run
`npm test --prefix desktop -- openclaw-approval-replay-compat`. The integration cases validate the
published module hashes, patch points, preload initialization, and compiled JavaScript syntax without
modifying the installed package or requiring a configured Gateway.

OpenClaw's doctor migrates the roster to keyed `agents.entries` with explicit ownership.
Desktop startup, skill updates and MXC policy changes preserve this format and never reintroduce
the retired per-agent `default` marker. Node command policy uses `gateway.nodes.commands.allow`
and `.deny`; execution timeouts use `timeoutSeconds`.

The same pinned Gateway binds approval registration and replay to the prepared plan's exact argv,
CWD, agent, and session. The bundled host therefore returns the canonical
`{ plan: { argv, commandText, cwd, agentId, sessionKey } }` response and copies `sessionKey` from the
inner `system.run.prepare` parameters, not the node envelope. Dropping it makes registration fall
back to the chat session while replay normalizes the plan to `null`, which the Gateway correctly
rejects as `approval id does not match request`.

After explicit consent, the MicroClaw-built system-drive helper and the official MXC null-device
helper both completed successfully. A Full request remains locked on `appcontainer-dacl`; only
`base-container` or `appcontainer-bfs` satisfies Full. An explicitly acknowledged Limited request
can proceed on `appcontainer-dacl` only after its sensitive ambient-access assessment passes. On a
supported host, the locked-generation proof reaches the exact bundled node and official
`wxc-exec.exe`; the deterministic PowerShell probe launches `hostname.exe` from isolated scratch
under a transition-bound internal one-use proof with no durable approval, user prompt, or host
fallback. Full also proves protected `C:\Windows` CWD denial. Ordinary agent execution retains the
visible approval contract.
The active transaction also passed end to end: MicroClaw reported chat disconnected before release,
started a new Gateway generation, re-attested the exact node and `exec`-only tool surface, repeated
the mode-specific smoke, issued and renewed the generation-bound active lease, then reported chat
connected.
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
