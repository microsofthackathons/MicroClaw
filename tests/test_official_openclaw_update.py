import json
import subprocess
import unittest
from unittest.mock import Mock, patch

from deployer.openclaw_upgrade import UpgradeBackupMode, UpgradePhase
from deployer.openclaw_version import OPENCLAW_TARGET_VERSION, packaged_openclaw_version
from tests import test_windows_setup_upgrade as fixtures


class OfficialOpenClawUpdateTests(unittest.TestCase):
    tearDown = fixtures.WindowsSetupUpgradeTests.tearDown
    _write_package = fixtures.WindowsSetupUpgradeTests._write_package

    def setUp(self):
        fixtures.WindowsSetupUpgradeTests.setUp(self)
        self.ws._resolve_validation_node = Mock(return_value=self.ws.node_dir / "node.exe")
        self.ws._get_env = Mock(return_value={"PATH": "test"})
        self.ws._desired_npm_registry = Mock(return_value="https://registry.npmjs.org")
        self.ws._reachable_npm_registries = Mock(return_value=["https://registry.npmjs.org"])
        self.ws._validate_installed_version = Mock(return_value=True)
        self.ws._install_openclaw_with_registry_fallback = Mock(return_value=True)
        self.ws._patch_pi_ai_usage_streaming = Mock()
        self.ws._run = Mock()
        self.ws._run_official_update = Mock(
            return_value=subprocess.CompletedProcess([], 0, '{"status":"ok"}', "")
        )
        self.ws._upgrade_openclaw_with_package_manager = Mock(return_value=True)

    def test_fresh_install_uses_npm_without_update_or_doctor(self):
        self.ws._get_npm_path = Mock(return_value="npm.cmd")
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._install_openclaw_with_registry_fallback.assert_called_once()
        self.ws._run_official_update.assert_not_called()

    def test_existing_versions_use_the_controlled_npm_upgrade(self):
        prefix = self.appdata / "npm"
        package = self._write_package(prefix, "2026.9.4")
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertIsNone(self.ws._openclaw_transaction)
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._upgrade_openclaw_with_package_manager.assert_called_once()
        installation = self.ws._upgrade_openclaw_with_package_manager.call_args.args[0]
        self.assertEqual(installation.entry_path, package / "openclaw.mjs")
        self.assertEqual(installation.prefix, prefix)
        self.ws._run_official_update.assert_not_called()
        self.ws._patch_pi_ai_usage_streaming.assert_not_called()

    def test_same_version_skips_update_and_doctor(self):
        self._write_package(self.appdata / "npm", OPENCLAW_TARGET_VERSION)
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertFalse(self.ws._openclaw_upgrade_required)
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._upgrade_openclaw_with_package_manager.assert_not_called()

    def test_previous_releases_upgrade_to_10_5_without_the_official_updater(self):
        package = self._write_package(self.appdata / "npm", "2026.9.3")
        for version in ("2026.9.3", "2026.10.3"):
            with self.subTest(version=version):
                (package / "package.json").write_text(json.dumps({"version": version}))
                self.ws._run_official_update.reset_mock()
                self.ws._upgrade_openclaw_with_package_manager.reset_mock()
                self.assertTrue(self.ws.prepare_openclaw_update())
                self.assertTrue(self.ws.install_openclaw_windows())
                self.ws._upgrade_openclaw_with_package_manager.assert_called_once()
                installation = self.ws._upgrade_openclaw_with_package_manager.call_args.args[0]
                self.assertEqual(installation.version, version)
                self.ws._run_official_update.assert_not_called()
                self.ws._install_openclaw_with_registry_fallback.assert_not_called()

    def test_old_installer_does_not_downgrade_newer_core(self):
        self._write_package(self.appdata / "npm", "2026.10.3")
        with patch("deployer.windows_setup.OPENCLAW_TARGET_VERSION", "2026.9.3"):
            self.assertFalse(self.ws.prepare_openclaw_update())
            self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._upgrade_openclaw_with_package_manager.assert_not_called()

    def test_failed_npm_upgrade_does_not_try_the_official_updater_or_fresh_install(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        self.ws._upgrade_openclaw_with_package_manager.return_value = False
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertIsNone(self.ws._openclaw_transaction)
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._validate_installed_version.assert_not_called()
        self.ws._run_official_update.assert_not_called()

    def test_update_timeout_kills_its_process_tree(self):
        process = Mock()
        process.communicate.side_effect = subprocess.TimeoutExpired("openclaw", 1800)
        self.ws._terminate_process_tree = Mock()
        with (
            patch("deployer.windows_setup.subprocess.Popen", return_value=process),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            fixtures.WindowsSetup._run_official_update(
                self.ws,
                ["node.exe", "openclaw.mjs", "update"],
                timeout=1800,
                capture_output=True,
            )
        self.ws._terminate_process_tree.assert_called_once_with(process, self.process_job)

    def test_managed_rollback_does_not_launch_another_gateway_or_restore_core(self):
        transaction = Mock()
        transaction.manifest.phase = UpgradePhase.INSTALLING
        transaction.manifest.backup_mode = UpgradeBackupMode.MANAGED_STATE
        transaction.manifest.source_version = OPENCLAW_TARGET_VERSION
        self.ws._start_validation_gateway = Mock()
        self.assertTrue(self.ws._rollback_openclaw_transaction(transaction))
        transaction.complete_rollback.assert_called_once()
        self.ws._start_validation_gateway.assert_not_called()

    def test_packaged_manifest_selects_target_without_mutating_source(self):
        manifest = self.root / "install-manifest.json"
        for version in ("2026.9.3", "2026.10.3", "2026.10.5"):
            manifest.write_text(json.dumps({"openClawVersion": version}), encoding="utf-8-sig")
            self.assertEqual(packaged_openclaw_version(manifest), version)
        manifest.write_text('{"openClawVersion":"latest"}', encoding="utf-8")
        with self.assertRaises(ValueError):
            packaged_openclaw_version(manifest)
