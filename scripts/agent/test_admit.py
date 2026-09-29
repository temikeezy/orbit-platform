import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from admit import decide  # noqa: E402

A = {"decision": "admit", "reason": "genuine"}
H = {"decision": "hold", "reason": "spam"}


def never():
    raise AssertionError("tie-break should not run")


class Decide(unittest.TestCase):
    def test_agree_admit(self):
        self.assertEqual(decide(A, A, never)[0], "admit")

    def test_agree_hold(self):
        self.assertEqual(decide(H, H, never)[0], "hold")

    def test_no_answer_is_not_a_hold(self):
        self.assertEqual(decide(None, H, never)[0], "no-quorum")
        self.assertEqual(decide({"decision": "reject"}, A, never)[0], "no-quorum")

    def test_split_tiebreak_admit(self):
        self.assertEqual(decide(A, H, lambda: A)[0], "admit")

    def test_split_tiebreak_hold_is_contested_not_hold(self):
        self.assertEqual(decide(H, A, lambda: H)[0], "contested")


if __name__ == "__main__":
    unittest.main()
