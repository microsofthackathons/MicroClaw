"""SHA-256 verified state backups for Windows package-manager upgrades."""

import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from deployer.openclaw_upgrade import (
    UpgradeRecoveryRequiredError,
    _acquire_transaction_lock,
    _atomic_json_write,
    _manifest_requires_recovery,
    trusted_openclaw_prefixes,
)


def _valid_upgrade_versions(source: object, target: object) -> bool:
    if any(
        not isinstance(version, str) or re.fullmatch(r"[0-9]{4}\.[0-9]+\.[0-9]+", version) is None
        for version in (source, target)
    ):
        return False
    return tuple(map(int, source.split("."))) < tuple(map(int, target.split(".")))


@contextmanager
def package_upgrade_lock(root: Path):
    lock = _acquire_transaction_lock(root / "upgrade" / "openclaw-upgrade.lock", "npm-upgrade")
    try:
        if _manifest_requires_recovery(root / "upgrade" / "openclaw-upgrade.json"):
            raise UpgradeRecoveryRequiredError(
                "An older MicroClaw transaction needs recovery first"
            )
        yield
    finally:
        lock.release(lock.owner_token)


class PackageManagerUpgrade:
    def __init__(self, root: Path, data: dict):
        self.root = root.resolve()
        self.data = data

    @property
    def prefix(self) -> Path:
        return Path(self.data["prefix"])

    @property
    def backup_dir(self) -> Path:
        return self.root / "backups" / "openclaw-package" / self.data["id"]

    @property
    def archive(self) -> Path:
        return self.backup_dir / "state.tar.gz"

    @classmethod
    def pending(cls, root: Path) -> "PackageManagerUpgrade | None":
        path = root / "upgrade" / "openclaw-package-upgrade.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("schema") != 1:
            raise ValueError("Invalid package-manager upgrade record; keep it for recovery")
        if (
            not _valid_upgrade_versions(data.get("sourceVersion"), data.get("targetVersion"))
            or re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}", str(data.get("id"))) is None
            or data.get("phase")
            not in {
                "backing-up",
                "backed-up",
                "package-installing",
                "package-installed",
                "repairing",
                "migrating",
                "complete",
                "failed",
            }
            or not isinstance(data.get("packageReady"), bool)
            or not isinstance(data.get("prefix"), str)
        ):
            raise ValueError("Unrecognized package-manager upgrade record; keep it for recovery")
        prefix = Path(data.get("prefix", ""))
        if not prefix.is_absolute() or prefix.resolve() not in trusted_openclaw_prefixes():
            raise ValueError("Package-manager recovery prefix is not a trusted installation root")
        digest = data.get("archiveSha256")
        if digest is not None and re.fullmatch(r"[a-f0-9]{64}", str(digest)) is None:
            raise ValueError("Invalid state backup checksum in package-manager recovery record")
        upgrade = cls(root, data)
        expected = root.resolve() / "backups" / "openclaw-package" / data["id"]
        if upgrade.backup_dir.resolve() != expected or upgrade.archive.resolve().parent != expected:
            raise ValueError("State backup path was redirected; refusing package-manager recovery")
        return None if data["phase"] == "complete" else upgrade

    @classmethod
    def create(
        cls, root: Path, prefix: Path, *, source_version: str, target_version: str
    ) -> "PackageManagerUpgrade":
        if not _valid_upgrade_versions(source_version, target_version):
            raise ValueError("Package replacement requires exact versions and a newer target")
        if prefix.resolve() not in trusted_openclaw_prefixes():
            raise ValueError("Package replacement requires a trusted OpenClaw npm prefix")
        upgrade = cls(
            root,
            {
                "schema": 1,
                "id": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8],
                "sourceVersion": source_version,
                "targetVersion": target_version,
                "prefix": str(prefix.resolve()),
                "archiveSha256": None,
                "packageReady": False,
            },
        )
        upgrade.save("backing-up")
        return upgrade

    def save(self, phase: str, **changes) -> None:
        self.data.update(changes)
        self.data.update(phase=phase, updatedAt=datetime.now(UTC).isoformat())
        _atomic_json_write(self.backup_dir / "upgrade.json", self.data)
        _atomic_json_write(self.root / "upgrade" / "openclaw-package-upgrade.json", self.data)

    def archive_digest(self) -> str:
        with self.archive.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    def verify_archive(self) -> None:
        expected = self.data.get("archiveSha256")
        if not expected or self.archive_digest() != expected:
            raise ValueError(
                f"State backup verification failed; keep {self.backup_dir} for recovery"
            )
