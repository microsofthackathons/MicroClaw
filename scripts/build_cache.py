import argparse
import fnmatch
import hashlib
import json
import os
import platform
import stat
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCHEMA = 1
STAGES = ("native", "desktop", "portable", "installer", "setup")
SOURCE_EXCLUDES = (".git", "__pycache__", ".cache", ".vite", "*.pyc", "*.tsbuildinfo")


def filesystem_path(path):
    if os.name != "nt":
        return Path(path)
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def fingerprint(root, paths, excludes=()):
    digest = hashlib.sha256()
    entries = []

    def hash_file(path):
        content = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(64 * 1024), b""):
                content.update(block)
                size += len(block)
        return size, content.hexdigest()

    def visit(path, label, ancestors, executor, entry=None):
        if any(
            fnmatch.fnmatchcase(path.name, pattern)
            if "/" not in pattern
            else label == pattern or label.startswith(pattern + "/")
            for pattern in excludes
        ):
            return
        metadata = entry if entry is not None else path
        is_link = metadata.is_symlink()
        if is_link:
            entries.append((label, "link", os.readlink(path)))
        if metadata.is_file():
            entries.append((label, "file", executor.submit(hash_file, path)))
        elif metadata.is_dir():
            attributes = getattr(metadata.stat(follow_symlinks=False), "st_file_attributes", 0)
            is_reparse = attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            resolved = path.resolve() if is_link or is_reparse else path.absolute()
            if resolved in ancestors:
                raise ValueError(f"Directory link cycle: {path}")
            entries.append((label, "directory"))
            with os.scandir(path) as children:
                for child in sorted(children, key=lambda item: item.name):
                    visit(
                        Path(child.path),
                        f"{label}/{child.name}",
                        ancestors | {resolved},
                        executor,
                        child,
                    )
        elif not path.exists() and not path.is_symlink():
            entries.append((label, "missing"))
        else:
            raise ValueError(f"Unsupported cache input: {path}")

    with ThreadPoolExecutor(max_workers=16) as executor:
        for name in sorted({str(path) for path in paths}):
            path = Path(name)
            if not path.is_absolute():
                path = root / path
            label = os.path.relpath(path, root).replace("\\", "/")
            visit(filesystem_path(path), label, set(), executor)
        for entry in entries:
            values = (*entry[:2], *entry[2].result()) if entry[1] == "file" else entry
            digest.update(json.dumps(values, ensure_ascii=True).encode("utf-8") + b"\n")
    return digest.hexdigest()


def stage_paths(root, stage):
    common = ["build.ps1", "scripts/build_cache.py"]
    if stage == "native":
        sources = [
            "windows-node-host",
            "third_party",
            "global.json",
            "NuGet.Config",
            "nuget.config",
            "Directory.Build.props",
            "Directory.Build.targets",
            "Directory.Packages.props",
        ]
        resources = [
            "desktop/scripts",
            "desktop/package.json",
            "desktop/package-lock.json",
            "desktop/node_modules/@microsoft/mxc-sdk",
            "plugins/openclaw-weixin",
        ]
        return [
            (common + sources, (*SOURCE_EXCLUDES, "bin", "obj")),
            (resources, SOURCE_EXCLUDES),
        ], [
            "desktop/resources/windows-node",
            "desktop/resources/openclaw-weixin",
        ]
    if stage == "desktop":
        return [
            (
                common + ["desktop", "NOTICE", "skills/rednote-publisher"],
                (
                    *SOURCE_EXCLUDES,
                    "desktop/dist",
                    "desktop/renderer/dist",
                    "desktop/release",
                    "desktop/resources/llama-cpp",
                    "desktop/native/build",
                    "desktop/studio-backend",
                    "desktop/logs",
                    "coverage",
                ),
            )
        ], ["desktop/release/win-unpacked"]
    if stage == "portable":
        return [(common + ["desktop/release/win-unpacked"], ())], ["dist/microclaw-portable.zip"]
    if stage == "installer":
        return [
            (
                common
                + [
                    "deploy.py",
                    "deployer",
                    "scripts",
                    "skills",
                    "MicroClawDeployer.spec",
                    "requirements.txt",
                    "pyproject.toml",
                    "uv.lock",
                    "desktop/src/openclaw-state-owner-compat.mjs",
                    "dist/microclaw-portable.zip",
                    "dist/install-manifest.json",
                    Path(sys.prefix),
                    Path(sys.base_prefix),
                ],
                (*SOURCE_EXCLUDES, "logs"),
            )
        ], ["dist/MicroClawInstaller"]
    return [(common + ["installer", "deployer/assets/microclaw.ico"], ())], [
        "dist/MicroClawSetup.exe"
    ]


