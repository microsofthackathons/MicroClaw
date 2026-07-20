import concurrent.futures
import errno
import json
import os
import shutil
import tempfile
import threading
import unittest
import unittest.mock
from dataclasses import FrozenInstanceError
from pathlib import Path

import deployer.openclaw_upgrade as upgrade
from deployer.openclaw_upgrade import (
    ACTIVE_PHASES,
    OpenClawInstallation,
    OpenClawUpgradeTransaction,
    UpgradePhase,
    process_is_alive,
    prune_previous_committed_backups,
)


class TrustedPrefixTests(unittest.TestCase):
    def test_production_prefix_function_is_available(self) -> None:
        self.assertTrue(hasattr(upgrade, "trusted_openclaw_prefixes"))

    def test_production_prefixes_come_from_independent_standard_roots(self) -> None:
        root = Path(tempfile.gettempdir()).resolve() / "trusted-prefix-test"
        environment = {
            "APPDATA": str(root / "appdata"),
            "ProgramFiles": str(root / "program-files"),
            "LOCALAPPDATA": str(root / "local-appdata"),
            "OPENCLAW_NODE_DIR": str(root / "program-files" / "nodejs"),
        }
        with (
            unittest.mock.patch.dict(os.environ, environment, clear=True),
            unittest.mock.patch.object(Path, "home", return_value=root / "home"),
        ):
            prefixes = upgrade.trusted_openclaw_prefixes()

        self.assertEqual(
            prefixes,
            (
                (root / "home" / ".openclaw-node").resolve(),
                (root / "appdata" / "npm").resolve(),
                (root / "program-files" / "nodejs").resolve(),
                (root / "local-appdata" / "Programs" / "nodejs").resolve(),
            ),
        )

    def test_relative_node_override_is_not_a_trusted_root(self) -> None:
        with (
            unittest.mock.patch.dict(
                os.environ,
                {"OPENCLAW_NODE_DIR": "relative-node"},
            ),
            unittest.mock.patch.object(Path, "home", return_value=Path(tempfile.gettempdir())),
        ):
            prefixes = upgrade.trusted_openclaw_prefixes()

        self.assertNotIn(Path("relative-node").resolve(), prefixes)


class DurabilityHelperTests(unittest.TestCase):
    def test_fsync_helpers_are_available(self) -> None:
        self.assertTrue(hasattr(upgrade, "_flush_and_fsync"))
        self.assertTrue(hasattr(upgrade, "_fsync_file"))
        self.assertTrue(hasattr(upgrade, "_fsync_directory"))

    def test_atomic_json_fsyncs_file_before_replace_then_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            events: list[str] = []
            real_flush = upgrade._flush_and_fsync
            real_replace = os.replace

            def flush(file: object) -> None:
                events.append("file-fsync")
                real_flush(file)

            def replace(source: str, destination: str) -> None:
                events.append("replace")
                real_replace(source, destination)

            with (
                unittest.mock.patch.object(upgrade, "_flush_and_fsync", side_effect=flush),
                unittest.mock.patch.object(upgrade.os, "replace", side_effect=replace),
                unittest.mock.patch.object(
                    upgrade,
                    "_fsync_directory",
                    side_effect=lambda _: events.append("directory-fsync"),
                ),
            ):
                upgrade._atomic_json_write(path, {"phase": "backing-up"})

        self.assertEqual(events, ["file-fsync", "replace", "directory-fsync"])

    def test_atomic_json_propagates_file_fsync_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            with (
                unittest.mock.patch.object(
                    upgrade,
                    "_flush_and_fsync",
                    side_effect=OSError(errno.EIO, "disk failure"),
                ),
                self.assertRaisesRegex(OSError, "disk failure"),
            ):
                upgrade._atomic_json_write(path, {"phase": "backing-up"})

            self.assertFalse(path.exists())
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_directory_fsync_tolerates_only_unsupported_errors(self) -> None:
        unsupported = OSError(errno.EINVAL, "directory fsync unsupported")
        with unittest.mock.patch.object(upgrade.os, "open", side_effect=unsupported):
            upgrade._fsync_directory(Path(tempfile.gettempdir()))

        ordinary_failure = OSError(errno.EIO, "disk failure")
        with (
            unittest.mock.patch.object(upgrade.os, "open", side_effect=ordinary_failure),
            self.assertRaisesRegex(OSError, "disk failure"),
        ):
            upgrade._fsync_directory(Path(tempfile.gettempdir()))

    def test_payload_file_fsync_uses_a_windows_compatible_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.txt"
            path.write_text("durable", encoding="utf-8")

            upgrade._fsync_file(path)


class OpenClawUpgradeTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.microclaw = self.root / ".microclaw"
        self.state = self.root / ".openclaw"
        self.prefix = self.root / "npm"
        self.package = self.prefix / "node_modules" / "openclaw"
        self.package.mkdir(parents=True)
        (self.package / "package.json").write_text('{"version":"2026.3.12"}', encoding="utf-8")
        (self.package / "old.txt").write_text("old-package", encoding="utf-8")

        self.state.mkdir()
        (self.state / "openclaw.json").write_text('{"gateway":{}}', encoding="utf-8")
        (self.state / "cache").mkdir()
        (self.state / "cache" / "durable.db").write_text("keep", encoding="utf-8")
        (self.state / "cache" / "trace.log").write_text("skip", encoding="utf-8")
        (self.state / "sandbox").mkdir()
        (self.state / "sandbox" / "policy.json").write_text("keep", encoding="utf-8")
        (self.state / "compile-cache").mkdir()
        (self.state / "compile-cache" / "bytecode").write_text("skip", encoding="utf-8")
        (self.state / "logs").mkdir()
        (self.state / "logs" / "gateway.txt").write_text("skip", encoding="utf-8")

        self.shim = self.prefix / "openclaw.cmd"
        self.shim.write_text("@old", encoding="utf-8")
        self.state_patch = unittest.mock.patch(
            "deployer.openclaw_upgrade._default_state_dir", return_value=self.state
        )
        self.state_patch.start()

    def tearDown(self) -> None:
        self.state_patch.stop()
        self.temp.cleanup()

    def _installation(self, *, shim_paths: tuple[Path, ...] | None = None) -> OpenClawInstallation:
        return OpenClawInstallation(
            version="2026.3.12",
            prefix=self.prefix,
            package_dir=self.package,
            entry_path=self.package / "openclaw.mjs",
            shim_paths=shim_paths if shim_paths is not None else (self.shim,),
        )

    def _create(
        self, *, installation: OpenClawInstallation | None = None
    ) -> OpenClawUpgradeTransaction:
        return OpenClawUpgradeTransaction.create(
            microclaw_root=self.microclaw,
            state_dir=self.state,
            target_version="2026.7.1-1",
            installation=installation or self._installation(),
        )

    def _load(self) -> OpenClawUpgradeTransaction | None:
        return OpenClawUpgradeTransaction.load(
            self.microclaw,
            trusted_prefixes=(self.prefix,),
        )

    @property
    def lock_path(self) -> Path:
        return self.microclaw / "upgrade" / "openclaw-upgrade.lock"

    def _write_lock(self, *, owner_pid: int, transaction_id: str) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "owner_pid": owner_pid,
                    "transaction_id": transaction_id,
                }
            ),
            encoding="utf-8",
        )

    def test_lock_exceptions_are_available(self) -> None:
        self.assertTrue(hasattr(upgrade, "UpgradeInProgressError"))
        self.assertTrue(hasattr(upgrade, "UpgradeRecoveryRequiredError"))

    def test_phase_values_and_active_phases_are_exact(self) -> None:
        self.assertEqual(
            {phase.value for phase in UpgradePhase},
            {
                "backing-up",
                "installing",
                "verifying",
                "committed",
                "rolling-back",
                "rolled-back",
                "rollback-failed",
            },
        )
        self.assertEqual(
            ACTIVE_PHASES,
            {
                UpgradePhase.BACKING_UP,
                UpgradePhase.INSTALLING,
                UpgradePhase.VERIFYING,
                UpgradePhase.ROLLING_BACK,
            },
        )

    def test_installation_is_immutable(self) -> None:
        installation = self._installation()
        with self.assertRaises(FrozenInstanceError):
            installation.version = "changed"  # type: ignore[misc]

    def test_create_writes_schema_v1_manifest_atomically(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))

        self.assertEqual(
            set(data),
            {
                "schema_version",
                "transaction_id",
                "owner_pid",
                "source_version",
                "target_version",
                "prefix",
                "package_dir",
                "state_dir",
                "backup_dir",
                "shim_paths",
                "package_existed",
                "state_existed",
                "phase",
                "created_at",
                "updated_at",
                "validation_results",
            },
        )
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["source_version"], "2026.3.12")
        self.assertEqual(data["target_version"], "2026.7.1-1")
        self.assertEqual(data["phase"], "backing-up")
        self.assertEqual(data["validation_results"], {})
        self.assertEqual(
            lock_data,
            {
                "schema": 1,
                "owner_pid": os.getpid(),
                "transaction_id": tx.manifest.transaction_id,
            },
        )
        self.assertEqual(list(tx.manifest_path.parent.glob("*.tmp")), [])

    def test_exclusive_lock_allows_exactly_one_create_without_manifest_overwrite(self) -> None:
        barrier = threading.Barrier(2)

        def attempt_create() -> tuple[str, str | None]:
            barrier.wait()
            try:
                transaction = self._create()
                return ("created", transaction.manifest.transaction_id)
            except upgrade.UpgradeInProgressError:
                return ("in-progress", None)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(lambda _: attempt_create(), range(2)))

        self.assertCountEqual([outcome for outcome, _ in outcomes], ["created", "in-progress"])
        created_id = next(
            transaction_id for outcome, transaction_id in outcomes if outcome == "created"
        )
        manifest = json.loads(
            (self.microclaw / "upgrade" / "openclaw-upgrade.json").read_text(encoding="utf-8")
        )
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["transaction_id"], created_id)
        self.assertEqual(lock["transaction_id"], created_id)

    def test_dead_owner_lock_without_recoverable_manifest_is_replaced_once(self) -> None:
        stale_id = "20260720T000000Z-deadbeef"
        self._write_lock(owner_pid=0, transaction_id=stale_id)

        tx = self._create()

        lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))
        self.assertNotEqual(lock_data["transaction_id"], stale_id)
        self.assertEqual(lock_data["transaction_id"], tx.manifest.transaction_id)

    def test_dead_owner_lock_with_active_manifest_requires_recovery(self) -> None:
        tx = self._create()
        original_manifest = tx.manifest_path.read_bytes()
        self._write_lock(owner_pid=0, transaction_id=tx.manifest.transaction_id)
        original_lock = self.lock_path.read_bytes()

        with self.assertRaises(upgrade.UpgradeRecoveryRequiredError):
            self._create()

        self.assertEqual(tx.manifest_path.read_bytes(), original_manifest)
        self.assertEqual(self.lock_path.read_bytes(), original_lock)

    def test_active_manifest_without_lock_requires_recovery(self) -> None:
        tx = self._create()
        original_manifest = tx.manifest_path.read_bytes()
        self.lock_path.unlink()

        with self.assertRaises(upgrade.UpgradeRecoveryRequiredError):
            self._create()

        self.assertEqual(tx.manifest_path.read_bytes(), original_manifest)
        self.assertFalse(self.lock_path.exists())

    def test_set_phase_persists_public_phase_updates(self) -> None:
        tx = self._create()
        tx.backup()

        tx.set_phase(UpgradePhase.VERIFYING)

        self.assertEqual(tx.manifest.phase, UpgradePhase.VERIFYING)
        for manifest_path in (tx.manifest_path, tx.backup_dir / "transaction.json"):
            persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["phase"], "verifying")

    def test_source_version_none_round_trips_through_manifest(self) -> None:
        installation = OpenClawInstallation(
            version="",
            prefix=self.prefix,
            package_dir=self.package,
            entry_path=self.package / "openclaw.mjs",
            shim_paths=(self.shim,),
        )

        tx = self._create(installation=installation)
        loaded = self._load()

        self.assertIsNone(tx.manifest.source_version)
        self.assertIsNotNone(loaded)
        self.assertIsNone(loaded.manifest.source_version)  # type: ignore[union-attr]

    def test_backup_preserves_durable_state_writes_inventory_then_installs(self) -> None:
        tx = self._create()
        tx.backup()

        backup_state = tx.backup_dir / "state"
        self.assertEqual((backup_state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((backup_state / "cache" / "durable.db").read_text(), "keep")
        self.assertEqual((backup_state / "sandbox" / "policy.json").read_text(), "keep")
        self.assertFalse((backup_state / "cache" / "trace.log").exists())
        self.assertFalse((backup_state / "compile-cache").exists())
        self.assertFalse((backup_state / "logs").exists())
        self.assertTrue((tx.backup_dir / "package" / "old.txt").exists())
        self.assertTrue((tx.backup_dir / "backup-files.json").exists())
        self.assertTrue((tx.backup_dir / "transaction.json").exists())
        inventory = json.loads((tx.backup_dir / "backup-files.json").read_text(encoding="utf-8"))
        self.assertIn("state/openclaw.json", inventory)
        self.assertIn("package/old.txt", inventory)
        self.assertEqual(tx.manifest.phase, UpgradePhase.INSTALLING)

    def test_backup_excludes_log_files_but_preserves_log_named_directories(self) -> None:
        audit_log = self.state / "audit.log"
        audit_log.mkdir()
        (audit_log / "events.json").write_text("keep", encoding="utf-8")
        (self.state / "gateway.log").write_text("skip", encoding="utf-8")

        tx = self._create()
        tx.backup()

        backup_state = tx.backup_dir / "state"
        self.assertEqual((backup_state / "audit.log" / "events.json").read_text(), "keep")
        self.assertFalse((backup_state / "gateway.log").exists())

    def test_backup_preserves_regular_logs_files_but_excludes_logs_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_dir = root / ".openclaw"
            state_dir.mkdir()
            (state_dir / "openclaw.json").write_text('{"gateway":{}}', encoding="utf-8")
            (state_dir / "logs").write_text("keep-file", encoding="utf-8")
            (state_dir / "compile-cache").write_text("keep-file", encoding="utf-8")

            with unittest.mock.patch(
                "deployer.openclaw_upgrade._default_state_dir", return_value=state_dir
            ):
                tx = OpenClawUpgradeTransaction.create(
                    microclaw_root=self.microclaw / "file-state",
                    state_dir=state_dir,
                    target_version="2026.7.1-1",
                    installation=self._installation(),
                )
                tx.backup()

            backup_state = tx.backup_dir / "state"
            self.assertEqual((backup_state / "logs").read_text(), "keep-file")
            self.assertEqual((backup_state / "compile-cache").read_text(), "keep-file")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_dir = root / ".openclaw"
            state_dir.mkdir()
            (state_dir / "openclaw.json").write_text('{"gateway":{}}', encoding="utf-8")
            (state_dir / "logs").mkdir()
            (state_dir / "logs" / "events.json").write_text("skip", encoding="utf-8")
            (state_dir / "compile-cache").mkdir()
            (state_dir / "compile-cache" / "bytecode").write_text("skip", encoding="utf-8")

            with unittest.mock.patch(
                "deployer.openclaw_upgrade._default_state_dir", return_value=state_dir
            ):
                tx = OpenClawUpgradeTransaction.create(
                    microclaw_root=self.microclaw / "directory-state",
                    state_dir=state_dir,
                    target_version="2026.7.1-1",
                    installation=self._installation(),
                )
                tx.backup()

            backup_state = tx.backup_dir / "state"
            self.assertFalse((backup_state / "logs").exists())
            self.assertFalse((backup_state / "compile-cache").exists())

    def test_backup_inventory_contains_only_copied_payload_files(self) -> None:
        tx = self._create()
        tx.backup()

        inventory = json.loads((tx.backup_dir / "backup-files.json").read_text(encoding="utf-8"))

        self.assertTrue(
            {
                "package/old.txt",
                "shims/openclaw.cmd",
                "state/openclaw.json",
            }.issubset(inventory)
        )
        self.assertNotIn("transaction.json", inventory)
        self.assertNotIn("backup-files.json", inventory)

    def test_backup_fsyncs_all_payload_before_inventory_and_installing_phase(self) -> None:
        tx = self._create()
        events: list[tuple[str, str, str | None]] = []
        real_atomic_write = upgrade._atomic_json_write
        real_flush = upgrade._flush_and_fsync

        def record_file(path: Path) -> None:
            events.append(("file-fsync", path.relative_to(tx.backup_dir).as_posix(), None))

        def record_directory(path: Path) -> None:
            if path.is_relative_to(tx.backup_dir):
                events.append(("directory-fsync", path.relative_to(tx.backup_dir).as_posix(), None))

        def record_json(path: Path, payload: dict[str, object]) -> None:
            events.append(
                (
                    "json-write",
                    path.name,
                    payload.get("phase") if isinstance(payload.get("phase"), str) else None,
                )
            )
            real_atomic_write(path, payload)

        def record_flush(file: object) -> None:
            events.append(("content-fsync", Path(file.name).name, None))  # type: ignore[attr-defined]
            real_flush(file)

        with (
            unittest.mock.patch.object(upgrade, "_fsync_file", side_effect=record_file),
            unittest.mock.patch.object(
                upgrade,
                "_fsync_directory",
                side_effect=record_directory,
            ),
            unittest.mock.patch.object(
                upgrade,
                "_atomic_json_write",
                side_effect=record_json,
            ),
            unittest.mock.patch.object(
                upgrade,
                "_flush_and_fsync",
                side_effect=record_flush,
            ),
        ):
            tx.backup()

        inventory = json.loads((tx.backup_dir / "backup-files.json").read_text(encoding="utf-8"))
        fsynced_files = {path for event, path, _ in events if event == "file-fsync"}
        self.assertEqual(fsynced_files, set(inventory))
        self.assertNotIn("transaction.json", fsynced_files)

        expected_directories = {
            path.relative_to(tx.backup_dir).as_posix()
            for root_name in ("package", "shims", "state")
            for path in [tx.backup_dir / root_name, *(tx.backup_dir / root_name).rglob("*")]
            if path.is_dir()
        }
        fsynced_directories = {path for event, path, _ in events if event == "directory-fsync"}
        self.assertTrue(expected_directories.issubset(fsynced_directories))

        inventory_index = events.index(("json-write", "backup-files.json", None))
        installing_index = next(
            index
            for index, event in enumerate(events)
            if event == ("json-write", "openclaw-upgrade.json", "installing")
        )
        payload_indexes = [
            index
            for index, (event, path, _) in enumerate(events)
            if event in {"file-fsync", "directory-fsync"}
            and path in fsynced_files | expected_directories
        ]
        self.assertLess(max(payload_indexes), inventory_index)
        inventory_fsync_index = next(
            index
            for index, (event, path, _) in enumerate(events)
            if event == "content-fsync" and path.startswith(".backup-files.json.")
        )
        manifest_fsync_indexes = [
            index
            for index, (event, path, _) in enumerate(events)
            if event == "content-fsync" and path.startswith(".openclaw-upgrade.json.")
        ]
        self.assertTrue(any(index < installing_index for index in manifest_fsync_indexes))
        self.assertLess(inventory_index, inventory_fsync_index)
        self.assertLess(inventory_fsync_index, installing_index)

    def test_backup_cannot_install_after_expected_package_disappears(self) -> None:
        tx = self._create()
        shutil.rmtree(self.package)

        with self.assertRaises(FileNotFoundError):
            tx.backup()

        self.assertEqual(tx.manifest.phase, UpgradePhase.BACKING_UP)
        self.assertFalse((tx.backup_dir / "backup-files.json").exists())

    def test_rollback_restores_package_shim_and_state_without_network(self) -> None:
        tx = self._create()
        tx.backup()
        (self.package / "old.txt").write_text("new-package", encoding="utf-8")
        self.shim.write_text("@new", encoding="utf-8")
        (self.state / "openclaw.json").write_text('{"migrated":true}', encoding="utf-8")

        tx.rollback()

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual(self.shim.read_text(), "@old")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLED_BACK)
        self.assertFalse(self.lock_path.exists())

    def test_rollback_removes_new_shim_without_backup(self) -> None:
        new_shim = self.prefix / "openclaw.ps1"
        tx = self._create(installation=self._installation(shim_paths=(self.shim, new_shim)))
        tx.backup()
        new_shim.write_text("new shim", encoding="utf-8")

        tx.rollback()

        self.assertFalse(new_shim.exists())
        self.assertEqual(self.shim.read_text(), "@old")

    def test_rollback_removes_package_and_state_that_did_not_exist(self) -> None:
        for path in (self.package, self.state):
            if path.is_dir():
                shutil.rmtree(path)
        installation = self._installation()
        tx = self._create(installation=installation)
        tx.backup()
        self.package.mkdir(parents=True)
        (self.package / "new.txt").write_text("new", encoding="utf-8")
        self.state.mkdir()
        (self.state / "new.json").write_text("new", encoding="utf-8")

        tx.rollback()

        self.assertFalse(self.package.exists())
        self.assertFalse(self.state.exists())
        self.assertTrue((tx.backup_dir / "failed" / "package" / "new.txt").exists())
        self.assertTrue((tx.backup_dir / "failed" / "state" / "new.json").exists())

    def test_tampered_manifest_paths_are_rejected(self) -> None:
        tx = self._create()
        original = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        tampered_values = {
            "package_dir": str(self.root / "outside-package"),
            "shim_paths": [str(self.root / "outside-shim.cmd")],
            "state_dir": str(self.root / "other-state"),
            "backup_dir": str(self.root / "outside-backup"),
        }

        for field, value in tampered_values.items():
            with self.subTest(field=field):
                data = dict(original)
                data[field] = value
                tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self._load()

    def test_tampering_prefix_package_and_shims_together_is_rejected(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        outside = self.root / "attacker-controlled"
        data["prefix"] = str(outside)
        data["package_dir"] = str(outside / "node_modules" / "openclaw")
        data["shim_paths"] = [str(outside / "openclaw.cmd")]
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "trusted OpenClaw installation root"):
            self._load()

    def test_load_accepts_explicit_trusted_root(self) -> None:
        tx = self._create()

        loaded = OpenClawUpgradeTransaction.load(
            self.microclaw,
            trusted_prefixes=(self.prefix,),
        )

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.manifest.transaction_id, tx.manifest.transaction_id)  # type: ignore[union-attr]

    def test_load_accepts_default_appdata_npm_root(self) -> None:
        tx = self._create()

        with unittest.mock.patch.dict(os.environ, {"APPDATA": str(self.root)}):
            loaded = OpenClawUpgradeTransaction.load(self.microclaw)

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.manifest.transaction_id, tx.manifest.transaction_id)  # type: ignore[union-attr]

    def test_tampered_manifest_backup_dir_cannot_equal_backup_root(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        data["backup_dir"] = str(tx.backup_root)
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_tampered_manifest_transaction_id_cannot_be_dot(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        data["transaction_id"] = "."
        data["backup_dir"] = str(tx.backup_root)
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_tampered_manifest_transaction_id_must_match_backup_dir_name(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        data["transaction_id"] = "20260720T043308Z-aaaaaaaa"
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_package_dir_must_match_an_openclaw_package_location(self) -> None:
        tx = self._create()
        original = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        invalid_packages = (
            self.prefix,
            self.prefix / "node_modules",
            self.prefix / "node_modules" / "other",
            self.prefix / "nested" / "node_modules" / "openclaw",
            self.prefix / "lib" / "node_modules",
            self.prefix / "lib" / "node_modules" / "other",
        )

        for package_dir in invalid_packages:
            with self.subTest(package_dir=package_dir):
                data = dict(original)
                data["package_dir"] = str(package_dir)
                tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self._load()

    def test_lib_node_modules_openclaw_package_location_is_allowed(self) -> None:
        installation = OpenClawInstallation(
            version="2026.3.12",
            prefix=self.prefix,
            package_dir=self.prefix / "lib" / "node_modules" / "openclaw",
            entry_path=self.prefix / "lib" / "node_modules" / "openclaw" / "openclaw.mjs",
            shim_paths=(self.shim,),
        )

        tx = self._create(installation=installation)

        self.assertEqual(Path(tx.manifest.package_dir), installation.package_dir)

    def test_shims_must_be_named_direct_children_of_prefix(self) -> None:
        tx = self._create()
        original = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        invalid_shims = (
            self.prefix,
            self.prefix / "other.cmd",
            self.prefix / "OPENCLAW.CMD",
            self.prefix / "bin" / "openclaw.cmd",
        )

        for shim in invalid_shims:
            with self.subTest(shim=shim):
                data = dict(original)
                data["shim_paths"] = [str(shim)]
                tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self._load()

    def test_interrupted_backing_up_preserves_live_and_partial_diagnostics(self) -> None:
        tx = self._create()
        tx.backup_dir.mkdir(parents=True)
        partial_state = tx.backup_dir / "state"
        partial_state.mkdir()
        (partial_state / "partial.txt").write_text("partial", encoding="utf-8")

        tx.rollback()

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertTrue((partial_state / "partial.txt").exists())
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLED_BACK)

    def test_rollback_retry_preserves_first_failed_upgrade_diagnostic(self) -> None:
        tx = self._create()
        tx.backup()
        (self.package / "old.txt").write_text("failed-package", encoding="utf-8")
        (self.state / "openclaw.json").write_text("failed-state", encoding="utf-8")
        original_set_phase = tx.set_phase

        def interrupt_before_final_phase(phase: UpgradePhase) -> None:
            if phase == UpgradePhase.ROLLED_BACK:
                raise KeyboardInterrupt("simulated process interruption")
            original_set_phase(phase)

        with (
            unittest.mock.patch.object(tx, "set_phase", side_effect=interrupt_before_final_phase),
            self.assertRaisesRegex(KeyboardInterrupt, "simulated process interruption"),
        ):
            tx.rollback()

        failed = tx.backup_dir / "failed"
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLING_BACK)
        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((failed / "package" / "old.txt").read_text(), "failed-package")
        self.assertEqual((failed / "state" / "openclaw.json").read_text(), "failed-state")

        resumed = self._load()
        self.assertIsNotNone(resumed)

        resumed.rollback()  # type: ignore[union-attr]

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((failed / "package" / "old.txt").read_text(), "failed-package")
        self.assertEqual((failed / "state" / "openclaw.json").read_text(), "failed-state")
        self.assertEqual(resumed.manifest.phase, UpgradePhase.ROLLED_BACK)  # type: ignore[union-attr]
        self.assertFalse(self.lock_path.exists())

    def test_loaded_recovery_releases_matching_dead_owner_lock(self) -> None:
        tx = self._create()
        tx.backup()
        self._write_lock(owner_pid=0, transaction_id=tx.manifest.transaction_id)

        resumed = self._load()
        resumed.rollback()  # type: ignore[union-attr]

        self.assertFalse(self.lock_path.exists())

    def test_successful_rollback_never_removes_mismatched_lock_identity(self) -> None:
        tx = self._create()
        tx.backup()
        other_id = "20260720T000000Z-aaaaaaaa"
        self._write_lock(owner_pid=0, transaction_id=other_id)

        tx.rollback()

        lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))
        self.assertEqual(lock_data["transaction_id"], other_id)

    def test_rollback_can_start_from_verifying(self) -> None:
        tx = self._create()
        tx.backup()
        tx.mark_verifying()
        (self.package / "old.txt").write_text("new-package", encoding="utf-8")
        (self.state / "openclaw.json").write_text("new-state", encoding="utf-8")

        tx.rollback()

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLED_BACK)

    def test_rollback_failure_is_persisted_and_reraised(self) -> None:
        tx = self._create()
        tx.backup()
        with (
            unittest.mock.patch(
                "deployer.openclaw_upgrade.shutil.copytree",
                side_effect=OSError("restore failed"),
            ),
            self.assertRaisesRegex(OSError, "restore failed"),
        ):
            tx.rollback()

        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLBACK_FAILED)
        persisted = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["phase"], "rollback-failed")
        self.assertTrue(self.lock_path.exists())

    def test_commit_requires_nonempty_all_true_validations(self) -> None:
        tx = self._create()
        tx.backup()
        tx.mark_verifying()
        with self.assertRaises(RuntimeError):
            tx.commit()
        tx.record_validation("version", True)
        tx.record_validation("gateway", False)
        with self.assertRaises(RuntimeError):
            tx.commit()

        tx.record_validation("gateway", True)
        tx.commit()

        self.assertEqual(tx.manifest.phase, UpgradePhase.COMMITTED)
        self.assertFalse(self.lock_path.exists())

    def test_process_is_alive_handles_current_and_invalid_pids(self) -> None:
        self.assertTrue(process_is_alive(os.getpid()))
        self.assertFalse(process_is_alive(0))
        self.assertFalse(process_is_alive(-1))

    @unittest.skipUnless(os.name == "nt", "Windows process API test")
    def test_process_is_alive_checks_windows_process_exit_code(self) -> None:
        for exit_code, expected_alive in ((259, True), (0, False)):
            with self.subTest(exit_code=exit_code):
                kernel32 = unittest.mock.MagicMock()
                kernel32.OpenProcess.return_value = 123

                def set_exit_code(_handle: int, result: object, code: int = exit_code) -> bool:
                    result._obj.value = code  # type: ignore[attr-defined]
                    return True

                kernel32.GetExitCodeProcess.side_effect = set_exit_code
                with unittest.mock.patch("ctypes.WinDLL", return_value=kernel32):
                    self.assertEqual(process_is_alive(456), expected_alive)

                kernel32.GetExitCodeProcess.assert_called_once()
                kernel32.CloseHandle.assert_called_once_with(123)


