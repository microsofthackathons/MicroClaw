import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deployer.openclaw_version import OPENCLAW_TARGET_VERSION
from deployer.windows_setup import WindowsSetup


class BundledInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.desktop = self.home / ".microclaw"
        self.appdata = self.root / "roaming"
        self.state = self.home / ".openclaw"
        self.runtime = self.appdata / "microclaw/runtime/openclaw"
        for context in (
            patch.dict(
                os.environ,
                {"APPDATA": str(self.appdata), "OPENCLAW_NODE_DIR": str(self.root / "node")},
            ),
            patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", self.desktop),
            patch("deployer.windows_setup.Path.home", return_value=self.home),
        ):
            context.start()
            self.addCleanup(context.stop)
        config = Mock()
        config.get.side_effect = lambda _key, default=None: default
        self.setup = WindowsSetup(config, Mock())
        self.setup.use_bundled_runtime = True
        self.setup._package_upgrade_is_idle = Mock(return_value=True)
        self.setup._gateway_is_stopped_for_upgrade = Mock(return_value=True)
        self.setup._process_snapshot = Mock(return_value={})
        self.setup._openclaw_search_roots = Mock(return_value=[])
        self.setup._add_to_user_path = Mock()
        self.setup._bundled_install_manifest = None
        self.setup._get_env = Mock(return_value={})
        self.setup._run = Mock(side_effect=self.run_helper)
        self.setup._install_openclaw_with_registry_fallback = Mock(
            side_effect=AssertionError("Core npm install is forbidden")
        )
        self.archive = self.root / "desktop.zip"
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name in (
                "MicroClawDesktop.exe",
                "resources/app.asar",
                "resources/node.exe",
                "resources/openclaw.asar",
            ):
                archive.writestr(name, "new-" + name)
        self.setup._find_local_desktop_zip = Mock(return_value=self.archive)
        self.setup._desktop_install_is_current = Mock(return_value=False)
        self.addCleanup(self.close_transaction)

    def close_transaction(self):
        if self.setup._bundled_upgrade:
            self.setup._bundled_upgrade.close()

    def run_helper(self, command, **_kwargs):
        if "--prepare-installer-runtime" in command:
            package = self.runtime / "node_modules/openclaw"
            package.mkdir(parents=True, exist_ok=True)
            (package / "package.json").write_text(
                json.dumps({"name": "openclaw", "version": OPENCLAW_TARGET_VERSION})
            )
            (package / "openclaw.mjs").write_text("entry")
            (self.runtime / ".microclaw-version").write_text("fixture-cache")
            return SimpleNamespace(
                returncode=0,
                stdout="MICROCLAW_INSTALLER_RUNTIME "
                + json.dumps({"runtimeRoot": str(self.runtime)}),
                stderr="",
            )
        if command[-2:] == ["config", "validate"]:
            return SimpleNamespace(returncode=0, stdout="valid", stderr="")
        raise AssertionError(f"Unexpected command: {command}")

    def test_new_install_uses_bundled_runtime_without_npm_core_or_gateway_launch(self):
        self.assertTrue(self.setup.prepare_openclaw_update())
        self.assertTrue(self.setup.prepare_openclaw_upgrade())
        self.assertTrue(self.setup.install_desktop_client())
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "openclaw.json").write_text('{"gateway":{"mode":"local"}}')
        with patch.object(self.setup, "_validate_bundled_migration") as migrate:
            self.assertTrue(self.setup.begin_openclaw_upgrade_validation())
            self.assertTrue(self.setup.commit_openclaw_upgrade())
        migrate.assert_not_called()
        self.setup._install_openclaw_with_registry_fallback.assert_not_called()
        command = self.setup._find_openclaw_cmd()
        self.assertEqual(
            command,
            [
                str(self.desktop / "resources/node.exe"),
                str(self.runtime / "node_modules/openclaw/openclaw.mjs"),
            ],
        )
        self.assertTrue((self.desktop / "microclaw-openclaw.cmd").is_file())
        self.assertEqual(
            json.loads((self.desktop / "upgrade/bundled-upgrade.json").read_text())["phase"],
            "committed",
        )

    def test_incomplete_desktop_package_fails_before_success_and_recovers(self):
        self.assertTrue(self.setup.prepare_openclaw_upgrade())
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("MicroClawDesktop.exe", "incomplete")
        self.assertFalse(self.setup.install_desktop_client())
        self.assertTrue(self.setup.rollback_openclaw_upgrade())
        self.assertFalse((self.desktop / "MicroClawDesktop.exe").exists())
        self.setup._install_openclaw_with_registry_fallback.assert_not_called()

    def test_unknown_existing_data_is_not_overwritten_without_a_snapshot_source(self):
        self.state.mkdir(parents=True)
        config = self.state / "openclaw.json"
        config.write_text('{"keep":true}')
        self.assertFalse(self.setup.prepare_openclaw_upgrade())
        self.assertEqual(config.read_text(), '{"keep":true}')
        self.assertTrue(self.setup.rollback_openclaw_upgrade())
        self.setup._run.assert_not_called()

    def test_cross_version_validation_requires_migration_before_commit(self):
        self.assertTrue(self.setup.prepare_openclaw_upgrade())
        self.assertTrue(self.setup.install_desktop_client())
        tx = self.setup._bundled_upgrade
        tx.data["sourceVersion"] = "2026.10.5"
        with patch.object(
            self.setup,
            "_validate_bundled_migration",
            side_effect=RuntimeError("history unavailable"),
        ) as migrate:
            self.assertFalse(self.setup.begin_openclaw_upgrade_validation())
        migrate.assert_called_once()
        self.assertNotEqual(tx.data["phase"], "committed")

    def test_malformed_user_config_is_preserved_instead_of_reset(self):
        self.state.mkdir(parents=True)
        config = self.state / "openclaw.json"
        config.write_text("malformed-user-config")
        self.assertFalse(self.setup.write_config())
        self.assertEqual(config.read_text(), "malformed-user-config")

    def test_manifest_digest_mismatch_cannot_publish_the_desktop(self):
        self.setup._bundled_install_manifest = {"desktopArchiveSha256": "0" * 64}
        self.assertTrue(self.setup.prepare_openclaw_upgrade())
        self.assertFalse(self.setup.install_desktop_client())
        self.assertFalse((self.desktop / "MicroClawDesktop.exe").exists())
        self.assertTrue(self.setup.rollback_openclaw_upgrade())


if __name__ == "__main__":
    unittest.main()
