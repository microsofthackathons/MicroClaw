"""Durable OpenClaw upgrade backup and rollback transactions."""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any


class UpgradePhase(StrEnum):
    BACKING_UP = "backing-up"
    INSTALLING = "installing"
    VERIFYING = "verifying"
    COMMITTED = "committed"
    ROLLING_BACK = "rolling-back"
    ROLLED_BACK = "rolled-back"
    ROLLBACK_FAILED = "rollback-failed"


ACTIVE_PHASES = {
    UpgradePhase.BACKING_UP,
    UpgradePhase.INSTALLING,
    UpgradePhase.VERIFYING,
    UpgradePhase.ROLLING_BACK,
}

_TRANSACTION_ID_PATTERN = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")


@dataclass(frozen=True)
class OpenClawInstallation:
    version: str
    prefix: Path
    package_dir: Path
    entry_path: Path
    shim_paths: tuple[Path, ...]


@dataclass
class UpgradeManifest:
    schema_version: int
    transaction_id: str
    owner_pid: int
    source_version: str | None
    target_version: str
    prefix: str
    package_dir: str
    state_dir: str
    backup_dir: str
    shim_paths: list[str]
    package_existed: bool
    state_existed: bool
    phase: UpgradePhase
    created_at: str
    updated_at: str
    validation_results: dict[str, bool] = field(default_factory=dict)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _default_state_dir() -> Path:
    return Path.home() / ".openclaw"


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _require_absolute(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    return path.resolve(strict=False)


def _require_within(path: Path, root: Path, label: str) -> Path:
    resolved = _require_absolute(path, label)
    allowed = _require_absolute(root, f"{label} root")
    if resolved != allowed and not resolved.is_relative_to(allowed):
        raise ValueError(f"{label} escapes allowed root: {resolved}")
    return resolved


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


class OpenClawUpgradeTransaction:
    def __init__(self, microclaw_root: Path, manifest: UpgradeManifest):
        self.microclaw_root = microclaw_root.resolve(strict=False)
        self.manifest = manifest
        self._validate_manifest()

    @property
    def manifest_path(self) -> Path:
        return self.microclaw_root / "upgrade" / "openclaw-upgrade.json"

    @property
    def backup_root(self) -> Path:
        return self.microclaw_root / "backups" / "openclaw"

    @property
    def backup_dir(self) -> Path:
        return Path(self.manifest.backup_dir)

    @classmethod
    def create(
        cls,
        *,
        microclaw_root: Path,
        state_dir: Path,
        target_version: str,
        installation: OpenClawInstallation,
    ) -> OpenClawUpgradeTransaction:
        root = microclaw_root.resolve(strict=False)
        transaction_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        backup_dir = root / "backups" / "openclaw" / transaction_id
        timestamp = _now()
        manifest = UpgradeManifest(
            schema_version=1,
            transaction_id=transaction_id,
            owner_pid=os.getpid(),
            source_version=installation.version or None,
            target_version=target_version,
            prefix=str(installation.prefix.resolve(strict=False)),
            package_dir=str(installation.package_dir.resolve(strict=False)),
            state_dir=str(state_dir.resolve(strict=False)),
            backup_dir=str(backup_dir),
            shim_paths=[str(path.resolve(strict=False)) for path in installation.shim_paths],
            package_existed=installation.package_dir.exists(),
            state_existed=state_dir.exists(),
            phase=UpgradePhase.BACKING_UP,
            created_at=timestamp,
            updated_at=timestamp,
        )
        transaction = cls(root, manifest)
        transaction._persist()
        return transaction

    @classmethod
    def load(cls, microclaw_root: Path) -> OpenClawUpgradeTransaction | None:
        root = microclaw_root.resolve(strict=False)
        manifest_path = root / "upgrade" / "openclaw-upgrade.json"
        if not manifest_path.exists():
            return None
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("manifest root must be an object")
            data["phase"] = UpgradePhase(data["phase"])
            manifest = UpgradeManifest(**data)
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("invalid OpenClaw upgrade manifest") from error
        return cls(root, manifest)

    def _validate_manifest(self) -> None:
        if self.manifest.schema_version != 1:
            raise ValueError("unsupported OpenClaw upgrade manifest schema")
        transaction_id = self.manifest.transaction_id
        if not isinstance(transaction_id, str) or not _TRANSACTION_ID_PATTERN.fullmatch(
            transaction_id
        ):
            raise ValueError("transaction_id is not a valid generated transaction ID")

        prefix = _require_absolute(Path(self.manifest.prefix), "prefix")
        package_dir = _require_absolute(Path(self.manifest.package_dir), "package_dir")
        allowed_package_dirs = {
            (prefix / "node_modules" / "openclaw").resolve(strict=False),
            (prefix / "lib" / "node_modules" / "openclaw").resolve(strict=False),
        }
        if package_dir not in allowed_package_dirs:
            raise ValueError("package_dir is not an OpenClaw package location")

        allowed_shim_names = {"openclaw", "openclaw.cmd", "openclaw.ps1"}
        for shim in self.manifest.shim_paths:
            shim_path = Path(shim)
            resolved_shim = _require_absolute(shim_path, "shim")
            if resolved_shim.parent != prefix or shim_path.name not in allowed_shim_names:
                raise ValueError("shim is not a recognized direct child of prefix")

        state_dir = _require_absolute(Path(self.manifest.state_dir), "state_dir")
        expected_state = _default_state_dir().resolve(strict=False)
        if state_dir != expected_state:
            raise ValueError("state_dir is not the default OpenClaw state directory")

        backup_dir = _require_within(Path(self.manifest.backup_dir), self.backup_root, "backup_dir")
        backup_root = self.backup_root.resolve(strict=False)
        if backup_dir == backup_root:
            raise ValueError("backup_dir must be a strict descendant of backup root")
        expected_backup = (backup_root / transaction_id).resolve(strict=False)
        if backup_dir.name != transaction_id or backup_dir != expected_backup:
            raise ValueError("backup_dir does not match transaction_id")

    def _payload(self) -> dict[str, Any]:
        payload = asdict(self.manifest)
        payload["phase"] = self.manifest.phase.value
        return payload

    def _persist(self) -> None:
        self.manifest.updated_at = _now()
        payload = self._payload()
        _atomic_json_write(self.manifest_path, payload)
        if self.backup_dir.exists():
            _atomic_json_write(self.backup_dir / "transaction.json", payload)

    def set_phase(self, phase: UpgradePhase) -> None:
        self.manifest.phase = phase
        self._persist()

    def _ignore_state(self, directory: str, names: list[str]) -> set[str]:
        current_dir = Path(directory)
        ignored = {
            name for name in names if name.endswith(".log") and (current_dir / name).is_file()
        }
        if current_dir.resolve(strict=False) == Path(self.manifest.state_dir).resolve(strict=False):
            ignored.update(
                name
                for name in ("compile-cache", "logs")
                if name in names and (current_dir / name).is_dir()
            )
        return ignored

    def _shim_backup_path(self, shim: Path) -> Path:
        relative = shim.resolve(strict=False).relative_to(
            Path(self.manifest.prefix).resolve(strict=False)
        )
        return self.backup_dir / "shims" / relative

    def backup(self) -> None:
        self.set_phase(UpgradePhase.BACKING_UP)
        self.backup_dir.mkdir(parents=True, exist_ok=False)
        self._persist()

        package_dir = Path(self.manifest.package_dir)
        if self.manifest.package_existed and not package_dir.exists():
            raise FileNotFoundError(f"OpenClaw package disappeared before backup: {package_dir}")
        if not self.manifest.package_existed and package_dir.exists():
            raise RuntimeError(f"OpenClaw package appeared before backup: {package_dir}")
        if self.manifest.package_existed:
            shutil.copytree(package_dir, self.backup_dir / "package")

        (self.backup_dir / "shims").mkdir()
        for shim_value in self.manifest.shim_paths:
            shim = Path(shim_value)
            if shim.exists():
                destination = self._shim_backup_path(shim)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(shim, destination)

        state_dir = Path(self.manifest.state_dir)
        if self.manifest.state_existed and not state_dir.exists():
            raise FileNotFoundError(f"OpenClaw state disappeared before backup: {state_dir}")
        if not self.manifest.state_existed and state_dir.exists():
            raise RuntimeError(f"OpenClaw state appeared before backup: {state_dir}")
        if self.manifest.state_existed:
            shutil.copytree(
                state_dir,
                self.backup_dir / "state",
                ignore=self._ignore_state,
            )

        metadata_files = {
            self.backup_dir / "transaction.json",
            self.backup_dir / "backup-files.json",
        }
        inventory = {
            path.relative_to(self.backup_dir).as_posix(): path.stat().st_size
            for path in self.backup_dir.rglob("*")
            if path.is_file() and path not in metadata_files
        }
        _atomic_json_write(self.backup_dir / "backup-files.json", inventory)
        self.set_phase(UpgradePhase.INSTALLING)

    def mark_verifying(self) -> None:
        self.set_phase(UpgradePhase.VERIFYING)

    def record_validation(self, name: str, passed: bool) -> None:
        self.manifest.validation_results[name] = passed
        self._persist()

    def commit(self) -> None:
        results = self.manifest.validation_results
        if not results or not all(value is True for value in results.values()):
            raise RuntimeError("cannot commit before every validation passes")
        self.set_phase(UpgradePhase.COMMITTED)

    def _move_to_failed(self, live: Path, failed: Path) -> None:
        if not live.exists() and not live.is_symlink():
            return
        if failed.exists() or failed.is_symlink():
            _remove_path(live)
            return
        failed.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(live), str(failed))

    def _restore_package(self, failed_dir: Path) -> None:
        package_dir = Path(self.manifest.package_dir)
        self._move_to_failed(package_dir, failed_dir / "package")
        if self.manifest.package_existed:
            package_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(self.backup_dir / "package", package_dir)

    def _restore_shims(self) -> None:
        for shim_value in self.manifest.shim_paths:
            shim = Path(shim_value)
            _remove_path(shim)
            backup_shim = self._shim_backup_path(shim)
            if backup_shim.exists():
                shim.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup_shim, shim)

    def _restore_state(self, failed_dir: Path) -> None:
        state_dir = Path(self.manifest.state_dir)
        self._move_to_failed(state_dir, failed_dir / "state")
        if self.manifest.state_existed:
            state_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(self.backup_dir / "state", state_dir)

    def rollback(self) -> None:
        original_phase = self.manifest.phase
        if original_phase == UpgradePhase.BACKING_UP:
            self.set_phase(UpgradePhase.ROLLED_BACK)
            return
        if original_phase == UpgradePhase.ROLLED_BACK:
            return
        if original_phase not in {
            UpgradePhase.INSTALLING,
            UpgradePhase.VERIFYING,
            UpgradePhase.ROLLING_BACK,
            UpgradePhase.ROLLBACK_FAILED,
        }:
            raise RuntimeError(f"cannot roll back from phase {original_phase.value}")

        try:
            self.set_phase(UpgradePhase.ROLLING_BACK)
            failed_dir = self.backup_dir / "failed"
            failed_dir.mkdir(parents=True, exist_ok=True)
            self._restore_package(failed_dir)
            self._restore_shims()
            self._restore_state(failed_dir)
            self.set_phase(UpgradePhase.ROLLED_BACK)
        except Exception:
            self.set_phase(UpgradePhase.ROLLBACK_FAILED)
            raise


def process_is_alive(pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False
    return True


def prune_previous_committed_backups(backup_root: Path, keep: Path) -> None:
    if not backup_root.exists():
        return
    keep_resolved = keep.resolve(strict=False)
    try:
        keep_data = json.loads((keep / "transaction.json").read_text(encoding="utf-8"))
        keep_created_at = datetime.fromisoformat(keep_data["created_at"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return
    if keep_created_at.tzinfo is None:
        keep_created_at = keep_created_at.replace(tzinfo=UTC)
    keep_created_at = keep_created_at.astimezone(UTC)

    for candidate in backup_root.iterdir():
        if (
            not candidate.is_dir()
            or candidate.is_symlink()
            or candidate.resolve(strict=False) == keep_resolved
        ):
            continue
        manifest_path = candidate / "transaction.json"
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            phase = data.get("phase")
            created_at = datetime.fromisoformat(data["created_at"])
        except (OSError, AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        created_at = created_at.astimezone(UTC)
        if phase == UpgradePhase.COMMITTED.value and created_at < keep_created_at:
            shutil.rmtree(candidate)
