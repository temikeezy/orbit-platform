"""
Turns a pending submission into something a reader can actually read.

WHY THIS IS ITS OWN STEP. Three quarters of the queue is files and links, not
text, and the assessor that marked twelve interns at 8% failed precisely here:
it was handed a Google sign-in page and read it as the work. So nothing reaches
a reader until this module has decided, explicitly, what the evidence IS:

    ("text", body)        — extracted, long enough to judge
    ("image", path)       — a picture the readers open themselves
    ("unreadable", why)   — a sign-in wall, a dead link, an app shell — fixable
                            by the intern, who is told and can reshare
    ("unsupported", why)  — a real format nothing here can read (video, zip,
                            a design-tool link, a scanned PDF)
    ("empty", why)        — a note with no work in it ("done, please check")
    ("no-quorum", why)    — a transient failure on OUR side; retried

None of these is ever scored. The settlement in convex/lib/agentFallback.ts pays
"unreadable" and "unsupported" in full after the window rather than letting a
machine score what it could not see — but never "empty", because a note is not
a submission and paying it would make the cheapest entry worth the most.

Standard library plus `pdftotext` (poppler) only. The runner is a launchd job
with a bare environment, and every extra dependency is one more way for it to
fail at 3am without anyone reading the log.
"""

import html
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

MAX_BYTES = 25 * 1024 * 1024
MAX_TEXT = 20000
# Below this, "text" is a title and some chrome, not a piece of work.
MIN_TEXT = 60
# A FETCHED PAGE needs far more. A JavaScript app shell (Notion, Canva, Figma,
# OneDrive) strips to a product tagline of 50-150 characters, and two readers
# agreeing on a low mark for a tagline is the 2026-09-07 failure again.
MIN_PAGE_TEXT = 500

# Hosts whose links are real deliverables that only render in their own app.
# Honest to call these unsupported (settled at full points) rather than fetch
# the shell and pretend it is the work.
APP_HOSTS = (
    "notion.so", "notion.site", "canva.com", "figma.com", "onedrive.live.com",
    "1drv.ms", "sharepoint.com", "miro.com", "behance.net", "dribbble.com",
)

VIDEO_HOSTS = ("youtube.com", "youtu.be", "tiktok.com", "vimeo.com", "loom.com", "instagram.com")

# What a gated page looks like once the markup is stripped. Checked only on
# SHORT pages: a real essay that mentions signing in is not a sign-in wall.
SIGNIN_MARKERS = (
    "sign in", "signin", "log in", "login", "request access", "you need access",
    "accounts.google.com", "servicelogin", "enable javascript", "javascript is required",
    "download anyway", "can't scan this file", "virus scan", "access denied",
)

UA = "Mozilla/5.0 (ORBIT agent; +https://orbit2.iih.ng)"


def _host(url):
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def _host_is(url, hosts):
    h = _host(url)
    return any(h == x or h.endswith("." + x) for x in hosts)


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(MAX_BYTES + 1)
        return data, r.headers.get("Content-Type", ""), r.geturl()


def _strip_html(raw, keep_noscript=False):
    drop = "script|style|svg" if keep_noscript else "script|style|noscript|svg"
    raw = re.sub(r"(?is)<(" + drop + r")[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


def _ooxml_text(path, kind):
    """docx / pptx / xlsx are zips of XML; the words are in known elements."""
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return ""
    names = z.namelist()
    if kind == "docx":
        parts = [n for n in names if re.match(r"word/(document|footnotes|endnotes)\d*\.xml$", n)]
        tag = r"<w:t[^>]*>(.*?)</w:t>"
        para = r"</w:p>"
    elif kind == "pptx":
        parts = sorted(
            (n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)),
            key=lambda n: int(re.findall(r"\d+", n)[-1]),
        )
        tag = r"<a:t>(.*?)</a:t>"
        para = r"</a:p>"
    else:
        parts = [n for n in names if n in ("xl/sharedStrings.xml",)]
        tag = r"<t[^>]*>(.*?)</t>"
        para = r"</si>"
    out = []
    for n in parts:
        xml = z.read(n).decode("utf-8", "replace").replace(para, para + "\n")
        for line in xml.split("\n"):
            words = "".join(re.findall(tag, line, flags=re.S))
            if words.strip():
                out.append(html.unescape(words))
        if kind == "pptx":
            out.append("")
    return "\n".join(out).strip()


