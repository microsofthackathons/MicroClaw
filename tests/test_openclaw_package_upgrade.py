import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock

from deployer.openclaw_package_upgrade import PackageManagerUpgrade, package_upgrade_lock
from deployer.openclaw_upgrade import UpgradeInProgressError
from deployer.windows_setup import _ProcessInfo
from tests import test_windows_setup_upgrade as fixtures


class PackageManagerUpgradeTests(unittest.TestCase):
    tearDown = fixtures.WindowsSetupUpgradeTests.tearDown
    _write_package = fixtures.WindowsSetupUpgradeTests._write_package

    def setUp(self):
        fixtures.WindowsSetupUpgradeTests.setUp(self)
        self.microclaw = self.root / ".microclaw"
        self.prefix = self.appdata / "npm"
        self.package = self._write_package(self.prefix, "2026.9.3")
        self._set_version("2026.9.3")
        self.state = self.home / ".openclaw"
        self.state.mkdir()
        self.config = self.state / "openclaw.json"
        self.config.write_text('{"agents":{"defaults":{"workspace":"custom-workspace"}}}')
        self.ws._resolve_validation_node = Mock(return_value=self.ws.node_dir / "node.exe")
        self.ws._get_npm_path = Mock(return_value="npm.cmd")
        self.ws._get_env = Mock(return_value={"PATH": "test"})
        self.ws._desired_npm_registry = Mock(return_value="https://registry.npmjs.org")
        self.ws._reachable_npm_registries = Mock(return_value=["https://registry.npmjs.org"])
        self.ws._with_state_owner_compatibility = Mock(side_effect=lambda env, _installation: env)
        self.ws._process_snapshot = Mock(
            return_value={
                os.getpid(): _ProcessInfo(
                    parent_pid=0, name="python.exe", command_line="installer"
                ),
            }
        )
        self.ws._run_official_update = Mock(side_effect=self._command)
        self.ws._install_openclaw_with_registry_fallback = Mock()
        self.ws._start_validation_gateway = Mock()
        self.backup_verified = True
        self.npm_exit = 0
        self.repair_status = "ok"
        self.repair_exit = 0

    def _set_version(self, version):
        self.package.mkdir(parents=True, exist_ok=True)
        (self.package / "package.json").write_text(
            json.dumps({"name": "openclaw", "version": version})
        )
        (self.package / "openclaw.mjs").touch()

    def _command(self, command, **_options):
        if "backup" in command:
            archive = Path(command[command.index("--output") + 1])
            archive.write_bytes(b"verified state and workspace archive")
            result = {
                "verified": self.backup_verified,
                "includeWorkspace": True,
                "onlyConfig": False,
                "archivePath": str(archive),
                "assets": [{"kind": "state", "sourcePath": str(self.state)}],
            }
            return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
        if "install" in command:
            self._set_version("2026.10.3")
            return subprocess.CompletedProcess(command, self.npm_exit, "npm output", "")
        if "repair" in command:
            return subprocess.CompletedProcess(
                command, self.repair_exit, json.dumps({"status": self.repair_status}), ""
            )
        raise AssertionError(command)

    def test_exact_upgrade_backs_up_before_npm_then_repairs_without_extra_doctor(self):
        artifact = self.prefix / "node_modules" / ".openclaw-retained.restore"
        artifact.mkdir()
        (artifact / "evidence").write_text("keep")
        original_config = self.config.read_bytes()
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertTrue(self.ws.install_openclaw_windows())
        commands = [call.args[0] for call in self.ws._run_official_update.call_args_list]
        self.assertEqual(len(commands), 3)
        self.assertIn("backup", commands[0])
        self.assertIn("--verify", commands[0])
        self.assertNotIn("--no-include-workspace", commands[0])
        self.assertEqual(commands[1][:4], ["npm.cmd", "install", "-g", "openclaw@2026.10.3"])
        self.assertEqual(commands[1][commands[1].index("--prefix") + 1], str(self.prefix))
        self.assertEqual(
            commands[2][2:],
            [
                "update",
                "repair",
                "--yes",
                "--no-restart",
                "--timeout",
                "600",
                "--json",
            ],
        )
        self.assertFalse(any("doctor" in command for command in commands))
        self.assertEqual(self.config.read_bytes(), original_config)
        self.assertEqual((artifact / "evidence").read_text(), "keep")
        self.assertIsNone(PackageManagerUpgrade.pending(self.microclaw))
        self.assertTrue(self.ws.check_openclaw_windows())
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()
        self.ws._start_validation_gateway.assert_not_called()
        self.assertEqual(self.ws._rollback_actions, [])

    def test_unverified_backup_never_replaces_runtime(self):
        self.backup_verified = False
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 1)
        self.assertEqual(self.ws._detect_openclaw_installation().version, "2026.9.3")

    def test_failed_repair_is_resumed_even_with_target_package_installed(self):
        self.repair_status = "error"
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "repairing")
        original_archive = pending.archive
        self.assertTrue(pending.data["packageReady"])
        self.assertFalse(self.ws.check_openclaw_windows())
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertTrue(self.ws._openclaw_upgrade_required)
        self.ws._run_official_update.reset_mock()
        self.repair_status = "ok"
        self.assertTrue(self.ws.install_openclaw_windows())
        calls = self.ws._run_official_update.call_args_list
        self.assertEqual(len(calls), 1)
        self.assertIn("repair", calls[0].args[0])
        self.assertTrue(original_archive.is_file())

    def test_legacy_migrating_record_resumes_with_repair_only(self):
        self.repair_status = "error"
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        pending.save("migrating")
        self.ws._run_official_update.reset_mock()
        self.repair_status = "ok"
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_called_once()
        self.assertIn("repair", self.ws._run_official_update.call_args.args[0])
        self.assertTrue(pending.archive.is_file())
        self.assertIsNone(PackageManagerUpgrade.pending(self.microclaw))

    def test_repair_warning_is_logged_without_extra_doctor(self):
        self.repair_status = "warning"
        self.ws.log.warn = Mock()
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 3)
        self.ws.log.warn.assert_any_call('OpenClaw update repair advisories: {"status": "warning"}')
        self.assertIsNone(PackageManagerUpgrade.pending(self.microclaw))

    def test_nonzero_npm_exit_is_not_success_even_if_version_already_changed(self):
        self.npm_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 2)
        self.assertFalse(PackageManagerUpgrade.pending(self.microclaw).data["packageReady"])
        self.ws._run_official_update.reset_mock()
        self.npm_exit = 0
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertIn("install", self.ws._run_official_update.call_args_list[0].args[0])

    def test_partial_package_without_entry_is_not_treated_as_a_fresh_install(self):
        self.npm_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        (self.package / "openclaw.mjs").unlink()
        self.npm_exit = 0
        self.ws._run_official_update.reset_mock()
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 2)
        self.ws._install_openclaw_with_registry_fallback.assert_not_called()

    def test_tampered_backup_blocks_resume_without_any_child_command(self):
        self.repair_status = "error"
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        pending.archive.write_bytes(b"changed")
        self.ws._run_official_update.reset_mock()
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_nonzero_repair_exit_keeps_backup_and_pending_marker(self):
        self.repair_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "repairing")
        pending.verify_archive()
        self.assertFalse(self.ws.check_openclaw_windows())

    def test_version_validation_failure_keeps_backup_and_pending_marker(self):
        self.ws._validate_installed_version = Mock(return_value=False)
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "repairing")
        pending.verify_archive()
        self.ws._start_validation_gateway.assert_not_called()

    def test_gateway_restart_during_repair_keeps_backup_and_pending_marker(self):
        def command_with_gateway_restart(command, **options):
            result = self._command(command, **options)
            if "repair" in command:
                self.ws._gateway_is_stopped_for_upgrade = Mock(return_value=False)
            return result

        self.ws._run_official_update.side_effect = command_with_gateway_restart
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "repairing")
        pending.verify_archive()
        self.ws._start_validation_gateway.assert_not_called()

    def test_busy_gateway_blocks_backup_and_replacement(self):
        self.ws._gateway_is_stopped_for_upgrade = Mock(return_value=False)
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_active_old_updater_is_not_killed_or_overwritten(self):
        self.ws._process_snapshot.return_value[1234] = _ProcessInfo(
            parent_pid=0,
            name="node.exe",
            command_line="node openclaw.mjs update --yes",
        )
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_missing_process_inventory_blocks_replacement(self):
        self.ws._process_snapshot.return_value = {}
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_custom_state_environment_is_not_silently_replaced(self):
        self.ws._get_env.return_value["OPENCLAW_STATE_DIR"] = str(self.root / "custom-state")
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_case_variant_custom_state_environment_also_blocks_replacement(self):
        self.ws._get_env.return_value["openclaw_state_dir"] = str(self.root / "custom-state")
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_case_variant_npm_prefix_is_replaced_with_detected_prefix(self):
        self.ws._get_env.return_value["NPM_CONFIG_PREFIX"] = "unrelated-prefix"
        self.assertTrue(self.ws.install_openclaw_windows())
        for call in self.ws._run_official_update.call_args_list:
            env = call.kwargs["env"]
            self.assertNotIn("NPM_CONFIG_PREFIX", env)
            self.assertEqual(env["npm_config_prefix"], str(self.prefix))
            self.assertEqual(env["OPENCLAW_SERVICE_REPAIR_POLICY"], "external")

    def test_timeout_leaves_a_resumable_record_and_never_starts_gateway(self):
        original_command = self._command

        def command_with_timeout(command, **options):
            if "repair" in command:
                raise subprocess.TimeoutExpired(command, 900)
            return original_command(command, **options)

        self.ws._run_official_update.side_effect = command_with_timeout
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(PackageManagerUpgrade.pending(self.microclaw).data["phase"], "repairing")
        self.ws._start_validation_gateway.assert_not_called()

    def test_invalid_recovery_record_is_preserved_and_blocks_install(self):
        path = self.microclaw / "upgrade" / "openclaw-package-upgrade.json"
        path.parent.mkdir(parents=True)
        path.write_text("invalid")
        self.assertFalse(self.ws.prepare_openclaw_update())
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(path.read_text(), "invalid")
        self.ws._run_official_update.assert_not_called()

    def test_lock_contention_does_not_overwrite_recovery_record(self):
        with (
            package_upgrade_lock(self.microclaw),
            self.assertRaises(UpgradeInProgressError),
            package_upgrade_lock(self.microclaw),
        ):
            self.fail("second writer acquired the upgrade lock")

    def test_pending_prefix_cannot_escape_trusted_install_locations(self):
        upgrade = PackageManagerUpgrade.create(self.microclaw, self.prefix)
        upgrade.data["prefix"] = str(self.root / "untrusted")
        upgrade.save("backing-up")
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()
