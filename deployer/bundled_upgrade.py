"""Durable, offline replacement of the desktop and its bundled OpenClaw runtime.

Program trees are renamed, not copied into data archives. The state archive is a
verified whitelist snapshot. Pending journals block desktop startup until the
installer either commits or completes an offline rollback.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import tarfile
import uuid
from datetime import UTC, datetime
from pathlib import Path

from deployer.lightweight_backup import verify_lightweight_archive
from deployer.openclaw_upgrade import (
    _acquire_transaction_lock,
    _atomic_json_write,
    _durable_replace,
    _fsync_file,
    _manifest_requires_recovery,
)

TERMINAL_PHASES = {"committed", "rolled-back"}
PHASES = TERMINAL_PHASES | {
    "backing-up",
    "backed-up",
    "installing",
    "validating",
    "rolling-back",
    "failed",
}
RESERVED_DESKTOP_NAMES = {"backups", "upgrade", "install-state"}


def plain_path(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    if path.resolve(strict=False) != absolute:
        raise ValueError(f"Upgrade path is redirected: {path}")
    current = absolute
    while current != current.parent:
        if current.is_symlink() or current.is_junction():
            raise ValueError(f"Upgrade path is linked: {current}")
        current = current.parent
    return absolute


def remove_owned_path(path: Path) -> None:
    """Never traverse a redirected transaction path."""
    plain_path(path)
    if path.is_dir():
        # Windows shutil.rmtree unlinks directory junctions without following them.
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def unlink_owned_leaf(path: Path) -> None:
    plain_path(path.parent)
    if path.is_junction():
        path.rmdir()
    elif path.is_symlink():
        path.unlink()
    else:
        remove_owned_path(path)


class BundledUpgrade:
    def __init__(self, desktop: Path, runtime: Path, state: Path, user_data: Path, data: dict):
        self.desktop = plain_path(desktop)
        self.runtime = plain_path(runtime)
        self.state = plain_path(state)
        self.user_data = plain_path(user_data)
        self.data = data
        self.lock = None
        self.validate()

    @property
    def journal(self):
        return self.desktop / "upgrade" / "bundled-upgrade.json"

    @property
    def backup_dir(self):
        return self.desktop / "backups" / "bundled" / self.data["id"]

    @property
    def archive(self):
        return self.backup_dir / "state.tar.gz"

    @property
    def prefix(self):
        # Shared snapshot runner only uses this as a working directory.
        return self.desktop

    def validate(self):
        data = self.data
        if (
            data.get("schema") != 1
            or re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}", str(data.get("id"))) is None
            or data.get("phase") not in PHASES
            or not isinstance(data.get("operations"), list)
            or not isinstance(data.get("stateExisted"), bool)
            or not isinstance(data.get("dataTouched"), bool)
        ):
            raise ValueError("Invalid bundled upgrade journal; preserve it for recovery")
        for field in ("sourceVersion", "targetVersion"):
            value = data.get(field)
            if value is not None and re.fullmatch(r"\d{4}\.\d+\.\d+", str(value)) is None:
                raise ValueError("Invalid bundled upgrade version")
        if not data.get("targetVersion"):
            raise ValueError("Missing bundled upgrade target")
        for key, path in (
            ("desktop", self.desktop),
            ("runtime", self.runtime),
            ("state", self.state),
            ("userData", self.user_data),
        ):
            if data.get(key) != str(path):
                raise ValueError(f"Unexpected bundled upgrade {key}")
        digest = data.get("archiveSha256")
        if digest is not None and re.fullmatch(r"[a-f0-9]{64}", str(digest)) is None:
            raise ValueError("Invalid bundled state backup digest")
        for operation in data["operations"]:
            self.operation_paths(operation)
        plain_path(self.backup_dir)

    def operation_paths(self, operation):
        kind, name = operation.get("kind"), operation.get("name")
        if not isinstance(operation.get("existed"), bool):
            raise ValueError("Invalid bundled replacement record")
        if kind == "runtime" and name == "openclaw":
            live = self.runtime
            previous = self.runtime.with_name("openclaw.previous")
        elif kind == "plugin-peer" and name in {"openclaw-weixin", "llama-cpp"}:
            live = self.state / "extensions" / name / "node_modules" / "openclaw"
            previous = self.backup_dir / "plugin-peers" / name
            plain_path(live.parent)
            plain_path(previous.parent)
            return live, previous
        elif kind == "uninstaller" and name in {"MicroClawInstaller.exe", "_internal"}:
            live = self.state / name
            previous = self.backup_dir / "uninstaller" / name
        elif kind == "desktop" and isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            if name in {".", ".."} or name.lower() in RESERVED_DESKTOP_NAMES:
                raise ValueError("Desktop payload overlaps upgrade state")
            live = self.desktop / name
            previous = self.backup_dir / "desktop" / name
        else:
            raise ValueError("Invalid bundled replacement target")
        return plain_path(live), plain_path(previous)

    def bind_plugin_peer(self, name):
        operation = {"kind": "plugin-peer", "name": name, "existed": False}
        live, previous = self.operation_paths(operation)
        if not live.parent.parent.is_dir():
            return
        if any(o["kind"] == "plugin-peer" and o["name"] == name for o in self.data["operations"]):
            return
        operation["existed"] = live.exists() or live.is_symlink() or live.is_junction()
        if previous.exists() or previous.is_symlink() or previous.is_junction():
            raise ValueError("Plugin peer recovery destination already exists")
        self.data["operations"].append(operation)
        self.save("installing")
        if operation["existed"]:
            previous.parent.mkdir(parents=True, exist_ok=True)
            _durable_replace(live, previous)
        live.parent.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            import subprocess

            target = self.runtime / "node_modules" / "openclaw"
            script = "New-Item -ItemType Junction -Path '{}' -Target '{}' -ErrorAction Stop | Out-Null".format(
                str(live).replace("'", "''"), str(target).replace("'", "''")
            )
            encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                capture_output=True,
                creationflags=0x08000000,
                timeout=30,
            )
            if result.returncode != 0:
                raise OSError("Could not bind managed plugin to the bundled OpenClaw runtime")
        else:
            live.symlink_to(self.runtime / "node_modules" / "openclaw", target_is_directory=True)

    @classmethod
    def load(cls, desktop, runtime, state, user_data):
        journal = plain_path(desktop / "upgrade" / "bundled-upgrade.json")
        if not journal.exists():
            return None
        data = json.loads(journal.read_text(encoding="utf-8"))
        return cls(desktop, runtime, state, user_data, data)

    @classmethod
    def create(cls, desktop, runtime, state, user_data, source_version, target_version):
        if source_version and tuple(map(int, source_version.split("."))) > tuple(
            map(int, target_version.split("."))
        ):
            raise ValueError("Refusing a bundled OpenClaw downgrade")
        transaction = cls(
            desktop,
            runtime,
            state,
            user_data,
            {
                "schema": 1,
                "id": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8],
                "phase": "backing-up",
                "sourceVersion": source_version,
                "targetVersion": target_version,
                "desktop": str(plain_path(desktop)),
                "runtime": str(plain_path(runtime)),
                "state": str(plain_path(state)),
                "userData": str(plain_path(user_data)),
                "stateExisted": state.exists(),
                "dataTouched": False,
                "operations": [],
                "archiveSha256": None,
            },
        )
        transaction.claim()
        try:
            if _manifest_requires_recovery(
                transaction.desktop / "upgrade" / "openclaw-upgrade.json"
            ):
                raise ValueError("An older desktop upgrade still requires recovery")
            legacy = transaction.desktop / "upgrade" / "openclaw-package-upgrade.json"
            if (
                legacy.exists()
                and json.loads(legacy.read_text(encoding="utf-8")).get("phase") != "complete"
            ):
                raise ValueError("An older npm upgrade still requires recovery")
            previous = cls.load(desktop, runtime, state, user_data)
            if previous and previous.data["phase"] not in TERMINAL_PHASES:
                raise ValueError("Pending bundled upgrade requires rollback first")
            transaction.save("backing-up")
            return transaction
        except BaseException:
            transaction.close()
            raise

    def claim(self):
        if self.lock is None:
            self.lock = _acquire_transaction_lock(
                self.desktop / "upgrade" / "openclaw-upgrade.lock", self.data["id"]
            )

    def close(self):
        if self.lock is not None:
            self.lock.release(self.lock.owner_token)
            self.lock = None

    def save(self, phase, **changes):
        if self.lock is None:
            raise RuntimeError("Bundled upgrade does not own its lock")
        self.data.update(
            changes, phase=phase, ownerPid=os.getpid(), updatedAt=datetime.now(UTC).isoformat()
        )
        self.validate()
        _atomic_json_write(self.backup_dir / "transaction.json", self.data)
        _atomic_json_write(self.journal, self.data)
        marker = self.desktop / "upgrade" / ".bundled-upgrade-active"
        if phase in TERMINAL_PHASES:
            marker.unlink(missing_ok=True)
        else:
            marker.write_text(self.data["id"], encoding="utf-8")

    def track_runtime(self):
        if any(operation["kind"] == "runtime" for operation in self.data["operations"]):
            return
        operation = {"kind": "runtime", "name": "openclaw", "existed": self.runtime.exists()}
        _, previous = self.operation_paths(operation)
        if previous.exists():
            raise ValueError("An unclaimed previous runtime exists; recovery is required")
        self.data["operations"].append(operation)
        self.save("installing")

    def archive_digest(self):
        with plain_path(self.archive).open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    def verify_archive(self):
        if self.archive_digest() != self.data.get("archiveSha256"):
            raise ValueError("Bundled upgrade state archive checksum mismatch")
        manifest = verify_lightweight_archive(self.archive)
        if (
            manifest.get("stateDir") != str(self.state)
            or manifest.get("desktopDir") != str(self.user_data)
            or manifest.get("sourceVersion") != self.data["sourceVersion"]
        ):
            raise ValueError("Bundled state snapshot identity mismatch")
        return manifest

    def ready(self):
        if self.data.get("archiveSha256"):
            self.verify_archive()
        elif self.data["stateExisted"] and (self.state / "openclaw.json").exists():
            raise ValueError("Existing user configuration has no verified recovery snapshot")
        self.save("installing")

    def replace(self, kind, name, source: Path | None):
        if self.data["phase"] != "installing":
            raise RuntimeError("Bundled replacement requires a verified recovery point")
        probe = {"kind": kind, "name": name, "existed": False}
        live, previous = self.operation_paths(probe)
        if any(o["kind"] == kind and o["name"] == name for o in self.data["operations"]):
            raise RuntimeError("Bundled replacement was already started; recover before retrying")
        if previous.exists():
            raise ValueError("Previous payload destination already exists")
        probe["existed"] = live.exists()
        self.data["operations"].append(probe)
        self.save("installing")  # Intent is durable before moving either directory.
        if probe["existed"]:
            previous.parent.mkdir(parents=True, exist_ok=True)
            _durable_replace(live, previous)
        if source is not None:
            plain_path(source)
            live.parent.mkdir(parents=True, exist_ok=True)
            _durable_replace(source, live)

    def touch_data(self):
        self.save("installing", dataTouched=True)

    def restore_state(self):
        manifest = self.verify_archive()
        entries = {
            str(plain_path(Path(entry["sourcePath"]))): entry for entry in manifest["entries"]
        }
        protected = manifest.get("protectedRoots")
        if not isinstance(protected, list):
            raise ValueError("Snapshot has no recovery whitelist")
        roots = [plain_path(Path(root)) for root in protected]
        if any(not any(Path(source).is_relative_to(root) for root in roots) for source in entries):
            raise ValueError("Snapshot entry is outside its recovery whitelist")
        # Keep post-upgrade contents as recovery evidence rather than deleting them.
        quarantine = self.backup_dir / "failed-state"
        quarantine.mkdir(exist_ok=True)
        index_path = quarantine / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}

        def capture(path):
            key = hashlib.sha256(str(path).encode()).hexdigest()
            captured = quarantine / key
            if not captured.exists():
                shutil.copy2(path, captured)
                _fsync_file(captured)
            index[key] = str(path)
            _atomic_json_write(index_path, index)

        candidates = set(Path(source) for source in entries)
        for root in roots:
            if root.is_dir():
                for directory, subdirs, files in os.walk(root, followlinks=False):
                    for name in subdirs:
                        plain_path(Path(directory) / name)
                    candidates.update(Path(directory) / name for name in files)
            elif root.exists():
                candidates.add(root)
        for source in sorted(candidates):
            plain_path(source)
            if not source.is_file():
                continue
            capture(source)
            if str(source) not in entries:
                source.unlink()
        with tarfile.open(self.archive, "r:gz") as bundle:
            for source, entry in entries.items():
                target = plain_path(Path(source))
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(f".{target.name}.{self.data['id']}.restore")
                with (
                    bundle.extractfile(entry["archivePath"]) as incoming,
                    temporary.open("wb") as outgoing,
                ):
                    shutil.copyfileobj(incoming, outgoing)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                with temporary.open("rb") as stream:
                    sqlite = stream.read(16) == b"SQLite format 3\x00"
                if sqlite:
                    for suffix in ("-wal", "-shm", "-journal"):
                        companion = plain_path(Path(source + suffix))
                        if companion.exists():
                            capture(companion)
                            companion.unlink()
                _durable_replace(temporary, target)
        for directory in manifest.get("directories", []):
            candidate = plain_path(Path(directory))
            if not any(candidate.is_relative_to(root) for root in roots):
                raise ValueError("Snapshot directory is outside recovery whitelist")
            candidate.mkdir(parents=True, exist_ok=True)

    def rollback(self):
        self.claim()
        self.save("rolling-back")
        if self.data["dataTouched"]:
            if self.data.get("archiveSha256"):
                self.restore_state()
            elif not self.data["stateExisted"] and self.state.exists():
                quarantine = self.backup_dir / "failed-new-state"
                if not quarantine.exists():
                    _durable_replace(self.state, quarantine)
            else:
                raise ValueError("Cannot roll back changed state without a verified backup")
        for operation in reversed(self.data["operations"]):
            if operation.get("restored"):
                continue
            live, previous = self.operation_paths(operation)
            if previous.exists() or previous.is_symlink() or previous.is_junction():
                unlink_owned_leaf(live)
                _durable_replace(previous, live)
            elif not operation["existed"]:
                unlink_owned_leaf(live)
            operation["restored"] = True
            self.save("rolling-back")
        self.save("rolled-back")
        self.close()

    def commit(self):
        if self.data["phase"] != "validating" or not self.data.get("validated"):
            raise RuntimeError("Cannot commit an unvalidated bundled upgrade")
        self.save("committed")
        self.close()
        return self.cleanup_program_backups()

    def cleanup_program_backups(self):
        if self.data["phase"] != "committed":
            raise RuntimeError("Cannot retire program backups before commit")
        failures = []
        # Cleanup failure does not invalidate a committed installation; leave evidence.
        for operation in self.data["operations"]:
            _, previous = self.operation_paths(operation)
            try:
                unlink_owned_leaf(previous)
            except OSError as error:
                failures.append(f"{previous}: {error}")
        return failures
