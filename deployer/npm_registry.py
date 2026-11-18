"""MicroClaw-owned npm source selection; never writes the user's npm configuration."""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

REGISTRY_CONFIG_NAME = "npm-registry.json"


def normalize_npm_registry(value: str) -> str:
    message = "MicroClaw npm registry must be an absolute HTTP(S) URL without credentials or query."
    if not isinstance(value, str) or re.search(r"[\s\\]", value.strip()):
        raise ValueError(message)
    try:
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(message)
        host = parsed.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        port = parsed.port
        if port is not None and (parsed.scheme.lower(), port) not in {("http", 80), ("https", 443)}:
            host += f":{port}"
        return urlunsplit((parsed.scheme.lower(), host, parsed.path.rstrip("/"), "", ""))
    except (ValueError, AttributeError) as error:
        raise ValueError(message) from error


def load_registry_config(path: Path) -> str | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise ValueError("MicroClaw npm source configuration could not be read.") from error
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ValueError("Unsupported MicroClaw npm source configuration.")
    return normalize_npm_registry(payload.get("registry"))


def default_npm_registry() -> str:
    value = load_registry_config(Path(__file__).parent / "assets" / REGISTRY_CONFIG_NAME)
    if value is None:
        raise ValueError("MicroClaw default npm source configuration is missing.")
    return value


def resolve_npm_registry(*, configured=None, dedicated=None, installed=None, bundled=None) -> str:
    candidates = (
        os.environ.get("MICROCLAW_NPM_REGISTRY"),
        configured,
        dedicated,
        (installed or {}).get("npmRegistry"),
        (bundled or {}).get("npmRegistry"),
    )
    for value in candidates:
        if value:
            return normalize_npm_registry(value)
    return default_npm_registry()


def registry_environment(environment: dict[str, str], registry: str) -> dict[str, str]:
    settings = {
        "npm_config_registry": normalize_npm_registry(registry),
        "npm_config_replace_registry_host": "npmjs",
        "npm_config_fetch_retries": "1",
        "npm_config_fetch_retry_mintimeout": "1000",
        "npm_config_fetch_retry_maxtimeout": "3000",
        "npm_config_fetch_timeout": "60000",
    }
    return {
        **{key: value for key, value in environment.items() if key.lower() not in settings},
        **settings,
    }
