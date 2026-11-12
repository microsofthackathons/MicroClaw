import os
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


class InstallerStubTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (Path(__file__).parents[1] / "installer" / "microclaw-setup.nsi").read_text(
            encoding="utf-8"
        )

    def test_window_name_does_not_duplicate_setup_suffix(self):
        self.assertRegex(self.script, re.compile(r'^Name "MicroClaw"$', re.MULTILINE))
        self.assertIn('VIAddVersionKey "ProductName"    "MicroClaw Setup"', self.script)

    def test_bootstrapper_defaults_to_simplified_chinese(self):
        self.assertRegex(
            self.script,
            re.compile(r"Function \.onInit\s+StrCpy \$LANGUAGE \$\{LANG_SIMPCHINESE\}"),
        )

    def test_bootstrapper_extracts_silently_before_launching_installer(self):
        self.assertRegex(
            self.script,
            re.compile(r"^SilentInstall silent$", re.MULTILINE),
        )
        self.assertNotRegex(self.script, re.compile(r"^Page instfiles$", re.MULTILINE))
        self.assertNotIn("ShowInstDetails show", self.script)
        self.assertIn('Banner::show /NOUNLOAD "$(PreparingText)"', self.script)
        self.assertIn("Banner::destroy", self.script)
        self.assertIn("LangString PreparingText ${LANG_ENGLISH}", self.script)
        self.assertIn("LangString PreparingText ${LANG_SIMPCHINESE}", self.script)
        self.assertIn('File /r "${PAYLOAD_DIR}\\*"', self.script)
        self.assertIn("Exec '\"$INSTDIR\\MicroClawInstaller.exe\"'", self.script)
        self.assertIn('IfFileExists "$INSTDIR\\.payload-complete"', self.script)
        self.assertIn('StrCmp $1 "${PAYLOAD_ID}" launch_installer extract_payload', self.script)
        self.assertIn(
            'IfFileExists "$INSTDIR\\MicroClawInstaller.exe" payload_complete extraction_failed',
            self.script,
        )
        self.assertIn('FileWrite $0 "${PAYLOAD_ID}"', self.script)
        self.assertLess(self.script.index("Banner::show"), self.script.index("File /r"))
        self.assertLess(self.script.index("File /r"), self.script.index("Banner::destroy"))
        self.assertLess(self.script.index("Banner::destroy"), self.script.index("Exec '"))

    def test_bootstrapper_isolates_each_payload_from_running_older_installers(self):
        self.assertIn('InstallDir "$LOCALAPPDATA\\MicroClaw\\Setup\\${PAYLOAD_ID}"', self.script)
        self.assertNotIn('InstallDir "$LOCALAPPDATA\\MicroClaw\\Setup"', self.script)

    def test_bootstrapper_defaults_to_fast_compression_with_an_override(self):
        self.assertIn("!ifndef SETUP_COMPRESSION\n  !define SETUP_COMPRESSION zlib", self.script)
        self.assertIn("SetCompressor /SOLID ${SETUP_COMPRESSION}", self.script)
        build = (Path(__file__).parents[1] / "build.ps1").read_text(encoding="utf-8")
        self.assertIn("[ValidateSet('zlib', 'lzma')]", build)
        self.assertIn("[string]$SetupCompression = 'zlib'", build)
        self.assertIn('"/DSETUP_COMPRESSION=$SetupCompression"', build)

    def test_ci_explicitly_requests_the_additional_installer_archive(self):
        root = Path(__file__).parents[1]
        for name in ("pr-build.yml", "release.yml"):
            with self.subTest(workflow=name):
                workflow = (root / ".github" / "workflows" / name).read_text(encoding="utf-8")
                self.assertIn("run: .\\build.ps1 -IncludeInstallerZip", workflow)

    def test_bootstrapper_does_not_mark_failed_extraction_complete(self):
        self.assertRegex(
            self.script,
            r'ClearErrors\s+RMDir /r "\$INSTDIR"\s+IfErrors extraction_failed',
        )
        self.assertRegex(
            self.script,
            r'File /r "\$\{PAYLOAD_DIR\}\\\*"\s+IfErrors extraction_failed',
        )
        self.assertIn(
            'FileOpen $0 "$INSTDIR\\.payload-complete" w\n  IfErrors extraction_failed', self.script
        )
        self.assertIn("SetErrorLevel 2\n  Quit", self.script)

    def test_extract_only_mode_never_launches_installation(self):
        self.assertIn('${GetOptions} $0 "/EXTRACT_ONLY" $1', self.script)
        self.assertRegex(self.script, r"launch_installer:\s+StrCmp \$ExtractOnly 1 extraction_done")
        self.assertRegex(self.script, r"extraction_done:\s+SetErrorLevel 0")

    def test_build_checks_the_final_executable_payload_before_delivery(self):
        build = (Path(__file__).parents[1] / "build.ps1").read_text(encoding="utf-8")
        self.assertIn("@('/EXTRACT_ONLY', \"/D=$verificationDir\")", build)
        self.assertIn("-WindowStyle Hidden -Wait -PassThru", build)
        self.assertIn("Get-FileSetId -Files $extractedFiles -BasePath $verificationDir", build)
        self.assertIn("if ($extractedId -ne $payloadId)", build)


