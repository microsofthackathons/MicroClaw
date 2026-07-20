import json
import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

from deployer.openclaw_upgrade import UpgradePhase
from deployer.openclaw_version import OPENCLAW_TARGET_VERSION
from deployer.windows_setup import WindowsSetup


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
        self.env_patch.start()
        self.home_patch.start()

        self.ws = WindowsSetup.__new__(WindowsSetup)
        self.ws.cfg = _Config({"gateway.port": 18789, "openclaw.channel": "stable"})
        self.ws.log = _Log()
        self.ws.node_dir = self.program_files / "nodejs"
        self.ws._node_bin = None
        self.ws._git_bin = None
        self.ws._rollback_actions = []
        self.ws._openclaw_transaction = None
        self.ws.appcontainer_enabled = True
        self.ws.weixin_plugin_enabled = True

    def tearDown(self):
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

    def test_declared_closed_lock_port_wins_over_reused_live_pid(self):
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

        with unittest.mock.patch("deployer.windows_setup.process_is_alive", return_value=True):
            self.assertIsNone(self.ws._find_active_gateway_lock())

    def test_prepare_refuses_a_live_gateway_even_when_target_is_installed(self):
        prefix = self.home / ".openclaw-node"
        self._write_package(prefix, OPENCLAW_TARGET_VERSION)
        self.ws._is_tcp_port_open = unittest.mock.Mock(return_value=True)
        self.ws._find_active_gateway_lock = unittest.mock.Mock(return_value=None)

        self.assertFalse(self.ws.prepare_openclaw_upgrade())
        self.assertIsNone(self.ws._openclaw_transaction)

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

        with unittest.mock.patch(
            "deployer.windows_setup.OpenClawUpgradeTransaction.load",
            return_value=transaction,
        ):
            self.assertTrue(self.ws.recover_interrupted_openclaw_upgrade())

        transaction.rollback.assert_called_once()

    def test_registry_tls_failure_retries_next_registry(self):
        self.ws.cfg = _Config({"npm.registry": "https://registry.npmmirror.com"})
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

    def test_non_network_npm_failure_does_not_change_registry(self):
        self.ws.cfg = _Config()
        self.ws._install_openclaw_from_registry = unittest.mock.Mock(
            return_value=SimpleNamespace(
                installed_version=None,
                returncode=1,
                output="EINTEGRITY sha512 mismatch",
            )
        )

        self.assertFalse(self.ws._install_openclaw_with_registry_fallback(self.appdata / "npm"))
        self.assertEqual(self.ws._install_openclaw_from_registry.call_count, 1)

    def test_automatic_registry_fallbacks_are_https(self):
        self.ws.cfg = _Config()

        self.assertTrue(
            all(registry.startswith("https://") for registry in self.ws._npm_registry_candidates())
        )

    def test_install_uses_prepared_prefix(self):
        prepared = self.home / ".openclaw-node"
        self.ws.install_prefix = prepared
        self.ws._get_npm_path = unittest.mock.Mock(return_value="npm.cmd")
        self.ws._get_env = unittest.mock.Mock(return_value={})
        self.ws._install_openclaw_with_registry_fallback = unittest.mock.Mock(return_value=True)
        self.ws._patch_pi_ai_usage_streaming = unittest.mock.Mock()

        self.assertTrue(self.ws.install_openclaw_windows())

        self.ws._install_openclaw_with_registry_fallback.assert_called_once_with(prepared)


if __name__ == "__main__":
    unittest.main()
