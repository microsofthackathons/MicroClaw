"""Installation timing metrics shared by both installer frontends."""

from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter


@dataclass(frozen=True)
class StepTiming:
    label: str
    status: str
    duration_ms: int


class InstallTiming:
    """Record readable per-step timings and a compact installation summary."""

    def __init__(self, logger, clock: Callable[[], float] | None = None):
        self._logger = logger
        self._clock = clock or perf_counter
        self._started_at = self._clock()
        self._steps: list[StepTiming] = []
        self._finished = False

    def start_step(self) -> float:
        return self._clock()

    def record_step(self, label: str, started_at: float, status: str) -> None:
        clean_label = label.rstrip(".")
        duration_ms = max(0, round((self._clock() - started_at) * 1000))
        self._steps.append(StepTiming(label=clean_label, status=status, duration_ms=duration_ms))
        self._logger.info(f"Install timing: {clean_label} [{status}] {duration_ms / 1000:.2f}s")

    def finish(self, status: str) -> None:
        if self._finished:
            return
        self._finished = True

        total_ms = max(0, round((self._clock() - self._started_at) * 1000))
        self._logger.info(
            f"Install timing summary: status={status} "
            f"total={total_ms / 1000:.2f}s steps={len(self._steps)}"
        )
        if self._steps:
            slowest = sorted(self._steps, key=lambda step: step.duration_ms, reverse=True)[:5]
            details = "; ".join(f"{step.label}={step.duration_ms / 1000:.2f}s" for step in slowest)
            self._logger.info(f"Slowest install steps: {details}")
