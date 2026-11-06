# Best-Effort Installer Shortcuts

## Problem

The installer currently treats every Windows entry-point failure as fatal.
After the uninstaller bundle is safely persisted, a failure to create a
Desktop or Start menu shortcut can therefore roll back an otherwise usable
installation. Redirected shell folders and enterprise policies make shortcut
creation less reliable than the installed application and Windows uninstall
registration.

## Required Behavior

Shortcut creation is best-effort:

- the MicroClaw Desktop shortcut may fail without failing installation;
- the Start menu shortcut may fail without failing installation;
- the Desktop uninstall shortcut may fail without failing installation.

The installer still attempts all three shortcuts and keeps their existing
diagnostic logging.

The following remain fatal:

- resolving, copying, validating, or starting the persistent uninstaller
  bundle;
- registering MicroClaw under the current user's Windows uninstall registry
  key.

The registry entry is the authoritative uninstall path. If it cannot be
written, the install step returns failure and the existing installer pipeline
initiates rollback.

## Design

`WindowsSetup.create_desktop_shortcut()` continues to invoke every shortcut
helper before registration. It does not short-circuit after a shortcut failure.
The method returns only the result of `_register_installed_app()`.

Each shortcut helper retains its current Boolean result and warning/error
logging so failures remain visible in installer logs. Their results no longer
determine the install-step result.

`install_uninstaller_bundle()` remains a separate required pipeline step before
shortcut creation. `_register_installed_app()` continues to validate the
persistent bundle before writing the uninstall key. This preserves defense in
depth if the bundle disappears between the persistence and registration steps.

## Tests

Update the `WindowsSetup` tests to prove:

- Desktop shortcut failure plus successful registry registration returns
  success;
- Start menu shortcut failure plus successful registry registration returns
  success;
- Desktop uninstall shortcut failure plus successful registry registration
  returns success;
- registry failure still returns failure;
- every shortcut and the registry helper are attempted.

Run the Windows setup tests, the complete Python test suite, and the existing
full build.

## Out of Scope

- Uninstaller bundle fast paths or identity markers.
- Changing registry failure or bundle validation into best-effort behavior.
- Retrying shortcut creation outside the existing installer retry policy.
