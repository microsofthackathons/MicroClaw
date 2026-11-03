import os
import subprocess
import tempfile
import unittest
import unittest.mock
import zipfile
from pathlib import Path

from deployer.windows_setup import WindowsSetup


class DesktopInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.install = self.root / "Desktop with spaces"
        self.archive = self.root / "microclaw-portable.zip"
        config = unittest.mock.Mock()
        config.get.side_effect = lambda _name, default=None: default
        self.setup = WindowsSetup(config, unittest.mock.Mock())
        self.setup._register_rollback = unittest.mock.Mock()
        self.write(self.install / "MicroClawDesktop.exe", "old executable")
        self.write(self.install / "resources/app.asar", "old app")
        self.old_canvas = self.write(
            self.install
            / "resources/windows-node/canvas-host/mscordaccore_amd64_amd64_10.0.1326.50504.dll",
            "old runtime",
        )
        self.backup = self.write(self.install / "backups/openclaw/transaction/marker", "backup")
        self.transaction = self.write(self.install / "upgrade/openclaw-upgrade.json", "transaction")
        self.state = self.write(self.install / "install-state/install-manifest.json", "state")
        self.entries = {
            "MicroClawDesktop.exe": "new executable",
            "resources/app.asar": "new app",
            "resources/windows-node/RUNTIME.json": "new manifest",
            "resources/windows-node/canvas-host/mscordaccore_amd64_amd64_10.0.1426.52326.dll": "new runtime",
            "locales/zh-CN.pak": "new locale",
        }

    @staticmethod
    def write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def bundle(self, entries=None, prefix=""):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, content in (self.entries if entries is None else entries).items():
                archive.writestr(prefix + name, content)

    def assert_state_preserved(self):
        self.assertEqual(self.backup.read_text(encoding="utf-8"), "backup")
        self.assertEqual(self.transaction.read_text(encoding="utf-8"), "transaction")
        self.assertEqual(self.state.read_text(encoding="utf-8"), "state")
        self.assertFalse(list(self.install.glob(".desktop-install-*")))

    def assert_old_payload_preserved(self):
        self.assertEqual(
            (self.install / "MicroClawDesktop.exe").read_text(encoding="utf-8"),
            "old executable",
        )
        self.assertEqual(
            (self.install / "resources/app.asar").read_text(encoding="utf-8"), "old app"
        )
        self.assertEqual(self.old_canvas.read_text(encoding="utf-8"), "old runtime")
        self.assert_state_preserved()

    def test_upgrade_replaces_bundled_directories_without_stale_runtime_files(self):
        self.write(self.install / "locales/obsolete.pak", "old locale")
        self.bundle()

        self.assertTrue(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assertFalse(self.old_canvas.exists())
        self.assertFalse((self.install / "locales/obsolete.pak").exists())
        for name, content in self.entries.items():
            self.assertEqual((self.install / name).read_text(encoding="utf-8"), content)
        self.assert_state_preserved()
        self.setup._register_rollback.assert_called_once()

    def test_nested_archive_replaces_existing_payload_without_touching_upgrade_state(self):
        self.bundle(prefix="win-unpacked/")

        self.assertTrue(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assertFalse(self.old_canvas.exists())
        self.assertFalse((self.install / "win-unpacked").exists())
        self.assertEqual(
            (self.install / "resources/app.asar").read_text(encoding="utf-8"), "new app"
        )
        self.assert_state_preserved()

    def test_archive_without_an_executable_leaves_existing_installation_unchanged(self):
        self.bundle(entries={"resources/app.asar": "invalid replacement"})

        self.assertFalse(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assert_old_payload_preserved()
        self.setup._register_rollback.assert_not_called()

    def test_failed_extraction_leaves_existing_installation_unchanged(self):
        self.bundle()

        def fail_extraction(_archive, destination):
            self.write(Path(destination) / "resources/app.asar", "partial replacement")
            raise zipfile.BadZipFile("corrupt archive")

        with unittest.mock.patch.object(zipfile.ZipFile, "extractall", fail_extraction):
            self.assertFalse(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assert_old_payload_preserved()
        self.setup._register_rollback.assert_not_called()

    def test_failed_publication_restores_replaced_files_and_directories(self):
        self.bundle()
        replace = Path.replace

        def fail_publication(source, destination):
            if source.name == "resources" and "payload" in source.parts:
                raise PermissionError("resource directory is locked")
            return replace(source, destination)

        with unittest.mock.patch.object(Path, "replace", fail_publication):
            self.assertFalse(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assert_old_payload_preserved()
        self.assertFalse((self.install / "locales").exists())
        self.setup._register_rollback.assert_not_called()

    def test_locked_existing_directory_leaves_existing_installation_unchanged(self):
        self.bundle()
        replace = Path.replace

        def fail_backup(source, destination):
            if source == self.install / "resources":
                raise PermissionError("old resource directory is locked")
            return replace(source, destination)

        with unittest.mock.patch.object(Path, "replace", fail_backup):
            self.assertFalse(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assert_old_payload_preserved()
        self.assertFalse((self.install / "locales").exists())

    def test_fresh_installation_and_alternate_executable_are_supported(self):
        self.bundle(entries={"AlternateDesktop.exe": "executable", "resources/app.asar": "app"})
        destination = self.root / "Fresh desktop"

        self.assertTrue(self.setup._extract_desktop_zip(self.archive, destination))

        self.assertEqual(
            (destination / "AlternateDesktop.exe").read_text(encoding="utf-8"), "executable"
        )
        self.assertFalse(list(destination.glob(".desktop-install-*")))

    def test_failed_restoration_keeps_recovery_files_and_restores_other_entries(self):
        self.bundle()
        replace = Path.replace

        def fail_publication_and_restoration(source, destination):
            if source.name == "resources" and source.parent.name in ("payload", "previous"):
                raise PermissionError("resource directory is locked")
            return replace(source, destination)

        with unittest.mock.patch.object(Path, "replace", fail_publication_and_restoration):
            self.assertFalse(self.setup._extract_desktop_zip(self.archive, self.install))

        recovery = list(self.install.glob(".desktop-install-*"))
        self.assertEqual(len(recovery), 1)
        self.assertEqual(
            (recovery[0] / "previous/resources/app.asar").read_text(encoding="utf-8"),
            "old app",
        )
        self.assertEqual(
            (self.install / "MicroClawDesktop.exe").read_text(encoding="utf-8"),
            "old executable",
        )
        self.assertFalse((self.install / "locales").exists())
        self.assertEqual(self.backup.read_text(encoding="utf-8"), "backup")
        self.assertEqual(self.transaction.read_text(encoding="utf-8"), "transaction")
        self.assertEqual(self.state.read_text(encoding="utf-8"), "state")
        self.assertIn("recovery files retained", self.setup.log.error.call_args.args[0])
        self.setup._register_rollback.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows directory junction regression")
    def test_replacing_old_resources_does_not_follow_directory_junctions(self):
        external = self.write(self.root / "external runtime/openclaw.mjs", "preserved runtime")
        junction = self.install / "resources" / "old-host-link"
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(external.parent)],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.bundle()

        self.assertTrue(self.setup._extract_desktop_zip(self.archive, self.install))

        self.assertEqual(external.read_text(encoding="utf-8"), "preserved runtime")
        self.assertFalse(junction.exists())
        self.assert_state_preserved()
