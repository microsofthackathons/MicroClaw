import json
import subprocess
import unittest
from unittest.mock import Mock

from deployer.install_timing import (
    RUNTIME_PREPARATION_TIMING_PREFIX,
    InstallTiming,
    RuntimePreparationTiming,
)


class _Log:
    def __init__(self):
        self.messages = []

    def info(self, message):
        self.messages.append(message)


class _Clock:
    def __init__(self, *values):
        self._values = iter(values)

    def __call__(self):
        return next(self._values)


class InstallTimingTests(unittest.TestCase):
    def test_logs_step_total_and_slowest_summary(self):
        log = _Log()
        timing = InstallTiming(log, clock=_Clock(10.0, 11.0, 13.5, 16.0))

        started_at = timing.start_step()
        timing.record_step("Installing Git...", started_at, "success")
        timing.finish("success")

        self.assertEqual(
            log.messages,
            [
                "Install timing: Installing Git [success] 2.50s",
                "Install timing summary: status=success total=6.00s steps=1",
                "Slowest install steps: Installing Git=2.50s",
            ],
        )

    def test_finish_only_logs_once(self):
        log = _Log()
        timing = InstallTiming(log, clock=_Clock(1.0, 2.0))

        timing.finish("failed")
        timing.finish("success")

        self.assertEqual(
            log.messages,
            ["Install timing summary: status=failed total=1.00s steps=0"],
        )


class RuntimePreparationTimingTests(unittest.TestCase):
    def test_records_phase_start_finish_and_summary_boundaries(self):
        log = _Log()
        clock = Mock(return_value=10.0)
        timing = RuntimePreparationTiming(log, clock=clock)
        with timing.phase("helper-process", summary=True):
            clock.return_value = 12.345
        events = [
            json.loads(message.removeprefix(RUNTIME_PREPARATION_TIMING_PREFIX))
            for message in log.messages
        ]
        self.assertEqual(
            events,
            [
                {
                    "scope": "installer",
                    "phase": "helper-process",
                    "kind": "summary",
                    "status": "started",
                    "elapsedMs": 0,
                },
                {
                    "scope": "installer",
                    "phase": "helper-process",
                    "kind": "summary",
                    "status": "success",
                    "elapsedMs": 2345,
                    "durationMs": 2345,
                },
            ],
        )

    def test_preserves_errors_and_distinguishes_timeouts(self):
        for error, status in (
            (ValueError("invalid receipt"), "failed"),
            (subprocess.TimeoutExpired("desktop", 600), "timeout"),
        ):
            with self.subTest(status=status):
                log = _Log()
                timing = RuntimePreparationTiming(log)
                with self.assertRaises(type(error)) as raised, timing.phase("helper-process"):
                    raise error
                self.assertIs(raised.exception, error)
                event = json.loads(log.messages[-1].removeprefix(RUNTIME_PREPARATION_TIMING_PREFIX))
                self.assertEqual(event["status"], status)
                self.assertGreaterEqual(event["durationMs"], 0)

    def test_forwards_only_timing_records_including_partial_timeout_bytes(self):
        log = _Log()
        timing = RuntimePreparationTiming(log)
        record = (
            f'{RUNTIME_PREPARATION_TIMING_PREFIX}{{"phase":"archive-extract","status":"started"}}'
        )
        for output in (
            f"unrelated output\n{record}\nMICROCLAW_INSTALLER_RUNTIME {{}}\n",
            record.encode(),
            None,
        ):
            timing.forward_output(output)
        self.assertEqual(log.messages, [record, record])

    def test_logging_failure_does_not_change_operation_results(self):
        log = Mock()
        log.info.side_effect = OSError("log unavailable")
        timing = RuntimePreparationTiming(log)
        with timing.phase("result-validation"):
            result = "prepared"
        self.assertEqual(result, "prepared")
        with (
            self.assertRaisesRegex(ValueError, "original failure"),
            timing.phase("result-validation"),
        ):
            raise ValueError("original failure")


if __name__ == "__main__":
    unittest.main()
