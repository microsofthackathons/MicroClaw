import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
DEFAULT_REGISTRY = "https://repo.huaweicloud.com/repository/npm/"
GENERAL_REGISTRY = "https://packagefeedproxy.microsoft.io/npm/"
REGISTRY_KEYS = ("MICROCLAW_NPM_REGISTRY", "MSIX_NPM_REGISTRY", "NPM_CONFIG_REGISTRY")


@unittest.skipUnless(POWERSHELL, "Requires PowerShell")
class BuildResourceRegistryTests(unittest.TestCase):
    def run_stage(self, *, microclaw=None, msix=None, failure=None, cache_hit=False):
        source = (ROOT / "build.ps1").read_text(encoding="utf-8-sig")
        dependencies = source[
            source.index("Start-BuildStage 'Preflight: desktop dependencies'") : source.index(
                "# -- Step 1:"
            )
        ]
        resources = source[
            source.index("Start-BuildStage 'Step 1/7: prepare packaged resources'") : source.index(
                "Start-BuildStage 'Preflight: verify core resource target'"
            )
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "desktop").mkdir()
            probe = root / "npm_probe.py"
            probe.write_text(
                "import json, os, sys\n"
                "with open(os.environ['BUILD_TEST_LOG'], 'a', encoding='utf-8') as log:\n"
                "    log.write(json.dumps({'args': sys.argv[1:], 'env': {\n"
                f"        key: os.environ.get(key) for key in {REGISTRY_KEYS!r}"
                "}}) + '\\n')\n"
                "if sys.argv[1:] == ['run', 'prepare-packaged-resources']:\n"
                "    sys.exit(23 if os.environ.get('BUILD_TEST_FAILURE') == 'exit' else 0)\n",
                encoding="utf-8",
            )
            snapshot = (
                "@{ microclaw=$env:MICROCLAW_NPM_REGISTRY; msix=$env:MSIX_NPM_REGISTRY; "
                "general=$env:NPM_CONFIG_REGISTRY; location=(Get-Location).Path }"
            )
            harness = root / "build.ps1"
            harness.write_text(
                "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n"
                "$root = $PSScriptRoot\n"
                "function Start-BuildStage { param($Name) }\n"
                "function Save-BuildCache { param($Cache) }\n"
                "function Write-BuildTimingSummary { param($Status) }\n"
                "function npm {\n"
                "    & $env:BUILD_TEST_PYTHON $env:BUILD_TEST_PROBE @args\n"
                "    if ($args[0] -eq 'run' -and $env:BUILD_TEST_FAILURE -eq 'throw') {\n"
                "        throw 'intentional resource launch failure'\n"
                "    }\n"
                "}\n"
                f"$nativeCache = [pscustomobject]@{{ hit=${str(cache_hit).lower()} }}\n"
                f"$before = {snapshot}\n"
                "try {\n" + dependencies + resources + "} finally {\n"
                f"    $after = {snapshot}\n"
                "    'ENV_JSON:' + (ConvertTo-Json -Compress @{ before=$before; after=$after })\n"
                "}\n",
                encoding="utf-8-sig",
            )
            env = {
                key: value for key, value in os.environ.items() if key.upper() not in REGISTRY_KEYS
            }
            env.update(
                NPM_CONFIG_REGISTRY=GENERAL_REGISTRY,
                BUILD_TEST_PYTHON=sys.executable,
                BUILD_TEST_PROBE=str(probe),
                BUILD_TEST_LOG=str(root / "calls.jsonl"),
                BUILD_TEST_FAILURE=failure or "",
            )
            if microclaw is not None:
                env["MICROCLAW_NPM_REGISTRY"] = microclaw
            if msix is not None:
                env["MSIX_NPM_REGISTRY"] = msix
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
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            calls = [
                json.loads(line)
                for line in (root / "calls.jsonl").read_text(encoding="utf-8").splitlines()
            ]
        state = json.loads(result.stdout.split("ENV_JSON:", 1)[1].splitlines()[0])
        self.assertEqual(state["before"], state["after"], result.stdout + result.stderr)
        self.assertEqual(calls[0]["args"], ["install"])
        self.assertEqual(
            calls[0]["env"],
            dict(zip(REGISTRY_KEYS, (microclaw, msix, GENERAL_REGISTRY), strict=True)),
        )
        return result, calls

    def test_resource_registry_precedence_without_changing_dependency_registry(self):
        for microclaw, msix, expected in (
            (None, None, DEFAULT_REGISTRY),
            ("https://custom.example/npm/", None, "https://custom.example/npm/"),
            (None, "https://msix.example/npm/", "https://msix.example/npm/"),
            (
                "https://custom.example/npm/",
                "https://msix.example/npm/",
                "https://custom.example/npm/",
            ),
        ):
            with self.subTest(microclaw=microclaw, msix=msix):
                result, calls = self.run_stage(microclaw=microclaw, msix=msix)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls[1]["args"], ["run", "prepare-packaged-resources"])
                self.assertEqual(calls[1]["env"]["MICROCLAW_NPM_REGISTRY"], expected)
                self.assertEqual(calls[1]["env"]["MSIX_NPM_REGISTRY"], msix)
                self.assertEqual(calls[1]["env"]["NPM_CONFIG_REGISTRY"], GENERAL_REGISTRY)
                self.assertIn(expected.split("://")[1].split("/")[0], result.stdout)

    def test_preparation_failures_restore_environment_and_remain_failures(self):
        for failure, microclaw in (
            ("exit", None),
            ("exit", "https://custom.example/npm/"),
            ("throw", None),
        ):
            with self.subTest(failure=failure, microclaw=microclaw):
                result, calls = self.run_stage(microclaw=microclaw, failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(
                    calls[1]["env"]["MICROCLAW_NPM_REGISTRY"], microclaw or DEFAULT_REGISTRY
                )
                self.assertIn(
                    "resource launch failure" if failure == "throw" else "preparation failed",
                    result.stdout + result.stderr,
                )

    def test_diagnostic_logs_only_registry_origin_not_credentials_path_or_query(self):
        registry = (
            "https://builder:private-password@registry.example/private-path/?token=private-token"
        )
        result, calls = self.run_stage(microclaw=registry)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1]["env"]["MICROCLAW_NPM_REGISTRY"], registry)
        diagnostics = result.stdout.split("ENV_JSON:", 1)[0] + result.stderr
        self.assertIn("https://registry.example", diagnostics)
        for secret in ("builder", "private-password", "private-path", "private-token"):
            self.assertNotIn(secret, diagnostics)

    def test_cache_hit_skips_acquisition_without_changing_environment(self):
        result, calls = self.run_stage(cache_hit=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)

    def test_invalid_registry_fails_without_exposing_value_or_leaking_environment(self):
        registry = "invalid-registry private-secret"
        result, calls = self.run_stage(microclaw=registry)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        diagnostics = result.stdout.split("ENV_JSON:", 1)[0] + result.stderr
        self.assertIn("must be an absolute HTTP(S) URL", diagnostics)
        self.assertNotIn(registry, diagnostics)


if __name__ == "__main__":
    unittest.main()
