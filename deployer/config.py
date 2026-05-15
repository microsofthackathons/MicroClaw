"""Configuration management for OpenClaw Deployer.

Loads/saves a YAML config file; provides defaults so the app
works out-of-the-box.
"""

import copy
import os
import sys
from pathlib import Path
from typing import Any


def _get_app_dir() -> Path:
    """Return the directory where the exe (or script) lives."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


def _get_bundled_dir() -> Path:
    """Return the directory with bundled resources (_MEIPASS or CWD)."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


# We bundle a tiny YAML-like serialiser so the user doesn't need pyyaml.
# For real YAML we fall back to pyyaml if available.
try:
    import yaml  # type: ignore

    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


def _load_dotenv() -> None:
    """Load .env file from the app directory into os.environ (if present)."""
    env_path = _get_app_dir() / ".env"
    if not env_path.exists():
        return
    with env_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if key:
                os.environ.setdefault(key, value)


# Load .env BEFORE building DEFAULT_CONFIG so env vars are available
_load_dotenv()


DEFAULT_CONFIG: dict[str, Any] = {
    "node": {
        "version": "22",
    },
    "openclaw": {
        "install_method": "npm",  # npm | source
        "channel": "stable",  # stable | beta | dev
        "install_daemon": True,
    },
    "desktop": {
        "download_url": os.environ.get("MICROCLAW_URL", ""),
        "version": "latest",
    },
    "model": {
        "provider": "anthropic",
        "base_url": os.environ.get("MODEL_BASE_URL", ""),
        "api_key": os.environ.get("MODEL_API_KEY", ""),
        "model_name": os.environ.get("MODEL_NAME", "claude-opus-4-6"),
    },
    "brave": {
        "api_key": os.environ.get("BRAVE_API_KEY", ""),
    },
    "gateway": {
        "port": 18789,
        "bind": "loopback",
    },
    # Skill whitelist controls.
    # enable: set to true to activate skill restrictions (default off = no restrictions).
    # allowBundled: restrict bundled skills to this list (empty = no restriction).
    # allowManaged: whitelist for managed/workspace skills; skills NOT in this list get
    #   disabled via skills.entries.<name>.enabled=false in openclaw.json.
    #   An empty list with enable=true disables ALL managed/workspace skills.
    "skills": {
        "enable": True,
        "allowBundled": [],
        "allowManaged": [],
    },
    "logging": {
        "log_dir": str(_get_app_dir() / "logs"),
        "verbose": True,
    },
}

CONFIG_PATH = Path(os.environ.get("OPENCLAW_DEPLOYER_CONFIG", str(_get_app_dir() / "config.yaml")))


def _simple_dump(data: dict, indent: int = 0) -> str:
    """Minimal YAML-ish dump when pyyaml is absent."""
    lines: list[str] = []
    prefix = "  " * indent
    for k, v in data.items():
        if isinstance(v, dict):
            lines.append(f"{prefix}{k}:")
            lines.append(_simple_dump(v, indent + 1))
        elif isinstance(v, bool):
            lines.append(f"{prefix}{k}: {'true' if v else 'false'}")
        else:
            lines.append(f"{prefix}{k}: {v}")
    return "\n".join(lines)


def _simple_load(text: str) -> dict:
    """Very small subset YAML loader (flat + one-level nesting)."""
    result: dict = {}
    stack: list[tuple[int, dict]] = [(0, result)]
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip())
        while stack and indent <= stack[-1][0] and len(stack) > 1:
            stack.pop()
        if ":" not in stripped:
            continue
        key, _, val = stripped.partition(":")
        key = key.strip()
        val = val.strip()
        parent = stack[-1][1]
        if val == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent + 2, child))
        else:
            if val.lower() == "true":
                parent[key] = True
            elif val.lower() == "false":
                parent[key] = False
            else:
                try:
                    parent[key] = int(val)
                except ValueError:
                    parent[key] = val
    return result


class DeployerConfig:
    """Load → merge defaults → save cycle."""

    def __init__(self, path: Path | None = None):
        self.path = path or CONFIG_PATH
        self.data = copy.deepcopy(DEFAULT_CONFIG)
        if self.path.exists():
            self.load()
        elif getattr(sys, "frozen", False):
            # Running as exe: copy bundled config.yaml to exe dir if missing
            bundled = _get_bundled_dir() / "config.yaml"
            if bundled.exists():
                import shutil

                shutil.copy2(bundled, self.path)
                self.load()

    # ---- I/O ----

    def load(self):
        text = self.path.read_text(encoding="utf-8")
        if _HAS_YAML:
            loaded = yaml.safe_load(text) or {}
        else:
            loaded = _simple_load(text)
        self._deep_merge(self.data, loaded)

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if _HAS_YAML:
            text = yaml.dump(
                self.data, default_flow_style=False, allow_unicode=True, sort_keys=False
            )
        else:
            text = _simple_dump(self.data)
        self.path.write_text(text, encoding="utf-8")

    # ---- convenience getters ----

    def get(self, dotpath: str, default=None):
        """e.g. config.get('model.api_key')"""
        keys = dotpath.split(".")
        node = self.data
        for k in keys:
            if isinstance(node, dict) and k in node:
                node = node[k]
            else:
                return default
        return node

    def set(self, dotpath: str, value):
        keys = dotpath.split(".")
        node = self.data
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        node[keys[-1]] = value

    # ---- helpers ----

    @staticmethod
    def _deep_merge(base: dict, overlay: dict):
        for k, v in overlay.items():
            if isinstance(v, dict) and isinstance(base.get(k), dict):
                DeployerConfig._deep_merge(base[k], v)
            else:
                base[k] = v
