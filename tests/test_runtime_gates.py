import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RuntimeGateTests(unittest.TestCase):
    def test_legacy_helper_uses_exact_pin_and_supported_node_floor(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn('[string]$OpenClawTag = "2026.7.1-1"', script)
        self.assertIn('$nodeVersion = "22.22.3"', script)
        self.assertIn("function Test-SupportedNodeVersion", script)
        self.assertIn("$parsed.Major -eq 23", script)

    def test_legacy_helper_refuses_nontransactional_existing_upgrade(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("requires transactional upgrade", script)
        self.assertIn("Run the MicroClaw installer", script)

    def test_ci_enforces_openclaw_node_range_in_both_jobs(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-build.yml").read_text(encoding="utf-8")

        self.assertGreaterEqual(workflow.count("22.22.3"), 2)
        self.assertGreaterEqual(workflow.count("is unsupported by OpenClaw 2026.7.1-1"), 2)

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
