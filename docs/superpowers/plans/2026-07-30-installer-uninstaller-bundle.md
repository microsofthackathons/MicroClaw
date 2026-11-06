# Installer-Owned Uninstaller Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every successful packaged or source-mode MicroClaw installation persist and verify a runnable uninstaller before creating Windows uninstall entry points.

**Architecture:** Add a focused `deployer.uninstaller_bundle` module for deterministic source resolution, bundle validation, staged publication, and restoration. `WindowsSetup` adapts those pure operations to installer logging and subprocess execution; both installer UIs expose persistence as a required transaction step, while `deploy.py` provides a side-effect-free runtime check.

**Tech Stack:** Python 3.10+, `pathlib`, `shutil`, `tempfile`, PyInstaller onedir, `unittest`, Windows registry and PowerShell shortcut integration.

---

## File Structure

- Create `deployer\uninstaller_bundle.py`: pure bundle resolution, validation,
  manifest comparison, staged publication, and restoration.
- Create `tests\test_uninstaller_bundle.py`: filesystem-focused unit tests for
  the new module.
- Modify `deployer\windows_setup.py`: installer integration, startup-check
  subprocess, strict shortcut and registry behavior.
- Modify `tests\test_windows_setup_upgrade.py`: `WindowsSetup` integration and
  failure propagation tests.
- Modify `deploy.py`: side-effect-free `--check-uninstaller` handling and a
  testable legacy install-step builder.
- Modify `deployer\webview_bridge.py`: testable web install-step builder and
  required uninstaller step.
- Modify `tests\test_webview_bridge.py`: argument routing and install-step order
  tests for both UIs.

### Task 1: Pure Uninstaller Bundle Publication

**Files:**
- Create: `deployer\uninstaller_bundle.py`
- Create: `tests\test_uninstaller_bundle.py`

- [ ] **Step 1: Write failing resolver and validation tests**

Create `tests\test_uninstaller_bundle.py` with temporary packaged and source
layouts:

```python
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deployer.uninstaller_bundle import (
    UninstallerBundleError,
    bundle_manifest,
    publish_uninstaller_bundle,
    resolve_uninstaller_bundle,
    validate_uninstaller_bundle,
)


class UninstallerBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _write_bundle(self, root: Path, marker: str = "new") -> Path:
        root.mkdir(parents=True)
        (root / "MicroClawInstaller.exe").write_text(marker, encoding="utf-8")
        internal = root / "_internal"
        internal.mkdir()
        (internal / "python.dll").write_text(f"{marker}-runtime", encoding="utf-8")
        (internal / "deployer.pyc").write_text(f"{marker}-code", encoding="utf-8")
        return root

    def test_resolves_frozen_bundle_from_executable_directory(self):
        source = self._write_bundle(self.root / "packaged")

        resolved = resolve_uninstaller_bundle(
            frozen=True,
            executable=source / "MicroClawInstaller.exe",
            app_dir=self.root / "repo",
        )

        self.assertEqual(resolved, source)

    def test_resolves_source_bundle_from_dist(self):
        app_dir = self.root / "repo"
        source = self._write_bundle(app_dir / "dist" / "MicroClawInstaller")

        resolved = resolve_uninstaller_bundle(
            frozen=False,
            executable=self.root / "python.exe",
            app_dir=app_dir,
        )

        self.assertEqual(resolved, source)

    def test_rejects_bundle_without_internal_runtime(self):
        source = self.root / "broken"
        source.mkdir()
        (source / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")

        with self.assertRaisesRegex(UninstallerBundleError, "_internal"):
            validate_uninstaller_bundle(source)

    def test_rejects_empty_internal_runtime(self):
        source = self.root / "broken"
        source.mkdir()
        (source / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")
        (source / "_internal").mkdir()

        with self.assertRaisesRegex(UninstallerBundleError, "empty"):
            validate_uninstaller_bundle(source)
```

- [ ] **Step 2: Run resolver tests and confirm the missing-module failure**

Run:

```powershell
python -m unittest tests.test_uninstaller_bundle -v
```

Expected: FAIL with `ModuleNotFoundError: No module named
'deployer.uninstaller_bundle'`.

