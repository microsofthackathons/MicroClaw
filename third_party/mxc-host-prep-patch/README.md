# MicroClaw MXC host-preparation patch

This directory is a minimal managed-code port of the target-only system-drive DACL fix from
[`microsoft/mxc#649`](https://github.com/microsoft/mxc/pull/649), pinned to commit
`695c2b89c6142090a098ec4484f49aff8157f0b3`. The patch addresses
[`microsoft/mxc#648`](https://github.com/microsoft/mxc/issues/648).

Only `prepare-system-drive` and `unprepare-system-drive` are included. Both write the drive-root
DACL with `SetFileSecurityW`, which changes only the named root and does not normalize descendant
ACLs. Exact-ACE conflict detection, idempotence, and precise revoke semantics match the pinned
upstream change.

The output is named `microclaw-mxc-host-prep.exe` and is a MicroClaw-built derivative. It is not
the official `wxc-host-prep.exe` and must not be represented as Microsoft-signed. The official
`@microsoft/mxc-sdk@0.7.0` runtime is still staged unchanged; its helper remains available only for
the separate null-device operation until an official release includes the target-only fix.

Resource staging verifies the reproducible unsigned x64/ARM64 hashes recorded in `PROVENANCE.json`.
Electron packaging may then apply the MicroClaw product signature; its `afterSign` hook records the
final packaged hash in `RUNTIME.json` so runtime integrity checks use the signed artifact.
