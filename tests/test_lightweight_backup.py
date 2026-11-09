import io
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

from deployer.lightweight_backup import (
    BACKUP_SCOPE,
    create_lightweight_archive,
    verify_lightweight_archive,
)


class LightweightBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.desktop = self.root / "desktop"
        self.scratch = self.root / "scratch"
        self.state.mkdir()
        self.scratch.mkdir()
        self.config = self.state / "openclaw.json"
        self.config.write_text('{"fixture":true}', encoding="utf-8")
        self.archive = self.root / "state.tar.gz"
        self.plan_path = self.scratch / "plan.json"
        self.plan = {
            "scope": BACKUP_SCOPE,
            "verifiedSqlite": True,
            "sourceVersion": "2026.10.5",
            "stateDir": str(self.state),
            "desktopDir": str(self.desktop),
            "workspaceDirs": [str(self.root / "external-workspace")],
            "directories": [str(self.root / "empty-workspace")],
            "entries": [
                {"sourcePath": str(self.config), "stagedPath": str(self.config), "kind": "config"}
            ],
        }

    def create(self):
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        return create_lightweight_archive(
            self.plan_path,
            self.archive,
            state_dir=self.state,
            desktop_dir=self.desktop,
            source_version="2026.10.5",
            progress=Mock(),
        )

    def test_roundtrip_contains_explicit_scope_sources_hashes_and_empty_directories(self):
        result = self.create()
        self.assertEqual(verify_lightweight_archive(self.archive), result)
        self.assertEqual(result["scope"], BACKUP_SCOPE)
        self.assertEqual(result["entries"][0]["sourcePath"], str(self.config))
        self.assertEqual(result["directories"], self.plan["directories"])
        self.assertNotIn("stagedPath", result["entries"][0])
        self.assertEqual(self.config.read_text(), '{"fixture":true}')

    def test_uncaptured_live_sqlite_is_refused_even_inside_workspace(self):
        database = self.root / "external-workspace" / "unknown.db"
        database.parent.mkdir()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("CREATE TABLE fixture(value TEXT)")
        self.plan["entries"].append(
            {"sourcePath": str(database), "stagedPath": str(database), "kind": "workspace"}
        )
        with self.assertRaisesRegex(ValueError, "no verified OpenClaw snapshot"):
            self.create()
        self.assertFalse(self.archive.exists())

    def test_verified_database_artifact_is_archived_instead_of_live_bytes(self):
        original = self.state / "state" / "openclaw.sqlite"
        original.parent.mkdir()
        original.write_bytes(b"not a safe raw backup")
        snapshot = self.scratch / "snapshot.sqlite"
        with closing(sqlite3.connect(snapshot)) as connection, connection:
            connection.execute("CREATE TABLE fixture(value TEXT)")
        self.plan["entries"].append(
            {
                "sourcePath": str(original),
                "stagedPath": str(snapshot),
                "kind": "verified-sqlite-or-audit",
            }
        )
        result = self.create()
        with tarfile.open(self.archive) as bundle:
            self.assertEqual(
                bundle.extractfile(result["entries"][1]["archivePath"]).read(),
                snapshot.read_bytes(),
            )
        self.assertEqual(original.read_bytes(), b"not a safe raw backup")

    def test_bad_scope_wrong_owner_and_missing_configuration_are_refused(self):
        for change in (
            {"scope": "full"},
            {"verifiedSqlite": False},
            {"sourceVersion": "2026.10.10"},
            {"stateDir": str(self.root)},
            {"entries": []},
        ):
            with (
                self.subTest(change=change),
                patch.dict(self.plan, change),
                self.assertRaises(ValueError),
            ):
                self.create()
        self.assertFalse(self.archive.exists())

    def test_snapshot_cannot_reference_a_staging_file_outside_the_private_generation(self):
        outside = self.root / "outside"
        outside.write_bytes(b"outside")
        self.plan["entries"][0]["stagedPath"] = str(outside)
        with self.assertRaisesRegex(ValueError, "redirected"):
            self.create()

    def test_existing_recovery_archive_is_never_overwritten(self):
        self.archive.write_bytes(b"keep recovery evidence")
        with self.assertRaises(FileExistsError):
            self.create()
        self.assertEqual(self.archive.read_bytes(), b"keep recovery evidence")

    def test_failed_durable_flush_never_publishes_a_backup(self):
        with (
            patch("deployer.lightweight_backup._fsync_file", side_effect=OSError("flush failed")),
            self.assertRaisesRegex(OSError, "flush failed"),
        ):
            self.create()
        self.assertFalse(self.archive.exists())

    def test_changed_source_is_refused_before_publication(self):
        def mutate(_path):
            self.config.write_text("concurrent edit", encoding="utf-8")
            return "0" * 64

        with (
            patch("deployer.lightweight_backup._digest", side_effect=mutate),
            self.assertRaisesRegex(ValueError, "changed"),
        ):
            self.create()
        self.assertFalse(self.archive.exists())

    def test_tampered_payload_or_additional_symlink_is_rejected(self):
        manifest = self.create()
        for extra_link in (False, True):
            corrupted = self.root / f"bad-{extra_link}.tar.gz"
            with tarfile.open(corrupted, "w:gz") as bundle:
                for name, content in (
                    ("manifest.json", json.dumps(manifest).encode()),
                    ("payload/00000000", self.config.read_bytes() if extra_link else b"changed"),
                ):
                    member = tarfile.TarInfo(name)
                    member.size = len(content)
                    bundle.addfile(member, io.BytesIO(content))
                if extra_link:
                    member = tarfile.TarInfo("outside")
                    member.type = tarfile.SYMTYPE
                    member.linkname = "../../outside"
                    bundle.addfile(member)
            with self.subTest(extra_link=extra_link), self.assertRaises(ValueError):
                verify_lightweight_archive(corrupted)


