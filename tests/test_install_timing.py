import json
import subprocess
import unittest
from unittest.mock import Mock

from deployer.install_timing import (
    INSTALL_TIMING_PREFIX,
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
            [line for line in log.messages if not line.startswith(INSTALL_TIMING_PREFIX)],
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
            [line for line in log.messages if not line.startswith(INSTALL_TIMING_PREFIX)],
            ["Install timing summary: status=failed total=1.00s steps=0"],
        )

    def test_structured_steps_keep_identity_and_separate_human_wait(self):
        log = _Log()
        clock = Mock(return_value=10.0)
        timing = InstallTiming(log, clock)
        started = timing.start_step("prepareUpgrade-18")
        with timing.span("attempt", attempt=1):
            clock.return_value = 11.0
            with timing.span("human-wait"):
                clock.return_value = 16.0
            clock.return_value = 17.0
        timing.record_step("准备升级...", started, "success")
        timing.finish("success")
        events = [
            json.loads(line[len(INSTALL_TIMING_PREFIX) :])
            for line in log.messages
            if line.startswith(INSTALL_TIMING_PREFIX)
        ]
        self.assertTrue(all(event["runId"] == timing.run_id for event in events))
        self.assertTrue(all(event["stageId"] == "prepareUpgrade-18" for event in events[:-1]))
        self.assertEqual(events[-1]["stageId"], "installation")
        self.assertEqual(events[-1]["stepCount"], 1)
        self.assertEqual(events[-1]["durationMs"], 7000)
        self.assertEqual(events[-1]["humanWaitMs"], 5000)
        self.assertEqual(events[-1]["activeMs"], 2000)
        self.assertEqual(events[-2]["durationMs"], 7000)

    def test_broken_sink_does_not_change_installation_or_original_failure(self):
        log = Mock()
        log.info.side_effect = OSError("unavailable")
        timing = InstallTiming(log)
        started = timing.start_step("desktop-60")
        with self.assertRaisesRegex(ValueError, "original"), timing.span("attempt", attempt=1):
            raise ValueError("original")
        timing.record_step("Desktop", started, "failed")
        timing.finish("failed")


class RuntimePreparationTimingTests(unittest.TestCase):
    def test_helper_records_inherit_install_attempt_identity(self):
        log = _Log()
        context = {
            "schemaVersion": 2,
            "runId": "run",
            "sampleId": "sample",
            "stageId": "desktop-60",
        }
        timing = RuntimePreparationTiming(log, context=context)
        timing.forward_output(
            RUNTIME_PREPARATION_TIMING_PREFIX
            + json.dumps(
                {
                    "scope": "worker",
                    "phase": "archive-extract",
                    "status": "success",
                    "durationMs": 5,
                }
            )
        )
        event = json.loads(log.messages[-1][len(RUNTIME_PREPARATION_TIMING_PREFIX) :])
        self.assertEqual(event["scope"], "worker")
        self.assertEqual(event["sampleId"], "sample")
        self.assertEqual(event["stageId"], "desktop-60")

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
