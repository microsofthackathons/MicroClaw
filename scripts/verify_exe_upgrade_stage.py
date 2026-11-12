"""Exercise the data/desktop install steps from an extracted Windows EXE payload."""

from __future__ import annotations

import argparse
import hashlib
import importlib.abc
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader


class FrozenDeployer(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, executable: Path, internal: Path):
        self.archive = CArchiveReader(str(executable)).open_embedded_archive("PYZ.pyz")
        self.internal = internal

    def find_spec(self, fullname, path=None, target=None):
        if fullname != "deployer" and not fullname.startswith("deployer."):
            return None
        if fullname not in self.archive.toc:
            raise ImportError(f"Missing frozen installer module: {fullname}")
        return importlib.util.spec_from_loader(
            fullname, self, is_package=self.archive.toc[fullname][0] == 1
        )

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__file__ = str(self.internal / (module.__name__.replace(".", "/") + ".py"))
        exec(self.archive.extract(module.__name__), module.__dict__)


def require_inside(root: Path, target: Path) -> Path:
    resolved = target.resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError(f"Fixture path escaped its root: {target}")
    return resolved


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--version", required=True, choices=["2026.10.5", "2026.10.10"])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--registry", default="https://repo.huaweicloud.com/repository/npm/")
    parser.add_argument("--inject-validation-failure", action="store_true")
    args = parser.parse_args()
    root = args.fixture.resolve()
    if not (root / ".microclaw-upgrade-fixture").is_file():
        raise ValueError("An explicitly marked isolated fixture directory is required")
    home = require_inside(root, root / "home")
    state = require_inside(root, home / ".openclaw")
    desktop = require_inside(root, home / ".microclaw")
    temporary = require_inside(root, root / "temp")
    for directory in (
        home,
        state,
        desktop,
        temporary,
        home / "AppData/Roaming",
        home / "AppData/Local",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    for key in list(os.environ):
        upper = key.upper()
        if upper.startswith(("OPENCLAW_", "MICROCLAW_", "VITEST")) or any(
            sensitive in upper for sensitive in ("API_KEY", "TOKEN", "SECRET", "PASSWORD")
        ):
            del os.environ[key]
    os.environ.pop("NODE_ENV", None)
    os.environ.update(
        USERPROFILE=str(home),
        HOME=str(home),
        APPDATA=str(home / "AppData/Roaming"),
        LOCALAPPDATA=str(home / "AppData/Local"),
        TEMP=str(temporary),
        TMP=str(temporary),
        OPENCLAW_HOME=str(home),
        OPENCLAW_STATE_DIR=str(state),
        OPENCLAW_CONFIG_PATH=str(state / "openclaw.json"),
        OPENCLAW_NODE_DIR=str(home / ".openclaw-node"),
        MICROCLAW_DIR=str(desktop),
        OPENCLAW_DEPLOYER_LOGDIR=str(root / "logs"),
        npm_config_userconfig=str(home / ".npmrc"),
        NODE_LLAMA_CPP_SKIP_DOWNLOAD="true",
    )
    if Path.home().resolve() != home:
        raise ValueError("Python home isolation failed")
    payload = args.payload.resolve()
    internal = payload / "_internal"
    executable = payload / "MicroClawInstaller.exe"
    manifest = json.loads((internal / "install-manifest.json").read_text(encoding="utf-8-sig"))
    if manifest["openClawVersion"] != args.version:
        raise ValueError("The EXE payload is not the expected version")
    with (internal / "microclaw-portable.zip").open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest["desktopArchiveSha256"]:
        raise ValueError("The EXE desktop archive differs from its manifest")
    sys.meta_path.insert(0, FrozenDeployer(executable, internal))
    sys.frozen = True
    sys._MEIPASS = str(internal)
    sys.executable = str(executable)
    from deployer.config import DeployerConfig
    from deployer.logger import DeployerLogger
    from deployer.windows_setup import WindowsSetup

    config = DeployerConfig(path=root / "fixture-config.yaml")
    config.set("npm.registry", args.registry)
    config.set("gateway.port", args.port)
    config.set("model.provider", "openai")
    config.set("model.model_name", "migration-fixture-model")
    config.set("model.api_key", "not-a-real-api-key-migration-fixture")
    logger = DeployerLogger(f"UpgradeFixture-{args.version}")
    setup = WindowsSetup(config, logger)
    if setup.node_dir.resolve() != home / ".openclaw-node":
        raise ValueError("Installer Node prefix isolation failed")
    detected = setup._detect_openclaw_installation()
    if detected is not None:
        require_inside(root, detected.prefix)
        require_inside(root, detected.entry_path)
    setup.node_dir.mkdir(parents=True, exist_ok=True)
    node = setup.node_dir / "node.exe"
    if not node.exists():
        shutil.copy2(args.node.resolve(), node)
    inventory = setup._process_snapshot
    setup._process_snapshot = lambda: {
        process_id: process
        for process_id, process in inventory().items()
        if process_id == os.getpid() or str(root).lower() in process.command_line.lower()
    }
    official_update = setup._run_official_update
    invocations = []
    injected = False

    def run_official_update(command, **options):
        stage = "doctor" if "doctor" in command else "backup" if "backup" in command else "npm"
        invocations.append(stage)
        result = official_update(command, **options)
        (root / f"official-{stage}.stdout.log").write_text(result.stdout or "", encoding="utf-8")
        (root / f"official-{stage}.stderr.log").write_text(result.stderr or "", encoding="utf-8")
        return result

    setup._run_official_update = run_official_update
    installed_version_validation = setup._validate_installed_version

    def validate_installed_version():
        nonlocal injected
        if args.inject_validation_failure and not injected:
            injected = True
            return False
        return installed_version_validation()

    setup._validate_installed_version = validate_installed_version
    steps = [
        ("prepare-core", setup.prepare_openclaw_update),
        ("install-core", setup.install_openclaw_windows),
        ("prepare-managed-state", setup.prepare_openclaw_upgrade),
        ("install-desktop", setup.install_desktop_client),
        ("write-config", setup.write_config),
        ("validate", setup.begin_openclaw_upgrade_validation),
        ("commit", setup.commit_openclaw_upgrade),
    ]
    completed = []
    for label, action in steps:
        print(f"[{args.version}] {label}", flush=True)
        if not action():
            print("\n".join(logger.get_all_lines()[-100:]), flush=True)
            if args.inject_validation_failure and injected and label == "install-core":
                failure = {"injectedValidationFailure": True, "officialUpdateCommands": invocations}
                (root / "validation-failure-injection.json").write_text(
                    json.dumps(failure, indent=2), encoding="utf-8"
                )
                print(json.dumps(failure), flush=True)
                return 0
            raise RuntimeError(f"Frozen installer step failed: {label}")
        completed.append(label)
    if args.inject_validation_failure:
        raise ValueError("The requested version validation failure was not exercised")
    installation = setup._detect_openclaw_installation()
    if installation is None or installation.version != args.version:
        raise ValueError("Installed npm runtime does not match the EXE target")
    runtime = setup._desktop_runtime_root
    if runtime is None:
        raise ValueError("The installed desktop did not prepare its actual runtime")
    require_inside(root, runtime)
    report = {
        "target": args.version,
        "payload": str(payload),
        "fixture": str(root),
        "steps": completed,
        "coreEntry": str(installation.entry_path),
        "desktopRuntimeEntry": str(runtime / "node_modules/openclaw/openclaw.mjs"),
        "node": str(desktop / "resources/node.exe"),
        "state": str(state),
        "desktopArchiveSha256": digest,
        "officialUpdateCommands": invocations,
        "hostStepsExcluded": ["registry/PATH", "Defender", "shortcuts", "installer UI"],
        "processInventory": "fixture-scoped; no unrelated process is stopped",
    }
    (root / f"installed-{args.version}.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    print(json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
