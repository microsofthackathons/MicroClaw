import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from deployer.openclaw_version import OPENCLAW_TARGET_VERSION, is_supported_node_version

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


class RuntimeGateTests(unittest.TestCase):
    def test_approval_replay_hook_targets_installer_openclaw_version(self):
        hook = (ROOT / "desktop" / "src" / "openclaw-approval-replay-compat.mjs").read_text(
            encoding="utf-8"
        )
        versions = re.findall(r'^const EXPECTED_VERSION\s*=\s*"([^"]+)";$', hook, re.MULTILINE)
        self.assertEqual(versions, [OPENCLAW_TARGET_VERSION])

    def test_legacy_helper_uses_exact_pin_and_supported_node_floor(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn('[string]$OpenClawTag = "2026.9.3"', script)
        self.assertIn('$nodeVersion = "26.1.0"', script)
        self.assertIn(r'. "$PSScriptRoot\node-runtime.ps1"', script)
        self.assertIn("Test-SupportedNodeVersion $v", script)
        self.assertIn("Test-SupportedNodeVersion $ver", script)
        self.assertIn("'^26\\.'", script)

    @unittest.skipUnless(POWERSHELL, "PowerShell is required to exercise its runtime gate")
    def test_powershell_gate_matches_python_for_boundaries_and_malformed_versions(self):
        versions = [
            "v22.22.3",
            "22.99.0",
            "23.10.0",
            "24.15.9",
            "24.16.0",
            "v24.17.0",
            "25.0.0",
            "25.9.0",
            "25.99.0",
            "26.0.0",
            "v26.0.9",
            "26.1.0",
            "v26.2.0",
            "27.0.0",
            "",
            "26",
            "26.1",
            "26.1.0.0",
            "26.1.0-rc.1",
            "26.1.0+build.1",
            " 26.1.0",
            "26.1.0\n",
            "vv26.1.0",
            "V26.1.0",
            "026.1.0",
            "26.01.0",
            "26.1.00",
            "-26.1.0",
            "26.a.0",
        ]
        command = (
            r". .\scripts\windows\node-runtime.ps1; "
            f"$versions = '{json.dumps(versions)}' | ConvertFrom-Json; "
            "$results = @($versions | ForEach-Object { Test-SupportedNodeVersion $_ }); "
            "ConvertTo-Json -InputObject $results -Compress"
        )
        result = subprocess.run(
            [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        self.assertEqual(
            json.loads(result.stdout),
            [is_supported_node_version(version) for version in versions],
        )

    def test_build_validates_standard_and_path_node_candidates(self):
        script = (ROOT / "build.ps1").read_text(encoding="utf-8")
        self.assertIn(r'. "$root\scripts\windows\node-runtime.ps1"', script)
        self.assertEqual(script.count("Test-SupportedNodeVersion $version"), 2)
        self.assertIn(">=24.16.0 <25 || >=26.1.0", script)

    def test_installer_bundles_runtime_gate_beside_standalone_setup_script(self):
        spec = (ROOT / "MicroClawDeployer.spec").read_text(encoding="utf-8")
        self.assertIn("('scripts/windows/node-runtime.ps1', '.')", spec)

    def test_legacy_helper_refuses_nontransactional_existing_upgrade(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("requires transactional upgrade", script)
        self.assertIn("Run the MicroClaw installer", script)

    def test_ci_enforces_openclaw_node_range_in_both_jobs(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-build.yml").read_text(encoding="utf-8")

        self.assertEqual(workflow.count(r". .\scripts\windows\node-runtime.ps1"), 2)
        self.assertEqual(workflow.count("Test-SupportedNodeVersion $node"), 2)
        self.assertGreaterEqual(workflow.count("is unsupported by OpenClaw 2026.9.3"), 2)

    def test_release_enforces_openclaw_node_range(self):
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")

        self.assertIn('node-version: "26"', workflow)
        self.assertIn(r". .\scripts\windows\node-runtime.ps1", workflow)
        self.assertIn("Test-SupportedNodeVersion $node", workflow)
        self.assertIn("is unsupported by OpenClaw 2026.9.3", workflow)

    def test_security_workflow_uses_recommended_node(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-security-check.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('node-version: "26"', workflow)

    def test_ci_runs_python_unit_tests(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-build.yml").read_text(encoding="utf-8")

        self.assertIn("python -m unittest discover -s tests -v", workflow)

    def test_build_uses_uv_only_for_a_real_uv_project(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")

        self.assertIn("$hasUvProject", build_script)
        self.assertIn("if ($hasUvProject)", build_script)
        self.assertIn(
            'python -m pip install -r "$root\\requirements.txt"',
            build_script,
        )
        self.assertIn("$pipExitCode = $LASTEXITCODE", build_script)

    def test_installer_spec_excludes_weixin_runtime(self):
        spec = (ROOT / "MicroClawDeployer.spec").read_text(encoding="utf-8")

        self.assertNotIn("weixin_plugin_datas", spec)
        self.assertNotIn("plugins/openclaw-weixin", spec)
        self.assertNotIn("collect_plugin_files", spec)
        self.assertNotIn("('plugins', 'plugins')", spec)

    def test_build_does_not_stage_weixin_archives(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")

        for archive in (
            "tencent-weixin-openclaw-weixin-2.4.6.tgz",
            "zod-4.4.3.tgz",
            "qrcode-terminal-0.12.0.tgz",
        ):
            self.assertNotIn(archive, build_script)
        self.assertNotIn("Stage Weixin plugin", build_script)

    def test_nsis_build_declares_utf8_input_charset(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")

        self.assertIn('"/INPUTCHARSET"', build_script)
        self.assertIn('"UTF8"', build_script)


if __name__ == "__main__":
    unittest.main()