@unittest.skipUnless(shutil.which("powershell") or shutil.which("pwsh"), "Requires PowerShell")
class InstallerArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name)
        self.payload = self.work / "dist" / "MicroClawInstaller"
        self.payload.mkdir(parents=True)
        (self.payload / "resource.txt").write_text("complete installer", encoding="utf-8")
        self.archive = self.work / "dist" / "MicroClawInstaller.zip"
        source = (Path(__file__).parents[1] / "build.ps1").read_text(encoding="utf-8-sig")
        parameters = source[: source.index("Set-StrictMode")]
        archive_function = source[
            source.index("function New-BuildArchive {") : source.index(
                "Start-BuildStage 'Step 4/7: create portable zip'"
            )
        ]
        archive_step = source[source.index("# Step 6:") : source.index("# Step 7:")]
        self.harness = self.work / "archive-step.ps1"
        self.harness.write_text(
            parameters
            + "$ErrorActionPreference = 'Stop'\n$root = $PSScriptRoot\n"
            + "function Start-BuildStage { param($Name) }\n"
            + archive_function
            + archive_step,
            encoding="utf-8-sig",
        )

    def run_archive_step(self, *arguments):
        return subprocess.run(
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
            timeout=30,
        )

    def test_default_skips_the_extra_zip_without_altering_installer_files(self):
        result = self.run_archive_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.archive.exists())
        self.assertEqual(
            (self.payload / "resource.txt").read_text(encoding="utf-8"), "complete installer"
        )

    def test_requested_zip_contains_the_installer_files(self):
        result = self.run_archive_step("-IncludeInstallerZip")
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.read("resource.txt"), b"complete installer")

    def test_default_does_not_refresh_a_previous_optional_archive(self):
        self.archive.write_bytes(b"old optional archive")
        result = self.run_archive_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.archive.read_bytes(), b"old optional archive")

    def test_invalid_compression_is_rejected(self):
        result = self.run_archive_step("-SetupCompression", "unsupported")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"SetupCompression", result.stderr)
        self.assertFalse(self.archive.exists())


