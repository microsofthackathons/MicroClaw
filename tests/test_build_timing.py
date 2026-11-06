import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


class BuildTimingWiringTests(unittest.TestCase):
    def test_build_times_expensive_operations_separately(self):
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        parts = re.split(r"^\s*Start-BuildStage '([^']+)'\s*$", source, flags=re.MULTILINE)
        stages = dict(zip(parts[1::2], parts[2::2], strict=True))
        expected = {
            "Preflight: resolve Node.js": "Test-SupportedNodeVersion $version",
            "Preflight: initialize OpenClaw source": "submodule update --init",
            "Preflight: desktop dependencies": "npm ls --depth=0",
            "Step 1/7: check native cache": "Get-BuildCache -Stage native",
            "Step 1/7: prepare packaged resources": "npm run prepare-packaged-resources",
            "Step 1/7: save native cache": "Save-BuildCache -Cache $nativeCache",
            "Preflight: desktop toolchain context": "npm --version",
            "Preflight: check desktop cache": "Get-BuildCache -Stage desktop",
            "Step 2/7: clean stale build artifacts": "Remove-Item",
            "Step 3/7: build and pack desktop": "npm run pack:prepared",
            "Step 3/7: save desktop cache": "Save-BuildCache -Cache $desktopCache",
            "Step 4/7: check portable cache": "Get-BuildCache -Stage portable",
            "Step 4/7: create portable zip": "Compress-Archive",
            "Step 4/7: save portable cache": "Save-BuildCache -Cache $portableCache",
            "Step 4/7: generate install manifest": "Get-FileSetId -Files $installerIdentityFiles",
            "Step 5/7: Python dependencies": "pip install",
            "Step 5/7: check installer cache": "Get-BuildCache -Stage installer",
            "Step 5/7: PyInstaller": "pyinstaller MicroClawDeployer.spec",
            "Step 5/7: save installer cache": "Save-BuildCache -Cache $installerCache",
            "Step 6/7: pack optional installer zip": "Compress-Archive",
            "Step 7/7: resolve NSIS and version": "Get-Command makensis",
            "Step 7/7: fingerprint setup payload": "Get-FileHash",
            "Step 7/7: check setup cache": "Get-BuildCache -Stage setup",
            "Step 7/7: NSIS compression": "& $makensis",
            "Step 7/7: extract setup for verification": "Start-Process",
            "Step 7/7: verify extracted payload": "Get-FileSetId -Files $extractedFiles",
            "Step 7/7: sign setup": "sign-artifact.ps1",
            "Step 7/7: save setup cache": "Save-BuildCache -Cache $setupCache",
        }
        self.assertEqual(list(stages), list(expected))
        for stage, operation in expected.items():
            with self.subTest(stage=stage):
                self.assertIn(operation, stages[stage])
        self.assertIn("Start-BuildTiming -Timer $buildTimer", source)
        self.assertTrue(source.rstrip().endswith("Write-BuildTimingSummary"))

    def test_failure_paths_print_summary_before_exiting(self):
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        lines = source.splitlines()
        exits = [index for index, line in enumerate(lines) if line.strip() == "exit 1"]
        self.assertTrue(exits)
        for index in exits:
            with self.subTest(line=index + 1):
                self.assertEqual(
                    lines[index - 1].strip(), "Write-BuildTimingSummary -Status failed"
                )
        self.assertIn("trap {\n    Write-BuildTimingSummary -Status failed\n    break\n}", source)


@unittest.skipUnless(POWERSHELL, "PowerShell is required to exercise build timing")
class BuildTimingTests(unittest.TestCase):
    def run_powershell(self, command):
        return subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'; "
                "[Threading.Thread]::CurrentThread.CurrentCulture = "
                "[Globalization.CultureInfo]::InvariantCulture; "
                r". .\scripts\windows\build-timing.ps1; " + command,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_success_summary_accounts_for_total_once_without_pipeline_output(self):
        result = self.run_powershell(
            "$timer = [Diagnostics.Stopwatch]::StartNew(); "
            "Start-Sleep -Milliseconds 20; "
            "$global:LASTEXITCODE = 17; "
            "$unexpectedOutput = @("
            "Start-BuildTiming -Timer $timer; "
            "Start-BuildStage 'prepare'; Start-Sleep -Milliseconds 20; "
            "Start-BuildStage 'verify'; Start-Sleep -Milliseconds 20; "
            "Write-BuildTimingSummary; "
            "Start-Sleep -Milliseconds 20; Write-BuildTimingSummary -Status failed); "
            "$result = @{ stages = @($script:buildTiming.Stages); "
            "seconds = $timer.Elapsed.TotalSeconds; running = $timer.IsRunning; "
            "finished = $script:buildTiming.Finished; exitCode = $LASTEXITCODE; "
            "outputCount = $unexpectedOutput.Count }; "
            "'TIMING_JSON:' + (ConvertTo-Json -InputObject $result -Depth 4 -Compress)"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout.split("TIMING_JSON:", 1)[1])
        self.assertEqual([stage["Name"] for stage in data["stages"]], ["prepare", "verify"])
        self.assertEqual([stage["Status"] for stage in data["stages"]], ["success", "success"])
        self.assertTrue(all(stage["Seconds"] > 0 for stage in data["stages"]))
        self.assertAlmostEqual(sum(stage["Seconds"] for stage in data["stages"]), data["seconds"])
        self.assertFalse(data["running"])
        self.assertTrue(data["finished"])
        self.assertEqual(data["exitCode"], 17)
        self.assertEqual(data["outputCount"], 0)
        self.assertEqual(result.stdout.count("=== Build timing summary (success) ==="), 1)
        self.assertNotIn("Build timing summary (failed)", result.stdout)
        self.assertRegex(result.stdout, r"prepare\s+\d+\.\d{2}s\s+\d+\.\d%\s+\[success\]")
        self.assertRegex(result.stdout, r"Total build:\s+\d+\.\d{2} minutes \(\d+\.\d{2} seconds\)")

    def test_failure_summary_preserves_original_terminating_error(self):
        result = self.run_powershell(
            "trap { Write-BuildTimingSummary -Status failed; break }; "
            "Start-BuildTiming; Start-BuildStage 'prepare'; "
            "Start-BuildStage 'verify'; throw 'intentional timing test failure'; "
            "Write-Output 'unreachable'"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Build timing summary (failed)", result.stdout)
        self.assertIn("prepare [success]", result.stdout)
        self.assertIn("verify [failed]", result.stdout)
        self.assertIn("intentional timing test failure", result.stderr)
        self.assertNotIn("unreachable", result.stdout)

    def test_failure_summary_preserves_explicit_exit_code(self):
        result = self.run_powershell(
            "Start-BuildTiming; Start-BuildStage 'compress'; "
            "Write-BuildTimingSummary -Status failed; exit 1"
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("compress [failed]", result.stdout)
        self.assertIn("Total build:", result.stdout)

    def test_summary_handles_no_started_stage(self):
        result = self.run_powershell("Start-BuildTiming; Write-BuildTimingSummary")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Build timing summary (success)", result.stdout)
        self.assertIn("Total build:", result.stdout)

    def test_build_and_timing_scripts_parse(self):
        result = self.run_powershell(
            "foreach ($path in @('build.ps1', 'scripts/windows/build-timing.ps1')) { "
            "$tokens = $null; $parseErrors = $null; "
            "[Management.Automation.Language.Parser]::ParseFile("
            "(Join-Path $PWD $path), [ref]$tokens, [ref]$parseErrors) | Out-Null; "
            "if ($parseErrors.Count) { throw ($parseErrors | Out-String) } }"
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
