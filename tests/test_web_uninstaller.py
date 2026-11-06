import unittest
import unittest.mock
from pathlib import Path

from deployer.webview_bridge import WebUninstallBridge


class WebUninstallerTests(unittest.TestCase):
    def setUp(self):
        self.bridge = WebUninstallBridge(logger=unittest.mock.Mock(), lang="en")
        self.window = unittest.mock.Mock()
        self.bridge.attach_window(self.window)

    def test_cancel_before_confirmation_does_not_uninstall(self):
        with (
            unittest.mock.patch("deployer.webview_bridge.WindowsSetup") as setup,
            unittest.mock.patch("deployer.webview_bridge.threading.Thread") as thread,
        ):
            self.assertTrue(self.bridge.cancel())

        self.window.destroy.assert_called_once_with()
        setup.assert_not_called()
        thread.assert_not_called()
        self.assertEqual(self.bridge.get_state()["status"], "idle")

    def test_confirmation_starts_cleanup_once_without_closing_webview(self):
        with unittest.mock.patch("deployer.webview_bridge.threading.Thread") as thread:
            self.assertTrue(self.bridge.confirm())
            self.assertFalse(self.bridge.confirm())

        thread.assert_called_once_with(target=self.bridge._uninstall_thread, daemon=True)
        thread.return_value.start.assert_called_once_with()
        self.assertEqual(self.bridge.get_state()["status"], "running")
        self.window.destroy.assert_not_called()

    def test_running_uninstall_cannot_be_closed(self):
        with unittest.mock.patch("deployer.webview_bridge.threading.Thread"):
            self.bridge.confirm()

        self.assertFalse(self.bridge.can_close())
        self.assertFalse(self.bridge.cancel())
        self.window.destroy.assert_not_called()

    def test_cleanup_keeps_all_original_steps_in_order(self):
        setup = unittest.mock.Mock()
        with unittest.mock.patch("deployer.webview_bridge.WindowsSetup", return_value=setup):
            self.bridge._uninstall_thread()

        self.assertEqual(
            setup.method_calls,
            [
                unittest.mock.call._uninstall_stop_daemon(),
                unittest.mock.call._uninstall_stop_gateway(),
                unittest.mock.call._uninstall_kill_desktop(),
                unittest.mock.call._uninstall_plugins(),
                unittest.mock.call._uninstall_clean_official(),
                unittest.mock.call._uninstall_clean_desktop(),
                unittest.mock.call._uninstall_npm(),
                unittest.mock.call._uninstall_clean_node(),
                unittest.mock.call._uninstall_clean_git(),
                unittest.mock.call._uninstall_clean_openclaw_state(),
                unittest.mock.call._uninstall_clean_shortcuts(),
            ],
        )
        self.assertEqual(self.bridge.get_state()["status"], "success")
        self.assertEqual(self.bridge.get_state()["progress"], 100)
        self.assertFalse(self.bridge.get_state()["running"])
        self.assertTrue(self.bridge.cancel())
        self.window.destroy.assert_called_once_with()
        with unittest.mock.patch("deployer.webview_bridge.threading.Thread") as thread:
            self.assertFalse(self.bridge.confirm())
        thread.assert_not_called()

    def test_step_failures_are_reported_after_remaining_cleanup(self):
        for error in (None, PermissionError("access denied")):
            with self.subTest(error=error):
                setup = unittest.mock.Mock()
                setup._uninstall_npm.return_value = False
                setup._uninstall_npm.side_effect = error
                with unittest.mock.patch(
                    "deployer.webview_bridge.WindowsSetup", return_value=setup
                ):
                    self.bridge._uninstall_thread()

                setup._uninstall_clean_shortcuts.assert_called_once_with()
                self.assertEqual(self.bridge.get_state()["status"], "failed")
                self.assertIn("Removing OpenClaw Gateway...", self.bridge.get_state()["error"])
                self.assertFalse(self.bridge.get_state()["running"])
                self.assertTrue(self.bridge.can_close())

    def test_setup_failure_does_not_leave_uninstaller_running(self):
        self.bridge._state["running"] = True
        with unittest.mock.patch(
            "deployer.webview_bridge.WindowsSetup", side_effect=RuntimeError("setup failed")
        ):
            self.bridge._uninstall_thread()

        self.assertEqual(self.bridge.get_state()["status"], "failed")
        self.assertEqual(self.bridge.get_state()["error"], "setup failed")
        self.assertTrue(self.bridge.can_close())

    def test_bilingual_bootstrap_and_template_support_progress(self):
        for language in ("zh", "en"):
            bridge = WebUninstallBridge(logger=unittest.mock.Mock(), lang=language)
            strings = bridge.get_bootstrap()["strings"]
            self.assertEqual(len(strings["steps"]), 11)
            for key in ("progressTitle", "successTitle", "successMessage", "failedTitle", "close"):
                self.assertTrue(strings[key])

        template = (
            Path(__file__).parents[1] / "deployer" / "assets" / "uninstall_template.html"
        ).read_text(encoding="utf-8")
        self.assertIn('id="progress"', template)
        self.assertIn("api.get_state()", template)
        self.assertIn("close.disabled = state.running", template)


if __name__ == "__main__":
    unittest.main()
