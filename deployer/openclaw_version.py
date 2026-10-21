"""OpenClaw target version and Node.js engine policy."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

OPENCLAW_TARGET_VERSION = "2026.10.3"


def packaged_openclaw_version(manifest_path: Path) -> str:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    version = manifest["openClawVersion"]
    if not isinstance(version, str) or re.fullmatch(r"[0-9]{4}\.[0-9]+\.[0-9]+", version) is None:
        raise ValueError("Invalid packaged OpenClaw target version")
    return version


if getattr(sys, "frozen", False):
    OPENCLAW_TARGET_VERSION = packaged_openclaw_version(
        Path(sys._MEIPASS) / "install-manifest.json"
    )

NODE_DEFAULT_MAJOR = "26"
NODE_ENGINE_RANGE = ">=24.16.0 <25 || >=26.1.0"
NODE_FALLBACK_VERSION = "26.1.0"

_NODE_VERSION_RE = re.compile(
    r"v?(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)"
)
_OPENCLAW_VERSION_RE = re.compile(r"openclaw@(?P<version>\S+)")


def _parse_node_version(value: str) -> tuple[int, int, int] | None:
    match = _NODE_VERSION_RE.fullmatch(value)
    if match is None:
        return None
    return tuple(int(match.group(part)) for part in ("major", "minor", "patch"))


def is_supported_node_version(value: str) -> bool:
    version = _parse_node_version(value)
    if version is None:
        return False

    major, minor, patch = version
    return (
        (major == 24 and (minor, patch) >= (16, 0))
        or (major == 26 and (minor, patch) >= (1, 0))
        or major > 26
    )


def extract_openclaw_version(npm_list_output: str) -> str | None:
    match = _OPENCLAW_VERSION_RE.search(npm_list_output)
    if match is None:
        return None
    return match.group("version")
