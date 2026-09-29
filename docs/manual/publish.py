#!/usr/bin/env python3
"""
Builds every role's manual, renders the PDFs, and publishes both to the portal.

    python3 docs/manual/publish.py        # or: npm run manual:publish

One command because the steps used to be a README recipe, and the in-app
manifest (src/data/manuals.json) was maintained BY HAND despite the README
saying build.py generated it — so what the portal advertised and what the PDFs
contained could drift, and a new role would have needed four places edited.

For each role it writes:
  public/manuals/orbit-<role>-manual.pdf    the download
  public/manuals/orbit-<role>-manual.html   the same manual, readable online
and then src/data/manuals.json, which the Orientation page renders. The sync
test (src/test/unit/manual-sync.test.ts) fails if any of them disagree.
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PUBLIC = os.path.join(ROOT, 'public', 'manuals')
MANIFEST = os.path.join(ROOT, 'src', 'data', 'manuals.json')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

sys.path.insert(0, HERE)
from content import sections_for  # noqa: E402

# role -> (label shown in the app, published file stem, title)
ROLES = {
    'admin': ('Admin', 'orbit-admin-manual', 'Running ORBIT — Admin'),
    'moderator': ('Supervisor', 'orbit-supervisor-manual', 'Running ORBIT — Supervisor'),
    'intern': ('Intern', 'orbit-intern-manual', 'Your ORBIT handbook'),
}


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{' '.join(cmd[:3])}… failed:\n{p.stdout[-800:]}\n{p.stderr[-800:]}")
    return p


def main():
    os.makedirs(PUBLIC, exist_ok=True)
    manifest = {'generatedFrom': 'docs/manual/content.py (docs/manual/publish.py)', 'roles': {}}
    for role, (label, stem, title) in ROLES.items():
        run([sys.executable, os.path.join(HERE, 'build.py'), role])
        html = os.path.join(HERE, f'orbit-{role}-manual.html')
        pdf = os.path.join(PUBLIC, f'{stem}.pdf')
        run([CHROME, '--headless', '--disable-gpu', '--no-pdf-header-footer',
             f'--print-to-pdf={pdf}', f'file://{html}'])
        shutil.copyfile(html, os.path.join(PUBLIC, f'{stem}.html'))
        manifest['roles'][role] = {
            'label': label,
            'title': title,
            'file': f'/manuals/{stem}.pdf',
            'html': f'/manuals/{stem}.html',
            'sections': [t for (t, _) in sections_for(role)],
        }
        print(f'{role:10} {os.path.getsize(pdf)/1e6:5.2f} MB pdf   '
              f'{len(manifest["roles"][role]["sections"])} sections')
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {os.path.relpath(MANIFEST, ROOT)}')


if __name__ == '__main__':
    main()
