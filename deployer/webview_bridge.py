import json
import locale
import os
import shutil
import sys
import threading
import time
import tkinter as tk
import traceback
import webbrowser
from pathlib import Path
from tkinter import filedialog

from deployer.config import DeployerConfig
from deployer.logger import DeployerLogger
from deployer.windows_setup import DEFAULT_DESKTOP_DIR, WindowsSetup

_ACTIVE_WINDOW = None
INSTALLER_WINDOW_WIDTH = 710
INSTALLER_WINDOW_HEIGHT = 680

# Per-step retry budgets for the install pipeline (number of *additional*
# attempts after the first). Network/download-bound steps get more attempts to
# ride out transient connectivity failures; local/config steps still get one
# retry as cheap insurance against flaky IO.
NETWORK_RETRIES = 3
LOCAL_RETRIES = 1


def _get_centered_window_position(width, height):
    """Return the top-left coordinates needed to center a window."""
    if sys.platform == "win32":
        try:
            import ctypes

            screen_w = ctypes.windll.user32.GetSystemMetrics(0)
            screen_h = ctypes.windll.user32.GetSystemMetrics(1)
            return max(0, (screen_w - width) // 2), max(0, (screen_h - height) // 2)
        except Exception:
            pass

    root = tk.Tk()
    root.withdraw()
    try:
        return max(0, (root.winfo_screenwidth() - width) // 2), max(
            0, (root.winfo_screenheight() - height) // 2
        )
    finally:
        root.destroy()


def _center_native_window(hwnd, logger=None):
    """Center a native Windows window using its actual rendered size."""
    if sys.platform != "win32" or not hwnd:
        return

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32

    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return

    width = rect.right - rect.left
    height = rect.bottom - rect.top

    monitor = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    used_monitor = user32.GetMonitorInfoW(monitor, ctypes.byref(info))
    if used_monitor:
        work = info.rcWork
        x = work.left + ((work.right - work.left - width) // 2)
        y = work.top + ((work.bottom - work.top - height) // 2)
    else:
        x, y = _get_centered_window_position(width, height)

    # On DPI-virtualized WinForms/WebView2 hosts, these APIs may mix physical
    # monitor bounds with logical SetWindowPos coordinates. Only convert when
    # the monitor width clearly exceeds the process-visible screen width.
    try:
        dpi = user32.GetDpiForWindow(hwnd)
        scale = dpi / 96.0 if dpi else 1.0
        screen_w = user32.GetSystemMetrics(0)
        work_w = info.rcWork.right - info.rcWork.left if used_monitor else 0
        if scale and scale != 1.0 and screen_w and work_w > screen_w * 1.25:
            x = round(x / scale)
            y = round(y / scale)
    except Exception:
        pass

    user32.SetWindowPos(hwnd, 0, x, y, 0, 0, 0x0001 | 0x0004)


def _detect_lang():
    """Detect UI language from env or system locale. Returns 'zh' or 'en'."""
    lang = os.environ.get("MICROCLAW_LANG", "").lower()
    if lang in ("zh", "cn", "zh-cn", "zh_cn"):
        return "zh"
    if lang in ("en", "en-us", "en_us"):
        return "en"
    # On Windows, query the user's UI language directly. locale.getlocale()
    # returns (None, None) on Python 3.11+ without an explicit setlocale call.
    if sys.platform == "win32":
        try:
            import ctypes

            lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            # Primary language ID (low 10 bits): 0x04 == LANG_CHINESE
            if (lcid & 0x3FF) == 0x04:
                return "zh"
            return "en"
        except Exception:
            pass
    try:
        loc = locale.getlocale()[0] or locale.getdefaultlocale()[0] or ""
    except Exception:
        loc = ""
    return "zh" if loc.lower().startswith("zh") else "en"


def _assets_dir():
    """Resolve the deployer assets directory."""
    candidates = []
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.append(Path(sys._MEIPASS) / "deployer" / "assets")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).parent / "deployer" / "assets")
    candidates.append(Path(__file__).resolve().parent / "assets")
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[-1]


_STRINGS = {
    "zh": {
        "welcomeTitle": "欢迎来到 MicroClaw",
        "legalLine": '点击"快速安装"，即表示你同意 MicroClaw',
        "serviceAgreement": "服务协议",
        "and": "和",
        "privacyStatement": "隐私声明",
        "quickInstall": "快速安装",
        "customInstall": "自定义安装",
        "customTitle": "自定义安装",
        "customSubtitle": "选择安装位置",
        "allowRead": "允许 MicroClaw 读取安装目录中的所有文件",
        "startInstall": "开始安装",
        "back": "← 返回",
        "viewLog": "查看日志",
        "close": "关闭",
        "installFailTitle": "安装失败",
        "installFailMsg": "请检查日志后重试。",
        "carousel": [
            ["顺手", "不用再学 prompt"],
            ["可信", "能拦、能改、能撤回"],
            ["懂你", "符合你的工作模式"],
        ],
    },
    "en": {
        "welcomeTitle": "Welcome to MicroClaw",
        "legalLine": 'By clicking "Quick Install", you agree to the MicroClaw',
        "serviceAgreement": "Service Agreement",
        "and": "and",
        "privacyStatement": "Privacy Statement",
        "quickInstall": "Quick Install",
        "customInstall": "Custom Install",
        "customTitle": "Custom Install",
        "customSubtitle": "Choose install location",
        "allowRead": "Allow MicroClaw to read all files in its installation folder",
        "startInstall": "Start Install",
        "back": "← Back",
        "viewLog": "View Log",
        "close": "Close",
        "installFailTitle": "Installation Failed",
        "installFailMsg": "Please check the logs and retry.",
        "carousel": [
            ["Intuitive", "No prompt engineering needed"],
            ["Trustworthy", "Block, edit, or undo anytime"],
            ["Personal", "Fits your workflow"],
        ],
    },
}


class WebInstallerBridge:
    def __init__(self, logger=None):
        self._config = DeployerConfig()
        self._logger = logger or DeployerLogger()
        self._lang = _detect_lang()
        self._state_lock = threading.Lock()
        self._default_install_dir = str(DEFAULT_DESKTOP_DIR)
        self._default_allow_read = True
        self._state = {
            "install_dir": self._default_install_dir,
            "allow_read": self._default_allow_read,
            "progress": 0,
            "progress_text": "",
            "status": "idle",
            "running": False,
            "error": "",
        }

    def attach_window(self, window):
        global _ACTIVE_WINDOW
        _ACTIVE_WINDOW = window

    def get_bootstrap(self):
        identities = [
            "archaeologist.png",
            "astronomer.png",
            "coder.png",
            "diviner.png",
            "geologist.png",
            "lawyer.png",
            "painter.png",
            "scientist.png",
            "singer.png",
        ]
        with self._state_lock:
            install_dir = self._state["install_dir"]
            allow_read = self._state["allow_read"]
        return {
            "strings": _STRINGS[self._lang],
            "assets": {
                "fold": "welcome-fold.png",
                "expand": "welcome-expand.png",
                "stock": "stock.png",
                "identities": list(identities),
            },
            "install_dir": install_dir,
            "allow_read": allow_read,
        }

    def write_html_file(self):
        """Read the HTML template from assets dir, inject bootstrap JSON, write alongside it."""
        assets_dir = _assets_dir()
        template = (assets_dir / "installer_template.html").read_text(encoding="utf-8")
        # ensure_ascii=True so every non-ASCII char becomes \\uXXXX — safe inside any JS context
        bootstrap_json = json.dumps(self.get_bootstrap(), ensure_ascii=True)
        html = template.replace("__BOOTSTRAP_JSON__", bootstrap_json)
        html_path = assets_dir / "_installer.html"
        html_path.write_text(html, encoding="utf-8")
        return html_path

    def get_state(self):
        with self._state_lock:
            return dict(self._state)

    def choose_install_dir(self):
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            selected = filedialog.askdirectory(
                title="Select install location",
                initialdir=self.get_state()["install_dir"],
                parent=root,
            )
        finally:
            root.destroy()
        if selected:
            with self._state_lock:
                self._state["install_dir"] = selected
        return selected or self.get_state()["install_dir"]

    def toggle_allow_read(self):
        with self._state_lock:
            self._state["allow_read"] = not self._state["allow_read"]
            return self._state["allow_read"]

    def quick_install(self):
        with self._state_lock:
            self._state["install_dir"] = self._default_install_dir
            self._state["allow_read"] = self._default_allow_read
        self._start_install()
        return True

    def start_custom_install(self, install_dir, allow_read):
        with self._state_lock:
            self._state["install_dir"] = str(install_dir).strip() or self._default_install_dir
            self._state["allow_read"] = bool(allow_read)
        self._start_install()
        return True

    def open_log(self):
        try:
            os.startfile(str(self._logger.log_file))
        except Exception:
            webbrowser.open(self._logger.log_file.as_uri())
        return True

    def close_window(self):
        with self._state_lock:
            if self._state["running"]:
                self._state["running"] = False
        if _ACTIVE_WINDOW is not None:
            _ACTIVE_WINDOW.destroy()
        return True

    # -- internal helpers --------------------------------------------------

    def _start_install(self):
        with self._state_lock:
            if self._state["running"]:
                return
            self._state.update(
                {
                    "progress": 0,
                    "status": "running",
                    "running": True,
                    "error": "",
                }
            )
        threading.Thread(target=self._install_thread, daemon=True).start()

    def _set_progress(self, pct, text):
        with self._state_lock:
            self._state["progress"] = pct
            self._state["progress_text"] = text
            self._state["status"] = "running"
            self._state["running"] = True

    def _install_thread(self):
        log = self._logger
        ws = WindowsSetup(self._config, log)

        steps = [
            (
                3,
                "Configuring PowerShell execution policy...",
                ws.ensure_execution_policy,
                LOCAL_RETRIES,
            ),
            # Apply Defender exclusions early so later IO-heavy steps aren't AV-scanned.
            (6, "Adding Defender exclusions...", ws.ensure_defender_exclusions, LOCAL_RETRIES),
            (10, "Installing Git...", ws.ensure_git, NETWORK_RETRIES),
            (25, "Installing Node.js...", lambda: self._ensure_node(ws), NETWORK_RETRIES),
            (35, "Configuring npm registry...", ws.setup_npm_mirror, NETWORK_RETRIES),
            (
                50,
                "Installing OpenClaw gateway...",
                lambda: self._ensure_openclaw(ws),
                NETWORK_RETRIES,
            ),
            (55, "Updating PATH...", ws.add_to_path, LOCAL_RETRIES),
            (60, "Installing desktop client...", ws.install_desktop_client, NETWORK_RETRIES),
            (62, "Copying bundled assets...", lambda: self._copy_bundled_assets(), LOCAL_RETRIES),
            (65, "Writing API keys...", lambda: self._write_env_file(), LOCAL_RETRIES),
            (70, "Writing OpenClaw configuration...", ws.write_config, LOCAL_RETRIES),
            (75, "Warming up V8 compile cache...", ws.warmup_compile_cache, LOCAL_RETRIES),
            (85, "Provisioning AppContainer sandbox...", ws.provision_appcontainer, LOCAL_RETRIES),
            (90, "Installing WeChat plugin...", ws.install_weixin_plugin, NETWORK_RETRIES),
            (95, "Creating desktop shortcut...", ws.create_desktop_shortcut, LOCAL_RETRIES),
        ]

        for pct, label, fn, retries in steps:
            if not self.get_state()["running"]:
                self._finish_fail("Installation cancelled.")
                return
            self._set_progress(pct, label)
            if not self._run_step_with_retry(pct, label, fn, retries):
                # _run_step_with_retry already reported the failure.
                return

        self._finish_ok()

    def _run_step_with_retry(self, pct, label, fn, retries):
        """Execute one install step, retrying transient failures.

        A step is considered failed if it raises or returns an explicit
        falsy value; steps that return ``None`` are treated as success
        (matching the original contract). On failure the step is retried up
        to ``retries`` additional times with a short, capped exponential
        backoff (1s, 2s, 4s, … max 8s), honouring cancellation between and
        during attempts. Returns ``True`` on success. On final failure it
        calls ``_finish_fail`` and returns ``False`` so the caller stops.

        Every install step is check-first / idempotent (e.g. Node and the
        OpenClaw gateway are re-checked before reinstalling), so re-running a
        partially-failed step is safe.
        """
        log = self._logger
        attempts = retries + 1
        detail = ""
        clean_label = label.rstrip(".")
        for attempt in range(1, attempts + 1):
            if not self.get_state()["running"]:
                self._finish_fail("Installation cancelled.")
                return False
            try:
                result = fn()
                if result is None or result:
                    if attempt > 1:
                        log.success(f"{clean_label} succeeded on attempt {attempt}/{attempts}.")
                    return True
                detail = "step reported failure"
            except Exception as exc:
                detail = str(exc) or exc.__class__.__name__
                log.error(f"{clean_label} attempt {attempt}/{attempts} raised: {exc}")

            if attempt < attempts:
                delay = min(2 ** (attempt - 1), 8)
                log.warn(
                    f"{clean_label} failed ({detail}); retrying in {delay}s "
                    f"(attempt {attempt + 1}/{attempts})…"
                )
                self._set_progress(pct, f"{label} retrying ({attempt + 1}/{attempts})…")
                # Cancellation-aware wait so a user can abort during backoff.
                for _ in range(delay):
                    if not self.get_state()["running"]:
                        self._finish_fail("Installation cancelled.")
                        return False
                    time.sleep(1)

        self._finish_fail(f"{clean_label} failed after {attempts} attempt(s).")
        return False

    def _ensure_node(self, ws):
        if ws.check_node_windows():
            return True
        return ws.install_node_windows()

    def _ensure_openclaw(self, ws):
        if ws.check_openclaw_windows():
            return True
        return ws.install_openclaw_windows()

    def _copy_bundled_assets(self):
        candidates = []
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS) / "setup-dependencies.ps1")
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys.executable).parent / "setup-dependencies.ps1")
        # Prefer canonical path; fall back to the root wrapper for older checkouts.
        candidates.append(
            Path(__file__).parent.parent / "scripts" / "windows" / "setup-dependencies.ps1"
        )
        candidates.append(Path(__file__).parent.parent / "setup-dependencies.ps1")

        src = next((c for c in candidates if c.exists()), None)
        dest_dir = DEFAULT_DESKTOP_DIR
        dest_dir.mkdir(parents=True, exist_ok=True)
        if src:
            try:
                shutil.copy2(str(src), str(dest_dir / "setup-dependencies.ps1"))
                self._logger.info(f"Setup script copied to {dest_dir} (for reference)")
            except Exception as exc:
                self._logger.warn(f"Could not copy setup script: {exc}")

        skills_candidates = []
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            skills_candidates.append(Path(sys._MEIPASS) / "skills")
        if getattr(sys, "frozen", False):
            skills_candidates.append(Path(sys.executable).parent / "skills")
        skills_candidates.append(Path(__file__).parent.parent / "skills")

        skills_src = next((c for c in skills_candidates if c.is_dir()), None)
        if skills_src:
            dest_skills = dest_dir / "skills"
            try:
                if dest_skills.exists():
                    shutil.rmtree(dest_skills)
                shutil.copytree(str(skills_src), str(dest_skills))
                self._logger.info(f"  Skills copied to {dest_skills}")
            except Exception as exc:
                self._logger.warn(f"  Could not copy skills: {exc}")
        return True

    def _write_env_file(self):
        api_key = self._config.get("model.api_key", "")
        base_url = self._config.get("model.base_url", "")
        model_name = self._config.get("model.model_name", "")
        brave_key = self._config.get("brave.api_key", "")
        if not api_key and not brave_key:
            self._logger.info("No API keys found in .env — skipping")
            return True

        openclaw_dir = Path.home() / ".openclaw"
        openclaw_dir.mkdir(parents=True, exist_ok=True)
        env_path = openclaw_dir / ".env"
        existing = {}
        if env_path.exists():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    key, _, value = line.partition("=")
                    if key.strip():
                        existing[key.strip()] = value.strip()
            except Exception:
                pass

        if api_key:
            existing["MODEL_API_KEY"] = api_key
            existing["OPENCLAW_MODEL_API_KEY"] = api_key
        if base_url:
            existing["MODEL_BASE_URL"] = base_url
        if model_name:
            existing["MODEL_NAME"] = model_name
        if brave_key:
            existing["BRAVE_API_KEY"] = brave_key

        try:
            env_path.write_text(
                "\n".join(f"{k}={v}" for k, v in existing.items()) + "\n",
                encoding="utf-8",
            )
            self._logger.success(f"API keys written to {env_path}")
        except Exception as exc:
            self._logger.warn(f"Could not write .env: {exc}")
        return True

    def _finish_ok(self):
        with self._state_lock:
            self._state.update(
                {
                    "progress": 100,
                    "status": "success",
                    "running": False,
                    "error": "",
                }
            )
        try:
            self._launch_desktop()
        except Exception:
            pass

    def _finish_fail(self, msg):
        with self._state_lock:
            self._state.update(
                {
                    "status": "failed",
                    "running": False,
                    "error": msg,
                }
            )

    def _launch_desktop(self):
        # Try known desktop shortcut locations
        candidates = [
            Path.home() / "Desktop" / "MicroClawDesktop.lnk",
            Path(os.environ.get("USERPROFILE", "")) / "Desktop" / "MicroClawDesktop.lnk",
        ]
        # Also try the Windows shell folder path
        try:
            import ctypes.wintypes

            CSIDL_DESKTOP = 0
            buf = ctypes.create_unicode_buffer(260)
            ctypes.windll.shell32.SHGetFolderPathW(None, CSIDL_DESKTOP, None, 0, buf)
            if buf.value:
                candidates.insert(0, Path(buf.value) / "MicroClawDesktop.lnk")
        except Exception:
            pass

        for shortcut in candidates:
            if shortcut.exists():
                self._logger.info(f"Launching desktop shortcut: {shortcut}")
                os.startfile(str(shortcut))
                return

        # Fallback: try to launch the exe directly
        desktop_dir = Path.home() / ".microclaw"
        exe = desktop_dir / "MicroClawDesktop.exe"
        if exe.exists():
            self._logger.info(f"Launching exe directly: {exe}")
            os.startfile(str(exe))
        else:
            self._logger.warn(
                f"Could not find MicroClaw to launch. Checked: {[str(c) for c in candidates]}"
            )


