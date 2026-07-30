import os
import shutil
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deployer.uninstaller_bundle import (
    UninstallerBundleError,
    bundle_manifest,
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
        (internal / "deployer.pyc").write_text(f"{marker}-code", encoding="utf-8")
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

    def test_manifest_mismatch_does_not_replace_existing_bundle(self):
        source = self._write_bundle(self.root / "source", "new")
        state = self._write_bundle(self.root / "state", "old")
        original = bundle_manifest(state)
        real_copytree = shutil.copytree

        def incomplete_copytree(src, dst):
            copied = real_copytree(src, dst)
            (copied / "deployer.pyc").unlink()
            return copied

        with (
            unittest.mock.patch(
                "deployer.uninstaller_bundle.shutil.copytree",
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


if __name__ == "__main__":
    unittest.main()
