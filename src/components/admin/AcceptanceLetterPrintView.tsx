import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';
import { AlertTriangle, Printer, X } from 'lucide-react';
import {
  AcceptanceLetterConfig,
  DEFAULT_LETTER_CONFIG,
  LETTER_CLOSING,
  LetterCandidate,
  buildAcceptanceLetter,
  letterDateInputValue,
  parseLetterDateInput,
} from '../../../convex/lib/acceptanceLetter';
import { ORG_NAME } from '../../config/org';
import iihLogo from '../../assets/letterhead/iih-logo.png';
import iihContact from '../../assets/letterhead/iih-contact.png';
import { acceptanceLettersApi } from '../../lib/api/acceptanceLetters';

/**
 * Bolds the first mention of each given term, as the source document does.
 *
 * The student's name and the organisation are emphasised where they FIRST
 * appear and left plain afterwards — bolding every occurrence would make the
 * second paragraph, which names both, read as though it were shouting.
 *
 * Matching is literal and case sensitive: these strings come from the same
 * places the sentence was built from, so a match is exact or it is a term that
 * was dropped from the letter (an absent department, say) and should not be
 * hunted for.
 */
function emphasise(text: string, terms: string[]): ReactNode {
  const seen = new Set<string>();
  let rest = text;
  const out: ReactNode[] = [];

  for (;;) {
    let at = -1;
    let hit = '';

    for (const term of terms) {
      const clean = term?.trim();
      if (!clean || seen.has(clean)) continue;
      const found = rest.indexOf(clean);
      if (found !== -1 && (at === -1 || found < at)) {
        at = found;
        hit = clean;
      }
    }

    if (at === -1) break;

    seen.add(hit);
    out.push(rest.slice(0, at), <strong key={`${hit}-${out.length}`}>{hit}</strong>);
    rest = rest.slice(at + hit.length);
  }

  out.push(rest);
  return out;
}

interface AcceptanceLetterPrintViewProps {
  /** One accepted candidate, or every accepted candidate for a batch. */
  candidates: LetterCandidate[];
  /**
   * Set when a batch hit the server's ceiling, so the shortfall is stated.
   *
   * A batch that stops at its cap and says nothing is the failure this whole
   * screen exists to avoid: the admin prints what they are given, posts it, and
   * finds out in September which students were never written for.
   */
  truncatedAt?: number | null;
  onClose: () => void;
}

/**
 * The printable SIWES acceptance letter.
 *
 * Print-to-PDF rather than a generated PDF file: it is what the logbook export
 * already does, it adds no dependency, and "Save as PDF" in the browser's print
 * dialog produces the same document an admin would otherwise print. The letter
 * has to be signed on paper regardless, so producing a PDF server-side would not
 * remove a step — it would only move where the wording lives.
 *
 * Portalled to <body> so the print stylesheet can hide the application while it
 * is open. See the `@media print` block in index.css for why a fixed overlay
 * inside the app tree prints the dashboard underneath the letter.
 */
