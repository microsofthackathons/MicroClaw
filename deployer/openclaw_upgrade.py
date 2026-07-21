"""Durable OpenClaw upgrade backup and rollback transactions."""

from __future__ import annotations

import errno
import json
import os
import re
import shutil
import uuid
from collections.abc import Iterable
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
RECOVERABLE_PHASES = ACTIVE_PHASES | {UpgradePhase.ROLLBACK_FAILED}

_TRANSACTION_ID_PATTERN = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")
_LOCK_BYTE_OFFSET = 4095


class UpgradeInProgressError(RuntimeError):
    """Raised when another process owns the upgrade transaction lock."""


class UpgradeRecoveryRequiredError(RuntimeError):
    """Raised when an interrupted transaction must be recovered first."""


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


def trusted_openclaw_prefixes() -> tuple[Path, ...]:
    """Return independently configured roots where OpenClaw may be installed."""
    candidates = [Path.home() / ".openclaw-node"]
    environment_roots = (
        ("APPDATA", ("npm",)),
        ("ProgramFiles", ("nodejs",)),
        ("LOCALAPPDATA", ("Programs", "nodejs")),
    )
    for variable, suffix in environment_roots:
        value = os.environ.get(variable)
        if value:
            candidates.append(Path(value).joinpath(*suffix))

    override = os.environ.get("OPENCLAW_NODE_DIR")
    if override and Path(override).expanduser().is_absolute():
        candidates.append(Path(override).expanduser())

    return tuple(dict.fromkeys(path.resolve(strict=False) for path in candidates))


def _flush_and_fsync(file: Any) -> None:
    file.flush()
    os.fsync(file.fileno())


def _fsync_file(path: Path) -> None:
    with path.open("rb+") as file:
        os.fsync(file.fileno())


def _directory_fsync_is_unsupported(error: OSError) -> bool:
    unsupported = {errno.EINVAL}
    for name in ("ENOTSUP", "EOPNOTSUPP"):
        value = getattr(errno, name, None)
        if value is not None:
            unsupported.add(value)
    if error.errno in unsupported:
        return True
    return os.name == "nt" and (
        error.errno in {errno.EACCES, errno.EPERM}
        or getattr(error, "winerror", None) in {1, 5, 50, 87}
    )


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if _directory_fsync_is_unsupported(error):
            return
        raise
    try:
        os.fsync(descriptor)
    except OSError as error:
        if not _directory_fsync_is_unsupported(error):
            raise
    finally:
        os.close(descriptor)


def _is_windows() -> bool:
    return os.name == "nt"


def _windows_move_file(source: Path, destination: Path, *, replace: bool) -> None:
    import ctypes
    from ctypes import wintypes

    movefile_replace_existing = 0x1
    movefile_write_through = 0x8
    flags = movefile_write_through
    if replace:
        flags |= movefile_replace_existing

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.MoveFileExW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
    ]
    kernel32.MoveFileExW.restype = wintypes.BOOL
    if not kernel32.MoveFileExW(str(source), str(destination), flags):
        raise ctypes.WinError(ctypes.get_last_error())


def _durable_rename(source: Path, destination: Path, *, replace: bool = False) -> None:
    source = Path(source)
    destination = Path(destination)
    if _is_windows():
        _windows_move_file(source, destination, replace=replace)
        return

    if replace:
        os.replace(source, destination)
    else:
        os.rename(source, destination)
    _fsync_directory(destination.parent)
    if source.parent != destination.parent:
        _fsync_directory(source.parent)


def _durable_replace(source: Path, destination: Path) -> None:
    _durable_rename(source, destination, replace=True)


