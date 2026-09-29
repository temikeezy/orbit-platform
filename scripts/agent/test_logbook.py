import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from logbook import decide  # noqa: E402

A = {"decision": "approve", "comment": ""}
C = {"decision": "changes", "comment": "Add what you built."}


def never():
    raise AssertionError("tie-break should not run")


class Decide(unittest.TestCase):
    def test_both_approve(self):
        self.assertEqual(decide(A, A, never), ("approve", ""))

    def test_both_changes_carries_comment(self):
        self.assertEqual(decide(C, C, never), ("changes", "Add what you built."))

    def test_one_voice_never_returns_an_entry(self):
        self.assertEqual(decide(C, A, lambda: C)[0], "contested")
        self.assertEqual(decide(A, C, lambda: A)[0], "approve")

    def test_missing_answer(self):
        self.assertEqual(decide(None, A, never)[0], "no-quorum")


if __name__ == "__main__":
    unittest.main()
