"""Centralized logging for OpenClaw Deployer.

Writes to both a rotating log file and an in-memory buffer
that the GUI can poll.
"""

import logging
import os
import sys
import threading
from collections import deque
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path


def _get_app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


class DeployerLogger:
    """Thread-safe logger with an in-memory ring buffer for the GUI."""

    LOG_DIR = Path(os.environ.get("OPENCLAW_DEPLOYER_LOGDIR", str(_get_app_dir() / "logs")))
    MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
    BACKUP_COUNT = 5
    BUFFER_SIZE = 10_000  # lines kept in memory

    def __init__(self, name: str = "OpenClawDeployer"):
        self.LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._buffer: deque[str] = deque(maxlen=self.BUFFER_SIZE)
        self._lock = threading.Lock()
        self._listeners: list = []

        # ---- file handler ----
        log_file = self.LOG_DIR / f"deployer_{datetime.now():%Y%m%d_%H%M%S}.log"
        file_handler = RotatingFileHandler(
            log_file, maxBytes=self.MAX_BYTES, backupCount=self.BACKUP_COUNT, encoding="utf-8"
        )
        file_handler.setFormatter(
            logging.Formatter(
                "[%(asctime)s] [%(levelname)-7s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
            )
        )

        # ---- base logger ----
        self._logger = logging.getLogger(name)
        self._logger.setLevel(logging.DEBUG)
        self._logger.addHandler(file_handler)

        self.log_file = log_file

    # ---------- public API ----------

    def add_listener(self, callback):
        """Register a callable(line: str) invoked on every new log line."""
        self._listeners.append(callback)

    def info(self, msg: str):
        self._emit(logging.INFO, msg)

    def warn(self, msg: str):
        self._emit(logging.WARNING, msg)

    # alias so callers can use either .warn() or .warning()
    warning = warn

    def error(self, msg: str):
        self._emit(logging.ERROR, msg)

    def debug(self, msg: str):
        self._emit(logging.DEBUG, msg)

    def success(self, msg: str):
        self._emit(logging.INFO, f"✓ {msg}")

    def step(self, msg: str):
        self._emit(logging.INFO, f"▸ {msg}")

    def get_all_lines(self) -> list[str]:
        with self._lock:
            return list(self._buffer)

    def export(self, path: str):
        """Write current buffer to a text file."""
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(line + "\n" for line in self.get_all_lines())

    # ---------- internal ----------

    def _emit(self, level: int, msg: str):
        self._logger.log(level, msg)
        ts = datetime.now().strftime("%H:%M:%S")
        level_name = logging.getLevelName(level)
        line = f"[{ts}] [{level_name:<7}] {msg}"
        with self._lock:
            self._buffer.append(line)
        for cb in self._listeners:
            try:
                cb(line)
            except Exception:
                pass