- [ ] **Step 3: Implement deterministic resolution and manifests**

Create `deployer\uninstaller_bundle.py`:

```python
"""Durable publication of the onedir MicroClaw uninstaller."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

INSTALLER_EXE = "MicroClawInstaller.exe"
INTERNAL_DIR = "_internal"


class UninstallerBundleError(RuntimeError):
    """Raised when the persistent uninstaller cannot be safely published."""


def validate_uninstaller_bundle(root: Path) -> None:
    exe = root / INSTALLER_EXE
    internal = root / INTERNAL_DIR
    if not exe.is_file():
        raise UninstallerBundleError(f"Uninstaller executable is missing: {exe}")
    if not internal.is_dir():
        raise UninstallerBundleError(f"Uninstaller _internal directory is missing: {internal}")
    if not any(path.is_file() for path in internal.rglob("*")):
        raise UninstallerBundleError(f"Uninstaller _internal directory is empty: {internal}")


def resolve_uninstaller_bundle(
    *,
    frozen: bool,
    executable: Path,
    app_dir: Path,
) -> Path:
    root = executable.parent if frozen else app_dir / "dist" / "MicroClawInstaller"
    validate_uninstaller_bundle(root)
    return root


def bundle_manifest(root: Path) -> dict[str, int]:
    validate_uninstaller_bundle(root)
    files = [root / INSTALLER_EXE]
    files.extend(path for path in (root / INTERNAL_DIR).rglob("*") if path.is_file())
    return {
        path.relative_to(root).as_posix(): path.stat().st_size
        for path in sorted(files)
    }
```

- [ ] **Step 4: Run resolver tests and confirm they pass**

Run:

```powershell
python -m unittest tests.test_uninstaller_bundle -v
```

Expected: 4 tests PASS.

- [ ] **Step 5: Write failing publication and restoration tests**

Append these tests to `UninstallerBundleTests`:

```python
    def test_publishes_verified_bundle_and_runs_startup_check(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"
        checked = []

        published = publish_uninstaller_bundle(source, state, checked.append)

        self.assertEqual(published, state / "MicroClawInstaller.exe")
        self.assertEqual(bundle_manifest(state), bundle_manifest(source))
        self.assertEqual(checked, [state / "MicroClawInstaller.exe"])
        self.assertFalse(any(path.name.startswith(".microclaw-uninstaller-") for path in state.iterdir()))

    def test_manifest_mismatch_does_not_replace_existing_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        original = bundle_manifest(state)
        real_copytree = __import__("shutil").copytree

        def incomplete_copytree(src, dst):
            copied = real_copytree(src, dst)
            (copied / "deployer.pyc").unlink()
            return copied

        with (
            unittest.mock.patch(
                "deployer.uninstaller_bundle.shutil.copytree",
                side_effect=incomplete_copytree,
            ),
            self.assertRaisesRegex(UninstallerBundleError, "manifest"),
        ):
            publish_uninstaller_bundle(source, state, lambda _exe: None)

        self.assertEqual(bundle_manifest(state), original)

    def test_failed_startup_check_restores_existing_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")

        def fail_check(_exe):
            raise UninstallerBundleError("startup check failed")

        with self.assertRaisesRegex(UninstallerBundleError, "startup check failed"):
            publish_uninstaller_bundle(source, state, fail_check)

        self.assertEqual(
            (state / "MicroClawInstaller.exe").read_text(encoding="utf-8"),
            "old",
        )
        self.assertEqual(
            (state / "_internal" / "python.dll").read_text(encoding="utf-8"),
            "old-runtime",
        )

    def test_fresh_install_failure_removes_partial_bundle(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"

        with self.assertRaisesRegex(UninstallerBundleError, "check"):
            publish_uninstaller_bundle(
                source,
                state,
                lambda _exe: (_ for _ in ()).throw(UninstallerBundleError("check failed")),
            )

        self.assertFalse((state / "MicroClawInstaller.exe").exists())
        self.assertFalse((state / "_internal").exists())
```

- [ ] **Step 6: Run publication tests and confirm the undefined-function failure**

Run:

```powershell
python -m unittest tests.test_uninstaller_bundle -v
```

