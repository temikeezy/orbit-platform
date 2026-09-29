"""Run: python3 -m unittest discover -s scripts/agent -p 'test_*.py'"""
import io
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assess import decide  # noqa: E402
import evidence  # noqa: E402

M = 12  # tolerance = 3 points


def r(score=None, unreadable=False, fb="fb"):
    return {"score": score, "unreadable": unreadable, "feedback": fb}


def never():
    raise AssertionError("third reader should not be called")


class Decide(unittest.TestCase):
    def test_agreement_uses_primary(self):
        self.assertEqual(decide(r(9, fb="A"), r(8), never, M), ("marked", 9, "A", "sonnet+luna", False))

    def test_zero_is_unanimous_only_when_every_reader_said_zero(self):
        self.assertTrue(decide(r(0), r(0), never, M)[4])
        out = decide(r(0), r(2), never, M)
        self.assertEqual(out[:2], ("marked", 0))
        self.assertFalse(out[4])

    def test_missing_reader_is_no_quorum_not_a_mark(self):
        self.assertEqual(decide(None, r(8), never, M)[0], "no-quorum")

    def test_both_unreadable(self):
        self.assertEqual(decide(r(unreadable=True), r(unreadable=True), never, M)[0], "unreadable")

    def test_out_of_range_score_is_refused(self):
        self.assertEqual(decide(r(40), r(8), never, M)[0], "no-quorum")

    def test_tiebreak_sides_with_primary(self):
        # Tie-break feedback is the tie-breaker's; the mean rounds half up.
        self.assertEqual(decide(r(10, fb="A"), r(2), lambda: r(9, fb="C"), M), ("marked", 10, "C", "sonnet+opus", False))

    def test_tiebreak_sides_with_second(self):
        out = decide(r(10), r(2), lambda: r(3, fb="C"), M)
        self.assertEqual(out, ("marked", 3, "C", "luna+opus", False))

    def test_tiebreak_agrees_with_nobody(self):
        self.assertEqual(decide(r(12), r(0), lambda: r(6), M)[0], "contested")

    def test_one_unreadable_then_tiebreak_unreadable(self):
        self.assertEqual(decide(r(unreadable=True), r(8), lambda: r(unreadable=True), M)[0], "unreadable")

    def test_one_unreadable_then_tiebreak_scores_with_reader(self):
        self.assertEqual(decide(r(unreadable=True), r(8), lambda: r(7, fb="C"), M)[:2], ("marked", 8))


class Evidence(unittest.TestCase):
    def test_signin_page_is_unreadable(self):
        page = "<html><body><h1>Sign in</h1><p>to continue to Google Docs</p></body></html>"
        self.assertEqual(evidence._classify_page(page)[0], "unreadable")

    def test_long_page_mentioning_login_is_text(self):
        page = "<p>" + ("Our audit found the login flow slow. " * 80) + "</p>"
        self.assertEqual(evidence._classify_page(page)[0], "text")

    def test_docx_text_extracted(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml",
                       "<w:document><w:body>" +
                       "".join(f"<w:p><w:r><w:t>Paragraph {i} of real findings here.</w:t></w:r></w:p>"
                               for i in range(10)) + "</w:body></w:document>")
        kind, body = evidence._classify_bytes(
            buf.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "", tempfile.mkdtemp())
        self.assertEqual(kind, "text")
        self.assertIn("Paragraph 9 of real findings", body)

    def test_video_and_zip_are_unsupported(self):
        self.assertEqual(evidence._from_link("https://youtu.be/abc", tempfile.mkdtemp())[0], "unsupported")
        self.assertEqual(evidence._classify_bytes(b"PK..", "application/zip", "", tempfile.mkdtemp())[0], "unsupported")

    def test_google_doc_link_exports_as_text(self):
        u = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing"
        self.assertEqual(evidence._google_export(u),
                         "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=txt")

    def test_empty_text_submission_is_unreadable(self):
        self.assertEqual(evidence.evidence_for({"submissionText": "done"})[0], "empty")

    def test_app_shell_is_not_scored(self):
        shell = ("<html><head><title>Notion</title></head><body><noscript>You need to enable "
                 "JavaScript to run this app.</noscript><div id=root></div>"
                 "<p>Notion – The all-in-one workspace for your notes, tasks and wikis.</p></body></html>")
        self.assertEqual(evidence._classify_page(shell)[0], "unreadable")

    def test_short_page_without_markers_is_still_not_work(self):
        self.assertEqual(evidence._classify_page("<p>" + "Portfolio of Ada. " * 10 + "</p>")[0], "unreadable")

    def test_app_hosts_are_unsupported_not_fetched(self):
        self.assertEqual(evidence._from_link("https://www.figma.com/file/abc", tempfile.mkdtemp())[0], "unsupported")


if __name__ == "__main__":
    unittest.main()