def input_key(root, stage, context=(), extra_inputs=()):
    groups, _ = stage_paths(root, stage)
    environment_prefixes = (
        "DOTNET_",
        "MSBUILD",
        "NUGET_",
        "CSC_",
        "WIN_CSC_",
        "ELECTRON_",
        "MICROCLAW_",
        "NODE_",
        "NPM_CONFIG_",
        "PYTHON",
        "TRUSTED_SIGNING_",
    )
    environment = {
        name.upper(): value
        for name, value in os.environ.items()
        if name.upper().startswith(environment_prefixes)
        or name.upper() in ("PATH", "SOURCE_DATE_EPOCH", "USE_HARD_LINKS")
    }
    identity = {
        "schema": SCHEMA,
        "root": str(root),
        "stage": stage,
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "context": list(context),
        "environment": environment,
        "inputs": [fingerprint(root, paths, excludes) for paths, excludes in groups],
        "extraInputs": fingerprint(root, extra_inputs),
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()


def output_key(root, outputs):
    for name in outputs:
        path = filesystem_path(root / name)
        if not path.exists():
            return None
        if path.is_dir() and not any(child.is_file() for child in path.rglob("*")):
            return None
        if path.is_file() and path.stat().st_size == 0:
            return None
    return fingerprint(root, outputs)


def cache_file(root, stage):
    if stage not in STAGES:
        raise ValueError(f"Unknown build stage: {stage}")
    directory = root / "build" / "package-cache"
    if not directory.resolve().is_relative_to(root):
        raise ValueError(f"Cache directory escapes the workspace: {directory}")
    return directory / f"{stage}.json"


def probe(root, stage, key, outputs, rebuild=False):
    result = {"stage": stage, "key": key, "hit": False, "reason": "no cache"}
    if rebuild:
        return {**result, "reason": "rebuild requested"}
    try:
        state = json.loads(cache_file(root, stage).read_text(encoding="utf-8"))
        if not isinstance(state, dict) or state.get("schema") != SCHEMA:
            return {**result, "reason": "invalid cache"}
        if state.get("key") != key:
            return {**result, "reason": "inputs changed"}
        actual = output_key(root, outputs)
        if actual is None or actual != state.get("outputs"):
            return {**result, "reason": "outputs missing or changed"}
        return {**result, "hit": True, "reason": "content verified"}
    except (OSError, ValueError, TypeError):
        return result


def save(root, stage, key, outputs):
    actual = output_key(root, outputs)
    if actual is None:
        raise ValueError(f"Cannot cache incomplete {stage} outputs")
    destination = cache_file(root, stage)
    destination.parent.mkdir(parents=True, exist_ok=True)
    state = {"schema": SCHEMA, "key": key, "outputs": actual}
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=destination.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
        json.dump(state, stream, sort_keys=True)
    try:
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("probe", "save"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--stage", choices=STAGES, required=True)
    parser.add_argument("--context", action="append", default=[])
    parser.add_argument("--extra-input", action="append", default=[])
    parser.add_argument("--key")
    parser.add_argument("--rebuild", action="store_true")
    arguments = parser.parse_args()
    root = arguments.root.resolve()
    _, outputs = stage_paths(root, arguments.stage)
    if arguments.command == "probe":
        started = time.perf_counter()
        key = input_key(root, arguments.stage, arguments.context, arguments.extra_input)
        inputs_finished = time.perf_counter()
        result = probe(root, arguments.stage, key, outputs, arguments.rebuild)
        result["timings"] = {
            "inputs": round(inputs_finished - started, 4),
            "verification": round(time.perf_counter() - inputs_finished, 4),
        }
        print(json.dumps(result))
    else:
        if not arguments.key:
            parser.error("save requires --key")
        save(root, arguments.stage, arguments.key, outputs)


if __name__ == "__main__":
    main()
