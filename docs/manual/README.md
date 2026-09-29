# ORBIT manuals

One manual per role — **admin**, **supervisor** and **intern** — published on the portal
(`/orientation` → Manual: read online or download the PDF) and built from one source.

**To rebuild and publish all three:** `npm run manual:publish` (`publish.py`). It builds each
role, renders the PDFs with headless Chrome, copies PDF + HTML into `public/manuals/`, and
writes `src/data/manuals.json`, which the in-app card renders. Then deploy the frontend.
The older recipes below still work for building one file by hand.

## Rebuilding

```bash
cd docs/manual
python3 build.py                      # content.py + img/opt/ -> orbit-staff-manual.html

# then render the PDF (A4, print stylesheet in build.py)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="ORBIT Staff Manual.pdf" \
  "file://$PWD/orbit-staff-manual.html"
```

| File | What it is |
|---|---|
| `content.py` | All the wording. Edit here. |
| `build.py` | Renders content + screenshots into one self-contained HTML file, and holds the stylesheet (screen and print). |
| `img/` | Screenshots as captured. |
| `img/opt/` | The same images resized to 1200px and quantised — this is what gets embedded. |
| `orbit-staff-manual.html` | Generated. Do not edit by hand. |
| `ORBIT Staff Manual.pdf` | Generated. What actually gets emailed. |

Screenshots are embedded as data URIs so the file works as a single attachment with no
external requests.

## Re-capturing screenshots

They were taken from the **dev** deployment, deliberately: production holds real applicant
data — names, emails, matric numbers — and a manual circulated to the team would carry it.
Dev holds only test and demo records, so the document is safe to share.

The whole pipeline is three commands:

```bash
export ORBIT_TEST_MCP_SECRET=$(npx convex env get MCP_SERVER_SECRET)
npm run capture:manual     # e2e/capture/manual-shots.capture.ts -> img/
npm run manual:optimise    # img/ -> img/opt/ (1200px, 8-bit palette)
npm run manual:build       # content.py + img/opt/ -> orbit-staff-manual.html
```

then render the PDF with the Chrome command above.

Both scripts are committed now. The previous ones were not — the capture spec
(`e2e/zz-manual-shots.spec.ts`) and the optimise step existed only on someone's
machine, so "re-shoot the manual" meant rewriting the harness first. That is why
the screenshots went stale.

The shot list lives in `SHOTS` at the top of `manual-shots.capture.ts`, and every
filename there must match a `('shot', ...)` block in `content.py`.

Three things that harness gets right and an ad-hoc script will not:

- **It waits for `animate-pulse`, not just `animate-spin`.** Skeleton loaders use
  the former, so waiting only for spinners photographs the SIWES tabs as grey
  placeholder bars under captions describing data that is not in the picture.
- **Framing is per shot.** `viewport` for a screen, `element` with a selector for
  a form or a letter, `full` only where the whole scroll matters. A full-page
  capture of an admin list becomes an unreadable sliver once the print height cap
  scales it to fit A4.
- **It is one test per role**, so a slow step cannot eat the whole run's timeout
  and take every remaining shot down with it.

Demo applicants on dev (Aisha Bello, Chinedu Okafor and friends) are fictional and were
seeded through the public intake endpoint so the screens show recognisable names rather
than `E2E intern tjoo1x`.

## Role-specific manuals

`python3 build.py` alone builds the combined manual, as before. Passing a role
builds that role's manual instead — only the sections they can actually reach:

```bash
cd docs/manual
python3 build.py admin       # -> orbit-admin-manual.html      (11 sections)
python3 build.py moderator   # -> orbit-moderator-manual.html  (5 sections)

# then the PDFs, A4, via headless Chrome
for r in admin moderator; do
  label=$([ "$r" = admin ] && echo Admin || echo Supervisor)
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="ORBIT $label Manual.pdf" \
    "file://$PWD/orbit-$r-manual.html"
done

# publish them and regenerate the manifest the app reads
cp "ORBIT Admin Manual.pdf"      ../../public/manuals/orbit-admin-manual.pdf
cp "ORBIT Supervisor Manual.pdf" ../../public/manuals/orbit-supervisor-manual.pdf
```

**Who gets which section is declared once**, in `content.py`'s `SECTION_ROLES`.
`build.py` filters the manuals from it, and `publish.py` generates `src/data/manuals.json`
from it, which is what the in-app card on `/orientation` renders. So the page
and the PDF cannot disagree about what a role's manual contains —
`src/test/unit/manual-sync.test.ts` fails if they do, if an advertised PDF
is missing from `public/`, or if an admin-only topic appears in the supervisor
manual.

Adding a section without a `SECTION_ROLES` entry raises rather than silently
dropping it from every manual.
