import unittest

from deployer.config import DEFAULT_CONFIG
from deployer.openclaw_version import (
    NODE_ENGINE_RANGE,
    NODE_FALLBACK_VERSION,
    OPENCLAW_TARGET_VERSION,
    extract_openclaw_version,
    is_supported_node_version,
)


class OpenClawVersionTests(unittest.TestCase):
    def test_target_version(self) -> None:
        self.assertEqual(OPENCLAW_TARGET_VERSION, "2026.9.3")
        self.assertEqual(NODE_ENGINE_RANGE, ">=24.16.0 <25 || >=26.1.0")

    def test_unsupported_node_lines(self) -> None:
        for version in (
            "20.20.0",
            "v22.22.3",
            "22.99.0",
            "23.0.0",
            "v23.10.0",
            "25.9.0",
            "25.99.0",
        ):
            with self.subTest(version=version):
                self.assertFalse(is_supported_node_version(version))

    def test_node_24_boundary(self) -> None:
        self.assertFalse(is_supported_node_version("24.15.9"))
        self.assertTrue(is_supported_node_version("v24.16.0"))
        self.assertTrue(is_supported_node_version("24.17.0"))

    def test_node_26_boundary_and_newer(self) -> None:
        self.assertFalse(is_supported_node_version("26.0.0"))
        self.assertFalse(is_supported_node_version("v26.0.9"))
        self.assertTrue(is_supported_node_version("26.1.0"))
        self.assertTrue(is_supported_node_version("v26.2.0"))
        self.assertTrue(is_supported_node_version("27.0.0"))

    def test_malformed_node_versions(self) -> None:
        for version in (
            "",
            "26",
            "26.1",
            "26.1.0.0",
            "v26.1.0-rc.1",
            "26.1.0+build.1",
            " 26.1.0",
            "26.1.0\n",
            "vv26.1.0",
            "V26.1.0",
            "026.1.0",
            "26.01.0",
            "26.1.00",
            "２６.1.0",
            "-26.1.0",
            "26.a.0",
        ):
            with self.subTest(version=version):
                self.assertFalse(is_supported_node_version(version))

    def test_fallback_validity(self) -> None:
        self.assertEqual(NODE_FALLBACK_VERSION, "26.1.0")
        self.assertEqual(DEFAULT_CONFIG["node"]["version"], "26")
        self.assertTrue(is_supported_node_version(NODE_FALLBACK_VERSION))

    def test_extract_openclaw_version(self) -> None:
        output = """
        npm list -g openclaw --depth=0
        C:\\Program Files\\nodejs
        `-- openclaw@2026.9.3
        """
        self.assertEqual(extract_openclaw_version(output), "2026.9.3")

    def test_extract_openclaw_version_malformed(self) -> None:
        self.assertIsNone(extract_openclaw_version("openclaw missing"))
        self.assertIsNone(extract_openclaw_version("`-- openclaw@"))
        self.assertIsNone(extract_openclaw_version("`-- openclaw@ \n"))


if __name__ == "__main__":
    unittest.main()
