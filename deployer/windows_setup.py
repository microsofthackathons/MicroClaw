"""Windows-native Node.js + OpenClaw installation.

Downloads Node.js from npmmirror (Chinese mirror), installs it,
configures npm to use the taobao registry, and installs openclaw.
"""

import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from deployer.logger import DeployerLogger
from deployer.openclaw_upgrade import (
    RECOVERABLE_PHASES,
    OpenClawInstallation,
    OpenClawUpgradeTransaction,
    UpgradeInProgressError,
    UpgradePhase,
    process_is_alive,
    process_started_at,
    prune_previous_committed_backups,
)
from deployer.openclaw_version import (
    NODE_FALLBACK_VERSION,
    OPENCLAW_TARGET_VERSION,
    is_supported_node_version,
)
from deployer.skill_catalog import export_catalog_json, export_managed_catalog_json

# ── Mirror URLs ──
# Mirror names — used as keys into MIRRORS and as the fallback when probing fails.
MIRROR_OFFICIAL = "official"
MIRROR_NPMMIRROR = "npmmirror"
MIRROR_TENCENT = "tencent"
MIRROR_HUAWEI = "huawei"
MIRROR_FALLBACK = MIRROR_NPMMIRROR
NPM_REGISTRY_HUAWEI = "https://repo.huaweicloud.com/repository/npm/"

MIRRORS = {
    MIRROR_OFFICIAL: {
        "node_download_base": "https://nodejs.org/dist",
        "git_mirror_base": "https://github.com/git-for-windows/git/releases/download",
        "npm_registry": "https://registry.npmjs.org",
    },
    MIRROR_NPMMIRROR: {
        "node_download_base": "https://registry.npmmirror.com/-/binary/node",
        "git_mirror_base": "https://registry.npmmirror.com/-/binary/git-for-windows",
        "npm_registry": "https://registry.npmmirror.com",
    },
    MIRROR_TENCENT: {
        "node_download_base": "https://mirrors.cloud.tencent.com/nodejs-release",
        "git_mirror_base": "https://registry.npmmirror.com/-/binary/git-for-windows",  # tencent has no Git mirror
        "npm_registry": "http://mirrors.cloud.tencent.com/npm/",
    },
    MIRROR_HUAWEI: {
        # Huawei Cloud mirrors nodejs.org/dist verbatim and stays reachable on
        # locked-down corporate networks that block the *.npmmirror.com CDN.
        "node_download_base": "https://repo.huaweicloud.com/nodejs",
        "git_mirror_base": "https://github.com/git-for-windows/git/releases/download",
        "npm_registry": NPM_REGISTRY_HUAWEI,
    },
}

# Order in which Node.js binary mirrors are tried when the selected one is
# unreachable. official + Huawei tend to work on corporate networks that block
# the npmmirror CDN, so they lead the fallback chain.
NODE_MIRROR_FALLBACK_ORDER = (
    MIRROR_OFFICIAL,
    MIRROR_HUAWEI,
    MIRROR_TENCENT,
    MIRROR_NPMMIRROR,
)

# Order in which Git-for-Windows mirrors are tried when the selected one is
# unreachable. The official GitHub releases host works on corp networks that
# block the npmmirror CDN, so it leads the fallback chain. (official + huawei
# share the GitHub base and collapse to one entry after de-duplication.)
GIT_MIRROR_FALLBACK_ORDER = (
    MIRROR_OFFICIAL,
    MIRROR_HUAWEI,
    MIRROR_NPMMIRROR,
    MIRROR_TENCENT,
)

# Default install location.
#
# The Node.js Windows MSI is authored as a per-machine installer (it does
# NOT support per-user installs — passing ``MSIINSTALLPERUSER=1`` fails with
# exit code 1603).  Its default ``INSTALLDIR`` is ``C:\Program Files\nodejs``
# and we mirror that here so the standard, Authenticode-trusted path is
# used.  Windows Defender does not flag binaries under Program Files the
# way it did with the previous zip-extract-to-dotfolder approach.
#
# Legacy zip-extract layouts under ~/.openclaw-node and the per-user
# ``%LocalAppData%\Programs\nodejs`` directory are still recognised at
# runtime for users upgrading from earlier builds (see check_node_windows /
# sandbox-state.js).
_PROGRAM_FILES = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
_LOCAL_APPDATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
DEFAULT_NODE_DIR = Path(
    os.environ.get(
        "OPENCLAW_NODE_DIR",
        str(_PROGRAM_FILES / "nodejs"),
    )
)
LEGACY_NODE_DIRS = (
    Path.home() / ".openclaw-node",
    _LOCAL_APPDATA / "Programs" / "nodejs",
)
# Standard, Authenticode-trusted locations the system Node.js MSI installs
# to.  We accept a system Node at any of these paths without forcing a
# reinstall, as long as the version satisfies our minimum.
_STANDARD_NODE_DIRS = (
    _PROGRAM_FILES / "nodejs",
    _LOCAL_APPDATA / "Programs" / "nodejs",
)

DEFAULT_DESKTOP_DIR = Path(
    os.environ.get(
        "MICROCLAW_DIR",
        str(Path.home() / ".microclaw"),
    )
)

# Strict pattern for version strings interpolated into URLs/commands
_VERSION_RE = re.compile(r"^\d+(\.\d+){0,2}$")

# Hide console windows spawned by subprocess on Windows
_CREATE_NO_WINDOW = 0x08000000

# Per-call timeout (seconds) for `openclaw gateway call ...` RPC probes run
# during post-install validation. Each probe cold-starts the OpenClaw CLI, and
# on freshly-provisioned machines (empty V8 compile cache + antivirus scanning
# newly-written files) that start alone can take 30-60s, so this must be well
# above the CLI boot time to avoid spurious validation failures.
_OPENCLAW_RPC_TIMEOUT = 120


@dataclass(frozen=True)
class OpenClawInstallAttempt:
    returncode: int
    output: str
    installed_version: str | None


@dataclass(frozen=True)
class ActiveGateway:
    pid: int | None
    port: int
    lock_path: Path | None


@dataclass(frozen=True)
class ActiveInstallation:
    pids: tuple[int, ...]
    gateway: ActiveGateway | None


@dataclass(frozen=True)
class _ProcessInfo:
    parent_pid: int
    name: str
    command_line: str


class NodeInstallBlocked(RuntimeError):
    """Node.js MSI failed for a deterministic reason that a retry cannot fix.

    Raised when msiexec aborts on a launch condition (e.g. a *later* version
    of Node.js is already installed, so the MSI refuses to downgrade). Retrying
    only re-triggers the UAC prompt and fails again, so the install pipeline
    treats this as fatal instead of retrying.
    """


