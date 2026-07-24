import unittest
import unittest.mock
from pathlib import Path

from deploy import DeployerApp
from deployer.webview_bridge import InstallationCancelled, WebInstallerBridge
from deployer.windows_setup import ActiveGateway, ActiveInstallation


class _Log:
    def __getattr__(self, _name):
        return lambda _message: None


class WebInstallerBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = WebInstallerBridge(logger=_Log())

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


if __name__ == "__main__":
    unittest.main()
