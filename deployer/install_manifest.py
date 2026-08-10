"""Build identity and committed install state for repeat-install fast paths."""

from __future__ import annotations

import json
import os
from pathlib import Path

MANIFEST_NAME = "install-manifest.json"
SCHEMA_VERSION = 1
_BUILD_KEYS = (
    "desktopArchiveSha256",
    "installerBundleId",
    "managedSkillsId",
    "openClawVersion",
    "appContainerSchema",
)


def load_install_manifest(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema") != SCHEMA_VERSION:
        return None
    if any(not isinstance(payload.get(key), (str, int)) for key in _BUILD_KEYS):
        return None
    if not all(str(payload[key]).strip() for key in _BUILD_KEYS):
        return None
    registry = payload.get("npmRegistry")
    if registry is not None and not isinstance(registry, str):
        return None
    return payload


def resolve_bundled_install_manifest(
    *,
    frozen: bool,
    executable: Path,
    app_dir: Path,
) -> dict | None:
    candidates = (
        [
            executable.parent / MANIFEST_NAME,
            executable.parent / "_internal" / MANIFEST_NAME,
        ]
        if frozen
        else []
    )
    candidates.extend(
        (
            app_dir / "dist" / MANIFEST_NAME,
            app_dir / MANIFEST_NAME,
        )
    )
    return next(
        (manifest for path in candidates if (manifest := load_install_manifest(path)) is not None),
        None,
    )


def build_identity_matches(bundled: dict | None, persisted: dict | None) -> bool:
    if bundled is None or persisted is None:
        return False
    return all(bundled.get(key) == persisted.get(key) for key in ("schema", *_BUILD_KEYS))


def normalize_registry(value: str) -> str:
    return value.strip().rstrip("/").casefold()


def committed_install_manifest(bundled: dict, npm_registry: str) -> dict:
    return {
        **{key: bundled[key] for key in ("schema", *_BUILD_KEYS)},
        "npmRegistry": normalize_registry(npm_registry),
    }


def write_install_manifest(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
