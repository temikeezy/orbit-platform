import { Download, FileText, Check, BookOpen } from 'lucide-react';
import manifest from '../../data/manuals.json';

/**
 * The reader's own manual: read online, or download the same thing as a PDF.
 *
 * ONE PER ROLE. Interns get "Your ORBIT handbook" — how to do tasks, hand in
 * work that can be marked, keep a logbook, get help. Staff get "Running ORBIT",
 * which since the portal began running itself (2026-09-29) explains what the
 * ORBIT Agent does and how to step in. Until then interns, the only people who
 * use ORBIT daily, had no manual at all.
 *
 * SYNCED BY CONSTRUCTION. The section list and both file paths come from
 * `src/data/manuals.json`, which `docs/manual/publish.py` writes from the
 * same `SECTION_ROLES` mapping it filters the manuals with. So "what is in my
 * manual" has one answer rather than two that drift — previously the PDF was a
 * separate document maintained by hand, and nothing made it agree with the app.
 *
 * A supervisor's manual is deliberately shorter than an admin's: it omits
 * admissions, letters, accounts, email and settings, none of which a moderator
 * can reach. Handing them those pages describes buttons they will never find.
 */

export type ManualRole = 'admin' | 'moderator' | 'intern';

interface RoleManual {
  label: string;
  title: string;
  file: string;
  html: string;
  sections: string[];
}

export function ManualCard({ role }: { role: ManualRole }) {
  const manual = (manifest.roles as Record<string, RoleManual>)[role];
  if (!manual) return null;

  return (
    <section
      aria-labelledby="manual-heading"
      className="mb-8 rounded-xl border border-slate-200 bg-white p-6 shadow-orbit-sm"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2
            id="manual-heading"
            className="text-lg font-semibold text-orbit-ink flex items-center gap-2"
          >
            <FileText className="w-5 h-5 text-iih-green" aria-hidden />
            {manual.title}
          </h2>
          <p className="text-sm text-orbit-muted mt-1">
            {role === 'intern'
              ? 'Everything you do on ORBIT, with screenshots of every screen.'
              : 'How ORBIT runs, and how to step in, with screenshots of every screen.'}
          </p>
        </div>

        {/*
          A plain link, not a fetch — the PDF is a static asset, so the browser
          downloads it directly and a failure is a visible 404 rather than a
          spinner that never resolves.
        */}
        <div className="flex gap-2 flex-wrap">
        {/*
          The HTML manual is self-contained (screenshots embedded), so it opens
          as a static page with nothing to load and nothing for the CSP to block.
        */}
        <a
          href={manual.html}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 shrink-0 border border-iih-green text-iih-green hover:bg-emerald-50 font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <BookOpen className="w-4 h-4" aria-hidden />
          Read online
        </a>
        <a
          href={manual.file}
          download={`ORBIT ${manual.label} Manual.pdf`}
          className="inline-flex items-center gap-2 shrink-0 bg-iih-green hover:bg-iih-green-dark text-white font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Download className="w-4 h-4" aria-hidden />
          Download PDF
        </a>
        </div>
      </div>

      <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
        {manual.sections.map((title) => (
          <li key={title} className="flex items-start gap-2 text-sm text-slate-700">
            <Check className="w-4 h-4 shrink-0 mt-0.5 text-iih-green" aria-hidden />
            {title}
          </li>
        ))}
      </ul>

      <p className="text-xs text-orbit-muted mt-4">
        {manual.sections.length} sections. This list is generated from the manual itself, so
        it always matches what you read.
      </p>
    </section>
  );
}
