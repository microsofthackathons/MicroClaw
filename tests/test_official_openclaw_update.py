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

    def test_fresh_install_uses_npm_without_update_or_doctor(self):
        self.ws._get_npm_path = Mock(return_value="npm.cmd")
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._install_openclaw_with_registry_fallback.assert_called_once()
        self.ws._run_official_update.assert_not_called()

    def test_other_existing_versions_use_the_official_updater_with_exact_target(self):
        prefix = self.appdata / "npm"
        package = self._write_package(prefix, "2026.9.4")
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertIsNone(self.ws._openclaw_transaction)
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        command = self.ws._run_official_update.call_args.args[0]
        self.assertEqual(command[1], str(package / "openclaw.mjs"))
        self.assertEqual(
            command[2:],
            [
                "update",
                "--tag",
                OPENCLAW_TARGET_VERSION,
                "--yes",
                "--no-restart",
                "--timeout",
                "600",
                "--json",
            ],
        )
        options = self.ws._run_official_update.call_args.kwargs
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["env"]["OPENCLAW_STATE_DIR"], str(self.home / ".openclaw"))
        self.assertEqual(options["env"]["npm_config_prefix"], str(prefix))
        self.ws._validate_installed_version.assert_called_once_with()
        self.ws._patch_pi_ai_usage_streaming.assert_not_called()

    def test_same_version_skips_update_and_doctor(self):
        self._write_package(self.appdata / "npm", OPENCLAW_TARGET_VERSION)
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertFalse(self.ws._openclaw_upgrade_required)
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()

    def test_old_installer_does_not_downgrade_newer_core(self):
        self._write_package(self.appdata / "npm", "2026.10.3")
        with patch("deployer.windows_setup.OPENCLAW_TARGET_VERSION", "2026.9.3"):
            self.assertFalse(self.ws.prepare_openclaw_update())
            self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()

    def test_failed_update_preserves_official_recovery_and_never_falls_back_to_npm(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        self.ws._run_official_update.return_value = subprocess.CompletedProcess(
            [], 1, "", "upgrade refused"
        )
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertIsNone(self.ws._openclaw_transaction)
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._validate_installed_version.assert_not_called()

    def test_update_must_verify_installed_target(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        self.ws._validate_installed_version.return_value = False
        self.assertFalse(self.ws.install_openclaw_windows())

    def test_update_selects_a_reachable_registry_before_mutating_state(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        registry = "https://mirrors.huaweicloud.com/repository/npm/"
        self.ws._reachable_npm_registries.return_value = [registry]
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertEqual(
            self.ws._run_official_update.call_args.kwargs["env"]["npm_config_registry"], registry
        )

    def test_inconclusive_probes_allow_one_official_update_without_npm_fallback(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        self.ws._reachable_npm_registries.return_value = []
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_called_once()
        self.assertEqual(
            self.ws._run_official_update.call_args.kwargs["env"]["npm_config_registry"],
            self.ws._npm_registry_candidates()[0],
        )
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()

    def test_update_rejects_zero_exit_with_incomplete_or_invalid_outcome(self):
        self._write_package(self.appdata / "npm", "2026.9.4")
        for output in ('{"status":"error"}', '{"status":"warning"}', "{}", "invalid"):
            with self.subTest(output=output):
                self.ws._run_official_update.return_value = subprocess.CompletedProcess(
                    [], 0, output, ""
                )
                self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._validate_installed_version.assert_not_called()

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
        for version in ("2026.9.3", "2026.10.3"):
            manifest.write_text(json.dumps({"openClawVersion": version}), encoding="utf-8-sig")
            self.assertEqual(packaged_openclaw_version(manifest), version)
        manifest.write_text('{"openClawVersion":"latest"}', encoding="utf-8")
        with self.assertRaises(ValueError):
            packaged_openclaw_version(manifest)
