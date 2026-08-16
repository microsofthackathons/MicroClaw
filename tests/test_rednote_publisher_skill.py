from __future__ import annotations

import json
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "rednote-publisher"
POWERSHELL = shutil.which("powershell")


@unittest.skipUnless(POWERSHELL, "Windows PowerShell is required")
class RednotePublisherSkillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.package_dir = Path(self.temp_dir.name) / "package"
        self.package_dir.mkdir()
        for name in (
            "ideas.example.json",
            "ideas.example.md",
            "material-kit.example.json",
            "material-kit.example.md",
            "package.example.json",
        ):
            target_name = name.replace(".example", "")
            shutil.copy2(SKILL / "examples" / name, self.package_dir / target_name)
        self.validate_stage("Ideas", "ideas-validation.json")
        self.validate_stage("Material", "material-validation.json")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_script(self, name: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SKILL / "scripts" / name),
                *args,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    @staticmethod
    def png_dimensions(path: Path) -> tuple[int, int]:
        with path.open("rb") as stream:
            header = stream.read(24)
        if header[:8] != b"\x89PNG\r\n\x1a\n":
            raise AssertionError(f"{path} is not a PNG")
        return struct.unpack(">II", header[16:24])

    def render(self) -> subprocess.CompletedProcess[str]:
        return self.run_script(
            "New-RednotePackage.ps1",
            "-SpecPath",
            str(self.package_dir / "package.json"),
            "-OutputPath",
            str(self.package_dir),
        )

    def validate_stage(self, stage: str, output_name: str) -> subprocess.CompletedProcess[str]:
        result = self.run_script(
            "Test-RednoteStage.ps1",
            "-Stage",
            stage,
            "-ProjectPath",
            str(self.package_dir),
            "-OutputPath",
            str(self.package_dir / output_name),
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        return result

    def test_validates_ideas_and_material_as_distinct_stages(self) -> None:
        ideas = json.loads(
            (self.package_dir / "ideas-validation.json").read_text(encoding="utf-8-sig")
        )
        material = json.loads(
            (self.package_dir / "material-validation.json").read_text(encoding="utf-8-sig")
        )
        self.assertTrue(ideas["ok"])
        self.assertEqual(ideas["stage"], "Ideas")
        self.assertEqual(ideas["selectedIdeaId"], "idea-01")
        self.assertTrue(material["ok"])
        self.assertEqual(material["stage"], "Material")
        self.assertEqual(material["materialKitId"], "kit-idea-01")

    def test_renders_and_validates_publish_ready_package(self) -> None:
        rendered = self.render()
        self.assertEqual(rendered.returncode, 0, rendered.stderr)

        validation_path = self.package_dir / "validation.json"
        validated = self.run_script(
            "Test-RednotePackage.ps1",
            "-PackagePath",
            str(self.package_dir),
            "-OutputPath",
            str(validation_path),
        )
        self.assertEqual(validated.returncode, 0, validated.stdout + validated.stderr)
        result = json.loads(validation_path.read_text(encoding="utf-8-sig"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["cardCount"], 3)
        self.assertEqual(self.png_dimensions(self.package_dir / "cover.png"), (1242, 1660))
        self.assertEqual(
            self.png_dimensions(self.package_dir / "cards" / "01.png"),
            (1242, 1660),
        )
        self.assertIn(
            "小红书发布包", (self.package_dir / "post.md").read_text(encoding="utf-8-sig")
        )

    def test_requires_force_before_replacing_generated_outputs(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        custom_card = self.package_dir / "cards" / "user-photo.png"
        custom_card.write_bytes(b"user-owned")
        second = self.render()
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("Use -Force", second.stderr)

        forced = self.run_script(
            "New-RednotePackage.ps1",
            "-SpecPath",
            str(self.package_dir / "package.json"),
            "-OutputPath",
            str(self.package_dir),
            "-Force",
        )
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertEqual(custom_card.read_bytes(), b"user-owned")

    def test_requires_force_for_a_different_output_package_json(self) -> None:
        source_spec = Path(self.temp_dir.name) / "source.json"
        shutil.copy2(self.package_dir / "package.json", source_spec)

        rendered = self.run_script(
            "New-RednotePackage.ps1",
            "-SpecPath",
            str(source_spec),
            "-OutputPath",
            str(self.package_dir),
        )

        self.assertNotEqual(rendered.returncode, 0)
        self.assertIn("Use -Force", rendered.stderr)

    def test_rejects_text_that_does_not_fit_a_card(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        previous_cover = (self.package_dir / "cover.png").read_bytes()
        previous_post = (self.package_dir / "post.md").read_text(encoding="utf-8-sig")
        spec_path = Path(self.temp_dir.name) / "package.next.json"
        spec = json.loads((self.package_dir / "package.json").read_text(encoding="utf-8-sig"))
        spec["slides"][0]["body"] = "This content is intentionally too long. " * 200
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        rendered = self.run_script(
            "New-RednotePackage.ps1",
            "-SpecPath",
            str(spec_path),
            "-OutputPath",
            str(self.package_dir),
            "-Force",
        )

        self.assertNotEqual(rendered.returncode, 0)
        self.assertIn("does not fit the visual template", rendered.stderr)
        self.assertEqual((self.package_dir / "cover.png").read_bytes(), previous_cover)
        self.assertEqual(
            (self.package_dir / "post.md").read_text(encoding="utf-8-sig"),
            previous_post,
        )

    def test_validation_rejects_placeholder_text(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        with (self.package_dir / "post.md").open("a", encoding="utf-8") as stream:
            stream.write("\nTODO\n")

        validated = self.run_script(
            "Test-RednotePackage.ps1",
            "-PackagePath",
            str(self.package_dir),
        )
        self.assertNotEqual(validated.returncode, 0)
        self.assertIn("Placeholder text found", validated.stdout)

    def test_validation_rejects_a_corrupt_png(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        cover_path = self.package_dir / "cover.png"
        png = bytearray(cover_path.read_bytes())
        offset = 8
        while offset < len(png):
            length = struct.unpack(">I", png[offset : offset + 4])[0]
            chunk_type = bytes(png[offset + 4 : offset + 8])
            data_start = offset + 8
            data_end = data_start + length
            if chunk_type == b"IDAT" and length > 8:
                png[data_start + (length // 2)] ^= 0xFF
                crc = zlib.crc32(chunk_type + bytes(png[data_start:data_end])) & 0xFFFFFFFF
                png[data_end : data_end + 4] = struct.pack(">I", crc)
                break
            offset = data_end + 4
        cover_path.write_bytes(png)

        validated = self.run_script(
            "Test-RednotePackage.ps1",
            "-PackagePath",
            str(self.package_dir),
        )

        self.assertNotEqual(validated.returncode, 0)
        self.assertIn("Unreadable PNG image", validated.stdout)

    def test_validation_rejects_invalid_arrays_and_manifest_paths(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        spec_path = self.package_dir / "package.json"
        spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
        spec["titles"] = ["title"] * 6
        spec["hashtags"] = ["tag"] * 11
        spec["slides"][0]["title"] = None
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        manifest_path = self.package_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        manifest["schemaVersion"] = 2
        manifest["files"]["cards"] = ["cards/missing.png"] * 3
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        validated = self.run_script(
            "Test-RednotePackage.ps1",
            "-PackagePath",
            str(self.package_dir),
        )

        self.assertNotEqual(validated.returncode, 0)
        self.assertIn("3-5 non-empty title options", validated.stdout)
        self.assertIn("3-10 non-empty hashtags", validated.stdout)
        self.assertIn("Every package.json slide", validated.stdout)
        self.assertIn("schemaVersion", validated.stdout)
        self.assertIn("card paths", validated.stdout)

    def test_material_stage_rejects_an_unknown_selected_idea(self) -> None:
        material_path = self.package_dir / "material-kit.json"
        material = json.loads(material_path.read_text(encoding="utf-8-sig"))
        material["selectedIdeaId"] = "idea-99"
        material_path.write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")

        validated = self.run_script(
            "Test-RednoteStage.ps1",
            "-Stage",
            "Material",
            "-ProjectPath",
            str(self.package_dir),
        )

        self.assertNotEqual(validated.returncode, 0)
        self.assertIn("selectedIdeaId must match", validated.stdout)

    def test_stage_validator_returns_structured_failure_for_missing_fields(self) -> None:
        (self.package_dir / "ideas.json").write_text(
            json.dumps({"schemaVersion": 1}), encoding="utf-8"
        )

        validated = self.run_script(
            "Test-RednoteStage.ps1",
            "-Stage",
            "Ideas",
            "-ProjectPath",
            str(self.package_dir),
            "-OutputPath",
            str(self.package_dir / "ideas-validation.json"),
        )

        self.assertNotEqual(validated.returncode, 0)
        result = json.loads(
            (self.package_dir / "ideas-validation.json").read_text(encoding="utf-8-sig")
        )
        self.assertFalse(result["ok"])
        self.assertTrue(result["errors"])

    def test_final_validation_rechecks_stages_instead_of_trusting_stale_ok(self) -> None:
        self.assertEqual(self.render().returncode, 0)
        ideas = json.loads((self.package_dir / "ideas.json").read_text(encoding="utf-8-sig"))
        ideas["ideas"] = ideas["ideas"][:1]
        (self.package_dir / "ideas.json").write_text(
            json.dumps(ideas, ensure_ascii=False), encoding="utf-8"
        )
        (self.package_dir / "ideas-validation.json").write_text(
            json.dumps({"ok": True}), encoding="utf-8"
        )

        validated = self.run_script(
            "Test-RednotePackage.ps1",
            "-PackagePath",
            str(self.package_dir),
        )

        self.assertNotEqual(validated.returncode, 0)
        self.assertIn("Ideas stage validation failed", validated.stdout)
        self.assertIn("exactly 5 ideas", validated.stdout)

    def test_renderer_rejects_a_mismatched_material_kit(self) -> None:
        spec_path = self.package_dir / "package.json"
        spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
        spec["materialKitId"] = "kit-wrong"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        rendered = self.render()

        self.assertNotEqual(rendered.returncode, 0)
        self.assertIn("materialKitId must match", rendered.stderr)


if __name__ == "__main__":
    unittest.main()
