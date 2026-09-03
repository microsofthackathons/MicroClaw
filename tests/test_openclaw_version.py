import unittest

from deployer.openclaw_version import (
    NODE_FALLBACK_VERSION,
    OPENCLAW_TARGET_VERSION,
    extract_openclaw_version,
    is_supported_node_version,
)


class OpenClawVersionTests(unittest.TestCase):
    def test_target_version(self) -> None:
        self.assertEqual(OPENCLAW_TARGET_VERSION, "2026.8.2")

    def test_node_22_boundary(self) -> None:
        self.assertFalse(is_supported_node_version("v22.22.2"))
        self.assertTrue(is_supported_node_version("v22.22.3"))
        self.assertTrue(is_supported_node_version("22.23.0"))

    def test_node_23_rejection(self) -> None:
        self.assertFalse(is_supported_node_version("23.0.0"))
        self.assertFalse(is_supported_node_version("v23.10.0"))

    def test_node_24_and_25_boundaries(self) -> None:
        self.assertFalse(is_supported_node_version("24.14.9"))
        self.assertTrue(is_supported_node_version("24.15.0"))
        self.assertFalse(is_supported_node_version("25.8.9"))
        self.assertTrue(is_supported_node_version("25.9.0"))

    def test_node_26_acceptance(self) -> None:
        self.assertTrue(is_supported_node_version("26.0.0"))

    def test_fallback_validity(self) -> None:
        self.assertTrue(is_supported_node_version(NODE_FALLBACK_VERSION))

    def test_extract_openclaw_version(self) -> None:
        output = """
        npm list -g openclaw --depth=0
        C:\\Program Files\\nodejs
        `-- openclaw@2026.8.2
        """
        self.assertEqual(extract_openclaw_version(output), "2026.8.2")

    def test_extract_openclaw_version_malformed(self) -> None:
        self.assertIsNone(extract_openclaw_version("openclaw missing"))
        self.assertIsNone(extract_openclaw_version("`-- openclaw@"))
        self.assertIsNone(extract_openclaw_version("`-- openclaw@ \n"))


if __name__ == "__main__":
    unittest.main()
