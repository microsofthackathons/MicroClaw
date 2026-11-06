# Installer-Owned Uninstaller Bundle

## Problem

MicroClaw registers `~/.openclaw/MicroClawInstaller.exe --uninstall` as the
Windows uninstall command. The current installer creates that persistent copy
only when it is running as a frozen PyInstaller executable. A source-mode or
headless installation can therefore finish successfully while registering an
uninstall command whose executable or adjacent `_internal` runtime is absent.

The installer must own this responsibility. A successful installation must
always leave a runnable persistent uninstaller, regardless of whether the
installation was launched from the packaged installer or from the source tree.

## Required Behavior

1. Packaged mode uses the running PyInstaller executable and its adjacent
   `_internal` directory as the source bundle.
2. Source mode uses `dist/MicroClawInstaller` in the repository as the source
   bundle.
3. The installer persists and verifies the bundle before creating uninstall
   shortcuts or writing the Windows uninstall registry entry.
4. Missing, incomplete, or unusable source bundles fail the installation.
5. A failed update preserves or restores the previously installed uninstaller
   bundle.
6. The persisted executable supports a no-side-effect `--check-uninstaller`
   mode that loads the packaged runtime and exits successfully without opening
   the UI or uninstalling anything.

## Design

### Bundle Resolution

Add a resolver with one responsibility: return the directory containing
`MicroClawInstaller.exe` and `_internal`.

- In frozen mode, resolve from `Path(sys.executable).parent`.
- In source mode, resolve from the repository application directory under
  `dist/MicroClawInstaller`.
- Reject a source if the executable is missing, `_internal` is absent or not a
  directory, or the source is the persistent destination itself.

Source-mode discovery is deterministic. It does not search arbitrary parent
directories or silently reuse a previously installed bundle.

### Persistence

Move persistence out of `_create_uninstall_shortcut()` into a dedicated
installation step.

The step copies the complete source bundle into a unique staging directory
inside `~/.openclaw`. It compares the staged bundle with the source using:

- required executable and `_internal` presence;
- relative file paths;
- file sizes.

After verification, the installer replaces the persistent
`MicroClawInstaller.exe` and `_internal` as one publication operation:

1. Move any existing persistent bundle to a temporary backup.
2. Move the verified staged bundle into the final paths.
3. Run the persisted executable with `--check-uninstaller`.
4. Delete the temporary backup only after the check succeeds.

If publication or the startup check fails, remove the partial new bundle,
restore the temporary backup, clean staging data, log an actionable error, and
return failure.

### Installation Flow

Both the legacy installer UI and the web installer add an explicit
`Installing uninstaller...` step after OpenClaw validation and before shortcut
creation.

Shortcut creation then performs only these tasks:

- create the desktop application shortcut;
- create the Start menu application shortcut;
- create the desktop uninstall shortcut;
- register MicroClaw under the current user's Windows uninstall key.

The shortcut and registry helpers require the persistent uninstaller to exist.
They return failure instead of falling back to the transient running installer.
`create_desktop_shortcut()` propagates failure from every required shortcut and
registration operation.

The existing installation orchestrators already treat an explicit false result
as a failed step and invoke the OpenClaw upgrade rollback. The persistence step
additionally restores the prior uninstaller bundle itself before returning
failure, so the old installation never loses its uninstall path.

### Startup Check

`deploy.py` recognizes `--check-uninstaller` before UI initialization or
elevation. The command imports the installer runtime, confirms it can resolve
the uninstaller entry point, and exits with status 0. It does not mutate state,
request administrator privileges, launch a window, or execute uninstall logic.

The persistence step invokes the check with a bounded timeout and suppressed
window. A nonzero exit, timeout, or process-start error fails publication.

## Error Handling

Errors identify the failed phase: source resolution, staging copy, staging
verification, publication, startup check, or restoration. Exceptions are not
converted into success-shaped defaults.

Temporary staging and backup paths are unique and scoped beneath
`~/.openclaw`. Cleanup targets only those resolved paths. Restoration failure
is reported separately and causes the installation to remain failed.

## Tests

Unit tests cover:

- packaged-mode and source-mode source resolution;
- missing executable or `_internal`;
- successful staging, verification, publication, and startup check;
- relative-path or size mismatches;
- copy and publication failures;
- startup-check failure and timeout;
- restoration of an existing bundle after failure;
- refusal to register or create an uninstall shortcut without a persisted
  bundle;
- propagation of shortcut and registry failures from
  `create_desktop_shortcut()`;
- `--check-uninstaller` exiting without UI or uninstall side effects.

Run the installer-focused Python tests, then the repository's existing full
build to validate the PyInstaller onedir output and distributable packaging.

## Out of Scope

- Replacing the current installer with MSI or a full NSIS installation model.
- Building a separate lightweight uninstaller.
- Changing what MicroClaw uninstallation removes.
