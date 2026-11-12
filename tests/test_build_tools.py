import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")


@unittest.skipUnless(POWERSHELL, "Requires PowerShell")
class BuildPythonBootstrapTests(unittest.TestCase):
    def run_bootstrap(self, mode):
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        bootstrap = source[
            source.index("$uvCmd = Get-Command uv") : source.index("# --- Run PyInstaller ---")
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "pyproject.toml").write_text("[tool.ruff]\n", encoding="utf-8")
            if mode == "working":
                scripts = root / ".venv" / "Scripts"
                scripts.mkdir(parents=True)
                (scripts / "pyinstaller.exe").write_text("test-only fixture", encoding="utf-8")
            (root / "uv.ps1").write_text(
                "if ($env:BUILD_TEST_UV -eq 'denied') {\n"
                "    throw [Management.Automation.ApplicationFailedException]::new("
                "'intentional uv launch denial')\n"
                "}\n"
                "if ($env:BUILD_TEST_UV -eq 'nonzero') { exit 3 }\n"
                "if ($args[0] -ne '--version') { throw 'unexpected uv install' }\n"
                "'uv 0.9.9'\n"
                "$global:LASTEXITCODE = 0\n",
                encoding="utf-8-sig",
            )
            harness = root / "bootstrap.ps1"
            harness.write_text(
                "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n"
                "$root = $PSScriptRoot\n"
                "$global:LASTEXITCODE = 0\n"
                "function Get-Command {\n"
                "    param($Name, $ErrorAction)\n"
                "    if ($Name -eq 'uv') {\n"
                "        [pscustomobject]@{ Source=(Join-Path $root 'uv.ps1') }\n"
                "    }\n"
                "}\n"
                "function python {\n"
                "    if (($args -join ' ') -ne '-c import PyInstaller') {\n"
                "        throw 'unexpected Python install'\n"
                "    }\n"
                "    Add-Content (Join-Path $root 'python-called.txt') 'probe'\n"
                "    $global:LASTEXITCODE = 0\n"
                "}\n" + bootstrap,
                encoding="utf-8-sig",
            )
            result = subprocess.run(
                [
                    POWERSHELL,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(harness),
                ],
                env={**os.environ, "BUILD_TEST_UV": mode},
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            python_called = (root / "python-called.txt").exists()
        return result, python_called

    def test_unusable_optional_uv_reports_warning_and_uses_python_strategy(self):
        for mode in ("denied", "nonzero"):
            with self.subTest(mode=mode):
                result, python_called = self.run_bootstrap(mode)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("WARNING: uv is unavailable", result.stdout)
                self.assertTrue(python_called)

    def test_usable_uv_keeps_existing_local_environment_strategy(self):
        result, python_called = self.run_bootstrap("working")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("WARNING:", result.stdout)
        self.assertFalse(python_called)


@unittest.skipUnless(POWERSHELL, "Requires PowerShell")
class BuildNsisResolutionTests(unittest.TestCase):
    def test_resolves_legacy_and_versioned_electron_builder_cache(self):
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        resolution = source[
            source.index("Start-BuildStage 'Step 7/7: resolve NSIS and version'") : source.index(
                "# Fingerprint the complete onedir payload"
            )
        ]
        for cache_name in ("nsis", "nsis-3.0.4.1"):
            with self.subTest(cache_name=cache_name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                compiler = (
                    root
                    / "electron-builder"
                    / "Cache"
                    / cache_name
                    / "bundle"
                    / "Bin"
                    / "makensis.exe"
                )
                compiler.parent.mkdir(parents=True)
                compiler.write_text("test-only compiler discovery fixture", encoding="utf-8")
                harness = root / "resolve.ps1"
                harness.write_text(
                    "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n"
                    "$root = $PSScriptRoot\n"
                    "function Start-BuildStage { param($Name) }\n"
                    "function Write-BuildTimingSummary { param($Status) }\n"
                    "function Get-Command { param($Name, $ErrorAction) }\n" + resolution,
                    encoding="utf-8-sig",
                )
                result = subprocess.run(
                    [
                        POWERSHELL,
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(harness),
                    ],
                    env={
                        **os.environ,
                        "LOCALAPPDATA": str(root),
                        "ProgramFiles": str(root / "program-files"),
                        "ProgramFiles(x86)": str(root / "program-files-x86"),
                    },
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(str(compiler), result.stdout)


if __name__ == "__main__":
    unittest.main()
