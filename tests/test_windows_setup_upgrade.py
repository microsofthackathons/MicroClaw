import json
import os
import tempfile
import unittest
import unittest.mock
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from deployer.openclaw_upgrade import UpgradePhase
from deployer.openclaw_version import OPENCLAW_TARGET_VERSION
from deployer.windows_setup import (
    MIRROR_HUAWEI,
    MIRROR_NPMMIRROR,
    MIRROR_OFFICIAL,
    MIRRORS,
    WindowsSetup,
)


class _Config:
    def __init__(self, values=None):
        self.values = values or {}

    def get(self, key, default=None):
        return self.values.get(key, default)


class _Log:
    def __getattr__(self, _name):
        return lambda _message: None


class WindowsSetupUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.appdata = self.root / "AppData" / "Roaming"
        self.local_appdata = self.root / "AppData" / "Local"
        self.program_files = self.root / "Program Files"
        self.home.mkdir(parents=True)
        self.appdata.mkdir(parents=True)
        self.local_appdata.mkdir(parents=True)
        self.program_files.mkdir(parents=True)

        self.env_patch = unittest.mock.patch.dict(
            os.environ,
            {
                "APPDATA": str(self.appdata),
                "LOCALAPPDATA": str(self.local_appdata),
                "ProgramFiles": str(self.program_files),
            },
            clear=False,
        )
        self.home_patch = unittest.mock.patch(
            "deployer.windows_setup.Path.home", return_value=self.home
        )
        self.desktop_dir_patch = unittest.mock.patch(
            "deployer.windows_setup.DEFAULT_DESKTOP_DIR", self.root / ".microclaw"
        )
        self.env_patch.start()
        self.home_patch.start()
        self.desktop_dir_patch.start()

        self.ws = WindowsSetup.__new__(WindowsSetup)
        self.ws.cfg = _Config({"gateway.port": 18789, "openclaw.channel": "stable"})
        self.ws.log = _Log()
        self.ws.node_dir = self.program_files / "nodejs"
        self.ws._node_bin = None
        self.ws._git_bin = None
        self.ws._rollback_actions = []
        self.ws._openclaw_transaction = None
        self.ws.progress_callback = None
        self.ws.appcontainer_enabled = True
        self.ws.weixin_plugin_enabled = True
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)

    def tearDown(self):
        self.desktop_dir_patch.stop()
        self.home_patch.stop()
        self.env_patch.stop()
        self.temp.cleanup()

    def _write_package(self, prefix: Path, version: str) -> Path:
        package = prefix / "node_modules" / "openclaw"
        package.mkdir(parents=True)
        (package / "openclaw.mjs").write_text("", encoding="utf-8")
        (package / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        return package

    def test_target_version_is_current(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)

        installation = self.ws._detect_openclaw_installation()

        self.assertEqual(installation.version, OPENCLAW_TARGET_VERSION)
        self.assertTrue(self.ws.check_openclaw_windows())
        self.assertEqual(self.ws.install_prefix, prefix)

    def test_other_version_requires_upgrade(self):
        self._write_package(self.home / ".openclaw-node", "2026.3.12")

        self.assertFalse(self.ws.check_openclaw_windows())

    def test_detection_matches_desktop_search_order_and_tracks_all_shims(self):
        legacy_prefix = self.home / ".openclaw-node"
        appdata_prefix = self.appdata / "npm"
        self._write_package(appdata_prefix, OPENCLAW_TARGET_VERSION)
        package = self._write_package(legacy_prefix, "2026.3.12")
        (legacy_prefix / "openclaw.cmd").write_text("@old", encoding="utf-8")

        installation = self.ws._detect_openclaw_installation()

        self.assertEqual(installation.package_dir, package)
        self.assertEqual(
            installation.shim_paths,
            tuple(legacy_prefix / name for name in ("openclaw", "openclaw.cmd", "openclaw.ps1")),
        )

    def test_detects_a_live_gateway_lock(self):
        lock_dir = self.local_appdata / "Temp" / "openclaw"
        lock_dir.mkdir(parents=True)
        lock = lock_dir / "gateway.12345678.lock"
        lock.write_text(
            json.dumps(
                {
                    "pid": 4321,
                    "createdAt": "2026-07-20T00:00:00Z",
                    "configPath": str(self.home / ".openclaw" / "openclaw.json"),
                    "port": 18789,
                }
            ),
            encoding="utf-8",
        )

        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=True)
        with unittest.mock.patch("deployer.windows_setup.process_is_alive", return_value=True):
            self.assertEqual(self.ws._find_active_gateway_lock()["pid"], 4321)

    def test_reused_live_pid_does_not_activate_a_stale_gateway_lock(self):
        lock_dir = self.local_appdata / "Temp" / "openclaw"
        lock_dir.mkdir(parents=True)
        (lock_dir / "gateway.12345678.lock").write_text(
            json.dumps(
                {
                    "pid": 4321,
                    "createdAt": "2026-07-20T00:00:00Z",
                    "configPath": str(self.home / ".openclaw" / "openclaw.json"),
                    "port": 18789,
                }
            ),
            encoding="utf-8",
        )
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)

        with (
            unittest.mock.patch("deployer.windows_setup.process_is_alive", return_value=True),
            unittest.mock.patch(
                "deployer.windows_setup.process_started_at",
                return_value=datetime(2026, 7, 21, tzinfo=UTC),
            ),
        ):
            self.assertIsNone(self.ws._find_active_gateway_lock())

    def test_live_gateway_pid_is_detected_before_its_port_opens(self):
        lock_dir = self.local_appdata / "Temp" / "openclaw"
        lock_dir.mkdir(parents=True)
        (lock_dir / "gateway.12345678.lock").write_text(
            json.dumps(
                {
                    "pid": 4321,
                    "createdAt": "2026-07-20T00:00:00Z",
                    "configPath": str(self.home / ".openclaw" / "openclaw.json"),
                    "port": 18789,
                }
            ),
            encoding="utf-8",
        )

        with (
            unittest.mock.patch("deployer.windows_setup.process_is_alive", return_value=True),
            unittest.mock.patch(
                "deployer.windows_setup.process_started_at",
                return_value=datetime(2026, 7, 20, 0, 0, 2, tzinfo=UTC),
            ),
        ):
            self.assertEqual(self.ws._find_active_gateway_lock()["pid"], 4321)

    def test_prepare_refuses_a_live_gateway_even_when_target_is_installed(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=True)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)

        self.assertFalse(self.ws.prepare_openclaw_upgrade())
        self.assertIsNone(self.ws._openclaw_transaction)

    def test_prepare_still_snapshots_a_stopped_exact_target_installation(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)
        transaction = unittest.mock.Mock()

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.create",
            return_value=transaction,
        ):
            self.assertTrue(self.ws.prepare_openclaw_upgrade())

        transaction.backup.assert_called_once()
        self.assertIs(self.ws._openclaw_transaction, transaction)

    def test_prepare_backs_up_existing_installation_in_same_prefix(self):
        prefix = self.home / ".openclaw-node"
        package = self._write_package(prefix, "2026.3.12")
        state = self.home / ".openclaw"
        state.mkdir()
        (state / "openclaw.json").write_text("{}", encoding="utf-8")
        transaction = unittest.mock.Mock()
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.create",
            return_value=transaction,
        ) as create:
            self.assertTrue(self.ws.prepare_openclaw_upgrade())

        create.assert_called_once()
        installation = create.call_args.kwargs["installation"]
        self.assertEqual(installation.prefix, prefix)
        self.assertEqual(installation.package_dir, package)
        transaction.backup.assert_called_once()
        self.assertEqual(self.ws.install_prefix, prefix)

    def test_interrupted_upgrade_is_rolled_back_before_new_preparation(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.phase = UpgradePhase.INSTALLING
        transaction.manifest.source_version = None

        def rollback():
            transaction.manifest.phase = UpgradePhase.ROLLING_BACK

        transaction.rollback.side_effect = rollback

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.load",
            return_value=transaction,
        ) as load:
            self.assertTrue(self.ws.recover_interrupted_openclaw_upgrade())

        load.assert_called_once_with(self.root / ".microclaw")
        transaction.rollback.assert_called_once()
        transaction.complete_rollback.assert_called_once()

    def test_interrupted_recovery_health_checks_the_restored_gateway(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.phase = UpgradePhase.INSTALLING
        transaction.manifest.source_version = "2026.3.12"
        process = unittest.mock.Mock()

        def rollback():
            transaction.manifest.phase = UpgradePhase.ROLLING_BACK

        transaction.rollback.side_effect = rollback
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=True)

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.load",
            return_value=transaction,
        ):
            self.assertTrue(self.ws.recover_interrupted_openclaw_upgrade())

        self.ws._start_validation_gateway.assert_called_once_with(expected_version="2026.3.12")
        transaction.complete_rollback.assert_called_once()
        self.ws._stop_validation_gateway.assert_called_once_with(process)

    def test_recovery_releases_its_lock_if_gateway_starts_before_restore(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.phase = UpgradePhase.INSTALLING
        self.ws._find_active_gateway_lock = unittest.mock.Mock(side_effect=[None, {"pid": 4321}])

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.load",
            return_value=transaction,
        ):
            self.assertFalse(self.ws.recover_interrupted_openclaw_upgrade())

        transaction.close.assert_called_once()
        transaction.rollback.assert_not_called()

    def test_prepare_rechecks_gateway_after_acquiring_upgrade_lock(self):
        transaction = unittest.mock.Mock()
        self.ws._gateway_is_stopped_for_upgrade = unittest.mock.Mock(
            side_effect=[True, True, True, False]
        )

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.create",
            return_value=transaction,
        ):
            self.assertFalse(self.ws.prepare_openclaw_upgrade())

        transaction.close.assert_called_once()
        transaction.backup.assert_not_called()
        self.assertIsNone(self.ws._openclaw_transaction)

    def test_registry_tls_failure_retries_next_registry(self):
        self.ws.cfg = _Config({"npm.registry": "https://registry.npmmirror.com"})
        self.ws._reachable_npm_registries = lambda candidates, **_kw: list(candidates)
        self.ws._install_openclaw_from_registry = unittest.mock.Mock(
            side_effect=[
                SimpleNamespace(
                    installed_version=None,
                    returncode=1,
                    output="ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
                ),
                SimpleNamespace(
                    installed_version=OPENCLAW_TARGET_VERSION,
                    returncode=0,
                    output="installed",
                ),
            ]
        )

        self.assertTrue(self.ws._install_openclaw_with_registry_fallback(self.appdata / "npm"))
        self.assertEqual(self.ws._install_openclaw_from_registry.call_count, 2)

    def test_registry_policy_or_missing_package_retries_next_registry(self):
        self.ws.cfg = _Config({"npm.registry": "https://packagefeedproxy.microsoft.io/npm/"})
        self.ws._reachable_npm_registries = lambda candidates, **_kw: list(candidates)

        for output in (
            "npm error code E404\nnpm error 404 Not Found - GET",
            "npm error code E403\nnpm error 403 Forbidden by package policy",
        ):
            with self.subTest(output=output):
                self.ws._install_openclaw_from_registry = unittest.mock.Mock(
                    side_effect=[
                        SimpleNamespace(
                            installed_version=None,
                            returncode=1,
                            output=output,
                        ),
                        SimpleNamespace(
                            installed_version=OPENCLAW_TARGET_VERSION,
                            returncode=0,
                            output="installed",
                        ),
                    ]
                )

                self.assertTrue(
                    self.ws._install_openclaw_with_registry_fallback(self.appdata / "npm")
                )
                self.assertEqual(self.ws._install_openclaw_from_registry.call_count, 2)

    def test_non_network_npm_failure_does_not_change_registry(self):
        self.ws.cfg = _Config()
        self.ws._reachable_npm_registries = lambda candidates, **_kw: list(candidates)
        self.ws._install_openclaw_from_registry = unittest.mock.Mock(
            return_value=SimpleNamespace(
                installed_version=None,
                returncode=1,
                output="EINTEGRITY sha512 mismatch",
            )
        )

        self.assertFalse(self.ws._install_openclaw_with_registry_fallback(self.appdata / "npm"))
        self.assertEqual(self.ws._install_openclaw_from_registry.call_count, 1)

    def test_all_registries_unreachable_fails_fast_without_install(self):
        self.ws.cfg = _Config()
        self.ws._reachable_npm_registries = lambda candidates, **_kw: []
        self.ws._install_openclaw_from_registry = unittest.mock.Mock()

        self.assertFalse(self.ws._install_openclaw_with_registry_fallback(self.appdata / "npm"))
        self.ws._install_openclaw_from_registry.assert_not_called()

    def test_git_download_bases_start_with_selected_and_are_deduped(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        bases = self.ws._git_download_bases()

        names = [name for name, _base in bases]
        urls = [base for _name, base in bases]
        self.assertEqual(names[0], MIRROR_NPMMIRROR)
        self.assertIn(MIRROR_OFFICIAL, names)
        # No duplicate download bases (official + huawei share the GitHub base).
        self.assertEqual(len(urls), len(set(urls)))

    def test_git_download_falls_through_blocked_mirror(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        attempted: list[str] = []
        blocked_base = MIRRORS[MIRROR_NPMMIRROR]["git_mirror_base"]

        def fake_download(url, dest):
            attempted.append(url)
            if url.startswith(blocked_base):
                raise OSError("SSLV3_ALERT_HANDSHAKE_FAILURE")
            Path(dest).write_bytes(b"git")

        self.ws._download_with_progress = fake_download

        with tempfile.TemporaryDirectory() as directory:
            dl_path = Path(directory) / "PortableGit.7z.exe"
            self.assertTrue(
                self.ws._download_git_installer("2.53.0", "PortableGit.7z.exe", dl_path)
            )
            self.assertTrue(dl_path.exists())

        self.assertGreater(len(attempted), 1)
        self.assertFalse(attempted[-1].startswith(blocked_base))

    def test_git_download_fails_when_all_mirrors_blocked(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        self.ws._download_with_progress = unittest.mock.Mock(
            side_effect=OSError("SSLV3_ALERT_HANDSHAKE_FAILURE")
        )

        with tempfile.TemporaryDirectory() as directory:
            dl_path = Path(directory) / "PortableGit.7z.exe"
            self.assertFalse(
                self.ws._download_git_installer("2.53.0", "PortableGit.7z.exe", dl_path)
            )

    def test_automatic_registry_fallbacks_are_https(self):
        self.ws.cfg = _Config()

        self.assertTrue(
            all(registry.startswith("https://") for registry in self.ws._npm_registry_candidates())
        )

    def test_node_download_bases_start_with_selected_and_are_deduped(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        bases = self.ws._node_download_bases()

        names = [name for name, _base in bases]
        urls = [base for _name, base in bases]
        # Selected mirror is tried first, then the fallback order.
        self.assertEqual(names[0], MIRROR_NPMMIRROR)
        self.assertIn(MIRROR_OFFICIAL, names)
        self.assertIn(MIRROR_HUAWEI, names)
        # No duplicate download bases.
        self.assertEqual(len(urls), len(set(urls)))

    def test_node_download_falls_through_blocked_mirror(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        attempted: list[str] = []
        blocked_base = MIRRORS[MIRROR_NPMMIRROR]["node_download_base"]

        def fake_download(url, dest):
            attempted.append(url)
            if url.startswith(blocked_base):
                raise OSError("SSLV3_ALERT_HANDSHAKE_FAILURE")
            Path(dest).write_bytes(b"msi")

        self.ws._download_with_progress = fake_download
        self.ws._verify_node_sha256 = lambda version, path: True

        with tempfile.TemporaryDirectory() as directory:
            msi_path = Path(directory) / "node.msi"
            self.assertTrue(self.ws._download_and_verify_node_msi("22.23.1", msi_path))
            self.assertTrue(msi_path.exists())

        # It tried the blocked mirror first, then fell through to a working one.
        self.assertGreater(len(attempted), 1)
        self.assertFalse(self.ws._node_download_base.startswith(blocked_base))

    def test_node_download_fails_when_all_mirrors_blocked(self):
        self.ws._mirror_name = MIRROR_NPMMIRROR
        self.ws._download_with_progress = unittest.mock.Mock(
            side_effect=OSError("SSLV3_ALERT_HANDSHAKE_FAILURE")
        )
        self.ws._verify_node_sha256 = unittest.mock.Mock(return_value=True)

        with tempfile.TemporaryDirectory() as directory:
            msi_path = Path(directory) / "node.msi"
            self.assertFalse(self.ws._download_and_verify_node_msi("22.23.1", msi_path))

        # Verification is never reached when every download fails.
        self.ws._verify_node_sha256.assert_not_called()

    def test_install_uses_prepared_prefix(self):
        prepared = self.home / ".openclaw-node"
        self.ws.install_prefix = prepared
        self.ws._get_npm_path = unittest.mock.Mock(return_value="npm.cmd")
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._install_openclaw_with_registry_fallback = unittest.mock.Mock(return_value=True)
        self.ws._patch_pi_ai_usage_streaming = unittest.mock.Mock()

        self.assertTrue(self.ws.install_openclaw_windows())

        self.ws._install_openclaw_with_registry_fallback.assert_called_once_with(prepared)

    def test_validation_records_every_required_check_and_stops_gateway(self):
        transaction = unittest.mock.Mock()
        process = unittest.mock.Mock()
        self.ws._openclaw_transaction = transaction
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_installed_version = unittest.mock.Mock(return_value=True)
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=True)
        self.ws._validate_gateway_status = unittest.mock.Mock(return_value=True)
        self.ws._validate_gateway_rpc = unittest.mock.Mock(return_value=True)
        self.ws._validate_weixin_plugin = unittest.mock.Mock(return_value=True)
        self.ws._validate_appcontainer_smoke = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.ws.verify_openclaw_upgrade())

        self.assertEqual(
            [call.args for call in transaction.record_validation.call_args_list],
            [
                ("version", True),
                ("health", True),
                ("v4-handshake", True),
                ("config.get", True),
                ("agents.list", True),
                ("channels.status", True),
                ("cron.list", True),
                ("weixin-plugin", True),
                ("appcontainer", True),
            ],
        )
        transaction.mark_verifying.assert_called_once()
        self.ws._stop_validation_gateway.assert_called_once_with(process)

    def test_failed_validation_returns_false_without_rolling_back_inside_validator(self):
        transaction = unittest.mock.Mock()
        process = unittest.mock.Mock()
        self.ws._openclaw_transaction = transaction
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_installed_version = unittest.mock.Mock(return_value=False)

        self.assertFalse(self.ws.verify_openclaw_upgrade())

        transaction.rollback.assert_not_called()
        transaction.record_validation.assert_called_once_with("version", False)
        self.ws._start_validation_gateway.assert_not_called()
        self.ws._stop_validation_gateway.assert_not_called()

    def test_rollback_restores_and_health_checks_previous_gateway(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.source_version = "2026.3.12"
        transaction.manifest.phase = UpgradePhase.ROLLING_BACK
        process = unittest.mock.Mock()
        self.ws._openclaw_transaction = transaction
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.ws.rollback_openclaw_upgrade())

        transaction.rollback.assert_called_once()
        transaction.complete_rollback.assert_called_once()
        transaction.mark_rollback_failed.assert_not_called()
        self.ws._start_validation_gateway.assert_called_once_with(expected_version="2026.3.12")
        self.ws._stop_validation_gateway.assert_called_once_with(process)

    def test_backing_up_rollback_skips_gateway_health_check(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.source_version = "2026.3.12"
        transaction.manifest.phase = UpgradePhase.BACKING_UP

        def rollback():
            transaction.manifest.phase = UpgradePhase.ROLLING_BACK

        transaction.rollback.side_effect = rollback
        self.ws._start_validation_gateway = unittest.mock.Mock()

        self.assertTrue(self.ws._rollback_openclaw_transaction(transaction))

        transaction.rollback.assert_called_once()
        transaction.complete_rollback.assert_called_once()
        transaction.mark_rollback_failed.assert_not_called()
        self.ws._start_validation_gateway.assert_not_called()

    def test_new_install_rollback_does_not_start_a_missing_previous_gateway(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.source_version = None
        transaction.manifest.phase = UpgradePhase.ROLLING_BACK
        self.ws._openclaw_transaction = transaction
        self.ws._start_validation_gateway = unittest.mock.Mock()

        self.assertTrue(self.ws.rollback_openclaw_upgrade())

        transaction.rollback.assert_called_once()
        transaction.complete_rollback.assert_called_once()
        self.ws._start_validation_gateway.assert_not_called()

    def test_failed_rollback_health_check_discards_transaction(self):
        transaction = unittest.mock.Mock()
        transaction.manifest.source_version = "2026.3.12"
        transaction.manifest.phase = UpgradePhase.ROLLING_BACK
        self.ws._openclaw_transaction = transaction
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=unittest.mock.Mock())
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=False)

        self.assertFalse(self.ws.rollback_openclaw_upgrade())

        # A failed post-rollback health check must not leave a permanent
        # rollback-failed brick; the transaction is discarded so future
        # installs are not blocked by the retained lock.
        transaction.discard.assert_called_once()
        transaction.complete_rollback.assert_not_called()

    def test_desktop_update_preserves_upgrade_transaction_directories(self):
        install_dir = self.root / ".microclaw"
        backup_marker = install_dir / "backups" / "openclaw" / "tx" / "marker.txt"
        transaction_marker = install_dir / "upgrade" / "openclaw-upgrade.json"
        backup_marker.parent.mkdir(parents=True)
        transaction_marker.parent.mkdir(parents=True)
        backup_marker.write_text("backup", encoding="utf-8")
        transaction_marker.write_text("transaction", encoding="utf-8")
        (install_dir / "MicroClawDesktop.exe").write_text("old", encoding="utf-8")
        desktop_zip = self.root / "microclaw-portable.zip"
        with zipfile.ZipFile(desktop_zip, "w") as archive:
            archive.writestr("MicroClawDesktop.exe", "new")

        self.ws._find_local_desktop_zip = unittest.mock.Mock(return_value=desktop_zip)
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        with unittest.mock.patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", install_dir):
            self.assertTrue(self.ws.install_desktop_client())

        self.assertEqual(backup_marker.read_text(encoding="utf-8"), "backup")
        self.assertEqual(transaction_marker.read_text(encoding="utf-8"), "transaction")
        self.assertEqual(
            (install_dir / "MicroClawDesktop.exe").read_text(encoding="utf-8"),
            "new",
        )


if __name__ == "__main__":
    unittest.main()
