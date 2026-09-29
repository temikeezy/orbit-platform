import { AlertTriangle, PauseCircle, Timer } from 'lucide-react';

/**
 * Queue health, above the log.
 *
 * The counts alone are not the useful part — the log already showed those. What
 * this adds is the difference between the three ways a message can be sitting
 * unsent, which look identical in a status column and need different responses:
 *
 *   - waiting for the next drain          -> nothing to do
 *   - waiting out a retry backoff         -> nothing to do, it is scheduled
 *   - held because dispatch is paused     -> waiting for a HUMAN
 *
 * The last one is why this exists. During the go-live hold, "17 pending" read
 * as a queue about to move when in fact nothing would move until someone
 * released the brake.
 */

export interface QueueHealth {
  counts: { pending: number; processing: number; sent: number; failed: number; cancelled: number };
  retrying: number;
  windowSize: number;
  windowTruncated: boolean;
  oldestPendingAt?: number;
  dbPaused: boolean;
}

function age(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function EmailQueueHealth({ health }: { health: QueueHealth | null }) {
  if (!health) return null;

  const { counts, retrying, dbPaused, oldestPendingAt, windowTruncated, windowSize } = health;
  const waiting = counts.pending - retrying;

  return (
    <div className="mb-6 space-y-3">
      {dbPaused && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <PauseCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="font-medium text-amber-900">Dispatch is paused</p>
            <p className="text-sm text-amber-800">
              {counts.pending === 0
                ? 'Nothing is queued. Releasing the pause would send nothing.'
                : `${counts.pending} message${counts.pending === 1 ? '' : 's'} held. Nothing sends until this is released — they are not failing, and none will be discarded.`}
            </p>
          </div>
        </div>
      )}

      {/*
        The environment brake is invisible to a query — EMAIL_PAUSED is read
        from the deployment's environment by the drain, and a Convex query
        cannot see it. Saying so is better than showing a green queue that is
        actually held.
      */}
      <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <AlertTriangle className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" aria-hidden />
        <p className="text-sm text-slate-600">
          There is a second brake, <code className="font-mono text-xs">EMAIL_PAUSED</code>, set on
          the deployment itself. Either one holds the queue, and this screen cannot see that one —
          if messages stay pending with dispatch running, check it before assuming a fault.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Waiting to send" value={waiting} tone={waiting > 0 ? 'amber' : 'slate'} />
        <Stat
          label="Retrying"
          value={retrying}
          tone={retrying > 0 ? 'amber' : 'slate'}
          hint={retrying > 0 ? 'backing off' : undefined}
          icon={retrying > 0 ? Timer : undefined}
        />
        <Stat label="Sending now" value={counts.processing} tone="slate" />
        <Stat label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'red' : 'slate'} />
        <Stat label="Cancelled" value={counts.cancelled} tone="slate" />
      </div>

      {oldestPendingAt !== undefined && counts.pending > 0 && (
        <p className="text-sm text-slate-500">
          Oldest unsent message queued {age(oldestPendingAt)} ago.
        </p>
      )}

      {windowTruncated && (
        <p className="text-sm text-slate-500">
          Counts cover the most recent {windowSize.toLocaleString()} messages, not all history.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'slate' | 'amber' | 'red';
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneClass =
    tone === 'red'
      ? 'text-red-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : 'text-slate-800';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </p>
      <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
