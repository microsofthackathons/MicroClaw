"""OpenClaw target version and Node.js engine policy."""

from __future__ import annotations

import re

OPENCLAW_TARGET_VERSION = "2026.7.1-1"
NODE_FALLBACK_VERSION = "22.22.3"

_NODE_VERSION_RE = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
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
        (major == 22 and (minor, patch) >= (22, 3))
        or (major == 24 and (minor, patch) >= (15, 0))
        or (major == 25 and (minor, patch) >= (9, 0))
        or major > 25
    )


def extract_openclaw_version(npm_list_output: str) -> str | None:
    match = _OPENCLAW_VERSION_RE.search(npm_list_output)
    if match is None:
        return None
    return match.group("version")
