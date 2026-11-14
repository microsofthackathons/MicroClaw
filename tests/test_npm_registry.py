import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deployer.npm_registry import (
    default_npm_registry,
    load_registry_config,
    normalize_npm_registry,
    registry_environment,
    resolve_npm_registry,
)
from deployer.windows_setup import WindowsSetup

ROOT = Path(__file__).resolve().parents[1]


class NpmRegistryTests(unittest.TestCase):
    def test_shared_url_contract_preserves_enterprise_feed_path_case(self):
        cases = json.loads((ROOT / "tests/fixtures/npm-registry-contract.json").read_text())
        for value, expected in cases["valid"]:
            with self.subTest(value=value):
                self.assertEqual(normalize_npm_registry(value), expected)
        for value in cases["invalid"]:
            with self.subTest(value=value), self.assertRaises(ValueError) as caught:
                normalize_npm_registry(value)
            self.assertNotIn(value, str(caught.exception))

    def test_explicit_deployment_source_wins_without_using_generic_npm_environment(self):
        with patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": "", "NPM_CONFIG_REGISTRY": "https://ambient.invalid"}):
            self.assertEqual(resolve_npm_registry(), default_npm_registry())
            self.assertEqual(resolve_npm_registry(configured="https://chosen.invalid/Feed/"), "https://chosen.invalid/Feed")
            self.assertEqual(resolve_npm_registry(dedicated="https://saved.invalid/"), "https://saved.invalid")
            self.assertEqual(resolve_npm_registry(installed={"npmRegistry": "https://legacy.invalid/"}), "https://legacy.invalid")
            self.assertEqual(resolve_npm_registry(bundled={"npmRegistry": "https://bundle.invalid/"}), "https://bundle.invalid")
        with patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": "https://deployment.invalid/"}):
            self.assertEqual(resolve_npm_registry(configured="https://chosen.invalid"), "https://deployment.invalid")

    def test_child_environment_pins_source_and_preserves_auth_proxy_and_tls(self):
        original = {"NPM_CONFIG_REGISTRY": "https://ambient.invalid", "npm_config_registry": "https://other.invalid",
                    "NPM_CONFIG_REPLACE_REGISTRY_HOST": "never", "NPM_CONFIG_CAFILE": "corporate-ca.pem",
                    "HTTPS_PROXY": "http://proxy.invalid:8080", "NPM_TOKEN": "synthetic-token"}
        before = original.copy()
        result = registry_environment(original, "https://enterprise.invalid/Feed/")
        self.assertEqual(original, before)
        self.assertEqual(result["npm_config_registry"], "https://enterprise.invalid/Feed")
        self.assertNotIn("NPM_CONFIG_REGISTRY", result)
        self.assertEqual(result["npm_config_replace_registry_host"], "npmjs")
        for key in ("NPM_CONFIG_CAFILE", "HTTPS_PROXY", "NPM_TOKEN"):
            self.assertEqual(result[key], original[key])

    def test_setup_writes_only_application_config_and_never_runs_npm_config_set(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": ""}):
            root = Path(temporary)
            user_config = root / ".npmrc"
            user_config.write_text("registry=https://user-choice.invalid/\n")
            before = user_config.read_bytes()
            setup = WindowsSetup.__new__(WindowsSetup)
            setup.cfg = SimpleNamespace(get=lambda key, default=None: {"npm.registry": "https://enterprise.invalid/Feed/"}.get(key, default))
            setup.log = Mock()
            setup._run = Mock(side_effect=AssertionError("npm config must not be mutated"))
            with patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", root / "app"):
                self.assertTrue(setup.setup_npm_mirror())
                self.assertEqual(load_registry_config(root / "app/install-state/npm-registry.json"), "https://enterprise.invalid/Feed")
            self.assertEqual(user_config.read_bytes(), before)
            setup._run.assert_not_called()

    def test_only_explicitly_configured_fallbacks_are_attempted_in_order(self):
        setup = WindowsSetup.__new__(WindowsSetup)
        values = {"npm.registry": "https://enterprise.invalid/Feed/"}
        setup.cfg = SimpleNamespace(get=lambda key, default=None: values.get(key, default))
        setup._reachable_npm_registries = Mock(side_effect=AssertionError("No unsolicited source probes"))
        with patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": ""}):
            self.assertEqual(setup._npm_registry_attempts(), ["https://enterprise.invalid/Feed"])
            values["npm.fallback_registries"] = ["https://approved-backup.invalid/", "https://enterprise.invalid/Feed/"]
            self.assertEqual(setup._npm_registry_attempts(), ["https://enterprise.invalid/Feed", "https://approved-backup.invalid"])

    def test_committed_fallback_source_matches_runtime_application_config(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": ""}):
            root = Path(temporary)
            setup = WindowsSetup.__new__(WindowsSetup)
            setup.cfg = SimpleNamespace(get=lambda key, default=None: {"npm.registry": "https://primary.invalid/"}.get(key, default))
            setup.log = Mock()
            setup.use_bundled_runtime = True
            setup._bundled_upgrade = Mock()
            setup._bundled_upgrade.commit.return_value = []
            setup._successful_npm_registry = "https://approved-backup.invalid/Feed/"
            setup._bundled_install_manifest = {
                "schema": 2, "desktopArchiveSha256": "desktop", "installerBundleId": "installer",
                "managedSkillsId": "skills", "openClawVersion": "2026.10.10", "mxcSchema": 1,
            }
            setup._install_manifest_path = root / "install-state/install-manifest.json"
            with patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", root):
                self.assertTrue(setup.commit_openclaw_upgrade())
            source = load_registry_config(root / "install-state/npm-registry.json")
            self.assertEqual(source, "https://approved-backup.invalid/Feed")
            self.assertEqual(json.loads(setup._install_manifest_path.read_text())["npmRegistry"], source)


    def test_saved_enterprise_source_does_not_trigger_public_registry_mirror_probes(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"MICROCLAW_NPM_REGISTRY": ""}):
            root = Path(temporary)
            source = root / "install-state/npm-registry.json"
            source.parent.mkdir()
            source.write_text(json.dumps({"schema": 1, "registry": "https://enterprise.invalid/Feed/"}))
            with patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", root), patch(
                "deployer.windows_setup.resolve_bundled_install_manifest", return_value=None
            ):
                setup = WindowsSetup(SimpleNamespace(get=lambda key, default=None: default), Mock())
                self.assertFalse(setup._mirror_probe_pending)
                self.assertEqual(setup._desired_npm_registry(), "https://enterprise.invalid/Feed")


if __name__ == "__main__":
    unittest.main()
