"""Durable publication of the onedir MicroClaw uninstaller."""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import warnings
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

INSTALLER_EXE = "MicroClawInstaller.exe"
INTERNAL_DIR = "_internal"
_HASH_WORKERS = 8

# PyInstaller runtime dependencies used by deploy.py / WebUninstallBridge.
# Installation payloads (desktop ZIP, scripts, skills, installer UI) are not
# part of the persisted uninstaller. Keep this policy shared with backup/restore.
_RUNTIME_DIRECTORIES = frozenset(
    {"_tcl_data", "_tk_data", "tcl8", "clr_loader", "pythonnet", "webview", "setuptools", "yaml"}
)
_UNINSTALLER_ASSETS = frozenset(
    {"uninstall_template.html", "microclaw.ico", "microclaw-uninstall.ico"}
)
# openclaw_version reads this manifest during import, including --uninstall.
_RUNTIME_ROOT_FILES = frozenset({"base_library.zip", "install-manifest.json"})


class UninstallerBundleError(RuntimeError):
    """Raised when the persistent uninstaller cannot be safely published."""


def _runtime_directory(relative: Path) -> bool:
    parts = tuple(part.casefold() for part in relative.parts)
    return bool(parts) and (
        parts[0] in _RUNTIME_DIRECTORIES or parts in (("deployer",), ("deployer", "assets"))
    )


def _runtime_file(relative: Path) -> bool:
    parts = tuple(part.casefold() for part in relative.parts)
    if len(parts) == 1:
        return parts[0] in _RUNTIME_ROOT_FILES or relative.suffix.casefold() in {".dll", ".pyd"}
    return parts[0] in _RUNTIME_DIRECTORIES or (
        len(parts) == 3 and parts[:2] == ("deployer", "assets") and parts[2] in _UNINSTALLER_ASSETS
    )


