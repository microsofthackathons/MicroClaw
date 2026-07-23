import errno
import gc
import json
import multiprocessing
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
import weakref
from dataclasses import FrozenInstanceError
from pathlib import Path

import deployer.openclaw_upgrade as upgrade
from deployer.openclaw_upgrade import (
    ACTIVE_PHASES,
    OpenClawInstallation,
    OpenClawUpgradeTransaction,
    UpgradePhase,
    process_is_alive,
    process_started_at,
    prune_previous_committed_backups,
)


def _worker_installation(prefix_value: str) -> OpenClawInstallation:
    prefix = Path(prefix_value)
    package = prefix / "node_modules" / "openclaw"
    return OpenClawInstallation(
        version="2026.3.12",
        prefix=prefix,
        package_dir=package,
        entry_path=package / "openclaw.mjs",
        shim_paths=(prefix / "openclaw.cmd",),
    )


def _concurrent_create_worker(
    microclaw_value: str,
    state_value: str,
    prefix_value: str,
    barrier: object,
    release: object,
    outcomes: object,
) -> None:
    state = Path(state_value)
    upgrade._default_state_dir = lambda: state
    transaction = None
    try:
        barrier.wait(timeout=15)  # type: ignore[attr-defined]
        transaction = OpenClawUpgradeTransaction.create(
            microclaw_root=Path(microclaw_value),
            state_dir=state,
            target_version="2026.7.1-1",
            installation=_worker_installation(prefix_value),
        )
    except upgrade.UpgradeInProgressError:
        outcomes.put(("in-progress", None))  # type: ignore[attr-defined]
        return
    except Exception as error:
        outcomes.put(("error", f"{type(error).__name__}: {error}"))  # type: ignore[attr-defined]
        return

    outcomes.put(("created", transaction.manifest.transaction_id))  # type: ignore[attr-defined]
    release.wait(timeout=15)  # type: ignore[attr-defined]
    transaction.close()


def _concurrent_recovery_worker(
    microclaw_value: str,
    state_value: str,
    prefix_value: str,
    worker_id: int,
    barrier: object,
    release: object,
    outcomes: object,
) -> None:
    state = Path(state_value)
    upgrade._default_state_dir = lambda: state
    transaction = None
    try:
        barrier.wait(timeout=15)  # type: ignore[attr-defined]
        transaction = OpenClawUpgradeTransaction.load(
            Path(microclaw_value),
            trusted_prefixes=(Path(prefix_value),),
        )
        if transaction is None:
            raise RuntimeError("active transaction disappeared")
        transaction.record_validation(f"recovery-{worker_id}", True)
    except upgrade.UpgradeInProgressError:
        outcomes.put(("in-progress", None))  # type: ignore[attr-defined]
        return
    except Exception as error:
        outcomes.put(("error", f"{type(error).__name__}: {error}"))  # type: ignore[attr-defined]
        return

    outcomes.put(("recovered", worker_id))  # type: ignore[attr-defined]
    release.wait(timeout=15)  # type: ignore[attr-defined]
    transaction.close()


