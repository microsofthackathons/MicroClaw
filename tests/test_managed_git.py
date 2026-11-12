import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deployer.windows_setup import WindowsSetup


class ManagedGitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.git_dir = self.home / ".openclaw-git"
        for context in (
            patch("deployer.windows_setup.Path.home", return_value=self.home),
            patch.dict(os.environ, {"PATH": str(self.home / "other-tools")}),
            patch("deployer.windows_setup.shutil.which", return_value=None),
        ):
            context.start()
            self.addCleanup(context.stop)
        config = Mock()
        config.get.side_effect = lambda _key, default=None: default
        self.setup = WindowsSetup(config, Mock())
        self.setup._select_download_mirror = Mock()
        self.setup._resolve_git_version = Mock(return_value="2.53.0")
        self.setup._download_git_installer = Mock(return_value=False)
        self.setup._add_to_user_path = Mock()
        self.setup._run = Mock(
            return_value=SimpleNamespace(returncode=0, stdout="git version 2.53.0.windows.1\n")
        )

    def write_git(self, directory="bin"):
        executable = self.git_dir / directory / "git.exe"
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"fixture")
        return executable

    def test_existing_managed_git_is_reused_without_network_or_rollback_deletion(self):
        for directory in ("bin", "cmd"):
            with self.subTest(directory=directory):
                executable = self.write_git(directory)
                self.assertTrue(self.setup.ensure_git())
                self.assertEqual(self.setup._git_bin, str(executable.parent))
                self.setup._run.assert_called_with(
                    [str(executable), "--version"], capture_output=True, text=True, timeout=5
                )
                self.setup._add_to_user_path.assert_called_with(str(executable.parent))
                self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(executable.parent))
                self.setup._select_download_mirror.assert_not_called()
                self.setup._download_git_installer.assert_not_called()
                self.setup.rollback()
                self.assertTrue(executable.is_file())
                executable.unlink()

    def test_existing_system_git_keeps_precedence_and_does_not_change_path(self):
        self.write_git()
        original_path = os.environ["PATH"]
        external = self.home / "system-git" / "git.exe"
        with patch("deployer.windows_setup.shutil.which", return_value=str(external)):
            self.assertTrue(self.setup.ensure_git())
        self.assertEqual(self.setup._git_bin, str(external.parent))
        self.assertEqual(os.environ["PATH"], original_path)
        self.setup._run.assert_not_called()
        self.setup._add_to_user_path.assert_not_called()
        self.setup._select_download_mirror.assert_not_called()

    def test_managed_git_already_in_process_path_repairs_persistent_path_without_duplicates(self):
        executable = self.write_git()
        original_path = str(executable.parent) + os.pathsep + os.environ["PATH"]
        with (
            patch.dict(os.environ, {"PATH": original_path}),
            patch("deployer.windows_setup.shutil.which", return_value=str(executable)),
        ):
            self.assertTrue(self.setup.ensure_git())
            self.assertEqual(os.environ["PATH"], original_path)
        self.setup._add_to_user_path.assert_called_once_with(str(executable.parent))
        self.setup._select_download_mirror.assert_not_called()

    def test_broken_managed_git_including_path_hit_is_not_treated_as_installed(self):
        executable = self.write_git()
        self.setup._resolve_git_version.return_value = None
        for outcome in (
            SimpleNamespace(returncode=1, stdout="git version broken"),
            SimpleNamespace(returncode=0, stdout="not Git"),
            subprocess.TimeoutExpired("git", 5),
            OSError("invalid executable"),
        ):
            with self.subTest(outcome=outcome):
                self.setup._run.side_effect = [outcome]
                with patch("deployer.windows_setup.shutil.which", return_value=str(executable)):
                    self.assertFalse(self.setup.ensure_git())
        self.setup._add_to_user_path.assert_not_called()

    def test_cmd_layout_is_used_when_bin_executable_is_broken(self):
        self.write_git()
        executable = self.write_git("cmd")
        self.setup._run.side_effect = [
            OSError("broken bin wrapper"),
            SimpleNamespace(returncode=0, stdout="git version 2.53.0"),
        ]
        self.assertTrue(self.setup.ensure_git())
        self.assertEqual(self.setup._git_bin, str(executable.parent))
        self.setup._download_git_installer.assert_not_called()

    def test_fresh_zip_install_is_validated_and_persisted_to_user_path(self):
        self.setup._get_arch = Mock(return_value="x86")

        def download(_version, _name, destination):
            with zipfile.ZipFile(destination, "w") as archive:
                archive.writestr("cmd/git.exe", b"fixture")
            return True

        self.setup._download_git_installer.side_effect = download
        self.assertTrue(self.setup.ensure_git())
        self.assertEqual(len(self.setup._rollback_actions), 1)
        self.setup._add_to_user_path.assert_called_once_with(str(self.git_dir / "cmd"))
        self.setup._run.assert_called_once()

    def test_repair_does_not_register_deletion_of_preexisting_git_directory(self):
        self.git_dir.mkdir()
        self.setup._get_arch = Mock(return_value="x86")

        def download(_version, _name, destination):
            with zipfile.ZipFile(destination, "w") as archive:
                archive.writestr("cmd/git.exe", b"fixture")
            return True

        self.setup._download_git_installer.side_effect = download
        self.assertTrue(self.setup.ensure_git())
        self.assertEqual(self.setup._rollback_actions, [])

    def test_failed_self_extraction_cleans_download_and_does_not_publish_path(self):
        download_dir = self.home / "download"
        download_dir.mkdir()
        self.setup._get_arch = Mock(return_value="x64")
        self.setup._download_git_installer.return_value = True
        self.setup._run.return_value = SimpleNamespace(returncode=1, stdout="failed")
        with patch("deployer.windows_setup.tempfile.mkdtemp", return_value=str(download_dir)):
            self.assertFalse(self.setup.ensure_git())
        self.assertFalse(download_dir.exists())
        self.setup._add_to_user_path.assert_not_called()
        self.assertEqual(self.setup._rollback_actions, [])


