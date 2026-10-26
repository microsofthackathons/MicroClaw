import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(
    os.name == "nt" and os.environ.get("MICROCLAW_DOTNET_TEST_TARGET"),
    "Requires Windows and MICROCLAW_DOTNET_TEST_TARGET for an installed .NET SDK",
)
class AppContainerAclTests(unittest.TestCase):
    def test_grants_and_shields_are_idempotent_without_skipping_permission_changes(self):
        target = os.environ["MICROCLAW_DOTNET_TEST_TARGET"]
        self.assertRegex(target, r"^net\d+\.\d+-windows$")
        root = Path(__file__).resolve().parents[1]
        project = root / "tests" / "appcontainer_acl" / "AppContainerAclTests.csproj"
        build_root = root / "build"
        build_root.mkdir(exist_ok=True)
        build = subprocess.run(
            [
                "dotnet",
                "build",
                str(project),
                f"-p:MicroClawTestTargetFramework={target}",
                "-p:NuGetAudit=false",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
        executable = project.parent / "bin" / "Debug" / target / "AppContainerAclTests.dll"
        with tempfile.TemporaryDirectory(prefix="acl-regression-", dir=build_root) as work:
            result = subprocess.run(
                ["dotnet", str(executable), str(Path(work) / "data")],
                cwd=root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"Passed \d+ ACL assertions")
            self.assertIn("ACL writes: 0", result.stdout)
