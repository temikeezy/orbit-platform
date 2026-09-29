import { useState } from 'react';
import { Bug, X, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';

/**
 * "Report a bug" — a small persistent affordance, on every page.
 *
 * The platform had no way for a member to say something was broken. Their only
 * route was to tell a supervisor, who would tell an admin, who would have
 * nothing to look up — because caught errors were not being recorded either.
 * This closes both halves: the report lands in the same table as the automatic
 * captures, so an admin reading the list sees what the app noticed and what a
 * person noticed side by side.
 *
 * Available to everyone including signed-out visitors, because the login page
 * is exactly where a stuck person most needs to be able to say so, and the one
 * place they cannot ask anyone inside the app for help.
 *
 * The CURRENT PATH is captured automatically — a report that says "it's broken"
 * with a page attached is worth several that describe the wrong screen.
 */
export function ReportBugButton() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = note.trim();
    if (!text) return;

    setSending(true);
    try {
      await convex.mutation(api.errorReports.report, {
        token: authService.getToken() ?? undefined,
        source: 'reported',
        // The message is what an admin scans; the note is what they read.
        message: text.slice(0, 120),
        note: text,
        url: window.location.href,
        userAgent: navigator.userAgent,
      });
      toast.success('Thank you — that has been logged.');
      setNote('');
      setOpen(false);
    } catch {
      // Deliberately not logError: a failure here would try to record itself.
      toast.error('Could not send that. Please try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 shadow-orbit-sm hover:text-iih-green hover:border-iih-green transition-colors"
        title="Report a problem"
      >
        <Bug className="w-4 h-4" aria-hidden />
        <span className="hidden sm:inline">Report a bug</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-4 shadow-orbit-md">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="font-semibold text-orbit-ink flex items-center gap-2">
            <Bug className="w-4 h-4 text-iih-green" aria-hidden />
            Report a problem
          </p>
          <p className="text-xs text-orbit-muted mt-0.5">
            What were you doing, and what happened instead?
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-slate-400 hover:text-slate-700 p-1"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
        autoFocus
        aria-label="Describe the problem"
        placeholder="I tried to submit my task and the page did nothing…"
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-iih-green focus:border-transparent"
      />

      <p className="text-xs text-orbit-muted mt-2">
        The page you are on is included automatically. Do not paste passwords or
        sign-in links.
      </p>

      <button
        type="button"
        onClick={send}
        disabled={sending || !note.trim()}
        className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-iih-green hover:bg-iih-green-dark disabled:opacity-50 text-white text-sm font-medium py-2"
      >
        <Check className="w-4 h-4" aria-hidden />
        {sending ? 'Sending…' : 'Send report'}
      </button>
    </div>
  );
}