class PruneCommittedBackupsTests(unittest.TestCase):
    def test_prune_deletes_only_previous_committed_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup_root = Path(directory) / "backups"
            manifests = {
                "old-committed": ("committed", "2026-07-18T00:00:00+00:00"),
                "active": ("installing", "2026-07-18T00:00:00+00:00"),
                "rolled-back": ("rolled-back", "2026-07-18T00:00:00+00:00"),
                "rollback-failed": ("rollback-failed", "2026-07-18T00:00:00+00:00"),
                "unknown": ("future-phase", "2026-07-18T00:00:00+00:00"),
                "current": ("committed", "2026-07-19T00:00:00+00:00"),
                "newer-committed": ("committed", "2026-07-20T00:00:00+00:00"),
            }
            for name, (phase, created_at) in manifests.items():
                candidate = backup_root / name
                candidate.mkdir(parents=True)
                (candidate / "transaction.json").write_text(
                    json.dumps({"phase": phase, "created_at": created_at}),
                    encoding="utf-8",
                )
            malformed = backup_root / "malformed"
            malformed.mkdir()
            (malformed / "transaction.json").write_text("{", encoding="utf-8")
            no_manifest = backup_root / "no-manifest"
            no_manifest.mkdir()

            keep = backup_root / "current"
            prune_previous_committed_backups(backup_root, keep)

            self.assertFalse((backup_root / "old-committed").exists())
            for name in manifests.keys() - {"old-committed"}:
                self.assertTrue((backup_root / name).exists(), name)
            self.assertTrue(malformed.exists())
            self.assertTrue(no_manifest.exists())


if __name__ == "__main__":
    unittest.main()
