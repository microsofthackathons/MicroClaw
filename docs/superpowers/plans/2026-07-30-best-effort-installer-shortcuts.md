# Best-Effort Installer Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Desktop and Start menu shortcut failures from rolling back an otherwise valid installation while keeping uninstaller persistence and Windows uninstall registration mandatory.

**Architecture:** Keep each existing shortcut helper responsible for its own diagnostics and Boolean result. Change only `WindowsSetup.create_desktop_shortcut()` so it attempts every shortcut but returns the uninstall registry result as the authoritative install-step outcome.

**Tech Stack:** Python 3.10+, `unittest`, Windows PowerShell shortcut integration, Windows registry.

---

## File Structure

- Modify `deployer\windows_setup.py`: aggregate shortcut and registry outcomes
  according to the new fatality boundary.
- Modify `tests\test_windows_setup_upgrade.py`: prove all shortcut failures are
  nonfatal, all helpers are attempted, and registry failure remains fatal.

### Task 1: Make Shortcut Creation Best-Effort

**Files:**
- Modify: `deployer\windows_setup.py:3722-3739`
- Test: `tests\test_windows_setup_upgrade.py:1565-1601`

- [ ] **Step 1: Replace the three fatal-shortcut tests with failing best-effort tests**

Replace
`test_create_desktop_shortcut_propagates_uninstall_shortcut_failure`,
`test_create_desktop_shortcut_propagates_start_menu_failure`, and the adjacent
registry test with:

```python
    def _configure_entry_point_mocks(self):
        desktop_exe = self.root / ".microclaw" / "MicroClawDesktop.exe"
        self.ws._get_desktop_path = unittest.mock.Mock(return_value=self.root / "Desktop")
        self.ws._find_desktop_exe = unittest.mock.Mock(return_value=desktop_exe)
        self.ws._create_lnk_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_start_menu_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_uninstall_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._register_installed_app = unittest.mock.Mock(return_value=True)

    def test_create_desktop_shortcut_treats_shortcut_failures_as_nonfatal(self):
        for helper_name in (
            "_create_lnk_shortcut",
            "_create_start_menu_shortcut",
            "_create_uninstall_shortcut",
        ):
            with self.subTest(helper=helper_name):
                self._configure_entry_point_mocks()
                getattr(self.ws, helper_name).return_value = False

                self.assertTrue(self.ws.create_desktop_shortcut())

                self.ws._create_lnk_shortcut.assert_called_once()
                self.ws._create_start_menu_shortcut.assert_called_once()
                self.ws._create_uninstall_shortcut.assert_called_once()
                self.ws._register_installed_app.assert_called_once()

    def test_create_desktop_shortcut_propagates_registry_failure(self):
        self._configure_entry_point_mocks()
        self.ws._register_installed_app.return_value = False

        self.assertFalse(self.ws.create_desktop_shortcut())

        self.ws._create_lnk_shortcut.assert_called_once()
        self.ws._create_start_menu_shortcut.assert_called_once()
        self.ws._create_uninstall_shortcut.assert_called_once()
        self.ws._register_installed_app.assert_called_once()
```

Keep `test_url_shortcut_reports_write_failure` unchanged. The helper itself
must still report its real result even though the coordinator treats that
result as nonfatal.

- [ ] **Step 2: Run the focused tests and verify the shortcut case fails**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_create_desktop_shortcut_treats_shortcut_failures_as_nonfatal tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_create_desktop_shortcut_propagates_registry_failure -v
```

Expected: the three shortcut subtests FAIL because the current coordinator
combines every Boolean result; the registry test PASSes.

- [ ] **Step 3: Return only the registry result from the coordinator**

Replace `WindowsSetup.create_desktop_shortcut()` with:

```python
    def create_desktop_shortcut(self) -> bool:
        """Create best-effort shortcuts and required uninstall registration."""
        self.log.step("Creating desktop shortcut…")

        desktop = self._get_desktop_path()
        desktop_exe = self._find_desktop_exe()

        if desktop_exe:
            self._create_lnk_shortcut(desktop, desktop_exe)
            self._create_start_menu_shortcut(desktop_exe)
        else:
            self.log.info("桌面客户端未安装，创建浏览器快捷方式作为备选")
            self._create_url_shortcut(desktop)

        self._create_uninstall_shortcut(desktop)
        return self._register_installed_app(desktop_exe)
```

Do not change `install_uninstaller_bundle()`,
`_create_uninstall_shortcut()`, or `_register_installed_app()`. Their existing
validation and logging remain intact.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_create_desktop_shortcut_treats_shortcut_failures_as_nonfatal tests.test_windows_setup_upgrade.WindowsSetupUpgradeTests.test_create_desktop_shortcut_propagates_registry_failure -v
```

Expected: 2 tests PASS, including all three shortcut-failure subtests.

- [ ] **Step 5: Run the complete Windows setup test module**

Run:

```powershell
python -m unittest tests.test_windows_setup_upgrade -v
```

Expected: all tests PASS.

- [ ] **Step 6: Run formatting and lint checks**

Run:

```powershell
ruff check deployer\windows_setup.py tests\test_windows_setup_upgrade.py
ruff format --check deployer\windows_setup.py tests\test_windows_setup_upgrade.py
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the behavior change**

```powershell
git add -- deployer\windows_setup.py tests\test_windows_setup_upgrade.py
git commit -m "Treat installer shortcuts as best effort" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Verify the Complete Installer

**Files:**
- Modify only if verification reveals a defect directly caused by Task 1.

- [ ] **Step 1: Run the complete Python test suite**

Run:

```powershell
python -m unittest discover -s tests -v
```

Expected: all tests PASS.

- [ ] **Step 2: Run the full project build**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Expected: exit 0 and produce:

- `dist\MicroClawSetup.exe`
- `dist\MicroClawInstaller.zip`
- `dist\MicroClawInstaller\MicroClawInstaller.exe`
- `dist\microclaw-portable.zip`

- [ ] **Step 3: Verify the packaged runtime check**

Run:

```powershell
& .\dist\MicroClawInstaller\MicroClawInstaller.exe --check-uninstaller
if ($LASTEXITCODE -ne 0) { throw "Packaged uninstaller startup check failed" }
```

Expected: exit 0 without opening installer UI or starting uninstall.

- [ ] **Step 4: Check the final change set**

Run:

```powershell
git diff --check
git --no-pager status --short
git --no-pager log -5 --oneline
```

Expected: `git diff --check` exits 0 and the implementation is committed.
