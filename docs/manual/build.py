#!/usr/bin/env python3
"""
Builds the ORBIT staff manual into a single self-contained HTML file.

Screenshots are embedded as data URIs because the published page runs under a
CSP that blocks every external host — a linked image would silently show
nothing. Re-run this after re-capturing screenshots; the content lives in
content.py beside it.
"""
import base64, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, 'img', 'opt')
OUT = os.path.join(HERE, 'orbit-staff-manual.html')

sys.path.insert(0, HERE)
from content import SECTIONS, INTRO, TITLE, STANDFIRST, sections_for  # noqa: E402

# ---------------------------------------------------------------------------
# ROLE-SPECIFIC BUILDS
#
# `python3 build.py` alone still writes the combined manual, unchanged. Passing
# a role writes that role's manual instead, with only the sections they can
# actually reach — a supervisor's copy no longer walks them through admissions,
# letters, accounts and settings, none of which they have a route to.
#
# The section list comes from content.py's own mapping rather than being
# restated here, so the PDF and the in-app manual cannot disagree about who
# sees what.
# ---------------------------------------------------------------------------
ROLE = (sys.argv[1] if len(sys.argv) > 1 else '').strip().lower()
ROLE_LABEL = {'admin': 'Admin', 'moderator': 'Supervisor', 'intern': 'Intern'}

if ROLE and ROLE not in ROLE_LABEL:
    raise SystemExit(f"Unknown role {ROLE!r}. Use one of: {', '.join(ROLE_LABEL)}, or none for the combined manual.")

if not ROLE:
    # The combined manual is the STAFF manual. The intern sections are a separate
    # document for a different reader and do not belong in it.
    SECTIONS = [(t, b) for (t, b) in SECTIONS if t not in dict(sections_for('intern'))]

if ROLE:
    SECTIONS = sections_for(ROLE)
    OUT = os.path.join(HERE, f'orbit-{ROLE}-manual.html')
    TITLE = f'Running ORBIT — {ROLE_LABEL[ROLE]}'
    if ROLE == 'intern':
        TITLE = 'Your ORBIT handbook'
        STANDFIRST = (
            'How to take on your weekly tasks, hand in work that can be marked, keep your '
            'logbook, and get help — everything you do on ORBIT, screen by screen.'
        )
        INTRO = (
            '<p>This handbook is for interns on every ORBIT programme — SIWES, internship, '
            'NYSC and volunteer. The parts that only apply to some of you, like the logbook, '
            'say so. It is written to be looked up rather than read through, so each section '
            'stands on its own; start with <a href="#getting-started">{{sec:getting-started}}</a> '
            'if you are new.</p>'
        )
    elif ROLE == 'moderator':
        # The combined standfirst and intro both describe ADMIN work — admitting
        # applicants, issuing SIWES letters, placing interns — none of which a
        # supervisor can do. Worse, the intro's callout linked to "Section 03",
        # which does not exist in a supervisor's manual: acceptance letters are
        # admin-only, so the anchor pointed at nothing. A manual that opens by
        # describing someone else's job and then links into a missing section
        # teaches the reader not to trust it.
        STANDFIRST = (
            'Everything this role can reach, and nothing it cannot. The ORBIT Agent now '
            'marks your interns\' work, reviews their logbooks and writes their tasks; this '
            'is how that works and how to step in when you want to — screen by screen.'
        )
        INTRO = (
            '<p>A supervisor moderates streams: the interns on them, the work those interns '
            'submit, the logbooks they keep, and the tasks set for them each week. Since '
            '29 September 2026 the ORBIT Agent does that work unattended '
            '(<a href="#how-orbit-runs-itself">{{sec:how-orbit-runs-itself}}</a>), so nothing '
            'here waits on you — but anything you decide first is yours, and the agent leaves '
            'it alone. Everything is scoped to your own streams, enforced on the server. '
            'Admissions, acceptance letters, accounts and platform settings are admin work and '
            'are deliberately absent from this manual.</p>'
        )
    else:
        STANDFIRST = (
            'Everything this role can reach, and nothing it cannot. '
            + STANDFIRST
        )

# Named for whoever is actually holding it. The combined manual said "Admins &
# supervisors" on every copy, which on a supervisor's own manual advertised a
# role they do not have.
AUDIENCE = {'admin': 'Admins', 'moderator': 'Supervisors', 'intern': 'Interns'}.get(ROLE, 'Admins &amp; supervisors')


