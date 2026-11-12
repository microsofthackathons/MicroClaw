import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import build_cache


class BuildCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.write("source.txt", "input")
        self.write("output/data.txt", "complete output")
        self.outputs = ["output"]
        self.addCleanup(patch.stopall)
        patch.object(build_cache.sys, "prefix", str(self.root / "python-env")).start()
        patch.object(build_cache.sys, "base_prefix", str(self.root / "python-runtime")).start()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def key(self):
        return build_cache.fingerprint(self.root, ["source.txt"])

    def remember(self):
        build_cache.save(self.root, "desktop", self.key(), self.outputs)

    def probe(self, **arguments):
        return build_cache.probe(self.root, "desktop", self.key(), self.outputs, **arguments)

    def test_same_content_hits_despite_timestamp_changes(self):
        self.remember()
        for name in ("source.txt", "output/data.txt"):
            os.utime(self.root / name, (1000, 1000))
        self.assertTrue(self.probe()["hit"])

    def test_equal_length_source_edit_with_original_timestamp_misses(self):
        self.remember()
        source = self.root / "source.txt"
        previous = source.stat()
        self.write("source.txt", "other")
        os.utime(source, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        self.assertFalse(self.probe()["hit"])
        self.assertEqual(self.probe()["reason"], "inputs changed")

    def test_changed_deleted_or_extra_output_files_miss(self):
        for operation in ("edit", "delete", "add", "rename"):
            with self.subTest(operation=operation):
                shutil.rmtree(self.root / "output", ignore_errors=True)
                target = self.write("output/data.txt", "complete output")
                self.remember()
                if operation == "edit":
                    previous = target.stat()
                    target.write_text("corrupt! output", encoding="utf-8")
                    os.utime(target, ns=(previous.st_atime_ns, previous.st_mtime_ns))
                elif operation == "delete":
                    target.unlink()
                elif operation == "add":
                    self.write("output/stale.txt", "stale")
                else:
                    target.rename(target.with_name("renamed.txt"))
                self.assertFalse(self.probe()["hit"])

    def test_force_rebuild_does_not_hit(self):
        self.remember()
        self.assertFalse(self.probe(rebuild=True)["hit"])
        self.assertTrue(self.probe()["hit"])

    def test_interrupted_rebuild_does_not_validate_new_inputs(self):
        self.remember()
        self.write("source.txt", "new source")
        self.assertFalse(self.probe()["hit"])
        self.write("output/data.txt", "partial rebuild")
        self.assertFalse(self.probe()["hit"])
        self.remember()
        self.assertTrue(self.probe()["hit"])

    def test_bad_cache_records_are_misses(self):
        for contents in ("invalid json", "[]", '{"schema":999}', '{"schema":1}'):
            with self.subTest(contents=contents):
                state = build_cache.cache_file(self.root, "desktop")
                self.write(str(state.relative_to(self.root)), contents)
                self.assertFalse(self.probe()["hit"])

    def test_missing_empty_or_zero_byte_outputs_cannot_be_saved(self):
        for name in ("missing", "empty-directory", "empty-file"):
            with self.subTest(name=name):
                (self.root / "empty-directory").mkdir(exist_ok=True)
                self.write("empty-file", "")
                with self.assertRaises(ValueError):
                    build_cache.save(self.root, "desktop", self.key(), [name])

    def test_cache_record_does_not_store_environment_secrets(self):
        with patch.dict(os.environ, {"CSC_KEY_PASSWORD": "private-signing-value"}):
            key = build_cache.input_key(self.root, "portable")
        build_cache.save(self.root, "portable", key, self.outputs)
        state = build_cache.cache_file(self.root, "portable").read_text(encoding="utf-8")
        self.assertNotIn("private-signing-value", state)

    def test_unknown_stages_cannot_escape_cache_directory(self):
        with self.assertRaises(ValueError):
            build_cache.cache_file(self.root, "../../elsewhere")

    def test_ui_changes_invalidate_desktop_but_not_native(self):
        self.write("desktop/renderer/src/App.vue", "before")
        native = build_cache.input_key(self.root, "native")
        desktop = build_cache.input_key(self.root, "desktop")
        self.write("desktop/renderer/src/App.vue", "after")
        self.assertEqual(build_cache.input_key(self.root, "native"), native)
        self.assertNotEqual(build_cache.input_key(self.root, "desktop"), desktop)

    def test_native_source_dependency_and_plugin_changes_invalidate_native(self):
        for name in (
            "windows-node-host/Program.cs",
            "third_party/openclaw-windows-node/source/src/OpenClaw.Shared/Shared.cs",
            "third_party/mxc-host-prep-patch/source/Program.cs",
            "desktop/package-lock.json",
            "desktop/node_modules/@microsoft/mxc-sdk/bin/x64/wxc-exec.exe",
            "plugins/openclaw-weixin/vendor/plugin.tgz",
            "plugins/openclaw-weixin/src/monitor/monitor.ts",
            "Directory.Build.props",
        ):
            with self.subTest(name=name):
                before = build_cache.input_key(self.root, "native")
                self.write(name, "new content")
                self.assertNotEqual(build_cache.input_key(self.root, "native"), before)

    def test_native_cache_does_not_require_bundled_llama_runtime(self):
        _, outputs = build_cache.stage_paths(self.root, "native")
        self.assertNotIn("desktop/resources/llama-cpp", outputs)
        for directory in outputs:
            self.write(f"{directory}/RUNTIME.json", "prepared runtime")
        key = build_cache.input_key(self.root, "native")
        build_cache.save(self.root, "native", key, outputs)
        self.assertTrue(build_cache.probe(self.root, "native", key, outputs)["hit"])

    def test_native_generated_obj_and_bin_do_not_invalidate_native(self):
        before = build_cache.input_key(self.root, "native")
        self.write("windows-node-host/obj/generated.cs", "generated")
        self.write("windows-node-host/bin/Release/app.exe", "compiled")
        after = build_cache.input_key(self.root, "native")
        self.assertNotEqual(before, after)
        self.write("windows-node-host/obj/generated.cs", "changed generated file")
        self.write("windows-node-host/bin/Release/app.exe", "changed binary")
        self.assertEqual(build_cache.input_key(self.root, "native"), after)

    def test_prepared_resources_and_installed_js_dependencies_invalidate_desktop(self):
        for name in (
            "desktop/resources/windows-node/host/app.exe",
            "desktop/resources/openclaw.asar",
            "desktop/node_modules/package/dist/index.js",
            "desktop/renderer/node_modules/package/dist/index.js",
            "desktop/renderer/vite.config.ts",
            "desktop/assets/icon.svg",
            "skills/rednote-publisher/SKILL.md",
        ):
            with self.subTest(name=name):
                before = build_cache.input_key(self.root, "desktop")
                self.write(name, "updated build input")
                self.assertNotEqual(build_cache.input_key(self.root, "desktop"), before)

    def test_unused_llama_bundle_does_not_invalidate_desktop_cache(self):
        self.write("desktop/resources/llama-cpp/RUNTIME.json", "obsolete bundle")
        before = build_cache.input_key(self.root, "desktop")
        self.write("desktop/resources/llama-cpp/win32-x64/llama-server.exe", "unused binary")
        self.assertEqual(build_cache.input_key(self.root, "desktop"), before)

    def test_desktop_outputs_do_not_feed_back_into_the_desktop_input_key(self):
        self.write("desktop/src/main.ts", "source")
        self.write("desktop/renderer/src/App.vue", "UI")
        before = build_cache.input_key(self.root, "desktop")
        for name in (
            "desktop/dist/main.js",
            "desktop/renderer/dist/index.html",
            "desktop/release/win-unpacked/resources/app.asar",
            "desktop/renderer/tsconfig.tsbuildinfo",
        ):
            self.write(name, "compiled")
        self.assertEqual(build_cache.input_key(self.root, "desktop"), before)

    def test_installer_inputs_include_manifest_skills_scripts_and_python_environment(self):
        for name in (
            "dist/microclaw-portable.zip",
            "dist/install-manifest.json",
            "skills/example/SKILL.md",
            "scripts/windows/setup-dependencies.ps1",
            "deployer/installer.py",
            "python-env/Lib/site-packages/webview/__init__.py",
            "python-runtime/python312.dll",
        ):
            with self.subTest(name=name):
                before = build_cache.input_key(self.root, "installer")
                self.write(name, "updated installer input")
                self.assertNotEqual(build_cache.input_key(self.root, "installer"), before)

    def test_toolchain_context_compression_and_compiler_contents_invalidate_setup(self):
        compiler = self.write("compiler/makensis.exe", "compiler")
        before = build_cache.input_key(self.root, "setup", ["payload", "zlib"], [compiler])
        after = build_cache.input_key(self.root, "setup", ["payload", "lzma"], [compiler])
        self.assertNotEqual(before, after)
        compiler.write_text("updated compiler", encoding="utf-8")
        changed = build_cache.input_key(self.root, "setup", ["payload", "zlib"], [compiler])
        self.assertNotEqual(before, changed)

    def test_source_file_additions_deletions_and_renames_change_the_key(self):
        self.write("tree/input", "source")
        before = build_cache.fingerprint(self.root, ["tree"])
        added = self.write("tree/added", "new")
        self.assertNotEqual(build_cache.fingerprint(self.root, ["tree"]), before)
        added.unlink()
        self.assertEqual(build_cache.fingerprint(self.root, ["tree"]), before)
        (self.root / "tree/input").rename(self.root / "tree/renamed")
        self.assertNotEqual(build_cache.fingerprint(self.root, ["tree"]), before)

    def test_thread_completion_order_does_not_change_fingerprints(self):
        for number in range(32):
            self.write(f"tree/{number}", "payload" * (number + 1))
        before = build_cache.fingerprint(self.root, ["tree"])
        self.assertEqual(build_cache.fingerprint(self.root, ["tree"]), before)

    def test_content_hashing_preserves_depth_first_fingerprint_order(self):
        nested = self.write("tree/a/nested/data.txt", "nested payload")
        sibling = self.write("tree/a.txt", "sibling payload")
        entries = [
            ("missing", "missing"),
            ("tree", "directory"),
            ("tree/a", "directory"),
            ("tree/a/nested", "directory"),
            (
                "tree/a/nested/data.txt",
                "file",
                nested.stat().st_size,
                hashlib.sha256(nested.read_bytes()).hexdigest(),
            ),
            (
                "tree/a.txt",
                "file",
                sibling.stat().st_size,
                hashlib.sha256(sibling.read_bytes()).hexdigest(),
            ),
        ]
        expected = hashlib.sha256()
        for entry in entries:
            expected.update(json.dumps(entry, ensure_ascii=True).encode("utf-8") + b"\n")
        self.assertEqual(
            build_cache.fingerprint(self.root, ["tree", "missing"]), expected.hexdigest()
        )

    def test_hashing_preserves_contents_across_read_buffer_boundaries(self):
        content = bytes(range(256)) * 513
        (self.root / "source.txt").write_bytes(content)
        entry = ("source.txt", "file", len(content), hashlib.sha256(content).hexdigest())
        expected = hashlib.sha256(
            json.dumps(entry, ensure_ascii=True).encode("utf-8") + b"\n"
        ).hexdigest()
        self.assertEqual(self.key(), expected)

    def test_content_hashing_keeps_name_and_subtree_exclusions(self):
        self.write("tree/source/data.txt", "source")
        excludes = ("*.tmp", "tree/generated")
        before = build_cache.fingerprint(self.root, ["tree"], excludes)
        self.write("tree/generated/nested/output.js", "generated")
        self.write("tree/source/ignored.tmp", "temporary")
        self.assertEqual(build_cache.fingerprint(self.root, ["tree"], excludes), before)

    def test_nested_equal_length_edits_with_restored_timestamps_change_fingerprint(self):
        source = self.write("tree/nested/data.txt", "before")
        metadata = source.stat()
        before = build_cache.fingerprint(self.root, ["tree"])
        source.write_text("after!", encoding="utf-8")
        os.utime(source, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
        self.assertNotEqual(build_cache.fingerprint(self.root, ["tree"]), before)

    @unittest.skipUnless(os.name == "nt", "Requires Windows long paths")
    def test_long_worker_paths_are_hashed_and_invalidate_output_cache(self):
        long_tree = self.root / "output" / ("worker-" + "x" * 50)
        target = long_tree.joinpath(*(["nested-" + "y" * 50] * 4), "worker.dll")
        self.assertGreater(len(str(target)), 260)
        extended_tree = Path("\\\\?\\" + str(long_tree))
        extended_target = Path("\\\\?\\" + str(target))
        extended_target.parent.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, extended_tree)
        extended_target.write_bytes(b"worker-before")

        self.remember()
        self.assertTrue(self.probe()["hit"])
        extended_target.write_bytes(b"worker-after!")
        self.assertFalse(self.probe()["hit"])
        self.assertEqual(self.probe()["reason"], "outputs missing or changed")

    def test_content_hashing_errors_are_not_silently_ignored(self):
        self.write("tree/nested/data.txt", "source")
        with (
            patch.object(Path, "open", side_effect=PermissionError("unreadable input")),
            self.assertRaisesRegex(PermissionError, "unreadable input"),
        ):
            build_cache.fingerprint(self.root, ["tree"])

    def test_cli_reports_input_and_output_verification_timings(self):
        result = subprocess.run(
            [
                sys.executable,
                build_cache.__file__,
                "probe",
                "--root",
                str(self.root),
                "--stage",
                "portable",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertFalse(data["hit"])
        self.assertGreaterEqual(data["timings"]["inputs"], 0)
        self.assertGreaterEqual(data["timings"]["verification"], 0)

    def test_directory_link_cycles_are_rejected(self):
        directory = self.root / "tree"
        directory.mkdir()
        try:
            (directory / "loop").symlink_to(directory, target_is_directory=True)
        except OSError:
            self.skipTest("Directory symlinks are unavailable")
        with self.assertRaisesRegex(ValueError, "link cycle"):
            build_cache.fingerprint(self.root, ["tree"])

    def test_only_successful_local_pyinstaller_builds_can_populate_installer_cache(self):
        source = (Path(__file__).resolve().parents[1] / "build.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("$localInstallerBuilt = $false", source)
        self.assertIn("$localInstallerBuilt = $true", source)
        self.assertIn(
            "if (-not $installerCache.hit -and $localInstallerBuilt) { Save-BuildCache -Cache $installerCache }",
            source,
        )


@unittest.skipUnless(shutil.which("powershell") or shutil.which("pwsh"), "Requires PowerShell")
class BuildCachePowerShellTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        repository = Path(__file__).resolve().parents[1]
        source = (repository / "build.ps1").read_text(encoding="utf-8-sig")
        parameters = source[: source.index("Set-StrictMode")]
        functions = source[
            source.index("function Invoke-BuildCache") : source.index("function Get-FileSetId")
        ]
        (self.root / "scripts").mkdir()
        shutil.copyfile(repository / "scripts/build_cache.py", self.root / "scripts/build_cache.py")
        (self.root / "desktop/release/win-unpacked").mkdir(parents=True)
        self.input = self.root / "desktop/release/win-unpacked/app.exe"
        self.input.write_bytes(b"complete application")
        (self.root / "dist").mkdir()
        (self.root / "dist/microclaw-portable.zip").write_bytes(b"complete zip")
        self.harness = self.root / "build.ps1"
        self.harness.write_text(
            parameters
            + "$ErrorActionPreference = 'Stop'\n$root = $PSScriptRoot\n"
            + functions
            + '\n$context = @("PowerShell fixture", $PortableCompression, "quoted `"value`"`nsecond line")\n'
            + "$first = Get-BuildCache -Stage portable -Context $context\n"
            + "if (-not $first.hit) { Save-BuildCache -Cache $first }\n"
            + "$second = Get-BuildCache -Stage portable -Context $context\n"
            + "@{first=$first.hit; second=$second.hit} | ConvertTo-Json -Compress\n",
            encoding="utf-8-sig",
        )

    def run_harness(self, *arguments):
        result = subprocess.run(
            [
                shutil.which("powershell") or shutil.which("pwsh"),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(self.harness),
                *arguments,
            ],
            capture_output=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.splitlines()[-1])

    def test_cold_then_warm_builds(self):
        self.assertEqual(self.run_harness(), {"first": False, "second": True})
        self.assertEqual(self.run_harness(), {"first": True, "second": True})

    def test_changed_input_is_rebuilt_then_cached(self):
        self.run_harness()
        self.input.write_bytes(b"updated application")
        self.assertEqual(self.run_harness(), {"first": False, "second": True})

    def test_rebuild_switch_bypasses_cache(self):
        self.run_harness()
        self.assertEqual(self.run_harness("-Rebuild"), {"first": False, "second": False})

    def test_changing_portable_compression_invalidates_cached_archive(self):
        self.assertEqual(self.run_harness(), {"first": False, "second": True})
        self.assertEqual(
            self.run_harness("-PortableCompression", "NoCompression"),
            {"first": False, "second": True},
        )
        self.assertEqual(
            self.run_harness("-PortableCompression", "NoCompression"),
            {"first": True, "second": True},
        )

    def test_disabled_cache_does_not_save_reusable_records(self):
        source = self.harness.read_text(encoding="utf-8-sig")
        self.harness.write_text(
            source.replace("-Context $context", "-Context $context -Disabled"),
            encoding="utf-8-sig",
        )
        self.assertEqual(self.run_harness(), {"first": False, "second": False})
        self.assertFalse(build_cache.cache_file(self.root, "portable").exists())

    def test_missing_python_disables_cache_without_blocking_build_bootstrap(self):
        source = self.harness.read_text(encoding="utf-8-sig")
        self.harness.write_text(
            source.replace(
                "function Invoke-BuildCache",
                "function Get-Command { param($Name, $ErrorAction) return $null }\n"
                "function Invoke-BuildCache",
            ),
            encoding="utf-8-sig",
        )
        self.assertEqual(self.run_harness(), {"first": False, "second": False})
        self.assertFalse(build_cache.cache_file(self.root, "portable").exists())


if __name__ == "__main__":
    unittest.main()
