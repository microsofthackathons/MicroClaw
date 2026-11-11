"""Installation timing metrics shared by both installer frontends."""

import json
import os
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from subprocess import TimeoutExpired
from time import perf_counter
from uuid import uuid4

RUNTIME_PREPARATION_TIMING_PREFIX = "MICROCLAW_RUNTIME_TIMING "
INSTALL_TIMING_PREFIX = "MICROCLAW_INSTALL_TIMING "


class RuntimePreparationTiming:
    def __init__(self, logger, clock: Callable[[], float] | None = None, *, context=None):
        self._logger = logger
        self._clock = clock or perf_counter
        self._started_at = self._clock()
        self._context = context or {}

    def _write(self, message: str) -> None:
        try:
            self._logger.info(message)
        except Exception:
            pass

    def _record(self, phase: str, kind: str, status: str, duration_ms: int | None = None):
        event = {
            **self._context,
            "scope": "installer",
            "phase": phase,
            "kind": kind,
            "status": status,
            "elapsedMs": max(0, round((self._clock() - self._started_at) * 1000)),
        }
        if duration_ms is not None:
            event["durationMs"] = duration_ms
        self._write(f"{RUNTIME_PREPARATION_TIMING_PREFIX}{json.dumps(event)}")

    @contextmanager
    def phase(self, phase: str, *, summary: bool = False):
        started_at = self._clock()
        kind = "summary" if summary else "phase"
        self._record(phase, kind, "started")
        status = "success"
        try:
            yield
        except TimeoutExpired:
            status = "timeout"
            raise
        except Exception:
            status = "failed"
            raise
        finally:
            self._record(phase, kind, status, max(0, round((self._clock() - started_at) * 1000)))

    def forward_output(self, output: str | bytes | None) -> None:
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        if isinstance(output, str):
            for line in output.splitlines():
                if line.startswith(RUNTIME_PREPARATION_TIMING_PREFIX):
                    if self._context:
                        try:
                            event = json.loads(line[len(RUNTIME_PREPARATION_TIMING_PREFIX) :])
                            line = RUNTIME_PREPARATION_TIMING_PREFIX + json.dumps(
                                {**event, **self._context}
                            )
                        except (ValueError, TypeError):
                            continue
                    self._write(line)


@dataclass(frozen=True)
class StepTiming:
    label: str
    status: str
    duration_ms: int


class InstallTiming:
    """Readable logs plus versioned, locale-independent installation evidence."""

    def __init__(self, logger, clock: Callable[[], float] | None = None):
        self._logger = logger
        self._clock = clock or perf_counter
        self._started_at = self._clock()
        self._steps: list[StepTiming] = []
        self._finished = False
        self.run_id = os.environ.get("MICROCLAW_PERF_RUN_ID") or str(uuid4())
        self.sample_id = os.environ.get("MICROCLAW_PERF_SAMPLE_ID")
        self.stage_id = "installation"
        self._human_wait_ms = 0

    def context(self):
        return {
            "schemaVersion": 2,
            "runId": self.run_id,
            "sampleId": self.sample_id,
            "stageId": self.stage_id,
        }

    def _write(self, message):
        try:
            self._logger.info(message)
        except Exception:
            pass

    def _record(self, phase, kind, status, now, **details):
        self._write(
            INSTALL_TIMING_PREFIX
            + json.dumps(
                {
                    "schemaVersion": 2,
                    "runId": self.run_id,
                    "sampleId": self.sample_id,
                    "scope": "installer",
                    "stageId": self.stage_id,
                    "phase": phase,
                    "kind": kind,
                    "status": status,
                    "elapsedMs": max(0, round((now - self._started_at) * 1000)),
                    **details,
                }
            )
        )

    def start_step(self, stage_id: str | None = None) -> float:
        self.stage_id = stage_id or f"step-{len(self._steps) + 1}"
        now = self._clock()
        self._record(self.stage_id, "step", "started", now)
        return now

    def record_step(self, label: str, started_at: float, status: str) -> None:
        clean_label = label.rstrip(".")
        now = self._clock()
        duration_ms = max(0, round((now - started_at) * 1000))
        self._steps.append(StepTiming(label=clean_label, status=status, duration_ms=duration_ms))
        self._write(f"Install timing: {clean_label} [{status}] {duration_ms / 1000:.2f}s")
        self._record(self.stage_id, "step", status, now, durationMs=duration_ms)

    @contextmanager
    def span(self, phase: str, *, attempt: int | None = None):
        started = self._clock()
        details = {} if attempt is None else {"attempt": attempt}
        self._record(phase, "phase", "started", started, **details)
        outcome = {"status": "success"}
        try:
            yield outcome
        except Exception:
            outcome["status"] = "failed"
            raise
        finally:
            now = self._clock()
            duration = max(0, round((now - started) * 1000))
            if phase == "human-wait":
                self._human_wait_ms += duration
            self._record(phase, "phase", outcome["status"], now, durationMs=duration, **details)

    def finish(self, status: str) -> None:
        if self._finished:
            return
        self._finished = True

        now = self._clock()
        total_ms = max(0, round((now - self._started_at) * 1000))
        self._write(
            f"Install timing summary: status={status} "
            f"total={total_ms / 1000:.2f}s steps={len(self._steps)}"
        )
        if self._steps:
            slowest = sorted(self._steps, key=lambda step: step.duration_ms, reverse=True)[:5]
            details = "; ".join(f"{step.label}={step.duration_ms / 1000:.2f}s" for step in slowest)
            self._write(f"Slowest install steps: {details}")
        self._record(
            "installation-total",
            "summary",
            status,
            now,
            stageId="installation",
            stepCount=len(self._steps),
            durationMs=total_ms,
            humanWaitMs=self._human_wait_ms,
            activeMs=max(0, total_ms - self._human_wait_ms),
        )