def data_uri(name: str) -> str:
    with open(os.path.join(IMG, name), 'rb') as f:
        return 'data:image/png;base64,' + base64.b64encode(f.read()).decode()


def figure(name: str, caption: str) -> str:
    return (
        f'<figure class="shot">'
        f'<img src="{data_uri(name)}" alt="{caption}" loading="lazy">'
        f'<figcaption>{caption}</figcaption>'
        f'</figure>'
    )


def render_block(b) -> str:
    kind = b[0]
    if kind == 'p':
        return f'<p>{b[1]}</p>'
    if kind == 'h':
        return f'<h3 id="{slug(b[1])}">{b[1]}</h3>'
    if kind == 'steps':
        items = ''.join(f'<li>{s}</li>' for s in b[1])
        return f'<ol class="steps">{items}</ol>'
    if kind == 'bullets':
        items = ''.join(f'<li>{s}</li>' for s in b[1])
        return f'<ul class="bullets">{items}</ul>'
    if kind == 'shot':
        return figure(b[1], b[2])
    if kind == 'note':
        return f'<aside class="note note--{b[1]}"><p>{b[2]}</p></aside>'
    if kind == 'table':
        head = ''.join(f'<th>{h}</th>' for h in b[1])
        rows = ''.join(
            '<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in b[2]
        )
        return (
            f'<div class="tablewrap"><table><thead><tr>{head}</tr></thead>'
            f'<tbody>{rows}</tbody></table></div>'
        )
    raise ValueError(kind)


