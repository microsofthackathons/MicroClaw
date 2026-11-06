# OpenClaw official updater installation test

## npm registry checks

Quick `/-/ping` probes only prioritize registries; they never prevent an actual
npm request. Python and npm can use different proxy or certificate settings,
and a slow or unsupported ping does not prove that package downloads fail.
Both Huawei HTTPS registry hostnames are available as fallback candidates.

Installer subprocesses use a 60-second npm request timeout and one retry, with
1-to-3-second retry delays. Proxy and certificate verification settings remain
intact, and these retry limits do not change global npm configuration. Fresh
installs can try another registry after a network or missing-version error;
an official update still runs once and never blindly falls back to npm replacement.

## Core installation and updates

The Windows installer separates first-time installation from core updates:

- No OpenClaw installation: install the exact packaged version with npm.
- Windows 2026.9.3 to 2026.10.3: use the controlled package-manager path below.
- Other older OpenClaw installations: invoke that installation's `openclaw update
  --tag <packaged-version> --yes --no-restart --timeout 600 --json`.
- Same version: skip core update/Doctor unless a package-manager repair is pending.
- Newer version: refuse an automatic downgrade.

OpenClaw owns plugin convergence, database migrations and official core update
recovery. MicroClaw does not retry an arbitrary failed core update with npm
or restore an older core/database snapshot over the official updater's state.
After a successful core update, MicroClaw backs up only its managed files before
updating its desktop/configuration. Gateway startup happens after desktop setup.
Local model provider installation remains an explicit Model Settings action.
The desktop's fixed read-only Windows identity bridge verifies separate module
hash manifests for 2026.9.3 and 2026.10.3; it does not grant arbitrary commands
host execution or disable the agent-tool sandbox for the older test runtime.

### Windows 9.3 to 10.3 compatibility path

The 9.3 updater's retained-package scan compares `ctimeNs` before and after a
read-only open. Endpoint DLP can add an extended attribute during that open,
changing NTFS ChangeTime without changing the document. This pair deliberately
uses the supported npm replacement path instead of invoking the incompatible
baseline scan first. It is not a fallback for unknown update/security failures.
See `openclaw-update-timestamp-2026-10-19.md` for the local reproduction evidence.

1. Require the Gateway and other OpenClaw/npm mutation processes to be stopped.
   Failure to enumerate processes blocks replacement; unrelated processes are
   not killed. Share the existing MicroClaw upgrade lock with legacy installers.
2. Run the **old** runtime's `backup create --output <archive> --verify --json`.
   The normal backup includes config, credentials, sessions, state databases and
   discovered workspaces, including configured custom workspace directories.
   Require its full-state/workspace verification result before continuing.
3. Record the backup's SHA-256 under `.microclaw/backups/openclaw-package/<id>/`
   and a durable resume record under `.microclaw/upgrade/`. Do not back up or
   scan the old `node_modules` tree. Existing upstream recovery artifacts stay
   available; MicroClaw does not delete them or disable endpoint protection.
4. Run `npm install -g openclaw@2026.10.3 --prefix <original-prefix>` once using
   the selected registry. A nonzero exit is a failure even if package.json now
   says 10.3. Do not automatically restore older databases after code migration.
5. Run the **new** runtime's `update repair --yes --no-restart --timeout 600
   --json`. Its official Doctor/plugin convergence handles state migrations;
   MicroClaw does not run an additional standalone Doctor afterward. Repair
   errors stop installation; reported advisories remain visible in the installer
   log. Before marking the upgrade complete, verify the installed version and
   require the Gateway to remain stopped.
   MicroClaw's own normal startup/health check still happens after desktop setup.
   Installation requires the launched desktop's matching transaction/PID ready
   receipt and an HTTP 200 response from the Gateway's `/health` endpoint. It
   does not launch additional Gateway status, configuration, agent, channel or
   cron RPC queries; feature diagnostics do not gate installation completion.
   `OPENCLAW_SERVICE_REPAIR_POLICY=external` keeps service install/start repairs
   with MicroClaw's supervisor instead of creating a competing OpenClaw service.
   The pinned Windows 10.3 compatibility preload opens newly copied native
   snapshot files before their identity baseline is recorded, avoiding first-read
   Endpoint DLP metadata changes without weakening the upstream integrity guards.
   See `openclaw-plugin-admission-2026-10-20.md` for evidence and test boundaries.
6. If interrupted after replacement, rerunning this installer verifies the
   retained backup checksum and resumes repair even if the installed version
   already says 10.3. Older pending `migrating` records also resume through
   official repair without an additional standalone Doctor. Missing/corrupt
   backups or unrecognized recovery records
   stop rather than being silently discarded. No blanket npm fallback or
   automatic old-state restoration is added to other upgrade versions.

The automatic path supports the installer's default state/config location.
Custom `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` or `OPENCLAW_HOME` overrides
are refused before backup/replacement rather than silently migrating the wrong
state. Configured custom **workspaces** remain supported by the official backup.

Build both test installers without changing the source default:

```powershell
.\build.ps1 -OpenClawVersion 2026.9.3
Copy-Item .\dist\MicroClawSetup.exe .\dist\MicroClawSetup-OpenClaw-2026.9.3.exe
.\build.ps1 -OpenClawVersion 2026.10.3
Copy-Item .\dist\MicroClawSetup.exe .\dist\MicroClawSetup-OpenClaw-2026.10.3.exe
```

The frozen installer reads its target from the bundled install manifest, not
from an environment variable. Both installers download OpenClaw and the matching
Parallel search plugin during installation; they are not offline runtime bundles.

Manual verification:

1. Back up user state and remove only MicroClaw/OpenClaw runtime installations.
2. Run the 2026.9.3 installer, confirm `openclaw --version`, launch the desktop,
   configure a model, and send a message to create state to preserve.
3. Run the 2026.10.3 installer without clearing state. Confirm the log records
   verified state/workspace backup, controlled npm replacement, new-runtime
   update repair, with a timing line for each phase and no additional standalone
   Doctor command.
4. Confirm the version, existing model settings/history, and Gateway readiness.
   No missing local-provider directory should be introduced by the installer.
5. Re-run the 2026.10.3 installer: core update/Doctor must be skipped. Re-running
   the older installer must refuse to downgrade.

Installer tests validate command selection and ordering. They do not establish
that upstream's full database/plugin migration succeeds on every user state;
the two manual installations above are the end-to-end acceptance test.
