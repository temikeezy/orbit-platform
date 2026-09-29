import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../../data/manuals.json';

/**
 * The manuals, the app, and the published files must agree.
 *
 * `docs/manual/publish.py` builds one manual per role from `content.py`'s
 * `SECTION_ROLES`, publishes each as a PDF and as a readable HTML page under
 * `public/manuals/`, and writes `src/data/manuals.json`, which the Orientation
 * page renders. The manifest used to be edited by hand despite the README
 * saying it was generated, so these tests fail if it stops matching what
 * actually shipped — a manual advertised but not published, a role with no
 * manual, or a section handed to someone who cannot reach it.
 */
describe('manual manifest', () => {
  const root = resolve(__dirname, '../../..');
  const roles = manifest.roles as Record<
    string,
    { label: string; title: string; file: string; html: string; sections: string[] }
  >;

  it('has a manual for every kind of user, interns included', () => {
    // Interns are the only people who use ORBIT day to day, and until
    // 2026-09-29 they were the one role with no manual.
    expect(Object.keys(roles).sort()).toEqual(['admin', 'intern', 'moderator']);
  });

  it('publishes a PDF and a readable page for every role it advertises', () => {
    for (const [role, m] of Object.entries(roles)) {
      for (const file of [m.file, m.html]) {
        const path = resolve(root, 'public', file.replace(/^\//, ''));
        expect(existsSync(path), `${role}: ${file} is advertised but not in public/`).toBe(true);
        // A truncated or placeholder file would still "exist"; a real manual with
        // embedded screenshots is hundreds of kilobytes.
        const bytes = readFileSync(path).length;
        expect(bytes, `${role}: ${file} is only ${bytes} bytes`).toBeGreaterThan(100_000);
      }
    }
  });

  it('gives a supervisor strictly less than an admin, and nothing they cannot reach', () => {
    const admin = roles.admin.sections;
    const supervisor = roles.moderator.sections;

    expect(supervisor.length).toBeGreaterThan(0);
    expect(supervisor.length).toBeLessThan(admin.length);
    for (const s of supervisor) {
      expect(admin, `"${s}" is in the supervisor manual but not the admin one`).toContain(s);
    }
  });

  it('keeps admin-only operations out of the supervisor manual', () => {
    const supervisor = roles.moderator.sections.join(' | ').toLowerCase();
    for (const forbidden of ['admissions', 'acceptance letter', 'placement', 'email:', 'settings']) {
      expect(supervisor, `supervisor manual mentions "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('keeps the work a supervisor actually does, and how the agent now does it', () => {
    const supervisor = roles.moderator.sections.join(' | ').toLowerCase();
    for (const needed of ['runs itself', 'reviewing submissions', 'logbook', 'task proposals']) {
      expect(supervisor, `supervisor manual is missing "${needed}"`).toContain(needed);
    }
  });

  it('keeps every staff operation out of the intern handbook', () => {
    const intern = roles.intern.sections;
    const staff = new Set([...roles.admin.sections, ...roles.moderator.sections]);
    for (const s of intern) {
      expect(staff.has(s), `"${s}" is in both the intern handbook and a staff manual`).toBe(false);
    }
    const text = intern.join(' | ').toLowerCase();
    for (const forbidden of ['admissions', 'reviewing submissions', 'proposals', 'settings and accounts']) {
      expect(text, `intern handbook mentions "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('covers what an intern actually does', () => {
    const text = roles.intern.sections.join(' | ').toLowerCase();
    for (const needed of ['tasks', 'handing in', 'marked', 'logbook', 'help']) {
      expect(text, `intern handbook is missing "${needed}"`).toContain(needed);
    }
  });

  it('records where it was generated from, so the source is findable', () => {
    // Someone editing the JSON by hand needs to know it will be overwritten.
    expect(manifest.generatedFrom).toContain('docs/manual/content.py');
    expect(existsSync(resolve(root, 'docs/manual/content.py'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/manual/publish.py'))).toBe(true);
  });
});