def _kernel_lock_owner_worker(
    lock_path_value: str,
    transaction_id: str,
    mismatched_token: str | None,
    release: object,
    outcomes: object,
) -> None:
    try:
        held = upgrade._acquire_transaction_lock(
            Path(lock_path_value),
            transaction_id,
        )
    except upgrade.UpgradeInProgressError:
        outcomes.put(("in-progress", None))  # type: ignore[attr-defined]
        return
    except Exception as error:
        outcomes.put(("error", f"{type(error).__name__}: {error}"))  # type: ignore[attr-defined]
        return

    outcomes.put(("acquired", held.owner_token))  # type: ignore[attr-defined]
    if mismatched_token is not None:
        outcomes.put(("mismatch-release", held.release(mismatched_token)))  # type: ignore[attr-defined]
    release.wait(timeout=15)  # type: ignore[attr-defined]
    if not held.released:
        held.release(held.owner_token)


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

    def test_atomic_json_fsyncs_file_before_durable_replace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            events: list[str] = []
            real_flush = upgrade._flush_and_fsync
            real_replace = upgrade._durable_replace

            def flush(file: object) -> None:
                events.append("file-fsync")
                real_flush(file)

            def replace(source: Path, destination: Path) -> None:
                events.append("durable-replace")
                real_replace(source, destination)

            with (
                unittest.mock.patch.object(upgrade, "_flush_and_fsync", side_effect=flush),
                unittest.mock.patch.object(upgrade, "_durable_replace", side_effect=replace),
            ):
                upgrade._atomic_json_write(path, {"phase": "backing-up"})

        self.assertEqual(events, ["file-fsync", "durable-replace"])

    def test_posix_durable_replace_fsyncs_parent_after_os_replace(self) -> None:
        parent = Path(tempfile.gettempdir())
        source = parent / "source.tmp"
        destination = parent / "destination.json"
        events: list[tuple[str, Path, Path | None]] = []

        with (
            unittest.mock.patch.object(upgrade, "_is_windows", return_value=False),
            unittest.mock.patch.object(
                upgrade.os,
                "replace",
                side_effect=lambda old, new: events.append(("replace", Path(old), Path(new))),
            ),
            unittest.mock.patch.object(
                upgrade,
                "_fsync_directory",
                side_effect=lambda path: events.append(("fsync", path, None)),
            ),
        ):
            upgrade._durable_replace(source, destination)

        self.assertEqual(
            events,
            [
                ("replace", source, destination),
                ("fsync", destination.parent, None),
            ],
        )

    def test_posix_durable_mkdir_fsyncs_each_new_parent_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "one" / "two"
            fsynced: list[Path] = []
            with (
                unittest.mock.patch.object(upgrade, "_is_windows", return_value=False),
                unittest.mock.patch.object(
                    upgrade,
                    "_fsync_directory",
                    side_effect=fsynced.append,
                ),
            ):
                upgrade._durable_mkdir(target)

            self.assertTrue(target.is_dir())
            self.assertEqual(fsynced, [root, root / "one"])

    def test_windows_move_file_ex_uses_write_through_and_replace_flags(self) -> None:
        kernel32 = unittest.mock.MagicMock()
        kernel32.MoveFileExW.return_value = True
        source = Path(r"C:\upgrade\source")
        destination = Path(r"C:\upgrade\destination")

        with (
            unittest.mock.patch.object(upgrade, "_is_windows", return_value=True),
            unittest.mock.patch("ctypes.WinDLL", return_value=kernel32, create=True),
        ):
            upgrade._durable_rename(source, destination)
            upgrade._durable_replace(source, destination)

        self.assertEqual(
            kernel32.MoveFileExW.call_args_list,
            [
                unittest.mock.call(str(source), str(destination), 0x8),
                unittest.mock.call(str(source), str(destination), 0x9),
            ],
        )

    def test_windows_durable_mkdir_publishes_unique_sibling_with_write_through(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "created"
            moves: list[tuple[Path, Path, bool]] = []

            def move(source: Path, destination: Path, *, replace: bool) -> None:
                moves.append((source, destination, replace))
                os.rename(source, destination)

            with (
                unittest.mock.patch.object(upgrade, "_is_windows", return_value=True),
                unittest.mock.patch.object(upgrade, "_windows_move_file", side_effect=move),
            ):
                upgrade._durable_mkdir(target)

            self.assertTrue(target.is_dir())
            self.assertEqual(len(moves), 1)
            staging, destination, replace = moves[0]
            self.assertEqual(staging.parent, root)
            self.assertRegex(staging.name, r"^\.created\.[0-9a-f]{32}\.mkdir$")
            self.assertEqual(destination, target)
            self.assertFalse(replace)

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
        self.transactions: list[OpenClawUpgradeTransaction] = []

    def tearDown(self) -> None:
        for transaction in reversed(self.transactions):
            transaction.close()
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
        transaction = OpenClawUpgradeTransaction.create(
            microclaw_root=self.microclaw,
            state_dir=self.state,
            target_version="2026.7.1-1",
            installation=installation or self._installation(),
        )
        self.transactions.append(transaction)
        return transaction

    def _load(self) -> OpenClawUpgradeTransaction | None:
        transaction = OpenClawUpgradeTransaction.load(
            self.microclaw,
            trusted_prefixes=(self.prefix,),
        )
        if transaction is not None:
            self.transactions.append(transaction)
        return transaction

    @property
    def lock_path(self) -> Path:
        return self.microclaw / "upgrade" / "openclaw-upgrade.lock"

    def _write_lock(
        self,
        *,
        owner_pid: int,
        transaction_id: str,
        owner_token: str = "stale-owner-token",
    ) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "owner_pid": owner_pid,
                    "transaction_id": transaction_id,
                    "owner_token": owner_token,
                }
            ),
            encoding="utf-8",
        )

    def _run_concurrent_workers(
        self,
        target: object,
        *,
        include_worker_id: bool = False,
    ) -> list[tuple[str, object]]:
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(2)
        release = context.Event()
        outcomes = context.Queue()
        processes = []
        for worker_id in range(2):
            arguments: tuple[object, ...] = (
                str(self.microclaw),
                str(self.state),
                str(self.prefix),
            )
            if include_worker_id:
                arguments += (worker_id,)
            arguments += (barrier, release, outcomes)
            process = context.Process(target=target, args=arguments)
            process.start()
            processes.append(process)

        try:
            results = [outcomes.get(timeout=20) for _ in processes]
        finally:
            release.set()
            for process in processes:
                process.join(timeout=20)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
            outcomes.close()
            outcomes.join_thread()

        self.assertTrue(all(process.exitcode == 0 for process in processes))
        return results

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
        lock_data = upgrade._read_lock(self.lock_path)
        self.assertIsNotNone(lock_data)

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
            set(lock_data),
            {
                "schema",
                "owner_pid",
                "transaction_id",
                "owner_token",
            },
        )
        self.assertEqual(lock_data["owner_pid"], os.getpid())  # type: ignore[index]
        self.assertEqual(
            lock_data["transaction_id"],  # type: ignore[index]
            tx.manifest.transaction_id,
        )
        self.assertRegex(lock_data["owner_token"], r"^[0-9a-f]{32}$")  # type: ignore[index]
        self.assertEqual(list(tx.manifest_path.parent.glob("*.tmp")), [])

    def test_exclusive_lock_allows_exactly_one_create_without_manifest_overwrite(self) -> None:
        outcomes = self._run_concurrent_workers(_concurrent_create_worker)

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
        self.assertEqual(
            len(list((self.microclaw / "upgrade").glob("openclaw-upgrade.json"))),
            1,
        )

    def test_existing_unlocked_stale_lock_allows_exactly_one_concurrent_owner(self) -> None:
        stale_id = "20260720T000000Z-deadbeef"
        self._write_lock(owner_pid=os.getpid(), transaction_id=stale_id)

        outcomes = self._run_concurrent_workers(_concurrent_create_worker)

        self.assertCountEqual([outcome for outcome, _ in outcomes], ["created", "in-progress"])
        created_id = next(
            transaction_id for outcome, transaction_id in outcomes if outcome == "created"
        )
        lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))
        self.assertNotEqual(lock_data["transaction_id"], stale_id)
        self.assertEqual(lock_data["transaction_id"], created_id)

    def test_active_manifest_requires_recovery_after_owner_releases_lock(self) -> None:
        tx = self._create()
        original_manifest = tx.manifest_path.read_bytes()
        tx.close()

        with self.assertRaises(upgrade.UpgradeRecoveryRequiredError):
            self._create()

        self.assertEqual(tx.manifest_path.read_bytes(), original_manifest)

    def test_active_manifest_without_lock_requires_recovery(self) -> None:
        tx = self._create()
        original_manifest = tx.manifest_path.read_bytes()
        tx.close()
        self.lock_path.unlink()

        with self.assertRaises(upgrade.UpgradeRecoveryRequiredError):
            self._create()

        self.assertEqual(tx.manifest_path.read_bytes(), original_manifest)
        self.assertTrue(self.lock_path.exists())

    def test_two_recovery_processes_cannot_both_mutate_active_manifest(self) -> None:
        tx = self._create()
        tx.backup()
        tx.close()

        outcomes = self._run_concurrent_workers(
            _concurrent_recovery_worker,
            include_worker_id=True,
        )

        self.assertCountEqual(
            [outcome for outcome, _ in outcomes],
            ["recovered", "in-progress"],
        )
        manifest = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["validation_results"]), 1)

    def test_owner_token_mismatch_cannot_release_held_kernel_lock(self) -> None:
        context = multiprocessing.get_context("spawn")

        def start_owner(
            transaction_id: str,
            mismatched_token: str | None,
        ) -> tuple[object, object, object]:
            release = context.Event()
            outcomes = context.Queue()
            process = context.Process(
                target=_kernel_lock_owner_worker,
                args=(
                    str(self.lock_path),
                    transaction_id,
                    mismatched_token,
                    release,
                    outcomes,
                ),
            )
            process.start()
            return process, release, outcomes

        first, release_first, first_outcomes = start_owner(
            "20260720T000000Z-aaaaaaaa",
            None,
        )
        first_status, first_token = first_outcomes.get(timeout=20)
        self.assertEqual(first_status, "acquired")
        release_first.set()
        first.join(timeout=20)
        self.assertEqual(first.exitcode, 0)
        first_outcomes.close()
        first_outcomes.join_thread()

        second, release_second, second_outcomes = start_owner(
            "20260720T000000Z-bbbbbbbb",
            first_token,
        )
        second_status, second_token = second_outcomes.get(timeout=20)
        mismatch_status, mismatch_result = second_outcomes.get(timeout=20)
        self.assertEqual(second_status, "acquired")
        self.assertNotEqual(second_token, first_token)
        self.assertEqual((mismatch_status, mismatch_result), ("mismatch-release", False))

        contender, release_contender, contender_outcomes = start_owner(
            "20260720T000000Z-cccccccc",
            None,
        )
        try:
            self.assertEqual(
                contender_outcomes.get(timeout=20),
                ("in-progress", None),
            )
        finally:
            release_contender.set()
            contender.join(timeout=20)
            release_second.set()
            second.join(timeout=20)
            contender_outcomes.close()
            contender_outcomes.join_thread()
            second_outcomes.close()
            second_outcomes.join_thread()

        self.assertEqual(contender.exitcode, 0)
        self.assertEqual(second.exitcode, 0)

    def test_kernel_lock_is_acquired_before_initializing_empty_lock_file(self) -> None:
        lock_path = self.microclaw / "empty-lock" / "openclaw-upgrade.lock"
        events: list[str] = []
        real_lock = upgrade._lock_file_nonblocking
        real_flush = upgrade._flush_and_fsync

        def lock(lock_file: object) -> None:
            events.append("lock")
            real_lock(lock_file)

        def flush(lock_file: object) -> None:
            events.append("flush")
            real_flush(lock_file)

        with (
            unittest.mock.patch.object(upgrade, "_lock_file_nonblocking", side_effect=lock),
            unittest.mock.patch.object(upgrade, "_flush_and_fsync", side_effect=flush),
        ):
            held = upgrade._acquire_transaction_lock(
                lock_path,
                "20260720T000000Z-aaaaaaaa",
            )

        try:
            self.assertEqual(events, ["lock", "flush"])
        finally:
            held.release(held.owner_token)

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
        tx.close()
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

    def test_backup_excludes_generated_plugin_skills_directory(self) -> None:
        plugin_skills = self.state / "plugin-skills"
        plugin_skills.mkdir()
        (plugin_skills / "generated.txt").write_text("generated", encoding="utf-8")

        tx = self._create()
        tx.backup()

        self.assertFalse((tx.backup_dir / "state" / "plugin-skills").exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction behavior")
    def test_backup_ignores_broken_plugin_skill_junction(self) -> None:
        plugin_skills = self.state / "plugin-skills"
        plugin_skills.mkdir()
        target = self.root / "browser-skill-target"
        target.mkdir()
        junction = plugin_skills / "browser-automation"
        result = subprocess.run(
            [
                os.environ.get("COMSPEC", "cmd.exe"),
                "/d",
                "/c",
                "mklink",
                "/J",
                str(junction),
                str(target),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            self.skipTest(f"could not create test junction: {result.stderr.strip()}")
        shutil.rmtree(target)

        try:
            tx = self._create()
            tx.backup()

            self.assertFalse((tx.backup_dir / "state" / "plugin-skills").exists())
        finally:
            if upgrade._is_link_or_junction(junction):
                junction.rmdir()

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
                tx.close()

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
                tx.close()

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

    def test_backup_flushes_staging_and_publishes_before_installing(self) -> None:
        tx = self._create()
        events: list[tuple[str, Path | None, str | None]] = []
        real_flush_tree = upgrade._fsync_payload_tree
        real_atomic_write = upgrade._atomic_json_write
        real_rename = upgrade._durable_rename

        def flush_tree(path: Path) -> None:
            events.append(("payload-flush", path, None))
            real_flush_tree(path)

        def write_json(path: Path, payload: dict[str, object]) -> None:
            if path.name == "backup-files.json":
                events.append(("inventory", path, None))
            if payload.get("phase") == UpgradePhase.INSTALLING.value:
                events.append(("installing", path, UpgradePhase.INSTALLING.value))
            real_atomic_write(path, payload)

        def rename(source: Path, destination: Path, *, replace: bool = False) -> None:
            if destination == tx.backup_dir:
                events.append(("publish", source, None))
            real_rename(source, destination, replace=replace)

        with (
            unittest.mock.patch.object(upgrade, "_fsync_payload_tree", side_effect=flush_tree),
            unittest.mock.patch.object(upgrade, "_atomic_json_write", side_effect=write_json),
            unittest.mock.patch.object(upgrade, "_durable_rename", side_effect=rename),
        ):
            tx.backup()

        publish_index = next(
            index for index, (event, _, _) in enumerate(events) if event == "publish"
        )
        staging = events[publish_index][1]
        self.assertIsNotNone(staging)
        self.assertEqual(staging.parent, tx.backup_dir.parent)  # type: ignore[union-attr]
        self.assertRegex(
            staging.name,  # type: ignore[union-attr]
            rf"^\.{tx.manifest.transaction_id}\.[0-9a-f]{{32}}\.staging$",
        )
        payload_indexes = [
            index for index, (event, _, _) in enumerate(events) if event == "payload-flush"
        ]
        inventory_index = next(
            index for index, (event, _, _) in enumerate(events) if event == "inventory"
        )
        installing_indexes = [
            index for index, (event, _, _) in enumerate(events) if event == "installing"
        ]
        self.assertEqual(len(payload_indexes), 3)
        self.assertLess(max(payload_indexes), inventory_index)
        self.assertLess(inventory_index, publish_index)
        self.assertTrue(all(publish_index < index for index in installing_indexes))
        self.assertFalse(staging.exists())  # type: ignore[union-attr]
        published_manifest = json.loads(
            (tx.backup_dir / "transaction.json").read_text(encoding="utf-8")
        )
        self.assertEqual(published_manifest["phase"], UpgradePhase.INSTALLING.value)

    def test_backup_publication_failure_keeps_backing_up_and_live_data_untouched(self) -> None:
        tx = self._create()
        package_before = (self.package / "old.txt").read_bytes()
        state_before = (self.state / "openclaw.json").read_bytes()
        real_rename = upgrade._durable_rename

        def fail_publication(
            source: Path,
            destination: Path,
            *,
            replace: bool = False,
        ) -> None:
            if destination == tx.backup_dir:
                raise OSError(errno.EIO, "publication failed")
            real_rename(source, destination, replace=replace)

        with (
            unittest.mock.patch.object(
                upgrade,
                "_durable_rename",
                side_effect=fail_publication,
            ),
            self.assertRaisesRegex(OSError, "publication failed"),
        ):
            tx.backup()

        persisted = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(tx.manifest.phase, UpgradePhase.BACKING_UP)
        self.assertEqual(persisted["phase"], UpgradePhase.BACKING_UP.value)
        self.assertFalse(tx.backup_dir.exists())
        self.assertEqual((self.package / "old.txt").read_bytes(), package_before)
        self.assertEqual((self.state / "openclaw.json").read_bytes(), state_before)
        staging = list(tx.backup_dir.parent.glob(f".{tx.manifest.transaction_id}.*.staging"))
        self.assertEqual(len(staging), 1)
        self.assertTrue((staging[0] / "backup-files.json").exists())
        self.assertTrue((staging[0] / "transaction.json").exists())

    def test_backup_fsyncs_all_payload_before_inventory_and_installing_phase(self) -> None:
        tx = self._create()
        events: list[tuple[str, object, str | None]] = []
        published_staging: list[Path] = []
        real_atomic_write = upgrade._atomic_json_write
        real_flush = upgrade._flush_and_fsync
        real_rename = upgrade._durable_rename

        def record_file(path: Path) -> None:
            events.append(("file-fsync", path, None))

        def record_directory(path: Path) -> None:
            if path.is_relative_to(tx.backup_root):
                events.append(("directory-fsync", path, None))

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

        def record_rename(source: Path, destination: Path, *, replace: bool = False) -> None:
            if destination == tx.backup_dir:
                published_staging.append(source)
            real_rename(source, destination, replace=replace)

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
            unittest.mock.patch.object(
                upgrade,
                "_durable_rename",
                side_effect=record_rename,
            ),
        ):
            tx.backup()

        self.assertEqual(len(published_staging), 1)
        staging = published_staging[0]
        inventory = json.loads((tx.backup_dir / "backup-files.json").read_text(encoding="utf-8"))
        fsynced_files = {
            path.relative_to(staging).as_posix()
            for event, path, _ in events
            if event == "file-fsync" and isinstance(path, Path)
        }
        self.assertEqual(fsynced_files, set(inventory))
        self.assertNotIn("transaction.json", fsynced_files)

        expected_directories = {
            path.relative_to(tx.backup_dir).as_posix()
            for root_name in ("package", "shims", "state")
            for path in [tx.backup_dir / root_name, *(tx.backup_dir / root_name).rglob("*")]
            if path.is_dir()
        }
        fsynced_directories = {
            path.relative_to(staging).as_posix()
            for event, path, _ in events
            if event == "directory-fsync"
            and isinstance(path, Path)
            and path.is_relative_to(staging)
        }
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
            and isinstance(path, Path)
            and path.is_relative_to(staging)
            and path.relative_to(staging).as_posix() in fsynced_files | expected_directories
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
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLING_BACK)
        with self.assertRaises(upgrade.UpgradeInProgressError):
            OpenClawUpgradeTransaction.load(
                self.microclaw,
                trusted_prefixes=(self.prefix,),
            )
        tx.complete_rollback()
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLED_BACK)
        self.assertTrue(self.lock_path.exists())

    def test_cross_device_rollback_ignores_generated_plugin_skills_in_quarantine(self) -> None:
        tx = self._create()
        tx.backup()
        plugin_skills = self.state / "plugin-skills"
        plugin_skills.mkdir()
        (plugin_skills / "generated.txt").write_text("generated", encoding="utf-8")
        (self.state / "openclaw.json").write_text("failed-state", encoding="utf-8")
        failed_state = tx.backup_dir / "failed" / "state"
        real_rename = upgrade._durable_rename

        def cross_device_state_move(
            source: Path,
            destination: Path,
            *,
            replace: bool = False,
        ) -> None:
            if source == self.state and destination == failed_state:
                raise OSError(errno.EXDEV, "cross-device state move")
            real_rename(source, destination, replace=replace)

        with unittest.mock.patch.object(
            upgrade,
            "_durable_rename",
            side_effect=cross_device_state_move,
        ):
            tx.rollback()

        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertFalse((failed_state / "plugin-skills").exists())

    def test_rollback_flushes_staging_before_durable_restore_and_rolled_back(self) -> None:
        tx = self._create()
        tx.backup()
        (self.package / "old.txt").write_text("new-package", encoding="utf-8")
        self.shim.write_text("@new", encoding="utf-8")
        (self.state / "openclaw.json").write_text("new-state", encoding="utf-8")
        events: list[tuple[str, Path | UpgradePhase, Path | None]] = []
        real_flush_tree = upgrade._fsync_payload_tree
        real_fsync_file = upgrade._fsync_file
        real_rename = upgrade._durable_rename
        real_replace = upgrade._durable_replace
        real_set_phase = tx.set_phase

        def flush_tree(path: Path) -> None:
            events.append(("tree-flush", path, None))
            real_flush_tree(path)

        def fsync_file(path: Path) -> None:
            if path.parent == self.shim.parent and path.name.endswith(".restore"):
                events.append(("shim-flush", path, None))
            real_fsync_file(path)

        def rename(source: Path, destination: Path, *, replace: bool = False) -> None:
            if destination in {self.package, self.state}:
                events.append(("tree-publish", source, destination))
            real_rename(source, destination, replace=replace)

        def replace(source: Path, destination: Path) -> None:
            if destination == self.shim:
                events.append(("shim-publish", source, destination))
            real_replace(source, destination)

        def set_phase(phase: UpgradePhase) -> None:
            events.append(("phase", phase, None))
            real_set_phase(phase)

        with (
            unittest.mock.patch.object(upgrade, "_fsync_payload_tree", side_effect=flush_tree),
            unittest.mock.patch.object(upgrade, "_fsync_file", side_effect=fsync_file),
            unittest.mock.patch.object(upgrade, "_durable_rename", side_effect=rename),
            unittest.mock.patch.object(upgrade, "_durable_replace", side_effect=replace),
            unittest.mock.patch.object(tx, "set_phase", side_effect=set_phase),
        ):
            tx.rollback()
            tx.complete_rollback()

        rolled_back_index = events.index(("phase", UpgradePhase.ROLLED_BACK, None))
        for live in (self.package, self.state):
            publish_index = next(
                index
                for index, event in enumerate(events)
                if event[0] == "tree-publish" and event[2] == live
            )
            staging = events[publish_index][1]
            flush_index = events.index(("tree-flush", staging, None))
            self.assertEqual(staging.parent, live.parent)  # type: ignore[union-attr]
            self.assertLess(flush_index, publish_index)
            self.assertLess(publish_index, rolled_back_index)

        shim_publish_index = next(
            index for index, event in enumerate(events) if event[0] == "shim-publish"
        )
        shim_staging = events[shim_publish_index][1]
        shim_flush_index = events.index(("shim-flush", shim_staging, None))
        self.assertLess(shim_flush_index, shim_publish_index)
        self.assertLess(shim_publish_index, rolled_back_index)

    def test_restore_flush_failure_never_writes_rolled_back_and_retains_lock(self) -> None:
        tx = self._create()
        tx.backup()
        (self.package / "old.txt").write_text("failed-package", encoding="utf-8")
        (self.state / "openclaw.json").write_text("failed-state", encoding="utf-8")

        with (
            unittest.mock.patch.object(
                upgrade,
                "_fsync_payload_tree",
                side_effect=OSError(errno.EIO, "restore flush failed"),
            ),
            self.assertRaisesRegex(OSError, "restore flush failed"),
        ):
            tx.rollback()

        self.assertEqual((self.package / "old.txt").read_text(), "failed-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), "failed-state")
        for manifest_path in (tx.manifest_path, tx.backup_dir / "transaction.json"):
            persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["phase"], UpgradePhase.ROLLBACK_FAILED.value)
            self.assertNotEqual(persisted["phase"], UpgradePhase.ROLLED_BACK.value)
        with self.assertRaises(upgrade.UpgradeInProgressError):
            OpenClawUpgradeTransaction.load(
                self.microclaw,
                trusted_prefixes=(self.prefix,),
            )

        tx.close()
        resumed = self._load()
        self.assertIsNotNone(resumed)
        self.assertEqual(resumed.manifest.phase, UpgradePhase.ROLLBACK_FAILED)  # type: ignore[union-attr]

    def test_rollback_failed_lock_survives_transaction_garbage_collection(self) -> None:
        tx = self._create()
        tx.backup()
        with (
            unittest.mock.patch.object(
                upgrade,
                "_fsync_payload_tree",
                side_effect=OSError(errno.EIO, "restore flush failed"),
            ),
            self.assertRaisesRegex(OSError, "restore flush failed"),
        ):
            tx.rollback()

        lock_data = upgrade._read_lock(self.lock_path)
        self.assertIsNotNone(lock_data)
        owner_token = lock_data["owner_token"]  # type: ignore[index]
        transaction_reference = weakref.ref(tx)
        self.transactions.remove(tx)
        del tx
        gc.collect()
        self.assertIsNone(transaction_reference())

        recovered = None
        blocked = False
        try:
            recovered = OpenClawUpgradeTransaction.load(
                self.microclaw,
                trusted_prefixes=(self.prefix,),
            )
        except upgrade.UpgradeInProgressError:
            blocked = True
        finally:
            if recovered is not None:
                recovered.close()
            retained_locks = getattr(upgrade, "_RETAINED_FAILED_LOCKS", {})
            retained = retained_locks.pop(owner_token, None)
            if retained is not None:
                retained.release(owner_token)

        self.assertTrue(blocked)

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
        tx.close()
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
        tx.close()
        outside = self.root / "attacker-controlled"
        data["prefix"] = str(outside)
        data["package_dir"] = str(outside / "node_modules" / "openclaw")
        data["shim_paths"] = [str(outside / "openclaw.cmd")]
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "trusted OpenClaw installation root"):
            self._load()

    def test_load_accepts_explicit_trusted_root(self) -> None:
        tx = self._create()
        tx.close()

        loaded = OpenClawUpgradeTransaction.load(
            self.microclaw,
            trusted_prefixes=(self.prefix,),
        )
        if loaded is not None:
            self.transactions.append(loaded)

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.manifest.transaction_id, tx.manifest.transaction_id)  # type: ignore[union-attr]

    def test_load_accepts_default_appdata_npm_root(self) -> None:
        tx = self._create()
        tx.close()

        with unittest.mock.patch.dict(os.environ, {"APPDATA": str(self.root)}):
            loaded = OpenClawUpgradeTransaction.load(self.microclaw)
        if loaded is not None:
            self.transactions.append(loaded)

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.manifest.transaction_id, tx.manifest.transaction_id)  # type: ignore[union-attr]

    def test_tampered_manifest_backup_dir_cannot_equal_backup_root(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        tx.close()
        data["backup_dir"] = str(tx.backup_root)
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_tampered_manifest_transaction_id_cannot_be_dot(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        tx.close()
        data["transaction_id"] = "."
        data["backup_dir"] = str(tx.backup_root)
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_tampered_manifest_transaction_id_must_match_backup_dir_name(self) -> None:
        tx = self._create()
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        tx.close()
        data["transaction_id"] = "20260720T043308Z-aaaaaaaa"
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError):
            self._load()

    def test_package_dir_must_match_an_openclaw_package_location(self) -> None:
        tx = self._create()
        original = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        tx.close()
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
        tx.close()
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
        tx.complete_rollback()

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
            tx.complete_rollback()

        failed = tx.backup_dir / "failed"
        self.assertEqual(tx.manifest.phase, UpgradePhase.ROLLING_BACK)
        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((failed / "package" / "old.txt").read_text(), "failed-package")
        self.assertEqual((failed / "state" / "openclaw.json").read_text(), "failed-state")

        tx.close()
        resumed = self._load()
        self.assertIsNotNone(resumed)

        resumed.rollback()  # type: ignore[union-attr]
        resumed.complete_rollback()  # type: ignore[union-attr]

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((failed / "package" / "old.txt").read_text(), "failed-package")
        self.assertEqual((failed / "state" / "openclaw.json").read_text(), "failed-state")
        self.assertEqual(resumed.manifest.phase, UpgradePhase.ROLLED_BACK)  # type: ignore[union-attr]
        self.assertTrue(self.lock_path.exists())

    def test_loaded_recovery_acquires_existing_unlocked_lock(self) -> None:
        tx = self._create()
        tx.backup()
        tx.close()

        resumed = self._load()
        resumed.rollback()  # type: ignore[union-attr]
        resumed.complete_rollback()  # type: ignore[union-attr]

        self.assertTrue(self.lock_path.exists())

    def test_successful_rollback_never_removes_mismatched_lock_identity(self) -> None:
        tx = self._create()
        tx.backup()
        other_id = "20260720T000000Z-aaaaaaaa"
        self._write_lock(owner_pid=0, transaction_id=other_id)

        tx.rollback()
        tx.complete_rollback()

        lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))
        self.assertEqual(lock_data["transaction_id"], other_id)

    def test_rollback_can_start_from_verifying(self) -> None:
        tx = self._create()
        tx.backup()
        tx.mark_verifying()
        (self.package / "old.txt").write_text("new-package", encoding="utf-8")
        (self.state / "openclaw.json").write_text("new-state", encoding="utf-8")

        tx.rollback()
        tx.complete_rollback()

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
        self.assertTrue(self.lock_path.exists())

    def test_closed_terminal_transaction_cannot_overwrite_new_active_owner(self) -> None:
        original = self._create()
        original.backup()
        original.mark_verifying()
        original.record_validation("version", True)
        original.commit()
        current = self._create()
        current_manifest = current.manifest_path.read_bytes()

        with self.assertRaisesRegex(RuntimeError, "no longer owns"):
            original.record_validation("stale-writer", True)

        self.assertEqual(current.manifest_path.read_bytes(), current_manifest)
        persisted = json.loads(current.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["transaction_id"], current.manifest.transaction_id)

    def test_process_is_alive_handles_current_and_invalid_pids(self) -> None:
        self.assertTrue(process_is_alive(os.getpid()))
        self.assertFalse(process_is_alive(0))
        self.assertFalse(process_is_alive(-1))

    def test_process_started_at_identifies_current_process(self) -> None:
        self.assertIsNotNone(process_started_at(os.getpid()))
        self.assertIsNone(process_started_at(0))
        self.assertIsNone(process_started_at(True))

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