def _is_link(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def _runtime_walk_error(error: OSError) -> None:
    raise UninstallerBundleError(f"Could not enumerate uninstaller runtime: {error}") from error


def _runtime_files(internal: Path) -> Iterator[Path]:
    if _is_link(internal):
        raise UninstallerBundleError(f"Uninstaller runtime cannot be a link: {internal}")
    for directory, names, files in os.walk(internal, onerror=_runtime_walk_error):
        parent = Path(directory)
        names[:] = [
            name for name in names if _runtime_directory((parent / name).relative_to(internal))
        ]
        for name in names:
            if _is_link(parent / name):
                raise UninstallerBundleError(
                    f"Uninstaller runtime cannot contain links: {parent / name}"
                )
        for name in files:
            source = parent / name
            if _runtime_file(source.relative_to(internal)):
                if _is_link(source):
                    raise UninstallerBundleError(
                        f"Uninstaller runtime cannot contain links: {source}"
                    )
                yield source


def copy_uninstaller_runtime(source: Path, destination: Path) -> None:
    """Copy only the runtime allowlist, including when reading a legacy bundle."""
    if not source.is_dir():
        raise UninstallerBundleError(f"Uninstaller runtime directory is missing: {source}")
    destination.mkdir(parents=True)
    for path in _runtime_files(source):
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _has_extra_runtime_payload(internal: Path) -> bool:
    # Do not let a legacy destination with installation payloads hit the fast path.
    for directory, names, files in os.walk(internal, onerror=_runtime_walk_error):
        parent = Path(directory)
        if any(not _runtime_directory((parent / name).relative_to(internal)) for name in names):
            return True
        if any(not _runtime_file((parent / name).relative_to(internal)) for name in files):
            return True
    return False


def validate_uninstaller_bundle(root: Path) -> None:
    exe = root / INSTALLER_EXE
    internal = root / INTERNAL_DIR
    if not exe.is_file():
        raise UninstallerBundleError(f"Uninstaller executable is missing: {exe}")
    if not internal.is_dir():
        raise UninstallerBundleError(f"Uninstaller _internal directory is missing: {internal}")
    if next(_runtime_files(internal), None) is None:
        raise UninstallerBundleError(f"Uninstaller _internal directory is empty: {internal}")


def resolve_uninstaller_bundle(
    *,
    frozen: bool,
    executable: Path,
    app_dir: Path,
) -> Path:
    root = executable.parent if frozen else app_dir / "dist" / "MicroClawInstaller"
    validate_uninstaller_bundle(root)
    return root


def bundle_manifest(root: Path) -> dict[str, int]:
    validate_uninstaller_bundle(root)
    files = [root / INSTALLER_EXE]
    files.extend(_runtime_files(root / INTERNAL_DIR))
    return {
        path.relative_to(root).as_posix(): path.stat().st_size
        for path in sorted(files, key=lambda path: path.relative_to(root).as_posix())
    }


def _file_digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def bundles_match(source: Path, destination: Path) -> bool:
    try:
        source_manifest = bundle_manifest(source)
        if source_manifest != bundle_manifest(destination):
            return False
        if _has_extra_runtime_payload(destination / INTERNAL_DIR):
            return False

        def files_match(relative: str) -> bool:
            return _file_digest(source / relative) == _file_digest(destination / relative)

        with ThreadPoolExecutor(max_workers=_HASH_WORKERS) as pool:
            return all(pool.map(files_match, source_manifest))
    except (OSError, UninstallerBundleError):
        return False


def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _restore_previous_bundle(
    *,
    final_exe: Path,
    final_internal: Path,
    backup_exe: Path,
    backup_internal: Path,
    moved_exe: bool,
    moved_internal: bool,
    published_exe: bool,
    published_internal: bool,
) -> None:
    errors = []
    for path, published in (
        (final_exe, published_exe),
        (final_internal, published_internal),
    ):
        if not published:
            continue
        try:
            _remove_path(path)
        except OSError as error:
            errors.append(f"remove {path}: {error}")

    for backup_path, final_path, moved in (
        (backup_exe, final_exe, moved_exe),
        (backup_internal, final_internal, moved_internal),
    ):
        if not moved:
            continue
        try:
            os.replace(backup_path, final_path)
        except OSError as error:
            errors.append(f"restore {final_path}: {error}")

    if errors:
        raise UninstallerBundleError("; ".join(errors))


def publish_uninstaller_bundle(
    source: Path,
    destination: Path,
    startup_check: Callable[[Path], None],
    *,
    cleanup_error_handler: Callable[[str], None] | None = None,
) -> Path:
    source = source.resolve()
    destination = destination.resolve()
    validate_uninstaller_bundle(source)
    if source == destination:
        raise UninstallerBundleError("Uninstaller source and destination must differ")

    if bundles_match(source, destination):
        return destination / INSTALLER_EXE

    destination.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".microclaw-uninstaller-", dir=destination))
    staged = work / "staged"
    backup = work / "backup"
    staged.mkdir()
    backup.mkdir()

    final_exe = destination / INSTALLER_EXE
    final_internal = destination / INTERNAL_DIR
    backup_exe = backup / INSTALLER_EXE
    backup_internal = backup / INTERNAL_DIR
    moved_exe = False
    moved_internal = False
    published_exe = False
    published_internal = False
    preserve_work = False

    try:
        shutil.copy2(source / INSTALLER_EXE, staged / INSTALLER_EXE)
        copy_uninstaller_runtime(source / INTERNAL_DIR, staged / INTERNAL_DIR)
        if bundle_manifest(staged) != bundle_manifest(source):
            raise UninstallerBundleError("Staged uninstaller manifest does not match source")

        try:
            if final_exe.exists():
                os.replace(final_exe, backup_exe)
                moved_exe = True
            if final_internal.exists():
                os.replace(final_internal, backup_internal)
                moved_internal = True

            os.replace(staged / INSTALLER_EXE, final_exe)
            published_exe = True
            os.replace(staged / INTERNAL_DIR, final_internal)
            published_internal = True
            startup_check(final_exe)
        except Exception as publication_error:
            try:
                _restore_previous_bundle(
                    final_exe=final_exe,
                    final_internal=final_internal,
                    backup_exe=backup_exe,
                    backup_internal=backup_internal,
                    moved_exe=moved_exe,
                    moved_internal=moved_internal,
                    published_exe=published_exe,
                    published_internal=published_internal,
                )
            except Exception as restoration_error:
                preserve_work = True
                raise UninstallerBundleError(
                    f"Uninstaller publication failed: {publication_error}; "
                    f"restoration failed: {restoration_error}; "
                    f"recovery files retained at {work}"
                ) from restoration_error

            if isinstance(publication_error, UninstallerBundleError):
                raise publication_error
            raise UninstallerBundleError(
                f"Uninstaller publication failed: {publication_error}"
            ) from publication_error

        return final_exe
    except UninstallerBundleError:
        raise
    except Exception as error:
        raise UninstallerBundleError(f"Could not publish uninstaller bundle: {error}") from error
    finally:
        if not preserve_work and work.exists():
            try:
                shutil.rmtree(work)
            except OSError as error:
                message = f"Could not clean temporary uninstaller files at {work}: {error}"
                if cleanup_error_handler is not None:
                    cleanup_error_handler(message)
                else:
                    warnings.warn(message, RuntimeWarning, stacklevel=2)
