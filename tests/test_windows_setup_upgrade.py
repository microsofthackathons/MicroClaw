import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from deployer.openclaw_upgrade import UpgradeBackupMode, UpgradePhase
from deployer.openclaw_version import OPENCLAW_TARGET_VERSION
from deployer.uninstaller_bundle import UninstallerBundleError
from deployer.windows_setup import (
    _OPENCLAW_RPC_TIMEOUT,
    MIRROR_HUAWEI,
    MIRROR_NPMMIRROR,
    MIRROR_OFFICIAL,
    MIRRORS,
    ActiveGateway,
    ActiveInstallation,
    NodeInstallBlocked,
    WeixinPluginPolicy,
    WindowsSetup,
    _ProcessInfo,
    _WindowsKillOnCloseJob,
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
        self.ws._openclaw_upgrade_required = True
        self.ws._weixin_plugin_mutation_required = False
        self.ws._weixin_policy_snapshot = None
        self.ws._weixin_policy_restore_pending = False
        self.ws._weixin_registration_verified = False
        self.process_job = unittest.mock.Mock()
        self.ws._create_process_lifetime_job = unittest.mock.Mock(return_value=self.process_job)
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

    def _write_weixin_payload(self, root: Path, marker: str = "same") -> None:
        files = {
            "package.json": json.dumps(
                {"name": "@tencent-weixin/openclaw-weixin", "version": "2.4.6"}
            ),
            "openclaw.plugin.json": json.dumps({"id": "openclaw-weixin", "version": "2.4.6"}),
            "dist/index.js": marker,
            "node_modules/zod/package.json": json.dumps({"version": "4.4.3"}),
            "node_modules/qrcode-terminal/package.json": json.dumps({"version": "0.12.0"}),
        }
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def _weixin_inspection(
        self,
        installed: Path,
        *,
        enabled: bool = True,
        status: str = "loaded",
        activated: bool = True,
        tracked: bool = True,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "plugin": {
                "id": "openclaw-weixin",
                "version": "2.4.6",
                "rootDir": str(installed),
                "enabled": enabled,
                "status": status,
                "activated": activated,
            }
        }
        if tracked:
            payload["install"] = {
                "installPath": str(installed),
                "version": "2.4.6",
            }
        return payload

    @staticmethod
    def _plugin_process(output: str = "") -> unittest.mock.Mock:
        process = unittest.mock.Mock(returncode=0)
        process.communicate.return_value = (output, None)
        return process

    def test_target_version_is_current(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)

        installation = self.ws._detect_openclaw_installation()

        self.assertEqual(installation.version, OPENCLAW_TARGET_VERSION)
        self.assertTrue(self.ws.check_openclaw_windows())
        self.assertEqual(self.ws.install_prefix, prefix)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object behavior")
    def test_kill_on_close_job_terminates_assigned_process(self):
        process = subprocess.Popen(
            ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
            creationflags=0x08000000 | 0x00000004,
        )
        job = _WindowsKillOnCloseJob.attach(process)

        job.resume(process)
        job.close()
        process.wait(timeout=5)

        self.assertIsNotNone(process.returncode)

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

    def test_active_gateway_uses_listening_pid_when_lock_is_missing(self):
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=True)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)
        self.ws._find_listening_pid = unittest.mock.Mock(return_value=4321)

        gateway = self.ws.get_active_gateway()

        self.assertEqual(gateway, ActiveGateway(pid=4321, port=18789, lock_path=None))

    def test_finds_microclaw_ancestor_for_gateway(self):
        self.ws._process_snapshot = unittest.mock.Mock(
            return_value={
                100: _ProcessInfo(50, "MicroClawDesktop.exe", "MicroClawDesktop.exe"),
                200: _ProcessInfo(100, "node.exe", "node helper.js"),
                300: _ProcessInfo(200, "node.exe", "node openclaw.mjs gateway"),
            }
        )

        self.assertEqual(self.ws._find_managing_desktop_pid(300), 100)

    def test_active_installation_detects_desktop_without_a_gateway(self):
        self.ws.get_active_gateway = unittest.mock.Mock(return_value=None)
        self.ws._process_snapshot = unittest.mock.Mock(
            return_value={
                100: _ProcessInfo(50, "MicroClawDesktop.exe", "MicroClawDesktop.exe"),
                200: _ProcessInfo(100, "MicroClawDesktop.exe", "MicroClawDesktop.exe --type=gpu"),
            }
        )

        self.assertEqual(
            self.ws.get_active_installation(),
            ActiveInstallation(pids=(100,), gateway=None),
        )

    def test_unverified_port_owner_is_not_selected_for_termination(self):
        gateway = ActiveGateway(pid=300, port=18789, lock_path=None)
        self.ws.get_active_gateway = unittest.mock.Mock(return_value=gateway)
        self.ws._process_snapshot = unittest.mock.Mock(
            return_value={
                300: _ProcessInfo(50, "unrelated-server.exe", "unrelated-server.exe"),
            }
        )

        self.assertEqual(
            self.ws.get_active_installation(),
            ActiveInstallation(pids=(), gateway=gateway),
        )

    def test_confirmed_upgrade_stop_targets_only_the_managing_process_tree(self):
        gateway = ActiveGateway(
            pid=300,
            port=18789,
            lock_path=self.local_appdata / "Temp" / "openclaw" / "gateway.lock",
        )
        active = ActiveInstallation(pids=(100,), gateway=gateway)
        self.ws.get_active_installation = unittest.mock.Mock(side_effect=[active, None])
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )

        with unittest.mock.patch("deployer.windows_setup.process_is_alive", return_value=False):
            self.assertTrue(self.ws.stop_active_installation_for_upgrade(active))

        self.ws._run.assert_any_call(
            ["taskkill", "/PID", "100", "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertFalse(
            any(
                "/IM" in call.args[0] or "node.exe" in call.args[0]
                for call in self.ws._run.call_args_list
            )
        )

    def test_unknown_port_owner_is_never_terminated(self):
        gateway = ActiveGateway(pid=300, port=18789, lock_path=None)
        active = ActiveInstallation(pids=(), gateway=gateway)
        self.ws.get_active_installation = unittest.mock.Mock(return_value=active)
        self.ws._run = unittest.mock.Mock()

        self.assertFalse(self.ws.stop_active_installation_for_upgrade(active))

        self.ws._run.assert_not_called()

    def test_prepare_uses_managed_state_transaction_for_unchanged_installation(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)
        self.ws._same_version_weixin_requires_full_backup = unittest.mock.Mock(return_value=False)
        transaction = unittest.mock.Mock()

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.create",
            return_value=transaction,
        ) as create:
            self.assertTrue(self.ws.prepare_openclaw_upgrade())

        create.assert_called_once()
        self.assertEqual(
            create.call_args.kwargs["backup_mode"],
            UpgradeBackupMode.MANAGED_STATE,
        )
        transaction.backup.assert_called_once()
        self.assertEqual(self.ws.install_prefix, prefix)
        self.assertFalse(self.ws._openclaw_upgrade_required)
        self.assertIs(self.ws._openclaw_transaction, transaction)

    def test_prepare_uses_full_transaction_when_same_version_plugin_needs_repair(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=False)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)
        self.ws._same_version_weixin_requires_full_backup = unittest.mock.Mock(return_value=True)
        transaction = unittest.mock.Mock()

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.create",
            return_value=transaction,
        ) as create:
            self.assertTrue(self.ws.prepare_openclaw_upgrade())

        self.assertEqual(create.call_args.kwargs["backup_mode"], UpgradeBackupMode.FULL)
        self.assertTrue(self.ws._weixin_plugin_mutation_required)
        transaction.backup.assert_called_once()

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

    def test_resolve_target_node_version_bumps_to_installed_major(self):
        # An already-installed newer Node (e.g. 24.x) must not be downgraded to
        # the default 22.x line — the MSI refuses to install an older version.
        self.ws.node_version = "22"
        self.ws._installed_node_major = lambda: 24
        self.ws._resolve_latest_version = lambda major: {
            "22": "22.23.1",
            "24": "24.15.0",
        }[major]

        self.assertEqual(self.ws._resolve_target_node_version(), "24.15.0")

    def test_resolve_target_node_version_keeps_default_when_no_newer(self):
        self.ws.node_version = "22"
        self.ws._resolve_latest_version = lambda major: "22.23.1" if major == "22" else "wrong"

        self.ws._installed_node_major = lambda: None
        self.assertEqual(self.ws._resolve_target_node_version(), "22.23.1")

        self.ws._installed_node_major = lambda: 20
        self.assertEqual(self.ws._resolve_target_node_version(), "22.23.1")

    def test_installed_node_major_reads_highest(self):
        with (
            unittest.mock.patch(
                "deployer.windows_setup.shutil.which", return_value="C:/node/node.exe"
            ),
            unittest.mock.patch("deployer.windows_setup._STANDARD_NODE_DIRS", ()),
        ):
            self.ws._get_node_version = lambda _path: "v24.14.0"
            self.assertEqual(self.ws._installed_node_major(), 24)

    def test_installed_node_major_none_when_absent(self):
        with (
            unittest.mock.patch("deployer.windows_setup.shutil.which", return_value=None),
            unittest.mock.patch("deployer.windows_setup._STANDARD_NODE_DIRS", ()),
        ):
            self.assertIsNone(self.ws._installed_node_major())

    def test_install_node_raises_blocked_on_launch_condition(self):
        # A downgrade-blocked MSI (exit 1603, "later version already installed")
        # is deterministic: raise NodeInstallBlocked so the pipeline stops
        # instead of re-prompting UAC on every retry.
        self.ws._mirror_name = MIRROR_OFFICIAL
        self.ws.node_version = "22"
        self.ws._resolve_target_node_version = lambda: "24.15.0"
        self.ws._download_and_verify_node_msi = lambda _version, _path: True
        self.ws._get_arch = lambda: "x64"

        fake_tmp = self.root / "node_tmp"
        fake_tmp.mkdir()

        def fake_run(_cmd, **_kwargs):
            (fake_tmp / "msi-install.log").write_text(
                "Product: Node.js -- A later version of Node.js is already installed.",
                encoding="utf-16-le",
            )
            return SimpleNamespace(returncode=1603, stdout="", stderr="")

        self.ws._run = fake_run

        with (
            unittest.mock.patch(
                "deployer.windows_setup.tempfile.mkdtemp", return_value=str(fake_tmp)
            ),
            self.assertRaises(NodeInstallBlocked),
        ):
            self.ws.install_node_windows()

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

    def test_run_openclaw_json_uses_cold_start_tolerant_timeout(self):
        # Each RPC probe cold-starts the OpenClaw CLI; the timeout must be well
        # above the CLI boot time and the client must share the compile cache.
        self.ws._find_openclaw_cmd = lambda: ["openclaw.cmd"]
        self.ws._get_env = lambda: {}
        self.ws._load_openclaw_state_env = lambda _state: {}
        captured = {}

        def fake_run(_cmd, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            captured["env"] = kwargs.get("env")
            return SimpleNamespace(returncode=0, stdout='{"ok": true}', stderr="")

        self.ws._run = fake_run
        result = self.ws._run_openclaw_json(["gateway", "call", "config.get", "--json"])

        self.assertEqual(result, {"ok": True})
        self.assertEqual(captured["timeout"], _OPENCLAW_RPC_TIMEOUT)
        self.assertGreaterEqual(_OPENCLAW_RPC_TIMEOUT, 60)
        self.assertIn("NODE_COMPILE_CACHE", captured["env"])

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

    def test_same_version_fast_path_runs_health_without_deep_rpc_checks(self):
        self.ws._openclaw_upgrade_required = False
        transaction = unittest.mock.Mock()
        self.ws._openclaw_transaction = transaction
        process = unittest.mock.Mock()
        self.ws._validate_installed_version = unittest.mock.Mock(return_value=True)
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=True)
        self.ws._validate_appcontainer_smoke = unittest.mock.Mock(return_value=True)
        self.ws._validate_gateway_rpc = unittest.mock.Mock()

        self.assertTrue(self.ws.verify_openclaw_upgrade())

        self.ws._validate_installed_version.assert_called_once()
        self.ws._start_validation_gateway.assert_called_once()
        self.ws._validate_gateway_health.assert_called_once()
        self.ws._validate_appcontainer_smoke.assert_called_once()
        self.ws._validate_gateway_rpc.assert_not_called()
        self.ws._stop_validation_gateway.assert_called_once_with(process)
        transaction.mark_verifying.assert_called_once()
        self.assertEqual(
            [call.args for call in transaction.record_validation.call_args_list],
            [
                ("version", True),
                ("health", True),
                ("appcontainer", True),
            ],
        )

    def test_same_version_plugin_repair_validates_plugin_before_commit(self):
        self.ws._openclaw_upgrade_required = False
        self.ws._weixin_plugin_mutation_required = True
        transaction = unittest.mock.Mock()
        self.ws._openclaw_transaction = transaction
        process = unittest.mock.Mock()
        self.ws._validate_installed_version = unittest.mock.Mock(return_value=True)
        self.ws._start_validation_gateway = unittest.mock.Mock(return_value=process)
        self.ws._stop_validation_gateway = unittest.mock.Mock()
        self.ws._validate_gateway_health = unittest.mock.Mock(return_value=True)
        self.ws._validate_weixin_plugin = unittest.mock.Mock(return_value=True)
        self.ws._validate_appcontainer_smoke = unittest.mock.Mock(return_value=True)

        self.assertTrue(self.ws.verify_openclaw_upgrade())

        self.assertEqual(
            [call.args for call in transaction.record_validation.call_args_list],
            [
                ("version", True),
                ("health", True),
                ("weixin-plugin", True),
                ("appcontainer", True),
            ],
        )

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

    def test_weixin_install_skips_matching_bundled_payload(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self._write_weixin_payload(installed)
        peer = installed / "node_modules" / "openclaw" / "package.json"
        peer.parent.mkdir(parents=True)
        peer.write_text("{}", encoding="utf-8")
        config = installed.parents[1] / "openclaw.json"
        config.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {
                            "openclaw-weixin": {
                                "enabled": False,
                            }
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(
            return_value=self._weixin_inspection(installed, enabled=False, status="disabled")
        )

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen") as popen:
            self.assertTrue(self.ws.install_weixin_plugin())

        self.ws._inspect_weixin_plugin.assert_called_once()
        popen.assert_not_called()

    def test_weixin_missing_entry_stays_on_fast_path_when_official_registration_matches(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self._write_weixin_payload(installed)
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "allow": [],
                        "deny": [],
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(
            return_value=self._weixin_inspection(installed)
        )

        self.assertFalse(self.ws._same_version_weixin_requires_full_backup())

        self.assertFalse(self.ws._weixin_policy_snapshot.entry_present)
        self.assertTrue(self.ws._weixin_registration_verified)

    def test_weixin_matching_payload_repairs_missing_config_record(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self._write_weixin_payload(installed)
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(return_value={})
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        process = self._plugin_process()

        with unittest.mock.patch(
            "deployer.windows_setup.subprocess.Popen", return_value=process
        ) as popen:
            self.assertTrue(self.ws.install_weixin_plugin())

        self.assertEqual(
            popen.call_args.args[0],
            ["openclaw.cmd", "plugins", "install", "--force", str(bundled)],
        )

    def test_weixin_install_uses_force_without_deleting_existing_plugin(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        old_marker = installed / "old-only.txt"
        old_marker.write_text("preserve until OpenClaw replaces it", encoding="utf-8")
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        process = self._plugin_process()

        with unittest.mock.patch(
            "deployer.windows_setup.subprocess.Popen", return_value=process
        ) as popen:
            self.assertTrue(self.ws.install_weixin_plugin())

        command = popen.call_args.args[0]
        self.assertEqual(
            command,
            ["openclaw.cmd", "plugins", "install", "--force", str(bundled)],
        )
        self.assertEqual(popen.call_args.kwargs["creationflags"], 0x08000000 | 0x00000004)
        self.assertTrue(old_marker.exists())
        process.communicate.assert_called_once_with(timeout=120)
        self.ws._create_process_lifetime_job.assert_called_once_with(process)
        self.process_job.resume.assert_called_once_with(process)
        self.process_job.close.assert_called()
        self.ws._run.assert_called_once()

    def test_weixin_install_timeout_terminates_job_before_returning(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        process = unittest.mock.Mock(returncode=None, pid=4321)
        process.communicate.side_effect = subprocess.TimeoutExpired("openclaw", 120)
        process.poll.return_value = 1

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen", return_value=process):
            self.assertFalse(self.ws.install_weixin_plugin())

        self.process_job.close.assert_called()
        process.wait.assert_called_once_with(timeout=15)

    def test_weixin_force_install_restores_user_plugin_policy(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "allow": ["other-plugin"],
                        "deny": ["openclaw-weixin"],
                        "entries": {
                            "openclaw-weixin": {
                                "enabled": False,
                            }
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={"TEST": "1"})
        process = self._plugin_process()
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen", return_value=process):
            self.assertTrue(self.ws.install_weixin_plugin())

        restore = self.ws._run.call_args
        self.assertEqual(
            restore.args[0],
            [
                "openclaw.cmd",
                "config",
                "patch",
                "--stdin",
                "--replace-path",
                "plugins.entries.openclaw-weixin",
                "--replace-path",
                "plugins.allow",
                "--replace-path",
                "plugins.deny",
            ],
        )
        self.assertEqual(
            json.loads(restore.kwargs["input"]),
            {
                "plugins": {
                    "entries": {"openclaw-weixin": {"enabled": False}},
                    "enabled": None,
                    "allow": ["other-plugin"],
                    "deny": ["openclaw-weixin"],
                }
            },
        )
        self.assertEqual(restore.kwargs["env"]["TEST"], "1")
        self.assertEqual(
            restore.kwargs["env"]["OPENCLAW_STATE_DIR"],
            str(self.home / ".openclaw"),
        )

    def test_weixin_force_install_preserves_global_policy_without_existing_entry(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "allow": ["other-plugin"],
                        "deny": ["openclaw-weixin"],
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        process = self._plugin_process()

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen", return_value=process):
            self.assertTrue(self.ws.install_weixin_plugin())

        patch = json.loads(self.ws._run.call_args.kwargs["input"])
        self.assertEqual(
            patch,
            {
                "plugins": {
                    "entries": {"openclaw-weixin": None},
                    "enabled": None,
                    "allow": ["other-plugin"],
                    "deny": ["openclaw-weixin"],
                }
            },
        )
        self.assertFalse(self.ws._weixin_policy_snapshot.expects_enabled)

    def test_weixin_policy_treats_empty_allow_as_open_and_global_disable_as_closed(self):
        state_dir = self.home / ".openclaw"
        state_dir.mkdir()
        config_path = state_dir / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "allow": [],
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )

        policy = self.ws._read_weixin_plugin_policy(state_dir)

        self.assertIsNotNone(policy)
        self.assertTrue(policy.expects_enabled)

        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "enabled": False,
                        "allow": [],
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )

        policy = self.ws._read_weixin_plugin_policy(state_dir)

        self.assertIsNotNone(policy)
        self.assertFalse(policy.expects_enabled)

    def test_weixin_policy_restore_retry_does_not_reinstall_or_reread_policy(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "allow": ["other-plugin"],
                        "deny": ["openclaw-weixin"],
                        "entries": {"openclaw-weixin": {"enabled": False}},
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._run = unittest.mock.Mock(
            side_effect=[
                SimpleNamespace(returncode=1, stdout="", stderr="transient"),
                SimpleNamespace(returncode=0, stdout="", stderr=""),
            ]
        )
        process = self._plugin_process()

        with unittest.mock.patch(
            "deployer.windows_setup.subprocess.Popen", return_value=process
        ) as popen:
            self.assertFalse(self.ws.install_weixin_plugin())
            self.assertTrue(self.ws._weixin_policy_restore_pending)
            config_path.write_text(
                json.dumps(
                    {
                        "plugins": {
                            "allow": ["openclaw-weixin"],
                            "entries": {"openclaw-weixin": {"enabled": True}},
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertTrue(self.ws.install_weixin_plugin())

        popen.assert_called_once()
        self.assertEqual(self.ws._run.call_count, 2)
        first_patch = json.loads(self.ws._run.call_args_list[0].kwargs["input"])
        second_patch = json.loads(self.ws._run.call_args_list[1].kwargs["input"])
        self.assertEqual(first_patch, second_patch)
        self.assertEqual(first_patch["plugins"]["allow"], ["other-plugin"])
        self.assertEqual(first_patch["plugins"]["deny"], ["openclaw-weixin"])
        self.assertFalse(self.ws._weixin_policy_restore_pending)

    def test_weixin_matching_payload_with_missing_official_record_is_reinstalled(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self._write_weixin_payload(installed)
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(
            return_value=self._weixin_inspection(installed, tracked=False)
        )
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        process = self._plugin_process()

        with unittest.mock.patch(
            "deployer.windows_setup.subprocess.Popen", return_value=process
        ) as popen:
            self.assertTrue(self.ws.install_weixin_plugin())

        popen.assert_called_once()

    def test_weixin_force_install_refuses_lightweight_transaction_after_state_changes(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled, marker="new")
        self._write_weixin_payload(installed, marker="old")
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )
        transaction = unittest.mock.Mock()
        transaction.manifest.backup_mode = UpgradeBackupMode.MANAGED_STATE
        self.ws._openclaw_transaction = transaction
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen") as popen:
            self.assertFalse(self.ws.install_weixin_plugin())

        popen.assert_not_called()

    def test_weixin_install_rechecks_cached_registration_before_fast_path(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self._write_weixin_payload(installed)
        config_path = installed.parents[1] / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {"openclaw-weixin": {"enabled": True}},
                    }
                }
            ),
            encoding="utf-8",
        )
        transaction = unittest.mock.Mock()
        transaction.manifest.backup_mode = UpgradeBackupMode.MANAGED_STATE
        self.ws._openclaw_transaction = transaction
        self.ws._weixin_registration_verified = True
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._find_openclaw_cmd = unittest.mock.Mock(return_value=["openclaw.cmd"])
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(
            return_value=self._weixin_inspection(installed, tracked=False)
        )

        with unittest.mock.patch("deployer.windows_setup.subprocess.Popen") as popen:
            self.assertFalse(self.ws.install_weixin_plugin())

        self.ws._inspect_weixin_plugin.assert_called_once()
        popen.assert_not_called()

    def test_weixin_validation_accepts_user_disabled_plugin(self):
        bundled = self.root / "bundled-weixin"
        installed = self.home / ".openclaw" / "extensions" / "openclaw-weixin"
        self._write_weixin_payload(bundled)
        self.ws._find_bundled_weixin_plugin = unittest.mock.Mock(return_value=bundled)
        self.ws._inspect_weixin_plugin = unittest.mock.Mock(
            return_value=self._weixin_inspection(
                installed,
                enabled=False,
                status="disabled",
                activated=False,
            )
        )
        self.ws._weixin_policy_snapshot = WeixinPluginPolicy(
            plugins_enabled_present=False,
            plugins_enabled=None,
            entry_present=True,
            entry={"enabled": False},
            allow_present=True,
            allow=["other-plugin"],
            deny_present=True,
            deny=["openclaw-weixin"],
        )

        self.assertTrue(self.ws._validate_weixin_plugin())

    def test_write_config_preserves_existing_weixin_plugin_settings(self):
        config_path = self.home / ".openclaw" / "openclaw.json"
        config_path.parent.mkdir(parents=True)
        plugins = {
            "allow": ["openclaw-weixin"],
            "entries": {
                "openclaw-weixin": {
                    "enabled": False,
                    "config": {"userSetting": "preserved"},
                }
            },
        }
        config_path.write_text(json.dumps({"plugins": plugins}), encoding="utf-8")
        self.ws._deploy_managed_skills = unittest.mock.Mock()
        self.ws._install_officecli = unittest.mock.Mock()
        self.ws._generate_skill_snapshot = unittest.mock.Mock()

        self.assertTrue(self.ws.write_config())

        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            written["plugins"]["entries"]["openclaw-weixin"], plugins["entries"]["openclaw-weixin"]
        )
        self.assertIn("openclaw-weixin", written["plugins"]["allow"])

    def test_write_config_defaults_fresh_install_to_parallel_free_search(self):
        self.ws._deploy_managed_skills = unittest.mock.Mock()
        self.ws._install_officecli = unittest.mock.Mock()
        self.ws._generate_skill_snapshot = unittest.mock.Mock()

        self.assertTrue(self.ws.write_config())

        config_path = self.home / ".openclaw" / "openclaw.json"
        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(written["tools"]["web"]["search"], {"provider": "parallel-free"})
        self.assertEqual(written["plugins"]["entries"]["parallel"], {"enabled": True})

    def test_write_config_preserves_existing_web_search_provider(self):
        config_path = self.home / ".openclaw" / "openclaw.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            json.dumps({"tools": {"web": {"search": {"provider": "tavily", "apiKey": "key"}}}}),
            encoding="utf-8",
        )
        self.ws._deploy_managed_skills = unittest.mock.Mock()
        self.ws._install_officecli = unittest.mock.Mock()
        self.ws._generate_skill_snapshot = unittest.mock.Mock()

        self.assertTrue(self.ws.write_config())

        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            written["tools"]["web"]["search"],
            {"provider": "tavily", "apiKey": "key"},
        )

    def test_write_config_existing_provider_wins_over_installer_brave_key(self):
        config_path = self.home / ".openclaw" / "openclaw.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            json.dumps({"tools": {"web": {"search": {"provider": "tavily", "apiKey": "key"}}}}),
            encoding="utf-8",
        )
        self.ws.cfg = _Config({"brave.api_key": "installer-brave-key"})
        self.ws._deploy_managed_skills = unittest.mock.Mock()
        self.ws._install_officecli = unittest.mock.Mock()
        self.ws._generate_skill_snapshot = unittest.mock.Mock()

        self.assertTrue(self.ws.write_config())

        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            written["tools"]["web"]["search"],
            {"provider": "tavily", "apiKey": "key"},
        )

    def test_write_config_replaces_keyless_paid_provider_with_parallel_free(self):
        for provider in ("brave", "tavily"):
            with self.subTest(provider=provider):
                config_path = self.home / ".openclaw" / "openclaw.json"
                config_path.parent.mkdir(parents=True, exist_ok=True)
                config_path.write_text(
                    json.dumps({"tools": {"web": {"search": {"provider": provider}}}}),
                    encoding="utf-8",
                )
                self.ws._deploy_managed_skills = unittest.mock.Mock()
                self.ws._install_officecli = unittest.mock.Mock()
                self.ws._generate_skill_snapshot = unittest.mock.Mock()

                self.assertTrue(self.ws.write_config())

                written = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(
                    written["tools"]["web"]["search"],
                    {"provider": "parallel-free"},
                )
                self.assertEqual(
                    written["plugins"]["entries"]["parallel"],
                    {"enabled": True},
                )

    def test_install_search_provider_plugin_installs_parallel_package(self):
        config_path = self.home / ".openclaw" / "openclaw.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            json.dumps({"tools": {"web": {"search": {"provider": "parallel-free"}}}}),
            encoding="utf-8",
        )
        self.ws._weixin_cli_context = unittest.mock.Mock(
            return_value=(["openclaw.cmd"], {"OPENCLAW_STATE_DIR": str(config_path.parent)})
        )
        self.ws._run_openclaw_json = unittest.mock.Mock(side_effect=RuntimeError("not installed"))
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=0, stdout="installed", stderr="")
        )

        self.assertTrue(self.ws.install_search_provider_plugin())

        self.ws._run.assert_called_once()
        self.assertEqual(
            self.ws._run.call_args.args[0],
            ["openclaw.cmd", "plugins", "install", "@openclaw/parallel-plugin"],
        )

    def test_install_search_provider_plugin_preserves_other_provider(self):
        config_path = self.home / ".openclaw" / "openclaw.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            json.dumps({"tools": {"web": {"search": {"provider": "tavily", "apiKey": "key"}}}}),
            encoding="utf-8",
        )
        self.ws._weixin_cli_context = unittest.mock.Mock()

        self.assertTrue(self.ws.install_search_provider_plugin())

        self.ws._weixin_cli_context.assert_not_called()

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
        self.ws._process_snapshot = unittest.mock.Mock(return_value={})
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
        self.ws._run.assert_not_called()

    def test_install_uninstaller_bundle_publishes_source_and_checks_persisted_exe(self):
        source = self.root / "dist" / "MicroClawInstaller"
        destination = self.home / ".openclaw"
        persisted = destination / "MicroClawInstaller.exe"
        self.ws._check_persisted_uninstaller = unittest.mock.Mock()
        self.ws.log.warn = unittest.mock.Mock()

        with (
            unittest.mock.patch(
                "deployer.windows_setup.resolve_uninstaller_bundle",
                return_value=source,
            ) as resolve,
            unittest.mock.patch(
                "deployer.windows_setup.publish_uninstaller_bundle",
                return_value=persisted,
            ) as publish,
        ):
            self.assertTrue(self.ws.install_uninstaller_bundle())

        resolve.assert_called_once()
        publish.assert_called_once_with(
            source,
            destination,
            self.ws._check_persisted_uninstaller,
            cleanup_error_handler=self.ws.log.warn,
        )

    def test_install_uninstaller_bundle_reports_failure(self):
        with unittest.mock.patch(
            "deployer.windows_setup.resolve_uninstaller_bundle",
            side_effect=UninstallerBundleError("build installer first"),
        ):
            self.assertFalse(self.ws.install_uninstaller_bundle())

    def test_persisted_uninstaller_check_rejects_nonzero_exit(self):
        exe = self.root / "MicroClawInstaller.exe"
        self.ws._run = unittest.mock.Mock(
            return_value=SimpleNamespace(returncode=3, stdout="", stderr="runtime failed")
        )

        with self.assertRaisesRegex(UninstallerBundleError, "runtime failed"):
            self.ws._check_persisted_uninstaller(exe)

        self.ws._run.assert_called_once_with(
            [str(exe), "--check-uninstaller"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_persisted_uninstaller_check_rejects_timeout(self):
        exe = self.root / "MicroClawInstaller.exe"
        self.ws._run = unittest.mock.Mock(
            side_effect=subprocess.TimeoutExpired([str(exe)], timeout=30)
        )

        with self.assertRaisesRegex(UninstallerBundleError, "timed out"):
            self.ws._check_persisted_uninstaller(exe)

    def test_persisted_uninstaller_check_rejects_launch_error(self):
        exe = self.root / "MicroClawInstaller.exe"
        self.ws._run = unittest.mock.Mock(
            side_effect=FileNotFoundError(2, "No such file or directory")
        )

        with self.assertRaisesRegex(UninstallerBundleError, "could not launch"):
            self.ws._check_persisted_uninstaller(exe)

    def _write_persisted_uninstaller(self):
        state = self.home / ".openclaw"
        state.mkdir(parents=True, exist_ok=True)
        (state / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")
        (state / "_internal").mkdir(exist_ok=True)
        (state / "_internal" / "runtime.dll").write_text("runtime", encoding="utf-8")
        return state / "MicroClawInstaller.exe"

    def test_register_installed_app_refuses_missing_uninstaller(self):
        fake_winreg = unittest.mock.MagicMock()
        with unittest.mock.patch.dict("sys.modules", {"winreg": fake_winreg}):
            self.assertFalse(self.ws._register_installed_app(None))
        fake_winreg.CreateKeyEx.assert_not_called()

    def test_uninstall_shortcut_refuses_missing_uninstaller(self):
        desktop = self.root / "Desktop"
        desktop.mkdir()
        self.ws._run = unittest.mock.Mock()

        self.assertFalse(self.ws._create_uninstall_shortcut(desktop))

        self.ws._run.assert_not_called()

    def _configure_entry_point_mocks(self):
        desktop_exe = self.root / ".microclaw" / "MicroClawDesktop.exe"
        self.ws._get_desktop_path = unittest.mock.Mock(return_value=self.root / "Desktop")
        self.ws._find_desktop_exe = unittest.mock.Mock(return_value=desktop_exe)
        self.ws._create_lnk_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_start_menu_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._create_uninstall_shortcut = unittest.mock.Mock(return_value=True)
        self.ws._register_installed_app = unittest.mock.Mock(return_value=True)

    def test_create_desktop_shortcut_treats_shortcut_failures_as_nonfatal(self):
        for helper_name in (
            "_create_lnk_shortcut",
            "_create_start_menu_shortcut",
            "_create_uninstall_shortcut",
        ):
            with self.subTest(helper=helper_name):
                self._configure_entry_point_mocks()
                getattr(self.ws, helper_name).return_value = False

                self.assertTrue(self.ws.create_desktop_shortcut())

                self.ws._create_lnk_shortcut.assert_called_once()
                self.ws._create_start_menu_shortcut.assert_called_once()
                self.ws._create_uninstall_shortcut.assert_called_once()
                self.ws._register_installed_app.assert_called_once()

    def test_create_desktop_shortcut_propagates_registry_failure(self):
        self._configure_entry_point_mocks()
        self.ws._register_installed_app = unittest.mock.Mock(return_value=False)

        self.assertFalse(self.ws.create_desktop_shortcut())

        self.ws._create_lnk_shortcut.assert_called_once()
        self.ws._create_start_menu_shortcut.assert_called_once()
        self.ws._create_uninstall_shortcut.assert_called_once()
        self.ws._register_installed_app.assert_called_once()

    def test_browser_fallback_failure_defers_to_registry_result(self):
        for registry_result in (True, False):
            with self.subTest(registry_result=registry_result):
                self.ws._get_desktop_path = unittest.mock.Mock(return_value=self.root / "Desktop")
                self.ws._find_desktop_exe = unittest.mock.Mock(return_value=None)
                self.ws._create_lnk_shortcut = unittest.mock.Mock()
                self.ws._create_start_menu_shortcut = unittest.mock.Mock()
                self.ws._create_url_shortcut = unittest.mock.Mock(return_value=False)
                self.ws._create_uninstall_shortcut = unittest.mock.Mock(return_value=True)
                self.ws._register_installed_app = unittest.mock.Mock(return_value=registry_result)

                self.assertEqual(self.ws.create_desktop_shortcut(), registry_result)

                self.ws._create_lnk_shortcut.assert_not_called()
                self.ws._create_start_menu_shortcut.assert_not_called()
                self.ws._create_url_shortcut.assert_called_once()
                self.ws._create_uninstall_shortcut.assert_called_once()
                self.ws._register_installed_app.assert_called_once_with(None)

    def test_url_shortcut_reports_write_failure(self):
        self.ws._resolve_icon = unittest.mock.Mock(return_value=None)

        self.assertFalse(self.ws._create_url_shortcut(self.root / "missing-desktop"))

    def test_get_start_menu_path_uses_appdata(self):
        # Force the winreg lookup to fail so the APPDATA fallback is exercised.
        fake_winreg = unittest.mock.MagicMock()
        fake_winreg.OpenKey.side_effect = OSError("no key")
        with unittest.mock.patch.dict("sys.modules", {"winreg": fake_winreg}):
            programs = self.ws._get_start_menu_path()
        self.assertEqual(
            programs,
            self.appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs",
        )

    def test_create_start_menu_shortcut_creates_lnk_and_registers_rollback(self):
        target_exe = self.root / ".microclaw" / "MicroClawDesktop.exe"
        target_exe.parent.mkdir(parents=True, exist_ok=True)
        target_exe.write_text("exe", encoding="utf-8")

        programs = self.appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        self.ws._get_start_menu_path = unittest.mock.Mock(return_value=programs)
        self.ws._resolve_icon = unittest.mock.Mock(return_value=None)

        def _fake_run(cmd, **_kwargs):
            # Simulate PowerShell creating the .lnk
            (programs / "MicroClaw.lnk").write_text("lnk", encoding="utf-8")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        self.ws._run = unittest.mock.Mock(side_effect=_fake_run)

        self.assertTrue(self.ws._create_start_menu_shortcut(target_exe))
        self.assertTrue((programs / "MicroClaw.lnk").exists())
        # PowerShell invoked via EncodedCommand
        args = self.ws._run.call_args[0][0]
        self.assertIn("-EncodedCommand", args)
        self.assertEqual(len(self.ws._rollback_actions), 1)

    def test_register_installed_app_writes_hkcu_uninstall_key(self):
        target_exe = self.root / ".microclaw" / "MicroClawDesktop.exe"
        persisted = self._write_persisted_uninstaller()
        self.ws._resolve_icon = unittest.mock.Mock(return_value=None)

        fake_winreg = unittest.mock.MagicMock()
        fake_winreg.HKEY_CURRENT_USER = 0x11111111
        fake_winreg.KEY_WRITE = 0x20006
        fake_winreg.REG_SZ = 1
        fake_winreg.REG_DWORD = 4
        fake_key = unittest.mock.MagicMock()
        fake_winreg.CreateKeyEx.return_value = fake_key

        with unittest.mock.patch.dict("sys.modules", {"winreg": fake_winreg}):
            self.assertTrue(self.ws._register_installed_app(target_exe))

        fake_winreg.CreateKeyEx.assert_called_once()
        create_args = fake_winreg.CreateKeyEx.call_args[0]
        self.assertEqual(create_args[0], fake_winreg.HKEY_CURRENT_USER)
        self.assertEqual(create_args[1], self.ws._UNINSTALL_REG_KEY)

        values = {call.args[1]: call.args[4] for call in fake_winreg.SetValueEx.call_args_list}
        self.assertEqual(values["DisplayName"], "MicroClaw")
        self.assertEqual(values["DisplayVersion"], OPENCLAW_TARGET_VERSION)
        self.assertEqual(values["UninstallString"], f'"{persisted}" --uninstall')
        self.assertEqual(values["NoModify"], 1)
        self.assertEqual(len(self.ws._rollback_actions), 1)


if __name__ == "__main__":
    unittest.main()
