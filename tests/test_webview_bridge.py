import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deploy import DeployerApp, main
from deployer.webview_bridge import InstallationCancelled, WebInstallerBridge, _detect_lang
from deployer.windows_setup import ActiveGateway, ActiveInstallation


class _Log:
    def __getattr__(self, _name):
        return lambda _message: None


class WebInstallerBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings_path = Path(self.temp.name) / "microclaw" / "settings.json"
        self.bridge = WebInstallerBridge(
            logger=_Log(),
            lang="en",
            settings_path=self.settings_path,
        )

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _step_labels(steps):
        return [step[1] for step in steps]

    def test_prepare_upgrade_prompts_then_closes_running_gateway(self):
        gateway = ActiveGateway(pid=4321, port=18789, lock_path=Path("gateway.lock"))
        active = ActiveInstallation(pids=(1234,), gateway=gateway)
        setup = unittest.mock.Mock()
        setup.get_active_installation.return_value = active
        setup.stop_active_installation_for_upgrade.return_value = True
        setup.prepare_openclaw_upgrade.return_value = True
        self.bridge._confirm_close_running_apps = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.bridge._prepare_upgrade(setup))

        self.bridge._confirm_close_running_apps.assert_called_once_with(active)
        setup.stop_active_installation_for_upgrade.assert_called_once_with(active)
        setup.prepare_openclaw_upgrade.assert_called_once_with()

    def test_detect_language_uses_existing_app_preference(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text('{"language":"zh-CN"}', encoding="utf-8")

        with unittest.mock.patch.dict("os.environ", {"MICROCLAW_LANG": ""}):
            self.assertEqual(_detect_lang(self.settings_path), "zh")

    def test_language_switch_updates_current_progress_text(self):
        self.bridge._set_progress(10, "Installing Git...", "git")

        localized = self.bridge.set_language("zh-CN")

        self.assertEqual(localized["lang"], "zh")
        self.assertEqual(self.bridge.get_state()["progress_text"], "正在安装 Git…")

    def test_success_persists_language_without_replacing_other_settings(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text('{"themeMode":"dark"}', encoding="utf-8")
        self.bridge.set_language("zh")
        self.bridge._launch_desktop = unittest.mock.Mock()

        self.bridge._finish_ok()

        settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
        self.assertEqual(settings, {"themeMode": "dark", "language": "zh-CN"})

    def test_failed_install_does_not_persist_language(self):
        self.bridge.set_language("zh")

        self.bridge._finish_fail("failed")

        self.assertFalse(self.settings_path.exists())

    def test_success_does_not_replace_malformed_existing_settings(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text("not json", encoding="utf-8")
        self.bridge.set_language("zh")
        self.bridge._launch_desktop = unittest.mock.Mock()

        self.bridge._finish_ok()

        self.assertEqual(self.settings_path.read_text(encoding="utf-8"), "not json")

    def test_installer_template_exposes_language_selector(self):
        template = (
            Path(__file__).parents[1] / "deployer" / "assets" / "installer_template.html"
        ).read_text(encoding="utf-8")

        self.assertIn('id="language"', template)
        self.assertIn("api.set_language", template)

    def test_prepare_upgrade_cancels_without_stopping_gateway(self):
        gateway = ActiveGateway(pid=4321, port=18789, lock_path=None)
        active = ActiveInstallation(pids=(4321,), gateway=gateway)
        setup = unittest.mock.Mock()
        setup.get_active_installation.return_value = active
        self.bridge._confirm_close_running_apps = unittest.mock.Mock(return_value=False)

        with self.assertRaises(InstallationCancelled):
            self.bridge._prepare_upgrade(setup)

        setup.stop_active_installation_for_upgrade.assert_not_called()
        setup.prepare_openclaw_upgrade.assert_not_called()

    def test_running_app_confirmation_brings_installer_to_front(self):
        active = ActiveInstallation(pids=(1234,), gateway=None)
        window = unittest.mock.Mock()
        window.create_confirmation_dialog.return_value = True

        with unittest.mock.patch("deployer.webview_bridge._ACTIVE_WINDOW", window):
            self.assertTrue(self.bridge._confirm_close_running_apps(active))

        window.restore.assert_called_once_with()
        window.show.assert_called_once_with()
        window.create_confirmation_dialog.assert_called_once()

    def test_cancelled_interactive_step_does_not_retry_or_fail(self):
        with self.bridge._state_lock:
            self.bridge._state["running"] = True
        step = unittest.mock.Mock(side_effect=InstallationCancelled)

        self.assertFalse(self.bridge._run_step_with_retry(18, "Preparing...", step, 3))

        self.assertEqual(step.call_count, 1)
        self.assertEqual(self.bridge.get_state()["status"], "cancelled")
        self.assertEqual(self.bridge.get_state()["error"], "")

    def test_legacy_installer_uses_the_same_confirmed_close_flow(self):
        active = ActiveInstallation(
            pids=(1234,),
            gateway=ActiveGateway(pid=4321, port=18789, lock_path=None),
        )
        setup = unittest.mock.Mock()
        setup.get_active_installation.return_value = active
        setup.stop_active_installation_for_upgrade.return_value = True
        setup.prepare_openclaw_upgrade.return_value = True
        app = object.__new__(DeployerApp)
        app._confirm_close_running_apps = unittest.mock.Mock(return_value=True)

        self.assertTrue(app._prepare_upgrade(setup))

        app._confirm_close_running_apps.assert_called_once_with(active)
        setup.stop_active_installation_for_upgrade.assert_called_once_with(active)
        setup.prepare_openclaw_upgrade.assert_called_once_with()

    def test_legacy_installer_does_not_close_apps_when_prompt_is_declined(self):
        active = ActiveInstallation(pids=(1234,), gateway=None)
        setup = unittest.mock.Mock()
        setup.get_active_installation.return_value = active
        app = object.__new__(DeployerApp)
        app._confirm_close_running_apps = unittest.mock.Mock(return_value=False)

        with self.assertRaises(InstallationCancelled):
            app._prepare_upgrade(setup)

        setup.stop_active_installation_for_upgrade.assert_not_called()
        setup.prepare_openclaw_upgrade.assert_not_called()

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

    def test_legacy_pipeline_installs_uninstaller_before_shortcuts(self):
        app = object.__new__(DeployerApp)
        app._prepare_upgrade = unittest.mock.Mock()
        app._ensure_node = unittest.mock.Mock()
        app._ensure_openclaw = unittest.mock.Mock()
        app._copy_bundled_assets = unittest.mock.Mock()
        app._write_env_file = unittest.mock.Mock()
        setup = unittest.mock.Mock()

        steps = app._build_install_steps(setup)
        labels = self._step_labels(steps)
        uninstaller_index = labels.index("Installing uninstaller...")

        self.assertLess(
            uninstaller_index,
            labels.index("Creating desktop shortcut..."),
        )
        self.assertEqual(
            steps[uninstaller_index][2],
            setup.install_uninstaller_bundle,
        )

    def test_web_pipeline_installs_uninstaller_before_shortcuts(self):
        setup = unittest.mock.Mock()

        steps = self.bridge._build_install_steps(setup)
        labels = self._step_labels(steps)
        uninstaller_index = labels.index("Installing uninstaller...")
        uninstaller_step = steps[uninstaller_index]

        self.assertLess(
            uninstaller_index,
            labels.index("Creating desktop shortcut..."),
        )
        self.assertEqual(uninstaller_step[2], setup.install_uninstaller_bundle)
        self.assertEqual(uninstaller_step[3], 1)

    def test_both_installers_install_web_search_provider_after_configuration(self):
        setup = unittest.mock.Mock()
        app = object.__new__(DeployerApp)
        app._prepare_upgrade = unittest.mock.Mock()
        app._ensure_node = unittest.mock.Mock()
        app._ensure_openclaw = unittest.mock.Mock()
        app._copy_bundled_assets = unittest.mock.Mock()
        app._write_env_file = unittest.mock.Mock()

        for steps in (app._build_install_steps(setup), self.bridge._build_install_steps(setup)):
            labels = self._step_labels(steps)
            search_index = labels.index("Installing web search provider...")
            self.assertGreater(search_index, labels.index("Writing OpenClaw configuration..."))
            self.assertLess(search_index, labels.index("Validating OpenClaw upgrade..."))
            self.assertEqual(steps[search_index][2], setup.install_search_provider_plugin)


if __name__ == "__main__":
    unittest.main()
