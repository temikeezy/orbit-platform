import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Clock, User } from 'lucide-react';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';

/**
 * Every delivery attempt made for one queued message.
 *
 * The queue row answers "what is this message doing now"; this answers "what
 * has happened to it", which is the question anyone opens the log to ask. Until
 * `emailAttempts` existed, each failure overwrote the last error, so three
 * failures for three different reasons were indistinguishable from three for
 * one — and "it failed three times" is not something you can act on.
 *
 * Loaded on demand rather than with the list: the list shows a hundred rows and
 * nobody needs the history of ninety-nine of them.
 */

interface Attempt {
  id: string;
  attempt: number;
  outcome: string;
  providerMessageId?: string;
  error?: string;
  durationMs?: number;
  triggeredByName?: string;
  createdAt: number;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function EmailAttemptHistory({ emailId }: { emailId: string }) {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAttempts(null);
    setError(null);

    const token = authService.getToken();
    if (!token) {
      setError('Not authenticated');
      return;
    }

    convex
      .query(api.emailQueue.adminAttempts, { token, emailId: emailId as never })
      .then((rows) => {
        if (!cancelled) setAttempts(rows as Attempt[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load attempts');
      });

    return () => {
      cancelled = true;
    };
  }, [emailId]);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (attempts === null) {
    return <p className="text-sm text-slate-500">Loading delivery history…</p>;
  }

  if (attempts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No delivery attempts yet — this message has not left the queue.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {attempts.map((a) => {
        const sent = a.outcome === 'sent';
        return (
          <li
            key={a.id}
            className={`rounded-lg border p-3 ${
              sent ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {sent ? (
                <CheckCircle className="w-4 h-4 text-green-600 shrink-0" aria-hidden />
              ) : (
                <XCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden />
              )}
              <span className="font-medium text-slate-800">Attempt {a.attempt}</span>
              <span className={sent ? 'text-green-700 text-sm' : 'text-red-700 text-sm'}>
                {sent ? 'delivered' : 'failed'}
              </span>
              <span className="text-slate-400" aria-hidden>
                ·
              </span>
              <span className="text-sm text-slate-600">{when(a.createdAt)}</span>
              {a.durationMs !== undefined && (
                <span className="inline-flex items-center gap-1 text-sm text-slate-500">
                  <Clock className="w-3 h-3" aria-hidden />
                  {(a.durationMs / 1000).toFixed(1)}s
                </span>
              )}
              {/* Absent for cron attempts, which is most of them. */}
              {a.triggeredByName && (
                <span className="inline-flex items-center gap-1 text-sm text-slate-500">
                  <User className="w-3 h-3" aria-hidden />
                  {a.triggeredByName}
                </span>
              )}
            </div>

            {a.error && (
              <p className="mt-2 text-sm text-red-800 font-mono break-words whitespace-pre-wrap">
                {a.error}
              </p>
            )}

            {a.providerMessageId && (
              <p className="mt-2 text-xs text-slate-500 font-mono break-all">
                {/* The handle to quote at the provider when a recipient says
                    nothing arrived. */}
                {a.providerMessageId}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
