import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

from deployer.bundled_upgrade import BundledUpgrade
from deployer.lightweight_backup import BACKUP_SCOPE, create_lightweight_archive
from deployer.openclaw_upgrade import UpgradeInProgressError, _durable_replace


class BundledUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.desktop = self.root / "desktop"
        self.user_data = self.root / "user-data"
        self.runtime = self.user_data / "runtime" / "openclaw"
        self.state = self.root / "state"
        self.state.mkdir()
        self.config = self.state / "openclaw.json"
        self.config.write_text('{"old":true}', encoding="utf-8")
        self.write(self.desktop / "resources" / "openclaw.asar", "old-archive")
        self.write(self.runtime / "node_modules" / "openclaw" / "openclaw.mjs", "old-runtime")
        self.transactions = []
        self.addCleanup(lambda: [tx.close() for tx in self.transactions])

    @staticmethod
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        return path

    def transaction(self):
        tx = BundledUpgrade.create(
            self.desktop, self.runtime, self.state, self.user_data, "2026.10.5", "2026.10.10"
        )
        self.transactions.append(tx)
        return tx

    def snapshot(self, tx, extra=None):
        plan = tx.backup_dir / "plan.json"
        entries = [
            {"sourcePath": str(self.config), "stagedPath": str(self.config), "kind": "config"}
        ]
        entries.extend(extra or [])
        payload = {
            "scope": BACKUP_SCOPE,
            "verifiedSqlite": True,
            "sourceVersion": "2026.10.5",
            "stateDir": str(self.state),
            "desktopDir": str(self.user_data),
            "workspaceDirs": [],
            "directories": [],
            "protectedRoots": [str(self.config), str(self.state / "state")],
            "entries": entries,
        }
        plan.write_text(json.dumps(payload), encoding="utf-8")
        create_lightweight_archive(
            plan,
            tx.archive,
            state_dir=self.state,
            desktop_dir=self.user_data,
            source_version="2026.10.5",
            progress=Mock(),
        )
        tx.save("backed-up", archiveSha256=tx.archive_digest())
        tx.ready()

    def test_existing_state_cannot_be_replaced_without_verified_backup(self):
        tx = self.transaction()
        with self.assertRaisesRegex(ValueError, "verified recovery snapshot"):
            tx.ready()
        with self.assertRaisesRegex(RuntimeError, "verified recovery point"):
            tx.replace("desktop", "resources", self.root / "new")
        self.assertEqual((self.desktop / "resources/openclaw.asar").read_text(), "old-archive")

    def test_failed_upgrade_restores_matching_desktop_runtime_and_configuration(self):
        tx = self.transaction()
        self.snapshot(tx)
        tx.touch_data()
        new_resources = self.root / "new-resources"
        self.write(new_resources / "openclaw.asar", "new-archive")
        tx.replace("desktop", "resources", new_resources)
        tx.track_runtime()
        self.runtime.replace(self.runtime.with_name("openclaw.previous"))
        self.write(self.runtime / "node_modules/openclaw/openclaw.mjs", "new-runtime")
        self.config.write_text('{"migrated":true}', encoding="utf-8")
        tx.rollback()
        self.assertEqual(self.config.read_text(), '{"old":true}')
        self.assertEqual((self.desktop / "resources/openclaw.asar").read_text(), "old-archive")
        self.assertEqual(
            (self.runtime / "node_modules/openclaw/openclaw.mjs").read_text(), "old-runtime"
        )
        self.assertEqual(tx.data["phase"], "rolled-back")
        self.assertFalse((self.desktop / "upgrade/.bundled-upgrade-active").exists())
        self.assertTrue(list((tx.backup_dir / "failed-state").iterdir()))

    def test_sqlite_restore_removes_new_database_and_stale_wal(self):
        tx = self.transaction()
        database = self.state / "state/openclaw.sqlite"
        database.parent.mkdir()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("CREATE TABLE fixture(value TEXT)")
            connection.execute("INSERT INTO fixture VALUES ('old')")
        snapshot = tx.backup_dir / "snapshot.sqlite"
        with (
            closing(sqlite3.connect(database)) as source,
            closing(sqlite3.connect(snapshot)) as destination,
        ):
            source.backup(destination)
        self.snapshot(
            tx,
            [
                {
                    "sourcePath": str(database),
                    "stagedPath": str(snapshot),
                    "kind": "verified-sqlite-or-audit",
                }
            ],
        )
        tx.touch_data()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("UPDATE fixture SET value='new'")
        self.write(Path(str(database) + "-wal"), "stale-wal")
        extra = self.write(database.parent / "new-incompatible.sqlite", "new")
        tx.rollback()
        self.assertFalse(extra.exists())
        self.assertFalse(Path(str(database) + "-wal").exists())
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM fixture").fetchall(), [("old",)])

    def test_interrupted_publication_recovers_after_reloading_the_journal(self):
        tx = self.transaction()
        self.snapshot(tx)
        new = self.root / "new-resources"
        self.write(new / "openclaw.asar", "new-archive")
        replace = _durable_replace

        def fail_publish(source, destination):
            if Path(source) == new:
                raise OSError("publication interrupted")
            return replace(source, destination)

        with (
            patch("deployer.bundled_upgrade._durable_replace", side_effect=fail_publish),
            self.assertRaises(OSError),
        ):
            tx.replace("desktop", "resources", new)
        self.assertFalse((self.desktop / "resources").exists())
        tx.close()
        recovered = BundledUpgrade.load(self.desktop, self.runtime, self.state, self.user_data)
        self.transactions.append(recovered)
        recovered.rollback()
        self.assertEqual((self.desktop / "resources/openclaw.asar").read_text(), "old-archive")

    def test_commit_requires_validation_and_then_retires_old_program_files_only(self):
        tx = self.transaction()
        self.snapshot(tx)
        self.write(self.root / "payload/openclaw.asar", "new-archive")
        tx.replace("desktop", "resources", self.root / "payload")
        with self.assertRaisesRegex(RuntimeError, "unvalidated"):
            tx.commit()
        tx.save("validating", validated=True)
        tx.commit()
        self.assertEqual(tx.data["phase"], "committed")
        self.assertFalse((tx.backup_dir / "desktop/resources").exists())
        self.assertTrue(tx.archive.is_file())
        self.assertEqual((self.desktop / "resources/openclaw.asar").read_text(), "new-archive")

    def test_cache_hit_runtime_is_preserved_by_rollback(self):
        tx = self.transaction()
        self.snapshot(tx)
        tx.track_runtime()
        tx.rollback()
        self.assertEqual(
            (self.runtime / "node_modules/openclaw/openclaw.mjs").read_text(), "old-runtime"
        )

    def test_corrupted_snapshot_never_replaces_live_state_or_restores_old_code(self):
        tx = self.transaction()
        self.snapshot(tx)
        tx.touch_data()
        tx.track_runtime()
        self.runtime.replace(self.runtime.with_name("openclaw.previous"))
        self.write(self.runtime / "node_modules/openclaw/openclaw.mjs", "new-runtime")
        tx.archive.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            tx.rollback()
        self.assertEqual(
            (self.runtime / "node_modules/openclaw/openclaw.mjs").read_text(), "new-runtime"
        )
        self.assertTrue(self.runtime.with_name("openclaw.previous").exists())
        self.assertNotIn(tx.data["phase"], {"committed", "rolled-back"})

    def test_downgrade_and_second_installer_are_refused(self):
        with self.assertRaisesRegex(ValueError, "downgrade"):
            BundledUpgrade.create(
                self.desktop, self.runtime, self.state, self.user_data, "2026.10.10", "2026.10.5"
            )
        self.transaction()
        with self.assertRaises(UpgradeInProgressError):
            self.transaction()

    def test_traversal_and_reserved_payload_destinations_are_refused(self):
        tx = self.transaction()
        self.snapshot(tx)
        for name in ("../state", "backups", "upgrade", "install-state", ".", "C:\\outside"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                tx.replace("desktop", name, None)

    def test_plugin_peer_switch_and_rollback_preserve_the_external_runtime(self):
        tx = self.transaction()
        self.snapshot(tx)
        plugin = self.state / "extensions/llama-cpp"
        plugin.mkdir(parents=True)
        external = self.root / "external-runtime"
        self.write(external / "keep.txt", "external")
        peer = plugin / "node_modules/openclaw"
        peer.mkdir(parents=True)
        self.write(peer / "old-peer.txt", "old")
        tx.bind_plugin_peer("llama-cpp")
        self.assertEqual(peer.resolve(), (self.runtime / "node_modules/openclaw").resolve())
        tx.rollback()
        self.assertEqual((peer / "old-peer.txt").read_text(), "old")
        self.assertEqual((external / "keep.txt").read_text(), "external")

    def test_uninstaller_is_restored_if_a_later_step_fails(self):
        tx = self.transaction()
        self.snapshot(tx)
        self.write(self.state / "_internal/python.dll", "old-runtime")
        self.write(self.state / "MicroClawInstaller.exe", "old-uninstaller")
        tx.replace("uninstaller", "_internal", None)
        tx.replace("uninstaller", "MicroClawInstaller.exe", None)
        self.write(self.state / "_internal/python.dll", "new-runtime")
        self.write(self.state / "MicroClawInstaller.exe", "new-uninstaller")
        tx.rollback()
        self.assertEqual((self.state / "_internal/python.dll").read_text(), "old-runtime")
        self.assertEqual((self.state / "MicroClawInstaller.exe").read_text(), "old-uninstaller")


if __name__ == "__main__":
    unittest.main()