def _strip_motw(root: Path, logger: DeployerLogger) -> int:
    """Remove NTFS Zone.Identifier ADS (Mark-of-the-Web) under ``root``.

    ZIP downloads taint every extracted file with Internet-zone MOTW, which
    makes .NET CAS reject managed DLLs like Python.Runtime.dll. Equivalent to
    PowerShell ``Unblock-File``.
    """
    if not root.is_dir():
        return 0
    stripped = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            os.remove(f"{path}:Zone.Identifier")
            stripped += 1
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.debug(f"Could not strip MOTW from {path}: {exc}")
    return stripped


def run_web_installer():
    logger = DeployerLogger()
    logger.step("Starting web installer")
    logger.debug(
        f"frozen={getattr(sys, 'frozen', False)} executable={sys.executable} cwd={Path.cwd()}"
    )

    # Strip MOTW from the bundle before importing clr — see _strip_motw.
    if getattr(sys, "frozen", False):
        try:
            stripped = _strip_motw(Path(sys.executable).parent, logger)
            if stripped:
                logger.debug(f"Stripped Mark-of-the-Web from {stripped} bundled file(s)")
        except Exception as exc:
            logger.warn(f"MOTW strip pass failed (continuing anyway): {exc}")

    runtime_candidates = []
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        runtime_candidates.append(Path(sys._MEIPASS) / "pythonnet" / "runtime")
    if getattr(sys, "frozen", False):
        runtime_candidates.append(
            Path(sys.executable).parent / "_internal" / "pythonnet" / "runtime"
        )
    try:
        import pythonnet

        runtime_candidates.append(Path(pythonnet.__file__).resolve().parent / "runtime")
    except Exception as exc:
        logger.warn(f"Could not resolve pythonnet package path before startup: {exc}")

    seen_runtime_dirs = set()
    for runtime_dir in runtime_candidates:
        runtime_dir = runtime_dir.resolve()
        if runtime_dir in seen_runtime_dirs:
            continue
        seen_runtime_dirs.add(runtime_dir)
        if runtime_dir.is_dir():
            files = ", ".join(sorted(p.name for p in runtime_dir.iterdir()))
            logger.debug(f"pythonnet runtime dir: {runtime_dir}")
            logger.debug(f"pythonnet runtime files: {files}")
            deps_path = runtime_dir / "Python.Runtime.deps.json"
            logger.debug(f"Python.Runtime.deps.json present={deps_path.exists()}")
            break
        else:
            logger.warn(f"pythonnet runtime dir missing: {runtime_dir}")

    # Do NOT set PYTHONNET_RUNTIME — it expects a name ("netfx"/"coreclr"/"mono"),
    # not a path. Let pythonnet auto-detect.

    for env_name in (
        "PYTHONNET_RUNTIME",
        "PYTHONNET_CORECLR_RUNTIME_CONFIG",
        "PYTHONNET_CORECLR_DOTNET_ROOT",
    ):
        logger.debug(f"{env_name}={os.environ.get(env_name, '')}")

    # Pre-check the CLR so missing .NET / VC++ surfaces as one clean error
    # before pywebview's WinForms backend lazily loads it.
    try:
        import clr  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "pythonnet/.NET Framework is not available on this machine. "
            "The web installer requires .NET Framework 4.x and the "
            "Visual C++ Redistributable. "
            f"Detail: {exc}"
        ) from exc

    try:
        import webview
    except ImportError as exc:
        logger.error(f"pywebview import failed: {exc}")
        logger.debug(traceback.format_exc())
        raise SystemExit(
            "pywebview is not installed. Run `pip install -r requirements.txt` first."
        ) from exc
    except Exception as exc:
        logger.error(f"webview import failed during CLR startup: {exc}")
        logger.debug(traceback.format_exc())
        raise

    bridge = WebInstallerBridge(logger=logger)
    html_path = bridge.write_html_file()
    icon_path = _assets_dir() / "microclaw.ico"
    logger.debug(f"installer html path: {html_path}")
    logger.debug(f"installer icon path: {icon_path}")
    try:
        x, y = _get_centered_window_position(INSTALLER_WINDOW_WIDTH, INSTALLER_WINDOW_HEIGHT)
        window = webview.create_window(
            "MicroClaw",
            url=html_path.as_uri(),
            js_api=bridge,
            width=INSTALLER_WINDOW_WIDTH,
            height=INSTALLER_WINDOW_HEIGHT,
            x=x,
            y=y,
            resizable=False,
            text_select=False,
            frameless=True,
            transparent=True,
        )
        bridge.attach_window(window)

        def _on_shown():
            """Applies a native rounded-corner clipping region to the window.
            This removes the default gray square background from the frameless window.
            """
            try:
                import ctypes
                import threading
                import time
                from ctypes import wintypes

                def _clip():
                    # Wait briefly to ensure the window has been fully created and rendered
                    time.sleep(0.1)

                    # Retrieve the native window handle (HWND)
                    hwnd = ctypes.windll.user32.FindWindowW(None, "MicroClaw")
                    if not hwnd:
                        return

                    # Get actual window dimensions
                    rect = wintypes.RECT()
                    ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                    w = rect.right - rect.left
                    h = rect.bottom - rect.top

                    _center_native_window(hwnd, logger)

                    # Calculate the DPI scale factor to adjust the corner radius
                    scale = 1.0
                    try:
                        dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
                        scale = dpi / 96.0
                    except Exception:
                        pass

                    # Apply a scalable 12px logical border radius (24px diameter)
                    r = int(24 * scale)
                    rgn = ctypes.windll.gdi32.CreateRoundRectRgn(0, 0, w + 1, h + 1, r, r)
                    ctypes.windll.user32.SetWindowRgn(hwnd, rgn, True)

                # Run clipping in a background thread to prevent blocking the UI
                threading.Thread(target=_clip, daemon=True).start()
            except Exception as e:
                logger.warn(f"Could not apply window region: {e}")

        window.events.shown += _on_shown

        icon_arg = str(icon_path) if icon_path.exists() else None
        webview.start(debug=False, icon=icon_arg)
    except Exception as exc:
        logger.error(f"web installer startup failed: {exc}")
        logger.debug(traceback.format_exc())
        raise
