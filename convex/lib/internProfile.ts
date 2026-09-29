import { MutationCtx } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { defined } from './patch';

/**
 * Every account IS an intern profile.
 *
 * The two used to be separate records an admin had to join up: an account could
 * exist for weeks while its owner opened the logbook and read "No internship
 * profile yet — contact your programme admin". Nothing about that second record
 * carried information the first did not; it was a row someone had to remember
 * to create, and forgetting it looked to the intern like the platform was
 * broken.
 *
 * So the enrolment fields moved onto `users` and the `internProfiles` table is
 * gone. Daily logs, weekly summaries, attendance records, supervisor notes and
 * logbook exports point at `userId`. "Which of this person's profiles" stopped
 * being a question anything has to answer, and the null case — the one every
 * caller had to handle and several handled by crashing — no longer exists.
 *
 * COHORT, SUPERVISOR AND DEPARTMENT are still assigned by an admin. They are
 * real decisions about a person, not defaults; this only guarantees there is
 * always something to assign them to.
 */

export interface ProfileSeed {
  /** 'siwes' | 'internship' | 'nysc' | 'volunteer' — decides logbook duties. */
  programmeType?: string;
  participationMode?: string;
  institutionName?: string;
  faculty?: string;
  courseOfStudy?: string;
  matricNumber?: string;
  siwesStartDate?: string;
  siwesEndDate?: string;
  institutionSupervisorName?: string;
  institutionSupervisorEmail?: string;
  institutionSupervisorPhone?: string;
  physicalDay?: number;
}

/**
 * Fills in a new account's enrolment. Returns the user id, or null.
 *
 * Idempotent: it runs on every account-creation path and on a backfill, and an
 * account that already has a cohort is left alone — re-running it must never
 * move an intern out of the cohort an admin put them in.
 *
 * Returns null only when there is no cohort at all to attach to. The account is
 * still perfectly usable; the backfill completes it once a cohort exists.
 */
export async function ensureInternProfile(
  ctx: MutationCtx,
  userId: Id<'users'>,
  seed: ProfileSeed = {},
  /**
   * A cohort already resolved by the caller.
   *
   * Without this a bulk caller re-reads every cohort once per user. The
   * backfill over ~760 accounts read 27,127 documents against a 32,000 limit —
   * it succeeded, and would have started failing on a deployment slightly
   * larger than this one.
   */
  preResolved?: { _id: Id<'cohorts'>; defaultParticipationMode: string; defaultPhysicalDay?: number },
): Promise<Id<'users'> | null> {
  const existing = await ctx.db.get(userId);
  if (!existing) return null;
  if (existing.cohortId) return existing._id;

  const cohort = preResolved ?? (await resolveCohort(ctx));
  if (!cohort) return null;

  const now = Date.now();

  /**
   * The seeded half is filtered through `defined()`, the rest is not.
   *
   * Patching a field to `undefined` REMOVES it in Convex, and the backfill
   * (`users.backfillInternProfiles`) calls this with an EMPTY seed — so without
   * the filter, re-running it over an account whose institution and supervisor
   * had been filled in by hand would delete every one of those fields. Note
   * `physicalDay` is exposed too: `cohort.defaultPhysicalDay` is itself
   * optional, so the `??` does not guarantee a value.
   *
   * `cohortId`, `internStatus` and `updatedAt` sit outside it because they are
   * what this function exists to write.
   */
  await ctx.db.patch(userId, {
    ...defined({
      // The cohort's own default, not a hardcoded one: a fully-remote cohort
      // should not hand every new member a physical attendance tab.
      participationMode: seed.participationMode ?? cohort.defaultParticipationMode,
      programmeType: seed.programmeType,
      institutionName: seed.institutionName,
      faculty: seed.faculty,
      courseOfStudy: seed.courseOfStudy,
      matricNumber: seed.matricNumber,
      siwesStartDate: seed.siwesStartDate,
      siwesEndDate: seed.siwesEndDate,
      institutionSupervisorName: seed.institutionSupervisorName,
      institutionSupervisorEmail: seed.institutionSupervisorEmail,
      institutionSupervisorPhone: seed.institutionSupervisorPhone,
      physicalDay: seed.physicalDay ?? cohort.defaultPhysicalDay,
    }),
    cohortId: cohort._id,
    internStatus: 'active',
    updatedAt: now,
  });

  return userId;
}

/**
 * The cohort a new member joins: the active one that started most recently.
 *
 * DETERMINISTIC, which the previous version was not. It took the FIRST active
 * cohort in scan order, so with two active — the state this deployment is in
 * whenever a new intake overlaps a scaffold or a previous cohort — which one an
 * approved applicant landed in depended on document order. Two people approved
 * a minute apart could be enrolled into different cohorts, and nothing would
 * look wrong until their compliance reports disagreed.
 *
 * `startDate` decides it, not `createdAt`: a cohort created later for a term
 * that starts earlier is still the earlier term. Ties fall back to the newest
 * record, and a deployment with no active cohort still produces usable accounts
 * by taking the latest one, rather than refusing to create anyone.
 *
 * `YYYY-MM-DD` sorts correctly as a string; the codebase already relies on that
 * for SIWES date comparison in lib/intake.ts.
 */
export async function resolveCohort(ctx: MutationCtx) {
  const active = await ctx.db
    .query('cohorts')
    .withIndex('by_status', (q) => q.eq('status', 'active'))
    .collect();

  const newest = (rows: typeof active) =>
    rows.sort(
      (a, b) =>
        (b.startDate ?? '').localeCompare(a.startDate ?? '') || b.createdAt - a.createdAt,
    )[0] ?? null;

  if (active.length) return newest(active);

  return newest(await ctx.db.query('cohorts').collect());
}

/**
 * Whether an account belongs to an intern rather than to staff.
 *
 * THE ONE DEFINITION. Every account carries enrolment fields so the logbook
 * works without a setup step, which means "has a profile" stopped being a
 * useful test for who is an intern — the role is. Five surfaces list interns
 * (the roster, the review queue, cohort compliance, the daily reminder cron and
 * the compliance report) and each would otherwise carry its own copy of this
 * rule, which is how they drift apart.
 *
 * Staff arrive through Zoho, which is domain-gated to IIH and creates
 * moderators.
 */
export function isIntern(user: { roles?: string[] } | null | undefined): boolean {
  if (!user) return false;
  const roles = user.roles ?? [];
  return !roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'moderator');
}
