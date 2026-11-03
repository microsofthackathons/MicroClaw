import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deployer.openclaw_upgrade import managed_state_paths
from deployer.windows_setup import WindowsSetup


class DeferredSearchProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.state = self.home / ".openclaw"
        self.state.mkdir()
        self.config_path = self.state / "openclaw.json"
        self.pending_path = self.state / "microclaw-search-setup.json"
        self.config = {
            "tools": {"web": {"search": {"provider": "parallel-free", "maxResults": 7}}},
            "plugins": {
                "entries": {"parallel": {"enabled": True, "config": {"example": True}}},
                "allow": ["parallel", "other"],
            },
            "models": {"preserved": True},
        }
        self.write_config()
        self.setup = WindowsSetup.__new__(WindowsSetup)
        self.setup.log = unittest.mock.Mock()
        self.setup._parallel_plugin_is_installed_locally = unittest.mock.Mock(return_value=False)
        self.setup._run = unittest.mock.Mock(
            side_effect=AssertionError("Must not run a subprocess")
        )
        patch = unittest.mock.patch("deployer.windows_setup.Path.home", return_value=self.home)
        patch.start()
        self.addCleanup(patch.stop)

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

    def test_missing_plugin_is_queued_without_network_or_invalid_startup_configuration(self):
        self.assertTrue(self.setup.defer_search_provider_plugin())
        written = json.loads(self.config_path.read_text(encoding="utf-8"))
        pending = json.loads(self.pending_path.read_text(encoding="utf-8"))
        self.assertEqual(pending["search"], self.config["tools"]["web"]["search"])
        self.assertEqual(pending["pluginEntry"], self.config["plugins"]["entries"]["parallel"])
        self.assertEqual(written["tools"]["web"]["search"], {"enabled": False, "maxResults": 7})
        self.assertEqual(pending["suspendedSearch"], written["tools"]["web"]["search"])
        self.assertNotIn("parallel", written["plugins"]["entries"])
        self.assertEqual(written["plugins"]["allow"], ["other"])
        self.assertEqual(written["models"], self.config["models"])
        self.setup._run.assert_not_called()

    def test_repeated_preparation_preserves_the_original_pending_request(self):
        self.assertTrue(self.setup.defer_search_provider_plugin())
        original = self.pending_path.read_text(encoding="utf-8")
        self.assertTrue(self.setup.defer_search_provider_plugin())
        self.assertEqual(self.pending_path.read_text(encoding="utf-8"), original)
        self.setup._run.assert_not_called()

    def test_verified_local_plugin_does_not_need_background_installation(self):
        self.setup._parallel_plugin_is_installed_locally.return_value = True
        self.assertTrue(self.setup.defer_search_provider_plugin())
        self.assertFalse(self.pending_path.exists())
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf-8")), self.config)

    def test_other_providers_and_explicitly_disabled_search_are_preserved(self):
        for search in ({"provider": "brave", "apiKey": "example"}, {"enabled": False}):
            with self.subTest(search=search):
                self.config["tools"]["web"]["search"] = search
                self.write_config()
                self.assertTrue(self.setup.defer_search_provider_plugin())
                self.assertFalse(self.pending_path.exists())
                self.assertEqual(
                    json.loads(self.config_path.read_text(encoding="utf-8")), self.config
                )
        self.setup._parallel_plugin_is_installed_locally.assert_not_called()

    def test_pending_setup_is_included_in_managed_upgrade_rollback(self):
        self.assertIn(
            Path("microclaw-search-setup.json"), managed_state_paths(include_uninstaller=False)
        )

    def test_invalid_configuration_reports_a_local_preparation_failure(self):
        self.config_path.write_text("invalid json", encoding="utf-8")
        self.assertFalse(self.setup.defer_search_provider_plugin())
        self.assertFalse(self.pending_path.exists())
        self.setup._run.assert_not_called()
