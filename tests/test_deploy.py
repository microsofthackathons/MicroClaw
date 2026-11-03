import io
import unittest
import unittest.mock
from pathlib import Path

from deploy import _report_startup_failure, main


class DeployerEntryTests(unittest.TestCase):
    def test_default_install_ignores_removed_legacy_environment_switch(self):
        with (
            unittest.mock.patch.dict("os.environ", {"LEGACY_INSTALL_UI": "1"}),
            unittest.mock.patch("deploy._setup_windows_taskbar"),
            unittest.mock.patch("deploy.run_web_installer") as web_installer,
        ):
            self.assertEqual(main([]), 0)

        web_installer.assert_called_once_with(mode="install")

    def test_uninstall_uses_the_same_webview_without_a_second_ui(self):
        with (
            unittest.mock.patch("deploy._setup_windows_taskbar"),
            unittest.mock.patch("deploy.run_web_installer") as web_installer,
        ):
            self.assertEqual(main(["--uninstall"]), 0)

        web_installer.assert_called_once_with(mode="uninstall")

    def test_removed_legacy_flag_is_rejected(self):
        with (
            unittest.mock.patch("sys.stderr", new_callable=io.StringIO),
            unittest.mock.patch("deploy.run_web_installer") as web_installer,
            self.assertRaises(SystemExit) as error,
        ):
            main(["--legacy-ui"])

        self.assertEqual(error.exception.code, 2)
        web_installer.assert_not_called()

    def test_webview_failure_reports_error_and_exits_without_fallback(self):
        error = RuntimeError("WebView2 unavailable")
        for args in ([], ["--uninstall"]):
            with (
                self.subTest(args=args),
                unittest.mock.patch("deploy._setup_windows_taskbar"),
                unittest.mock.patch("deploy.run_web_installer", side_effect=error) as web_installer,
                unittest.mock.patch("deploy._report_startup_failure") as report,
            ):
                self.assertEqual(main(args), 1)

            web_installer.assert_called_once()
            report.assert_called_once_with(error)

    def test_startup_error_is_logged_and_shown_in_a_native_dialog(self):
        logger = unittest.mock.Mock(log_file=Path("setup.log"))
        with (
            unittest.mock.patch("deploy.DeployerLogger", return_value=logger),
            unittest.mock.patch("ctypes.windll.user32.MessageBoxW") as dialog,
        ):
            _report_startup_failure(RuntimeError("missing dependency"))

        logger.error.assert_called_once()
        dialog.assert_called_once()
        self.assertIn("missing dependency", dialog.call_args.args[1])
        self.assertIn("setup.log", dialog.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