Expected: FAIL because `publish_uninstaller_bundle` is not defined.

- [ ] **Step 7: Implement staged publication and restoration**

Add this implementation to `deployer\uninstaller_bundle.py`:

```python
def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _restore_previous_bundle(
    *,
    final_exe: Path,
    final_internal: Path,
    backup_exe: Path,
    backup_internal: Path,
    moved_exe: bool,
    moved_internal: bool,
    published_exe: bool,
    published_internal: bool,
) -> None:
    errors = []
    for path, published in (
        (final_exe, published_exe),
        (final_internal, published_internal),
    ):
        if not published:
            continue
        try:
            _remove_path(path)
        except OSError as error:
            errors.append(f"remove {path}: {error}")
    for backup_path, final_path, moved in (
        (backup_exe, final_exe, moved_exe),
        (backup_internal, final_internal, moved_internal),
    ):
        if not moved:
            continue
        try:
            os.replace(backup_path, final_path)
        except OSError as error:
            errors.append(f"restore {final_path}: {error}")
    if errors:
        raise UninstallerBundleError("; ".join(errors))


def publish_uninstaller_bundle(
    source: Path,
    destination: Path,
    startup_check: Callable[[Path], None],
) -> Path:
    source = source.resolve()
    destination = destination.resolve()
    validate_uninstaller_bundle(source)
    if source == destination:
        raise UninstallerBundleError("Uninstaller source and destination must differ")

    destination.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".microclaw-uninstaller-", dir=destination))
    staged = work / "staged"
    backup = work / "backup"
    staged.mkdir()
    backup.mkdir()

    final_exe = destination / INSTALLER_EXE
    final_internal = destination / INTERNAL_DIR
    backup_exe = backup / INSTALLER_EXE
    backup_internal = backup / INTERNAL_DIR
    moved_exe = False
    moved_internal = False
    published_exe = False
    published_internal = False
    preserve_work = False

    try:
        shutil.copy2(source / INSTALLER_EXE, staged / INSTALLER_EXE)
        shutil.copytree(source / INTERNAL_DIR, staged / INTERNAL_DIR)
        if bundle_manifest(staged) != bundle_manifest(source):
            raise UninstallerBundleError("Staged uninstaller manifest does not match source")

        try:
            if final_exe.exists():
                os.replace(final_exe, backup_exe)
                moved_exe = True
            if final_internal.exists():
                os.replace(final_internal, backup_internal)
                moved_internal = True
            os.replace(staged / INSTALLER_EXE, final_exe)
            published_exe = True
            os.replace(staged / INTERNAL_DIR, final_internal)
            published_internal = True
            startup_check(final_exe)
        except Exception as publication_error:
            try:
                _restore_previous_bundle(
                    final_exe=final_exe,
                    final_internal=final_internal,
                    backup_exe=backup_exe,
                    backup_internal=backup_internal,
                    moved_exe=moved_exe,
                    moved_internal=moved_internal,
                    published_exe=published_exe,
                    published_internal=published_internal,
                )
            except Exception as restoration_error:
                preserve_work = True
                raise UninstallerBundleError(
                    f"Uninstaller publication failed: {publication_error}; "
                    f"restoration failed: {restoration_error}; "
                    f"recovery files retained at {work}"
                ) from restoration_error
            if isinstance(publication_error, UninstallerBundleError):
                raise publication_error
            raise UninstallerBundleError(
                f"Uninstaller publication failed: {publication_error}"
            ) from publication_error
        return final_exe
    except UninstallerBundleError:
        raise
    except Exception as error:
        raise UninstallerBundleError(f"Could not publish uninstaller bundle: {error}") from error
    finally:
        if not preserve_work:
            shutil.rmtree(work)
```

- [ ] **Step 8: Run all bundle tests**

Run:

```powershell
python -m unittest tests.test_uninstaller_bundle -v
```

Expected: 8 tests PASS.

- [ ] **Step 9: Commit the pure bundle component**

