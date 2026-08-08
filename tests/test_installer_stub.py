import re
import unittest
from pathlib import Path


class InstallerStubTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (
            Path(__file__).parents[1] / "installer" / "microclaw-setup.nsi"
        ).read_text(encoding="utf-8")

    def test_window_name_does_not_duplicate_setup_suffix(self):
        self.assertRegex(self.script, re.compile(r'^Name "MicroClaw"$', re.MULTILINE))
        self.assertIn('VIAddVersionKey "ProductName"    "MicroClaw Setup"', self.script)

    def test_bootstrapper_extracts_silently_before_launching_installer(self):
        self.assertRegex(
            self.script,
            re.compile(r"^SilentInstall silent$", re.MULTILINE),
        )
        self.assertNotRegex(self.script, re.compile(r"^Page instfiles$", re.MULTILINE))
        self.assertNotIn("ShowInstDetails show", self.script)
        self.assertIn('Banner::show /NOUNLOAD "$(PreparingText)"', self.script)
        self.assertIn("Banner::destroy", self.script)
        self.assertIn('LangString PreparingText ${LANG_ENGLISH}', self.script)
        self.assertIn('LangString PreparingText ${LANG_SIMPCHINESE}', self.script)
        self.assertIn("File /r \"${PAYLOAD_DIR}\\*\"", self.script)
        self.assertIn("Exec '\"$INSTDIR\\MicroClawInstaller.exe\"'", self.script)
        self.assertLess(self.script.index("Banner::show"), self.script.index("File /r"))
        self.assertLess(self.script.index("File /r"), self.script.index("Banner::destroy"))
        self.assertLess(self.script.index("Banner::destroy"), self.script.index("Exec '"))


if __name__ == "__main__":
    unittest.main()