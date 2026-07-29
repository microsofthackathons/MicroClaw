import unittest

from deployer.install_timing import InstallTiming


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


if __name__ == "__main__":
    unittest.main()
