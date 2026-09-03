import json
import tempfile
import unittest
from pathlib import Path

from deployer.install_manifest import (
    build_identity_matches,
    committed_install_manifest,
    load_install_manifest,
    resolve_bundled_install_manifest,
    write_install_manifest,
)


def _manifest(**overrides):
    return {
        "schema": 1,
        "desktopArchiveSha256": "desktop",
        "installerBundleId": "installer",
        "managedSkillsId": "skills",
        "openClawVersion": "2026.8.2",
        "appContainerSchema": 1,
        **overrides,
    }


class InstallManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_load_rejects_missing_and_malformed_manifests(self):
        self.assertIsNone(load_install_manifest(self.root / "missing.json"))
        malformed = self.root / "malformed.json"
        malformed.write_text("not json", encoding="utf-8")
        self.assertIsNone(load_install_manifest(malformed))
        malformed.write_text(json.dumps({"schema": 1}), encoding="utf-8")
        self.assertIsNone(load_install_manifest(malformed))

    def test_build_identity_requires_every_build_field_to_match(self):
        bundled = _manifest()
        self.assertTrue(build_identity_matches(bundled, _manifest(npmRegistry="registry")))
        for key in (
            "desktopArchiveSha256",
            "installerBundleId",
            "managedSkillsId",
            "openClawVersion",
            "appContainerSchema",
        ):
            with self.subTest(key=key):
                self.assertFalse(build_identity_matches(bundled, _manifest(**{key: "changed"})))

    def test_committed_manifest_normalizes_runtime_registry(self):
        committed = committed_install_manifest(_manifest(), " HTTPS://Registry.Example/ ")

        self.assertEqual(committed["npmRegistry"], "https://registry.example")

    def test_write_and_load_round_trip(self):
        path = self.root / "state" / "install-manifest.json"
        payload = committed_install_manifest(_manifest(), "https://registry.example/")

        write_install_manifest(path, payload)

        self.assertEqual(load_install_manifest(path), payload)
        self.assertEqual(list(path.parent.glob(".*.tmp")), [])

    def test_frozen_bundle_is_preferred(self):
        executable = self.root / "bundle" / "MicroClawInstaller.exe"
        internal = executable.parent / "_internal"
        internal.mkdir(parents=True)
        bundled = _manifest(installerBundleId="frozen")
        (internal / "install-manifest.json").write_text(
            json.dumps(bundled), encoding="utf-8"
        )
        app_dir = self.root / "app"
        (app_dir / "dist").mkdir(parents=True)
        (app_dir / "dist" / "install-manifest.json").write_text(
            json.dumps(_manifest(installerBundleId="dev")), encoding="utf-8"
        )

        resolved = resolve_bundled_install_manifest(
            frozen=True,
            executable=executable,
            app_dir=app_dir,
        )

        self.assertEqual(resolved["installerBundleId"], "frozen")

    def test_build_generates_and_packages_install_manifest(self):
        repository = Path(__file__).parents[1]
        build_script = (repository / "build.ps1").read_text(encoding="utf-8")
        spec = (repository / "MicroClawDeployer.spec").read_text(encoding="utf-8")

        for field in (
            "desktopArchiveSha256",
            "installerBundleId",
            "managedSkillsId",
            "openClawVersion",
            "appContainerSchema",
        ):
            self.assertIn(field, build_script)
        self.assertIn("dist\\install-manifest.json", build_script)
        self.assertIn("('dist/install-manifest.json', '.')", spec)
