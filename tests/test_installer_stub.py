import os
import re
import subprocess
import tempfile
import unittest
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
        cls.setup = cls.work / "setup.exe"
        compilation = subprocess.run(
            [
                os.environ["MICROCLAW_NSIS_TEST_COMPILER"],
                "/V2",
                f"/DPAYLOAD_DIR={cls.payload}",
                f"/DOUT_FILE={cls.setup}",
                f"/DPAYLOAD_ID={cls.payload_id}",
                str(root / "installer" / "microclaw-setup.nsi"),
            ],
            capture_output=True,
            timeout=60,
        )
        if compilation.returncode:
            raise RuntimeError(
                f"NSIS compilation failed: {compilation.stdout!r} {compilation.stderr!r}"
            )

    def run_setup(self, staging):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        result = subprocess.run(
            f'"{self.setup}" /EXTRACT_ONLY /D={staging}',
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