def slug(t: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')


nav, body = [], []
for i, (title, blocks) in enumerate(SECTIONS, start=1):
    sid = slug(title)
    nav.append(f'<li><a href="#{sid}"><span class="num">{i:02d}</span>{title}</a></li>')
    inner = ''.join(render_block(b) for b in blocks)
    body.append(
        f'<section id="{sid}" class="section">'
        f'<header class="section__head"><span class="eyebrow">Section {i:02d}</span>'
        f'<h2>{title}</h2></header>{inner}</section>'
    )

LOGO_URI = data_uri('orbit-logo.png')
TITLE_UPPER = TITLE.upper().replace('"', '')

HTML = f'''<title>{TITLE}</title>
<style>
:root {{
  --ink:#102018; --ink-soft:#1B2F26; --graphite:#33423B; --muted:#66736D;
  --canvas:#EDF2F0; --surface:#FFFFFF; --subtle:#F7FAF8; --line:#D8E2DD;
  --green:#16A464; --green-dark:#0E7A4B; --mint:#DFF4EA;
  --amber:#A06A18; --amber-soft:#F7EACB; --danger:#B7443E; --danger-soft:#F7E2E1;
  --sky:#256D85; --sky-soft:#DDEEF3;
  --shadow:0 1px 2px rgba(16,32,24,.06), 0 8px 24px -12px rgba(16,32,24,.18);
  --sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}}
/*
  LIGHT ONLY, DELIBERATELY.

  This carried a dark theme that followed the reader's OS, so the manual
  rendered near-black (#0C1512) for anyone with dark mode on — while the PDF
  built from the same source stayed light. Two people reading "the manual"
  saw different documents, and screenshots captured against the light app UI
  sat in a dark page, which is the combination that reads worst of all.

  A manual is a reference that gets printed, quoted and screenshotted. It
  should look the same everywhere, and match the PDF it ships as.
*/

* {{ box-sizing:border-box; }}
body {{
  margin:0; background:var(--canvas); color:var(--ink);
  font-family:var(--sans); font-size:16px; line-height:1.65;
  -webkit-font-smoothing:antialiased;
}}
a {{ color:var(--green-dark); }}
:focus-visible {{ outline:2px solid var(--green); outline-offset:2px; border-radius:3px; }}

.wrap {{ max-width:1180px; margin:0 auto; padding:0 24px; }}

/* ---- masthead ---- */
.brandmark {{ height:44px; width:auto; display:block; margin-bottom:14px; }}
.runninghead {{ display:none; }}
.masthead {{ border-bottom:1px solid var(--line); background:var(--surface); }}
.masthead .wrap {{ padding-top:56px; padding-bottom:44px; }}
.brandline {{
  display:flex; align-items:center; gap:10px; margin-bottom:22px;
  font-family:var(--mono); font-size:12px; letter-spacing:.14em;
  text-transform:uppercase; color:var(--muted);
}}
.brandline .dot {{ width:9px; height:9px; border-radius:50%; background:var(--green); }}
h1 {{
  margin:0 0 14px; font-size:clamp(34px,5vw,52px); line-height:1.08;
  letter-spacing:-.022em; font-weight:650; text-wrap:balance;
}}
.standfirst {{ margin:0; max-width:60ch; font-size:18px; color:var(--graphite); }}
.meta {{
  margin-top:28px; padding-top:18px; border-top:1px solid var(--line);
  display:flex; flex-wrap:wrap; gap:26px;
  font-family:var(--mono); font-size:12px; color:var(--muted);
}}
.meta b {{ color:var(--ink); font-weight:600; }}

/* ---- layout ---- */
.layout {{ display:grid; grid-template-columns:236px 1fr; gap:52px; padding:48px 0 96px; align-items:start; }}
@media (max-width:900px) {{ .layout {{ grid-template-columns:1fr; gap:0; }} }}

nav.toc {{ position:sticky; top:24px; }}
@media (max-width:900px) {{
  nav.toc {{ position:static; margin-bottom:36px; padding-bottom:28px; border-bottom:1px solid var(--line); }}
}}
.toc h2 {{
  margin:0 0 14px; font-family:var(--mono); font-size:11px; letter-spacing:.16em;
  text-transform:uppercase; color:var(--muted); font-weight:600;
}}
.toc ol {{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:1px; }}
.toc a {{
  display:flex; gap:10px; padding:7px 10px; border-radius:7px;
  text-decoration:none; color:var(--graphite); font-size:14px; line-height:1.35;
}}
.toc a:hover {{ background:var(--subtle); color:var(--ink); }}
.toc .num {{ font-family:var(--mono); font-size:11px; color:var(--muted); padding-top:3px; }}

/* ---- sections ---- */
.section {{ margin-bottom:64px; scroll-margin-top:20px; }}
.section__head {{ margin-bottom:22px; padding-bottom:14px; border-bottom:2px solid var(--ink); }}
.eyebrow {{
  display:block; margin-bottom:6px; font-family:var(--mono); font-size:11px;
  letter-spacing:.16em; text-transform:uppercase; color:var(--green-dark);
}}
.section h2 {{ margin:0; font-size:28px; letter-spacing:-.015em; font-weight:650; text-wrap:balance; }}
.section h3 {{
  margin:36px 0 12px; font-size:18px; font-weight:620; letter-spacing:-.008em;
  scroll-margin-top:20px;
}}
.section p {{ margin:0 0 16px; max-width:68ch; }}
code {{
  font-family:var(--mono); font-size:.88em; background:var(--subtle);
  border:1px solid var(--line); border-radius:4px; padding:1px 5px;
}}
strong {{ font-weight:620; }}

ol.steps {{ counter-reset:s; list-style:none; margin:0 0 20px; padding:0; max-width:68ch; }}
ol.steps li {{ counter-increment:s; position:relative; padding-left:38px; margin-bottom:12px; }}
ol.steps li::before {{
  content:counter(s); position:absolute; left:0; top:1px;
  width:24px; height:24px; border-radius:50%; background:var(--mint); color:var(--green-dark);
  font-family:var(--mono); font-size:12px; font-weight:600;
  display:flex; align-items:center; justify-content:center;
}}
ul.bullets {{ margin:0 0 20px; padding-left:20px; max-width:68ch; }}
ul.bullets li {{ margin-bottom:9px; }}

.note {{ margin:0 0 22px; padding:14px 18px; border-radius:9px; border-left:3px solid; max-width:68ch; }}
.note p {{ margin:0; }}
.note--care {{ background:var(--amber-soft); border-color:var(--amber); }}
.note--stop {{ background:var(--danger-soft); border-color:var(--danger); }}
.note--info {{ background:var(--sky-soft); border-color:var(--sky); }}

.shot {{ margin:22px 0 28px; }}
.shot img {{
  display:block; width:100%; height:auto; border:1px solid var(--line);
  border-radius:10px; box-shadow:var(--shadow); background:var(--surface);
}}
.shot figcaption {{ margin-top:9px; font-size:13.5px; color:var(--muted); max-width:68ch; }}

.tablewrap {{ overflow-x:auto; margin:0 0 24px; }}
table {{ border-collapse:collapse; width:100%; font-size:14.5px; min-width:460px; }}
th, td {{ text-align:left; padding:9px 14px 9px 0; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{
  font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--muted); font-weight:600; border-bottom:1px solid var(--ink);
}}

footer.end {{ border-top:1px solid var(--line); background:var(--surface); }}
footer.end .wrap {{ padding:28px 24px 44px; font-size:13.5px; color:var(--muted); }}
@media print {{
  /* Bottom margin widened from 18mm to make room for the running mark. */
  @page {{
    size:A4; margin:16mm 15mm 24mm;
    /* The running mark, IN THE MARGIN. A page-margin box is laid out in the
       page's own margin, so unlike the fixed element below it can never sit on
       the text column's last line — which is exactly what the fixed version did
       to every full page (a table row, a step) once content reached the foot. */
    @bottom-left {{
      content: "ILORIN INNOVATION HUB · ORBIT · {TITLE_UPPER}";
      font-family: 'Inter', system-ui, sans-serif; font-size:7.5pt; letter-spacing:.06em;
      color:#7C8B84; vertical-align: middle;
    }}
    @bottom-right {{
      content: counter(page);
      font-family: 'Inter', system-ui, sans-serif; font-size:7.5pt; color:#7C8B84;
      vertical-align: middle;
    }}
  }}

  /*
   * THE RUNNING MARK, on every page.
   *
   * `position: fixed` is the one thing Chrome's print-to-pdf repeats per page,
   * which is how the logo reaches page 40 rather than page 1 only.
   *
   * IT SITS AT THE FOOT, and that is a constraint rather than a preference.
   * Chrome clamps any upward-shifted fixed element to the bottom of the page —
   * negative `top` and `translateY` were both tried and both landed here — and
   * a fixed element reserves no space, so one placed at the top of the text
   * column prints over the first line of every page. A true running header
   * needs the document restructured so its content lives in a table whose
   * `<thead>` repeats, which is a different and much larger change.
   */
  /* Superseded by the @page margin boxes above; kept for the screen-free
     markup but never printed, because a fixed element reserves no space. */
  .runninghead {{
    display:none !important;
    position:fixed; bottom:0; left:0; right:0;
    font-size:7.5pt; letter-spacing:.06em; text-transform:uppercase;
    color:#7C8B84; border-top:0.4pt solid #D8E2DD; padding-top:2.5mm;
  }}
  .runninghead img {{ height:7mm; width:auto; }}
  html, body {{ background:#fff; color:#102018; font-size:10.5pt; }}
  .masthead {{ border-bottom:none; }}
  .masthead .wrap {{ padding:0 0 22mm; }}
  h1 {{ font-size:32pt; }}
  .standfirst {{ font-size:12pt; }}
  /* The sidebar is a screen affordance; the contents page does that job on paper. */
  nav.toc {{ display:none; }}
  .wrap {{ max-width:none; padding:0; }}
  .layout {{ display:block; padding:0; }}
  /*
   * A figure must fit on ONE page, or `break-inside: avoid` below becomes an
   * impossible constraint and Chrome resolves it by CLIPPING the image.
   *
   * The usable text column is 297mm minus 34mm of margins, so a figure taller
   * than that can never be placed. Capping the height makes a tall shot scale
   * down — narrower, complete, centred — instead of being cut off mid-content.
   * `width:auto` is what keeps the aspect ratio while the cap does the work;
   * without it the image is stretched rather than scaled.
   */
  .shot img {{
    box-shadow:none;
    max-height:196mm; width:auto; max-width:100%; margin:0 auto;
  }}
  /* Nothing that must be read as one thing may straddle a page. */
  .shot, .note, .tablewrap, ol.steps li, tr {{ break-inside:avoid; page-break-inside:avoid; }}
  /* The whole list, not just each item. A numbered procedure split across a
     page turn reads as two shorter procedures — the reader follows steps 1-3,
     turns nothing, and acts. Lists here are short enough to keep together. */
  ol.steps, ul.bullets {{ break-inside:avoid; page-break-inside:avoid; }}
  /* A figure separated from the sentence that introduces it reads as a non sequitur. */
  .shot figcaption {{ break-before:avoid; page-break-before:avoid; }}
  .section {{ break-before:page; page-break-before:always; margin-bottom:0; }}
  .section__head, .section h3 {{ break-after:avoid; page-break-after:avoid; }}
  /* No single line of a paragraph left alone at a page boundary. orphans/widows
     alone did not achieve this — a four-line paragraph still split 3+1, leaving
     one line as the entire content of a page. Every paragraph here is bounded to
     68ch and runs a few lines, so keeping each one whole costs a little ragged
     space at a page foot and removes the stranded-line case entirely. */
  p, li {{ orphans:3; widows:3; }}
  .section p {{ break-inside:avoid; page-break-inside:avoid; }}
  a {{ color:#0E7A4B; text-decoration:none; }}
  footer.end {{ border-top:1px solid #D8E2DD; }}
}}
</style>

<div class="runninghead" aria-hidden="true">
  <img src="{LOGO_URI}" alt="">
  <span>Ilorin Innovation Hub &middot; ORBIT &middot; {TITLE}</span>
</div>

<header class="masthead"><div class="wrap">
  <img class="brandmark" src="{LOGO_URI}" alt="Ilorin Innovation Hub — ORBIT">
  <div class="brandline"><span class="dot"></span> Ilorin Innovation Hub &middot; ORBIT</div>
  <h1>{TITLE}</h1>
  <p class="standfirst">{STANDFIRST}</p>
  <div class="meta">
    <span><b>For</b> {AUDIENCE}</span>
    <span><b>Platform</b> orbit2.iih.ng</span>
    <span><b>Cohort</b> ORBIT 2.0</span>
  </div>
</div></header>

<div class="wrap"><div class="layout">
  <nav class="toc" aria-label="Sections">
    <h2>Contents</h2>
    <ol>{''.join(nav)}</ol>
  </nav>
  <main>
    {INTRO}
    {''.join(body)}
  </main>
</div></div>

<footer class="end"><div class="wrap">
  Screenshots are from the ORBIT test environment, so every name and record in them is
  fictional. The live platform looks identical.
</div></footer>
'''

# ---------------------------------------------------------------------------
# NO DANGLING CROSS-REFERENCES.
#
# Filtering sections by role silently breaks any link INTO a section the role
# does not get. The supervisor manual shipped exactly that: its opening callout
# pointed at "Section 03 — Acceptance letters", which is admin-only, so the
# anchor resolved to nothing. A manual that links into a missing section teaches
# its reader not to trust it, and nothing would have caught it but reading the
# PDF.
# ---------------------------------------------------------------------------
# SECTION NUMBERS ARE PER MANUAL. A supervisor's manual numbers its sections
# 01..06 where the admin's runs 01..13, so content never hardcodes "Section 05":
# it writes {{sec:slug}} and it is resolved here against THIS manual's numbering.
# A reference to a section this role does not have fails the build below.
_numbers = {slug(t): i for i, (t, _) in enumerate(SECTIONS, start=1)}
def _resolve(text: str) -> str:
    def sub(m):
        n = _numbers.get(m.group(1))
        if n is None:
            raise SystemExit(f"{OUT}: {{{{sec:{m.group(1)}}}}} names a section this manual does not have.")
        return f'Section {n:02d}'
    return re.sub(r'\{\{sec:([a-z0-9-]+)\}\}', sub, text)
INTRO = _resolve(INTRO)
body = [_resolve(b) for b in body]
HTML = _resolve(HTML)

_targets = set(re.findall(r'id="([a-z0-9-]+)" class="section"', ''.join(body)))
_links = set(re.findall(r'href="#([a-z0-9-]+)"', INTRO + ''.join(body)))
_dangling = sorted(_links - _targets)
if _dangling:
    raise SystemExit(
        f"{OUT}: link(s) to section(s) this role does not have: {', '.join(_dangling)}. "
        f"Either give the role that section in SECTION_ROLES, or reword the reference."
    )

with open(OUT, 'w') as f:
    f.write(HTML)
print(f'{OUT}  {os.path.getsize(OUT)/1e6:.2f} MB')