export function AcceptanceLetterPrintView({
  candidates,
  truncatedAt = null,
  onClose,
}: AcceptanceLetterPrintViewProps) {
  const [dateValue, setDateValue] = useState(() => letterDateInputValue(new Date()));
  const [config, setConfig] = useState<AcceptanceLetterConfig>(DEFAULT_LETTER_CONFIG);
  const [loadingConfig, setLoadingConfig] = useState(true);

  /**
   * True once the admin has touched either signatory field.
   *
   * The inputs are live before `getConfig()` resolves — deliberately, so the
   * view is usable immediately — which means a slow response would otherwise
   * land on top of a name already being typed and silently replace it. The
   * stored value only wins if nothing has been typed yet.
   */
  const signatoryEdited = useRef(false);

  useEffect(() => {
    let cancelled = false;

    acceptanceLettersApi
      .getConfig()
      .then((stored) => {
        if (!cancelled && !signatoryEdited.current) setConfig(stored);
      })
      .catch(() => {
        // Not fatal. The letters still render, with the signatory reported as
        // missing in the warning below — more useful than refusing to open the
        // view on the afternoon a cohort's letters are due.
        if (!cancelled) toast.error('Could not load the saved signatory.');
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** Hides the application while this view is mounted — print only. */
  useEffect(() => {
    document.body.classList.add('orbit-printing');
    return () => document.body.classList.remove('orbit-printing');
  }, []);

  /**
   * Names the file a "Save as PDF" produces.
   *
   * Browsers take the default file name from `document.title`. Without this
   * every letter saves as the app's own title, and an admin generating thirty
   * has thirty files they cannot tell apart.
   */
  useEffect(() => {
    const previous = document.title;
    document.title =
      candidates.length === 1
        ? `SIWES Acceptance Letter - ${candidates[0].fullName.trim() || 'Candidate'}`
        : `SIWES Acceptance Letters (${candidates.length})`;

    return () => {
      document.title = previous;
    };
  }, [candidates]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Cleared or half-typed, the date falls back to today rather than printing
  // "Invalid Date" onto a letter bound for a university. Tracked rather than
  // swallowed: the fallback is silent otherwise, and a letter dated today when
  // the admin meant to date it last Monday is wrong in a way nobody re-reads.
  const parsedDate = parseLetterDateInput(dateValue);
  const dateFellBack = parsedDate === null;

  const letters = useMemo(() => {
    const letterDate = parseLetterDateInput(dateValue) ?? new Date();

    return candidates.map((candidate) => ({
      candidate,
      letter: buildAcceptanceLetter(candidate, config, letterDate, ORG_NAME),
    }));
  }, [candidates, config, dateValue]);

  const incomplete = letters.filter((item) => item.letter.missing.length > 0);

  return createPortal(
    <div className="orbit-print-root fixed inset-0 z-50 overflow-y-auto bg-white">
      <div className="sticky top-0 z-10 border-b border-orbit-line bg-orbit-subtle print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div>
            <h2 className="text-base font-semibold text-orbit-ink">
              SIWES acceptance{' '}
              {candidates.length === 1 ? 'letter' : `letters (${candidates.length})`}
            </h2>
            <p className="text-xs text-orbit-muted">
              Print, or choose Save as PDF in the print dialog. Each letter prints on its own page.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-lg bg-iih-green px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-iih-green-dark"
            >
              <Printer className="h-4 w-4" />
              Print
            </button>
            <button
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-lg border border-orbit-line bg-white px-4 py-2 text-sm font-semibold text-orbit-graphite transition-colors hover:bg-orbit-subtle"
            >
              <X className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-orbit-line px-6 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-orbit-muted">
              Letter date
            </span>
            <input
              type="date"
              value={dateValue}
              onChange={(event) => setDateValue(event.target.value)}
              className="rounded-lg border border-orbit-line px-3 py-2 font-mono text-sm text-orbit-ink focus:border-iih-green focus:ring-2 focus:ring-iih-green/20"
            />
          </label>

          {/*
            READ-ONLY. Chosen in Settings by a super admin, and shown here so
            whoever prints can see who signs.

            These were editable text inputs, which quietly undid the whole
            control: anyone who can print a letter could type any name and any
            title onto the document that actually leaves IIH, while the mutation
            behind Settings was carefully gated to super admins. A gate on the
            stored value means nothing if the printed value is a free-text box
            beside the print button.
          */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-orbit-muted">
              Signatory
            </span>
            <p className="rounded-lg border border-orbit-line bg-white px-3 py-2 text-sm text-orbit-ink">
              {loadingConfig ? 'Loading…' : config.signatoryName || 'Not set'}
              {config.signatoryTitle && !loadingConfig && (
                <span className="text-orbit-muted"> · {config.signatoryTitle}</span>
              )}
            </p>
            <span className="text-xs text-orbit-muted">
              Set in Admin → Settings → Acceptance Letter Signatory.
            </span>
          </div>

        </div>

        {dateFellBack && (
          <div className="flex items-start gap-2 border-t border-orbit-amber/30 bg-orbit-amber-soft px-6 py-2 text-sm text-orbit-ink print:hidden">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orbit-amber" />
            <p>
              No letter date is set, so these are dated today. Set one above to date them
              otherwise.
            </p>
          </div>
        )}

        {truncatedAt !== null && (
          <div className="flex items-start gap-2 border-t border-orbit-line bg-orbit-amber-soft px-6 py-3 text-sm text-orbit-ink print:hidden">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orbit-amber" />
            <p>
              <span className="font-semibold">
                These are the {truncatedAt} most recent approved SIWES applicants, not all of
                them.
              </span>{' '}
              One run gathers at most {truncatedAt} letters and more have been approved than
              that. Print these, then raise it — at this many, a proper export beats a print
              dialog.
            </p>
          </div>
        )}

        {/* Named before printing, not discovered after posting. */}
        {incomplete.length > 0 && (
          <div className="flex items-start gap-2 border-t border-orbit-amber/30 bg-orbit-amber-soft px-6 py-3 text-sm text-orbit-ink print:hidden">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orbit-amber" />
            <div>
              <p className="font-semibold">
                {incomplete.length === 1
                  ? '1 letter is missing details from its application'
                  : `${incomplete.length} letters are missing details from their applications`}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-orbit-graphite">
                {incomplete.slice(0, 8).map((item, index) => (
                  <li key={`${item.candidate.fullName}-${index}`}>
                    <span className="font-medium">{item.candidate.fullName || 'Unnamed'}</span> — no{' '}
                    {item.letter.missing.join(', ')}
                  </li>
                ))}
                {incomplete.length > 8 && <li>and {incomplete.length - 8} more.</li>}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="bg-orbit-canvas py-8 print:bg-white print:py-0">
        {letters.map(({ candidate, letter }, index) => (
          <article
            key={`${candidate.fullName}-${index}`}
            className="orbit-letter-page mx-auto mb-8 flex min-h-[297mm] max-w-[210mm] flex-col bg-white px-[20mm] pb-[12mm] pt-[14mm] font-letter text-[12pt] leading-[1.5] text-black shadow-orbit-sm print:mx-0 print:mb-0 print:min-h-[271mm] print:max-w-none print:p-0 print:shadow-none"
          >
            {/* The letterhead, from the same document the wording came from —
                the logo sits in that file's header and the contact strip in its
                footer, so a letter printed from ORBIT carries the same masthead
                as one typed by hand. */}
            <img
              src={iihLogo}
              alt="Ilorin Innovation Hub"
              className="mb-6 h-[24.7mm] w-auto self-start"
            />

            <p className="mb-6 text-right">{letter.dateLine}</p>

            <div className="mb-6">
              {letter.recipientLines.map((line, lineIndex) => (
                // The addressee's title is bold in the sample; the unit and the
                // university under it are not.
                <p key={line} className={lineIndex === 0 ? 'font-semibold' : undefined}>
                  {line}
                </p>
              ))}
            </div>

            <p className="mb-6 font-semibold uppercase">{letter.subject}</p>

            <p className="mb-4">{letter.salutation}</p>

            {letter.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex} className="mb-3.5">
                {emphasise(paragraph, [candidate.fullName, ORG_NAME])}
              </p>
            ))}

            {/* The gap under the close is where the letter gets signed by hand.
                The source document carries no signature image — the name below
                is typed and the ink goes on after printing — so this space is
                load bearing, not decoration. */}
            <p className="mb-12 mt-6">{LETTER_CLOSING}</p>

            <div className="font-semibold">
              <p>{letter.signatory.name || ' '}</p>
              <p>{letter.signatory.title}</p>
              <p>{letter.signatory.organisation}</p>
            </div>

            {/* Pushed to the foot of the page, where the source document's own
                footer puts it. `mt-auto` in the flex column keeps it there
                whether the body runs long or short. */}
            <img
              src={iihContact}
              alt="Ilorin Innovation Hub — address, email and website"
              className="mt-auto h-[24.6mm] w-auto self-start"
            />
          </article>
        ))}
      </div>
    </div>,
    document.body,
  );
}
