# OpenClaw native plugin admission: 2026-10-20

## Failure and installed state

The October 19 installer completed npm replacement with OpenClaw 2026.10.3 in
244.62 seconds. Its subsequent `update repair` failed after 606.30 seconds.
The runtime now reports 2026.10.3, and the retained MicroClaw package-upgrade
record has `packageReady: true` and `phase: repairing`.

The first reported refusal is the Codex plugin Doctor contract failing with
`Native plugin companion changed before admission completed`. The
`plugin-doctor-state` refusal blocks later migration steps. Gateway recovery
verification and triage failure are subsequent diagnostics, not evidence that
the npm installation failed. The npm `allow-scripts` advisory is not the error
reported by this failed admission.

The 606.30-second phase includes the repair command and its recovery/diagnostic
work. It is not a measured database-migration duration. The upstream
`update-triage-BFMEOH1T.mjs` runs its noninteractive triage child with a separate
60-second timeout. The available log does not provide a full per-child timing
breakdown.

## Guard and local reproduction

The installed module is `dist/plugin-generation-artifact-BfVPxt5p.mjs`, SHA-256
`7e85c00946c7a17c2858c9cfcfa206854e92a1e9c10ca2e4c106d81dfca8ef04`.
Its source identity includes device, inode, mode, size, mtime and ctime. Native
companion snapshots copy safety-inspected files, including `package.json`,
before recording identities; other managed companions can use hardlinks.
The final admission hashes the copied files and requires the identity to remain
exactly equal to the recorded identity.

Using the actual installed module, with its imports redirected but its checks
unchanged, independent fixtures reproduce this exact error for copied `.md`,
`.txt` and `.json` companions. Bytes match the fixture SHA-256; only ctime
changes on the first read-content open. `.js` and `.bin` controls pass.
Managed hardlinked controls also pass. This is consistent with the previously
observed Endpoint DLP extended-attribute update, not an application editing
the companion's contents.

The failed installation retained a native snapshot for
`@openclaw/fs-safe-win32-x64-msvc` 0.24.2. Metadata-only inspection of its copied
`package.json` showed these October 19 UTC+08:00 times:

| Observation | Time |
| --- | --- |
| Creation | 18:07:32.4037889 |
| LastWriteTime | 18:07:32.4057886 |
| ChangeTime | 18:07:32.4157889 |

The file has `$KERNEL.SEC.ENDPOINTDLP`. Another retained native snapshot's copied
manifest had no EA and equal LastWriteTime/ChangeTime. This supports the
reproduction's mechanism. The original error does not name the companion or
retain its expected identity, so these observations alone do not prove the
historical offending pathname or the identity of the kernel writer.

## Compatibility change

The existing Windows 10.3 preload now also pins the native admission module's
exact filename and SHA-256. It adds a boundary-checked read-only open of each
newly **copied native snapshot** immediately after copy/chmod, before the
upstream identity inventory. This lets read-open metadata changes occur before
the baseline is recorded. It does not open the whole installed package in
advance, execute the native binary, modify the installed runtime on disk, or
change how old database contents are restored.

All upstream size, digest, path, inode, mtime and ctime guards remain unchanged.
In particular, a subsequent ctime change still refuses admission. Unknown
versions are skipped; an altered pinned module fails closed. Unmanaged-source
identity checks and reference/junction fallback behavior are not loosened.

The same existing preload is already loaded by installer repair/Doctor and by
the desktop-managed Gateway. Both bundled copies must match the source. The
installer bundle identity now includes this resource's source bytes.

## Validation and recovery boundary

`build/diagnose-native-plugin-admission.mjs` reproduces the unmodified behavior
and tests the fix against the actual 10.3 module without executing plugin code.
Its patched run verifies 15 fixture cases and three negative cases: appended
content, replacement by a different inode with identical bytes, and creating
a new hardlink after capture. All three mutations remain rejected. Unmanaged
protected-text copy cases continue to refuse source identity changes, as before.

The desktop regression suite additionally tests the source pin, exact patch
match, unchanged final guard, actual Node load-hook composition, copied native
manifests and rejection of post-capture edits. Existing state-owner/Gateway
tests cover coexistence with the previous PID compatibility adjustment.

The Windows run passed all 11 desktop tests, including the official Doctor and
owner integrations. The final native-snapshot test also rejects a ctime-only
hardlink mutation and an identical-content inode replacement. Installer
regression ran 195 tests successfully, with four skips. ESLint passed for the
preload and its tests. Final EXE extraction and both embedded preload copies
were verified; the retained 9.3 EXE is unchanged. The rebuilt 10.3 EXE SHA-256 is
`7F5A427A58D4542E232BC9D278AB766AC34BF1679645AB8BD93B309BED00D894`.

This is an installer/desktop preload adjustment. Direct system `openclaw`
commands without the preload still use the unmodified upstream behavior.

These checks are not a successful full migration of the user's retained state.
Do not delete recovery records, plugins, configuration, workspaces or backups,
disable endpoint protection, or blanket-approve npm scripts to bypass the
refusal. The corrected 10.3 installer should verify the existing backup and
resume repair rather than repeat the successful package replacement. A real
retry remains the end-to-end acceptance test.
