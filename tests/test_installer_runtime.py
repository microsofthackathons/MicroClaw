import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
import zipfile
from pathlib import Path
from types import SimpleNamespace

from deployer.install_timing import RUNTIME_PREPARATION_TIMING_PREFIX
from deployer.openclaw_version import OPENCLAW_TARGET_VERSION
from deployer.windows_setup import WindowsSetup


class InstallerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.desktop = self.root / "Desktop with spaces"
        self.appdata = self.root / "Roaming with spaces"
        self.home = self.root / "home"
        self.global_node = self.root / "global-node"
        self.runtime = self.appdata / "microclaw" / "runtime" / "openclaw"
        for patch in (
            unittest.mock.patch.dict(
                os.environ,
                {"APPDATA": str(self.appdata), "OPENCLAW_NODE_DIR": str(self.global_node)},
            ),
            unittest.mock.patch("deployer.windows_setup.DEFAULT_DESKTOP_DIR", self.desktop),
            unittest.mock.patch("deployer.windows_setup.Path.home", return_value=self.home),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        config = unittest.mock.Mock()
        config.get.side_effect = lambda _name, default=None: default
        self.setup = WindowsSetup(config, unittest.mock.Mock())
        self.executable = self.write(self.desktop / "MicroClawDesktop.exe")
        self.node = self.write(self.desktop / "resources" / "node.exe")
        self.archive = self.write(self.desktop / "resources" / "openclaw.asar")
        self.entry = self.write(self.runtime / "node_modules" / "openclaw" / "openclaw.mjs")
        self.write(
            self.entry.parent / "package.json",
            json.dumps({"name": "openclaw", "version": OPENCLAW_TARGET_VERSION}),
        )
        self.marker = self.write(self.runtime / ".microclaw-version", "prepared-runtime")
        self.setup._run = unittest.mock.Mock(return_value=self.receipt())

    @staticmethod
    def write(path, content="fixture"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def receipt(self, runtime=None):
        payload = json.dumps({"runtimeRoot": str(runtime or self.runtime)})
        return SimpleNamespace(
            returncode=0,
            stdout=f"[startup] preparing\nMICROCLAW_INSTALLER_RUNTIME {payload}\n",
            stderr="",
        )

    def plugin(self, project="parallel-project", peer=True, provider="parallel-free"):
        state = self.home / ".openclaw"
        plugin_id = "parallel" if provider == "parallel-free" else provider
        package_name = f"@openclaw/{plugin_id}-plugin"
        plugin = (
            state
            / "npm"
            / "projects"
            / project
            / "node_modules"
            / "@openclaw"
            / f"{plugin_id}-plugin"
        )
        self.write(plugin / "dist" / "index.js")
        self.write(
            plugin / "package.json",
            json.dumps(
                {
                    "name": package_name,
                    "version": OPENCLAW_TARGET_VERSION,
                    "openclaw": {"runtimeExtensions": ["./dist/index.js"]},
                }
            ),
        )
        self.write(
            plugin / "openclaw.plugin.json",
            json.dumps({"id": plugin_id, "contracts": {"webSearchProviders": [provider]}}),
        )
        self.write(
            state / "openclaw.json",
            json.dumps(
                {
                    "tools": {"web": {"search": {"provider": provider}}},
                    "plugins": {"entries": {plugin_id: {"enabled": True}}},
                }
            ),
        )
        if peer:
            (plugin / "node_modules" / "openclaw").mkdir(parents=True)
        return state, plugin

    def test_preparation_has_its_own_budget_and_binds_the_desktop_runtime(self):
        with unittest.mock.patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE": "1"}):
            self.assertTrue(self.setup._prepare_desktop_runtime())

        call = self.setup._run.call_args
        self.assertEqual(call.args[0], [str(self.executable), "--prepare-installer-runtime"])
        self.assertEqual(call.kwargs["timeout"], 600)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", call.kwargs["env"])
        self.assertEqual(self.setup._desktop_runtime_root, self.runtime)
        self.assertEqual(self.setup._find_openclaw_cmd(), [str(self.node), str(self.entry)])
        self.assertEqual(self.setup._get_env()["PATH"].split(os.pathsep)[0], str(self.node.parent))

    def test_legacy_desktop_without_an_archive_does_not_run_the_new_helper(self):
        self.archive.unlink()
        self.assertTrue(self.setup._prepare_desktop_runtime())
        self.setup._run.assert_not_called()
        self.assertIsNone(self.setup._desktop_runtime_root)

    def timing_events(self):
        return [
            json.loads(call.args[0].removeprefix(RUNTIME_PREPARATION_TIMING_PREFIX))
            for call in self.setup.log.info.call_args_list
            if call.args[0].startswith(RUNTIME_PREPARATION_TIMING_PREFIX)
        ]

    def test_helper_phase_records_are_forwarded_without_noise_or_receipts(self):
        child_event = {
            "scope": "worker",
            "phase": "archive-extract",
            "status": "success",
            "durationMs": 329000,
        }
        child_line = f"{RUNTIME_PREPARATION_TIMING_PREFIX}{json.dumps(child_event)}"
        receipt = self.receipt()
        receipt.stdout = f"unrelated helper output\n{child_line}\n{receipt.stdout}"
        self.setup._run.return_value = receipt
        self.assertTrue(self.setup._prepare_desktop_runtime())
        events = self.timing_events()
        self.assertIn(child_event, events)
        for phase in (
            "environment-preparation",
            "helper-process",
            "result-validation",
            "preparation-total",
        ):
            event = next(
                event
                for event in events
                if event["scope"] == "installer"
                and event["phase"] == phase
                and event["status"] == "success"
            )
            self.assertGreaterEqual(event["durationMs"], 0)
        messages = [call.args[0] for call in self.setup.log.info.call_args_list]
        self.assertNotIn("unrelated helper output", messages)
        self.assertFalse(
            any(message.startswith("MICROCLAW_INSTALLER_RUNTIME ") for message in messages)
        )

    def test_failed_or_timed_out_helper_preserves_partial_stage_records(self):
        child_event = {"scope": "worker", "phase": "archive-extract", "status": "started"}
        child_line = f"{RUNTIME_PREPARATION_TIMING_PREFIX}{json.dumps(child_event)}\n"
        for status in ("failed", "timeout"):
            with self.subTest(status=status):
                self.setup.log.reset_mock()
                if status == "timeout":
                    self.setup._run.side_effect = subprocess.TimeoutExpired(
                        "desktop", 600, output=child_line.encode(), stderr=b"partial error"
                    )
                else:
                    self.setup._run.side_effect = None
                    self.setup._run.return_value = SimpleNamespace(
                        returncode=1, stdout="", stderr=child_line
                    )
                self.assertFalse(self.setup._prepare_desktop_runtime())
                events = self.timing_events()
                self.assertIn(child_event, events)
                for phase in ("helper-process", "preparation-total"):
                    self.assertTrue(
                        any(
                            event["phase"] == phase and event["status"] == status
                            for event in events
                        )
                    )
                self.assertIsNone(self.setup._desktop_runtime_root)

    def test_receipt_validation_failure_is_not_reported_as_success(self):
        self.setup._run.return_value = self.receipt(self.global_node)
        self.assertFalse(self.setup._prepare_desktop_runtime())
        events = self.timing_events()
        for phase in ("result-validation", "preparation-total"):
            self.assertTrue(
                any(event["phase"] == phase and event["status"] == "failed" for event in events)
            )

    def test_missing_packaged_executable_or_node_fails_before_launch(self):
        for path in (self.executable, self.node):
            with self.subTest(path=path):
                path.unlink()
                self.assertFalse(self.setup._prepare_desktop_runtime())
                self.setup._run.assert_not_called()
                self.write(path)

    def test_failed_or_timed_out_preparation_does_not_reuse_an_old_binding(self):
        for outcome in (
            SimpleNamespace(returncode=1, stdout="", stderr="Archive extraction failed"),
            subprocess.TimeoutExpired("desktop", 600),
            OSError("Could not launch desktop"),
        ):
            with self.subTest(outcome=outcome):
                self.setup._desktop_runtime_root = self.runtime
                self.setup._run.side_effect = outcome if isinstance(outcome, Exception) else None
                self.setup._run.return_value = outcome
                self.assertFalse(self.setup._prepare_desktop_runtime())
                self.assertIsNone(self.setup._desktop_runtime_root)

    def test_missing_malformed_duplicate_or_unexpected_receipts_fail(self):
        for output in (
            "",
            "MICROCLAW_INSTALLER_RUNTIME not-json\n",
            "MICROCLAW_INSTALLER_RUNTIME []\n",
            "MICROCLAW_INSTALLER_RUNTIME {}\n",
            self.receipt().stdout * 2,
            self.receipt(self.global_node).stdout,
        ):
            with self.subTest(output=output):
                self.setup._run.return_value.stdout = output
                self.assertFalse(self.setup._prepare_desktop_runtime())
                self.assertIsNone(self.setup._desktop_runtime_root)

    def test_incomplete_prepared_runtime_is_not_accepted(self):
        for path in (self.entry, self.marker, self.entry.parent / "package.json"):
            with self.subTest(path=path):
                previous = path.read_text(encoding="utf-8")
                path.unlink()
                self.assertFalse(self.setup._prepare_desktop_runtime())
                self.assertIsNone(self.setup._desktop_runtime_root)
                self.write(path, previous)

    def test_matching_desktop_build_still_prepares_runtime_before_later_steps(self):
        self.setup._desktop_install_is_current = unittest.mock.Mock(return_value=True)
        self.setup._find_local_desktop_zip = unittest.mock.Mock()
        self.assertTrue(self.setup.install_desktop_client())
        self.setup._find_local_desktop_zip.assert_not_called()
        self.assertEqual(self.setup._desktop_runtime_root, self.runtime)

    def test_fresh_desktop_extraction_prepares_runtime_before_returning(self):
        archive = self.root / "desktop.zip"
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr("MicroClawDesktop.exe", "new-desktop")
            package.writestr("resources/openclaw.asar", "new-runtime")
            package.writestr("resources/node.exe", "new-node")
        self.setup._desktop_install_is_current = unittest.mock.Mock(return_value=False)
        self.setup._process_snapshot = unittest.mock.Mock(return_value={})
        self.setup._find_local_desktop_zip = unittest.mock.Mock(return_value=archive)
        self.assertTrue(self.setup.install_desktop_client())
        self.assertEqual(self.setup._desktop_runtime_root, self.runtime)

    def test_runtime_preparation_failure_makes_desktop_install_fail(self):
        self.setup._desktop_install_is_current = unittest.mock.Mock(return_value=True)
        self.setup._run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="failed")
        self.assertFalse(self.setup.install_desktop_client())

    def test_bound_runtime_never_falls_back_to_the_global_cli_when_missing(self):
        self.write(self.global_node / "openclaw.cmd")
        self.setup._desktop_runtime_root = self.runtime
        self.entry.unlink()
        self.assertIsNone(self.setup._find_openclaw_cmd())

    def test_warmup_uses_the_same_bundled_node_and_openclaw(self):
        self.setup._desktop_runtime_root = self.runtime
        with (
            unittest.mock.patch("deployer.windows_setup.subprocess.Popen") as launch,
            unittest.mock.patch("deployer.windows_setup.subprocess.run"),
            unittest.mock.patch("deployer.windows_setup.time.sleep"),
        ):
            self.assertTrue(self.setup.warmup_compile_cache())
        self.assertEqual(launch.call_args.args[0][:2], [str(self.node), str(self.entry)])

    def test_parallel_fast_path_requires_a_peer_link_to_the_actual_desktop_host(self):
        self.setup._desktop_runtime_root = self.runtime
        state, plugin = self.plugin()
        for valid in (False, True):
            with (
                self.subTest(valid=valid),
                unittest.mock.patch(
                    "deployer.windows_setup.os.path.samefile", return_value=valid
                ) as samefile,
            ):
                self.assertEqual(self.setup._parallel_plugin_is_installed_locally(state), valid)
                samefile.assert_called_once_with(
                    plugin / "node_modules" / "openclaw", self.entry.parent
                )

    def test_a_missing_old_peer_does_not_hide_a_valid_prepared_plugin(self):
        self.setup._desktop_runtime_root = self.runtime
        state, _plugin = self.plugin("old-project", peer=False)
        self.plugin("new-project")
        with unittest.mock.patch("deployer.windows_setup.os.path.samefile", return_value=True):
            self.assertTrue(self.setup._parallel_plugin_is_installed_locally(state))

    def test_keyed_search_plugin_verification_checks_its_identity_and_host(self):
        self.setup._desktop_runtime_root = self.runtime
        for provider in ("brave", "tavily"):
            with self.subTest(provider=provider):
                state, plugin = self.plugin(provider=provider)
                with unittest.mock.patch(
                    "deployer.windows_setup.os.path.samefile", return_value=True
                ):
                    self.assertTrue(self.setup._search_plugin_is_installed_locally(state, provider))
                    manifest = plugin / "openclaw.plugin.json"
                    manifest.write_text(json.dumps({"id": "wrong"}), encoding="utf-8")
                    self.assertFalse(
                        self.setup._search_plugin_is_installed_locally(state, provider)
                    )

    def test_parallel_repair_runs_under_the_bundled_host_and_checks_the_result(self):
        self.setup._desktop_runtime_root = self.runtime
        self.plugin()
        self.setup._npm_registry_attempts = unittest.mock.Mock(
            return_value=["https://registry.invalid"]
        )
        self.setup._run_openclaw_json = unittest.mock.Mock(return_value={"available": False})
        with unittest.mock.patch(
            "deployer.windows_setup.os.path.samefile", return_value=False
        ) as samefile:

            def install(_command, **_kwargs):
                samefile.return_value = True
                return SimpleNamespace(returncode=0, stdout="installed", stderr="")

            self.setup._run.side_effect = install
            self.assertTrue(self.setup.install_search_provider_plugin())
        self.assertEqual(
            self.setup._run.call_args.args[0],
            [
                str(self.node),
                str(self.entry),
                "plugins",
                "install",
                "--force",
                f"@openclaw/parallel-plugin@{OPENCLAW_TARGET_VERSION}",
            ],
        )
        self.setup._run_openclaw_json.assert_not_called()

    def test_parallel_install_exit_zero_does_not_hide_a_wrong_peer_link(self):
        self.setup._desktop_runtime_root = self.runtime
        self.plugin()
        self.setup._npm_registry_attempts = unittest.mock.Mock(
            return_value=["https://registry.invalid"]
        )
        self.setup._run.return_value = SimpleNamespace(returncode=0, stdout="installed", stderr="")
        with unittest.mock.patch("deployer.windows_setup.os.path.samefile", return_value=False):
            self.assertFalse(self.setup.install_search_provider_plugin())
        self.setup.log.error.assert_called_with(
            "Parallel plugin is not linked to the desktop OpenClaw runtime"
        )

    def test_real_peer_junction_distinguishes_global_and_bundled_hosts(self):
        self.setup._desktop_runtime_root = self.runtime
        global_host = self.global_node / "node_modules" / "openclaw"
        global_host.mkdir(parents=True)
        for project, target, expected in (
            ("global-project", global_host, False),
            ("bundled-project", self.entry.parent, True),
        ):
            state, plugin = self.plugin(project)
            peer = plugin / "node_modules" / "openclaw"
            peer.rmdir()
            if os.name == "nt":
                command = (
                    "New-Item -ItemType Junction -Path '"
                    + str(peer).replace("'", "''")
                    + "' -Target '"
                    + str(target).replace("'", "''")
                    + "' | Out-Null"
                )
                subprocess.run(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                    check=True,
                    capture_output=True,
                    creationflags=0x08000000,
                )
            else:
                peer.symlink_to(target, target_is_directory=True)
            self.assertEqual(self.setup._parallel_plugin_is_installed_locally(state), expected)
