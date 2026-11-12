"""Verified whitelist archives for upgrade recovery, not full OpenClaw backups."""

import hashlib
import io
import json
import os
import re
import tarfile
import uuid
from datetime import UTC, datetime
from pathlib import Path

from deployer.openclaw_upgrade import _fsync_directory, _fsync_file

BACKUP_SCOPE = "microclaw-lightweight-v1"


def _regular_file(path: Path) -> os.stat_result:
    if path.is_symlink() or path.is_junction() or not path.is_file():
        raise ValueError(f"Backup source must be a regular, unlinked file: {path}")
    if path.resolve() != path.absolute():
        raise ValueError(f"Backup source traverses a redirected directory: {path}")
    return path.stat()


def _fingerprint(stat: os.stat_result) -> tuple:
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_lightweight_archive(archive: Path) -> dict:
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        names = [member.name for member in members]
        if len(set(names)) != len(names) or not all(member.isfile() for member in members):
            raise ValueError("Invalid lightweight backup members")
        manifest_member = bundle.getmember("manifest.json")
        if manifest_member.size > 64 * 1024 * 1024:
            raise ValueError("Lightweight backup manifest exceeds the supported size")
        with bundle.extractfile(manifest_member) as stream:
            manifest = json.load(stream)
        if (
            manifest.get("schema") != 1
            or manifest.get("scope") != BACKUP_SCOPE
            or manifest.get("verifiedSqlite") is not True
            or not isinstance(manifest.get("entries"), list)
        ):
            raise ValueError("Unrecognized lightweight backup scope")
        expected = {"manifest.json"}
        sources = set()
        for entry in manifest["entries"]:
            name = entry.get("archivePath", "")
            source = entry.get("sourcePath")
            if (
                not re.fullmatch(r"payload/[0-9]{8}", name)
                or name in expected
                or not isinstance(source, str)
                or not Path(source).is_absolute()
                or source in sources
                or re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256"))) is None
            ):
                raise ValueError("Invalid lightweight backup entry")
            expected.add(name)
            sources.add(source)
            member = bundle.getmember(name)
            with bundle.extractfile(member) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if member.size != entry.get("size") or digest != entry["sha256"]:
                raise ValueError(f"Lightweight backup payload verification failed: {name}")
        if set(names) != expected:
            raise ValueError("Unexpected or missing lightweight backup payload")
        return manifest


def create_lightweight_archive(
    plan_path: Path,
    archive: Path,
    *,
    state_dir: Path,
    desktop_dir: Path,
    source_version: str,
    progress,
) -> dict:
    scratch = plan_path.parent.resolve()
    _regular_file(plan_path)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if (
        plan.get("scope") != BACKUP_SCOPE
        or plan.get("verifiedSqlite") is not True
        or plan.get("sourceVersion") != source_version
        or Path(plan.get("stateDir", "")).resolve() != state_dir.resolve()
        or Path(plan.get("desktopDir", "")).resolve() != desktop_dir.resolve()
        or not isinstance(plan.get("entries"), list)
        or not isinstance(plan.get("workspaceDirs"), list)
    ):
        raise ValueError("Incomplete lightweight state/workspace snapshot plan")
    manifest = {key: value for key, value in plan.items() if key != "entries"} | {
        "schema": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "entries": [],
    }
    captured = []
    seen = set()
    for index, entry in enumerate(plan["entries"]):
        source = Path(entry["sourcePath"])
        staged = Path(entry["stagedPath"])
        if (
            not source.is_absolute()
            or not staged.is_absolute()
            or source in seen
            or (source != staged and not staged.resolve().is_relative_to(scratch))
            or archive.resolve().is_relative_to(source)
        ):
            raise ValueError("Invalid or redirected lightweight backup source")
        before = _regular_file(staged)
        if source == staged:
            with staged.open("rb") as stream:
                if stream.read(16) == b"SQLite format 3\x00":
                    raise ValueError(f"SQLite file has no verified OpenClaw snapshot: {source}")
        digest = _digest(staged)
        if _fingerprint(before) != _fingerprint(_regular_file(staged)):
            raise ValueError(f"Backup source changed while hashing: {source}")
        record = {
            "sourcePath": str(source),
            "archivePath": f"payload/{index:08d}",
            "kind": entry["kind"],
            "size": before.st_size,
            "sha256": digest,
        }
        manifest["entries"].append(record)
        captured.append((staged, before, record))
        seen.add(source)
    config = state_dir / "openclaw.json"
    if config.exists() and config not in seen:
        raise ValueError("Active configuration is missing from lightweight backup")
    temporary = archive.with_name(f".{archive.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as output, tarfile.open(fileobj=output, mode="w:gz") as bundle:
            content = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
            member = tarfile.TarInfo("manifest.json")
            member.size = len(content)
            member.mode = 0o600
            bundle.addfile(member, io.BytesIO(content))
            for index, (staged, before, record) in enumerate(captured):
                if _fingerprint(before) != _fingerprint(_regular_file(staged)):
                    raise ValueError(
                        f"Backup source changed before archiving: {record['sourcePath']}"
                    )
                member = tarfile.TarInfo(record["archivePath"])
                member.size = record["size"]
                member.mode = 0o600
                with staged.open("rb") as stream:
                    bundle.addfile(member, stream)
                if _fingerprint(before) != _fingerprint(_regular_file(staged)):
                    raise ValueError(
                        f"Backup source changed during archiving: {record['sourcePath']}"
                    )
                if index % 100 == 0:
                    progress(f"Lightweight backup: {index + 1}/{len(captured)} files archived")
        _fsync_file(temporary)
        verify_lightweight_archive(temporary)
        os.link(temporary, archive)
        _fsync_file(archive)
        _fsync_directory(archive.parent)
    finally:
        temporary.unlink(missing_ok=True)
    total = sum(entry["size"] for entry in manifest["entries"])
    progress(f"Verified lightweight backup: {len(captured)} files, {total} source bytes; {archive}")
    return manifest
