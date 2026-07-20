import json
import os
import shutil
import tempfile
import unittest
import unittest.mock
from dataclasses import FrozenInstanceError
from pathlib import Path

from deployer.openclaw_upgrade import (
    ACTIVE_PHASES,
    OpenClawInstallation,
    OpenClawUpgradeTransaction,
    UpgradePhase,
    process_is_alive,
    prune_previous_committed_backups,
)


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

        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["source_version"], "2026.3.12")
        self.assertEqual(data["target_version"], "2026.7.1-1")
        self.assertEqual(data["phase"], "backing-up")
        self.assertEqual(data["validation_results"], {})
        self.assertEqual(list(tx.manifest_path.parent.glob("*.tmp")), [])

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
                    OpenClawUpgradeTransaction.load(self.microclaw)

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

    def test_rollback_retries_safely_from_rolling_back(self) -> None:
        tx = self._create()
        tx.backup()
        failed = tx.backup_dir / "failed"
        failed.mkdir()
        (failed / "package").mkdir()
        (failed / "package" / "interrupted.txt").write_text("keep", encoding="utf-8")
        shutil.rmtree(self.package)
        (failed / "state").mkdir()
        (failed / "state" / "stale.txt").write_text("stale", encoding="utf-8")
        (self.state / "openclaw.json").write_text("failed-upgrade", encoding="utf-8")
        data = json.loads(tx.manifest_path.read_text(encoding="utf-8"))
        data["phase"] = UpgradePhase.ROLLING_BACK.value
        tx.manifest_path.write_text(json.dumps(data), encoding="utf-8")
        resumed = OpenClawUpgradeTransaction.load(self.microclaw)
        self.assertIsNotNone(resumed)

        resumed.rollback()  # type: ignore[union-attr]

        self.assertEqual((self.package / "old.txt").read_text(), "old-package")
        self.assertEqual((self.state / "openclaw.json").read_text(), '{"gateway":{}}')
        self.assertEqual((failed / "package" / "interrupted.txt").read_text(), "keep")
        self.assertFalse((failed / "state" / "stale.txt").exists())
        self.assertEqual((failed / "state" / "openclaw.json").read_text(), "failed-upgrade")
        self.assertEqual(resumed.manifest.phase, UpgradePhase.ROLLED_BACK)  # type: ignore[union-attr]

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

    def test_process_is_alive_handles_current_and_invalid_pids(self) -> None:
        self.assertTrue(process_is_alive(os.getpid()))
        self.assertFalse(process_is_alive(0))
        self.assertFalse(process_is_alive(-1))


class PruneCommittedBackupsTests(unittest.TestCase):
    def test_prune_deletes_only_previous_committed_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup_root = Path(directory) / "backups"
            phases = {
                "old-committed": "committed",
                "active": "installing",
                "rolled-back": "rolled-back",
                "rollback-failed": "rollback-failed",
                "unknown": "future-phase",
                "current": "committed",
            }
            for name, phase in phases.items():
                candidate = backup_root / name
                candidate.mkdir(parents=True)
                (candidate / "transaction.json").write_text(
                    json.dumps({"phase": phase}), encoding="utf-8"
                )
            malformed = backup_root / "malformed"
            malformed.mkdir()
            (malformed / "transaction.json").write_text("{", encoding="utf-8")
            no_manifest = backup_root / "no-manifest"
            no_manifest.mkdir()

            keep = backup_root / "current"
            prune_previous_committed_backups(backup_root, keep)

            self.assertFalse((backup_root / "old-committed").exists())
            for name in phases.keys() - {"old-committed"}:
                self.assertTrue((backup_root / name).exists(), name)
            self.assertTrue(malformed.exists())
            self.assertTrue(no_manifest.exists())


if __name__ == "__main__":
    unittest.main()
