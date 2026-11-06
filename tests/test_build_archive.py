import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")


@unittest.skipUnless(POWERSHELL, "Requires PowerShell")
class BuildArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        payload = self.root / "desktop/release/win-unpacked"
        (payload / "resources").mkdir(parents=True)
        self.files = {
            "MicroClawDesktop.exe": b"application fixture" * 100,
            "resources/app.asar": b"resource fixture" * 100,
        }
        for name, content in self.files.items():
            (payload / name).write_bytes(content)
        (self.root / "dist").mkdir()
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        parameters = source[: source.index("Set-StrictMode")]
        archive_stage = source[
            source.index("Start-BuildStage 'Step 4/7: check portable cache'") : source.index(
                "# Build identity consumed"
            )
        ]
        self.harness = self.root / "build.ps1"
        self.harness.write_text(
            parameters
            + "$ErrorActionPreference = 'Stop'\n$root = $PSScriptRoot\n"
            + "$desktopContext = @('fixture')\n"
            + "function Start-BuildStage { param($Name) }\n"
            + "function Save-BuildCache { param($Cache) }\n"
            + "function Get-BuildCache { param($Stage, $Context) "
            + "$script:archiveContext = $Context; "
            + "return [pscustomobject]@{hit=$false} }\n"
            + archive_stage
            + "@{context=$script:archiveContext} | ConvertTo-Json -Compress\n",
            encoding="utf-8-sig",
        )

    def run_harness(self, *arguments):
        return subprocess.run(
            [
                POWERSHELL,
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

    def test_default_and_explicit_compression_preserve_installer_archive_layout(self):
        for compression in (None, "Fastest", "Optimal", "NoCompression"):
            with self.subTest(compression=compression):
                arguments = () if compression is None else ("-PortableCompression", compression)
                result = self.run_harness(*arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout.splitlines()[-1])
                self.assertEqual(data["context"], ["fixture", compression or "Fastest"])
                with zipfile.ZipFile(self.root / "dist/microclaw-portable.zip") as archive:
                    files = {
                        entry.filename.replace("\\", "/"): entry
                        for entry in archive.infolist()
                        if not entry.is_dir()
                    }
                    self.assertEqual(set(files), set(self.files))
                    for name, content in self.files.items():
                        self.assertEqual(archive.read(files[name]), content)
                        self.assertEqual(files[name].compress_type, zipfile.ZIP_DEFLATED)

    def test_invalid_compression_is_rejected_before_archive_creation(self):
        result = self.run_harness("-PortableCompression", "invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "dist/microclaw-portable.zip").exists())


if __name__ == "__main__":
    unittest.main()
