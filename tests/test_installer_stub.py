import re
import unittest
from pathlib import Path


class InstallerStubTests(unittest.TestCase):
    def test_window_name_does_not_duplicate_setup_suffix(self):
        script = (
            Path(__file__).parents[1] / "installer" / "microclaw-setup.nsi"
        ).read_text(encoding="utf-8")

        self.assertRegex(script, re.compile(r'^Name "MicroClaw"$', re.MULTILINE))
        self.assertIn('VIAddVersionKey "ProductName"    "MicroClaw Setup"', script)


if __name__ == "__main__":
    unittest.main()