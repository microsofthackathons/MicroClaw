import json
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

from deploy import main
from deployer.install_timing import INSTALL_TIMING_PREFIX
from deployer.webview_bridge import (
    _STRINGS,
    InstallationCancelled,
    WebInstallerBridge,
    _center_native_window,
    _detect_lang,
    run_web_installer,
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

    def test_installer_window_titles_are_distinct_from_the_desktop(self):
        for mode, expected, background in (
            ("install", "MicroClaw Setup", "0"),
            ("install", "MicroClaw Setup", "1"),
            ("uninstall", "MicroClaw Uninstall", "0"),
            ("uninstall", "MicroClaw Uninstall", "1"),
        ):
            with self.subTest(mode=mode, background=background):
                webview = unittest.mock.MagicMock()
                bridge = unittest.mock.Mock()
                bridge.write_html_file.return_value = Path(self.temp.name) / "installer.html"
                with (
                    unittest.mock.patch.dict("os.environ", {"MICROCLAW_BACKGROUND": background}),
                    unittest.mock.patch.dict(
                        "sys.modules",
                        {
                            "clr": SimpleNamespace(),
                            "webview": webview,
                            "pythonnet": SimpleNamespace(
                                __file__=str(Path(self.temp.name) / "pythonnet" / "__init__.py")
                            ),
                        },
                    ),
                    unittest.mock.patch(
                        "deployer.webview_bridge.DeployerLogger", return_value=_Log()
                    ),
                    unittest.mock.patch(
                        "deployer.webview_bridge.WebInstallerBridge", return_value=bridge
                    ),
                    unittest.mock.patch(
                        "deployer.webview_bridge.WebUninstallBridge",
                        return_value=bridge,
                    ),
                    unittest.mock.patch(
                        "deployer.webview_bridge._get_centered_window_position",
                        return_value=(0, 0),
                    ),
                ):
                    run_web_installer(mode)
                self.assertEqual(webview.create_window.call_args.args[0], expected)
                self.assertNotEqual(expected, "MicroClaw")
                self.assertEqual(webview.create_window.call_args.kwargs["focus"], background != "1")
                self.assertFalse(webview.create_window.call_args.kwargs["easy_drag"])
                webview.start.assert_called_once()

    def test_explicit_drag_regions_exclude_interactive_controls_in_both_templates(self):
        from html.parser import HTMLParser

        class DragRegionParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.regions = []

            def handle_starttag(self, tag, attrs):
                attributes = dict(attrs)
                if "pywebview-drag-region" in attributes.get("class", "").split():
                    self.regions.append((tag, self.get_starttag_text()))

        for name in ("installer_template.html", "uninstall_template.html"):
            with self.subTest(template=name):
                markup = (Path(__file__).parents[1] / "deployer" / "assets" / name).read_text(
                    encoding="utf-8"
                )
                parser = DragRegionParser()
                parser.feed(markup)
                self.assertEqual(len(parser.regions), 1)
                self.assertEqual(parser.regions[0][0], "div")
                # The title drag surface is empty, so clicks on native form
                # controls and buttons cannot bubble through a drag ancestor.
                self.assertIn(parser.regions[0][1] + "</div>", markup)

    def test_native_centering_does_not_activate_the_window(self):
        user32 = unittest.mock.Mock()

        def get_rect(_handle, pointer):
            pointer._obj.left = 0
            pointer._obj.top = 0
            pointer._obj.right = 640
            pointer._obj.bottom = 480
            return True

        user32.GetWindowRect.side_effect = get_rect
        user32.GetMonitorInfoW.return_value = False
        user32.GetDpiForWindow.return_value = 96
        with (
            unittest.mock.patch("deployer.webview_bridge.sys.platform", "win32"),
            unittest.mock.patch("ctypes.windll", SimpleNamespace(user32=user32), create=True),
            unittest.mock.patch(
                "deployer.webview_bridge._get_centered_window_position",
                return_value=(10, 20),
            ),
        ):
            _center_native_window(123)
        user32.SetWindowPos.assert_called_once_with(123, 0, 10, 20, 0, 0, 0x0015)

    def test_prepare_upgrade_prompts_then_closes_running_gateway(self):
        gateway = ActiveGateway(pid=4321, port=18789, lock_path=Path("gateway.lock"))
        active = ActiveInstallation(pids=(1234,), gateway=gateway)
        setup = unittest.mock.Mock()
        setup.get_active_installation.return_value = active
        setup.stop_active_installation_for_upgrade.return_value = True
        setup.prepare_openclaw_update.return_value = True
        self.bridge._confirm_close_running_apps = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.bridge._prepare_upgrade(setup))

        self.bridge._confirm_close_running_apps.assert_called_once_with(active)
        setup.stop_active_installation_for_upgrade.assert_called_once_with(active)
        setup.prepare_openclaw_update.assert_called_once_with()

    def test_detect_language_uses_existing_app_preference(self):
        self.settings_path.parent.mkdir(parents=True)
        for saved, expected in (("zh-CN", "zh"), ("en-US", "en")):
            with self.subTest(saved=saved):
                self.settings_path.write_text(json.dumps({"language": saved}), encoding="utf-8")
                with unittest.mock.patch.dict("os.environ", {"MICROCLAW_LANG": ""}):
                    self.assertEqual(_detect_lang(self.settings_path), expected)

    def test_first_launch_defaults_to_chinese_without_writing_settings(self):
        with unittest.mock.patch.dict("os.environ", {"MICROCLAW_LANG": ""}):
            bridge = WebInstallerBridge(logger=_Log(), settings_path=self.settings_path)

        self.assertEqual(bridge.get_bootstrap()["lang"], "zh")
        self.assertEqual(bridge.get_bootstrap()["strings"]["quickInstall"], "快速安装")
        self.assertFalse(self.settings_path.exists())

    def test_language_override_takes_precedence_over_saved_preference(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text('{"language":"zh-CN"}', encoding="utf-8")

        with unittest.mock.patch.dict("os.environ", {"MICROCLAW_LANG": "en-US"}):
            self.assertEqual(_detect_lang(self.settings_path), "en")

    def test_invalid_saved_language_defaults_to_chinese(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text('{"language":"fr-FR"}', encoding="utf-8")

        with unittest.mock.patch.dict("os.environ", {"MICROCLAW_LANG": "unsupported"}):
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

    def test_installer_uses_localized_microclaw_eula_labels(self):
        self.assertEqual(
            _STRINGS["zh"]["serviceAgreement"],
            "MicroClaw 最终用户许可协议",
        )
        self.assertEqual(
            _STRINGS["en"]["serviceAgreement"],
            "MicroClaw End User License Agreement",
        )

    def test_welcome_keeps_short_model_neutral_legal_copy(self):
        for language in _STRINGS.values():
            with self.subTest(language=language["language"]):
                self.assertNotIn("MicroClaw", language["legalLine"])
                self.assertNotIn("llama.cpp", language["legalLine"])
                self.assertNotIn("localModelNotice", language)
                self.assertNotIn("localModelDetails", language)
                self.assertLess(
                    len(language["serviceAgreementLink"]), len(language["serviceAgreement"])
                )

    def test_welcome_template_omits_local_model_notice(self):
        template = (
            Path(__file__).parents[1] / "deployer" / "assets" / "installer_template.html"
        ).read_text(encoding="utf-8")

        self.assertNotIn("localModelNotice", template)
        self.assertNotIn("localModelSummary", template)
        self.assertNotIn("localModelDetails", template)
        self.assertNotIn("local-model-notice", template)

    def test_eula_opens_localized_website_page(self):
        with unittest.mock.patch("deployer.webview_bridge.webbrowser.open") as open_browser:
            self.assertTrue(self.bridge.open_eula())
            self.bridge.set_language("zh")
            self.assertTrue(self.bridge.open_eula())

        self.assertEqual(
            open_browser.call_args_list,
            [
                unittest.mock.call("https://microclaw.microsoft.com/eula.en.html"),
                unittest.mock.call("https://microclaw.microsoft.com/eula.html"),
            ],
        )
        self.assertEqual(
            self.bridge.get_bootstrap()["eula_urls"],
            {
                "zh": "https://microclaw.microsoft.com/eula.html",
                "en": "https://microclaw.microsoft.com/eula.en.html",
            },
        )

    def test_privacy_statement_opens_microsoft_privacy_page(self):
        expected_url = "https://www.microsoft.com/privacy/privacystatement"

        with unittest.mock.patch("deployer.webview_bridge.webbrowser.open") as open_browser:
            self.assertTrue(self.bridge.open_privacy_statement())

        open_browser.assert_called_once_with(expected_url)
        self.assertEqual(self.bridge.get_bootstrap()["privacy_statement_url"], expected_url)

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
        self.bridge._finish_ok()

        settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
        self.assertEqual(settings, {"themeMode": "dark", "language": "zh-CN"})

    def test_successful_install_does_not_launch_desktop_or_gateway(self):
        setup = unittest.mock.Mock()
        self.bridge._state["running"] = True

        with (
            unittest.mock.patch("deployer.webview_bridge.WindowsSetup", return_value=setup),
            unittest.mock.patch.object(self.bridge, "_build_install_steps", return_value=[]),
            unittest.mock.patch("subprocess.Popen") as popen,
            unittest.mock.patch("os.startfile") as startfile,
            unittest.mock.patch("deployer.webview_bridge._ACTIVE_WINDOW") as window,
        ):
            self.bridge._install_thread()

        self.assertEqual(self.bridge.get_state()["status"], "success")
        self.assertFalse(self.bridge.get_state()["running"])
        self.assertEqual(
            setup.method_calls,
            [
                unittest.mock.call.begin_openclaw_upgrade_validation(),
                unittest.mock.call.commit_openclaw_upgrade(),
            ],
        )
        popen.assert_not_called()
        startfile.assert_not_called()
        window.destroy.assert_not_called()

    def test_completion_page_launches_normal_desktop_once_and_leaves_close_to_the_ui(self):
        desktop = Path(self.temp.name) / "Desktop with spaces"
        desktop.mkdir()
        executable = desktop / "MicroClawDesktop.exe"
        executable.write_bytes(b"fixture")
        self.bridge._state["status"] = "success"
        with (
            unittest.mock.patch("deployer.webview_bridge.DEFAULT_DESKTOP_DIR", desktop),
            unittest.mock.patch("deployer.webview_bridge.subprocess.Popen") as launch,
            unittest.mock.patch("deployer.webview_bridge._ACTIVE_WINDOW") as window,
            unittest.mock.patch.dict("os.environ", {"ELECTRON_RUN_AS_NODE": "1"}),
        ):
            self.assertEqual(self.bridge.open_desktop(), {"ok": True})
            self.assertEqual(self.bridge.open_desktop(), {"ok": True})
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[0], [str(executable)])
        options = launch.call_args.kwargs
        self.assertEqual(options["cwd"], str(desktop))
        self.assertNotIn("ELECTRON_RUN_AS_NODE", options["env"])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["stdout"], subprocess.DEVNULL)
        self.assertEqual(options["stderr"], subprocess.DEVNULL)
        self.assertEqual(
            options["creationflags"],
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        window.destroy.assert_not_called()

    def test_desktop_cannot_launch_before_successful_installation(self):
        for status, running in (
            ("idle", False),
            ("running", True),
            ("failed", False),
            ("cancelled", False),
            ("success", True),
        ):
            with self.subTest(status=status), unittest.mock.patch("subprocess.Popen") as launch:
                self.bridge._state.update(status=status, running=running)
                result = self.bridge.open_desktop()
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], _STRINGS["en"]["desktopLaunchUnavailable"])
                launch.assert_not_called()

    def test_missing_desktop_preserves_success_page_and_does_not_launch_another_exe(self):
        desktop = Path(self.temp.name)
        (desktop / "unrelated.exe").write_bytes(b"fixture")
        self.bridge._state["status"] = "success"
        with (
            unittest.mock.patch("deployer.webview_bridge.DEFAULT_DESKTOP_DIR", desktop),
            unittest.mock.patch("subprocess.Popen") as launch,
            unittest.mock.patch("deployer.webview_bridge._ACTIVE_WINDOW") as window,
        ):
            result = self.bridge.open_desktop()
        self.assertEqual(result, {"ok": False, "error": _STRINGS["en"]["desktopLaunchFailed"]})
        self.assertEqual(self.bridge.get_state()["status"], "success")
        launch.assert_not_called()
        window.destroy.assert_not_called()

    def test_launch_failure_allows_retry_without_rerunning_installation(self):
        desktop = Path(self.temp.name)
        (desktop / "MicroClawDesktop.exe").write_bytes(b"fixture")
        self.bridge._state["status"] = "success"
        self.bridge.set_language("zh")
        with (
            unittest.mock.patch("deployer.webview_bridge.DEFAULT_DESKTOP_DIR", desktop),
            unittest.mock.patch(
                "subprocess.Popen", side_effect=[OSError("failed"), object()]
            ) as launch,
            unittest.mock.patch("deployer.webview_bridge._ACTIVE_WINDOW") as window,
        ):
            result = self.bridge.open_desktop()
            self.assertEqual(result, {"ok": False, "error": _STRINGS["zh"]["desktopLaunchFailed"]})
            self.assertEqual(self.bridge.open_desktop(), {"ok": True})
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(self.bridge.get_state()["status"], "success")
        window.destroy.assert_not_called()

    def test_installation_logs_distinct_steps_retries_and_final_completion(self):
        log = unittest.mock.Mock()
        self.bridge._logger = log
        self.bridge._state["running"] = True
        retry = unittest.mock.Mock(side_effect=[False, True])
        label = _STRINGS["en"]["steps"]["prepareUpgrade"]
        with (
            unittest.mock.patch("deployer.webview_bridge.WindowsSetup"),
            unittest.mock.patch.object(
                self.bridge,
                "_build_install_steps",
                return_value=[
                    (18, label, retry, 1),
                    (52, label, lambda: True, 0),
                ],
            ),
            unittest.mock.patch("deployer.webview_bridge.time.sleep"),
        ):
            self.bridge._install_thread()
        events = [
            json.loads(call.args[0][len(INSTALL_TIMING_PREFIX) :])
            for call in log.info.call_args_list
            if call.args[0].startswith(INSTALL_TIMING_PREFIX)
        ]
        self.assertIn("prepareUpgrade-18", [event["stageId"] for event in events])
        self.assertIn("prepareUpgrade-52", [event["stageId"] for event in events])
        self.assertEqual(
            [
                event["status"]
                for event in events
                if event["phase"] == "attempt"
                and event["stageId"] == "prepareUpgrade-18"
                and event["status"] != "started"
            ],
            ["failed", "success"],
        )
        self.assertTrue(any(event["phase"] == "retry-wait" for event in events))
        self.assertEqual(events[-1]["phase"], "installation-total")
        self.assertEqual(events[-1]["status"], "success")

    def test_unexpected_setup_error_preserves_failed_summary(self):
        log = unittest.mock.Mock()
        self.bridge._logger = log
        with (
            unittest.mock.patch(
                "deployer.webview_bridge.WindowsSetup", side_effect=ValueError("setup failed")
            ),
            self.assertRaisesRegex(ValueError, "setup failed"),
        ):
            self.bridge._install_thread()
        summary = json.loads(log.info.call_args.args[0][len(INSTALL_TIMING_PREFIX) :])
        self.assertEqual(summary["phase"], "installation-total")
        self.assertEqual(summary["status"], "failed")

    def test_final_step_failure_rolls_back_without_launching_desktop(self):
        for failed_step in ("begin_openclaw_upgrade_validation", "commit_openclaw_upgrade"):
            with self.subTest(failed_step=failed_step):
                setup = unittest.mock.Mock()
                getattr(setup, failed_step).return_value = False
                self.bridge._state["running"] = True

                with (
                    unittest.mock.patch("deployer.webview_bridge.WindowsSetup", return_value=setup),
                    unittest.mock.patch.object(
                        self.bridge, "_build_install_steps", return_value=[]
                    ),
                    unittest.mock.patch("deployer.webview_bridge.time.sleep"),
                    unittest.mock.patch("subprocess.Popen") as popen,
                    unittest.mock.patch("os.startfile") as startfile,
                ):
                    self.bridge._install_thread()

                self.assertEqual(self.bridge.get_state()["status"], "failed")
                self.assertFalse(self.bridge.get_state()["running"])
                setup.rollback_openclaw_upgrade.assert_called_once_with()
                if failed_step == "begin_openclaw_upgrade_validation":
                    setup.commit_openclaw_upgrade.assert_not_called()
                popen.assert_not_called()
                startfile.assert_not_called()

    def test_web_final_steps_only_validate_and_commit_installation(self):
        setup = unittest.mock.Mock()

        final_steps = self.bridge._build_final_steps(setup)

        self.assertEqual(
            final_steps,
            [
                (99, "verifyUpgrade", setup.begin_openclaw_upgrade_validation, 1),
                (100, "commitUpgrade", setup.commit_openclaw_upgrade, 1),
            ],
        )
        for strings in _STRINGS.values():
            self.assertNotIn("startService", strings["steps"])

    def test_managed_backup_runs_after_core_update_without_extra_doctor(self):
        setup = unittest.mock.Mock()
        steps = self.bridge._build_install_steps(setup)
        actions = [step[2] for step in steps]
        backup_index = actions.index(setup.prepare_openclaw_upgrade)
        self.assertEqual(steps[backup_index][0], 52)
        self.assertLess(backup_index, actions.index(setup.write_config))
        self.assertNotIn(setup.migrate_openclaw_state, actions)
        self.assertEqual(next(step[3] for step in steps if step[0] == 50), 0)

    def test_failed_install_does_not_persist_language(self):
        self.bridge.set_language("zh")

        self.bridge._finish_fail("failed")

        self.assertFalse(self.settings_path.exists())

    def test_success_does_not_replace_malformed_existing_settings(self):
        self.settings_path.parent.mkdir(parents=True)
        self.settings_path.write_text("not json", encoding="utf-8")
        self.bridge.set_language("zh")
        self.bridge._finish_ok()

        self.assertEqual(self.settings_path.read_text(encoding="utf-8"), "not json")

    def test_installer_template_exposes_language_selector(self):
        template = (
            Path(__file__).parents[1] / "deployer" / "assets" / "installer_template.html"
        ).read_text(encoding="utf-8")

        self.assertIn('id="language"', template)
        self.assertIn("api.set_language", template)
        self.assertIn('data-link="eula"', template)
        self.assertIn("api.open_eula", template)
        self.assertIn('data-link="privacy"', template)
        self.assertIn("api.open_privacy_statement", template)
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
        run_installer.assert_called_once_with(auto_uninstall=True)

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

    def test_installer_copies_setup_runtime_gate(self):
        destination = Path(self.temp.name) / "desktop"
        with (
            unittest.mock.patch("deployer.webview_bridge.DEFAULT_DESKTOP_DIR", destination),
            unittest.mock.patch("deployer.webview_bridge.shutil.copytree"),
        ):
            self.assertTrue(self.bridge._copy_bundled_assets())
        self.assertIn(
            "Test-SupportedNodeVersion",
            (destination / "node-runtime.ps1").read_text(encoding="utf-8"),
        )
        self.assertIn(
            r'. "$PSScriptRoot\node-runtime.ps1"',
            (destination / "setup-dependencies.ps1").read_text(encoding="utf-8"),
        )

    def test_installer_defers_web_search_provider_after_configuration(self):
        setup = unittest.mock.Mock()
        steps = self.bridge._build_install_steps(setup)
        labels = self._step_labels(steps)
        search_index = labels.index("Preparing background web search setup...")
        self.assertGreater(search_index, labels.index("Writing MicroClaw configuration..."))
        self.assertLess(search_index, labels.index("Installing uninstaller..."))
        self.assertEqual(steps[search_index][2], setup.defer_search_provider_plugin)

    def test_installer_defers_optional_components_and_gateway_warmup(self):
        setup = unittest.mock.Mock()
        actions = [step[2] for step in self.bridge._build_install_steps(setup)]

        self.assertNotIn(setup.warmup_compile_cache, actions)
        self.assertNotIn(setup.install_local_model_provider, actions)
        self.assertNotIn(setup.install_weixin_plugin, actions)
        for strings in _STRINGS.values():
            self.assertNotIn("compileCache", strings["steps"])
            self.assertNotIn("localProvider", strings["steps"])


if __name__ == "__main__":
    unittest.main()