def _pdf_text(path):
    try:
        p = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, timeout=120)
        return p.stdout.decode("utf-8", "replace").strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _classify_bytes(data, content_type, name_hint, workdir):
    """Bytes of a file (uploaded, or served by a link) -> evidence."""
    ct = (content_type or "").split(";")[0].strip().lower()
    ext = os.path.splitext(name_hint.lower())[1]

    if len(data) > MAX_BYTES:
        return ("unsupported", "file larger than 25MB")

    if ct.startswith("image/") or ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        path = os.path.join(workdir, "evidence" + (ext or "." + ct.split("/")[-1]))
        with open(path, "wb") as f:
            f.write(data)
        return ("image", path)

    kind = None
    if ct == "application/pdf" or ext == ".pdf":
        kind = "pdf"
    elif "wordprocessingml" in ct or ext == ".docx":
        kind = "docx"
    elif "presentationml" in ct or ext == ".pptx":
        kind = "pptx"
    elif "spreadsheetml" in ct or ext == ".xlsx":
        kind = "xlsx"

    if kind:
        path = os.path.join(workdir, "evidence." + kind)
        with open(path, "wb") as f:
            f.write(data)
        text = _pdf_text(path) if kind == "pdf" else _ooxml_text(path, kind)
        if len(text) < MIN_TEXT:
            # A scanned PDF or an image-only deck: real work, no text layer.
            return ("unsupported", f"{kind} with no extractable text")
        return ("text", text[:MAX_TEXT])

    if ct.startswith("text/html"):
        return _classify_page(data.decode("utf-8", "replace"))

    if ct.startswith("text/") or ext in (".txt", ".md", ".csv", ".json") or ct in ("application/json",):
        text = data.decode("utf-8", "replace").strip()
        if len(text) < MIN_TEXT:
            return ("empty", "the text file is nearly empty")
        return ("text", text[:MAX_TEXT])

    if ct in ("application/zip", "application/x-zip-compressed") or ext == ".zip":
        return ("unsupported", "zip archive")

    return ("unsupported", f"unrecognised file type {ct or ext or 'unknown'}")


def _classify_page(raw_html):
    text = _strip_html(raw_html)
    # Markers are looked for INCLUDING <noscript>, which is where "enable
    # JavaScript" lives; the text a reader sees excludes it.
    low = _strip_html(raw_html, keep_noscript=True).lower()
    if len(text) < 1500 and any(m in low for m in SIGNIN_MARKERS):
        return ("unreadable", "the link serves a sign-in or access-request page")
    if len(text) < MIN_PAGE_TEXT:
        return ("unreadable", "the page has no readable content without signing in or running its app")
    return ("text", text[:MAX_TEXT])


def _google_export(url):
    """A Google Docs/Sheets/Slides/Drive link -> a URL that serves the content."""
    m = re.search(r"/d/([A-Za-z0-9_-]{10,})", url)
    if not m:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        fid = (q.get("id") or [None])[0]
        return f"https://drive.google.com/uc?export=download&id={fid}" if fid else None
    fid = m.group(1)
    if "/document/" in url:
        return f"https://docs.google.com/document/d/{fid}/export?format=txt"
    if "/spreadsheets/" in url:
        return f"https://docs.google.com/spreadsheets/d/{fid}/export?format=csv"
    if "/presentation/" in url:
        return f"https://docs.google.com/presentation/d/{fid}/export/txt"
    return f"https://drive.google.com/uc?export=download&id={fid}"


def _from_link(url, workdir):
    if not re.match(r"^https?://", url or ""):
        return ("unreadable", "not a web link")
    if _host_is(url, VIDEO_HOSTS):
        return ("unsupported", "video link")
    if _host_is(url, APP_HOSTS):
        return ("unsupported", f"a {_host(url)} link, which only opens in its own app")
    target = url
    if _host_is(url, ("dropbox.com",)):
        # ?dl=0 serves a preview app; ?dl=1 serves the file.
        target = re.sub(r"([?&])dl=0", r"\1dl=1", url)
        if "dl=1" not in target:
            target += ("&" if "?" in target else "?") + "dl=1"
    if _host_is(url, ("docs.google.com", "drive.google.com")):
        target = _google_export(url) or url
    try:
        data, ct, final = _download(target)
    except urllib.error.HTTPError as e:
        return ("unreadable", f"the link returned HTTP {e.code}")
    except ValueError:
        return ("unreadable", "the link is malformed")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # Not the intern's fault until proven otherwise: DNS, a timeout, or this
        # machine being offline all look like this. `no-quorum` is retried in six
        # hours; a genuinely dead domain falls to the two-week safety net.
        return ("no-quorum", f"the link could not be fetched ({type(e).__name__})")
    # Google answers a restricted export with a redirect to its sign-in page.
    if _host_is(final, ("accounts.google.com",)) or "servicelogin" in final.lower():
        return ("unreadable", "the link is restricted to signed-in users")
    name = urllib.parse.urlparse(final).path.rsplit("/", 1)[-1]
    if "export?format=txt" in target or "export/txt" in target or "format=csv" in target:
        ct = ct if not ct.startswith("text/html") else ct
        if ct.startswith("text/html"):
            return _classify_page(data.decode("utf-8", "replace"))
        return _classify_bytes(data, "text/plain", "export.txt", workdir)
    return _classify_bytes(data, ct, name, workdir)


def evidence_for(row, workdir=None):
    """The one entry point. `row` is a `tasks:pendingForAgent` row."""
    workdir = workdir or tempfile.mkdtemp(prefix="orbit-evidence-")
    notes = row.get("submissionText") or ""

    if row.get("fileUrl"):
        try:
            data, ct, _ = _download(row["fileUrl"])
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return ("no-quorum", f"could not download the stored file ({type(e).__name__})")
        kind, body = _classify_bytes(data, row.get("fileContentType") or ct, "", workdir)
    elif row.get("link"):
        kind, body = _from_link(row["link"], workdir)
    else:
        if len(notes) < MIN_TEXT:
            return ("empty", "the submission contains no work, only a short note")
        return ("text", notes[:MAX_TEXT])

    # The intern's accompanying note is context, never a substitute for the work.
    if kind == "text" and notes and notes not in body:
        body = f"{body}\n\n[Intern's note with the submission]\n{notes[:2000]}"
    return (kind, body)
