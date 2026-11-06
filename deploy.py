#!/usr/bin/env python3
"""MicroClaw WebView installer and uninstaller entry point."""

import argparse
import sys
import traceback

from deployer.logger import DeployerLogger
from deployer.webview_bridge import run_web_installer


def _setup_windows_taskbar():
    import ctypes

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "ai.openclaw.microclaw.installer"
        )
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


def _report_startup_failure(exc: Exception):
    message = (
        "MicroClaw Setup could not open its WebView interface.\n"
        "Check the WebView2/.NET prerequisites and the error below, then try again.\n\n"
        "MicroClaw 安装界面无法启动，请检查 WebView2/.NET 依赖及以下错误后重试。\n\n"
        f"{exc}"
    )
    try:
        logger = DeployerLogger()
        logger.error(f"Web installer unavailable: {exc}")
        logger.debug(traceback.format_exc())
        message += f"\n\nLog / 日志: {logger.log_file}"
    except Exception:
        pass
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "MicroClaw Setup", 0x10)
    except Exception:
        if sys.stderr is not None:
            print(message, file=sys.stderr)


def _run_installer(auto_uninstall: bool):
    run_web_installer(mode="uninstall" if auto_uninstall else "install")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MicroClaw Setup")
    parser.add_argument("--uninstall", action="store_true", help="Uninstall MicroClaw")
    parser.add_argument("--check-uninstaller", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.check_uninstaller:
        return 0

    _setup_windows_taskbar()
    try:
        _run_installer(auto_uninstall=args.uninstall)
    except Exception as exc:
        _report_startup_failure(exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
