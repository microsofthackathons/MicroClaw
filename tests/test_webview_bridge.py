import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deploy import DeployerApp, _run_installer, main, select_installer_font_family
from deployer.webview_bridge import (
    _STRINGS,
    InstallationCancelled,
    WebInstallerBridge,
    _detect_lang,
)
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

    def test_visible_strings_use_microclaw_product_name(self):
        def string_values(value):
            if isinstance(value, dict):
                for child in value.values():
                    yield from string_values(child)
            elif isinstance(value, list):
                for child in value:
                    yield from string_values(child)
            elif isinstance(value, str):
                yield value

        for language in _STRINGS.values():
            self.assertNotIn("OpenClaw", "\n".join(string_values(language)))

    def test_chinese_dynamic_file_progress_is_fully_localized(self):
        self.bridge.set_language("zh")

        self.bridge._set_progress_detail("Restoring MicroClaw files (2,007/2,007 files)")
        self.assertEqual(
            self.bridge.get_state()["progress_detail"],
            "正在恢复 MicroClaw 文件（2,007/2,007 个文件）",
        )

        self.bridge._set_progress_detail("Finalizing MicroClaw file restore…")
        self.assertEqual(
            self.bridge.get_state()["progress_detail"],
            "正在完成 MicroClaw 文件恢复…",
        )

    def test_dynamic_errors_replace_internal_product_name(self):
        self.bridge._finish_fail("OpenClaw service failed")

        self.assertEqual(self.bridge.get_state()["error"], "MicroClaw service failed")

    def test_success_persists_language_without_replacing_other_settings(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text('{"themeMode":"dark"}', encoding="utf-8")
        self.bridge.set_language("zh")
        self.bridge._launch_desktop = unittest.mock.Mock()

        self.bridge._finish_ok()

        settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
        self.assertEqual(settings, {"themeMode": "dark", "language": "zh-CN"})

    def test_handoff_launches_app_and_validates_its_gateway(self):
        setup = unittest.mock.Mock()
        setup.get_openclaw_upgrade_transaction_id.return_value = "20260720T000000Z-1234abcd"
        setup.validate_running_gateway.return_value = True
        self.bridge._launch_desktop = unittest.mock.Mock(return_value=True)
        self.bridge._wait_for_desktop_service = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.bridge._start_and_validate_desktop(setup))

        self.bridge._launch_desktop.assert_called_once_with("20260720T000000Z-1234abcd")
        self.bridge._wait_for_desktop_service.assert_called_once_with(
            "20260720T000000Z-1234abcd"
        )
        setup.validate_running_gateway.assert_called_once_with()

    def test_service_handoff_is_not_retried_with_a_second_desktop(self):
        setup = unittest.mock.Mock()

        final_steps = self.bridge._build_final_steps(setup)

        retries_by_key = {progress_key: retries for _, progress_key, _, retries in final_steps}
        self.assertEqual(retries_by_key["startService"], 0)
        self.assertEqual(retries_by_key["verifyUpgrade"], 1)
        self.assertEqual(retries_by_key["commitUpgrade"], 1)

    def test_service_wait_allows_slow_gateway_cold_start(self):
        defaults = WebInstallerBridge._wait_for_desktop_service.__defaults__

        self.assertEqual(defaults, (300,))

    def test_service_wait_stops_when_launched_app_exits(self):
        process = unittest.mock.Mock(pid=4321)
        process.poll.return_value = 1
        self.bridge._launched_desktop_process = process

        self.assertFalse(self.bridge._wait_for_desktop_service("20260720T000000Z-1234abcd"))

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
        self.assertNotIn("<br><a", template)
        self.assertIn('id="progressPercent"', template)
        self.assertIn('role="progressbar"', template)
        self.assertIn('els.progressPercent.textContent = progress + "%";', template)
        self.assertNotIn('id="pathLabel">Install Path', template)
        self.assertNotIn('"Debug: "', template)

    def test_installer_uses_existing_app_font_stack(self):
        root = Path(__file__).parents[1]
        installer = (root / "deployer" / "assets" / "installer_template.html").read_text(
            encoding="utf-8"
        )
        uninstaller = (root / "deployer" / "assets" / "uninstall_template.html").read_text(
            encoding="utf-8"
        )
        app_styles = (root / "desktop" / "renderer" / "src" / "styles" / "global.css").read_text(
            encoding="utf-8"
        )
        app_fonts = (root / "desktop" / "renderer" / "src" / "web-fonts.ts").read_text(
            encoding="utf-8"
        )
        font_stack = (
            '"DM Sans", "Noto Sans SC", -apple-system, BlinkMacSystemFont, '
            '"Segoe UI", "SF Pro Display", sans-serif;'
        )

        self.assertIn(font_stack, " ".join(installer.split()))
        self.assertIn(font_stack, " ".join(uninstaller.split()))
        self.assertIn(font_stack, " ".join(app_styles.split()))
        for source in (installer, uninstaller, app_fonts):
            self.assertIn("DM+Sans:ital,opsz,wght@0,9..40,400", source)
            self.assertIn("Noto+Sans+SC:wght@400;500;600;700", source)

    def test_legacy_installer_uses_matching_bilingual_font_preferences(self):
        available = {"DM Sans", "Noto Sans SC", "Microsoft YaHei UI", "Segoe UI"}

        self.assertEqual(select_installer_font_family(available, "en"), "DM Sans")
        self.assertEqual(select_installer_font_family(available, "zh"), "Noto Sans SC")
        self.assertEqual(select_installer_font_family({"Segoe UI"}, "zh"), "Segoe UI")

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
            unittest.mock.patch("deploy._run_installer") as run_installer,
        ):
            self.assertEqual(main(["--check-uninstaller"]), 0)

        taskbar.assert_not_called()
        run_installer.assert_not_called()

    def test_installed_apps_uninstall_stays_in_current_user_context(self):
        with (
            unittest.mock.patch("deploy._setup_windows_taskbar") as taskbar,
            unittest.mock.patch("deploy._run_installer") as run_installer,
        ):
            self.assertEqual(main(["--uninstall"]), 0)

        taskbar.assert_called_once_with()
        run_installer.assert_called_once_with(auto_uninstall=True, use_legacy_ui=False)

    def test_web_uninstall_consent_starts_confirmed_progress_ui(self):
        app = unittest.mock.Mock()
        with (
            unittest.mock.patch(
                "deploy.run_web_uninstall_confirmation",
                return_value=True,
            ) as confirm,
            unittest.mock.patch("deploy.DeployerApp", return_value=app) as app_type,
        ):
            _run_installer(auto_uninstall=True, use_legacy_ui=False)

        confirm.assert_called_once_with()
        app_type.assert_called_once_with(auto_uninstall=True, uninstall_confirmed=True)
        app.mainloop.assert_called_once_with()

    def test_cancelled_web_uninstall_does_not_start_progress_ui(self):
        with (
            unittest.mock.patch(
                "deploy.run_web_uninstall_confirmation",
                return_value=False,
            ) as confirm,
            unittest.mock.patch("deploy.DeployerApp") as app_type,
        ):
            _run_installer(auto_uninstall=True, use_legacy_ui=False)

        confirm.assert_called_once_with()
        app_type.assert_not_called()

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
            self.assertGreater(search_index, labels.index("Writing MicroClaw configuration..."))
            self.assertLess(search_index, labels.index("Installing uninstaller..."))
            self.assertEqual(steps[search_index][2], setup.install_search_provider_plugin)

    def test_both_installers_exclude_wechat_installation(self):
        setup = unittest.mock.Mock()
        app = object.__new__(DeployerApp)
        app._prepare_upgrade = unittest.mock.Mock()
        app._ensure_node = unittest.mock.Mock()
        app._ensure_openclaw = unittest.mock.Mock()
        app._copy_bundled_assets = unittest.mock.Mock()
        app._write_env_file = unittest.mock.Mock()

        for steps in (app._build_install_steps(setup), self.bridge._build_install_steps(setup)):
            self.assertNotIn(setup.install_weixin_plugin, [step[2] for step in steps])


if __name__ == "__main__":
    unittest.main()
