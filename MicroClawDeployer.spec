# -*- mode: python ; coding: utf-8 -*-

import importlib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# Uses onedir mode to avoid WDAC (Windows Defender Application Control) blocking
# unsigned DLLs extracted to %TEMP% by onefile mode.
# build.ps1 packs the output directory into a self-extracting installer.

# Fail fast if pywebview is missing — collect_data_files silently returns [] for
# uninstalled packages, which produces a broken installer that crashes at runtime.
if importlib.util.find_spec('webview') is None:
    raise SystemExit(
        '\n*** BUILD ERROR: pywebview is not installed in this Python environment. ***\n'
        'The installer requires pywebview to bundle its WebView assets.\n'
        'Fix: pip install pywebview   (or: uv sync)\n'
    )

webview_datas = collect_data_files('webview', subdir='lib') + collect_data_files('webview', subdir='js')
webview_binaries = collect_dynamic_libs('webview')
pythonnet_datas = collect_data_files('pythonnet', subdir='runtime')


def collect_plugin_files(source_root='plugins'):
    """Bundle plugin source and manifests without local development artifacts."""
    root = Path(source_root)
    excluded_parts = {'node_modules', 'dist', 'coverage', '.cache'}
    collected = []
    for source in root.rglob('*'):
        if not source.is_file():
            continue
        relative = source.relative_to(root)
        if excluded_parts.intersection(relative.parts):
            continue
        if source.name.endswith(('.test.ts', '.tsbuildinfo')):
            continue
        destination = Path('plugins') / relative.parent
        collected.append((str(source), str(destination)))
    return collected


plugin_datas = collect_plugin_files()

a = Analysis(
    ['deploy.py'],
    pathex=[],
    binaries=webview_binaries,
    datas=[
        ('dist/microclaw-portable.zip', '.'),
        ('scripts/windows/setup-dependencies.ps1', '.'),
        ('skills', 'skills'),
        ('scripts', 'scripts'),
        ('deployer/assets', 'deployer/assets'),
    ] + plugin_datas + webview_datas + pythonnet_datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'qtpy'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='MicroClawInstaller',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['deployer/assets/microclaw.ico'],
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='MicroClawInstaller',
)