class WindowsSetup:
    """Handles Node.js + OpenClaw installation on Windows natively."""

    def __init__(self, config, logger: DeployerLogger):
        self.cfg = config
        self.log = logger
        self.node_version = config.get("node.version", "22")
        # Re-read env var at construction time (UI may have set it)
        self.node_dir = Path(os.environ.get("OPENCLAW_NODE_DIR", str(DEFAULT_NODE_DIR)))
        self._node_bin: Path | None = None
        self._git_bin: str | None = None  # path to git bin directory
        self._rollback_actions: list[tuple[str, Callable]] = []
        self._openclaw_transaction: OpenClawUpgradeTransaction | None = None
        # Optional UI hook forwarded to upgrade transactions so long backup /
        # restore file operations can report progress instead of looking frozen.
        self.progress_callback: Callable[[str], None] | None = None
        self.appcontainer_enabled = True  # AppContainer sandbox (built-in)
        self.weixin_plugin_enabled = True  # Install by default

        # Select mirror: respect explicit user override (npm.registry config)
        # if set; otherwise probe all candidates in parallel and pick the
        # one with the lowest latency. The probe is silent — users on a
        # slow link just see one extra "Selecting fastest mirror…" line.
        registry = config.get("npm.registry", "")
        if registry:
            mirror_name = self._match_mirror_by_registry(registry)
        else:
            mirror_name = self._probe_fastest_mirror()
        mirror = MIRRORS[mirror_name]
        self._node_download_base = mirror["node_download_base"]
        self._git_mirror_base = mirror["git_mirror_base"]
        self._mirror_name = mirror_name
        # Persist the resolved registry on the config object so setup_npm_mirror
        # picks it up without needing to re-probe.
        if not registry:
            try:
                config.set("npm.registry", mirror["npm_registry"])
            except Exception:
                # config may not support .set(); fall back to internal attr
                self._resolved_npm_registry = mirror["npm_registry"]

    # ────────────────────── Subprocess helper ──────────────────────

    @staticmethod
    def _run(cmd, **kwargs):
        """Wrapper around subprocess.run that hides console windows on Windows."""
        kwargs.setdefault("creationflags", _CREATE_NO_WINDOW)
        return subprocess.run(cmd, **kwargs)

    # ────────────────────── Mirror selection ──────────────────────

    @staticmethod
    def _match_mirror_by_registry(registry: str) -> str:
        """Map a user-provided npm registry URL back to a known mirror name.

        Falls back to ``npmmirror`` for unrecognised URLs so that Node.js
        binary downloads still go through a working CDN even when the user
        only customised the npm registry.
        """
        url = registry.lower()
        if "npmjs.org" in url:
            return MIRROR_OFFICIAL
        if "tencent" in url:
            return MIRROR_TENCENT
        if "npmmirror" in url or "taobao" in url:
            return MIRROR_NPMMIRROR
        return MIRROR_FALLBACK

    def _probe_fastest_mirror(self, timeout: float = 2.5) -> str:
        """Pick the lowest-latency npm registry from MIRRORS.

        Probes every candidate's ``/-/ping`` endpoint in parallel and
        returns the mirror name (key of ``MIRRORS``) with the smallest
        round-trip time. Failures (timeout, DNS, HTTP error) score as
        infinity so they lose to any successful probe.

        The probe is bounded by ``timeout`` per mirror; total wall time is
        roughly ``timeout`` because all candidates run concurrently.
        """
        import concurrent.futures as _cf

        self.log.step("Selecting fastest download mirror…")

        def _measure(name: str, base: str) -> tuple[str, float]:
            # /-/ping is supported by registry.npmjs.org and npmmirror;
            # tencent/cnpmcore returns 404 on it but still resolves the
            # TCP+TLS handshake, which is what we actually want to time.
            url = base.rstrip("/") + "/-/ping"
            req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
            start = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    resp.read(64)
                return name, time.monotonic() - start
            except urllib.error.HTTPError:
                # 404 / 403 still means the host is reachable.
                return name, time.monotonic() - start
            except Exception:
                return name, float("inf")

        candidates = [(name, m["npm_registry"]) for name, m in MIRRORS.items()]
        results: list[tuple[str, float]] = []
        try:
            with _cf.ThreadPoolExecutor(max_workers=len(candidates)) as pool:
                futures = [pool.submit(_measure, n, b) for n, b in candidates]
                for f in _cf.as_completed(futures, timeout=timeout + 1.0):
                    results.append(f.result())
        except Exception as e:
            self.log.debug(f"Mirror probe failed: {e}")

        if not results:
            self.log.warn(f"Mirror probe produced no results; using {MIRROR_FALLBACK}")
            return MIRROR_FALLBACK

        results.sort(key=lambda x: x[1])
        for name, latency in results:
            human = "timeout" if latency == float("inf") else f"{int(latency * 1000)} ms"
            self.log.debug(f"  mirror {name}: {human}")

        best_name, best_latency = results[0]
        if best_latency == float("inf"):
            self.log.warn(f"All mirrors unreachable; falling back to {MIRROR_FALLBACK}")
            return MIRROR_FALLBACK

        self.log.info(f"Fastest mirror: {best_name} ({int(best_latency * 1000)} ms)")
        return best_name

    # ────────────────────── Rollback ──────────────────────

    def _register_rollback(self, label: str, fn):
        """Push a cleanup action onto the rollback stack."""
        self._rollback_actions.append((label, fn))

    def rollback(self):
        """Execute all registered rollback actions in reverse order."""
        if not self._rollback_actions:
            return
        self.log.step("正在清理已安装的组件…")
        for label, fn in reversed(self._rollback_actions):
            try:
                self.log.info(f"  回滚: {label}")
                fn()
            except Exception as e:
                self.log.warn(f"  回滚 '{label}' 失败: {e}")
        self._rollback_actions.clear()
        self.log.info("清理完成")

    # ────────────────────── Git ──────────────────────

    def ensure_git(self) -> bool:
        """Install Git if not already available."""
        git_path = shutil.which("git")
        if git_path:
            self._git_bin = str(Path(git_path).parent)
            self.log.info("git already in PATH")
            return True

        self.log.step(f"Installing Git for Windows ({self._mirror_name})…")
        arch = self._get_arch()
        # Resolve latest Git version from npmmirror
        git_version = self._resolve_git_version()
        if not git_version:
            self.log.error("Could not resolve Git version")
            return False

        # Git for Windows release naming (verified against actual releases):
        #   x64:   PortableGit-{ver}-64-bit.7z.exe   (self-extracting)
        #   arm64: PortableGit-{ver}-arm64.7z.exe     (self-extracting)
        #   x86:   MinGit-{ver}-32-bit.zip            (zip — no 32-bit PortableGit since ~v2.50)
        use_mingit_zip = arch == "x86"
        if arch == "arm64":
            filename = f"PortableGit-{git_version}-arm64.7z.exe"
        elif arch == "x86":
            filename = f"MinGit-{git_version}-32-bit.zip"
        else:
            filename = f"PortableGit-{git_version}-64-bit.7z.exe"
        git_dir = Path.home() / ".openclaw-git"
        try:
            tmp_dir = Path(tempfile.mkdtemp(prefix="openclaw_git_"))
            dl_path = tmp_dir / filename

            if not self._download_git_installer(git_version, filename, dl_path):
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return False

            self.log.step("Extracting Git…")
            git_dir.mkdir(parents=True, exist_ok=True)

            if use_mingit_zip:
                # MinGit is a plain zip — extract directly
                with zipfile.ZipFile(dl_path, "r") as zf:
                    zf.extractall(git_dir)
            else:
                # PortableGit self-extracts with -o flag
                self._run(
                    [str(dl_path), "-o" + str(git_dir), "-y"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )

            shutil.rmtree(tmp_dir, ignore_errors=True)

            git_exe = git_dir / "bin" / "git.exe"
            if not git_exe.exists():
                # Some versions use cmd/git.exe
                git_exe = git_dir / "cmd" / "git.exe"

            if git_exe.exists():
                # Add to current process PATH
                git_bin = str(git_exe.parent)
                self._git_bin = git_bin
                os.environ["PATH"] = git_bin + os.pathsep + os.environ.get("PATH", "")
                # Add to system PATH permanently
                self._add_to_system_path(git_bin)
                self.log.success(f"Git installed to {git_dir}")

                # Register rollback
                def _rollback_git(d=str(git_dir), b=git_bin):
                    shutil.rmtree(d, ignore_errors=True)
                    self._remove_from_system_path(b)

                self._register_rollback("删除 Git", _rollback_git)
                return True

            self.log.error("Git extraction failed — git.exe not found")
            return False
        except Exception as e:
            self.log.error(f"Git install failed: {e}")
            return False

    def _git_download_bases(self) -> list[tuple[str, str]]:
        """Ordered, de-duplicated list of ``(mirror_name, git_mirror_base)``.

        The selected mirror is tried first, followed by ``GIT_MIRROR_FALLBACK_ORDER``
        so a single blocked CDN (e.g. a corporate ``NPM URL Block`` on npmmirror)
        no longer dead-ends the Git download.
        """
        ordered_names = [self._mirror_name, *GIT_MIRROR_FALLBACK_ORDER]
        bases: list[tuple[str, str]] = []
        seen: set[str] = set()
        for name in ordered_names:
            mirror = MIRRORS.get(name)
            if mirror is None:
                continue
            base = mirror["git_mirror_base"]
            if base not in seen:
                seen.add(base)
                bases.append((name, base))
        return bases

    def _download_git_installer(self, git_version: str, filename: str, dl_path: Path) -> bool:
        """Download the Git-for-Windows installer, falling through mirrors.

        A single mirror can be unreachable on a given network (corporate
        policies often block the npmmirror CDN with an SSL handshake failure),
        so we try each mirror in turn instead of failing on the first blocked
        host.
        """
        bases = self._git_download_bases()
        last_error = "no mirrors configured"
        for index, (name, base) in enumerate(bases, start=1):
            url = f"{base}/v{git_version}.windows.1/{filename}"
            self.log.info(f"Downloading Git from {name} ({index}/{len(bases)}): {url}")
            try:
                self._download_with_progress(url, dl_path)
            except Exception as error:
                last_error = str(error) or error.__class__.__name__
                self.log.warn(f"Git download from {name} failed ({last_error}); trying next mirror")
                dl_path.unlink(missing_ok=True)
                continue
            return True
        self.log.error(f"Could not download Git from any mirror. Last error: {last_error}")
        return False

    def _resolve_git_version(self) -> str | None:
        """Resolve latest Git for Windows version from GitHub."""
        import json

        try:
            url = "https://api.github.com/repos/git-for-windows/git/releases/latest"
            req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            tag = data.get("tag_name", "")  # e.g. "v2.47.1.windows.1"
            ver = tag.lstrip("v").split(".windows")[0]  # "2.47.1"
            return ver
        except Exception:
            pass
        # Fallback: hardcoded recent version
        return "2.53.0"

    def _add_to_system_path(self, directory: str):
        """Add a directory to system PATH via registry (persistent)."""
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                0,
                winreg.KEY_ALL_ACCESS,
            )
            current, _ = winreg.QueryValueEx(key, "Path")
            if directory.lower() not in current.lower():
                new_path = current.rstrip(";") + ";" + directory
                winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, new_path)
                self.log.info(f"  Added to system PATH: {directory}")
            winreg.CloseKey(key)
        except Exception as e:
            self.log.warn(f"  Could not update system PATH: {e}")

    def _remove_from_system_path(self, directory: str):
        """Remove a directory from both system and user PATH via registry.

        For system PATH, tries direct registry access first; if that fails
        (no admin), elevates via UAC to run a PowerShell snippet.
        For user PATH, no elevation is needed.
        """
        import winreg

        # ── User PATH (no elevation needed) ──
        try:
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Environment",
                0,
                winreg.KEY_READ | winreg.KEY_WRITE,
            )
            current, _ = winreg.QueryValueEx(key, "Path")
            parts = [p for p in current.split(";") if p.strip().lower() != directory.lower()]
            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(parts))
            winreg.CloseKey(key)
        except Exception:
            pass

        # ── System PATH (requires admin) ──
        try:
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                0,
                winreg.KEY_ALL_ACCESS,
            )
            current, _ = winreg.QueryValueEx(key, "Path")
            parts = [p for p in current.split(";") if p.strip().lower() != directory.lower()]
            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(parts))
            winreg.CloseKey(key)
        except PermissionError:
            # Elevate via UAC
            self._remove_from_system_path_elevated(directory)
        except Exception:
            pass

    def _remove_from_system_path_elevated(self, directory: str):
        """Remove a directory from system PATH via an elevated PowerShell script."""
        # Escape for PowerShell — use single quotes around the directory
        safe_dir = directory.replace("'", "''")
        ps_script = (
            f"$regPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';"
            f"$cur = (Get-ItemProperty -Path $regPath -Name Path).Path;"
            f"$parts = $cur -split ';' | Where-Object {{ $_.Trim().ToLower() -ne '{safe_dir.lower()}' }};"
            f"Set-ItemProperty -Path $regPath -Name Path -Value ($parts -join ';');"
        )
        try:
            self._run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden "
                    f"-ArgumentList '-NoProfile','-Command','{ps_script}'",
                ],
                capture_output=True,
                timeout=30,
            )
        except Exception:
            pass

    def _prepend_before_system_nodejs(self, directory: str):
        """Insert *directory* before any ``…\\nodejs\\`` entry in the system PATH.

        On Windows the effective PATH = system PATH + user PATH, so a
        ``C:\\Program Files\\nodejs\\`` entry in the system PATH always
        shadows anything the user PATH provides.  This method ensures our
        managed node directory is evaluated first.
        """
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                0,
                winreg.KEY_ALL_ACCESS,
            )
            current, _ = winreg.QueryValueEx(key, "Path")
            parts = [p for p in current.split(";") if p]
            dir_lower = directory.lower()

            # Already present – nothing to do
            if dir_lower in (p.lower() for p in parts):
                winreg.CloseKey(key)
                return

            # Find the first …\nodejs\ entry and insert before it
            insert_idx = None
            for idx, p in enumerate(parts):
                if "nodejs" in p.lower():
                    insert_idx = idx
                    break

            if insert_idx is not None:
                parts.insert(insert_idx, directory)
            else:
                # No nodejs in system PATH – just prepend
                parts.insert(0, directory)

            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(parts))
            winreg.CloseKey(key)
            self.log.info(f"  Inserted {directory} before system nodejs in machine PATH")
        except PermissionError:
            # Elevate via UAC to update system PATH
            self._prepend_before_system_nodejs_elevated(directory)
        except Exception as e:
            self.log.warn(f"  Could not update system PATH: {e}")

    # ────────────────────── Node.js ──────────────────────

    def _prepend_before_system_nodejs_elevated(self, directory: str):
        """Insert directory before nodejs in system PATH via an elevated PowerShell script."""
        safe_dir = directory.replace("'", "''")
        ps_script = (
            f"$regPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';"
            f"$cur = (Get-ItemProperty -Path $regPath -Name Path).Path;"
            f"$parts = $cur -split ';' | Where-Object {{ $_ }};"
            f"$dirLower = '{safe_dir.lower()}';"
            f"if ($parts.ToLower() -contains $dirLower) {{ exit 0 }};"
            f"$idx = -1; for ($i=0; $i -lt $parts.Count; $i++) {{ if ($parts[$i] -match 'nodejs') {{ $idx = $i; break }} }};"
            f"if ($idx -ge 0) {{ $parts = $parts[0..($idx-1)] + '{safe_dir}' + $parts[$idx..($parts.Count-1)] }}"
            f"else {{ $parts = @('{safe_dir}') + $parts }};"
            f"Set-ItemProperty -Path $regPath -Name Path -Value ($parts -join ';');"
        )
        try:
            self._run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden "
                    f"-ArgumentList '-NoProfile','-Command','{ps_script}'",
                ],
                capture_output=True,
                timeout=30,
            )
            self.log.info(f"  Inserted {directory} before system nodejs in machine PATH (elevated)")
        except Exception as e:
            self.log.warn(f"  Could not update system PATH (elevated): {e}")

    def _get_arch(self) -> str:
        """Return 'x64', 'x86', or 'arm64' based on platform."""
        machine = platform.machine().lower()
        if machine in ("amd64", "x86_64", "x64"):
            return "x64"
        if machine in ("arm64", "aarch64"):
            return "arm64"
        if machine in ("x86", "i386", "i686"):
            return "x86"
        return "x64"

    def _get_node_download_url(self, version: str) -> str:
        """Build the download URL for the official signed Node.js Windows MSI.

        Both nodejs.org and npmmirror host the Authenticode-signed installer
        at ``v{version}/node-v{version}-{arch}.msi`` (note: no ``-win-`` infix
        in the MSI naming, unlike the zip).
        """
        arch = self._get_arch()
        return f"{self._node_download_base}/v{version}/node-v{version}-{arch}.msi"

    def _node_download_bases(self) -> list[tuple[str, str]]:
        """Ordered, de-duplicated list of ``(mirror_name, node_download_base)``.

        The selected mirror is tried first, followed by ``NODE_MIRROR_FALLBACK_ORDER``
        so a single blocked CDN (e.g. a corporate ``NPM URL Block`` on
        npmmirror) no longer dead-ends the Node.js download.
        """
        ordered_names = [self._mirror_name, *NODE_MIRROR_FALLBACK_ORDER]
        bases: list[tuple[str, str]] = []
        seen: set[str] = set()
        for name in ordered_names:
            mirror = MIRRORS.get(name)
            if mirror is None:
                continue
            base = mirror["node_download_base"]
            if base not in seen:
                seen.add(base)
                bases.append((name, base))
        return bases

    def _download_and_verify_node_msi(self, version: str, msi_path: Path) -> bool:
        """Download the Node.js MSI, falling through mirrors until one works.

        A single mirror can be unreachable on a given network (corporate
        policies often block the npmmirror CDN with an SSL handshake failure),
        so we try each mirror in turn instead of failing on the first blocked
        host. Every candidate download is SHA256-verified against the official
        checksums before it is accepted (fail-closed).
        """
        bases = self._node_download_bases()
        last_error = "no mirrors configured"
        for index, (name, base) in enumerate(bases, start=1):
            self._node_download_base = base
            url = self._get_node_download_url(version)
            self.log.info(f"Downloading Node.js from {name} ({index}/{len(bases)}): {url}")
            try:
                self._download_with_progress(url, msi_path)
            except Exception as error:
                last_error = str(error) or error.__class__.__name__
                self.log.warn(
                    f"Node.js download from {name} failed ({last_error}); trying next mirror"
                )
                msi_path.unlink(missing_ok=True)
                continue
            if not self._verify_node_sha256(version, msi_path):
                last_error = "SHA256 verification failed"
                self.log.warn(f"Node.js MSI from {name} failed verification; trying next mirror")
                msi_path.unlink(missing_ok=True)
                continue
            return True
        self.log.error(
            f"Could not download a verified Node.js MSI from any mirror. Last error: {last_error}"
        )
        return False

    def _resolve_latest_version(self, major: str) -> str:
        """Resolve '22' to the latest specific version like '22.14.0'."""
        self.log.debug(f"Resolving latest Node.js {major}.x version…")
        import json
        import re

        # Method 1: Use a nodejs.org-compatible version index (most reliable).
        # Try the official host first, then Huawei's verbatim mirror so version
        # resolution still works on networks that block nodejs.org.
        for url in (
            "https://nodejs.org/dist/index.json",
            "https://repo.huaweicloud.com/nodejs/index.json",
        ):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
                resp = urllib.request.urlopen(req, timeout=15)
                with resp:
                    data = json.loads(resp.read())
                for entry in data:
                    ver = entry.get("version", "").lstrip("v")
                    if ver.startswith(f"{major}."):
                        self.log.debug(f"Resolved from {url}: {ver}")
                        return ver
            except Exception as e:
                self.log.debug(f"version index {url} resolve failed: {e}")

        # Method 2: Scrape npmmirror directory listing
        try:
            url = f"{self._node_download_base}/latest-v{major}.x/"
            req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            arch = self._get_arch()
            pattern = rf"node-v({major}\.\d+\.\d+)-win-{arch}\.zip"
            matches = re.findall(pattern, html)
            if matches:
                best = max(matches, key=lambda v: tuple(int(x) for x in v.split(".")))
                self.log.debug(f"Resolved from npmmirror: {best}")
                return best
        except Exception as e:
            self.log.debug(f"npmmirror resolve failed: {e}")

        # Fallback — use the pinned supported Node.js release.
        fallback = NODE_FALLBACK_VERSION
        self.log.warn(f"Could not resolve version, using fallback: {fallback}")
        return fallback

    def check_node_windows(self) -> bool:
        """Check if a suitable Node.js is available on Windows.

        Only the managed install (inside node_dir) counts as a pass.
        A system-level node is logged for diagnostics but never accepted,
        because its version/PATH-priority is outside our control.
        """
        # Check our managed install first — only this is authoritative
        managed_node = self.node_dir / "node.exe"
        if managed_node.exists():
            ver = self._get_node_version(str(managed_node))
            if ver and is_supported_node_version(ver):
                self.log.info(f"Node.js (managed) found: {ver}")
                self._node_bin = managed_node.parent
                # Verify npm is also available — a partial install (e.g. after
                # uninstall + reinstall with AV interference) may leave node.exe
                # but no npm.  _get_npm_path will auto-regenerate the shim if
                # the npm module exists but npm.cmd is missing.
                if not self._get_npm_path():
                    self.log.warn("Node.js found but npm is missing — will reinstall")
                    return False
                return True
            elif ver:
                self.log.info(
                    "Managed Node.js "
                    f"{ver} is outdated (need >=22.22.3, <23 / >=24.15.0, <25 / >=25.9.0), "
                    "will reinstall"
                )

        # Log system node for diagnostics. Accept it when it lives at a
        # standard, Authenticode-trusted location (Program Files or the
        # per-user MSI path) and satisfies our minimum version — reinstalling
        # over a healthy system Node only causes Defender scoring noise and
        # version churn.
        node_path = shutil.which("node")
        if node_path:
            ver = self._get_node_version(node_path)
            if ver:
                resolved = Path(node_path).resolve()
                parent = resolved.parent
                is_standard = any(
                    parent == std.resolve() if std.exists() else parent == std
                    for std in _STANDARD_NODE_DIRS
                )
                if is_standard and is_supported_node_version(ver):
                    self.log.info(f"Node.js (system) accepted: {ver} at {node_path}")
                    # Pin the discovered directory so all later logic
                    # (AppContainer ACLs, PATH, npm prefix) targets the
                    # actual install location rather than the configured
                    # default.
                    self.node_dir = parent
                    self._node_bin = parent
                    if not self._get_npm_path():
                        self.log.warn(
                            "System Node.js found but npm is missing — will install managed copy"
                        )
                        return False
                    return True
                self.log.info(
                    f"Node.js (system) found: {ver} at {node_path} (will install managed copy)"
                )

        return False

    def _installed_node_major(self) -> int | None:
        """Highest major version of any Node.js already installed on the box.

        The Node.js MSI is authored as per-machine and enforces a launch
        condition that refuses to install an *older* product version over a
        newer one (``A later version of Node.js is already installed`` ->
        exit 1603). So we must never target a major below what is already
        present. We inspect both the PATH ``node`` and the standard MSI
        install directories.
        """
        candidates: list[str] = []
        on_path = shutil.which("node")
        if on_path:
            candidates.append(on_path)
        for std in _STANDARD_NODE_DIRS:
            exe = std / "node.exe"
            if exe.exists():
                candidates.append(str(exe))

        majors: list[int] = []
        for exe in candidates:
            ver = self._get_node_version(exe)
            if ver:
                match = re.match(r"v?(\d+)\.", ver)
                if match:
                    majors.append(int(match.group(1)))
        return max(majors) if majors else None

    def _resolve_target_node_version(self) -> str:
        """Resolve the Node.js version to install, never downgrading.

        Starts from the configured target line (``self.node_version``, default
        ``22``) but bumps up to the major of any already-installed Node when
        that is higher, so the per-machine MSI performs an upgrade rather than
        a blocked downgrade.
        """
        target_line = str(self.node_version)
        match = re.match(r"(\d+)", target_line)
        target_major = int(match.group(1)) if match else 0

        installed_major = self._installed_node_major()
        if installed_major is not None and installed_major > target_major:
            self.log.info(
                f"Node.js v{installed_major}.x is already installed; targeting the "
                f"{installed_major}.x line instead of {target_major}.x — the MSI refuses "
                "to install an older version over a newer one."
            )
            target_line = str(installed_major)

        return self._resolve_latest_version(target_line)

    def install_node_windows(self) -> bool:
        """Download and install Node.js on Windows via the official signed MSI.

        Uses ``msiexec`` to install the Authenticode-signed Node.js MSI to a
        per-user, standard path (``%LocalAppData%\\Programs\\nodejs\\`` by
        default).  This avoids triggering Windows Defender's behavior-based
        detections that the previous zip-extract-to-dotfolder approach
        produced on some configurations.
        """
        self.log.step(f"Installing Node.js on Windows ({self._mirror_name})…")

        version = self._resolve_target_node_version()
        if not _VERSION_RE.match(version):
            self.log.error(f"Invalid resolved version: {version!r}")
            return False
        self.log.info(f"Resolved version: v{version}")

        tmp_dir: Path | None = None
        try:
            tmp_dir = Path(tempfile.mkdtemp(prefix="openclaw_node_"))
            msi_path = tmp_dir / f"node-v{version}-{self._get_arch()}.msi"

            # Download from the first reachable mirror; each candidate is
            # SHA256-verified before we accept it.
            if not self._download_and_verify_node_msi(version, msi_path):
                return False

            # Install via msiexec to the standard per-machine location
            # (C:\Program Files\nodejs by default).  The Node.js MSI is
            # authored as per-machine only — passing MSIINSTALLPERUSER=1
            # fails with exit code 1603.  We elevate via UAC so unprivileged
            # users still get a non-interactive install.
            self.log.step("Installing Node.js (msiexec)…")
            install_dir = str(self.node_dir).rstrip("\\")
            log_path = tmp_dir / "msi-install.log"
            msi_args = (
                f'/i "{msi_path}" /qn /norestart '
                f'INSTALLDIR="{install_dir}\\" '
                f"ADDLOCAL=NodeRuntime,npm "
                f'/L*V "{log_path}"'
            )
            # Use PowerShell Start-Process -Verb RunAs to elevate.  -Wait
            # blocks until msiexec exits and -PassThru lets us read the
            # exit code; -WindowStyle Hidden keeps the UAC-spawned console
            # off-screen.
            ps_cmd = (
                "$ErrorActionPreference = 'Stop'; "
                "try { "
                "$p = Start-Process -FilePath msiexec.exe "
                f"-ArgumentList '{msi_args}' "
                "-Verb RunAs -Wait -PassThru -WindowStyle Hidden; "
                "if ($null -eq $p) { throw 'Failed to start elevated msiexec process.' }; "
                "exit [int]$p.ExitCode "
                "} catch { "
                "[Console]::Error.WriteLine($_.Exception.Message); "
                "exit 1 "
                "}"
            )
            try:
                result = self._run(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        ps_cmd,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
            except subprocess.TimeoutExpired:
                self.log.error("msiexec timed out after 10 minutes")
                return False

            # msiexec exit codes: 0 = success, 3010 = success + reboot required
            if result.returncode not in (0, 3010):
                process_error = (result.stderr or result.stdout or "").strip()
                if process_error:
                    self.log.error(f"Could not start elevated Node.js installer: {process_error}")
                if not log_path.exists():
                    self.log.error(
                        "Node.js installer did not start. Approve the Windows UAC prompt and retry."
                    )
                self.log.error(f"msiexec exited with code {result.returncode}; see log: {log_path}")
                # Surface a short tail of the log to help diagnose.
                msi_log = ""
                try:
                    msi_log = log_path.read_text(encoding="utf-16-le", errors="replace")
                    for line in msi_log.splitlines()[-20:]:
                        self.log.debug(f"  msi: {line}")
                except Exception:
                    pass
                # A launch-condition failure (e.g. a newer Node is already
                # installed and the MSI refuses to downgrade) is deterministic —
                # retrying only re-prompts UAC and fails again, so bail out.
                if "later version" in msi_log.lower() or "LaunchConditions" in msi_log:
                    raise NodeInstallBlocked(
                        "A newer version of Node.js is already installed and the installer "
                        "cannot replace it. Uninstall the existing Node.js (or install a "
                        "matching/newer version) and run MicroClaw again."
                    )
                return False

            node_exe = self.node_dir / "node.exe"
            if not node_exe.exists():
                self.log.error(f"MSI install reported success but node.exe missing at {node_exe}")
                return False

            self._node_bin = self.node_dir

            ver = self._get_node_version(str(node_exe))
            if not ver:
                self.log.error("Node.js installed but verification failed")
                return False

            self.log.success(f"Node.js {ver} installed to {self.node_dir}")

            # Record that MicroClaw owns this Node install so the uninstaller
            # knows it's safe to remove.  Without this marker, uninstall
            # preserves any Node.js it finds (assumes user-installed).
            self._mark_node_owned_by_microclaw(self.node_dir)

            # Register rollback: msiexec /x by MSI file, elevated.
            def _rollback_node(msi=str(msi_path), d=str(self.node_dir)):
                try:
                    ps = (
                        f"$p = Start-Process -FilePath msiexec.exe "
                        f"-ArgumentList '/x \"{msi}\" /qn /norestart' "
                        f"-Verb RunAs -Wait -PassThru -WindowStyle Hidden; "
                        f"exit $p.ExitCode"
                    )
                    self._run(
                        [
                            "powershell.exe",
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            ps,
                        ],
                        capture_output=True,
                        timeout=300,
                    )
                except Exception:
                    pass
                # Best-effort: remove any residual files
                shutil.rmtree(d, ignore_errors=True)

            self._register_rollback("删除 Node.js", _rollback_node)
            return True

        except NodeInstallBlocked:
            # Deterministic, non-retryable — propagate so the pipeline stops
            # instead of re-prompting UAC on every retry.
            raise
        except Exception as e:
            self.log.error(f"Node.js install failed: {e}")
            return False
        finally:
            # Keep the MSI around if install failed so the rollback can use
            # it; otherwise drop the temp dir.
            if tmp_dir and self._node_bin is not None:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    def _download_with_progress(self, url: str, dest: Path):
        """Download a URL with progress logging."""
        req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            total_mb = total / (1024 * 1024) if total else 0
            downloaded = 0
            last_pct = -1

            with open(dest, "wb") as f:
                while True:
                    chunk = resp.read(256 * 1024)  # 256KB chunks
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = int(downloaded * 100 / total)
                        if pct >= last_pct + 10:
                            self.log.info(
                                f"  Downloading… {downloaded // (1024 * 1024):.0f}"
                                f" / {total_mb:.0f} MB ({pct}%)"
                            )
                            last_pct = pct

        self.log.info(f"  Download complete: {downloaded // (1024 * 1024):.0f} MB")

    def _verify_node_sha256(self, version: str, installer_path: Path) -> bool:
        """Verify the downloaded Node.js MSI against official SHASUMS256.txt."""

        arch = self._get_arch()
        filename = f"node-v{version}-{arch}.msi"

        # Compute local hash
        sha = hashlib.sha256()
        with open(installer_path, "rb") as f:
            for chunk in iter(lambda: f.read(256 * 1024), b""):
                sha.update(chunk)
        local_hash = sha.hexdigest()

        # Fetch official SHASUMS256.txt (try nodejs.org first, then npmmirror)
        shasums_urls = [
            f"https://nodejs.org/dist/v{version}/SHASUMS256.txt",
            f"{self._node_download_base}/v{version}/SHASUMS256.txt",
        ]
        for url in shasums_urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
                resp = urllib.request.urlopen(req, timeout=15)
                with resp:
                    shasums = resp.read().decode("utf-8")
                for line in shasums.splitlines():
                    parts = line.strip().split()
                    if len(parts) >= 2 and parts[1].strip() == filename:
                        expected = parts[0].strip()
                        if local_hash == expected:
                            self.log.success(f"SHA256 verified: {local_hash[:16]}…")
                            return True
                        else:
                            self.log.error(
                                f"SHA256 mismatch!\n"
                                f"  Expected: {expected}\n"
                                f"  Got:      {local_hash}"
                            )
                            return False
                self.log.warn(f"Filename {filename} not found in SHASUMS256 from {url}")
            except Exception as e:
                self.log.debug(f"SHASUMS256 fetch from {url} failed: {e}")
                continue

        self.log.error(
            "Could not fetch SHASUMS256.txt — aborting to prevent installing unverified binaries"
        )
        return False  # Fail-closed: refuse to install unverified binaries

    # ────────────────────── npm config ──────────────────────

    def setup_npm_mirror(self) -> bool:
        """Set npm registry and global prefix.

        Redirects npm's global config path via npm_config_globalconfig env var
        so that npm never touches the system npmrc (which may be under
        C:\\Program Files and need admin privileges).
        """
        # Honour the registry resolved during __init__ (auto-probe or user
        # override). _resolved_npm_registry is only set when cfg.set() was
        # unavailable; otherwise the resolved value lives in cfg.
        default_registry = getattr(
            self,
            "_resolved_npm_registry",
            MIRRORS.get(self._mirror_name, MIRRORS[MIRROR_FALLBACK])["npm_registry"],
        )
        registry = self.cfg.get("npm.registry", default_registry) or default_registry
        self.log.step(f"Configuring npm registry ({registry})…")
        npm = self._get_npm_path()
        if not npm:
            self.log.error("npm not found")
            return False
        try:
            env = self._get_env()

            # Set prefix so `npm install -g` puts openclaw.cmd in our dir
            try:
                self._run(
                    [npm, "config", "set", "prefix", str(self.node_dir)],
                    capture_output=True,
                    timeout=30,
                    env=env,
                )
            except Exception:
                pass

            r = self._run(
                [npm, "config", "set", "registry", registry],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                env=env,
            )
            if r.returncode != 0:
                self.log.error(f"npm config set failed: {r.stderr.strip()}")
                return False

            # Verify
            r2 = self._run(
                [npm, "config", "get", "registry"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                env=env,
            )
            actual = r2.stdout.strip().rstrip("/")
            expected = registry.rstrip("/")
            if actual == expected:
                self.log.success(f"npm registry → {actual}  ✓")
            else:
                self.log.warn(f"npm registry set to {actual} (expected {expected})")

            # Register rollback. The default-arg pattern is intentional: it captures
            # `npm` and `env` by value at definition time so the closure isn't affected
            # by later mutations of the enclosing scope.
            def _rollback_npm_mirror(npm_path=npm, env_copy=env.copy()):  # noqa: B008
                try:
                    WindowsSetup._run(
                        [npm_path, "config", "set", "registry", "https://registry.npmjs.org/"],
                        capture_output=True,
                        timeout=30,
                        env=env_copy,
                    )
                except Exception:
                    pass

            self._register_rollback("重置 npm 镜像源", _rollback_npm_mirror)
            return True
        except Exception as e:
            self.log.error(f"npm config failed: {e}")
            self.log.info(f"  node_dir: {self.node_dir}")
            self.log.info(f"  node_dir exists: {self.node_dir.exists()}")
            self.log.info(
                f"  npm_config_globalconfig: {env.get('npm_config_globalconfig', 'NOT SET')}"
            )
            return False

    # ────────────────────── OpenClaw ──────────────────────

    def _openclaw_search_roots(self) -> list[Path]:
        """Return package roots in the same precedence used by the desktop."""
        appdata = Path(os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming"))
        local_appdata = Path(
            os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        )
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        candidates = [
            getattr(self, "install_prefix", None),
            Path.home() / ".openclaw-node",
            appdata / "npm",
            program_files / "nodejs",
            local_appdata / "Programs" / "nodejs",
            self.node_dir,
        ]
        roots: list[Path] = []
        for candidate in candidates:
            if candidate is None:
                continue
            path = Path(candidate).resolve(strict=False)
            if path not in roots:
                roots.append(path)
        return roots

    @staticmethod
    def _openclaw_installation_at_prefix(prefix: Path) -> OpenClawInstallation | None:
        prefix = prefix.resolve(strict=False)
        for package_dir in (
            prefix / "node_modules" / "openclaw",
            prefix / "lib" / "node_modules" / "openclaw",
        ):
            package_json = package_dir / "package.json"
            if not package_json.exists():
                continue
            try:
                package = json.loads(package_json.read_text(encoding="utf-8"))
                version = package["version"]
            except (OSError, KeyError, TypeError, json.JSONDecodeError):
                continue
            if not isinstance(version, str) or not version:
                continue
            entry = package_dir / "openclaw.mjs"
            if not entry.exists():
                entry = package_dir / "dist" / "index.js"
            if not entry.exists():
                continue
            return OpenClawInstallation(
                version=version,
                prefix=prefix,
                package_dir=package_dir,
                entry_path=entry,
                shim_paths=tuple(
                    prefix / name for name in ("openclaw", "openclaw.cmd", "openclaw.ps1")
                ),
            )
        return None

    def _detect_openclaw_installation(self) -> OpenClawInstallation | None:
        for root in self._openclaw_search_roots():
            installation = self._openclaw_installation_at_prefix(root)
            if installation is not None:
                return installation
        return None

    def check_openclaw_windows(self) -> bool:
        """Return whether the exact pinned OpenClaw package is installed."""
        installation = self._detect_openclaw_installation()
        if installation is None:
            return False
        self.log.info(f"OpenClaw found on Windows: {installation.version}")
        if installation.version != OPENCLAW_TARGET_VERSION:
            self.log.info(
                f"OpenClaw {installation.version} requires upgrade to {OPENCLAW_TARGET_VERSION}"
            )
            return False
        self.install_prefix = installation.prefix
        return True

    @staticmethod
    def _is_tcp_port_open(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            return False

    def _find_active_gateway_lock(self) -> dict | None:
        local_appdata = Path(
            os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        )
        lock_dir = local_appdata / "Temp" / "openclaw"
        if not lock_dir.is_dir():
            return None
        for lock_path in lock_dir.glob("gateway.*.lock"):
            try:
                payload = json.loads(lock_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            pid = payload.get("pid")
            port = payload.get("port")
            has_declared_port = (
                isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535
            )
            port_active = has_declared_port and self._is_tcp_port_open(port)
            pid_active = False
            if isinstance(pid, int) and process_is_alive(pid):
                try:
                    lock_created_at = datetime.fromisoformat(
                        str(payload.get("createdAt")).replace("Z", "+00:00")
                    )
                    if lock_created_at.tzinfo is None:
                        lock_created_at = lock_created_at.replace(tzinfo=UTC)
                    process_created_at = process_started_at(pid)
                    if process_created_at is not None:
                        if process_created_at.tzinfo is None:
                            process_created_at = process_created_at.replace(tzinfo=UTC)
                        pid_active = (
                            abs(
                                (
                                    lock_created_at.astimezone(UTC)
                                    - process_created_at.astimezone(UTC)
                                ).total_seconds()
                            )
                            <= 300
                        )
                except (TypeError, ValueError):
                    pid_active = False
            active = port_active or pid_active
            if active:
                return {**payload, "lockPath": str(lock_path)}
        return None

    def _find_listening_pid(self, port: int) -> int | None:
        try:
            result = self._run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        for line in result.stdout.splitlines():
            columns = line.split()
            if len(columns) < 5 or columns[0].upper() != "TCP":
                continue
            if columns[3].upper() != "LISTENING":
                continue
            local_address = columns[1].rsplit(":", 1)
            if len(local_address) != 2 or local_address[1] != str(port):
                continue
            try:
                pid = int(columns[4])
            except ValueError:
                continue
            if pid > 0:
                return pid
        return None

    def get_active_gateway(self) -> ActiveGateway | None:
        port = int(self.cfg.get("gateway.port", 18789))
        active_lock = self._find_active_gateway_lock()
        port_open = self._is_tcp_port_open(port)
        if not port_open and active_lock is None:
            return None

        pid = active_lock.get("pid") if active_lock else None
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            pid = self._find_listening_pid(port) if port_open else None
        lock_port = active_lock.get("port") if active_lock else None
        if (
            isinstance(lock_port, int)
            and not isinstance(lock_port, bool)
            and 1 <= lock_port <= 65535
        ):
            port = lock_port
        lock_path = active_lock.get("lockPath") if active_lock else None
        return ActiveGateway(
            pid=pid,
            port=port,
            lock_path=Path(lock_path) if isinstance(lock_path, str) else None,
        )

    def _process_snapshot(self) -> dict[int, _ProcessInfo]:
        command = (
            "Get-CimInstance Win32_Process | "
            "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        )
        try:
            result = self._run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError):
            return {}
        if result.returncode != 0 or not result.stdout.strip():
            return {}
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return {}
        rows = payload if isinstance(payload, list) else [payload]
        snapshot: dict[int, _ProcessInfo] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            pid = row.get("ProcessId")
            parent_pid = row.get("ParentProcessId")
            name = row.get("Name")
            command_line = row.get("CommandLine")
            if (
                isinstance(pid, int)
                and not isinstance(pid, bool)
                and pid > 0
                and isinstance(parent_pid, int)
                and not isinstance(parent_pid, bool)
                and isinstance(name, str)
            ):
                snapshot[pid] = _ProcessInfo(
                    parent_pid=parent_pid,
                    name=name,
                    command_line=command_line if isinstance(command_line, str) else "",
                )
        return snapshot

    def _find_managing_desktop_pid(
        self,
        gateway_pid: int,
        snapshot: dict[int, _ProcessInfo] | None = None,
    ) -> int | None:
        snapshot = snapshot if snapshot is not None else self._process_snapshot()
        current_pid = gateway_pid
        visited: set[int] = set()
        while current_pid > 0 and current_pid not in visited:
            visited.add(current_pid)
            process = snapshot.get(current_pid)
            if process is None:
                return None
            if process.name.casefold() in {"microclawdesktop.exe", "openclaw.exe"}:
                return current_pid
            current_pid = process.parent_pid
        return None

    @staticmethod
    def _desktop_process_roots(snapshot: dict[int, _ProcessInfo]) -> tuple[int, ...]:
        managed_names = {"microclawdesktop.exe", "openclaw.exe"}
        managed_pids = {
            pid for pid, process in snapshot.items() if process.name.casefold() in managed_names
        }
        return tuple(
            sorted(pid for pid in managed_pids if snapshot[pid].parent_pid not in managed_pids)
        )

    @staticmethod
    def _is_openclaw_gateway_process(
        pid: int,
        snapshot: dict[int, _ProcessInfo],
    ) -> bool:
        process = snapshot.get(pid)
        if process is None:
            return False
        if process.name.casefold() in {"microclawdesktop.exe", "openclaw.exe"}:
            return True
        return "openclaw" in process.command_line.casefold()

    def get_active_installation(self) -> ActiveInstallation | None:
        gateway = self.get_active_gateway()
        snapshot = self._process_snapshot()
        target_pids = set(self._desktop_process_roots(snapshot))

        if gateway is not None and gateway.pid is not None:
            desktop_pid = self._find_managing_desktop_pid(gateway.pid, snapshot)
            if desktop_pid is not None:
                target_pids.add(desktop_pid)
            elif gateway.lock_path is not None or self._is_openclaw_gateway_process(
                gateway.pid, snapshot
            ):
                target_pids.add(gateway.pid)

        if gateway is None and not target_pids:
            return None
        return ActiveInstallation(pids=tuple(sorted(target_pids)), gateway=gateway)

    def stop_active_installation_for_upgrade(self, active: ActiveInstallation) -> bool:
        current = self.get_active_installation()
        if current is None:
            return True
        active = current
        if not active.pids:
            gateway = active.gateway
            port = gateway.port if gateway is not None else int(self.cfg.get("gateway.port", 18789))
            self.log.error(
                f"Port {port} is in use, but the owning process could not be safely "
                "identified as MicroClaw/OpenClaw."
            )
            return False

        if os.getpid() in active.pids:
            self.log.error("Refusing to stop the installer process while preparing the upgrade.")
            return False

        self.log.step("Closing the running MicroClaw/OpenClaw instance…")
        if active.gateway is not None:
            try:
                self._run(
                    ["schtasks", "/End", "/TN", "OpenClaw Gateway"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                pass

        for target_pid in active.pids:
            try:
                result = self._run(
                    ["taskkill", "/PID", str(target_pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            except (OSError, subprocess.SubprocessError) as error:
                self.log.error(f"Could not close MicroClaw/OpenClaw: {error}")
                return False
            if result.returncode != 0 and process_is_alive(target_pid):
                detail = result.stderr.strip() or result.stdout.strip()
                self.log.error(f"Could not close MicroClaw/OpenClaw: {detail}")
                return False

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.get_active_installation() is None:
                gateway = active.gateway
                if gateway is not None and gateway.lock_path is not None:
                    try:
                        gateway.lock_path.unlink(missing_ok=True)
                    except OSError as error:
                        self.log.warn(f"Could not remove stale Gateway lock: {error}")
                self.log.success("MicroClaw/OpenClaw closed; continuing installation")
                return True
            time.sleep(0.5)

        self.log.error(
            "MicroClaw/OpenClaw restarted or did not close. Exit it from the system tray and retry."
        )
        return False

    def _gateway_is_stopped_for_upgrade(self) -> bool:
        active_gateway = self.get_active_gateway()
        if active_gateway is not None:
            owner = f" (pid {active_gateway.pid})" if active_gateway.pid is not None else ""
            self.log.error(
                f"OpenClaw Gateway is active{owner}. Exit MicroClaw and standalone "
                "OpenClaw before upgrading."
            )
            return False
        return True

    def _discard_failed_transaction(
        self, transaction: OpenClawUpgradeTransaction, reason: str
    ) -> None:
        """Abandon a transaction whose rollback failed so future installs work.

        Leaving it in ``rollback-failed`` keeps the manifest recoverable and
        retains the upgrade lock, which permanently blocks every subsequent
        install with ``UpgradeInProgressError``. Discarding clears that state;
        the live installation is left as-is and later steps reinstall OpenClaw.
        """
        self.log.warn(
            f"OpenClaw upgrade rollback could not complete ({reason}); discarding "
            "transaction state so future installs are not blocked. The existing "
            "OpenClaw installation was left in place."
        )
        try:
            transaction.discard()
        except Exception as discard_error:
            self.log.error(f"Failed to discard OpenClaw upgrade transaction: {discard_error}")

    def _rollback_openclaw_transaction(self, transaction: OpenClawUpgradeTransaction) -> bool:
        transaction.progress_callback = self.progress_callback
        process: subprocess.Popen | None = None
        try:
            original_phase = transaction.manifest.phase
            transaction.rollback()
            if transaction.manifest.phase == UpgradePhase.ROLLED_BACK:
                return True
            if original_phase == UpgradePhase.BACKING_UP:
                transaction.complete_rollback()
                return True
            source_version = transaction.manifest.source_version
            if source_version is not None:
                process = self._start_validation_gateway(expected_version=source_version)
                if not self._validate_gateway_health():
                    self.log.error(
                        "Previous OpenClaw Gateway did not become healthy after rollback"
                    )
                    self._discard_failed_transaction(
                        transaction, "restored gateway did not become healthy"
                    )
                    return False
            transaction.complete_rollback()
            return True
        except Exception as error:
            self.log.error(
                f"Failed to restore OpenClaw backup at {transaction.backup_dir}: {error}"
            )
            self._discard_failed_transaction(transaction, str(error) or error.__class__.__name__)
            return False
        finally:
            self._stop_validation_gateway(process)

    def recover_interrupted_openclaw_upgrade(self) -> bool:
        if not self._gateway_is_stopped_for_upgrade():
            return False
        try:
            transaction = OpenClawUpgradeTransaction.load(DEFAULT_DESKTOP_DIR)
        except UpgradeInProgressError as error:
            self.log.error(str(error))
            return False
        if transaction is None or transaction.manifest.phase not in RECOVERABLE_PHASES:
            return True
        self.log.warn("Recovering interrupted OpenClaw upgrade before continuing")
        if not self._gateway_is_stopped_for_upgrade():
            transaction.close()
            return False
        return self._rollback_openclaw_transaction(transaction)

    def prepare_openclaw_upgrade(self) -> bool:
        """Block active gateways and snapshot the current package and state."""
        if not self._gateway_is_stopped_for_upgrade():
            return False
        if not self.recover_interrupted_openclaw_upgrade():
            return False
        installation = self._detect_openclaw_installation()
        if not self._gateway_is_stopped_for_upgrade():
            return False
        prefix = (
            installation.prefix if installation is not None else self._choose_npm_install_prefix()
        )
        source = installation or OpenClawInstallation(
            version="",
            prefix=prefix,
            package_dir=prefix / "node_modules" / "openclaw",
            entry_path=prefix / "node_modules" / "openclaw" / "openclaw.mjs",
            shim_paths=tuple(
                prefix / name for name in ("openclaw", "openclaw.cmd", "openclaw.ps1")
            ),
        )
        self.install_prefix = prefix
        try:
            transaction = OpenClawUpgradeTransaction.create(
                microclaw_root=DEFAULT_DESKTOP_DIR,
                state_dir=Path.home() / ".openclaw",
                target_version=OPENCLAW_TARGET_VERSION,
                installation=source,
            )
            self._openclaw_transaction = transaction
            transaction.progress_callback = self.progress_callback
            if not self._gateway_is_stopped_for_upgrade():
                transaction.close()
                self._openclaw_transaction = None
                return False
            transaction.backup()
            return True
        except Exception as error:
            self.log.error(f"Could not prepare OpenClaw upgrade backup: {error}")
            transaction = self._openclaw_transaction
            if transaction is not None and self._rollback_openclaw_transaction(transaction):
                self._openclaw_transaction = None
            return False

    def ensure_execution_policy(self) -> bool:
        """Set PowerShell ExecutionPolicy to RemoteSigned for current user.

        Without this, npm.ps1 / npx.ps1 scripts cannot execute on fresh
        Windows installs where the default policy is Restricted.
        """
        self.log.step("Checking PowerShell execution policy…")
        try:
            r = self._run(
                ["powershell", "-NoProfile", "-Command", "Get-ExecutionPolicy -Scope CurrentUser"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            policy = r.stdout.strip()
            if policy in ("RemoteSigned", "Unrestricted", "Bypass"):
                self.log.info(f"ExecutionPolicy already OK: {policy}")
                return True
        except Exception:
            pass

        try:
            self._run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.log.success("ExecutionPolicy set to RemoteSigned")
            return True
        except Exception as e:
            self.log.warn(f"Could not set ExecutionPolicy: {e}")
            return False

    def install_openclaw_windows(self) -> bool:
        """Install openclaw via npm on Windows."""
        channel = self.cfg.get("openclaw.channel", "stable")
        tag = OPENCLAW_TARGET_VERSION if channel == "stable" else channel
        # Validate tag before passing to subprocess
        if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$", tag):
            self.log.error(f"Invalid npm tag: {tag!r}")
            return False
        self.log.step(f"Installing OpenClaw on Windows (npm, tag={tag})…")

        npm = self._get_npm_path()
        if not npm:
            self.log.error("npm not found — install Node.js first")
            return False

        try:
            install_prefix = Path(
                getattr(self, "install_prefix", None) or self._choose_npm_install_prefix()
            )
            self.install_prefix = install_prefix
            self.log.info(f"  npm install prefix: {install_prefix}")
            if self._install_openclaw_with_registry_fallback(install_prefix):
                self._patch_pi_ai_usage_streaming()
                self.log.success(f"OpenClaw {tag} installed on Windows")
                return True
            return False
        except Exception as e:
            self.log.error(f"OpenClaw install failed: {e}")
            return False

    def _npm_registry_candidates(self) -> list[str]:
        configured = self.cfg.get("npm.registry", "") or getattr(self, "_resolved_npm_registry", "")
        candidates = [
            configured,
            MIRRORS[MIRROR_OFFICIAL]["npm_registry"],
            MIRRORS[MIRROR_NPMMIRROR]["npm_registry"],
            NPM_REGISTRY_HUAWEI,
        ]
        registries: list[str] = []
        for registry in candidates:
            if registry and registry.rstrip("/") not in {
                existing.rstrip("/") for existing in registries
            }:
                registries.append(registry)
        return registries

    def _reachable_npm_registries(self, candidates: list[str], timeout: float = 2.5) -> list[str]:
        """Filter ``candidates`` down to registries that answer a quick probe.

        Each candidate's ``/-/ping`` endpoint is probed in parallel with a
        short per-registry ``timeout``. A registry counts as reachable if the
        host responds at all — even a 4xx/5xx is fine, since that still proves
        the TCP+TLS handshake completed. Registries that time out or fail to
        connect (DNS, SSL, or a corporate ``NPM URL Block`` network policy)
        are dropped so we never hand them to ``npm install``, which would
        otherwise hang for up to 15 minutes retrying a blocked host.

        Returns the reachable subset ordered fastest-first; unreachable
        registries are omitted entirely.
        """
        import concurrent.futures as _cf

        def _measure(registry: str) -> tuple[str, float]:
            url = registry.rstrip("/") + "/-/ping"
            req = urllib.request.Request(url, headers={"User-Agent": "OpenClawDeployer/1.0"})
            start = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    resp.read(64)
                return registry, time.monotonic() - start
            except urllib.error.HTTPError:
                # A 404/403 still means the host is reachable.
                return registry, time.monotonic() - start
            except Exception:
                return registry, float("inf")

        if not candidates:
            return []

        results: list[tuple[str, float]] = []
        try:
            with _cf.ThreadPoolExecutor(max_workers=len(candidates)) as pool:
                futures = [pool.submit(_measure, r) for r in candidates]
                for f in _cf.as_completed(futures, timeout=timeout + 1.0):
                    results.append(f.result())
        except Exception as e:
            self.log.debug(f"npm registry reachability probe failed: {e}")

        reachable = sorted((r for r in results if r[1] != float("inf")), key=lambda x: x[1])
        for registry, latency in reachable:
            self.log.debug(f"  npm registry {registry}: {int(latency * 1000)} ms")
        return [registry for registry, _ in reachable]

    def _install_openclaw_from_registry(
        self, install_prefix: Path, registry: str
    ) -> OpenClawInstallAttempt:
        npm = self._get_npm_path()
        if not npm:
            raise RuntimeError("npm not found — install Node.js first")
        channel = self.cfg.get("openclaw.channel", "stable")
        tag = OPENCLAW_TARGET_VERSION if channel == "stable" else channel
        env = self._get_env()
        env["NODE_LLAMA_CPP_SKIP_DOWNLOAD"] = "true"
        proc = subprocess.Popen(
            [
                npm,
                "install",
                "-g",
                f"openclaw@{tag}",
                "--prefix",
                str(install_prefix),
                "--registry",
                registry,
                "--replace-registry-host",
                "always",
                "--loglevel",
                "info",
                "--no-progress",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
            creationflags=_CREATE_NO_WINDOW,
        )
        collected: list[str] = []
        if proc.stdout is not None:
            for line in proc.stdout:
                stripped = line.rstrip()
                if stripped:
                    collected.append(stripped)
                    self.log.info(f"  npm: {stripped}")
        proc.wait(timeout=900)
        installation = self._openclaw_installation_at_prefix(install_prefix)
        return OpenClawInstallAttempt(
            returncode=proc.returncode,
            output="\n".join(collected),
            installed_version=installation.version if installation else None,
        )

    def _install_openclaw_with_registry_fallback(self, install_prefix: Path) -> bool:
        retryable_registry_error = re.compile(
            r"ERR_SSL|TLS|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|"
            r"\bE(?:401|403|404|408|429|5\d{2})\b|"
            r"\b(?:401|403|404|408|429|5\d{2})\b",
            re.IGNORECASE,
        )
        channel = self.cfg.get("openclaw.channel", "stable")
        expected_version = OPENCLAW_TARGET_VERSION if channel == "stable" else None
        candidates = self._npm_registry_candidates()
        registries = self._reachable_npm_registries(candidates)
        if not registries:
            self.log.error(
                "Cannot reach any npm registry to install OpenClaw. Every candidate "
                "registry failed a quick reachability probe, which usually means they "
                "are blocked by your network or IT policy (e.g. a corporate "
                "'NPM URL Block'). Tried: " + ", ".join(candidates) + ". "
                "Configure an allowed npm registry via 'npm.registry' and retry."
            )
            return False
        for registry in registries:
            self.log.info(f"  npm registry attempt: {registry}")
            attempt = self._install_openclaw_from_registry(install_prefix, registry)
            installed = attempt.installed_version
            success = (
                installed == expected_version
                if expected_version is not None
                else attempt.returncode == 0 and installed is not None
            )
            if success:
                if attempt.returncode != 0:
                    self.log.warn(
                        f"npm exited with code {attempt.returncode} but the exact "
                        "OpenClaw package and entry were verified"
                    )
                return True
            if not retryable_registry_error.search(attempt.output):
                self.log.error(
                    f"npm install failed (exit {attempt.returncode}) via {registry}:\n"
                    f"{attempt.output[-1500:]}"
                )
                return False
            self.log.warn(f"npm registry failure via {registry}; trying next registry")
        self.log.error("OpenClaw install failed through every configured npm registry")
        return False

    def _load_openclaw_state_env(self, state_dir: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        env_path = state_dir / ".env"
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                key, separator, value = line.partition("=")
                if separator and key.strip():
                    values[key.strip()] = value.strip()
        except FileNotFoundError:
            pass
        return values

    def _resolve_validation_node(self) -> Path:
        candidates = []
        if self._node_bin is not None:
            candidates.append(Path(self._node_bin) / "node.exe")
        candidates.append(self.node_dir / "node.exe")
        path_node = shutil.which("node")
        if path_node:
            candidates.append(Path(path_node))
        for candidate in candidates:
            if candidate.exists():
                return candidate
        raise FileNotFoundError("node.exe not found for OpenClaw validation")

    def _start_validation_gateway(
        self, expected_version: str | None = OPENCLAW_TARGET_VERSION
    ) -> subprocess.Popen:
        installation = self._detect_openclaw_installation()
        if installation is None or (
            expected_version is not None and installation.version != expected_version
        ):
            raise RuntimeError(f"Expected OpenClaw package is not installed: {expected_version}")
        node = self._resolve_validation_node()
        state_dir = Path.home() / ".openclaw"
        cache_dir = state_dir / "compile-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        env = self._get_env()
        env.update(self._load_openclaw_state_env(state_dir))
        env.update(
            {
                "OPENCLAW_STATE_DIR": str(state_dir),
                "NODE_COMPILE_CACHE": str(cache_dir),
                "NODE_ENV": "production",
                "OPENCLAW_NO_RESPAWN": "1",
            }
        )
        return subprocess.Popen(
            [
                str(node),
                str(installation.entry_path),
                "gateway",
                "run",
                "--port",
                str(self.cfg.get("gateway.port", 18789)),
                "--bind",
                "loopback",
                "--allow-unconfigured",
            ],
            cwd=str(installation.package_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_CREATE_NO_WINDOW,
        )

    def _stop_validation_gateway(self, process: subprocess.Popen | None) -> None:
        if process is None or process.poll() is not None:
            return
        if platform.system() == "Windows" and process.pid:
            result = self._run(
                ["taskkill", "/pid", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode not in (0, 128):
                self.log.warn(
                    f"Could not stop validation Gateway process tree: "
                    f"{result.stderr.strip() or result.stdout.strip()}"
                )
        else:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _validate_installed_version(self) -> bool:
        installation = self._detect_openclaw_installation()
        return bool(
            installation
            and installation.version == OPENCLAW_TARGET_VERSION
            and installation.entry_path.exists()
        )

    def _validate_gateway_health(self) -> bool:
        url = f"http://127.0.0.1:{self.cfg.get('gateway.port', 18789)}/health"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    if response.status == 200:
                        return True
            except (OSError, urllib.error.URLError):
                time.sleep(0.5)
        return False

    def _run_openclaw_json(self, args: list[str]) -> object:
        command = self._find_openclaw_cmd()
        if command is None:
            raise RuntimeError("openclaw command not found")
        state_dir = Path.home() / ".openclaw"
        cache_dir = state_dir / "compile-cache"
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        env = self._get_env()
        env.update(self._load_openclaw_state_env(state_dir))
        env["OPENCLAW_STATE_DIR"] = str(state_dir)
        # Each `openclaw gateway call ...` spawns a fresh Node process that
        # boots the whole CLI before issuing the RPC. On freshly-provisioned
        # machines (cold V8 cache, antivirus scanning every newly written file)
        # that cold start alone can take 30-60s, so share the gateway's compile
        # cache and allow a generous, cold-start-tolerant timeout instead of the
        # old 30s ceiling that spuriously failed post-install validation.
        env.setdefault("NODE_COMPILE_CACHE", str(cache_dir))
        result = self._run(
            command + args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_OPENCLAW_RPC_TIMEOUT,
            env=env,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"OpenClaw returned invalid JSON for {' '.join(args)}") from error

    def _validate_gateway_status(self) -> bool:
        payload = self._run_openclaw_json(["gateway", "status", "--require-rpc", "--json"])
        return isinstance(payload, dict)

    def _validate_gateway_rpc(self, method: str) -> bool:
        return self._run_openclaw_json(["gateway", "call", method, "--json"]) is not None

    @staticmethod
    def _contains_enabled_weixin_plugin(value: object) -> bool:
        if isinstance(value, dict):
            identifier = value.get("id") or value.get("name")
            if identifier == "openclaw-weixin":
                status = str(value.get("status", "")).lower()
                return value.get("enabled", True) is not False and status not in {
                    "disabled",
                    "error",
                    "failed",
                }
            return any(
                WindowsSetup._contains_enabled_weixin_plugin(child) for child in value.values()
            )
        if isinstance(value, list):
            return any(WindowsSetup._contains_enabled_weixin_plugin(child) for child in value)
        return False

    def _validate_weixin_plugin(self) -> bool:
        payload = self._run_openclaw_json(["plugins", "list", "--json"])
        return self._contains_enabled_weixin_plugin(payload)

    def _validate_appcontainer_smoke(self) -> bool:
        if not self.appcontainer_enabled:
            return True
        launcher = self._find_appcontainer_launcher()
        if launcher is None:
            return False
        result = self._run(
            [
                str(launcher),
                "run",
                "--name",
                "MicroClaw",
                "--exe",
                os.environ.get("COMSPEC", "cmd.exe"),
                "--no-window",
                "--quiet",
                "--",
                "/c",
                "echo",
                "microclaw-sandbox-ok",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return result.returncode == 0 and "microclaw-sandbox-ok" in result.stdout

    def verify_openclaw_upgrade(self) -> bool:
        transaction = self._openclaw_transaction
        if transaction is not None:
            transaction.mark_verifying()

        def record(name: str, passed: bool) -> None:
            if transaction is not None:
                transaction.record_validation(name, passed)

        version_ok = self._validate_installed_version()
        record("version", version_ok)
        if not version_ok:
            self.log.error("OpenClaw validation failed: version")
            return False

        process = None
        checks = [
            ("health", self._validate_gateway_health),
            ("v4-handshake", self._validate_gateway_status),
            ("config.get", lambda: self._validate_gateway_rpc("config.get")),
            ("agents.list", lambda: self._validate_gateway_rpc("agents.list")),
            ("channels.status", lambda: self._validate_gateway_rpc("channels.status")),
            ("cron.list", lambda: self._validate_gateway_rpc("cron.list")),
            ("weixin-plugin", self._validate_weixin_plugin),
            ("appcontainer", self._validate_appcontainer_smoke),
        ]
        try:
            process = self._start_validation_gateway()
            for name, check in checks:
                passed = bool(check())
                record(name, passed)
                if not passed:
                    raise RuntimeError(f"OpenClaw validation failed: {name}")
            return True
        except Exception as error:
            self.log.error(str(error))
            return False
        finally:
            self._stop_validation_gateway(process)

    def commit_openclaw_upgrade(self) -> bool:
        transaction = self._openclaw_transaction
        if transaction is None:
            return True
        transaction.commit()
        try:
            prune_previous_committed_backups(transaction.backup_root, keep=transaction.backup_dir)
        except OSError as error:
            self.log.warn(f"Could not prune an older OpenClaw backup: {error}")
        self._openclaw_transaction = None
        return True

    def rollback_openclaw_upgrade(self) -> bool:
        transaction = self._openclaw_transaction
        if transaction is None:
            return True
        if not self._rollback_openclaw_transaction(transaction):
            return False
        self._openclaw_transaction = None
        return True

    def _choose_npm_install_prefix(self) -> Path:
        """Return a writable directory to use as ``npm install -g --prefix``.

        Prefers ``self.node_dir`` (where Node.js itself lives) so the
        resulting ``openclaw.cmd`` sits next to ``node.exe`` on PATH.  If
        that directory isn't writable for the current user (typical for the
        per-machine MSI install under ``C:\\Program Files\\nodejs`` when the
        installer is run without elevation), fall back to the standard
        per-user npm prefix at ``%APPDATA%\\npm`` — a location both the
        deployer (`_find_openclaw_cmd`) and the Electron desktop
        (`resolveOpenClawEntry`) already know how to find.
        """
        candidate = self.node_dir
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".write-probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return candidate
        except (OSError, PermissionError):
            appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
            fallback = Path(appdata) / "npm"
            fallback.mkdir(parents=True, exist_ok=True)
            self.log.info(f"  {candidate} 不可写，改用用户目录 {fallback}（无需管理员权限）")
            return fallback

    def _patch_pi_ai_usage_streaming(self) -> None:
        """Force pi-ai's openai-completions provider to always emit
        ``stream_options: { include_usage: true }``.

        pi-ai guards this behind ``compat.supportsUsageInStreaming !== false``,
        and OpenClaw's ``normalizeModelCompat`` flips that flag to ``false``
        for any non-native OpenAI endpoint (hostname != api.openai.com),
        which suppresses usage in streaming for third-party proxies and
        causes the Usage dashboard to report 0 tokens. Patch the guard
        away so usage is always requested. Idempotent; safe to re-run.
        """
        candidates = []
        # Search both node_dir and the npm install prefix actually used
        # (these differ when we fell back to %APPDATA%\npm).
        roots: list[Path] = [self.node_dir]
        install_prefix = getattr(self, "install_prefix", None)
        if install_prefix and Path(install_prefix) not in roots:
            roots.append(Path(install_prefix))
        appdata = os.environ.get("APPDATA")
        if appdata:
            appdata_npm = Path(appdata) / "npm"
            if appdata_npm not in roots:
                roots.append(appdata_npm)
        for root in roots:
            for sub in (
                ("node_modules", "openclaw", "node_modules"),
                ("node_modules",),
                ("lib", "node_modules", "openclaw", "node_modules"),
                ("lib", "node_modules"),
            ):
                candidates.append(
                    root.joinpath(
                        *sub,
                        "@mariozechner",
                        "pi-ai",
                        "dist",
                        "providers",
                        "openai-completions.js",
                    )
                )
        target = next((p for p in candidates if p.exists()), None)
        if target is None:
            self.log.debug(
                "pi-ai openai-completions.js not found \u2014 skipping usage-streaming patch"
            )
            return
        try:
            original = target.read_text(encoding="utf-8")
        except Exception as exc:
            self.log.warn(f"  Could not read {target} for patch: {exc}")
            return
        marker = "params.stream_options = { include_usage: true };"
        guard_old = (
            "if (compat.supportsUsageInStreaming !== false) {\n"
            "        params.stream_options = { include_usage: true };\n"
            "    }"
        )
        if guard_old in original:
            patched = original.replace(guard_old, marker)
        elif marker in original and "supportsUsageInStreaming !== false" not in original:
            self.log.debug("  pi-ai usage-streaming patch already applied")
            return
        else:
            self.log.warn(
                "  pi-ai openai-completions.js did not match expected usage-streaming guard \u2014 skipping"
            )
            return
        try:
            backup = target.with_suffix(target.suffix + ".bak")
            if not backup.exists():
                backup.write_text(original, encoding="utf-8")
            target.write_text(patched, encoding="utf-8")
            self.log.info("  Patched pi-ai to always emit stream_options.include_usage")
        except Exception as exc:
            self.log.warn(f"  Failed to write pi-ai usage-streaming patch: {exc}")

    def warmup_compile_cache(self) -> bool:
        """Warm up Node.js compile cache by briefly starting the gateway.

        Node 22's NODE_COMPILE_CACHE stores V8 compiled bytecode so that
        subsequent starts skip JS parsing.  We run the gateway for a few
        seconds during install so the cache is pre-populated and the user's
        first real launch is fast.
        """
        self.log.step("Warming up compile cache for faster startup…")

        node = self.node_dir / "node.exe"
        # Search both node_dir and the npm install prefix actually used
        # (these differ when we fell back to %APPDATA%\npm).
        entry_roots: list[Path] = [self.node_dir]
        install_prefix = getattr(self, "install_prefix", None)
        if install_prefix and Path(install_prefix) not in entry_roots:
            entry_roots.append(Path(install_prefix))
        appdata = os.environ.get("APPDATA")
        if appdata:
            appdata_npm = Path(appdata) / "npm"
            if appdata_npm not in entry_roots:
                entry_roots.append(appdata_npm)
        entry: Path | None = None
        for root in entry_roots:
            for sub in (
                ("node_modules", "openclaw", "openclaw.mjs"),
                ("node_modules", "openclaw", "dist", "index.js"),
                ("lib", "node_modules", "openclaw", "openclaw.mjs"),
                ("lib", "node_modules", "openclaw", "dist", "index.js"),
            ):
                candidate = root.joinpath(*sub)
                if candidate.exists():
                    entry = candidate
                    break
            if entry:
                break
        if not node.exists() or entry is None:
            self.log.info("  Node or openclaw entry not found — skipping warmup")
            return True

        state_dir = Path.home() / ".openclaw"
        cache_dir = state_dir / "compile-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        env = self._get_env()
        env["NODE_COMPILE_CACHE"] = str(cache_dir)
        env["NODE_OPTIONS"] = "--dns-result-order=ipv4first"
        env["NODE_ENV"] = "production"
        env["OPENCLAW_STATE_DIR"] = str(state_dir)

        try:
            # Start gateway, let it initialize (populates compile cache), then stop it
            proc = subprocess.Popen(
                [
                    str(node),
                    str(entry),
                    "gateway",
                    "run",
                    "--port",
                    "18789",
                    "--bind",
                    "loopback",
                    "--force",
                    "--allow-unconfigured",
                ],
                env=env,
                cwd=str(entry.parent),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
            # Wait enough time for Node to parse and compile all modules
            time.sleep(8)
            # Kill the entire process tree (terminate alone may leave child node processes)
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            # Also kill any node processes still listening on the warmup port
            try:
                subprocess.run(
                    [
                        "cmd",
                        "/c",
                        "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr LISTENING ^| findstr :18789') do taskkill /PID %a /T /F >nul 2>&1",
                    ],
                    shell=True,
                    timeout=10,
                    creationflags=0x08000000,
                )
            except Exception:
                pass

            cached = sum(1 for _ in cache_dir.glob("**/*") if _.is_file())
            self.log.success(f"Compile cache warmed up ({cached} files in {cache_dir})")
            return True
        except Exception as e:
            self.log.warn(f"Compile cache warmup failed (non-fatal): {e}")
            return True  # non-fatal

    # ────────────────────── Managed Skills ──────────────────────

    def _get_bundled_skills_dir(self) -> Path | None:
        """Locate the skills/ directory bundled with the deployer.

        Searches (in order):
          1. PyInstaller _MEIPASS (frozen exe)
          2. Next to the running script / exe
          3. Repo root (parent of deployer/)
        Returns None if not found.
        """
        import sys

        candidates: list[Path] = []
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS) / "skills")
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys.executable).parent / "skills")
        # Repo layout: deployer/ is a sibling of skills/
        candidates.append(Path(__file__).resolve().parent.parent / "skills")
        for p in candidates:
            if p.is_dir():
                return p
        return None

    @staticmethod
    def _find_edge_executable() -> Path | None:
        """Locate Microsoft Edge on Windows, checking common install paths."""
        local_app = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        prog_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")

        candidates = []
        if local_app:
            candidates.append(Path(local_app, "Microsoft", "Edge", "Application", "msedge.exe"))
        candidates.append(Path(prog_files, "Microsoft", "Edge", "Application", "msedge.exe"))
        candidates.append(Path(prog_x86, "Microsoft", "Edge", "Application", "msedge.exe"))

        for p in candidates:
            if p.exists():
                return p
        return None

    def _deploy_managed_skills(self, openclaw_dir: Path) -> None:
        """Copy bundled managed skills into ~/.openclaw/skills/.

        Only copies skills that exist in MANAGED_SKILL_CATALOG.
        Existing skill directories are overwritten to ensure updates propagate.
        """
        from deployer.skill_catalog import MANAGED_SKILL_CATALOG

        src_dir = self._get_bundled_skills_dir()
        if src_dir is None:
            self.log.info("  No bundled skills directory found — skipping managed skill deployment")
            return

        dest_dir = openclaw_dir / "skills"
        deployed = 0
        for skill_name in MANAGED_SKILL_CATALOG:
            skill_src = src_dir / skill_name
            if not skill_src.is_dir():
                continue
            skill_dest = dest_dir / skill_name
            try:
                if skill_dest.exists():
                    shutil.rmtree(skill_dest)
                shutil.copytree(skill_src, skill_dest)
                deployed += 1
                self.log.info(f"  Deployed managed skill: {skill_name}")
            except Exception as e:
                self.log.warn(f"  Failed to deploy skill '{skill_name}': {e}")

        if deployed:
            self.log.success(f"Deployed {deployed} managed skill(s) to {dest_dir}")
        else:
            self.log.info("  No managed skills to deploy")

    def _install_officecli(self, openclaw_dir: Path) -> None:
        """Download the OfficeCLI binary into the skill directory.

        OfficeCLI is a single-binary CLI for .docx/.xlsx/.pptx with no
        dependencies.  Downloads the exe from GitHub Releases to
        ~/.openclaw/skills/officecli/bin/ and adds it to the user PATH.

        Avoids the ``irm <url> | iex`` pattern which triggers Windows
        Defender Trojan:Win32/ClickFix.
        """
        self.log.step("Installing OfficeCLI…")

        install_dir = openclaw_dir / "skills" / "officecli" / "bin"

        # Check if already installed in skill dir
        existing_exe = install_dir / "officecli.exe"
        if existing_exe.exists():
            try:
                result = subprocess.run(
                    [str(existing_exe), "--version"],
                    capture_output=True,
                    timeout=10,
                    creationflags=_CREATE_NO_WINDOW,
                )
                if result.returncode == 0:
                    ver = result.stdout.decode().strip() or result.stderr.decode().strip()
                    self.log.success(f"OfficeCLI already installed: {ver}")
                    return
            except Exception:
                pass

        import tempfile
        import urllib.request

        exe_url = (
            "https://github.com/iOfficeAI/OfficeCli/releases/latest/download/officecli-win-x64.exe"
        )

        try:
            install_dir.mkdir(parents=True, exist_ok=True)
            dest_exe = install_dir / "officecli.exe"

            # Download to temp file first, then move
            self.log.info("  Downloading officecli from GitHub Releases…")
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".exe")
            os.close(tmp_fd)
            try:
                urllib.request.urlretrieve(exe_url, tmp_path)
                shutil.move(tmp_path, str(dest_exe))
            except Exception:
                os.unlink(tmp_path) if os.path.exists(tmp_path) else None
                raise

            # Verify the binary works
            result = subprocess.run(
                [str(dest_exe), "--version"],
                capture_output=True,
                timeout=10,
                creationflags=_CREATE_NO_WINDOW,
            )
            if result.returncode == 0:
                ver = result.stdout.decode().strip() or result.stderr.decode().strip()
                self.log.info(f"  OfficeCLI version: {ver}")
            else:
                self.log.warn("  OfficeCLI downloaded but --version check failed")

            # Add to user PATH if not already there
            import winreg

            install_dir_str = str(install_dir)
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Environment",
                0,
                winreg.KEY_READ | winreg.KEY_WRITE,
            ) as key:
                try:
                    current_path, _ = winreg.QueryValueEx(key, "Path")
                except FileNotFoundError:
                    current_path = ""
                if install_dir_str.lower() not in current_path.lower():
                    new_path = (
                        f"{current_path};{install_dir_str}" if current_path else install_dir_str
                    )
                    winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, new_path)
                    self.log.info(f"  Added {install_dir_str} to user PATH")

            self.log.success("OfficeCLI installed successfully")
        except Exception as e:
            self.log.warn(f"OfficeCLI install failed (non-fatal): {e}")

    # ────────────────────── Configure + Gateway ──────────────────────

    def write_config(self) -> bool:
        """Write ~/.openclaw/openclaw.json with custom model provider.

        Uses models.providers with openai-completions API type so OpenClaw
        routes through the configured endpoint instead of direct Anthropic API.
        Also migrates any legacy config keys.
        """
        self.log.step("Writing OpenClaw configuration…")
        import json

        base_url = self.cfg.get("model.base_url", "")
        api_key = self.cfg.get("model.api_key", "")
        model_name = self.cfg.get("model.model_name", "claude-opus-4-7")
        port = self.cfg.get("gateway.port", 18789)
        bind = self.cfg.get("gateway.bind", "loopback")

        # Extract bare model id (strip provider prefix if present)
        bare_model = model_name.split("/")[-1] if "/" in model_name else model_name
        provider_model = f"custom/{bare_model}"

        openclaw_dir = Path.home() / ".openclaw"
        openclaw_dir.mkdir(parents=True, exist_ok=True)
        config_path = openclaw_dir / "openclaw.json"

        # Load existing config if present (preserve user's other settings)
        existing = {}
        if config_path.exists():
            try:
                existing = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}

        # ── Migrate legacy keys ──
        migrated = []
        if "agent" in existing:
            existing.pop("agent")
            migrated.append("removed legacy 'agent' key")
        # Remove old providers key from previous attempts
        if "providers" in existing:
            existing.pop("providers")
            migrated.append("removed invalid 'providers' key")

        if migrated:
            for m in migrated:
                self.log.info(f"  Config migration: {m}")

        # ── Gateway ──
        gw = existing.get("gateway", {})
        gw["port"] = port
        gw["bind"] = bind
        gw["mode"] = "local"
        # Ensure auth token exists (generate if missing)
        import secrets

        auth = gw.get("auth", {})
        if not auth.get("token"):
            auth["mode"] = "token"
            auth["token"] = secrets.token_hex(24)
            self.log.info("  Generated gateway auth token")
        gw["auth"] = auth
        existing["gateway"] = gw

        # ── Browser: default to Edge on Windows ──
        browser_cfg = existing.get("browser", {})
        if "executablePath" not in browser_cfg:
            edge_exe = self._find_edge_executable()
            if edge_exe:
                browser_cfg["executablePath"] = str(edge_exe)
                self.log.info(f"  Browser: Edge at {edge_exe}")
            else:
                self.log.info("  Browser: Edge not found — using openclaw auto-detection")
        browser_cfg.setdefault("enabled", True)
        existing["browser"] = browser_cfg

        # ── Model + provider: only write when api_key is configured ──
        if api_key and base_url:
            existing["agents"] = {
                "defaults": {
                    "model": {
                        "primary": provider_model,
                    },
                },
            }

            # apiKey uses ${ENV_VAR} syntax so secrets stay in .env
            api_url = base_url.rstrip("/")
            if not api_url.endswith("/v1"):
                api_url += "/v1"

            existing["models"] = {
                "mode": "merge",
                "providers": {
                    "custom": {
                        "baseUrl": api_url,
                        "apiKey": "${OPENCLAW_MODEL_API_KEY}",
                        "api": "openai-completions",
                        "models": [
                            {
                                "id": bare_model,
                                "name": bare_model,
                                "reasoning": True,
                                "input": ["text", "image"],
                                "contextWindow": 200000,
                                "maxTokens": 16384,
                                "compat": {
                                    "supportsUsageInStreaming": True,
                                },
                            }
                        ],
                    }
                },
            }
        else:
            self.log.info("  No API key/base URL configured — skipping model provider")
            # Remove any existing invalid model provider entries to prevent
            # startup errors like "Invalid option" for api field
            VALID_API_TYPES = {
                "openai-completions",
                "openai-responses",
                "openai-codex-responses",
                "anthropic-messages",
                "google-generative-ai",
                "github-copilot",
                "bedrock-converse-stream",
                "ollama",
            }
            providers = existing.get("models", {}).get("providers", {})
            invalid = [
                name
                for name, cfg in providers.items()
                if isinstance(cfg, dict) and cfg.get("api") not in VALID_API_TYPES
            ]
            for name in invalid:
                self.log.warn(
                    f"  Removing invalid model provider '{name}' "
                    f"(api: {providers[name].get('api', '<missing>')})"
                )
                del providers[name]
            if invalid and not providers:
                existing.pop("models", None)

        # ── Brave Search API ──
        brave_api_key = self.cfg.get("brave.api_key", "")
        if brave_api_key:
            tools = existing.setdefault("tools", {})
            web = tools.setdefault("web", {})
            web["search"] = {
                "provider": "brave",
                "apiKey": "${BRAVE_API_KEY}",
            }
            self.log.info("  Brave Search API configured")

        # ── Skill whitelist ──
        # Only applied when skills.enable is true in deployer config.
        if self.cfg.get("skills.enable", False):
            allow_bundled = self.cfg.get("skills.allowBundled", [])
            allow_managed = self.cfg.get("skills.allowManaged", [])

            skills_cfg = existing.get("skills", {})

            # Bundled skill restriction: allowBundled=[...] limits which built-in skills load.
            if allow_bundled:
                skills_cfg["allowBundled"] = allow_bundled
            else:
                self.log.warn(
                    "  Skill whitelist: allowBundled is empty — all bundled skills will load"
                )

            # Managed/workspace skill restriction: OpenClaw has no native allowlist for these,
            # so we enumerate any currently known managed skills and disable the ones not
            # on the whitelist via entries.<name>.enabled=false in openclaw.json.
            # An empty allowManaged list with enable=true disables ALL managed/workspace skills.
            if allow_managed is not None:
                entries = skills_cfg.get("entries", {})
                # Skills in the whitelist: ensure enabled=true.
                for name in allow_managed:
                    entry = entries.get(name, {})
                    entry["enabled"] = True
                    entries[name] = entry
                # Skills already tracked in entries that are NOT in the whitelist: disable.
                for name in list(entries.keys()):
                    if name not in allow_managed:
                        entries[name]["enabled"] = False
                skills_cfg["entries"] = entries

            existing["skills"] = skills_cfg
            self.log.info(
                f"  Skill whitelist: bundled={allow_bundled or 'all'}, "
                f"managed={allow_managed if allow_managed else 'none allowed'}"
            )
        else:
            self.log.info("  Skill whitelist: disabled (skills.enable=false in deployer config)")

        # ── Clean stale plugin references ──
        # Previous installs (or the desktop app) may have added plugins.allow
        # and plugins.entries for openclaw-weixin.  If the plugin files were
        # removed during uninstall, these stale references cause
        # `openclaw plugins install` to fail config validation.
        # Strip them now; _enable_weixin_in_config() will re-add after install.
        plugins_cfg = existing.get("plugins", {})
        allow_list = plugins_cfg.get("allow", [])
        if isinstance(allow_list, list) and "openclaw-weixin" in allow_list:
            allow_list.remove("openclaw-weixin")
            plugins_cfg["allow"] = allow_list
            self.log.info("  Removed stale plugins.allow entry for openclaw-weixin")
        p_entries = plugins_cfg.get("entries", {})
        if "openclaw-weixin" in p_entries:
            del p_entries["openclaw-weixin"]
            plugins_cfg["entries"] = p_entries
            self.log.info("  Removed stale plugins.entries for openclaw-weixin")
        if plugins_cfg:
            existing["plugins"] = plugins_cfg

        try:
            config_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
            self.log.success(f"Config written to {config_path}")
            if api_key and base_url:
                self.log.info(f"  Model: {provider_model}")
                self.log.info(f"  Provider: custom → {api_url}")
                self.log.info("  API type: openai-completions")
            else:
                self.log.info("  Model provider not configured — configure later in desktop app")
        except Exception as e:
            self.log.error(f"Config write failed: {e}")
            return False

        # ── Skill catalog (certification metadata for desktop app) ──
        catalog_path = openclaw_dir / "skill_catalog.json"
        try:
            catalog_path.write_text(
                json.dumps(export_catalog_json(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            self.log.success(f"Skill catalog written to {catalog_path}")
        except Exception as e:
            self.log.warn(f"Skill catalog write failed (non-fatal): {e}")

        # ── Managed skill catalog (certification metadata for managed/workspace skills) ──
        managed_catalog_path = openclaw_dir / "managed_skill_catalog.json"
        try:
            managed_catalog_path.write_text(
                json.dumps(export_managed_catalog_json(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            self.log.success(f"Managed skill catalog written to {managed_catalog_path}")
        except Exception as e:
            self.log.warn(f"Managed skill catalog write failed (non-fatal): {e}")

        # ── Deploy bundled managed skills to ~/.openclaw/skills/ ──
        self._deploy_managed_skills(openclaw_dir)

        # ── Install OfficeCLI binary (single exe, no dependencies) ──
        self._install_officecli(openclaw_dir)

        # ── Skill integrity snapshot (SHA-256 hashes + Ed25519 signature) ──
        # Must run AFTER deploying managed skills so the snapshot includes them.
        self._generate_skill_snapshot(openclaw_dir)

        # ── .env file (secrets) — write API keys ──
        env_path = openclaw_dir / ".env"
        brave_api_key = self.cfg.get("brave.api_key", "")
        env_lines = []
        if api_key:
            env_lines.append(f"OPENCLAW_MODEL_API_KEY={api_key}")
        if brave_api_key:
            env_lines.append(f"BRAVE_API_KEY={brave_api_key}")
        if env_lines:
            try:
                env_path.write_text(
                    "\n".join(env_lines) + "\n",
                    encoding="utf-8",
                )
                self.log.success(f"Environment written to {env_path}")
            except Exception as e:
                self.log.warn(f"Env file write: {e}")

        # Register rollback
        def _rollback_config(cp=str(config_path), ep=str(env_path)):
            for p in (cp, ep):
                try:
                    Path(p).unlink(missing_ok=True)
                except Exception:
                    pass

        self._register_rollback("删除配置文件", _rollback_config)

        return True

    def _generate_skill_snapshot(self, openclaw_dir: Path) -> None:
        """Run the Node.js script to generate skill integrity snapshot."""
        node_exe = self.node_dir / "node.exe"
        if not node_exe.exists():
            self.log.warn("Node.js not found — skipping skill integrity snapshot")
            return

        # Locate the snapshot script (bundled in PyInstaller or in project root)
        import sys as _sys

        if getattr(_sys, "frozen", False) and hasattr(_sys, "_MEIPASS"):
            script = Path(_sys._MEIPASS) / "scripts" / "generate-skill-snapshot.js"
        else:
            script = (
                Path(__file__).resolve().parent.parent / "scripts" / "generate-skill-snapshot.js"
            )

        if not script.exists():
            self.log.warn(f"Snapshot script not found at {script} — skipping")
            return

        try:
            result = subprocess.run(
                [str(node_exe), str(script), "--state-dir", str(openclaw_dir)],
                capture_output=True,
                text=True,
                timeout=60,
                creationflags=_CREATE_NO_WINDOW,
            )
            if result.returncode == 0:
                self.log.success("Skill integrity snapshot generated")
                for line in result.stdout.strip().splitlines():
                    self.log.info(f"  {line}")
            else:
                self.log.warn(f"Snapshot generation failed: {result.stderr.strip()}")
        except Exception as e:
            self.log.warn(f"Snapshot generation failed (non-fatal): {e}")

    # ────────────────────── Desktop Client ──────────────────────

    def _find_local_desktop_zip(self) -> Path | None:
        """Look for a bundled desktop zip in _MEIPASS, next to exe, or project root."""
        import sys

        candidates = []
        # Bundled inside PyInstaller exe (_MEIPASS)
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS) / "microclaw-portable.zip")
        # Next to the exe (distribution scenario)
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys.executable).parent / "microclaw-portable.zip")
        # Project root (development scenario)
        project_root = Path(__file__).resolve().parent.parent
        candidates.append(project_root / "microclaw-portable.zip")
        candidates.append(project_root / "dist" / "microclaw-portable.zip")
        for p in candidates:
            if p.exists():
                return p
        return None

    def install_desktop_client(self) -> bool:
        """Install MicroClawDesktop (Electron portable).

        Priority: local zip next to exe > network download.
        """
        install_dir = DEFAULT_DESKTOP_DIR

        # If already installed, overwrite with bundled version
        exe_path = install_dir / "MicroClawDesktop.exe"
        if exe_path.exists():
            self.log.info("检测到已有桌面客户端，将覆盖更新…")
            if self._desktop_process_roots(self._process_snapshot()):
                self.log.error(
                    "MicroClaw restarted during the upgrade. Exit it from the system tray and retry."
                )
                return False
            # Overlay the verified archive instead of deleting the whole
            # MicroClaw root: active upgrade manifests and backups live under
            # this directory and must survive until the transaction commits.

        # 1. Try local bundled zip
        local_zip = self._find_local_desktop_zip()
        if local_zip:
            self.log.step(f"从本地安装桌面客户端 ({local_zip.name})…")
            return self._extract_desktop_zip(local_zip, install_dir)

        # 2. Try network download
        download_url = self.cfg.get("desktop.download_url", "")
        if not download_url:
            self.log.warn("未找到本地桌面客户端包，也未配置下载地址，跳过客户端安装")
            return True  # Non-fatal

        if not download_url.startswith(("https://", "http://")):
            self.log.error(f"Invalid desktop download URL: {download_url!r}")
            return False

        self.log.step("下载 MicroClawDesktop 桌面客户端…")
        try:
            tmp_dir = Path(tempfile.mkdtemp(prefix="microclaw_"))
            zip_path = tmp_dir / "microclaw.zip"
            self._download_with_progress(download_url, zip_path)
            result = self._extract_desktop_zip(zip_path, install_dir)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return result
        except Exception as e:
            self.log.error(f"桌面客户端下载失败: {e}")
            return False

    def _extract_desktop_zip(self, zip_path: Path, install_dir: Path) -> bool:
        """Extract a desktop client zip to install_dir."""
        if not zipfile.is_zipfile(zip_path):
            self.log.error("文件不是有效的 zip 包")
            return False

        self.log.step("解压桌面客户端…")
        install_dir.mkdir(parents=True, exist_ok=True)

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(install_dir)
        except Exception as e:
            self.log.error(f"解压失败: {e}")
            return False

        exe_path = install_dir / "MicroClawDesktop.exe"

        # electron-builder portable may nest inside a subfolder
        # e.g. "win-unpacked/" — detect and flatten if needed
        subdirs = [d for d in install_dir.iterdir() if d.is_dir()]
        if not exe_path.exists() and len(subdirs) == 1:
            nested_exe = subdirs[0] / "MicroClawDesktop.exe"
            if nested_exe.exists():
                for item in subdirs[0].iterdir():
                    dest = install_dir / item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest)
                        else:
                            dest.unlink()
                    shutil.move(str(item), str(dest))
                subdirs[0].rmdir()

        if exe_path.exists():
            self.log.success(f"桌面客户端安装到 {install_dir}")

            def _rollback_desktop(d=str(install_dir)):
                shutil.rmtree(d, ignore_errors=True)

            self._register_rollback("删除桌面客户端", _rollback_desktop)
            return True

        # Try to find exe with different name
        exes = list(install_dir.glob("*.exe"))
        if exes:
            self.log.success(f"桌面客户端安装到 {install_dir} (exe: {exes[0].name})")

            def _rollback_desktop(d=str(install_dir)):
                shutil.rmtree(d, ignore_errors=True)

            self._register_rollback("删除桌面客户端", _rollback_desktop)
            return True

        self.log.error("解压后未找到可执行文件")
        shutil.rmtree(install_dir, ignore_errors=True)
        return False

    def _find_desktop_exe(self) -> Path | None:
        """Find the desktop client exe."""
        install_dir = DEFAULT_DESKTOP_DIR
        # Primary name
        exe = install_dir / "MicroClawDesktop.exe"
        if exe.exists():
            return exe
        # Fallback: any exe in the directory
        exes = list(install_dir.glob("*.exe"))
        return exes[0] if exes else None

    # ────────────────────── Weixin Plugin ──────────────────────

    def _find_bundled_weixin_plugin(self) -> Path | None:
        """Find the bundled openclaw-weixin plugin directory."""
        import sys

        candidates = []
        # Bundled inside PyInstaller exe (_MEIPASS)
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS) / "plugins" / "openclaw-weixin")
        # Next to the exe (distribution scenario)
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys.executable).parent / "plugins" / "openclaw-weixin")
        # Project root (development scenario)
        project_root = Path(__file__).resolve().parent.parent
        candidates.append(project_root / "plugins" / "openclaw-weixin")
        for p in candidates:
            if p.is_dir() and (p / "package.json").exists():
                return p
        return None

    def _enable_weixin_in_config(self):
        """Enable openclaw-weixin plugin in openclaw.json after installation.

        Also fixes the ``sourcePath`` recorded by ``openclaw plugins install``:
        the original value points to a PyInstaller temp directory that is
        deleted after the installer exits.  We rewrite it to match the
        permanent ``installPath`` so the gateway can resolve the plugin on
        any machine.
        """
        import json

        config_path = Path.home() / ".openclaw" / "openclaw.json"
        try:
            config = (
                json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
            )
            plugins = config.setdefault("plugins", {})
            entries = plugins.setdefault("entries", {})
            entries.setdefault("openclaw-weixin", {})["enabled"] = True

            # Fix sourcePath → installPath so it survives across machines
            installs = plugins.get("installs", {})
            wx_install = installs.get("openclaw-weixin")
            if isinstance(wx_install, dict):
                install_path = wx_install.get("installPath", "")
                if install_path:
                    wx_install["source"] = "path"
                    wx_install["sourcePath"] = install_path
                    self.log.info(f"  已将 sourcePath 修正为 {install_path}")

            config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
            self.log.info("  已在配置中启用插件")
        except Exception as e:
            self.log.warn(f"  无法在配置中启用插件: {e}")

    def install_weixin_plugin(self) -> bool:
        """Install the openclaw-weixin plugin via 'openclaw plugins install'."""
        self.log.step("正在安装插件…")

        plugin_dir = self._find_bundled_weixin_plugin()
        if not plugin_dir:
            self.log.error("未找到插件安装包")
            return False

        openclaw_cmd = self._find_openclaw_cmd()
        if not openclaw_cmd:
            self.log.error("未找到 openclaw 命令，无法安装插件")
            return False

        env = self._get_env()
        # Enable V8 compile cache so the openclaw CLI cold-start is fast
        state_dir = Path.home() / ".openclaw"
        cache_dir = state_dir / "compile-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        env["NODE_COMPILE_CACHE"] = str(cache_dir)
        env["OPENCLAW_STATE_DIR"] = str(state_dir)

        # Remove stale extension directory so 'openclaw plugins install' won't
        # fail with "plugin already exists".
        existing = state_dir / "extensions" / "openclaw-weixin"
        if existing.exists():
            self.log.info("  删除旧版插件目录…")
            shutil.rmtree(existing, ignore_errors=True)

        try:
            proc = subprocess.Popen(
                openclaw_cmd + ["plugins", "install", str(plugin_dir)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=_CREATE_NO_WINDOW,
            )
            for line in proc.stdout:
                stripped = line.rstrip()
                if stripped:
                    self.log.info(f"  plugin: {stripped}")
            proc.wait(timeout=120)

            if proc.returncode == 0:
                self.log.success("插件安装成功")
                # Enable the plugin in openclaw.json
                self._enable_weixin_in_config()
                return True
            else:
                self.log.error(f"插件安装失败 (exit {proc.returncode})")
                return False
        except subprocess.TimeoutExpired:
            self.log.error("插件安装超时")
            return False
        except Exception as e:
            self.log.error(f"插件安装失败: {e}")
            return False

    def create_desktop_shortcut(self) -> bool:
        """Create a desktop shortcut for the MicroClawDesktop client."""
        self.log.step("Creating desktop shortcut…")

        desktop = self._get_desktop_path()
        desktop_exe = self._find_desktop_exe()

        if desktop_exe:
            ok = self._create_lnk_shortcut(desktop, desktop_exe)
        else:
            self.log.info("桌面客户端未安装，创建浏览器快捷方式作为备选")
            ok = self._create_url_shortcut(desktop)

        # Also create uninstall shortcut
        self._create_uninstall_shortcut(desktop)
        return ok

    def _create_uninstall_shortcut(self, desktop: Path) -> bool:
        """Copy installer to ~/.openclaw/ and create an uninstall shortcut on desktop."""
        import sys

        shortcut_path = desktop / "Uninstall MicroClaw.lnk"

        # Copy installer exe to a persistent location
        openclaw_dir = Path.home() / ".openclaw"
        openclaw_dir.mkdir(parents=True, exist_ok=True)
        installer_dest = openclaw_dir / "MicroClawInstaller.exe"

        if getattr(sys, "frozen", False):
            src = Path(sys.executable)
            if src.exists() and src != installer_dest:
                try:
                    shutil.copy2(src, installer_dest)
                    # In onedir mode, PyInstaller places dependencies in _internal/
                    # next to the exe. Copy it so the uninstall exe can actually run.
                    src_internal = src.parent / "_internal"
                    if src_internal.is_dir():
                        dest_internal = openclaw_dir / "_internal"
                        if dest_internal.exists():
                            shutil.rmtree(dest_internal)
                        shutil.copytree(src_internal, dest_internal)
                    self.log.info(f"安装程序已复制到 {installer_dest}")
                except Exception as e:
                    self.log.warn(f"无法复制安装程序: {e}")
                    return False
        elif not installer_dest.exists():
            self.log.info("非打包模式，跳过卸载快捷方式创建")
            return True

        try:
            ico_path = self._resolve_uninstall_icon()
            ico_arg = ""
            if ico_path:
                ico_arg = f'$s.IconLocation = "{ico_path},0";'

            # Use single-quoted paths in PowerShell to avoid interpolation issues,
            # then cast to [string] for CreateShortcut which expects a string argument.
            ps_script = (
                f"$ws = New-Object -ComObject WScript.Shell;"
                f"$s = $ws.CreateShortcut([string]'{shortcut_path}');"
                f"$s.TargetPath = [string]'{installer_dest}';"
                f'$s.Arguments = "--uninstall";'
                f"$s.WorkingDirectory = [string]'{installer_dest.parent}';"
                f"$s.Description = 'Uninstall MicroClaw';"
                f"{ico_arg}"
                f"$s.Save()"
            )
            import base64

            encoded = base64.b64encode(ps_script.encode("utf-16-le")).decode("ascii")
            r = self._run(
                ["powershell", "-NoProfile", "-EncodedCommand", encoded],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )

            if shortcut_path.exists():
                self.log.success(f"卸载快捷方式已创建: {shortcut_path}")
                return True

            self.log.warn(
                f"卸载快捷方式创建失败 (stdout={r.stdout.strip()}, stderr={r.stderr.strip()}, rc={r.returncode})"
            )
            return False
        except Exception as e:
            self.log.warn(f"创建卸载快捷方式异常: {e}")
            return False

    def _get_desktop_path(self) -> Path:
        """Resolve the user's Desktop folder path."""
        # Always prefer the registry value — it reflects the actual Desktop
        # location even when the folder has been redirected (e.g. OneDrive,
        # Chinese Windows, or custom shell folder paths).
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            )
            desktop_val, _ = winreg.QueryValueEx(key, "Desktop")
            winreg.CloseKey(key)
            desktop = Path(os.path.expandvars(desktop_val))
            if desktop.exists():
                return desktop
        except Exception:
            pass
        return Path.home() / "Desktop"

    def _create_lnk_shortcut(self, desktop: Path, target_exe: Path) -> bool:
        """Create a proper .lnk shortcut to the Electron app via PowerShell."""
        shortcut_path = desktop / "MicroClawDesktop.lnk"
        # Remove stale .url shortcut if exists
        stale_url = desktop / "OpenClaw.url"
        stale_url.unlink(missing_ok=True)
        stale_lnk = desktop / "OpenClaw.lnk"
        stale_lnk.unlink(missing_ok=True)

        try:
            # Find icon
            ico_path = self._resolve_icon()
            ico_arg = ""
            if ico_path:
                ico_arg = f'$s.IconLocation = "{ico_path},0";'

            ps_script = (
                f"$ws = New-Object -ComObject WScript.Shell;"
                f'$s = $ws.CreateShortcut("{shortcut_path}");'
                f'$s.TargetPath = "{target_exe}";'
                f'$s.WorkingDirectory = "{target_exe.parent}";'
                f'$s.Description = "MicroClawDesktop";'
                f"{ico_arg}"
                f"$s.Save()"
            )
            # Use -EncodedCommand to avoid encoding/escaping issues with
            # non-ASCII characters (e.g. Chinese Desktop folder names) and
            # spaces in paths.
            import base64

            encoded = base64.b64encode(ps_script.encode("utf-16-le")).decode("ascii")
            self._run(
                ["powershell", "-NoProfile", "-EncodedCommand", encoded],
                capture_output=True,
                timeout=15,
            )

            if shortcut_path.exists():
                self.log.success(f"Desktop shortcut created: {shortcut_path}")

                def _rollback_shortcut(p=str(shortcut_path)):
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass

                self._register_rollback("删除桌面快捷方式", _rollback_shortcut)
                return True

            self.log.warn("PowerShell shortcut creation returned but .lnk not found")
            return self._create_url_shortcut(desktop)

        except Exception as e:
            self.log.warn(f"LNK shortcut failed ({e}), falling back to URL shortcut")
            return self._create_url_shortcut(desktop)

    def _create_url_shortcut(self, desktop: Path) -> bool:
        """Fallback: create a .url shortcut to the gateway dashboard."""
        port = self.cfg.get("gateway.port", 18789)

        import json

        config_path = Path.home() / ".openclaw" / "openclaw.json"
        token = ""
        try:
            cfg_data = json.loads(config_path.read_text(encoding="utf-8"))
            token = cfg_data.get("gateway", {}).get("auth", {}).get("token", "")
        except Exception:
            pass

        url = f"http://127.0.0.1:{port}/"
        if token:
            url += f"#token={token}"

        shortcut_path = desktop / "MicroClawDesktop.url"
        try:
            content = f"[InternetShortcut]\nURL={url}\nIconIndex=0\n"
            ico_path = self._resolve_icon()
            if ico_path:
                content = f"[InternetShortcut]\nURL={url}\nIconFile={ico_path}\nIconIndex=0\n"
            shortcut_path.write_text(content, encoding="utf-8")
            self.log.success(f"Desktop shortcut created: {shortcut_path}")

            def _rollback_shortcut(p=str(shortcut_path)):
                try:
                    Path(p).unlink(missing_ok=True)
                except Exception:
                    pass

            self._register_rollback("删除桌面快捷方式", _rollback_shortcut)
            return True
        except Exception as e:
            self.log.warn(f"Could not create desktop shortcut: {e}")
            return True  # Non-fatal

    # ────────────────────── AppContainer ──────────────────────

    def provision_appcontainer(self) -> bool:
        """Provision AppContainer sandbox for MicroClaw (Windows 10 2004+).

        Creates the AppContainer profile, grants directory ACLs, and adds
        loopback network exemption. Does NOT require admin unless the
        optional C:\\ traverse ACL setup is wanted.
        """
        launcher = self._find_appcontainer_launcher()
        if not launcher:
            self.log.info("AppContainerLauncher 未找到，跳过 AppContainer 配置")
            return False

        self.log.step("配置 AppContainer 沙箱…")
        container_name = "MicroClaw"

        # 1. Check OS support
        try:
            result = subprocess.run(
                [str(launcher), "check"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception as e:
            self.log.warn(f"AppContainer 检测失败: {e}")
            return False
        if result.returncode != 0:
            # returncode 1 = OS not supported; other codes = launcher error
            stderr = result.stderr.strip()
            stdout = result.stdout.strip()
            if result.returncode == 1 and '"supported":false' in (stdout or "").replace(" ", ""):
                self.log.warn("此 Windows 版本不支持 AppContainer，跳过")
            else:
                detail = stderr or stdout or f"exit code {result.returncode}"
                self.log.warn(f"AppContainer 检测失败 ({detail})，跳过")
            return False

        # 2. Create profile
        result = subprocess.run(
            [str(launcher), "sid", "--name", container_name],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=_CREATE_NO_WINDOW,
        )
        sid = result.stdout.strip().split("\n")[-1]
        self.log.info(f"AppContainer SID: {sid}")

        # 3. Grant directory ACLs
        home = Path.home()
        # Ensure sandbox workspace directory exists
        sandbox_dir = home / ".openclaw" / "sandbox"
        sandbox_dir.mkdir(parents=True, exist_ok=True)

        dirs_to_grant = [
            (str(self.node_dir), "r"),
            (str(self.node_dir / "node_modules"), "r"),
            (str(home / ".openclaw"), "rw"),
            (str(sandbox_dir), "rw"),  # Tool execution sandbox workspace
        ]
        # Legacy zip-extract layout — still grant if present so upgrades
        # from older builds keep working.
        for legacy in LEGACY_NODE_DIRS:
            if legacy.exists() and str(legacy) != str(self.node_dir):
                dirs_to_grant.append((str(legacy), "r"))
                dirs_to_grant.append((str(legacy / "node_modules"), "r"))
        # Grant access to system Temp directory
        temp_dir = os.environ.get("TEMP", os.environ.get("TMP", ""))
        if temp_dir:
            dirs_to_grant.append((temp_dir, "rw"))

        grant_failures = []
        for dir_path, access in dirs_to_grant:
            if Path(dir_path).exists():
                try:
                    subprocess.run(
                        [
                            str(launcher),
                            "grant",
                            "--name",
                            container_name,
                            "--dir",
                            dir_path,
                            "--access",
                            access,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=30,
                        creationflags=_CREATE_NO_WINDOW,
                    )
                except subprocess.TimeoutExpired:
                    self.log.warn(f"ACL grant 超时 (30s): {dir_path} — 将在应用启动时重试")
                    grant_failures.append(dir_path)
                except Exception as e:
                    self.log.warn(f"ACL grant 失败: {dir_path} — {e}")
                    grant_failures.append(dir_path)

        # 3b. Grant minimal traverse (no inherit) on user home and C:\Users
        # so Node.js realpathSync() can lstat ancestor directories.
        # This does NOT give read access to other user profile contents.
        for ancestor in [str(home), str(home.parent)]:
            if Path(ancestor).exists():
                try:
                    subprocess.run(
                        ["icacls", ancestor, "/grant", f"{sid}:(REA,RA,X)"],
                        capture_output=True,
                        text=True,
                        timeout=30,
                        creationflags=_CREATE_NO_WINDOW,
                    )
                except Exception as e:
                    self.log.warn(f"Traverse ACL 设置失败: {ancestor} — {e}")

        # 3c. Grant traverse on all fixed drive roots + C:\Users (needs admin elevation)
        # This lets AppContainer processes reach paths on any drive (e.g. D:\Documents).
        try:
            setup_result = subprocess.run(
                [str(launcher), "setup", "--name", container_name],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception as e:
            self.log.warn(f"AppContainer setup 失败: {e}")
            setup_result = type("R", (), {"returncode": 1})()
        if setup_result.returncode != 0:
            self.log.info("AppContainer setup 需要管理员权限，正在请求提权...")
            try:
                launcher_escaped = str(launcher).replace("'", "''")
                ps_cmd = (
                    f"Start-Process -FilePath '{launcher_escaped}' "
                    f"-ArgumentList @('setup','--name','{container_name}') "
                    f"-Verb RunAs -Wait -WindowStyle Hidden"
                )
                subprocess.run(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    creationflags=_CREATE_NO_WINDOW,
                )
            except Exception as e:
                self.log.warn(f"AppContainer setup 提权失败: {e}")

        # 4. Add loopback exemption
        try:
            subprocess.run(
                [str(launcher), "loopback", "--name", container_name],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception as e:
            self.log.warn(f"Loopback 豁免设置失败: {e}")

        if grant_failures:
            self.log.warn(
                f"部分 ACL 设置未完成 ({len(grant_failures)} 个目录)，应用启动时将自动重试"
            )
        self.log.success(f"AppContainer 沙箱 '{container_name}' 配置完成")
        return True

    def _find_appcontainer_launcher(self) -> Path | None:
        """Find AppContainerLauncher.exe."""
        candidates = [
            # Bundled with installed desktop client
            DEFAULT_DESKTOP_DIR / "resources" / "AppContainerLauncher.exe",
            # Adjacent to deployer in the repo (dev only)
            Path(__file__).parent.parent
            / "appcontainer"
            / "bin"
            / "Release"
            / "net9.0-windows"
            / "win-x64"
            / "AppContainerLauncher.exe",
        ]
        for c in candidates:
            if c and c.exists():
                return c
        return None

    def _uninstall_appcontainer(self) -> None:
        """Remove AppContainer profile and revoke ACLs."""
        launcher = self._find_appcontainer_launcher()
        if not launcher:
            return
        container_name = "MicroClaw"
        try:
            # Collect all directories that need ACL revocation:
            # 1. Default provisioned directories
            home = Path.home()
            dirs_to_revoke: list[str] = [
                str(self.node_dir),
                str(self.node_dir / "node_modules"),
                str(home / ".openclaw"),
                str(Path(os.environ.get("LOCALAPPDATA", "")) / "Temp"),
            ]
            for legacy in LEGACY_NODE_DIRS:
                if str(legacy) != str(self.node_dir):
                    dirs_to_revoke.append(str(legacy))
                    dirs_to_revoke.append(str(legacy / "node_modules"))

            # 2. User-added directories from electron-store settings
            #    (sandboxGrantHistory tracks every directory we ever granted ACLs to)
            appdata = os.environ.get("APPDATA", "")
            if appdata:
                settings_file = Path(appdata) / "microclaw" / "settings.json"
                if settings_file.exists():
                    try:
                        import json

                        settings = json.loads(settings_file.read_text(encoding="utf-8"))
                        for key in (
                            "sandboxGrantHistory",
                            "sandboxUserDirsRW",
                            "sandboxUserDirsRO",
                        ):
                            for d in settings.get(key, []):
                                if d and d not in dirs_to_revoke:
                                    dirs_to_revoke.append(d)
                        self.log.info(
                            f"  从 settings.json 读取到 {len(dirs_to_revoke)} 个 ACL 目录"
                        )
                    except Exception as e:
                        self.log.warn(f"  读取 settings.json 失败: {e}")

            # Revoke directory ACLs
            for dir_path in dirs_to_revoke:
                if Path(dir_path).exists():
                    subprocess.run(
                        [str(launcher), "revoke", "--name", container_name, "--dir", dir_path],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        creationflags=_CREATE_NO_WINDOW,
                    )
            # Remove loopback exemption
            subprocess.run(
                [str(launcher), "loopback", "--name", container_name, "--remove"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=_CREATE_NO_WINDOW,
            )
            # Delete profile (also removes ancestor traverse ACLs since the SID is deleted)
            subprocess.run(
                [str(launcher), "delete", "--name", container_name],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=_CREATE_NO_WINDOW,
            )
            self.log.info("AppContainer profile 已删除")
        except Exception as e:
            self.log.warn(f"AppContainer 清理失败: {e}")

    # ────────────────────── Uninstall ──────────────────────

    def _uninstall_stop_daemon(self) -> None:
        """Stop the openclaw daemon (scheduled task)."""
        self.log.step("停止守护进程…")

        # Fast path: check if the scheduled task even exists before invoking
        # the slow openclaw CLI (which takes 20-80s to cold-start via Node.js).
        try:
            r = self._run(
                ["schtasks", "/Query", "/TN", "OpenClaw Gateway"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode != 0:
                self.log.info("  守护进程未安装，跳过")
                return
        except Exception:
            self.log.info("  守护进程未安装，跳过")
            return

        # Task exists — stop and unregister it directly via schtasks
        try:
            self._run(
                ["schtasks", "/End", "/TN", "OpenClaw Gateway"],
                capture_output=True,
                timeout=10,
            )
            self.log.info("  已停止守护进程任务")
        except Exception:
            pass
        try:
            self._run(
                ["schtasks", "/Delete", "/TN", "OpenClaw Gateway", "/F"],
                capture_output=True,
                timeout=10,
            )
            self.log.info("  已删除守护进程任务")
        except Exception:
            pass

    @staticmethod
    def _clean_gateway_lock_files(log=None) -> int:
        """Remove stale gateway lock files from %LOCALAPPDATA%/Temp/openclaw/.

        OpenClaw stores gateway locks at:
          <LOCALAPPDATA>/Temp/openclaw/gateway.<hash>.lock
        These locks persist after a force-kill and block the next gateway start.
        Returns the number of lock files removed.
        """
        import glob

        lock_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Temp" / "openclaw"
        removed = 0
        for lock_file in glob.glob(str(lock_dir / "gateway.*.lock")):
            try:
                Path(lock_file).unlink()
                removed += 1
                if log:
                    log.info(f"  已删除锁文件 {Path(lock_file).name}")
            except Exception:
                pass
        return removed

    def _uninstall_stop_gateway(self) -> None:
        """Stop the openclaw gateway process."""
        self.log.step("停止网关服务…")
        # Kill node.exe processes running the gateway directly — much faster
        # than invoking `openclaw gateway stop` which cold-starts Node.js CLI.
        try:
            r = self._run(
                ["taskkill", "/F", "/IM", "node.exe", "/T"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode == 0:
                self.log.info("  已终止 node.exe 进程")
                time.sleep(2)
            else:
                self.log.info("  node.exe 未运行")
        except Exception:
            self.log.info("  node.exe 未运行")
        # Always clean stale lock files (they survive force-kill)
        self._clean_gateway_lock_files(self.log)

    def _uninstall_kill_desktop(self) -> None:
        """Kill desktop client processes."""
        self.log.step("关闭桌面客户端…")
        for exe in ("MicroClawDesktop.exe", "OpenClaw.exe"):
            try:
                r = self._run(
                    ["taskkill", "/F", "/IM", exe], capture_output=True, text=True, timeout=10
                )
                if r.returncode == 0:
                    self.log.info(f"  已终止 {exe}")
                else:
                    self.log.info(f"  {exe} 未运行")
            except Exception:
                self.log.info(f"  {exe} 未运行")
        time.sleep(1)

    def _uninstall_npm(self) -> None:
        """Uninstall openclaw from system-level npm global (if any).

        The managed .openclaw-node is deleted entirely by _uninstall_clean_node,
        but a system Node.js (e.g. C:\\Program Files\\nodejs) may also have
        openclaw installed globally.  Clean that up too.
        """
        self.log.step("清理系统全局 openclaw…")

        # 1. Try system npm (not our managed one — that gets rmtree'd later)
        system_npm = None
        for candidate in [
            Path("C:/Program Files/nodejs/npm.cmd"),
            Path("C:/Program Files (x86)/nodejs/npm.cmd"),
        ]:
            if candidate.exists():
                system_npm = str(candidate)
                break
        if not system_npm:
            # Search PATH but skip our managed dir
            for p in os.environ.get("PATH", "").split(os.pathsep):
                npm_cmd = Path(p) / "npm.cmd"
                if npm_cmd.exists() and str(self.node_dir) not in str(npm_cmd):
                    system_npm = str(npm_cmd)
                    break

        if system_npm:
            try:
                r = self._run(
                    [system_npm, "uninstall", "-g", "openclaw"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=30,
                )
                if r.returncode == 0:
                    self.log.info(f"  已从系统 npm 卸载 openclaw ({system_npm})")
                else:
                    self.log.info("  系统 npm 无全局 openclaw")
            except Exception:
                self.log.info("  系统 npm uninstall 跳过")
        else:
            self.log.info("  未找到系统 npm")

        # 2. Direct cleanup: remove openclaw files from %APPDATA%\npm
        npm_global = Path(os.environ.get("APPDATA", "")) / "npm"
        if npm_global.exists():
            # Remove openclaw shims
            for name in ("openclaw", "openclaw.cmd", "openclaw.ps1"):
                p = npm_global / name
                if p.exists():
                    try:
                        p.unlink()
                        self.log.info(f"  已删除 {p}")
                    except Exception:
                        pass
            # Remove openclaw package dir
            pkg_dir = npm_global / "node_modules" / "openclaw"
            if pkg_dir.exists():
                shutil.rmtree(pkg_dir, ignore_errors=True)
                self.log.info(f"  已删除 {pkg_dir}")

    def _uninstall_clean_node(self) -> None:
        """Uninstall Node.js and clean PATH — but only if MicroClaw installed it.

        A user may have installed Node.js themselves before installing
        MicroClaw (e.g. for the build, via winget, nvm, or the official
        installer).  Uninstalling MicroClaw must NOT remove their Node.

        Logic:
          * Legacy ``~/.openclaw-node`` (zip-extracted by earlier builds) is
            unambiguously ours — always cleaned up.
          * ``self.node_dir`` (e.g. ``C:\\Program Files\\nodejs``) is only
            touched if the ``~/.openclaw/.node-installed-by-microclaw``
            marker file is present and records that exact path.
          * Without the marker, MSI uninstall is skipped entirely.
        """
        self.log.step("清理 Node 环境…")

        owned_path = self._node_install_owned_by_microclaw()
        if owned_path is None:
            self.log.info("  未发现 MicroClaw 安装 Node 的标记 — 保留用户自带的 Node.js")

        # Step 1: MSI uninstall — only for the Node we installed ourselves.
        if owned_path is not None:
            self._msi_uninstall_node(owned_path)

        # Step 2: Remove residual files.
        #   - Legacy ~/.openclaw-node is always ours.
        #   - self.node_dir is only ours when owned_path matches it.
        candidate_dirs: list[Path] = list(LEGACY_NODE_DIRS)
        if owned_path is not None:
            candidate_dirs.insert(0, owned_path)

        seen: set[str] = set()
        for node_dir in candidate_dirs:
            key = str(node_dir).lower()
            if key in seen:
                continue
            seen.add(key)
            if not node_dir.exists():
                self.log.info(f"  {node_dir} 不存在，跳过")
                continue
            self._remove_from_system_path(str(node_dir))
            self.log.info(f"  从 PATH 中移除 {node_dir}")
            try:
                count = sum(1 for _ in node_dir.rglob("*") if _.is_file())
                self.log.info(f"  正在删除 {count} 个文件…")
            except Exception:
                pass
            # Retry rmtree — Windows may still hold file handles briefly
            # after taskkill returns (especially for node.exe).
            for attempt in range(3):
                shutil.rmtree(node_dir, ignore_errors=True)
                if not node_dir.exists():
                    break
                try:
                    remaining = [p.name for p in node_dir.iterdir()]
                except Exception:
                    remaining = []
                self.log.info(f"  删除重试 {attempt + 1}/3，残留文件: {remaining}")
                time.sleep(2)
            if node_dir.exists():
                self.log.warn(f"  {node_dir} 未完全删除，残留文件将在下次安装时覆盖")
            else:
                self.log.info(f"  已删除 {node_dir}")

        # Clean npm global bin from PATH only if we removed the Node that
        # populated it.  Otherwise leave the user's npm shims alone.
        if owned_path is not None:
            npm_global = Path.home() / "AppData" / "Roaming" / "npm"
            self._remove_from_system_path(str(npm_global))
            self.log.info(f"  从 PATH 中移除 {npm_global}")

        # Broadcast WM_SETTINGCHANGE so Explorer picks up PATH changes
        try:
            import ctypes

            HWND_BROADCAST = 0xFFFF
            WM_SETTINGCHANGE = 0x001A
            ctypes.windll.user32.SendMessageTimeoutW(
                HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", 0x0002, 5000, None
            )
        except Exception:
            pass

    # ── Node ownership marker ──
    #
    # Drop a sentinel file when we install Node ourselves so the uninstaller
    # can distinguish a MicroClaw-managed Node from a user-installed one.

    @staticmethod
    def _node_owner_marker_path() -> Path:
        return Path.home() / ".openclaw" / ".node-installed-by-microclaw"

    def _mark_node_owned_by_microclaw(self, install_dir: Path) -> None:
        """Persist that MicroClaw installed Node.js at *install_dir*."""
        marker = self._node_owner_marker_path()
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(str(install_dir), encoding="utf-8")
            self.log.debug(f"  Recorded Node ownership marker: {marker}")
        except Exception as e:
            self.log.warn(f"  Could not record Node ownership marker: {e}")

    def _node_install_owned_by_microclaw(self) -> Path | None:
        """Return the Node install path MicroClaw owns, or None if not ours.

        Reads the ownership marker written by ``_mark_node_owned_by_microclaw``.
        Returns ``None`` (treat Node as user-installed) when the marker is
        missing or unreadable.
        """
        marker = self._node_owner_marker_path()
        if not marker.exists():
            return None
        try:
            recorded = Path(marker.read_text(encoding="utf-8").strip())
        except Exception as e:
            self.log.warn(f"  Could not read Node ownership marker: {e}")
            return None
        if not recorded:
            return None
        return recorded

    def _msi_uninstall_node(self, owned_path: Path) -> None:
        """Run ``msiexec /x`` for the Node.js MSI MicroClaw installed.

        Inspects both the per-user (HKCU) and per-machine (HKLM) Uninstall
        registry hives and only removes entries whose ``InstallLocation``
        matches *owned_path* (the directory recorded in the ownership
        marker).  This prevents removing a Node install the user did
        themselves and that happens to share the same DisplayName prefix.
        """
        try:
            import winreg
        except Exception:
            return

        try:
            owned_resolved = owned_path.resolve()
        except Exception:
            owned_resolved = owned_path

        def _matches_owned(install_location: str) -> bool:
            if not install_location:
                return False
            try:
                p = Path(install_location.rstrip("\\/")).resolve()
            except Exception:
                p = Path(install_location.rstrip("\\/"))
            return str(p).lower() == str(owned_resolved).lower()

        hives = [
            (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
            (
                winreg.HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                winreg.HKEY_LOCAL_MACHINE,
                r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ]

        product_codes: list[str] = []
        for hive, subkey in hives:
            try:
                key = winreg.OpenKey(hive, subkey)
            except OSError:
                continue
            try:
                idx = 0
                while True:
                    try:
                        name = winreg.EnumKey(key, idx)
                    except OSError:
                        break
                    idx += 1
                    # Product codes look like {GUID}; skip everything else
                    if not (name.startswith("{") and name.endswith("}")):
                        continue
                    try:
                        sub = winreg.OpenKey(key, name)
                        display, _ = winreg.QueryValueEx(sub, "DisplayName")
                        try:
                            install_location, _ = winreg.QueryValueEx(sub, "InstallLocation")
                        except OSError:
                            install_location = ""
                        winreg.CloseKey(sub)
                    except OSError:
                        continue
                    if "node.js" not in str(display).lower():
                        continue
                    # Only target the Node MSI MicroClaw installed.  This
                    # protects user-installed Node from being collateral
                    # damage when MicroClaw is uninstalled.
                    if not _matches_owned(str(install_location)):
                        self.log.info(
                            f"  跳过非 MicroClaw 安装的 Node.js: {display} "
                            f"({install_location or '未知路径'})"
                        )
                        continue
                    product_codes.append(name)
            finally:
                winreg.CloseKey(key)

        for code in product_codes:
            self.log.info(f"  msiexec /x {code} (Node.js)")
            try:
                ps = (
                    f"$p = Start-Process -FilePath msiexec.exe "
                    f"-ArgumentList '/x {code} /qn /norestart' "
                    f"-Verb RunAs -Wait -PassThru -WindowStyle Hidden; "
                    f"exit $p.ExitCode"
                )
                self._run(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        ps,
                    ],
                    capture_output=True,
                    timeout=300,
                )
            except Exception as e:
                self.log.debug(f"  msi uninstall {code} failed: {e}")

    def _uninstall_clean_git(self) -> None:
        """Remove the managed PortableGit directory (~/.openclaw-git)."""
        self.log.step("清理 Git…")
        git_dir = Path.home() / ".openclaw-git"
        if not git_dir.exists():
            self.log.info(f"  {git_dir} 不存在，跳过")
            return
        for bin_name in ("bin", "cmd", "mingw64/bin"):
            self._remove_from_system_path(str(git_dir / bin_name))
        for _ in range(3):
            shutil.rmtree(git_dir, ignore_errors=True)
            if not git_dir.exists():
                break
            time.sleep(2)
        if git_dir.exists():
            self.log.warn(f"  {git_dir} 未完全删除")
        else:
            self.log.info(f"  已删除 {git_dir}")

    def _uninstall_clean_openclaw_state(self) -> None:
        """Remove the entire ~/.openclaw directory (config, .env, skills, extensions).

        Used by the full one-click uninstall. The older _uninstall_clean_config
        preserves openclaw.json and .env; this stronger variant removes everything
        because we are also removing the Node/OpenClaw runtime.
        """
        self.log.step("清理 OpenClaw 配置…")
        openclaw_dir = Path.home() / ".openclaw"
        if not openclaw_dir.exists():
            self.log.info("  配置目录不存在，跳过")
            return
        # Preserve the uninstaller binary itself (we're running from it)
        # by moving it to %TEMP% before the rmtree.
        # NOTE: onedir PyInstaller needs _internal/ alongside the exe, so we
        # just skip deletion — a lingering ~/.openclaw with only the installer
        # bundle is harmless and will be overwritten on re-install.
        preserved = {
            "MicroClawInstaller.exe",
            "_internal",
            "microclaw.ico",
            "microclaw-uninstall.ico",
        }
        for item in openclaw_dir.iterdir():
            if item.name in preserved:
                continue
            try:
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink()
                self.log.info(f"  删除 {item.name}")
            except Exception as e:
                self.log.warn(f"  无法删除 {item.name}: {e}")

    def _uninstall_clean_official(self) -> None:
        """Remove official OpenClaw desktop app if present."""
        official_dir = Path.home() / "AppData" / "Local" / "Programs" / "OpenClaw"
        if not official_dir.exists():
            self.log.info("  未发现官方 OpenClaw 客户端")
            return
        self.log.step("清理官方 OpenClaw 客户端…")
        uninstaller = official_dir / "Uninstall OpenClaw.exe"
        if uninstaller.exists():
            try:
                self._run([str(uninstaller), "/S"], capture_output=True, timeout=60)
                self.log.success("官方 OpenClaw 卸载程序已执行")
                time.sleep(2)
            except Exception as e:
                self.log.warn(f"官方卸载程序执行失败: {e}")
        runtime_bin = official_dir / "resources" / "runtime" / "bin"
        if runtime_bin.exists():
            self._remove_from_system_path(str(runtime_bin))
        if official_dir.exists():
            shutil.rmtree(official_dir, ignore_errors=True)
            self.log.info(f"  已删除 {official_dir}")

    def _uninstall_clean_desktop(self) -> None:
        """Remove the MicroClaw desktop client directory and app data."""
        self.log.step("删除桌面客户端…")
        install_dir = DEFAULT_DESKTOP_DIR
        if install_dir.exists():
            try:
                count = sum(1 for _ in install_dir.rglob("*") if _.is_file())
                self.log.info(f"  正在删除 {count} 个文件…")
            except Exception:
                pass
            shutil.rmtree(install_dir, ignore_errors=True)
            self.log.info(f"  已删除 {install_dir}")
        else:
            self.log.info(f"  {install_dir} 不存在，跳过")

        # Clean Electron app data (Local Storage, chat history, caches)
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("microclaw", "MicroClawDesktop"):
                app_dir = Path(appdata) / name
                if app_dir.exists():
                    shutil.rmtree(app_dir, ignore_errors=True)
                    self.log.info(f"  已删除应用数据 {app_dir}")

    def _uninstall_clean_config(self) -> None:
        """Remove MicroClaw-specific files from ~/.openclaw.

        Preserves openclaw.json and .env so that OpenClaw (installed by
        setup-dependencies.ps1) remains functional after MicroClaw is
        uninstalled.
        """
        self.log.step("清理 MicroClaw 配置…")
        openclaw_dir = Path.home() / ".openclaw"
        if not openclaw_dir.exists():
            self.log.info("  配置目录不存在，跳过")
            return

        # Only remove items that MicroClaw installer created.
        # Keep openclaw.json and .env so OpenClaw CLI still works.
        microclaw_items = [
            "skills",  # managed skills deployed by installer
            "extensions",  # plugins installed via 'openclaw plugins install'
            "compile-cache",  # V8 warmup cache
            "skill_catalog.json",  # MicroClaw skill catalog
            "managed_skill_catalog.json",  # MicroClaw managed skill catalog
            "MicroClawInstaller.exe",  # installer copy for uninstall
            "_internal",  # PyInstaller bundle for uninstall exe
            "microclaw.ico",  # app icon
            "microclaw-uninstall.ico",  # uninstall icon
        ]
        removed = 0
        for name in microclaw_items:
            p = openclaw_dir / name
            if p.exists():
                try:
                    if p.is_dir():
                        shutil.rmtree(p, ignore_errors=True)
                    else:
                        p.unlink()
                    self.log.info(f"  删除 {name}")
                    removed += 1
                except Exception as e:
                    self.log.warn(f"  无法删除 {name}: {e}")

        if removed:
            self.log.info(f"  已清理 {removed} 个 MicroClaw 项目")
        else:
            self.log.info("  无需清理")
        self.log.info("  保留 openclaw.json 和 .env（OpenClaw 依赖仍可使用）")

    def _uninstall_clean_shortcuts(self) -> None:
        """Remove desktop shortcuts."""
        self.log.step("删除快捷方式…")
        desktop = self._get_desktop_path()
        removed = 0
        for name in (
            "MicroClawDesktop.lnk",
            "MicroClawDesktop.url",
            "MicroClaw.lnk",
            "MicroClaw.url",
            "OpenClaw.lnk",
            "OpenClaw.url",
            "Uninstall MicroClaw.lnk",
            "卸载 MicroClaw.lnk",
        ):
            p = desktop / name
            if p.exists():
                p.unlink(missing_ok=True)
                self.log.info(f"  已删除 {p.name}")
                removed += 1
        if removed == 0:
            self.log.info("  未发现快捷方式")

        # Notify Windows Explorer to refresh the desktop so deleted icons disappear
        if removed > 0:
            try:
                import ctypes

                SHCNE_ASSOCCHANGED = 0x08000000
                SHCNF_IDLIST = 0x0000
                ctypes.windll.shell32.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None)
            except Exception:
                pass

    def _uninstall_plugins(self) -> None:
        """Uninstall plugins via openclaw CLI before removing files."""
        self.log.step("卸载插件…")
        openclaw_cmd = self._find_openclaw_cmd()
        if not openclaw_cmd:
            self.log.info("  未找到 openclaw 命令，跳过插件卸载")
            return

        env = self._get_env()
        state_dir = Path.home() / ".openclaw"
        env["OPENCLAW_STATE_DIR"] = str(state_dir)

        for plugin_id in ["openclaw-weixin"]:
            ext_dir = state_dir / "extensions" / plugin_id
            if not ext_dir.exists():
                continue
            try:
                proc = subprocess.run(
                    openclaw_cmd + ["plugins", "uninstall", plugin_id],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=60,
                    env=env,
                    creationflags=_CREATE_NO_WINDOW,
                )
                if proc.returncode == 0:
                    self.log.info(f"  插件 {plugin_id} 已卸载")
                else:
                    # CLI uninstall failed — remove directory manually
                    self.log.info(f"  插件 {plugin_id} CLI 卸载失败，手动删除")
                    shutil.rmtree(ext_dir, ignore_errors=True)
            except Exception as e:
                self.log.warn(f"  插件 {plugin_id} 卸载异常: {e}")
                shutil.rmtree(ext_dir, ignore_errors=True)

    def uninstall(self) -> bool:
        """Uninstall MicroClaw (preserves Node.js, Git, and OpenClaw dependencies)."""
        self._uninstall_stop_daemon()
        self._uninstall_stop_gateway()
        self._uninstall_kill_desktop()
        self._uninstall_plugins()
        self._uninstall_clean_official()
        self._uninstall_appcontainer()
        self._uninstall_clean_desktop()
        self._uninstall_clean_config()
        self._uninstall_clean_shortcuts()
        self.log.success("卸载完成")
        return True

    def _resolve_packaged_icon(self, source_name: str, target_name: str) -> Path | None:
        """Find an installer-bundled icon and copy it to ~/.openclaw/."""
        import sys

        target_ico = Path.home() / ".openclaw" / target_name
        if target_ico.exists():
            return target_ico
        candidates = [
            Path(__file__).parent / "assets" / source_name,
            Path(__file__).parent.parent / source_name,
        ]
        if getattr(sys, "frozen", False):
            candidates.insert(0, Path(sys._MEIPASS) / "deployer" / "assets" / source_name)
            candidates.insert(1, Path(sys.executable).parent / "deployer" / "assets" / source_name)
            candidates.insert(2, Path(sys._MEIPASS) / source_name)
            candidates.insert(3, Path(sys.executable).parent / source_name)
        for ico in candidates:
            if ico.exists():
                target_ico.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ico, target_ico)
                return target_ico
        return None

    def _resolve_icon(self) -> Path | None:
        """Find and ensure microclaw.ico is in ~/.openclaw/."""
        return self._resolve_packaged_icon("microclaw.ico", "microclaw.ico")

    def _resolve_uninstall_icon(self) -> Path | None:
        """Find and ensure the uninstall shortcut icon is in ~/.openclaw/."""
        return self._resolve_packaged_icon("microclaw-uninstall.ico", "microclaw-uninstall.ico")

    def ensure_defender_exclusions(self) -> bool:
        """Add Windows Defender exclusions for all managed directories.

        Real-time AV scanning thousands of JS/EXE files is the primary cause
        of slow plugin installs and gateway startup on Windows.  Runs as a
        standalone step so exclusions are applied regardless of whether Node.js
        was freshly installed or already present.
        """
        self.log.step("正在添加 Windows Defender 排除项…")
        local_appdata = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
        dirs = [
            self.node_dir,  # ~/.openclaw-node (node + node_modules)
            Path.home() / ".openclaw",  # config, skills, plugins, compile-cache
            Path.home() / ".openclaw-git",  # PortableGit
            Path.home() / ".microclaw",  # Electron desktop client
            local_appdata / "npm-cache",  # npm cache (heavy I/O during install)
            local_appdata / "Temp",  # %TEMP% (npm extracts packages here)
        ]
        self._add_defender_exclusions(dirs)
        return True

    def _add_defender_exclusions(self, dirs: list[Path]) -> None:
        """Best-effort: add Windows Defender exclusions for multiple directories.

        Real-time AV scanning thousands of JS/EXE files is the primary cause
        of slow gateway startup on Windows.  Batches all dirs into one
        elevated call to avoid multiple UAC prompts.

        Defender accepts paths that don't exist yet, so no need to filter.
        """
        if not dirs:
            return

        # Add-MpPreference always requires admin — elevate directly
        safe_paths = ",".join(f"''{str(d).replace(chr(39), chr(39) * 2)}''" for d in dirs)
        try:
            self._run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden "
                    f"-ArgumentList '-NoProfile','-Command',"
                    f"'Add-MpPreference -ExclusionPath {safe_paths}'",
                ],
                capture_output=True,
                timeout=30,
            )
            for d in dirs:
                self.log.info(f"  Defender exclusion added: {d}")
        except Exception as e:
            self.log.warning(f"  Defender 排除项添加失败（需要管理员权限）: {e}")
            self.log.warning(
                "  提示: 手动在 Windows 安全中心 > 病毒防护 > 排除项 中添加上述目录可显著加速安装"
            )

    def _find_openclaw_cmd(self) -> list[str] | None:
        """Find openclaw executable on Windows.

        Prefer .cmd over bare name to avoid .ps1 execution-policy issues.
        """
        # Prefix used by the most recent install (set by install_openclaw_windows)
        install_prefix = getattr(self, "install_prefix", None)
        # Managed node dir (always check, even if _node_bin not set)
        for search_dir in filter(None, [install_prefix, self._node_bin, self.node_dir]):
            for name in ("openclaw.cmd", "openclaw.exe", "openclaw"):
                p = Path(search_dir) / name
                if p.exists():
                    return [str(p)]
        # npm global
        npm_prefix = Path.home() / "AppData" / "Roaming" / "npm"
        for name in ("openclaw.cmd", "openclaw.exe", "openclaw"):
            p = npm_prefix / name
            if p.exists():
                return [str(p)]
        # System PATH — prefer .cmd to avoid .ps1
        for ext in (".cmd", ".exe", ""):
            found = shutil.which(f"openclaw{ext}")
            if found:
                return [found]
        return None

    # ────────────────────── helpers ──────────────────────

    def _get_env(self) -> dict:
        """Return env dict with our managed node + git in PATH.

        Also redirects npm's global config to our managed dir so npm never
        tries to read/write the system npmrc (avoids Access Denied on
        system Node.js installs under C:\\Program Files).
        """
        env = os.environ.copy()
        path_prefix = ""
        # Always put managed node dir first so our node.exe wins over system node
        if self.node_dir.exists():
            path_prefix += str(self.node_dir) + os.pathsep
        if self._node_bin and str(self._node_bin) != str(self.node_dir):
            path_prefix += str(self._node_bin) + os.pathsep
        if self._git_bin:
            path_prefix += self._git_bin + os.pathsep
        if path_prefix:
            env["PATH"] = path_prefix + env.get("PATH", "")

        # Redirect npm global config to our managed dir
        try:
            global_npmrc_dir = self.node_dir / "etc"
            global_npmrc_dir.mkdir(parents=True, exist_ok=True)
            env["npm_config_globalconfig"] = str(global_npmrc_dir / "npmrc")
        except Exception:
            # Fall back: use temp dir if node_dir/etc is not writable
            try:
                import tempfile

                fallback = Path(tempfile.gettempdir()) / "openclaw_npmrc"
                fallback.mkdir(parents=True, exist_ok=True)
                env["npm_config_globalconfig"] = str(fallback / "npmrc")
            except Exception:
                pass

        return env

    def _get_npm_path(self) -> str | None:
        """Find npm executable (prefer .cmd to avoid PS1 execution policy issues)."""
        # 1. Check managed node dir directly
        for search_dir in filter(None, [self._node_bin, self.node_dir]):
            for name in ("npm.cmd", "npm.exe", "npm"):
                p = search_dir / name
                if p.exists():
                    return str(p)

        # 2. Search using our modified PATH (includes managed node dir)
        env = self._get_env()
        modified_path = env.get("PATH", "")
        for ext in (".cmd", ".exe", ""):
            found = shutil.which(f"npm{ext}", path=modified_path)
            if found:
                return found

        # 3. Fallback: npm.cmd is missing but the module exists — regenerate shim
        #    Node ships npm as a bundled module; sometimes only node.exe survives
        #    a partial extraction or upgrade, leaving npm.cmd absent.
        for search_dir in filter(None, [self._node_bin, self.node_dir]):
            npm_cli = search_dir / "node_modules" / "npm" / "bin" / "npm-cli.js"
            node_exe = search_dir / "node.exe"
            if npm_cli.exists() and node_exe.exists():
                shim = search_dir / "npm.cmd"
                try:
                    shim.write_text(
                        "@ECHO off\r\n"
                        "SETLOCAL\r\n"
                        'SET "NODE_EXE=%~dp0\\node.exe"\r\n'
                        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n'
                        '"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n',
                        encoding="utf-8",
                    )
                    self.log.info(f"Regenerated missing npm.cmd shim at {shim}")
                    return str(shim)
                except Exception as e:
                    self.log.warn(f"Failed to regenerate npm.cmd: {e}")

        # 4. System PATH (unmodified)
        return shutil.which("npm")

    def _get_node_version(self, node_path: str) -> str | None:
        try:
            r = self._run(
                [node_path, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=10,
            )
            ver = r.stdout.strip()
            return ver if ver.startswith("v") else None
        except Exception:
            return None

    def add_to_path(self) -> bool:
        """Add managed node dir + npm global bin to the user's persistent PATH."""
        self.log.step("Adding Node.js & npm to system PATH…")
        import winreg

        dirs_to_add = []
        # Our managed node install
        if self.node_dir.exists():
            dirs_to_add.append(str(self.node_dir))
        # npm global bin (where openclaw.cmd lives)
        npm_global = Path.home() / "AppData" / "Roaming" / "npm"
        if npm_global.exists():
            dirs_to_add.append(str(npm_global))

        if not dirs_to_add:
            if self._node_bin and shutil.which("node"):
                self.log.info("Node.js already in PATH; no directories to add")
                return True
            self.log.warn("No directories to add to PATH")
            return False

        try:
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Environment",
                0,
                winreg.KEY_READ | winreg.KEY_WRITE,
            )
            current_path, _ = winreg.QueryValueEx(key, "Path")
            current_lower = current_path.lower()

            added = []
            for d in dirs_to_add:
                if d.lower() not in current_lower:
                    added.append(d)

            if not added:
                self.log.info("PATH already contains required directories")
                winreg.CloseKey(key)
                return True

            new_path = ";".join(added) + ";" + current_path.rstrip(";")
            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, new_path)
            winreg.CloseKey(key)

            # Broadcast WM_SETTINGCHANGE so Explorer picks it up
            try:
                import ctypes

                HWND_BROADCAST = 0xFFFF
                WM_SETTINGCHANGE = 0x001A
                ctypes.windll.user32.SendMessageTimeoutW(
                    HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", 0x0002, 5000, None
                )
            except Exception:
                pass

            for d in added:
                self.log.info(f"  Added to PATH: {d}")

            # Also ensure our node_dir comes BEFORE system nodejs in
            # the machine-level PATH (system PATH is evaluated first).
            self._prepend_before_system_nodejs(str(self.node_dir))

            self.log.success("PATH updated (restart terminal to take effect)")

            # Register rollback. Default-arg pattern intentionally captures the
            # *current* value of `added` so the closure has its own snapshot.
            def _rollback_path(dirs=list(added)):  # noqa: B006, B008
                try:
                    import winreg

                    key = winreg.OpenKey(
                        winreg.HKEY_CURRENT_USER,
                        r"Environment",
                        0,
                        winreg.KEY_READ | winreg.KEY_WRITE,
                    )
                    current, _ = winreg.QueryValueEx(key, "Path")
                    parts = [
                        p
                        for p in current.split(";")
                        if p.strip().lower() not in {d.lower() for d in dirs}
                    ]
                    winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(parts))
                    winreg.CloseKey(key)
                except Exception:
                    pass

            self._register_rollback("移除 PATH 条目", _rollback_path)

            return True

        except Exception as e:
            self.log.error(f"Failed to update PATH: {e}")
            return False
