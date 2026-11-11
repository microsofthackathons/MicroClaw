import json
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from deployer.install_timing import (
    RUNTIME_PREPARATION_TIMING_PREFIX,
    RuntimePreparationTiming,
    run_timed_process,
)
from deployer.windows_setup import WindowsSetup


class TimedProcessTests(unittest.TestCase):
    def setUp(self):
        self.logger = Mock()
        self.timing = RuntimePreparationTiming(self.logger, context={"runId": "test-run"})

    def events(self):
        return [
            json.loads(call.args[0].removeprefix(RUNTIME_PREPARATION_TIMING_PREFIX))
            for call in self.logger.info.call_args_list
        ]

    def test_real_child_preserves_captured_output_exit_code_and_context(self):
        result = WindowsSetup._run(
            [
                sys.executable,
                "-c",
                "import sys; print('ready'); print('detail', file=sys.stderr); sys.exit(7)",
            ],
            timing=self.timing,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout.strip(), "ready")
        self.assertEqual(result.stderr.strip(), "detail")
        events = self.events()
        self.assertEqual(
            [(event["phase"], event["status"]) for event in events],
            [
                ("helper-spawn", "started"),
                ("helper-spawn", "success"),
                ("helper-wait", "started"),
                ("helper-wait", "success"),
            ],
        )
        self.assertTrue(all(event["runId"] == "test-run" for event in events))
        self.assertTrue(all(event["durationMs"] >= 0 for event in events if "durationMs" in event))

    def test_timeout_keeps_partial_output_and_reaps_the_child(self):
        children = []
        launch = subprocess.Popen

        def capture_child(*args, **kwargs):
            child = launch(*args, **kwargs)
            children.append(child)
            return child

        with (
            patch("deployer.install_timing.subprocess.Popen", side_effect=capture_child),
            self.assertRaises(subprocess.TimeoutExpired) as raised,
        ):
            run_timed_process(
                [sys.executable, "-c", "import time; print('partial', flush=True); time.sleep(60)"],
                timing=self.timing,
                capture_output=True,
                text=True,
                timeout=1,
            )
        output = raised.exception.stdout
        if isinstance(output, bytes):
            output = output.decode()
        self.assertIn("partial", output)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(
            any(
                event["phase"] == "helper-wait" and event["status"] == "timeout"
                for event in self.events()
            )
        )
        self.assertTrue(
            any(
                event["phase"] == "helper-timeout-reap" and event["status"] == "success"
                for event in self.events()
            )
        )

    def test_launch_failure_records_failed_spawn_without_waiting(self):
        with (
            patch("deployer.install_timing.subprocess.Popen", side_effect=OSError("cannot launch")),
            self.assertRaises(OSError),
        ):
            run_timed_process(["missing-helper"], timing=self.timing, capture_output=True)
        self.assertEqual(
            [(event["phase"], event["status"]) for event in self.events()],
            [("helper-spawn", "started"), ("helper-spawn", "failed")],
        )

    def test_logging_failure_does_not_change_successful_process_result(self):
        self.logger.info.side_effect = OSError("log unavailable")
        result = run_timed_process(
            [sys.executable, "-c", "print('ready')"],
            timing=self.timing,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "ready")


if __name__ == "__main__":
    unittest.main()