```powershell
git add -- deployer\uninstaller_bundle.py tests\test_uninstaller_bundle.py
git commit -m "Add durable uninstaller bundle publication" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Installer Integration and Runtime Check

**Files:**
- Modify: `deployer\windows_setup.py:7-42,3670-3766`
- Modify: `deploy.py:1396-1415`
- Modify: `tests\test_windows_setup_upgrade.py`
- Modify: `tests\test_webview_bridge.py`

- [ ] **Step 1: Write failing `WindowsSetup` integration tests**

Add these imports to `tests\test_windows_setup_upgrade.py`:

```python
from deployer.uninstaller_bundle import UninstallerBundleError
```

Add these tests to `WindowsSetupUpgradeTests`:

```python
    def test_install_uninstaller_bundle_publishes_source_and_checks_persisted_exe(self):
        source = self.root / "dist" / "MicroClawInstaller"
        destination = self.home / ".openclaw"
        persisted = destination / "MicroClawInstaller.exe"
        self.ws._check_persisted_uninstaller = unittest.mock.Mock()

        with (
            unittest.mock.patch(
                "deployer.windows_setup.resolve_uninstaller_bundle",
                return_value=source,
            ) as resolve,
            unittest.mock.patch(
                "deployer.windows_setup.publish_uninstaller_bundle",
                return_value=persisted,
            ) as publish,
        ):
            self.assertTrue(self.ws.install_uninstaller_bundle())

        resolve.assert_called_once()
        publish.assert_called_once_with(
            source,
            destination,
            self.ws._check_persisted_uninstaller,
        )

    def test_install_uninstaller_bundle_reports_failure(self):
        with unittest.mock.patch(
            "deployer.windows_setup.resolve_uninstaller_bundle",
            side_effect=UninstallerBundleError("build installer first"),
        ):
            self.assertFalse(self.ws.install_uninstaller_bundle())

    def test_persisted_uninstaller_check_rejects_nonzero_exit(self):
        exe = self.root / "MicroClawInstaller.exe"
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=3, stdout="", stderr="runtime failed")
        )

        with self.assertRaisesRegex(UninstallerBundleError, "runtime failed"):
            self.ws._check_persisted_uninstaller(exe)

        self.ws._run.assert_called_once_with(
            [str(exe), "--check-uninstaller"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
```

- [ ] **Step 2: Write a failing no-side-effect argument-routing test**

Update the import in `tests\test_webview_bridge.py`:

```python
from deploy import DeployerApp, main
```

Add:

```python
    def test_uninstaller_check_exits_without_ui_or_elevation(self):
        with (
            unittest.mock.patch("deploy._setup_windows_taskbar") as taskbar,
            unittest.mock.patch("deploy._ensure_admin") as elevate,
            unittest.mock.patch("deploy._run_installer") as run_installer,
        ):
            self.assertEqual(main(["--check-uninstaller"]), 0)

        taskbar.assert_not_called()
        elevate.assert_not_called()
        run_installer.assert_not_called()
```

- [ ] **Step 3: Run the focused tests and confirm missing-method failures**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_install_uninstaller_bundle_publishes_source_and_checks_persisted_exe tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_install_uninstaller_bundle_reports_failure tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_persisted_uninstaller_check_rejects_nonzero_exit tests.test_webview_bridge.WebInstallerBridgeTests.test_uninstaller_check_exits_without_ui_or_elevation -v
```

Expected: FAIL because `install_uninstaller_bundle`,
`_check_persisted_uninstaller`, and `main` do not exist.

- [ ] **Step 4: Integrate bundle publication into `WindowsSetup`**

Add imports to `deployer\windows_setup.py`:

```python
import sys

from deployer.uninstaller_bundle import (
    UninstallerBundleError,
    publish_uninstaller_bundle,
    resolve_uninstaller_bundle,
)
```

Add these methods immediately before `create_desktop_shortcut()`:

```python
    def install_uninstaller_bundle(self) -> bool:
        """Persist a verified uninstaller before exposing Windows entry points."""
        try:
            app_dir = Path(__file__).resolve().parent.parent
            source = resolve_uninstaller_bundle(
                frozen=getattr(sys, "frozen", False),
                executable=Path(sys.executable),
                app_dir=app_dir,
            )
            destination = Path.home() / ".openclaw"
            persisted = publish_uninstaller_bundle(
                source,
                destination,
                self._check_persisted_uninstaller,
            )
            self.log.success(f"卸载程序已安装: {persisted}")
            return True
        except UninstallerBundleError as error:
            self.log.error(f"安装卸载程序失败: {error}")
            return False

    def _check_persisted_uninstaller(self, executable: Path) -> None:
        try:
            result = self._run(
                [str(executable), "--check-uninstaller"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
        except subprocess.TimeoutExpired as error:
            raise UninstallerBundleError(
                "Persisted uninstaller startup check timed out"
            ) from error
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown runtime error").strip()
            raise UninstallerBundleError(
                f"Persisted uninstaller startup check failed ({result.returncode}): {detail}"
            )
```

- [ ] **Step 5: Add a side-effect-free deploy entry point**

Replace the bottom-level argument handling in `deploy.py` with:

```python
def _check_uninstaller_runtime() -> int:
    return 0 if callable(getattr(DeployerApp, "_uninstall_thread", None)) else 2


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--check-uninstaller" in args:
        return _check_uninstaller_runtime()

    _setup_windows_taskbar()
    auto_uninstall = "--uninstall" in args
    use_legacy_ui = "--legacy-ui" in args or os.environ.get("LEGACY_INSTALL_UI", "") == "1"
    if auto_uninstall:
        _ensure_admin()
    _run_installer(auto_uninstall=auto_uninstall, use_legacy_ui=use_legacy_ui)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

This check occurs after Python imports have loaded the packaged runtime but
before taskbar setup, elevation, or UI construction.

- [ ] **Step 6: Run the focused integration tests**

Run the command from Step 3 again.

Expected: 4 tests PASS.

- [ ] **Step 7: Commit installer integration**

```powershell
git add -- deployer\windows_setup.py deploy.py tests\test_windows_setup_upgrade.py tests\test_webview_bridge.py
git commit -m "Persist and check the installed uninstaller" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Strict Shortcut and Registry Entry Points

**Files:**
- Modify: `deployer\windows_setup.py:3670-3766,3962-4030`
- Modify: `tests\test_windows_setup_upgrade.py:1471-1530`

- [ ] **Step 1: Write failing tests for missing bundles and failure propagation**

Add:

```python
    def _write_persisted_uninstaller(self):
        state = self.home / ".openclaw"
        state.mkdir(parents=True, exist_ok=True)
        (state / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")
        (state / "_internal").mkdir()
        (state / "_internal" / "runtime.dll").write_text("runtime", encoding="utf-8")
        return state / "MicroClawInstaller.exe"

    def test_register_installed_app_refuses_missing_uninstaller(self):
        fake_winreg = unittest.mock.MagicMock()
        with unittest.mock.patch.dict("sys.modules", {"winreg": fake_winreg}):
            self.assertFalse(self.ws._register_installed_app(None))
        fake_winreg.CreateKeyEx.assert_not_called()

    def test_uninstall_shortcut_refuses_missing_uninstaller(self):
        desktop = self.root / "Desktop"
        desktop.mkdir()
        self.ws._run = unittest.mock.Mock()
        self.assertFalse(self.ws._create_uninstall_shortcut(desktop))
        self.ws._run.assert_not_called()

    def test_create_desktop_shortcut_propagates_uninstall_shortcut_failure(self):
        desktop_exe = self.root / ".microclaw" / "MicroClawDesktop.exe"
        self.ws._get_desktop_path = unittest.mock.Mock(return_value=self.root / "Desktop")
        self.ws._find_desktop_exe = unittest.mock.Mock(return_value=desktop_exe)
        self.ws._create_lnk_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_start_menu_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_uninstall_shortcut = unittest.mock.Mock(return_value=False)
        self.ws._register_installed_app = unittest.mock.Mock(return_value=True)

        self.assertFalse(self.ws.create_desktop_shortcut())
```

Update `test_register_installed_app_writes_hkcu_uninstall_key` to call
`self._write_persisted_uninstaller()` before invoking the registry helper, and
assert the exact command:

```python
        persisted = self._write_persisted_uninstaller()
        self.assertEqual(
            values["UninstallString"],
            f'"{persisted}" --uninstall',
        )
```

- [ ] **Step 2: Run the focused shortcut tests and confirm failures**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_register_installed_app_refuses_missing_uninstaller tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_uninstall_shortcut_refuses_missing_uninstaller tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_create_desktop_shortcut_propagates_uninstall_shortcut_failure tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_register_installed_app_writes_hkcu_uninstall_key -v
```

Expected: at least the first three tests FAIL against the permissive current
behavior.

- [ ] **Step 3: Remove persistence from shortcut creation**

Replace the copy and source-mode branches at the start of
`_create_uninstall_shortcut()` with strict validation:

```python
        openclaw_dir = Path.home() / ".openclaw"
        installer_dest = openclaw_dir / "MicroClawInstaller.exe"
        try:
            validate_uninstaller_bundle(openclaw_dir)
        except UninstallerBundleError as error:
            self.log.error(f"无法创建卸载快捷方式: {error}")
            return False
```

Import `validate_uninstaller_bundle` from
`deployer.uninstaller_bundle`. Delete the `sys.frozen`, `copy2`, and `copytree`
logic from this method.

- [ ] **Step 4: Make registry registration require the persistent bundle**

At the start of `_register_installed_app()` use:

```python
        openclaw_dir = Path.home() / ".openclaw"
        installer_dest = openclaw_dir / "MicroClawInstaller.exe"
        try:
            validate_uninstaller_bundle(openclaw_dir)
        except UninstallerBundleError as error:
            self.log.error(f"无法注册“已安装的应用”: {error}")
            return False
        uninstall_exe = installer_dest
```

Remove the transient `sys.executable` fallback.

- [ ] **Step 5: Propagate all required entry-point failures**

Refactor `create_desktop_shortcut()` so every required operation contributes to
the return value:

```python
    def create_desktop_shortcut(self) -> bool:
        """Create application and uninstall entry points."""
        self.log.step("Creating desktop shortcut…")
        desktop = self._get_desktop_path()
        desktop_exe = self._find_desktop_exe()

        if desktop_exe:
            desktop_ok = self._create_lnk_shortcut(desktop, desktop_exe)
            start_menu_ok = self._create_start_menu_shortcut(desktop_exe)
        else:
            self.log.info("桌面客户端未安装，创建浏览器快捷方式作为备选")
            desktop_ok = self._create_url_shortcut(desktop)
            start_menu_ok = True

        uninstall_ok = self._create_uninstall_shortcut(desktop)
        registry_ok = self._register_installed_app(desktop_exe)
        return desktop_ok and start_menu_ok and uninstall_ok and registry_ok
```

Replace the exception branch in `_create_url_shortcut()` with:

```python
        except Exception as error:
            self.log.warn(f"Could not create desktop shortcut: {error}")
            return False
```

- [ ] **Step 6: Run shortcut and registry tests**

Run the command from Step 2 again.

Expected: 4 tests PASS.

- [ ] **Step 7: Run the complete Windows setup test module**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade -v
```

Expected: all tests PASS.

- [ ] **Step 8: Commit strict entry-point behavior**

```powershell
git add -- deployer\windows_setup.py tests\test_windows_setup_upgrade.py
git commit -m "Require a valid uninstaller for Windows entry points" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Wire Both Installer Pipelines

**Files:**
- Modify: `deploy.py:890-916`
- Modify: `deployer\webview_bridge.py:365-400`
- Modify: `tests\test_webview_bridge.py`

- [ ] **Step 1: Write failing install-step order tests**

Add a helper to `tests\test_webview_bridge.py`:

```python
    @staticmethod
    def _step_labels(steps):
        return [step[1] for step in steps]
```

Add:

```python
    def test_legacy_pipeline_installs_uninstaller_before_shortcuts(self):
        app = object.__new__(DeployerApp)
        app._prepare_upgrade = unittest.mock.Mock()
        app._ensure_node = unittest.mock.Mock()
        app._ensure_openclaw = unittest.mock.Mock()
        app._copy_bundled_assets = unittest.mock.Mock()
        app._write_env_file = unittest.mock.Mock()
        setup = unittest.mock.Mock()

        labels = self._step_labels(app._build_install_steps(setup))

        self.assertLess(
            labels.index("Installing uninstaller..."),
            labels.index("Creating desktop shortcut..."),
        )
        self.assertEqual(
            app._build_install_steps(setup)[labels.index("Installing uninstaller...")][2],
            setup.install_uninstaller_bundle,
        )

    def test_web_pipeline_installs_uninstaller_before_shortcuts(self):
        setup = unittest.mock.Mock()

        steps = self.bridge._build_install_steps(setup)
        labels = self._step_labels(steps)

        self.assertLess(
            labels.index("Installing uninstaller..."),
            labels.index("Creating desktop shortcut..."),
        )
        uninstaller_step = steps[labels.index("Installing uninstaller...")]
        self.assertEqual(uninstaller_step[2], setup.install_uninstaller_bundle)
        self.assertEqual(uninstaller_step[3], 1)
```

- [ ] **Step 2: Run pipeline tests and confirm missing-builder failures**

Run:

```powershell
python -m unittest tests.test_webview_bridge.WebInstallerBridgeTests.test_legacy_pipeline_installs_uninstaller_before_shortcuts tests.test_webview_bridge.WebInstallerBridgeTests.test_web_pipeline_installs_uninstaller_before_shortcuts -v
```

Expected: FAIL because `_build_install_steps` does not exist on either class.

- [ ] **Step 3: Extract and update the legacy install-step builder**

Move the list currently local to `DeployerApp._install_thread()` into:

```python
    def _build_install_steps(self, ws):
        return [
            (3, "Configuring PowerShell execution policy...", ws.ensure_execution_policy),
            (6, "Adding Defender exclusions...", ws.ensure_defender_exclusions),
            (10, "Installing Git...", ws.ensure_git),
            (18, "Preparing OpenClaw upgrade...", lambda: self._prepare_upgrade(ws)),
            (25, "Installing Node.js...", lambda: self._ensure_node(ws)),
            (35, "Configuring npm registry...", ws.setup_npm_mirror),
            (50, "Installing OpenClaw gateway...", lambda: self._ensure_openclaw(ws)),
            (55, "Updating PATH...", ws.add_to_path),
            (60, "Installing desktop client...", ws.install_desktop_client),
            (62, "Copying bundled assets...", lambda: self._copy_bundled_assets(ws)),
            (65, "Writing API keys...", self._write_env_file),
            (70, "Writing OpenClaw configuration...", ws.write_config),
            (85, "Provisioning AppContainer sandbox...", ws.provision_appcontainer),
            (90, "Installing WeChat plugin...", ws.install_weixin_plugin),
            (94, "Validating OpenClaw upgrade...", ws.verify_openclaw_upgrade),
            (95, "Installing uninstaller...", ws.install_uninstaller_bundle),
            (97, "Creating desktop shortcut...", ws.create_desktop_shortcut),
            (98, "Committing OpenClaw upgrade...", ws.commit_openclaw_upgrade),
        ]
```

Set `steps = self._build_install_steps(ws)` in `_install_thread()`.

- [ ] **Step 4: Extract and update the web install-step builder**

Move the existing web list into this complete builder:

```python
    def _build_install_steps(self, ws):
        return [
            (
                3,
                "Configuring PowerShell execution policy...",
                ws.ensure_execution_policy,
                LOCAL_RETRIES,
            ),
            (6, "Adding Defender exclusions...", ws.ensure_defender_exclusions, LOCAL_RETRIES),
            (10, "Installing Git...", ws.ensure_git, NETWORK_RETRIES),
            (18, "Preparing OpenClaw upgrade...", lambda: self._prepare_upgrade(ws), 0),
            (25, "Installing Node.js...", lambda: self._ensure_node(ws), NETWORK_RETRIES),
            (35, "Configuring npm registry...", ws.setup_npm_mirror, NETWORK_RETRIES),
            (
                50,
                "Installing OpenClaw gateway...",
                lambda: self._ensure_openclaw(ws),
                NETWORK_RETRIES,
            ),
            (55, "Updating PATH...", ws.add_to_path, LOCAL_RETRIES),
            (60, "Installing desktop client...", ws.install_desktop_client, NETWORK_RETRIES),
            (
                62,
                "Copying bundled assets...",
                self._copy_bundled_assets,
                LOCAL_RETRIES,
            ),
            (65, "Writing API keys...", self._write_env_file, LOCAL_RETRIES),
            (70, "Writing OpenClaw configuration...", ws.write_config, LOCAL_RETRIES),
            (75, "Warming up V8 compile cache...", ws.warmup_compile_cache, LOCAL_RETRIES),
            (85, "Provisioning AppContainer sandbox...", ws.provision_appcontainer, LOCAL_RETRIES),
            (90, "Installing WeChat plugin...", ws.install_weixin_plugin, NETWORK_RETRIES),
            (94, "Validating OpenClaw upgrade...", ws.verify_openclaw_upgrade, LOCAL_RETRIES),
            (95, "Installing uninstaller...", ws.install_uninstaller_bundle, LOCAL_RETRIES),
            (97, "Creating desktop shortcut...", ws.create_desktop_shortcut, LOCAL_RETRIES),
            (98, "Committing OpenClaw upgrade...", ws.commit_openclaw_upgrade, LOCAL_RETRIES),
        ]
```

Set `steps = self._build_install_steps(ws)` in `_install_thread()`.

- [ ] **Step 5: Run pipeline tests**

Run the command from Step 2 again.

Expected: 2 tests PASS.

- [ ] **Step 6: Run all installer-focused tests**

Run:

```powershell
python -m unittest tests.test_uninstaller_bundle tests.test_windows_setup_upgrade tests.test_webview_bridge -v
```

Expected: all tests PASS.

- [ ] **Step 7: Commit pipeline wiring**

```powershell
git add -- deploy.py deployer\webview_bridge.py tests\test_webview_bridge.py
git commit -m "Require uninstaller publication in install pipelines" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Packaged Runtime and Full Build Verification

**Files:**
- Modify only if validation reveals a defect directly caused by Tasks 1-4.

- [ ] **Step 1: Run Python formatting and lint checks already used by the repository**

Run:

```powershell
ruff check deploy.py deployer\uninstaller_bundle.py deployer\windows_setup.py deployer\webview_bridge.py tests\test_uninstaller_bundle.py tests\test_windows_setup_upgrade.py tests\test_webview_bridge.py
ruff format --check deploy.py deployer\uninstaller_bundle.py deployer\windows_setup.py deployer\webview_bridge.py tests\test_uninstaller_bundle.py tests\test_windows_setup_upgrade.py tests\test_webview_bridge.py
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete Python test suite**

Run:

```powershell
python -m unittest discover -s tests -v
```

Expected: all tests PASS.

- [ ] **Step 3: Run the full project build**

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Expected: exit 0 with these artifacts:

- `dist\microclaw-portable.zip`
- `dist\MicroClawInstaller\MicroClawInstaller.exe`
- `dist\MicroClawInstaller\_internal`
- `dist\MicroClawInstaller.zip`
- `dist\MicroClawSetup.exe`

- [ ] **Step 4: Exercise the packaged no-side-effect startup check**

Run:

```powershell
& .\dist\MicroClawInstaller\MicroClawInstaller.exe --check-uninstaller
if ($LASTEXITCODE -ne 0) { throw "Packaged uninstaller startup check failed" }
```

Expected: no window opens, no elevation prompt appears, no installation state
changes, and the process exits 0.

- [ ] **Step 5: Exercise source-mode resolution without changing the live installation**

Run only the resolver against the built directory:

```powershell
@'
from pathlib import Path
import sys
from deployer.uninstaller_bundle import resolve_uninstaller_bundle

resolved = resolve_uninstaller_bundle(
    frozen=False,
    executable=Path(sys.executable),
    app_dir=Path.cwd(),
)
assert resolved == Path.cwd() / "dist" / "MicroClawInstaller"
print(resolved)
'@ | python -
```

Expected: prints the repository's
`dist\MicroClawInstaller` absolute path and exits 0.

- [ ] **Step 6: Check the final change set**

Run:

```powershell
git diff --check
git --no-pager status --short
git --no-pager log -5 --oneline
```

Expected: `git diff --check` exits 0; only pre-existing unrelated work remains
uncommitted; the uninstaller implementation is represented by the task
commits.
