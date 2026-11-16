import io
import ssl
import threading
import time
import unittest
import urllib.error
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deployer.windows_setup import NPM_REGISTRY_HUAWEI, NPM_REGISTRY_HUAWEI_MIRRORS, WindowsSetup


class NpmRegistryProbeTests(unittest.TestCase):
    def setUp(self):
        self.setup = WindowsSetup.__new__(WindowsSetup)
        self.setup.log = Mock()
        self.setup.cfg = SimpleNamespace(get=lambda key, default=None: default)

    def test_https_response_confirms_registry(self):
        registry = "https://registry.example/npm/"
        with patch(
            "deployer.windows_setup.urllib.request.urlopen",
            return_value=closing(io.BytesIO(b"{}")),
        ) as urlopen:
            self.assertEqual(self.setup._reachable_npm_registries([registry]), [registry])
        self.assertEqual(urlopen.call_args.args[0].full_url, registry + "-/ping")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 5.0)

    def test_missing_ping_endpoint_does_not_reject_registry(self):
        registry = "https://registry.example"
        error = urllib.error.HTTPError(registry + "/-/ping", 404, "not found", {}, None)
        with patch("deployer.windows_setup.urllib.request.urlopen", side_effect=error):
            self.assertEqual(self.setup._reachable_npm_registries([registry]), [registry])

    def test_npm_attempts_do_not_depend_on_unauthenticated_python_probes(self):
        registry = "https://registry.example"
        self.setup._npm_registry_candidates = Mock(return_value=[registry])
        error = urllib.error.URLError(ssl.SSLError("certificate verify failed"))
        with patch("deployer.windows_setup.urllib.request.urlopen", side_effect=error):
            self.assertEqual(self.setup._npm_registry_attempts(), [registry])
        self.setup.log.warn.assert_not_called()

    def test_slow_probe_does_not_discard_completed_results_or_block_until_shutdown(self):
        fast = "https://fast.example"
        slow = "https://slow.example"
        release = threading.Event()

        def urlopen(request, **kwargs):
            if request.full_url.startswith(slow):
                release.wait(3)
                raise TimeoutError("slow DNS lookup")
            return closing(io.BytesIO(b"{}"))

        try:
            with patch("deployer.windows_setup.urllib.request.urlopen", side_effect=urlopen):
                started = time.monotonic()
                result = self.setup._reachable_npm_registries([slow, fast], timeout=0.01)
                elapsed = time.monotonic() - started
            self.assertEqual(result, [fast])
            self.assertLess(elapsed, 2)
        finally:
            release.set()

    def test_candidate_order_preserves_deployment_priority(self):
        candidates = ["https://configured.example", "https://fast.example", "https://slow.example"]
        self.setup._npm_registry_candidates = Mock(return_value=candidates)
        self.setup._reachable_npm_registries = Mock(return_value=[candidates[1]])
        self.assertEqual(
            self.setup._npm_registry_attempts(),
            candidates,
        )

    def test_candidates_include_both_huawei_https_endpoints_without_duplicates(self):
        def configured_registry(key, default=None):
            return {"npm.registry": NPM_REGISTRY_HUAWEI_MIRRORS,
                    "npm.fallback_registries": [NPM_REGISTRY_HUAWEI]}.get(key, default)

        self.setup.cfg = SimpleNamespace(get=configured_registry)
        candidates = self.setup._npm_registry_candidates()
        self.assertEqual(candidates[0], NPM_REGISTRY_HUAWEI_MIRRORS.rstrip("/"))
        self.assertEqual(candidates[1], NPM_REGISTRY_HUAWEI.rstrip("/"))
        self.assertEqual(len(candidates), len(set(registry.rstrip("/") for registry in candidates)))
        self.assertTrue(all(registry.startswith("https://") for registry in candidates))
