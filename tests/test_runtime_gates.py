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


if __name__ == "__main__":
    unittest.main()