def _durable_mkdir(path: Path) -> None:
    path = Path(path)
    missing = []
    candidate = path
    while not candidate.exists():
        missing.append(candidate)
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent

    if candidate.exists() and not candidate.is_dir():
        raise FileExistsError(f"directory path is occupied by a non-directory: {candidate}")

    for directory in reversed(missing):
        if _is_windows():
            staging = directory.with_name(f".{directory.name}.{uuid.uuid4().hex}.mkdir")
            staging.mkdir()
            try:
                _durable_rename(staging, directory)
            except FileExistsError:
                staging.rmdir()
                if not directory.is_dir():
                    raise
            continue

        try:
            directory.mkdir()
        except FileExistsError:
            if not directory.is_dir():
                raise
        else:
            _fsync_directory(directory.parent)


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    _durable_mkdir(path.parent)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as file:
            file.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
            _flush_and_fsync(file)
        _durable_replace(temporary, path)
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


def _durable_remove(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    tombstone = path.with_name(f".{path.name}.{uuid.uuid4().hex}.remove")
    _durable_rename(path, tombstone)
    _remove_path(tombstone)
    _fsync_directory(path.parent)


def _fsync_payload_tree(root: Path) -> None:
    if not root.exists():
        return
    directories = [root]
    for path in root.rglob("*"):
        if path.is_file():
            _fsync_file(path)
        elif path.is_dir():
            directories.append(path)
    for directory in sorted(directories, key=lambda path: len(path.parts), reverse=True):
        _fsync_directory(directory)


def _manifest_requires_recovery(manifest_path: Path) -> bool:
    if not manifest_path.exists():
        return False
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        phase = UpgradePhase(payload["phase"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
        return True
    return phase in RECOVERABLE_PHASES


def _read_lock(lock_path: Path) -> dict[str, Any] | None:
    try:
        with lock_path.open("rb", buffering=0) as lock_file:
            encoded = lock_file.read(1024)
        payload = json.loads(encoded.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != 1
        or not isinstance(payload.get("owner_pid"), int)
        or not isinstance(payload.get("transaction_id"), str)
        or not isinstance(payload.get("owner_token"), str)
    ):
        return None
    return payload


def _lock_file_nonblocking(lock_file: Any) -> None:
    lock_file.seek(_LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        try:
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            contention_errors = {errno.EACCES, errno.EAGAIN}
            deadlock = getattr(errno, "EDEADLK", None)
            if deadlock is not None:
                contention_errors.add(deadlock)
            if error.errno in contention_errors:
                raise UpgradeInProgressError("an OpenClaw upgrade is already in progress") from None
            raise
        return

    import fcntl

    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise UpgradeInProgressError("an OpenClaw upgrade is already in progress") from None


def _unlock_file(lock_file: Any) -> None:
    lock_file.seek(_LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@dataclass
class _UpgradeFileLock:
    path: Path
    file: Any
    owner_token: str
    transaction_id: str
    released: bool = False

    def _write_payload(self) -> None:
        payload = {
            "schema": 1,
            "owner_pid": os.getpid(),
            "transaction_id": self.transaction_id,
            "owner_token": self.owner_token,
        }
        encoded = (json.dumps(payload, sort_keys=True) + "\n").encode()
        if len(encoded) > _LOCK_BYTE_OFFSET:
            raise ValueError("OpenClaw upgrade lock payload is too large")
        self.file.seek(0)
        self.file.write(encoded)
        self.file.write(b" " * (_LOCK_BYTE_OFFSET + 1 - len(encoded)))
        self.file.truncate()
        _flush_and_fsync(self.file)

    def update_transaction_id(self, transaction_id: str) -> None:
        self.transaction_id = transaction_id
        self._write_payload()

    def release(self, owner_token: str) -> bool:
        if self.released or owner_token != self.owner_token:
            return False
        try:
            _unlock_file(self.file)
        finally:
            self.file.close()
            self.released = True
        return True


def _acquire_transaction_lock(
    lock_path: Path,
    transaction_id: str,
) -> _UpgradeFileLock:
    _durable_mkdir(lock_path.parent)
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    lock_file = os.fdopen(descriptor, "r+b", buffering=0)
    try:
        _lock_file_nonblocking(lock_file)
    except BaseException:
        lock_file.close()
        raise

    held_lock = _UpgradeFileLock(
        path=lock_path,
        file=lock_file,
        owner_token=uuid.uuid4().hex,
        transaction_id=transaction_id,
    )
    try:
        held_lock._write_payload()
    except BaseException:
        held_lock.release(held_lock.owner_token)
        raise
    return held_lock


_RETAINED_FAILED_LOCKS: dict[str, _UpgradeFileLock] = {}


class OpenClawUpgradeTransaction:
    def __init__(
        self,
        microclaw_root: Path,
        manifest: UpgradeManifest,
        *,
        trusted_prefixes: Iterable[Path] | None = None,
        held_lock: _UpgradeFileLock | None = None,
    ):
        self.microclaw_root = microclaw_root.resolve(strict=False)
        self.manifest = manifest
        self._held_lock = held_lock
        roots = trusted_openclaw_prefixes() if trusted_prefixes is None else trusted_prefixes
        self._trusted_prefixes = {_require_absolute(Path(path), "trusted prefix") for path in roots}
        self._validate_manifest()

    @property
    def manifest_path(self) -> Path:
        return self.microclaw_root / "upgrade" / "openclaw-upgrade.json"

    @property
    def lock_path(self) -> Path:
        return self.microclaw_root / "upgrade" / "openclaw-upgrade.lock"

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
        manifest_path = root / "upgrade" / "openclaw-upgrade.json"
        lock_path = root / "upgrade" / "openclaw-upgrade.lock"
        held_lock = _acquire_transaction_lock(lock_path, transaction_id)
        if _manifest_requires_recovery(manifest_path):
            held_lock.release(held_lock.owner_token)
            raise UpgradeRecoveryRequiredError("an interrupted OpenClaw upgrade must be recovered")
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
        try:
            transaction = cls(
                root,
                manifest,
                trusted_prefixes=(installation.prefix,),
                held_lock=held_lock,
            )
            transaction._persist()
            return transaction
        except BaseException:
            held_lock.release(held_lock.owner_token)
            raise

    @classmethod
    def _read_manifest(cls, manifest_path: Path) -> UpgradeManifest:
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("manifest root must be an object")
            data["phase"] = UpgradePhase(data["phase"])
            manifest = UpgradeManifest(**data)
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("invalid OpenClaw upgrade manifest") from error
        return manifest

    @classmethod
    def load(
        cls,
        microclaw_root: Path,
        trusted_prefixes: Iterable[Path] | None = None,
    ) -> OpenClawUpgradeTransaction | None:
        root = microclaw_root.resolve(strict=False)
        manifest_path = root / "upgrade" / "openclaw-upgrade.json"
        if not manifest_path.exists():
            return None

        manifest = cls._read_manifest(manifest_path)
        if manifest.phase not in RECOVERABLE_PHASES:
            return cls(root, manifest, trusted_prefixes=trusted_prefixes)

        held_lock = _acquire_transaction_lock(
            root / "upgrade" / "openclaw-upgrade.lock",
            manifest.transaction_id,
        )
        try:
            if not manifest_path.exists():
                held_lock.release(held_lock.owner_token)
                return None
            manifest = cls._read_manifest(manifest_path)
            if manifest.phase not in RECOVERABLE_PHASES:
                held_lock.release(held_lock.owner_token)
                return cls(root, manifest, trusted_prefixes=trusted_prefixes)
            if held_lock.transaction_id != manifest.transaction_id:
                held_lock.update_transaction_id(manifest.transaction_id)
            return cls(
                root,
                manifest,
                trusted_prefixes=trusted_prefixes,
                held_lock=held_lock,
            )
        except BaseException:
            held_lock.release(held_lock.owner_token)
            raise

    def close(self) -> bool:
        if self._held_lock is None:
            return False
        held_lock = self._held_lock
        if not held_lock.release(held_lock.owner_token):
            return False
        if _RETAINED_FAILED_LOCKS.get(held_lock.owner_token) is held_lock:
            del _RETAINED_FAILED_LOCKS[held_lock.owner_token]
        self._held_lock = None
        return True

    def _validate_manifest(self) -> None:
        if self.manifest.schema_version != 1:
            raise ValueError("unsupported OpenClaw upgrade manifest schema")
        transaction_id = self.manifest.transaction_id
        if not isinstance(transaction_id, str) or not _TRANSACTION_ID_PATTERN.fullmatch(
            transaction_id
        ):
            raise ValueError("transaction_id is not a valid generated transaction ID")

        prefix = _require_absolute(Path(self.manifest.prefix), "prefix")
        if prefix not in self._trusted_prefixes:
            raise ValueError(f"prefix is not a trusted OpenClaw installation root: {prefix}")
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

    def _require_held_lock(self) -> None:
        held_lock = self._held_lock
        if (
            held_lock is None
            or held_lock.released
            or held_lock.transaction_id != self.manifest.transaction_id
        ):
            raise RuntimeError("upgrade transaction no longer owns the transaction lock")

    def _persist(self) -> None:
        self._require_held_lock()
        self.manifest.updated_at = _now()
        payload = self._payload()
        if self.backup_dir.exists():
            _atomic_json_write(self.backup_dir / "transaction.json", payload)
        _atomic_json_write(self.manifest_path, payload)

    def set_phase(self, phase: UpgradePhase) -> None:
        self._require_held_lock()
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

    def _shim_backup_path(self, shim: Path, backup_dir: Path | None = None) -> Path:
        relative = shim.resolve(strict=False).relative_to(
            Path(self.manifest.prefix).resolve(strict=False)
        )
        return (self.backup_dir if backup_dir is None else backup_dir) / "shims" / relative

    def backup(self) -> None:
        self.set_phase(UpgradePhase.BACKING_UP)
        package_dir = Path(self.manifest.package_dir)
        if self.manifest.package_existed and not package_dir.exists():
            raise FileNotFoundError(f"OpenClaw package disappeared before backup: {package_dir}")
        if not self.manifest.package_existed and package_dir.exists():
            raise RuntimeError(f"OpenClaw package appeared before backup: {package_dir}")

        state_dir = Path(self.manifest.state_dir)
        if self.manifest.state_existed and not state_dir.exists():
            raise FileNotFoundError(f"OpenClaw state disappeared before backup: {state_dir}")
        if not self.manifest.state_existed and state_dir.exists():
            raise RuntimeError(f"OpenClaw state appeared before backup: {state_dir}")

        _durable_mkdir(self.backup_root)
        staging = self.backup_dir.with_name(
            f".{self.manifest.transaction_id}.{uuid.uuid4().hex}.staging"
        )
        _durable_mkdir(staging)
        if self.manifest.package_existed:
            shutil.copytree(package_dir, staging / "package")

        _durable_mkdir(staging / "shims")
        for shim_value in self.manifest.shim_paths:
            shim = Path(shim_value)
            if shim.exists():
                destination = self._shim_backup_path(shim, staging)
                _durable_mkdir(destination.parent)
                shutil.copy2(shim, destination)

        if self.manifest.state_existed:
            shutil.copytree(
                state_dir,
                staging / "state",
                ignore=self._ignore_state,
            )

        for payload_root in (
            staging / "package",
            staging / "shims",
            staging / "state",
        ):
            _fsync_payload_tree(payload_root)

        metadata_files = {
            staging / "transaction.json",
            staging / "backup-files.json",
        }
        inventory = {
            path.relative_to(staging).as_posix(): path.stat().st_size
            for path in staging.rglob("*")
            if path.is_file() and path not in metadata_files
        }
        _atomic_json_write(staging / "backup-files.json", inventory)
        _atomic_json_write(staging / "transaction.json", self._payload())
        _fsync_directory(staging)
        _durable_rename(staging, self.backup_dir)
        self.set_phase(UpgradePhase.INSTALLING)

    def mark_verifying(self) -> None:
        self.set_phase(UpgradePhase.VERIFYING)

    def record_validation(self, name: str, passed: bool) -> None:
        self._require_held_lock()
        self.manifest.validation_results[name] = passed
        self._persist()

    def commit(self) -> None:
        results = self.manifest.validation_results
        if not results or not all(value is True for value in results.values()):
            raise RuntimeError("cannot commit before every validation passes")
        self.set_phase(UpgradePhase.COMMITTED)
        self.close()

    def _move_to_failed(self, live: Path, failed: Path) -> None:
        if not live.exists() and not live.is_symlink():
            return
        if failed.exists() or failed.is_symlink():
            _durable_remove(live)
            return
        _durable_mkdir(failed.parent)
        try:
            _durable_rename(live, failed)
        except OSError as error:
            if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
                raise
            staging = failed.with_name(f".{failed.name}.{uuid.uuid4().hex}.quarantine")
            if live.is_dir() and not live.is_symlink():
                shutil.copytree(live, staging)
                _fsync_payload_tree(staging)
            else:
                shutil.copy2(live, staging)
                _fsync_file(staging)
            _durable_rename(staging, failed)
            _durable_remove(live)

    def _restore_tree(self, backup: Path, live: Path, failed: Path, existed: bool) -> None:
        staging = None
        if existed:
            _durable_mkdir(live.parent)
            staging = live.with_name(f".{live.name}.{uuid.uuid4().hex}.restore")
            shutil.copytree(backup, staging)
            _fsync_payload_tree(staging)
        self._move_to_failed(live, failed)
        if staging is not None:
            _durable_rename(staging, live)

    def _restore_package(self, failed_dir: Path) -> None:
        package_dir = Path(self.manifest.package_dir)
        self._restore_tree(
            self.backup_dir / "package",
            package_dir,
            failed_dir / "package",
            self.manifest.package_existed,
        )

    def _restore_shims(self) -> None:
        for shim_value in self.manifest.shim_paths:
            shim = Path(shim_value)
            backup_shim = self._shim_backup_path(shim)
            if backup_shim.exists():
                _durable_mkdir(shim.parent)
                staging = shim.with_name(f".{shim.name}.{uuid.uuid4().hex}.restore")
                try:
                    shutil.copy2(backup_shim, staging)
                    _fsync_file(staging)
                    _durable_replace(staging, shim)
                finally:
                    staging.unlink(missing_ok=True)
            else:
                _durable_remove(shim)

    def _restore_state(self, failed_dir: Path) -> None:
        state_dir = Path(self.manifest.state_dir)
        self._restore_tree(
            self.backup_dir / "state",
            state_dir,
            failed_dir / "state",
            self.manifest.state_existed,
        )

    def rollback(self) -> None:
        original_phase = self.manifest.phase
        if original_phase == UpgradePhase.BACKING_UP:
            self.set_phase(UpgradePhase.ROLLED_BACK)
            self.close()
            return
        if original_phase == UpgradePhase.ROLLED_BACK:
            self.close()
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
            _durable_mkdir(failed_dir)
            self._restore_package(failed_dir)
            self._restore_shims()
            self._restore_state(failed_dir)
            self.set_phase(UpgradePhase.ROLLED_BACK)
            self.close()
        except Exception as error:
            try:
                self.set_phase(UpgradePhase.ROLLBACK_FAILED)
            except Exception as persist_error:
                error.add_note(f"also failed to persist rollback-failed: {persist_error}")
            held_lock = self._held_lock
            if held_lock is not None and not held_lock.released:
                _RETAINED_FAILED_LOCKS[held_lock.owner_token] = held_lock
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
