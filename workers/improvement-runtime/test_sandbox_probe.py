import unittest

from sandbox_probe import validate_limits


class SandboxProbeTests(unittest.TestCase):
    def test_exact_cgroup_limits_and_alternative_cpu_period(self):
        validate_limits("200000 100000", "2147483648", "0", "128")
        validate_limits("20000 10000", "2147483648", "0", "128")

    def test_unbounded_or_changed_resources_are_refused(self):
        for values in (
            ("max 100000", "2147483648", "0", "128"),
            ("100000 100000", "2147483648", "0", "128"),
            ("200000 100000", "max", "0", "128"),
            ("200000 100000", "2147483648", "2147483648", "128"),
            ("200000 100000", "2147483648", "0", "max"),
        ):
            with self.subTest(values=values), self.assertRaises((AssertionError, ValueError)):
                validate_limits(*values)


if __name__ == "__main__":
    unittest.main()
