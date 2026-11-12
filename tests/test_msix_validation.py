import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
VALIDATOR = Path(__file__).resolve().parents[1] / "scripts" / "windows" / "validate-msix.ps1"
WORKER = "resources/windows-node/host/Workers/FileWorker/win-x64/" + "a" * 32


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Requires Windows PowerShell")
class MsixValidationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.package = Path(temporary.name) / "test.msix"
        self.files = {
            "AppxManifest.xml": (
                '<Package><Identity Name="MicroClaw.Test" Publisher="CN=MicroClaw Test" '
                'ProcessorArchitecture="x64" Version="1.0.0.0" /></Package>'
            ),
            "MicroClawDesktop.exe": "desktop",
            "resources/node.exe": "node",
            "resources/openclaw.asar": "gateway",
            "resources/windows-node/RUNTIME.json": "{}",
            "resources/windows-node/host/microclaw-windows-node-host.exe": "sdk-backed host",
            "resources/openclaw-weixin/microclaw-runtime.json": "{}",
            f"{WORKER}/payload-manifest.json": "{}",
            f"{WORKER}/OpenClaw.FileWorker.exe": "fixed worker",
            f"{WORKER}/coreclr.dll": "worker runtime",
            f"{WORKER}/OpenClaw.FileWorker.runtimeconfig.json": "{}",
        }

    def validate(self):
        with zipfile.ZipFile(self.package, "w") as archive:
            for name, content in self.files.items():
                archive.writestr(name, content)
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-File", str(VALIDATOR), "-Path", str(self.package)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_accepts_sdk_host_with_fixed_worker_without_retired_helpers(self):
        result = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_missing_host_or_fixed_worker_files(self):
        for missing in (
            "resources/windows-node/host/microclaw-windows-node-host.exe",
            f"{WORKER}/payload-manifest.json",
            f"{WORKER}/OpenClaw.FileWorker.exe",
            f"{WORKER}/coreclr.dll",
            f"{WORKER}/OpenClaw.FileWorker.runtimeconfig.json",
        ):
            with self.subTest(missing=missing):
                content = self.files.pop(missing)
                try:
                    result = self.validate()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("MSIX", result.stderr)
                finally:
                    self.files[missing] = content

    def test_rejects_retired_appcontainer_resource(self):
        self.files["resources/AppContainerLauncher.exe"] = "retired launcher"
        result = self.validate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("retired AppContainer resource", result.stderr)

    def test_rejects_ambiguous_fixed_worker_payloads(self):
        other_worker = WORKER[:-32] + "b" * 32
        self.files[f"{other_worker}/payload-manifest.json"] = "{}"
        self.files[f"{other_worker}/OpenClaw.FileWorker.exe"] = "other worker"
        result = self.validate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one x64 FileWorker", result.stderr)
