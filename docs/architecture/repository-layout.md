# Repository Layout

This repository now uses a conservative, production-friendly layout rule: keep external entry points stable, move implementation details under domain folders, and prefer compatibility wrappers over risky path churn.

## Canonical Structure

```text
repo/
|- appcontainer/                # Windows AppContainer launcher and preload hooks
|- deployer/                    # Installer Python package and supporting modules
|- desktop/                     # Electron desktop application
|- docs/
|  |- architecture/             # Structural decisions and migration plans
|  |- plans/                    # Work-in-progress planning docs
|  \- reference/               # Human reference docs and setup notes
|- plugins/                     # Runtime plugins and channel integrations
|- scripts/
|  |- windows/                  # Canonical Windows operational scripts
|  \- *.js                     # Build and asset utility scripts
|- skills/                      # Managed skill definitions and assets
|- build.ps1                    # Stable repo build entry point
|- deploy.py                    # Stable installer entry point
|- launch.bat                   # Compatibility wrapper -> scripts/windows/launch.bat
|- setup.bat                    # Compatibility wrapper -> scripts/windows/setup.bat
|- setup-dependencies.ps1       # Compatibility wrapper -> scripts/windows/setup-dependencies.ps1
|- uninstall.bat                # Compatibility wrapper -> scripts/windows/uninstall.bat
\- uninstall-dependencies.ps1   # Compatibility wrapper -> scripts/windows/uninstall-dependencies.ps1
```

## Rules

1. Add new Windows helper scripts under `scripts/windows/`. Keep a root-level wrapper only when a command is already part of the public repo surface.
2. Put durable design notes, setup guides, and operational references under `docs/reference/` instead of the repo root.
3. Put long-lived architectural decisions and migration plans under `docs/architecture/`.
4. Treat the repo root as a navigation layer, not a dumping ground. Runtime packages and implementation modules belong in their owning directories.
5. Preserve compatibility first. If a path is already referenced by docs, packaging, or end-user workflows, keep a thin wrapper at the old path until consumers are migrated.

## Long-Term Target

The next safe structural step is not another root cleanup. It is build-aware package consolidation:

1. Move runtime apps only after build, packaging, and installer scripts resolve paths through a shared workspace-root helper rather than hand-built relative paths.
2. Consolidate cross-product integrations under a dedicated `integrations/` area once Teams and WeChat setup flows are actively maintained.
3. Keep generated outputs in ignored build directories and out of the tracked source tree.

Until those path contracts are centralized, incremental reorganization with wrappers is the lowest-risk way to improve structure without breaking logic.