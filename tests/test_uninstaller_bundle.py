import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deployer.uninstaller_bundle import (
    UninstallerBundleError,
    bundle_manifest,
    bundles_match,
    copy_uninstaller_runtime,
    publish_uninstaller_bundle,
    resolve_uninstaller_bundle,
    validate_uninstaller_bundle,
)


class UninstallerBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _write_bundle(self, root: Path, marker: str = "new") -> Path:
        root.mkdir(parents=True)
        (root / "MicroClawInstaller.exe").write_text(marker, encoding="utf-8")
        internal = root / "_internal"
        internal.mkdir()
        (internal / "python.dll").write_text(f"{marker}-runtime", encoding="utf-8")
        (internal / "base_library.zip").write_text(f"{marker}-stdlib", encoding="utf-8")
        return root

    def test_resolves_frozen_bundle_from_executable_directory(self):
        source = self._write_bundle(self.root / "packaged")

        resolved = resolve_uninstaller_bundle(
            frozen=True,
            executable=source / "MicroClawInstaller.exe",
            app_dir=self.root / "repo",
        )

        self.assertEqual(resolved, source)

    def test_resolves_source_bundle_from_dist(self):
        app_dir = self.root / "repo"
        source = self._write_bundle(app_dir / "dist" / "MicroClawInstaller")

        resolved = resolve_uninstaller_bundle(
            frozen=False,
            executable=self.root / "python.exe",
            app_dir=app_dir,
        )

        self.assertEqual(resolved, source)

    def test_rejects_bundle_without_internal_runtime(self):
        source = self.root / "broken"
        source.mkdir()
        (source / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")

        with self.assertRaisesRegex(UninstallerBundleError, "_internal"):
            validate_uninstaller_bundle(source)

    def test_rejects_empty_internal_runtime(self):
        source = self.root / "broken"
        source.mkdir()
        (source / "MicroClawInstaller.exe").write_text("exe", encoding="utf-8")
        (source / "_internal").mkdir()

        with self.assertRaisesRegex(UninstallerBundleError, "empty"):
            validate_uninstaller_bundle(source)

    def test_publishes_verified_bundle_and_runs_startup_check(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"
        checked = []

        published = publish_uninstaller_bundle(source, state, checked.append)

        self.assertEqual(published, state / "MicroClawInstaller.exe")
        self.assertEqual(bundle_manifest(state), bundle_manifest(source))
        self.assertEqual(checked, [state / "MicroClawInstaller.exe"])
        self.assertFalse(
            any(path.name.startswith(".microclaw-uninstaller-") for path in state.iterdir())
        )

    def test_identical_bundle_skips_republish_and_startup_check(self):
        source = self._write_bundle(self.root / "source")
        state = self._write_bundle(self.root / "state")
        startup_check = unittest.mock.Mock()

        published = publish_uninstaller_bundle(source, state, startup_check)

        self.assertEqual(published, state / "MicroClawInstaller.exe")
        startup_check.assert_not_called()
        self.assertFalse(
            any(path.name.startswith(".microclaw-uninstaller-") for path in state.iterdir())
        )

    def test_publication_keeps_runtime_dependencies_but_excludes_installation_payloads(self):
        source = self._write_bundle(self.root / "source")
        required = (
            "_ssl.pyd",
            "install-manifest.json",
            "pythonnet/runtime/Python.Runtime.dll",
            "pythonnet/runtime/Python.Runtime.deps.json",
            "clr_loader/ffi/dlls/amd64/ClrLoader.dll",
            "webview/lib/WebView2Loader.dll",
            "webview/js/api.js",
            "_tcl_data/init.tcl",
            "_tk_data/tk.tcl",
            "tcl8/8.6/init.tcl",
            "setuptools/_vendor/metadata.txt",
            "yaml/_yaml.pyd",
            "deployer/assets/uninstall_template.html",
            "deployer/assets/microclaw.ico",
            "deployer/assets/microclaw-uninstall.ico",
        )
        excluded = (
            "microclaw-portable.zip",
            "another-desktop.zip",
            "setup-dependencies.ps1",
            "node-runtime.ps1",
            "scripts/install.ps1",
            "skills/example/SKILL.md",
            "deployer/assets/installer_template.html",
            "deployer/assets/welcome-expand.png",
            "unknown-data/payload.bin",
        )
        for relative in required + excluded:
            path = source / "_internal" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative, encoding="utf-8")
        state = self.root / "state"
        publish_uninstaller_bundle(source, state, lambda _exe: None)
        for relative in required + ("base_library.zip",):
            with self.subTest(required=relative):
                self.assertEqual(
                    (state / "_internal" / relative).read_bytes(),
                    (source / "_internal" / relative).read_bytes(),
                )
        for relative in excluded:
            with self.subTest(excluded=relative):
                self.assertFalse((state / "_internal" / relative).exists())
                self.assertTrue((source / "_internal" / relative).is_file())
                self.assertNotIn(f"_internal/{relative}", bundle_manifest(source))
        self.assertTrue(bundles_match(source, state))

    def test_legacy_destination_payload_forces_cleanup_even_when_runtime_matches(self):
        source = self._write_bundle(self.root / "source", "same")
        state = self._write_bundle(self.root / "state", "same")
        for root in (source, state):
            (root / "_internal" / "microclaw-portable.zip").write_bytes(b"old desktop ZIP")
        self.assertFalse(bundles_match(source, state))
        check = unittest.mock.Mock()
        publish_uninstaller_bundle(source, state, check)
        self.assertFalse((state / "_internal" / "microclaw-portable.zip").exists())
        self.assertTrue((source / "_internal" / "microclaw-portable.zip").exists())
        check.assert_called_once_with(state / "MicroClawInstaller.exe")

    def test_installation_payload_changes_do_not_invalidate_clean_uninstaller(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"
        payload = source / "_internal" / "microclaw-portable.zip"
        payload.write_bytes(b"old desktop")
        publish_uninstaller_bundle(source, state, lambda _exe: None)
        payload.write_bytes(b"new desktop payload")
        check = unittest.mock.Mock()
        publish_uninstaller_bundle(source, state, check)
        check.assert_not_called()
        self.assertTrue(bundles_match(source, state))
        (state / "_internal" / "python.dll").write_bytes(b"broken runtime")
        self.assertFalse(bundles_match(source, state))

    def test_desktop_zip_alone_is_not_an_uninstaller_runtime(self):
        source = self.root / "source"
        (source / "_internal").mkdir(parents=True)
        (source / "MicroClawInstaller.exe").write_bytes(b"exe")
        (source / "_internal" / "microclaw-portable.zip").write_bytes(b"payload")
        with self.assertRaisesRegex(UninstallerBundleError, "empty"):
            validate_uninstaller_bundle(source)

    def test_unreadable_runtime_cannot_be_silently_omitted_from_publication(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")

        def unreadable_tree(_root, *, onerror):
            onerror(PermissionError("runtime directory denied"))
            return iter(())

        with (
            unittest.mock.patch("deployer.uninstaller_bundle.os.walk", side_effect=unreadable_tree),
            self.assertRaisesRegex(UninstallerBundleError, "runtime directory denied"),
        ):
            publish_uninstaller_bundle(source, state, lambda _exe: None)
        self.assertEqual((state / "_internal" / "python.dll").read_text(), "old-runtime")
        self.assertEqual((state / "MicroClawInstaller.exe").read_text(), "old")

    def test_failed_runtime_migration_restores_the_original_legacy_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        payload = state / "_internal" / "microclaw-portable.zip"
        payload.write_bytes(b"old desktop ZIP")
        with self.assertRaisesRegex(UninstallerBundleError, "check failed"):
            publish_uninstaller_bundle(
                source, state, unittest.mock.Mock(side_effect=RuntimeError("check failed"))
            )
        self.assertEqual((state / "MicroClawInstaller.exe").read_text(), "old")
        self.assertEqual((state / "_internal" / "python.dll").read_text(), "old-runtime")
        self.assertEqual(payload.read_bytes(), b"old desktop ZIP")

    def test_manifest_mismatch_does_not_replace_existing_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        original = bundle_manifest(state)

        def incomplete_copytree(src, dst):
            copy_uninstaller_runtime(src, dst)
            (dst / "base_library.zip").unlink()

        with (
            unittest.mock.patch(
                "deployer.uninstaller_bundle.copy_uninstaller_runtime",
                side_effect=incomplete_copytree,
            ),
            self.assertRaisesRegex(UninstallerBundleError, "manifest"),
        ):
            publish_uninstaller_bundle(source, state, lambda _exe: None)

        self.assertEqual(bundle_manifest(state), original)

    def test_failed_startup_check_restores_existing_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")

        def fail_check(_exe):
            raise UninstallerBundleError("startup check failed")

        with self.assertRaisesRegex(UninstallerBundleError, "startup check failed"):
            publish_uninstaller_bundle(source, state, fail_check)

        self.assertEqual(
            (state / "MicroClawInstaller.exe").read_text(encoding="utf-8"),
            "old",
        )
        self.assertEqual(
            (state / "_internal" / "python.dll").read_text(encoding="utf-8"),
            "old-runtime",
        )

    def test_fresh_install_failure_removes_partial_bundle(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"

        def fail_check(_exe):
            raise UninstallerBundleError("check failed")

        with self.assertRaisesRegex(UninstallerBundleError, "check failed"):
            publish_uninstaller_bundle(source, state, fail_check)

        self.assertFalse((state / "MicroClawInstaller.exe").exists())
        self.assertFalse((state / "_internal").exists())

    def test_cleanup_error_is_reported_without_failing_published_bundle(self):
        source = self._write_bundle(self.root / "source")
        state = self.root / "state"
        cleanup_errors = []

        with unittest.mock.patch(
            "deployer.uninstaller_bundle.shutil.rmtree",
            side_effect=PermissionError("scanner locked staging"),
        ):
            published = publish_uninstaller_bundle(
                source,
                state,
                lambda _exe: None,
                cleanup_error_handler=cleanup_errors.append,
            )

        self.assertEqual(published, state / "MicroClawInstaller.exe")
        self.assertEqual(bundle_manifest(state), bundle_manifest(source))
        self.assertEqual(len(cleanup_errors), 1)
        self.assertIn("scanner locked staging", cleanup_errors[0])

    def test_backup_failure_restores_already_moved_files(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        real_replace = os.replace

        def fail_internal_backup(src, dst):
            if Path(src) == state / "_internal" and Path(dst).parent.name == "backup":
                raise OSError("cannot move old runtime")
            return real_replace(src, dst)

        with (
            unittest.mock.patch(
                "deployer.uninstaller_bundle.os.replace",
                side_effect=fail_internal_backup,
            ),
            self.assertRaisesRegex(UninstallerBundleError, "cannot move old runtime"),
        ):
            publish_uninstaller_bundle(source, state, lambda _exe: None)

        self.assertEqual(
            (state / "MicroClawInstaller.exe").read_text(encoding="utf-8"),
            "old",
        )
        self.assertEqual(
            (state / "_internal" / "python.dll").read_text(encoding="utf-8"),
            "old-runtime",
        )

    def test_partial_publication_restores_executable_and_internal_runtime(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        real_replace = os.replace

        def fail_staged_internal_publish(src, dst):
            source_path = Path(src)
            if source_path.parent.name == "staged" and source_path.name == "_internal":
                raise OSError("cannot publish new runtime")
            return real_replace(src, dst)

        with (
            unittest.mock.patch(
                "deployer.uninstaller_bundle.os.replace",
                side_effect=fail_staged_internal_publish,
            ),
            self.assertRaisesRegex(UninstallerBundleError, "cannot publish new runtime"),
        ):
            publish_uninstaller_bundle(source, state, lambda _exe: None)

        self.assertEqual(
            (state / "MicroClawInstaller.exe").read_text(encoding="utf-8"),
            "old",
        )
        self.assertEqual(
            (state / "_internal" / "python.dll").read_text(encoding="utf-8"),
            "old-runtime",
        )


if __name__ == "__main__":
    unittest.main()