@unittest.skipUnless(
    os.name == "nt" and os.environ.get("MICROCLAW_NSIS_TEST_COMPILER"),
    "Requires Windows and MICROCLAW_NSIS_TEST_COMPILER",
)
class InstallerStubRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        build_root = (root / "build").resolve()
        if not build_root.is_relative_to(root):
            raise RuntimeError("Unsafe NSIS test directory")
        build_root.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="nsis-test-", dir=build_root)
        cls.work = Path(temporary.name).resolve()
        if not cls.work.is_relative_to(build_root):
            raise RuntimeError("Unsafe NSIS test workspace")
        cls.addClassCleanup(temporary.cleanup)
        cls.payload_id = "a" * 64
        cls.payload = cls.work / "payload"
        cls.payload.mkdir()
        cls.executable = b"extract-only fixture must never be executed"
        (cls.payload / "MicroClawInstaller.exe").write_bytes(cls.executable)
        (cls.payload / "resource.txt").write_text("current resource", encoding="utf-8")
        cls.setups = {}
        for compression in ("zlib", "lzma"):
            setup = cls.work / f"setup-{compression}.exe"
            arguments = [] if compression == "zlib" else ["/DSETUP_COMPRESSION=lzma"]
            compilation = subprocess.run(
                [
                    os.environ["MICROCLAW_NSIS_TEST_COMPILER"],
                    "/V2",
                    f"/DPAYLOAD_DIR={cls.payload}",
                    f"/DOUT_FILE={setup}",
                    f"/DPAYLOAD_ID={cls.payload_id}",
                    *arguments,
                    str(root / "installer" / "microclaw-setup.nsi"),
                ],
                capture_output=True,
                timeout=60,
            )
            if compilation.returncode:
                raise RuntimeError(
                    f"NSIS compilation failed: {compilation.stdout!r} {compilation.stderr!r}"
                )
            cls.setups[compression] = setup
        cls.setup = cls.setups["zlib"]

    def run_setup(self, staging, setup=None):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        result = subprocess.run(
            f'"{setup or self.setup}" /EXTRACT_ONLY /D={staging}',
            startupinfo=startup,
            capture_output=True,
            timeout=30,
        )
        return result.returncode

    def assert_current_payload(self, staging):
        self.assertEqual((staging / "MicroClawInstaller.exe").read_bytes(), self.executable)
        self.assertEqual((staging / "resource.txt").read_text(encoding="utf-8"), "current resource")
        self.assertEqual((staging / ".payload-complete").read_text(), self.payload_id)

    def test_fresh_extraction_supports_paths_with_spaces_without_launching(self):
        staging = self.work / "fresh staging with spaces"
        self.assertEqual(self.run_setup(staging), 0)
        self.assert_current_payload(staging)

    def test_optional_lzma_compression_extracts_the_same_payload(self):
        staging = self.work / "lzma staging"
        self.assertEqual(self.run_setup(staging, self.setups["lzma"]), 0)
        self.assert_current_payload(staging)

    def test_stale_staging_is_fully_replaced(self):
        staging = self.work / "stale"
        staging.mkdir()
        (staging / "MicroClawInstaller.exe").write_bytes(b"old executable")
        (staging / ".payload-complete").write_text("old payload")
        self.assertEqual(self.run_setup(staging), 0)
        self.assert_current_payload(staging)

    def test_locked_stale_executable_fails_without_new_completion_marker(self):
        staging = self.work / "locked"
        staging.mkdir()
        (staging / "MicroClawInstaller.exe").write_bytes(b"old executable")
        (staging / ".payload-complete").write_text("old payload")
        with (staging / "MicroClawInstaller.exe").open("rb"):
            self.assertEqual(self.run_setup(staging), 2)
            self.assertEqual((staging / "MicroClawInstaller.exe").read_bytes(), b"old executable")
            marker = staging / ".payload-complete"
            self.assertFalse(marker.exists() and marker.read_text() == self.payload_id)

    def test_complete_staging_can_be_reused_while_its_executable_is_locked(self):
        staging = self.work / "complete"
        self.assertEqual(self.run_setup(staging), 0)
        with (staging / "MicroClawInstaller.exe").open("rb"):
            self.assertEqual(self.run_setup(staging), 0)
        self.assert_current_payload(staging)


if __name__ == "__main__":
    unittest.main()
