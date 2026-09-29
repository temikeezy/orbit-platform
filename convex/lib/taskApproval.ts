import { QueryCtx, MutationCtx } from '../_generated/server';

/**
 * The supervisor approval window for agent-proposed tasks.
 *
 * Shared because three places need the same number and must not disagree about
 * it: the cron that publishes overdue proposals, the notification that tells a
 * supervisor when that will happen, and the screen where they act on it. A
 * supervisor told "you have 48 hours" by an email while a cron works to 24 is
 * worse than not being told.
 *
 * In lib/ rather than in tasks.ts for the reason recorded in lib/sheets.ts: the
 * generated `api` type sits at TypeScript's inference limit and only tolerates
 * thin function modules.
 */

/** Used when the setting is unset, malformed, or negative. */
export const DEFAULT_APPROVAL_WINDOW_HOURS = 48;

export const APPROVAL_WINDOW_SETTING = 'task_approval_window_hours';

/**
 * The stored value, read as hours.
 *
 * Pure and exported so it can be tested directly — the async wrapper below only
 * fetches the row.
 *
 * THE ROW IS AN OBJECT, NOT A NUMBER. `seedTaskApprovalWindow` writes
 * `{ enabled: true, value: 48 }`, the same `{ enabled, value }` shape
 * `max_streams_per_intern` uses, because that is what the settings screen can
 * render. This function read only a bare number or numeric string, so the
 * object fell through to `NaN` and every deployment silently used the 48-hour
 * default no matter what was stored. Setting the window to 24 through
 * `adminSettings.set` therefore SUCCEEDED and changed nothing: the row said 24,
 * the cron kept publishing at 48, and nothing anywhere reported a
 * disagreement.
 *
 * `enabled: false` FALLS BACK TO THE DEFAULT, and deliberately not to 0. Zero
 * means "never auto-publish", which parks every agent draft behind a human who
 * may not come — the failure this file already warns about, a safety valve
 * welding itself shut with nothing to show for it. Switching an override off
 * means "no deliberate override", so the default governs. Someone who wants
 * auto-publish genuinely disabled writes the 0, which is a decision that reads
 * as one.
 */
export function readWindowHours(raw: unknown): number {
  const scalar =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { enabled?: unknown }).enabled === false
        ? undefined
        : (raw as { value?: unknown }).value
      : raw;

  /**
   * Only a number or a non-empty numeric string counts.
   *
   * `Number(null)` and `Number('')` are both 0, which is finite and >= 0 — so a
   * setting that was blanked or nulled would have read as "auto-publish is
   * switched off" rather than as "unset". That is the safety valve silently
   * disabling itself, which is the one failure this setting must not have.
   */
  const value =
    typeof scalar === 'number'
      ? scalar
      : typeof scalar === 'string' && scalar.trim() !== ''
        ? Number(scalar)
        : Number.NaN;

  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_APPROVAL_WINDOW_HOURS;
}

/**
 * Hours a proposal waits before publishing itself. `0` disables auto-publish.
 *
 * A setting rather than a constant so a cohort that wants every task signed off
 * by a human can have that, and a cohort running lean can shorten it, without a
 * deploy.
 */
export async function approvalWindowHours(ctx: QueryCtx | MutationCtx): Promise<number> {
  const row = await ctx.db
    .query('adminSettings')
    .withIndex('by_key', (q) => q.eq('settingKey', APPROVAL_WINDOW_SETTING))
    .unique();

  return readWindowHours(row?.settingValue);
}

/**
 * A task the stream can see.
 *
 * ABSENT STATUS MEANS APPROVED: every task created before the agent existed was
 * published by the human who wrote it, so backfilling them all with a status
 * would be writing down a decision nobody made.
 *
 * Lives here, not in tasks.ts, because four surfaces have to agree on it — the
 * task list, the single-task gate, the file-attachment path and the deadline
 * reminder cron. It was private to tasks.ts, which is exactly why the reminder
 * cron emailed unapproved proposals to every member of a stream.
 */
export function isPublished(task: { approvalStatus?: string }): boolean {
  return (task.approvalStatus ?? 'approved') === 'approved';
}

/** A proposal that will never publish: withdrawn, or its deadline passed unreviewed. */
export const EXPIRED = 'expired';

/** When a proposal created at `createdAt` publishes itself, or null if never. */
export function autoPublishAt(createdAt: number, hours: number): number | null {
  return hours > 0 ? createdAt + hours * 60 * 60 * 1000 : null;
}
