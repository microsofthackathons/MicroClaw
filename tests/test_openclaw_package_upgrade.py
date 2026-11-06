import json
import os
import subprocess
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from deployer.openclaw_package_upgrade import PackageManagerUpgrade, package_upgrade_lock
from deployer.openclaw_upgrade import UpgradeInProgressError
from deployer.windows_setup import _ProcessInfo
from tests import test_windows_setup_upgrade as fixtures


class PackageManagerUpgradeTests(unittest.TestCase):
    tearDown = fixtures.WindowsSetupUpgradeTests.tearDown
    _write_package = fixtures.WindowsSetupUpgradeTests._write_package

    def setUp(self):
        target = patch("deployer.windows_setup.OPENCLAW_TARGET_VERSION", "2026.10.5")
        target.start()
        self.addCleanup(target.stop)
        fixtures.WindowsSetupUpgradeTests.setUp(self)
        self.microclaw = self.root / ".microclaw"
        self.prefix = self.appdata / "npm"
        self.package = self._write_package(self.prefix, "2026.10.3")
        self._set_version("2026.10.3")
        self.target_version = "2026.10.5"
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
        self.backup_overrides = {}
        self.npm_exit = 0
        self.doctor_exit = 0

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
            result.update(self.backup_overrides)
            return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
        if "install" in command:
            self._set_version(self.target_version)
            return subprocess.CompletedProcess(command, self.npm_exit, "npm output", "")
        if "doctor" in command:
            return subprocess.CompletedProcess(
                command, self.doctor_exit, "OpenClaw doctor finished", ""
            )
        raise AssertionError(command)

    def test_upgrade_backs_up_before_npm_then_runs_doctor_exactly_once(self):
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
        self.assertEqual(commands[1][:4], ["npm.cmd", "install", "-g", "openclaw@2026.10.5"])
        self.assertIn("--allow-scripts=openclaw", commands[1])
        self.assertEqual(commands[1][commands[1].index("--prefix") + 1], str(self.prefix))
        self.assertEqual(
            commands[2][2:],
            [
                "doctor",
                "--fix",
                "--non-interactive",
            ],
        )
        self.assertEqual(sum("doctor" in command for command in commands), 1)
        self.assertFalse(any("update" in command or "repair" in command for command in commands))
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
        self.assertEqual(self.ws._detect_openclaw_installation().version, "2026.10.3")

    def test_failed_doctor_is_resumed_without_reinstalling_or_replacing_backup(self):
        self.doctor_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "migrating")
        original_archive = pending.archive
        self.assertTrue(pending.data["packageReady"])
        self.assertFalse(self.ws.check_openclaw_windows())
        self.assertTrue(self.ws.prepare_openclaw_update())
        self.assertTrue(self.ws._openclaw_upgrade_required)
        self.ws._run_official_update.reset_mock()
        self.doctor_exit = 0
        self.assertTrue(self.ws.install_openclaw_windows())
        calls = self.ws._run_official_update.call_args_list
        self.assertEqual(len(calls), 1)
        self.assertIn("doctor", calls[0].args[0])
        self.assertTrue(original_archive.is_file())

    def test_legacy_repairing_phase_resumes_with_doctor_only(self):
        self.doctor_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        pending.save("repairing")
        self.ws._run_official_update.reset_mock()
        self.doctor_exit = 0
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_called_once()
        self.assertIn("doctor", self.ws._run_official_update.call_args.args[0])
        self.assertTrue(pending.archive.is_file())
        self.assertIsNone(PackageManagerUpgrade.pending(self.microclaw))

    def test_same_version_retry_does_not_run_another_doctor(self):
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 3)
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
        self.doctor_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        pending.archive.write_bytes(b"changed")
        self.ws._run_official_update.reset_mock()
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_nonzero_doctor_exit_keeps_backup_and_pending_marker(self):
        self.doctor_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "migrating")
        pending.verify_archive()
        self.assertFalse(self.ws.check_openclaw_windows())

    def test_version_validation_failure_keeps_backup_and_pending_marker(self):
        self.ws._validate_installed_version = Mock(return_value=False)
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "migrating")
        pending.verify_archive()
        self.ws._start_validation_gateway.assert_not_called()

    def test_gateway_restart_during_doctor_keeps_backup_and_pending_marker(self):
        def command_with_gateway_restart(command, **options):
            result = self._command(command, **options)
            if "doctor" in command:
                self.ws._gateway_is_stopped_for_upgrade = Mock(return_value=False)
            return result

        self.ws._run_official_update.side_effect = command_with_gateway_restart
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        self.assertEqual(pending.data["phase"], "migrating")
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
            if "doctor" in command:
                raise subprocess.TimeoutExpired(command, 900)
            return original_command(command, **options)

        self.ws._run_official_update.side_effect = command_with_timeout
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(PackageManagerUpgrade.pending(self.microclaw).data["phase"], "migrating")
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
        upgrade = PackageManagerUpgrade.create(
            self.microclaw, self.prefix, source_version="2026.10.3", target_version="2026.10.5"
        )
        upgrade.data["prefix"] = str(self.root / "untrusted")
        upgrade.save("backing-up")
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_backup_verification_uses_sha_not_timestamp_metadata(self):
        self.doctor_exit = 1
        self.assertFalse(self.ws.install_openclaw_windows())
        pending = PackageManagerUpgrade.pending(self.microclaw)
        digest = pending.archive_digest()
        os.utime(pending.archive, (1000, 1000))
        with patch.object(Path, "stat", side_effect=AssertionError("No timestamp comparison")):
            pending.verify_archive()
        self.assertEqual(pending.archive_digest(), digest)
        self.ws._run_official_update.reset_mock()
        self.doctor_exit = 0
        self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_called_once()
        self.assertIn("doctor", self.ws._run_official_update.call_args.args[0])

    def test_backup_must_cover_state_and_workspaces_before_any_npm_replacement(self):
        for overrides in (
            {"includeWorkspace": False},
            {"onlyConfig": True},
            {"assets": []},
            {"assets": [{"kind": "state", "sourcePath": str(self.root / "other")}]},
            {"archivePath": str(self.root / "other.tar.gz")},
        ):
            with self.subTest(overrides=overrides):
                self.backup_overrides = overrides
                self.ws._run_official_update.reset_mock()
                self.assertFalse(self.ws.install_openclaw_windows())
                self.ws._run_official_update.assert_called_once()
                self.assertIn("backup", self.ws._run_official_update.call_args.args[0])
                self.assertEqual(self.ws._detect_openclaw_installation().version, "2026.10.3")

    def test_reachable_registry_is_used_for_the_entire_upgrade(self):
        registry = "https://mirrors.huaweicloud.com/repository/npm/"
        self.ws._reachable_npm_registries.return_value = [registry]
        self.assertTrue(self.ws.install_openclaw_windows())
        for call in self.ws._run_official_update.call_args_list:
            self.assertEqual(call.kwargs["env"]["npm_config_registry"], registry)
            self.assertEqual(call.kwargs["env"]["npm_config_prefix"], str(self.prefix))
        command = self.ws._run_official_update.call_args_list[1].args[0]
        self.assertEqual(command[command.index("--registry") + 1], registry)

    def test_inconclusive_registry_probe_does_not_launch_the_old_updater(self):
        self.ws._reachable_npm_registries.return_value = []
        self.assertTrue(self.ws.install_openclaw_windows())
        self.assertEqual(self.ws._run_official_update.call_count, 3)
        self.assertFalse(
            any("update" in call.args[0] for call in self.ws._run_official_update.call_args_list)
        )

    def test_previous_9_3_release_also_uses_backup_npm_and_one_doctor(self):
        self._set_version("2026.9.3")
        self.assertTrue(self.ws.install_openclaw_windows())
        record = json.loads(
            (self.microclaw / "upgrade" / "openclaw-package-upgrade.json").read_text()
        )
        self.assertEqual(record["sourceVersion"], "2026.9.3")
        self.assertEqual(record["targetVersion"], "2026.10.5")
        self.assertEqual(record["phase"], "complete")
        self.assertEqual(self.ws._run_official_update.call_count, 3)

    def test_legacy_9_3_to_10_3_repair_record_can_resume_with_doctor(self):
        upgrade = PackageManagerUpgrade.create(
            self.microclaw, self.prefix, source_version="2026.9.3", target_version="2026.10.3"
        )
        upgrade.archive.write_bytes(b"retained legacy state backup")
        upgrade.save("repairing", archiveSha256=upgrade.archive_digest(), packageReady=True)
        with patch("deployer.windows_setup.OPENCLAW_TARGET_VERSION", "2026.10.3"):
            self.assertTrue(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_called_once()
        self.assertIn("doctor", self.ws._run_official_update.call_args.args[0])
        self.assertTrue(upgrade.archive.exists())
        self.assertIsNone(PackageManagerUpgrade.pending(self.microclaw))

    def test_different_pending_target_is_preserved_without_replacement(self):
        upgrade = PackageManagerUpgrade.create(
            self.microclaw, self.prefix, source_version="2026.9.3", target_version="2026.10.3"
        )
        record = self.microclaw / "upgrade" / "openclaw-package-upgrade.json"
        original = record.read_bytes()
        self.assertFalse(self.ws.prepare_openclaw_update())
        self.assertFalse(self.ws.install_openclaw_windows())
        self.assertEqual(record.read_bytes(), original)
        self.ws._run_official_update.assert_not_called()
        self.assertEqual(
            PackageManagerUpgrade.pending(self.microclaw).data["id"], upgrade.data["id"]
        )

    def test_invalid_or_non_upgrade_versions_cannot_create_a_recovery_record(self):
        for source, target in (
            ("latest", "2026.10.5"),
            ("2026.10.3", "beta"),
            ("2026.10.5", "2026.10.5"),
            ("2026.10.6", "2026.10.5"),
        ):
            with self.subTest(source=source, target=target), self.assertRaises(ValueError):
                PackageManagerUpgrade.create(
                    self.microclaw, self.prefix, source_version=source, target_version=target
                )
        self.assertFalse((self.microclaw / "upgrade" / "openclaw-package-upgrade.json").exists())

    def test_newer_installed_runtime_is_never_downgraded_with_npm(self):
        self._set_version("2026.10.6")
        self.assertFalse(self.ws.install_openclaw_windows())
        self.ws._run_official_update.assert_not_called()

    def test_final_health_check_does_not_run_more_doctor_or_plugin_rpcs(self):
        self.assertTrue(self.ws.install_openclaw_windows())
        archive_command = self.ws._run_official_update.call_args_list[0].args[0]
        archive = Path(archive_command[archive_command.index("--output") + 1])
        self.ws._run_openclaw_json = Mock(side_effect=AssertionError("No post-install RPC"))
        self.ws._validate_gateway_health = Mock(return_value=True)
        self.assertTrue(self.ws.validate_running_gateway())
        self.ws._validate_gateway_health.return_value = False
        self.assertFalse(self.ws.validate_running_gateway())
        self.assertEqual(self.ws._run_official_update.call_count, 3)
        self.ws._run_openclaw_json.assert_not_called()
        self.assertTrue(archive.is_file())

    def test_health_probe_accepts_http_200_without_a_cli_query(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch("deployer.windows_setup.urllib.request.urlopen", return_value=response) as probe:
            self.assertTrue(self.ws._validate_gateway_health())
        probe.assert_called_once_with("http://127.0.0.1:18789/health", timeout=2)
        self.ws._run_official_update.assert_not_called()

    def test_health_probe_rejects_non_200_and_connection_failure(self):
        response = MagicMock()
        response.__enter__.return_value.status = 204
        for result in (response, urllib.error.URLError("not listening")):
            with (
                self.subTest(result=result),
                patch(
                    "deployer.windows_setup.urllib.request.urlopen",
                    side_effect=result if isinstance(result, Exception) else None,
                    return_value=response,
                ),
                patch("deployer.windows_setup.time.monotonic", side_effect=[0, 0, 121]),
                patch("deployer.windows_setup.time.sleep"),
            ):
                self.assertFalse(self.ws._validate_gateway_health())
        self.ws._run_official_update.assert_not_called()