class GitUserPathTests(unittest.TestCase):
    def setUp(self):
        config = Mock()
        config.get.side_effect = lambda _key, default=None: default
        self.setup = WindowsSetup(config, Mock())
        self.setup._notify_environment_change = Mock()
        self.registry = SimpleNamespace(
            HKEY_CURRENT_USER=1,
            KEY_QUERY_VALUE=1,
            KEY_SET_VALUE=2,
            REG_EXPAND_SZ=2,
            CreateKeyEx=Mock(return_value="user-environment"),
            QueryValueEx=Mock(return_value=(r"%USERPROFILE%\tools;C:\Git\bin-old", 2)),
            SetValueEx=Mock(),
            CloseKey=Mock(),
        )
        context = patch.dict(sys.modules, {"winreg": self.registry})
        context.start()
        self.addCleanup(context.stop)

    def test_writes_only_user_path_and_matches_complete_entries(self):
        self.setup._add_to_user_path(r"C:\Git\bin")
        self.registry.CreateKeyEx.assert_called_once_with(1, "Environment", 0, 3)
        self.registry.SetValueEx.assert_called_once_with(
            "user-environment",
            "Path",
            0,
            2,
            r"%USERPROFILE%\tools;C:\Git\bin-old;C:\Git\bin",
        )
        self.registry.CloseKey.assert_called_once_with("user-environment")
        self.setup._notify_environment_change.assert_called_once()

    def test_matching_entry_is_not_rewritten_or_broadcast(self):
        for value in (r'"c:/GIT/bin/";C:\Other', r"%USERPROFILE%\Git\bin;C:\Other"):
            with self.subTest(value=value), patch.dict(os.environ, {"USERPROFILE": "C:"}):
                self.registry.QueryValueEx.return_value = (value, 2)
                self.setup._add_to_user_path(r"C:\Git\bin")
        self.registry.SetValueEx.assert_not_called()
        self.setup._notify_environment_change.assert_not_called()

    def test_missing_user_path_is_created(self):
        self.registry.QueryValueEx.side_effect = FileNotFoundError()
        self.setup._add_to_user_path(r"C:\Git\bin")
        self.registry.SetValueEx.assert_called_once_with(
            "user-environment", "Path", 0, 2, r"C:\Git\bin"
        )

    def test_existing_registry_value_type_is_preserved(self):
        self.registry.QueryValueEx.return_value = (r"C:\Other", 1)
        self.setup._add_to_user_path(r"C:\Git\bin")
        self.registry.SetValueEx.assert_called_once_with(
            "user-environment", "Path", 0, 1, r"C:\Other;C:\Git\bin"
        )

    def test_persistence_failure_warns_and_closes_the_registry_handle(self):
        self.registry.SetValueEx.side_effect = PermissionError("denied")
        self.setup._add_to_user_path(r"C:\Git\bin")
        self.registry.CloseKey.assert_called_once_with("user-environment")
        self.setup.log.warn.assert_called_once()
        self.setup._notify_environment_change.assert_not_called()


if __name__ == "__main__":
    unittest.main()