@unittest.skipUnless(
    os.environ.get("MICROCLAW_BACKUP_TEST_PACKAGE"), "Requires an isolated real OpenClaw package"
)
class RealOpenClawLightweightBackupTests(unittest.TestCase):
    setUp = LightweightBackupTests.setUp

    def test_real_snapshot_and_whitelist_without_reading_user_state(self):
        package = Path(os.environ["MICROCLAW_BACKUP_TEST_PACKAGE"]).resolve()
        node = shutil.which("node")
        home = self.root / "home"
        home.mkdir()
        self.state = home / ".openclaw"
        self.state.mkdir()
        self.config = self.state / "openclaw.json"
        workspace = home / "external-workspace"
        workspace.mkdir()
        (workspace / "USER.md").write_text("essential workspace fixture")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.config.write_text(
            json.dumps(
                {
                    "gateway": {"mode": "local", "port": port},
                    "agents": {"defaults": {"workspace": str(workspace)}},
                }
            ),
            encoding="utf-8",
        )
        for relative in (
            "models/large.gguf",
            "browser/profile/cache",
            "_internal/old-installer.zip",
            "logs/runtime.log",
            "credentials/account.json",
            "agents/main/sessions/cold.zst",
            "media/attachment.png",
        ):
            filename = self.state / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_bytes(b"fixture bytes")
        environment = {
            key: value
            for key, value in os.environ.items()
            if not any(
                token in key.upper()
                for token in (
                    "OPENCLAW",
                    "MICROCLAW",
                    "TOKEN",
                    "SECRET",
                    "PASSWORD",
                    "API_KEY",
                    "NODE_OPTIONS",
                )
            )
        }
        environment.update(
            OPENCLAW_HOME=str(home),
            OPENCLAW_STATE_DIR=str(self.state),
            OPENCLAW_CONFIG_PATH=str(self.config),
            OPENCLAW_SERVICE_REPAIR_POLICY="external",
            HOME=str(home),
            USERPROFILE=str(home),
            APPDATA=str(home / "AppData/Roaming"),
            LOCALAPPDATA=str(home / "AppData/Local"),
        )
        doctor = subprocess.run(
            [node, str(package / "openclaw.mjs"), "doctor", "--fix", "--non-interactive"],
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
        self.assertEqual(doctor.returncode, 0, doctor.stderr[-2500:])
        helper = Path(__file__).resolve().parents[1] / "deployer/assets/upgrade-backup.mjs"
        command = [
            node,
            str(helper),
            "backup",
            "--package",
            str(package),
            "--output",
            str(self.plan_path),
            "--desktop",
            str(self.desktop),
        ]
        started = time.monotonic()
        outcome = subprocess.run(
            command,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
        self.assertEqual(outcome.returncode, 0, outcome.stderr[-3500:])
        plan = json.loads(self.plan_path.read_text(encoding="utf-8"))
        self.assertTrue(plan["verifiedSqlite"])
        self.assertGreaterEqual(plan["sqliteSnapshots"], 1)
        sources = {Path(entry["sourcePath"]) for entry in plan["entries"]}
        for relative in (
            "models/large.gguf",
            "browser/profile/cache",
            "_internal/old-installer.zip",
            "logs/runtime.log",
        ):
            self.assertNotIn(self.state / relative, sources)
            self.assertEqual((self.state / relative).read_bytes(), b"fixture bytes")
        self.assertIn(workspace / "USER.md", sources)
        self.assertIn(self.state / "credentials/account.json", sources)
        self.assertIn(self.state / "media/attachment.png", sources)
        self.assertIn(self.state / "agents/main/sessions/cold.zst", sources)
        create_lightweight_archive(
            self.plan_path,
            self.archive,
            state_dir=self.state,
            desktop_dir=self.desktop,
            source_version=plan["sourceVersion"],
            progress=Mock(),
        )
        self.assertEqual(verify_lightweight_archive(self.archive)["scope"], BACKUP_SCOPE)
        print(
            f"Real OpenClaw {plan['sourceVersion']} lightweight backup: {len(sources)} files, {self.archive.stat().st_size} archive bytes, {time.monotonic() - started:.2f}s (isolated fixture; excludes Doctor setup)"
        )


@unittest.skipUnless(shutil.which("node"), "Node.js is required for whitelist selection tests")
class NodeWhitelistTests(unittest.TestCase):
    def test_node_selection_and_snapshot_contracts(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [shutil.which("node"), "--test", str(root / "tests/upgrade-backup.test.mjs")],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-6000:])
