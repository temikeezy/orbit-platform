import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from './_generated/server';
import { v } from 'convex/values';
import { SIGN_IN_LINK_PLACEHOLDER, holdingEmail, acknowledgementEmail } from './lib/conversion';
import { watISODate } from './lib/datetime';
import { Doc, Id } from './_generated/dataModel';
import { MutationCtx } from './_generated/server';
import { requireUser, hasRole, requireAdmin, userFromToken, randomToken } from './lib/auth';
import { internal } from './_generated/api';
import { checkRateLimit, LIMITS } from './lib/rateLimit';
import { canTransition, isTerminal, refusalReason, STATUSES } from './lib/applicationStatus';
import { resolvePlacement, hasPlacement } from './lib/placement';
import { defined } from './lib/patch';
import { startMembership } from './lib/membership';

/**
 * Applications converted per transaction.
 *
 * Each conversion inserts a user, patches the application, queues an email and
 * may write a stream membership, so the batch has to leave room under the
 * 4,096-read ceiling. A full page reschedules, so a large intake drains across
 * transactions instead of failing as one.
 */
const CONVERSION_BATCH = 50;
import { approvalEmail, slugCandidate } from './lib/conversion';
import { ensureInternProfile } from './lib/internProfile';
import {
  SHEET_HEADERS,
  applicationToRow,
  deliver,
  readStatuses,
  retryDelayMs,
  sheetConfigured,
  MAX_MIRROR_ATTEMPTS,
  MAX_SHEET_APPROVALS_PER_SYNC,
} from './lib/sheets';

/**
 * Admissions review.
 *
 * The intake side — `netlify/functions/orbit-application.mts` — is a separate
 * job (it becomes an httpAction with Convex file storage). This is the half
 * nobody could do at all: applications were written by that function and there
 * was no way to read or act on them short of opening the Supabase dashboard.
 *
 * Applicants are not ORBIT users, so an application row is the only record of
 * someone's phone number, institution and passport photo. Everything here is
 * staff-gated, and the list view deliberately does not carry the free-text or
 * document fields — a reviewer browsing a queue does not need every applicant's
 * personal statement in the payload.
 */

/**
 * The admissions vocabulary lives in lib/applicationStatus.ts, so the state
 * machine and the list of valid values cannot drift apart.
 *
 * It previously said `accepted`/`withdrawn` here while the client said
 * `approved`/`converted`, and nothing translated — so every Approve was
 * rejected by this validator and an admin could not advance an application at
 * all. One source now.
 */

/**
 * The path to a document, served by the authenticated `/applications/document`
 * route. NOT a storage URL — see the note in `getById`.
 */
function documentDescriptor(a: Doc<'applications'>, kind: 'passport' | 'letter') {
  const id = kind === 'passport' ? a.passportPhotoId : a.siwesLetterId;
  const legacy = kind === 'passport' ? a.passportPhotoUrl : a.siwesLetterUrl;

  return id
    ? { available: true as const, path: `/applications/document?applicationId=${a._id}&kind=${kind}` }
    : { available: Boolean(legacy), legacyUrl: legacy ?? null };
}

/**
 * The list row.
 *
 * It used to carry only name, email, institution, course, mode and interests —
 * while the admissions table renders phone, matric number, SIWES dates,
 * institution supervisor, portfolio link, the passport photo and the SIWES
 * letter. Every one of those columns was blank for every row, which is
 * indistinguishable from an applicant not supplying them.
 *
 * This is the queue an admissions decision is made from, so it carries what the
 * queue shows. The fields still NOT here are the long-form ones only the detail
 * view renders (motivation, skills summary, notes, emergency contacts) — those
 * stay behind `getById`.
 */
function summaryShape(a: Doc<'applications'>) {
  return {
    id: a._id,
    referenceCode: a.referenceCode,
    programmeType: a.programmeType,
    status: a.status,
    fullName: a.fullName,
    email: a.email,
    phone: a.phone,
    // Carried so a single letter can be printed straight from the row the queue
    // already holds, without a second read for one word.
    gender: a.gender,
    location: a.location,
    institutionName: a.institutionName,
    faculty: a.faculty,
    courseOfStudy: a.courseOfStudy,
    matricNumber: a.matricNumber,
    levelOrYear: a.levelOrYear,
    siwesStartDate: a.siwesStartDate,
    siwesEndDate: a.siwesEndDate,
    institutionSupervisorName: a.institutionSupervisorName,
    portfolioUrl: a.portfolioUrl,
    preferredParticipationMode: a.preferredParticipationMode,
    availablePhysicalDay: a.availablePhysicalDay,
    trackInterests: a.trackInterests,
    // The decision, so the queue can show what review settled rather than only
    // what intake guessed.
    assignedParticipationMode: a.assignedParticipationMode ?? null,
    assignedPhysicalDay: a.assignedPhysicalDay ?? null,
    assignedStreamId: a.assignedStreamId ?? null,
    assignedSupervisorId: a.assignedSupervisorId ?? null,
    modeOverrideReason: a.modeOverrideReason ?? null,
    passportPhoto: documentDescriptor(a, 'passport'),
    siwesLetter: documentDescriptor(a, 'letter'),
    siwesLetterFileName: a.siwesLetterFileName,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    reviewedAt: a.reviewedAt,
  };
}

export const list = query({
  args: {
    token: v.string(),
    status: v.optional(v.string()),
    search: v.optional(v.string()),
    /**
     * Narrows to one programme: 'siwes' | 'internship' | 'nysc' | 'volunteer'.
     *
     * The SIWES screen passes 'siwes'; the general Applications screen passes
     * nothing and sees all four. Applied on the SERVER, so the scoped screen
     * cannot render a row it filtered out client-side.
     *
     * It is a SCOPE, not a permission: a caller may simply omit it and receive
     * every programme. That is deliberate — the same roles already reach the
     * general Applications queue, so there is nothing here to withhold from
     * them; the argument exists to give each screen the right subject, not to
     * keep a secret.
     */
    programmeType: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, status, search, programmeType, limit }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin', 'moderator')) {
      throw new Error('Moderator access required');
    }

    // by_time when unfiltered, so an intake table that grows every year does not
    // become a full scan on every dashboard load.
    const cap = Math.min(Math.max(limit ?? 100, 1), 500);

    /**
     * A WINDOW over the newest rows, not the whole table.
     *
     * `cap * 4` is 2,000 at the maximum limit, which is already half the 4,096
     * document read budget a Convex function gets — raising either number is
     * the trap, not the fix. Search therefore matches within this window: it is
     * exhaustive at any intake ORBIT has run (212 today) and would stop being so
     * somewhere past two thousand applications in a single status.
     *
     * The warning below is the honest signal, matching how `streams.list` and
     * `tasks.listForUser` report their own ceilings. If it ever fires in earnest
     * the answer is a Convex search index on fullName/email, not a bigger take.
     */
    const window = cap * 4;

    const rows = status
      ? await ctx.db
          .query('applications')
          .withIndex('by_status_and_time', (q) => q.eq('status', status))
          .order('desc')
          .take(window)
      : await ctx.db.query('applications').withIndex('by_time').order('desc').take(window);

    const needle = search?.trim().toLowerCase();

    if (needle && rows.length === window) {
      console.warn(
        `applications.list searched only the newest ${window} rows; ` +
          'an older match would not be found. Add a search index if this persists.',
      );
    }

    return rows
      .filter((a) => (programmeType ? a.programmeType === programmeType : true))
      .filter((a) =>
        !needle ||
        a.fullName.toLowerCase().includes(needle) ||
        a.email.toLowerCase().includes(needle) ||
        a.referenceCode.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, cap)
      .map(summaryShape);
  },
});

/** One application in full, including documents. Staff only. */
export const getById = query({
  args: { token: v.string(), applicationId: v.id('applications') },
  handler: async (ctx, { token, applicationId }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin', 'moderator')) {
      throw new Error('Moderator access required');
    }

    const a = await ctx.db.get(applicationId);
    if (!a) return null;

    const reviewer = a.reviewedBy ? await ctx.db.get(a.reviewedBy) : null;

    // NO ctx.storage.getUrl() here.
    //
    // That returns a capability URL: no auth, no expiry, not revocable short of
    // deleting the file. An applicant's passport photo handed out that way is
    // fetchable forever by anyone who ends up with the string — a browser
    // history, a forwarded link, a proxy log — for a person who is not an ORBIT
    // user and can neither see nor revoke anything. Supabase issued SIGNED urls
    // that expired, so returning a permanent one would have been a real
    // regression in exposure for the most sensitive data in the system.
    //
    // The client fetches `/applications/document` instead (see http.ts), which
    // checks the session on every request and audits the access.
    // Pre-migration rows hold a Supabase bucket URL instead. Left as-is: those
    // objects live in a bucket this deployment does not control, and the link
    // is already out there.
    const passportPhoto = documentDescriptor(a, 'passport');
    const siwesLetter = documentDescriptor(a, 'letter');

    return {
      ...summaryShape(a),
      phone: a.phone,
      location: a.location,
      faculty: a.faculty,
      matricNumber: a.matricNumber,
      levelOrYear: a.levelOrYear,
      siwesStartDate: a.siwesStartDate,
      siwesEndDate: a.siwesEndDate,
      institutionSupervisorName: a.institutionSupervisorName,
      institutionSupervisorEmail: a.institutionSupervisorEmail,
      institutionSupervisorPhone: a.institutionSupervisorPhone,
      availablePhysicalDay: a.availablePhysicalDay,
      skillsSummary: a.skillsSummary,
      motivation: a.motivation,
      portfolioUrl: a.portfolioUrl,
      emergencyContactName: a.emergencyContactName,
      emergencyContactPhone: a.emergencyContactPhone,
      consentLogbook: a.consentLogbook,
      consentDataUse: a.consentDataUse,
      notes: a.notes,
      passportPhoto,
      siwesLetter,
      siwesLetterFileName: a.siwesLetterFileName,
      reviewer: reviewer ? { id: reviewer._id, fullName: reviewer.fullName } : null,
    };
  },
});

/**
 * Moves an application through the pipeline.
 *
 * Admin only, not moderator: a moderator may READ the queue (they help triage),
 * but accepting someone is an admissions decision. `notes` are staff-internal
 * and never shown to the applicant — there is no applicant-facing surface at
 * all, which is worth keeping true.
 */

/**
 * Re-queues an application's mirror row so the next flush pushes its new status.
 *
 * Without this the sync is only half two-way. A row is delivered once and then
 * left alone, so approving in ORBIT would leave the sheet saying `submitted`
 * indefinitely — and the next person to read the sheet would either draw the
 * wrong conclusion or "fix" it and believe they had made the decision.
 *
 * Re-sending is safe by construction: the script matches on reference code,
 * updates the Status cell of the row already there, and appends nothing.
 */
async function requeueMirror(ctx: MutationCtx, applicationId: Id<'applications'>) {
  const row = await ctx.db
    .query('applicationMirror')
    .withIndex('by_application', (q) => q.eq('applicationId', applicationId))
    .first();

  if (!row) return;
  await ctx.db.patch(row._id, { status: 'pending', attempts: 0, nextAttemptAt: undefined });
}

/**
 * The placement decision, recorded without deciding the application.
 *
 * Separate from `updateStatus` so a half-finished assignment can never approve
 * anyone, and so a placement can be revised as many times as review needs.
 * Refuses once the application is terminal: the approval email has already told
 * the applicant their mode and start date, and silently editing the record
 * afterwards makes that email a lie with no correction path. After approval the
 * account exists and `siwes.assignProfile` is the right surface.
 */
export const assignPlacement = mutation({
  args: {
    token: v.string(),
    applicationId: v.id('applications'),
    participationMode: v.optional(v.string()),
    physicalDay: v.optional(v.number()),
    cohortId: v.optional(v.id('cohorts')),
    streamId: v.optional(v.id('streams')),
    supervisorId: v.optional(v.id('users')),
    departmentId: v.optional(v.id('departments')),
    modeOverrideReason: v.optional(v.string()),
  },
  handler: async (ctx, { token, applicationId, ...input }) => {
    const admin = await requireAdmin(ctx, token);

    const application = await ctx.db.get(applicationId);
    if (!application) return { success: false as const, error: 'Application not found' };

    if (isTerminal(application.status)) {
      return {
        success: false as const,
        error: 'This application is already approved. Change the placement on their account.',
      };
    }

    const resolved = await resolvePlacement(ctx, application, input);
    if (!resolved.ok) return { success: false as const, error: resolved.error };

    const now = Date.now();
    await ctx.db.patch(applicationId, {
      ...resolved.patch,
      assignedBy: admin._id,
      assignedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.application_assigned',
      tableName: 'applications',
      recordId: applicationId,
      oldValues: {
        participationMode: application.assignedParticipationMode ?? null,
        streamId: application.assignedStreamId ?? null,
        supervisorId: application.assignedSupervisorId ?? null,
      },
      newValues: { ...resolved.patch, referenceCode: application.referenceCode },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

export const updateStatus = mutation({
  args: {
    token: v.string(),
    applicationId: v.id('applications'),
    status: v.string(),
    notes: v.optional(v.string()),
    participationMode: v.optional(v.string()),
    physicalDay: v.optional(v.number()),
    cohortId: v.optional(v.id('cohorts')),
    streamId: v.optional(v.id('streams')),
    supervisorId: v.optional(v.id('users')),
    departmentId: v.optional(v.id('departments')),
    modeOverrideReason: v.optional(v.string()),
  },
  handler: async (ctx, { token, applicationId, status, notes, ...placement }) => {
    const admin = await requireAdmin(ctx, token);

    if (!(STATUSES as readonly string[]).includes(status)) {
      return { success: false as const, error: `Status must be one of: ${STATUSES.join(', ')}` };
    }

    const application = await ctx.db.get(applicationId);
    if (!application) return { success: false as const, error: 'Application not found' };

    // Approved and converted are one-way — see lib/applicationStatus.ts. The
    // check lives on the SERVER because the sheet can write back now, and a rule
    // enforced only in the admin screen is no rule at all.
    if (!canTransition(application.status, status)) {
      return { success: false as const, error: refusalReason(application.status, status) };
    }

    // A no-op re-submit of the same status must not rewrite who reviewed it and
    // when — that quietly reassigns an admissions decision to whoever last
    // opened the record.
    const changed = application.status !== status;

    const now = Date.now();
    const patch: Record<string, unknown> = { status, updatedAt: now };
    if (changed) {
      patch.reviewedBy = admin._id;
      patch.reviewedAt = now;
    }
    if (notes !== undefined) patch.notes = notes;

    /**
     * A placement sent with the decision lands in the SAME transaction.
     *
     * Assigning and then approving as two calls is two transactions, and the
     * approval schedules the conversion that reads the placement — so the
     * email can go out describing a placement that had not been written yet.
     * One transaction removes the ordering question entirely.
     */
    if (hasPlacement(placement)) {
      const resolved = await resolvePlacement(ctx, application, placement);
      if (!resolved.ok) return { success: false as const, error: resolved.error };
      Object.assign(patch, resolved.patch, { assignedBy: admin._id, assignedAt: now });
    }

    await ctx.db.patch(applicationId, patch);
    if (changed) {
      await requeueMirror(ctx, applicationId);
      await ctx.scheduler.runAfter(0, internal.applications.flushMirror, {});
      if (status === 'approved') {
        await ctx.scheduler.runAfter(0, internal.applications.convertApprovedApplications, {});
      }
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.application_reviewed',
      tableName: 'applications',
      recordId: applicationId,
      oldValues: { status: application.status },
      newValues: { status, referenceCode: application.referenceCode },
      success: true,
      createdAt: now,
    });

    return { success: true as const, previousStatus: application.status, changed };
  },
});

/** Counts per status, for the admissions dashboard. */
export const counts = query({
  args: { token: v.string(), programmeType: v.optional(v.string()) },
  handler: async (ctx, { token, programmeType }) => {
    const viewer = await requireUser(ctx, token);
    if (!hasRole(viewer, 'admin', 'super_admin', 'moderator')) {
      throw new Error('Moderator access required');
    }

    // BOUNDED. Six .collect()s over six disjoint partitions is a full table read
    // with extra steps — worse than one scan, not better, which is what the
    // previous version's comment got backwards. On a table nothing deletes from,
    // that eventually exceeds the per-transaction read limit and the dashboard
    // stops working rather than degrading.
    const CEILING = 2000;

    const rows = await ctx.db.query('applications').withIndex('by_time').order('desc').take(CEILING);

    // Scoped like the list beside it: the SIWES screen must not badge its tabs
    // with the whole platform's numbers.
    const scoped = programmeType ? rows.filter((a) => a.programmeType === programmeType) : rows;

    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const a of scoped) counts[a.status] = (counts[a.status] ?? 0) + 1;

    // Reported rather than hidden: a silently truncated count is a wrong number
    // presented as a right one.
    return { total: scoped.length, byStatus: counts, capped: rows.length === CEILING };
  },
});

/**
 * Backs the `/applications/document` httpAction.
 *
 * Internal: it returns a storage id, which is a capability. The route above it
 * checks the session and the caller's role before ever calling this.
 */
export const documentFor = internalQuery({
  args: { token: v.string(), applicationId: v.id('applications'), kind: v.string() },
  handler: async (ctx, { token, applicationId, kind }) => {
    const viewer = await userFromToken(ctx, token);
    if (!viewer || !hasRole(viewer, 'admin', 'super_admin', 'moderator')) return null;

    const application = await ctx.db.get(applicationId);
    if (!application) return null;

    const storageId =
      kind === 'passport' ? application.passportPhotoId
      : kind === 'letter' ? application.siwesLetterId
      : null;

    if (!storageId) return null;

    return {
      storageId,
      viewerId: viewer._id,
      viewerEmail: viewer.email,
      referenceCode: application.referenceCode,
      fileName:
        kind === 'letter'
          ? (application.siwesLetterFileName ?? `${application.referenceCode}-siwes-letter`)
          : `${application.referenceCode}-passport`,
    };
  },
});

/** Records that a reviewer opened an applicant's document. */
export const recordDocumentAccess = internalMutation({
  args: {
    viewerId: v.id('users'),
    viewerEmail: v.string(),
    applicationId: v.id('applications'),
    kind: v.string(),
  },
  handler: async (ctx, { viewerId, viewerEmail, applicationId, kind }) => {
    await ctx.db.insert('auditLogs', {
      userId: viewerId,
      userEmail: viewerEmail,
      action: 'admissions.document_viewed',
      tableName: 'applications',
      recordId: applicationId,
      newValues: { kind },
      success: true,
      createdAt: Date.now(),
    });
  },
});

/**
 * Writes an application from the public intake. Internal.
 *
 * The httpAction does the decoding and stores the files; this does the row and
 * nothing else, so the two failure modes stay separable — a rejected payload
 * never reaches the database, and a database failure never leaves the applicant
 * thinking the upload was the problem.
 */
/**
 * The throttle, checked before the request is allowed to cost anything.
 *
 * Separate from `submitFromIntake` because that runs after both files are
 * stored: a refused flood should cost a counter increment, not two storage
 * writes undone by a cleanup handler.
 *
 * The address comes from the HTTP action's resolved last proxy hop, never from
 * the request body — a caller-supplied address is not a limit, it is a field.
 */
export const checkIntakeAllowed = internalMutation({
  args: { ipAddress: v.optional(v.string()) },
  returns: v.object({ allowed: v.boolean(), error: v.string() }),
  handler: async (ctx, { ipAddress }) => {
    const busy = {
      allowed: false,
      error: 'We are receiving a lot of applications right now. Please try again shortly.',
    };

    /**
     * PER ADDRESS first, so one source cannot spend the global budget.
     *
     * With only a global ceiling, 300 requests from one script refuse every
     * genuine applicant for the rest of the hour — the failure mode is not
     * abuse of the form, it is everyone else locked out of it.
     */
    if (ipAddress && ipAddress !== 'unknown') {
      // Bare address, NOT `ip:${ipAddress}`. checkRateLimit looks the bucket key
      // up against `blockedIps`, and admin.setIpBlock stores exactly what an
      // operator types — a bare address, which is also what every other
      // IP-keyed limiter passes. Prefixed, no block an admin could enter ever
      // matched here, so the one unauthenticated endpoint that writes storage
      // was the one endpoint an IP block did not cover. Buckets stay separate
      // regardless: rateLimits is keyed by (address, endpoint).
      const perIp = await checkRateLimit(
        ctx, ipAddress, 'application_intake_ip',
        LIMITS.applicationIntakePerIp.max, LIMITS.applicationIntakePerIp.windowMs,
      );
      if (!perIp.allowed) return busy;
    }

    const global = await checkRateLimit(
      ctx, 'global', 'application_intake',
      LIMITS.applicationIntake.max, LIMITS.applicationIntake.windowMs,
    );
    if (!global.allowed) return busy;

    return { allowed: true, error: '' };
  },
});

export const submitFromIntake = internalMutation({
  args: {
    row: v.any(),
    passportPhotoId: v.id('_storage'),
    siwesLetterId: v.optional(v.id('_storage')),
  },
  // No ipAddress argument. The route cannot obtain a trustworthy one — it is
  // proxied through Netlify, so no fixed position in x-forwarded-for is the
  // client — and an untrusted value is worse than none: it looks like a limit.
  // The limits here are a global ceiling and a per-address cap instead.
  handler: async (ctx, { row, passportPhotoId, siwesLetterId }) => {
    const now = Date.now();

    // TWO LIMITS, neither keyed on anything the caller picks.
    //
    // The first attempt keyed on `x-forwarded-for`'s first entry, which is
    // written by the client: sending `X-Forwarded-For: unknown` landed on
    // checkRateLimit's unkeyable free-pass branch and removed the limit
    // entirely, and a random first entry per request worked as well. With
    // Netlify rewriting to Convex the proxy chain has two hops, so no fixed
    // index into that header is trustworthy either.
    //
    // So: a GLOBAL ceiling, which no header can move, plus a per-address one.
    // A global limit is a denial-of-service surface — someone can burn the
    // hour's quota — but a bounded outage on a form that takes tens of
    // applications per intake is a better failure than unbounded anonymous
    // writes of 8 MB each.
    // The global and per-address ceilings are checked in `checkIntakeAllowed`,
    // before anything is stored. Repeating them here would double-count every
    // submission against both.

    // Canonical form for limiting and duplicate detection only — the row keeps
    // what they typed. `victim+1@`, `victim+2@` … are one inbox, so a guard that
    // compares raw addresses is not a guard at all.
    const canonical = canonicalEmail(String(row.email));

    const perAddress = await checkRateLimit(
      ctx, `email:${canonical}`, 'application_intake_email',
      LIMITS.applicationIntakePerEmail.max, LIMITS.applicationIntakePerEmail.windowMs,
    );
    if (!perAddress.allowed) {
      return {
        success: false as const,
        error: 'An application from this address was received recently. Please check your email.',
      };
    }

    // Whether this address was mailed recently. Decides the EMAIL, not the row.
    //
    // The first version discarded the whole submission and returned the earlier
    // application's reference code as a success. That was badly wrong: anyone
    // could submit garbage under a victim's address, and when the victim then
    // applied for real their application was silently dropped and they were
    // handed a stranger's reference code — with admissions reviewing the
    // attacker's row under their name. It also disclosed an existing applicant's
    // reference code to anyone who guessed their email.
    //
    // Deduplicating the notification is enough. Every submission is recorded.
    const MAIL_ONCE_WINDOW_MS = 24 * 60 * 60 * 1000;

    // Matched on the CANONICAL address. Looking up the raw one meant the guard
    // and the mail server disagreed about what "the same inbox" is.
    const priorFromEmail = await ctx.db
      .query('applications')
      .withIndex('by_canonicalEmail', (q) => q.eq('canonicalEmail', canonical))
      .collect();

    const mailedRecently = priorFromEmail.some((a) => a.createdAt > now - MAIL_ONCE_WINDOW_MS);

    // A reference code is what the applicant is told to quote, and it is the
    // by_reference lookup key. `randomUUID().slice(0, 8)` is 32 bits, so
    // collisions are unlikely rather than impossible — and Convex has no unique
    // constraint to catch one. Retried rather than trusted.
    let referenceCode = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `ORB-${new Date(now).getUTCFullYear()}-${randomToken().slice(0, 8).toUpperCase()}`;
      const clash = await ctx.db
        .query('applications')
        .withIndex('by_reference', (q) => q.eq('referenceCode', candidate))
        .first();
      if (!clash) { referenceCode = candidate; break; }
    }
    if (!referenceCode) {
      return { success: false as const, error: 'Could not allocate a reference code. Please try again.' };
    }

    const id = await ctx.db.insert('applications', {
      ...row,
      canonicalEmail: canonical,
      referenceCode,
      passportPhotoId,
      siwesLetterId,
      createdAt: now,
      updatedAt: now,
    });

    // Confirmation to the applicant.
    //
    // This is the one place ORBIT emails an address supplied in an
    // unauthenticated request, which is the shape of an open relay. Three things
    // make it safe rather than merely bounded:
    //
    //  - the address is read back from the ROW just written, never from the
    //    request body, so what is mailed is what was recorded;
    //  - the body is a fixed template — the only caller-controlled text is the
    //    applicant's own name, escaped;
    //  - the duplicate guard above means one address cannot be mailed twice in
    //    24 hours no matter how many times the form is submitted.
    //
    // Combined with the per-IP rate limit, the worst available abuse is one
    // innocuous ORBIT-branded receipt per address per day.
    const applicantName = String(row.fullName ?? 'there');

    /**
     * THE ACKNOWLEDGEMENT IS BACK ON, and the reason it was off has inverted.
     *
     * It was switched off because the intake had been open so long that events
     * overtook it — the oldest unsent acknowledgement on production was eight
     * days old, telling the applicant nothing they did not know and reading as
     * a system catching up. The acceptance email was doing the job instead.
     *
     * Both halves of that have changed. The queue is no longer held, so a
     * receipt now leaves within minutes rather than days. And admissions are no
     * longer swept in bulk — every application from here is reviewed and
     * approved one at a time by a named admin, so there IS a real wait between
     * submitting and hearing back. An applicant who sends documents into
     * silence has no way to tell "received, under review" from "lost", and the
     * form's own copy promises this message.
     *
     * The per-address throttle above still governs it, so re-enabling this does
     * not reopen the duplicate-receipt hole.
     */
    const ack = acknowledgementEmail(applicantName, referenceCode, row.programmeType);

    if (!mailedRecently) {
      await ctx.db.insert('emailQueue', {
        emailType: 'application_acknowledgement',
        recipientEmail: row.email,
        subject: ack.subject,
        bodyHtml: ack.bodyHtml,
        bodyText: ack.bodyText,
        status: 'pending',
        retryCount: 0,
        isDummy: false,
        createdAt: Date.now(),
      });
    }

    // Admins are notified on a SEPARATE transaction, scheduled rather than
    // inline. Finding them means scanning `users` — there is no index for "has
    // the admin role" — and doing that on an unauthenticated request made the
    // endpoint a read amplifier that grows with membership, and made the most
    // likely thing to throw the thing holding two freshly stored files.
    await ctx.scheduler.runAfter(0, internal.applications.notifyAdminsOfApplication, {
      applicationId: id,
    });

    /**
     * Queued for the Google Sheet, then flushed on its own transaction.
     *
     * The queue row is written here, inside the transaction that creates the
     * application, so the two cannot disagree: if the application exists, it is
     * queued. The SEND happens elsewhere, because an applicant pressing Submit
     * must not be able to see a Google outage — and because a mutation cannot
     * make a network call at all.
     */
    await ctx.db.insert('applicationMirror', {
      applicationId: id,
      referenceCode,
      status: 'pending',
      attempts: 0,
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.applications.flushMirror, {});

    return { success: true as const, id, referenceCode, mailed: !mailedRecently };
  },
});

/** Admin fan-out for a new application. Scheduled, so it is off the request path. */
export const notifyAdminsOfApplication = internalMutation({
  args: { applicationId: v.id('applications') },
  handler: async (ctx, { applicationId }) => {
    const application = await ctx.db.get(applicationId);
    if (!application) return { notified: 0 };

    const users = await ctx.db.query('users').collect();
    const now = Date.now();
    let notified = 0;

    for (const admin of users) {
      if (!admin.isActive || admin.isDeleted) continue;
      if (!admin.roles.some((r) => ['admin', 'super_admin'].includes(r))) continue;

      await ctx.db.insert('notifications', {
        userId: admin._id,
        type: 'application_received',
        title: 'New application',
        content:
          `${application.fullName} applied for ${application.programmeType} ` +
          `(${application.referenceCode}).`,
        actionUrl: '/admin/applications',
        isRead: false,
        isDummy: false,
        createdAt: now,
      });
      notified++;
    }

    return { notified };
  },
});

/**
 * Canonical address, for rate limiting and duplicate detection only.
 *
 * Strips a `+tag` and lowercases. The stored address is always what the
 * applicant typed — this exists so `victim+1@`, `victim+2@` … cannot be used to
 * mail one inbox repeatedly through a guard that compares raw strings.
 */
function canonicalEmail(address: string): string {
  const [local = '', domain = ''] = address.trim().toLowerCase().split('@');
  const base = local.split('+')[0];

  /**
   * Gmail ignores dots in the local part, so `v.ictim@` and `victim@` are ONE
   * inbox with two rate-limit budgets — enough of them and a single address can
   * be mailed up to the global hourly ceiling through a guard that thinks it is
   * comparing different people. Stripping `+tags` alone did not cover it.
   */
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${base.replace(/\./g, '')}@gmail.com`;
  }

  return `${base}@${domain}`;
}

// ------------------------------------------------------- google sheet mirror

/**
 * Work the sweeper should attempt: never-sent rows whose backoff has elapsed.
 *
 * DELIBERATELY THIN, like the two below it. The Convex-generated `api` type is
 * built by inferring every function's signature, and this project sits at
 * TypeScript's limit for that — four functions with substantial handlers tipped
 * it over, and TS responded by silently widening query results to `any` at
 * eighteen call sites across seven unrelated files, with no error naming the
 * cause. The logic lives in lib/sheets.ts, which costs the generated type
 * nothing.
 */
export const mirrorBatch = internalMutation({
  args: { claimId: v.string() },
  returns: v.array(
    v.object({
      mirrorId: v.id('applicationMirror'),
      referenceCode: v.string(),
      attempts: v.number(),
      row: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { claimId }) => {
    const now = Date.now();
    const out = [];

    /**
     * A CLAIM, not just a read. Rows held by a live run are skipped; a claim
     * older than the lease is treated as abandoned, because a run that died
     * mid-flush must not strand its rows forever.
     */
    const MIRROR_LEASE_MS = 5 * 60 * 1000;

    for (const status of ['pending', 'failed']) {
      const rows = await ctx.db
        .query('applicationMirror')
        .withIndex('by_status_and_next', (q) => q.eq('status', status))
        .take(50);

      for (const m of rows) {
        if (m.nextAttemptAt !== undefined && m.nextAttemptAt > now) continue;
        if (m.claimedAt && now - m.claimedAt < MIRROR_LEASE_MS) continue;

        const application = await ctx.db.get(m.applicationId);
        if (!application) continue;

        await ctx.db.patch(m._id, { claimId, claimedAt: now });
        out.push({
          mirrorId: m._id,
          referenceCode: m.referenceCode,
          attempts: m.attempts,
          row: applicationToRow(application),
        });
      }
    }

    return out;
  },
});

/** Records the outcome of one flush. */
export const recordMirrorResults = internalMutation({
  args: {
    sent: v.array(v.id('applicationMirror')),
    duplicates: v.array(v.id('applicationMirror')),
    failed: v.array(
      v.object({ mirrorId: v.id('applicationMirror'), error: v.string(), attempts: v.number() }),
    ),
    claimId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { sent, duplicates, failed, claimId }) => {
    const now = Date.now();

    /**
     * Only the run that claimed a row may report on it.
     *
     * Without this, a slow flush that lost its lease could overwrite the result
     * of the run that took over — most damagingly by regressing a successfully
     * mirrored row back to `failed`, which then retries a row already in the
     * sheet.
     */
    const owned = async (id: Id<'applicationMirror'>) => {
      const row = await ctx.db.get(id);
      return row && row.claimId === claimId ? row : null;
    };

    for (const id of sent) {
      if (!(await owned(id))) continue;
      await ctx.db.patch(id, {
        status: 'sent', sentAt: now, lastAttemptAt: now, lastError: undefined,
        claimId: undefined, claimedAt: undefined,
      });
    }

    // A duplicate is a SUCCESS, not a failure: the row is in the sheet, which is
    // the only thing this cares about. Retrying it forever would be the natural
    // consequence of treating "already there" as an error.
    for (const id of duplicates) {
      if (!(await owned(id))) continue;
      await ctx.db.patch(id, {
        status: 'duplicate', sentAt: now, lastAttemptAt: now,
        claimId: undefined, claimedAt: undefined,
      });
    }

    for (const f of failed) {
      if (!(await owned(f.mirrorId))) continue;
      const attempts = f.attempts + 1;
      const exhausted = attempts >= MAX_MIRROR_ATTEMPTS;
      await ctx.db.patch(f.mirrorId, {
        // Abandoned rather than retried forever against a misconfigured
        // endpoint. The row stays in the log saying why, and a backfill can
        // pick it up once the endpoint is fixed.
        status: exhausted ? 'abandoned' : 'failed',
        attempts,
        lastError: f.error.slice(0, 300),
        lastAttemptAt: now,
        nextAttemptAt: exhausted ? undefined : now + retryDelayMs(attempts),
        claimId: undefined,
        claimedAt: undefined,
      });
    }

    return null;
  },
});

/**
 * Sends everything outstanding. Scheduled on submit, and by cron for retries.
 *
 * One action serves both paths: "send the new one" and "retry the failures" are
 * the same operation over the same queue, and having two would mean two things
 * to keep in step.
 */
export const flushMirror = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    attempted: v.number(),
    detail: v.optional(v.string()),
  }),
  handler: async (ctx): Promise<{ ok: boolean; attempted: number; detail?: string }> => {
    if (!sheetConfigured()) return { ok: true, attempted: 0, detail: 'not configured' };

    // Claiming, not just reading — see mirrorBatch. The id identifies this run
    // so a slow flush cannot report on rows another run has taken over.
    const claimId = crypto.randomUUID();
    /**
     * Annotated because this action reads a mutation in its OWN module, so the
     * inferred type routes back through the generated api type that contains
     * both — TypeScript reports that cycle as implicit `any` on the callbacks
     * below rather than as anything to do with this line. Matches mirrorBatch's
     * own `returns` validator.
     */
    const batch: {
      mirrorId: Id<'applicationMirror'>;
      referenceCode: string;
      attempts: number;
      row: string[];
    }[] = await ctx.runMutation(internal.applications.mirrorBatch, { claimId });
    if (batch.length === 0) return { ok: true, attempted: 0 };

    const result = await deliver(batch.map((b) => b.row));

    if (!result.ok) {
      console.error('Sheet mirror flush failed:', result.detail);
      await ctx.runMutation(internal.applications.recordMirrorResults, {
        claimId,
        sent: [],
        duplicates: [],
        failed: batch.map((b) => ({
          mirrorId: b.mirrorId,
          error: result.detail ?? 'unknown',
          attempts: b.attempts,
        })),
      });
      return { ok: false, attempted: batch.length, detail: result.detail };
    }

    const dupes = new Set(result.duplicates ?? []);
    await ctx.runMutation(internal.applications.recordMirrorResults, {
      claimId,
      sent: batch.filter((b) => !dupes.has(b.referenceCode)).map((b) => b.mirrorId),
      duplicates: batch.filter((b) => dupes.has(b.referenceCode)).map((b) => b.mirrorId),
      failed: [],
    });

    return { ok: true, attempted: batch.length };
  },
});

/**
 * Queues anything the sheet is missing: applications with no mirror row, and
 * rows previously ABANDONED after exhausting their retries.
 *
 * For a sheet created after applications already existed, one that was rebuilt,
 * or one whose endpoint was misconfigured long enough for the retries to give
 * up. Without the abandoned case there would be no way back from a bad
 * deployment — the rows would sit in the log forever, correctly describing a
 * failure nothing would ever retry.
 *
 * Idempotent: an application already queued or already sent is left alone, so
 * running it twice does not double-send. That matters, because running it again
 * is the natural response to a sheet that looks incomplete.
 */
export const backfillMirror = internalMutation({
  args: { after: v.optional(v.number()) },
  returns: v.object({
    queued: v.number(),
    requeued: v.number(),
    alreadyQueued: v.number(),
    nextCursor: v.optional(v.number()),
  }),
  handler: async (ctx, { after }) => {
    /**
     * Cursored, because this is the RECOVERY path.
     *
     * It collected every application ever received and did a mirror lookup and
     * write for each, in one transaction — so it was most likely to exceed the
     * limit exactly when it was needed: after a long outage, or against a
     * rebuilt sheet. A recovery tool that fails at scale is not one.
     */
    const BACKFILL_PAGE = 200;

    const applications = await ctx.db
      .query('applications')
      .withIndex('by_time', (q) => (after === undefined ? q : q.gt('createdAt', after)))
      .take(BACKFILL_PAGE);

    const now = Date.now();
    let queued = 0;
    let requeued = 0;
    let alreadyQueued = 0;

    for (const a of applications) {
      const existing = await ctx.db
        .query('applicationMirror')
        .withIndex('by_application', (q) => q.eq('applicationId', a._id))
        .first();

      if (existing) {
        if (existing.status === 'abandoned') {
          await ctx.db.patch(existing._id, {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: undefined,
            lastError: undefined,
          });
          requeued++;
        } else {
          alreadyQueued++;
        }
        continue;
      }

      await ctx.db.insert('applicationMirror', {
        applicationId: a._id,
        referenceCode: a.referenceCode,
        status: 'pending',
        attempts: 0,
        createdAt: now,
      });
      queued++;
    }

    return {
      queued,
      requeued,
      alreadyQueued,
      // Absent when the walk is finished, which is the signal to stop.
      nextCursor:
        applications.length === BACKFILL_PAGE
          ? applications[applications.length - 1].createdAt
          : undefined,
    };
  },
});

/**
 * Moves several applications at once.
 *
 * Admissions is done in passes — an admin reads twenty applications and rejects
 * fifteen. Doing that through a per-row dropdown is twenty round trips and
 * twenty chances to hit the wrong row, which is how the wrong person gets
 * rejected.
 *
 * PARTIAL SUCCESS IS THE POINT. A selection will often contain something already
 * approved, and refusing the whole batch because one row is terminal would make
 * the feature useless exactly when it is most wanted. Each application is judged
 * on its own and the caller is told, by reference code, which were skipped and
 * why.
 */
export const updateStatusBulk = mutation({
  args: {
    token: v.string(),
    applicationIds: v.array(v.id('applications')),
    status: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    updated: v.number(),
    skipped: v.array(v.object({ referenceCode: v.string(), reason: v.string() })),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { token, applicationIds, status }) => {
    const admin = await requireAdmin(ctx, token);

    if (!(STATUSES as readonly string[]).includes(status)) {
      return {
        success: false as const,
        updated: 0,
        skipped: [],
        error: `Status must be one of: ${STATUSES.join(', ')}`,
      };
    }

    // Bounded: a runaway selection should fail loudly rather than walk the whole
    // table inside one transaction.
    if (applicationIds.length > 200) {
      return {
        success: false as const,
        updated: 0,
        skipped: [],
        error: 'Select 200 applications or fewer at a time.',
      };
    }

    const now = Date.now();
    const skipped: { referenceCode: string; reason: string }[] = [];
    let updated = 0;

    for (const id of applicationIds) {
      const application = await ctx.db.get(id);
      if (!application) continue;

      if (!canTransition(application.status, status)) {
        skipped.push({
          referenceCode: application.referenceCode,
          reason: refusalReason(application.status, status),
        });
        continue;
      }

      if (application.status === status) continue;

      await ctx.db.patch(id, { status, reviewedBy: admin._id, reviewedAt: now, updatedAt: now });
      await requeueMirror(ctx, id);
      updated++;

      await ctx.db.insert('auditLogs', {
        userId: admin._id,
        userEmail: admin.email,
        userRoles: admin.roles,
        action: 'admin.application_reviewed',
        tableName: 'applications',
        recordId: id,
        oldValues: { status: application.status },
        newValues: { status, referenceCode: application.referenceCode, viaBulk: true },
        success: true,
        createdAt: now,
      });
    }

    if (updated > 0) {
      await ctx.scheduler.runAfter(0, internal.applications.flushMirror, {});
      if (status === 'approved') {
        await ctx.scheduler.runAfter(0, internal.applications.convertApprovedApplications, {});
      }
    }

    return { success: true as const, updated, skipped };
  },
});

/**
 * Applies approvals made in the Google Sheet.
 *
 * The sheet is a mirror in one direction and a control surface in the other:
 * changing a Status cell to `approved` approves that applicant in ORBIT. It is
 * one-way by construction — the only transition that exists is
 * submitted -> approved — so a sheet edit can never un-approve anyone, revive a
 * decision, or alter applicant data. The worst a bad edit can do is approve
 * someone early, which is why the batch cap below exists.
 *
 * ORBIT REMAINS THE AUTHORITY. Anything the sheet says that is not a legal
 * transition is ignored rather than reconciled, and the sheet is corrected on
 * the next push instead. Attribution degrades honestly: the audit row records
 * `via: sheet` because a spreadsheet cannot tell us which person typed.
 */
/**
 * DISABLED. An approval cannot come from a spreadsheet.
 *
 * This used to read the sheet's Status column and approve any application it
 * marked "approved", on a five-minute cron. Its own audit note admitted the
 * flaw: "A spreadsheet cannot identify which person made the edit, so no userId
 * is recorded."
 *
 * An approval is a decision communicated to a person. It creates their ORBIT
 * account and — now the global email hold is off — sends an acceptance carrying
 * a sign-in link within minutes. A stray paste, an autofill drag, or anyone
 * with edit access to the sheet could admit somebody with no admin in ORBIT
 * having decided anything, and nobody nameable as having decided it. That was
 * tolerable while the ORBIT 2.0 intake was approved in bulk behind a global
 * pause. From here admissions are one at a time, by a named admin, in ORBIT.
 *
 * Kept as a refusing stub rather than deleted, for two reasons: the refusal is
 * then visible at the exact place the behaviour used to live, and `syncFromSheet`
 * still has a mutation to call, so a leftover schedule degrades to a no-op
 * instead of erroring on a path nobody intends to use.
 *
 * The ORBIT -> sheet mirror (`flushMirror`) is untouched. The sheet still shows
 * the current state of every application; it is a report now, not a control.
 */
export const applySheetStatuses = internalMutation({
  args: {
    statuses: v.array(v.object({ reference: v.string(), status: v.string() })),
  },
  returns: v.object({
    approved: v.number(),
    ignored: v.number(),
    refusedTooMany: v.boolean(),
  }),
  handler: async (_ctx, { statuses }) => {
    if (statuses.length > 0) {
      console.warn(
        `Sheet status sync is disabled: applications are approved in ORBIT by a named admin, `
        + `never from the spreadsheet. Ignored ${statuses.length} row(s).`,
      );
    }
    return { approved: 0, ignored: statuses.length, refusedTooMany: false };
  },
});

export const syncFromSheet = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    approved: v.number(),
    detail: v.optional(v.string()),
  }),
  handler: async (ctx): Promise<{ ok: boolean; approved: number; detail?: string }> => {
    if (!sheetConfigured()) return { ok: true, approved: 0, detail: 'not configured' };

    const read = await readStatuses();
    if (!read.ok) {
      console.error('Sheet status read failed:', read.detail);
      return { ok: false, approved: 0, detail: read.detail };
    }

    const result = await ctx.runMutation(internal.applications.applySheetStatuses, {
      statuses: read.rows,
    });

    return {
      ok: !result.refusedTooMany,
      approved: result.approved,
      detail: result.refusedTooMany
        ? `Refused: more than ${MAX_SHEET_APPROVALS_PER_SYNC} approvals in one pass. Check the sheet.`
        : undefined,
    };
  },
});

// ------------------------------------------------ approval -> ORBIT account

/** A slug nothing else holds. Suffixes only on collision, so names stay clean. */
async function uniqueSlug(ctx: MutationCtx, fullName: string, email: string): Promise<string> {
  const base = slugCandidate(fullName, email);

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await ctx.db
      .query('users')
      .withIndex('by_slug', (q) => q.eq('profileSlug', candidate))
      .unique();
    if (!taken) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Creates ORBIT accounts for approved applications that do not have one.
 *
 * A SWEEP, not a step inside approval. Applications are approved from three
 * places — the row button, the bulk action, and an edit to the Google Sheet —
 * and the sheet path has no acting user at all. One sweep means one
 * implementation rather than three that have to agree, and it is idempotent:
 * `convertedUserId` is the key, so running it twice converts nothing twice.
 *
 * It also means a failure is recoverable. If the cohort is missing or the email
 * queue is unavailable, the application stays approved and unconverted and the
 * next pass picks it up, instead of the approval half-happening.
 */
export const convertApprovedApplications = internalMutation({
  args: {},
  returns: v.object({
    converted: v.number(),
    linkedExisting: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx) => {
    /**
     * BOUNDED, and index-backed.
     *
     * This used to `collect()` the entire applications table on every run. Ten
     * applications made that invisible; a public intake makes it the reason no
     * approved applicant ever gets an account, because the transaction exceeds
     * its read limit and every conversion in it rolls back together.
     */
    const pending = await ctx.db
      .query('applications')
      .withIndex('by_status_and_converted', (q) =>
        q.eq('status', 'approved').eq('convertedUserId', undefined),
      )
      .take(CONVERSION_BATCH);

    if (pending.length === 0) return { converted: 0, linkedExisting: 0, skipped: 0 };

    // Cohort selection lives in ensureInternProfile, so an applicant and an
    // admin-created member cannot end up in different cohorts by different
    // rules.
    const now = Date.now();
    let converted = 0;
    let linkedExisting = 0;
    let skipped = 0;

    for (const application of pending) {
      const email = application.email.trim().toLowerCase();

      // Someone may already have an account — staff applying, or a returning
      // applicant. Linking beats creating a second account on the same address,
      // which the unique index would refuse anyway.
      const existing = await ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', email))
        .unique();

      let userId = existing?._id;

      if (!userId) {
        userId = await ctx.db.insert('users', {
          email,
          fullName: application.fullName,
          profileSlug: await uniqueSlug(ctx, application.fullName, email),
          roles: ['intern'],
          // NO passwordHash and NO tempPassword. They sign in with a magic link
          // they request themselves; a password mailed out lives in an inbox
          // for as long as the inbox does.
          isActive: true,
          isDeleted: false,
          isDummy: false,
          totalPoints: 0,
          currentLevel: 1,
          loginStreakCount: 0,
          mcpEnabled: false,
          profileVisibility: 'public',
          showEmail: false,
          showActivityOnFeed: true,
          showOnLeaderboard: true,
          createdAt: now,
          updatedAt: now,
        });
        converted++;
      } else {
        linkedExisting++;
      }

      /**
       * The cohort REVIEW assigned, not merely the newest active one.
       *
       * `assignPlacement` writes `assignedCohortId` (lib/placement.ts) and,
       * until now, nothing ever read it back — so `resolveCohort`'s fallback
       * decided every enrolment and quietly overruled the admin. With two
       * cohorts active, an applicant deliberately placed in the earlier one was
       * enrolled into the later one instead: wrong cadence, wrong compliance
       * report, the approval email naming the wrong cohort, and the next cohort
       * repeating work this one had already done — which is the reason the
       * grouping exists at all. The record showed an assignment that had never
       * been honoured.
       *
       * Passed as `preResolved`, so the cohort's own participation-mode and
       * physical-day defaults are the assigned cohort's too, not another's.
       */
      const assignedCohort = application.assignedCohortId
        ? await ctx.db.get(application.assignedCohortId)
        : null;

      // The same helper every other account-creation path uses, so an applicant
      // and an admin-created member end up with identical setup. Seeded with
      // what the applicant already told us.
      const internUserId = await ensureInternProfile(ctx, userId!, {
        // What review decided, falling back to what intake derived.
        participationMode:
          application.assignedParticipationMode ?? application.preferredParticipationMode,
        // Carried onto the account. Without it the platform forgets, the moment
        // someone becomes an intern, which programme they are actually on.
        programmeType: application.programmeType,
        institutionName: application.institutionName,
        faculty: application.faculty,
        courseOfStudy: application.courseOfStudy,
        matricNumber: application.matricNumber,
        siwesStartDate: application.siwesStartDate,
        siwesEndDate: application.siwesEndDate,
        institutionSupervisorName: application.institutionSupervisorName,
        institutionSupervisorEmail: application.institutionSupervisorEmail,
        institutionSupervisorPhone: application.institutionSupervisorPhone,
        physicalDay: application.assignedPhysicalDay ?? application.availablePhysicalDay,
      }, assignedCohort ?? undefined);

      /**
       * ENROLMENT FAILED — do NOT mark this converted.
       *
       * It used to stamp `convertedUserId` anyway and send the approval email,
       * which meant the recovery this function's own docstring promises could
       * never happen: the next sweep selects on the absence of that field, so
       * the application was permanently stuck with an account and no cohort,
       * and its owner had been told to sign in and start a logbook they had no
       * enrolment for.
       *
       * Leaving it unstamped is safe and idempotent — the account already
       * exists, so the next pass finds it by email and takes the linking branch.
       */
      if (!internUserId) {
        await ctx.db.patch(application._id, {
          conversionNote:
            'No cohort to enrol into. The account exists; this retries every 15 minutes.',
          updatedAt: now,
        });
        skipped++;
        continue;
      }

      /**
       * What review decided, applied to the account.
       *
       * `ensureInternProfile` returns early once a cohort is set, so it is not
       * the place for these — and it owns none of them anyway. Without this
       * step an approved applicant lands with no supervisor and no department,
       * which means `canReviewProfile` matches nobody and their logbook has no
       * reviewer at all.
       */
      await ctx.db.patch(userId!, {
        ...defined({
          iihSupervisorId: application.assignedSupervisorId,
          departmentId: application.assignedDepartmentId,
          /**
           * ALSO PATCHED HERE, not only seeded through `ensureInternProfile`.
           *
           * That helper returns early once an account already has a cohort, so
           * for anyone already enrolled — a returning applicant, or a staff
           * member who applies — the seed never runs and the programme on the
           * application never reaches the account. They would keep whatever
           * they had before, or nothing, and be treated accordingly for the
           * whole placement. The application is the authority on which
           * programme this conversion is for.
           */
          programmeType: application.programmeType,
          /**
           * Patched here for the same reason `programmeType` is.
           *
           * `ensureInternProfile` returns early once an account already has a
           * cohort, so a returning applicant or a staff member who applies
           * would keep their OLD cohort and the assignment would be ignored
           * exactly as it was before. The application is the authority on which
           * cohort this conversion is for.
           */
          cohortId: application.assignedCohortId,
        }),
        updatedAt: now,
      });

      if (application.assignedStreamId) {
        const stream = await ctx.db.get(application.assignedStreamId);
        if (stream?.isActive) {
          /**
           * NO LONGER ends other memberships.
           *
           * Conversion used to clear every other stream before placing the
           * applicant. For a duplicate applicant that was destructive: their
           * second application converted with no stream assigned, deactivated
           * the membership the first had created, and left them in none. Four
           * interns were found in exactly that state.
           *
           * Placing someone is now additive, and interns may hold several
           * streams anyway — see MAX_SELF_JOINED_STREAMS in streams.ts.
           */
          await startMembership(ctx, stream._id, userId!, application.reviewedBy ?? userId!, now);
          await ctx.db.patch(userId!, { currentStreamId: stream._id, updatedAt: now });
        }
      }

      await ctx.db.patch(application._id, {
        convertedUserId: userId!,
        convertedAt: now,
        updatedAt: now,
      });

      // The decision, to the applicant. The confirmation they already received
      // promises this email; until now nothing sent it.
      // Read back rather than resolved again: ensureInternProfile has just
      // decided which cohort this account belongs to, and the email must name
      // that one.
      const enrolled = await ctx.db.get(userId!);
      const cohort = enrolled?.cohortId ? await ctx.db.get(enrolled.cohortId) : null;
      const stream = application.assignedStreamId
        ? await ctx.db.get(application.assignedStreamId)
        : null;
      const supervisor = application.assignedSupervisorId
        ? await ctx.db.get(application.assignedSupervisorId)
        : null;

      /**
       * A PLACEHOLDER, not a live link. The real one is minted at SEND time.
       *
       * Minting here looked right and was wrong: a magic link lives 24 hours
       * from creation, and a queued email may sit far longer than that — mail is
       * currently paused outright, and the oldest thing in the queue is over a
       * week old. Every acceptance would then have arrived carrying a credential
       * that expired before it was ever delivered, which is worse than sending
       * no link at all: the applicant clicks, is refused, and has to request the
       * second email this design exists to avoid.
       *
       * emailQueue.drain substitutes a freshly minted link for this token
       * immediately before handing the message to SMTP, so the 24 hours starts
       * when it is actually sent.
       */
      const signInLink = userId ? SIGN_IN_LINK_PLACEHOLDER : undefined;

      const mail = approvalEmail(application.fullName, application.referenceCode, {
        signInLink,
        // The COHORT's start date wins. For a cohort with one fixed start,
        // "the start date on your application" is wrong for nearly everyone.
        startDate: cohort?.startDate ?? application.siwesStartDate,
        // So a start date already gone reads as "begins immediately".
        today: watISODate(now),
        cohortName: cohort?.name,
        participationMode:
          application.assignedParticipationMode ?? application.preferredParticipationMode,
        streamName: stream?.name ?? undefined,
        supervisorName: supervisor?.fullName ?? undefined,
        // Decides whether this email mentions a logbook at all.
        programmeType: application.programmeType,
      });
      /**
       * ONE ACCEPTANCE PER INBOX, EVER.
       *
       * Nine people in the first intake submitted twice, and each of them had
       * two acceptance emails queued to the same address. Conversion was right
       * to link the second application to the account the first had created;
       * the mistake was telling the person twice.
       *
       * Guarded HERE — at the message — and deliberately NOT at intake. Refusing
       * a second SUBMISSION was tried once and reverted, because it let anyone
       * apply under a stranger's address and have that stranger's genuine
       * application silently dropped (see the note in `submitFromIntake`). Every
       * submission is still recorded. Only the second acceptance is suppressed.
       */
      const alreadyTold = await ctx.db
        .query('emailQueue')
        .withIndex('by_recipient', (q) => q.eq('recipientEmail', email))
        .filter((q) => q.eq(q.field('emailType'), 'application_approved'))
        .first();

      if (alreadyTold) {
        skipped++;
        continue;
      }

      await ctx.db.insert('emailQueue', {
        userId: userId!,
        emailType: 'application_approved',
        // So the drain can rebuild this applicant's acceptance letter at send
        // time and attach it. SIWES only — letterInputs returns null otherwise.
        referenceType: 'application',
        referenceId: application._id,
        recipientEmail: email,
        subject: mail.subject,
        bodyHtml: mail.bodyHtml,
        bodyText: mail.bodyText,
        status: 'pending',
        retryCount: 0,
        isDummy: false,
        createdAt: now,
      });
    }

    return { converted, linkedExisting, skipped };
  },
});

/**
 * Stages a stream and cohort on every submitted application that has neither.
 *
 * Placement is optional at approval, and an applicant approved without a stream
 * becomes an intern with no team, no tasks and no feed — the quiet failure this
 * file's conversion path documents. At 246 applications, doing it by hand is
 * 246 trips through a modal, so in practice it does not get done.
 *
 * It is NOT a decision about who gets in. Approval remains untouched and
 * irreversible-by-hand; this only fills in the placement an applicant already
 * asked for. Every application carries `trackInterests`, an applicant-ordered
 * list of up to three track slugs, and the first entry is a genuine first
 * choice — verified against the live data, where all 21 possible track pairs
 * appear in both orders, which a fixed checkbox order could not produce.
 *
 * Within a track, the least-loaded active stream wins. That is deterministic,
 * resumable and self-levelling: counting the load that already exists means a
 * second run continues the distribution rather than restarting it, so this can
 * be run repeatedly and after new applications arrive.
 *
 * Idempotent by construction — it only ever looks at applications with no
 * `assignedStreamId`, and re-running assigns nothing to anyone already placed.
 * `dryRun` reports exactly what it would do and writes nothing.
 */
export const stageFirstChoicePlacements = internalMutation({
  args: { dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, { dryRun, limit }) => {
    const BATCH = Math.min(limit ?? 300, 300);

    const cohorts = await ctx.db.query('cohorts').withIndex('by_status', (q) => q.eq('status', 'active')).collect();
    const cohort = cohorts.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
    if (!cohort) return { ok: false as const, error: 'No active cohort to enrol into.' };

    const tracks = await ctx.db.query('tracks').collect();
    const trackBySlug = new Map(tracks.filter((t) => t.isActive).map((t) => [t.slug, t._id]));

    const streams = (await ctx.db.query('streams').collect()).filter((s) => s.isActive && s.trackId);
    const byTrack = new Map<string, typeof streams>();
    for (const s of streams) {
      const k = String(s.trackId);
      if (!byTrack.has(k)) byTrack.set(k, []);
      byTrack.get(k)!.push(s);
    }
    for (const list of byTrack.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    const all = await ctx.db.query('applications').collect();

    // Load that already exists, so a re-run continues rather than restarts.
    const load = new Map<string, number>();
    for (const s of streams) load.set(String(s._id), 0);
    for (const a of all) {
      if (a.assignedStreamId) {
        const k = String(a.assignedStreamId);
        load.set(k, (load.get(k) ?? 0) + 1);
      }
    }

    const todo = all.filter((a) => a.status === 'submitted' && !a.assignedStreamId).slice(0, BATCH);

    let placed = 0;
    let noInterest = 0;
    let unmappable = 0;
    const now = Date.now();

    for (const app of todo) {
      const first = (app.trackInterests ?? [])[0];
      if (!first) { noInterest++; continue; }

      const trackId = trackBySlug.get(first);
      const pool = trackId ? byTrack.get(String(trackId)) : undefined;
      if (!pool || !pool.length) { unmappable++; continue; }

      // Least loaded, name-stable on ties.
      const pick = pool.reduce((best, s) =>
        (load.get(String(s._id)) ?? 0) < (load.get(String(best._id)) ?? 0) ? s : best,
      );

      if (!dryRun) {
        await ctx.db.patch(app._id, {
          assignedStreamId: pick._id,
          assignedCohortId: cohort._id,
          updatedAt: now,
        });
      }
      load.set(String(pick._id), (load.get(String(pick._id)) ?? 0) + 1);
      placed++;
    }

    const distribution = streams
      .map((s) => ({ stream: s.name, total: load.get(String(s._id)) ?? 0 }))
      .sort((a, b) => b.total - a.total);

    return {
      ok: true as const,
      dryRun: Boolean(dryRun),
      cohort: cohort.name,
      considered: todo.length,
      placed,
      skippedNoInterest: noInterest,
      skippedUnmappableTrack: unmappable,
      remaining: all.filter((a) => a.status === 'submitted' && !a.assignedStreamId).length - placed,
      distribution,
    };
  },
});

/**
 * Queues the holding note for every applicant who has not had one.
 *
 * Separate from the send so it can be inspected before anything leaves: this
 * writes ordinary queue rows, which `emailQueue.qaPending` then checks like any
 * other message. Deduped on emailType per application, so re-running tops up
 * rather than sending twice — the failure mode that matters most when the
 * audience is 246 real people.
 */
export const queueHoldingEmails = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const applications = await ctx.db.query('applications').collect();

    /**
     * Deduped on the application id via `by_reference`, which exists, rather
     * than on emailType, which has no index. Bounded because this table grows
     * without limit and one send must not depend on scanning all of it.
     */
    const sentAlready = new Set<string>();
    for (const application of applications) {
      const prior = await ctx.db
        .query('emailQueue')
        .withIndex('by_reference', (q) => q.eq('referenceId', application._id))
        .collect();
      if (prior.some((r) => r.emailType === 'application_holding')) {
        sentAlready.add(String(application._id));
      }
    }

    const now = Date.now();
    let queued = 0;
    let alreadyHad = 0;

    for (const application of applications) {
      if (sentAlready.has(String(application._id))) { alreadyHad++; continue; }
      if (!application.email) continue;

      if (!dryRun) {
        const mail = holdingEmail(application.fullName, application.referenceCode);
        await ctx.db.insert('emailQueue', {
          emailType: 'application_holding',
          recipientEmail: application.email,
          subject: mail.subject,
          bodyHtml: mail.bodyHtml,
          bodyText: mail.bodyText,
          referenceType: 'application',
          referenceId: application._id,
          status: 'pending',
          retryCount: 0,
          isDummy: false,
          createdAt: now,
        });
      }
      queued++;
    }

    return { dryRun: Boolean(dryRun), queued, alreadyHad, applications: applications.length };
  },
});

/**
 * Removes redundant application rows where one person applied more than once.
 *
 * Nine people in the ORBIT 2.0 intake submitted twice. Conversion handled it
 * correctly — the second submission linked to the account the first had already
 * created, rather than making a second one — so the duplication was never a
 * data-integrity problem. It was an ADMISSIONS problem: two rows in the queue
 * for one person, and two acceptance emails queued to one inbox.
 *
 * KEEPS THE EARLIEST and deletes the rest, and only ever within one canonical
 * address. `canonicalEmail` is the same normalisation the intake guard uses, so
 * `victim+1@` and `victim+2@` are correctly seen as one inbox.
 *
 * REFUSES to delete a row that is the only one holding a conversion. If the
 * later submission is the one that carries `convertedUserId` and the earlier
 * does not, deleting the later would orphan the link between the person and
 * their account, so that pair is reported and left alone for a human.
 */
export const deleteDuplicateApplications = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    groups: v.number(),
    deleted: v.number(),
    kept: v.array(v.string()),
    refused: v.array(v.string()),
  }),
  handler: async (ctx, { dryRun }) => {
    const all = await ctx.db.query('applications').collect();

    const byAddress = new Map<string, typeof all>();
    for (const a of all) {
      const key = a.canonicalEmail ?? canonicalEmail(a.email);
      const bucket = byAddress.get(key);
      if (bucket) bucket.push(a);
      else byAddress.set(key, [a]);
    }

    let deleted = 0;
    const kept: string[] = [];
    const refused: string[] = [];
    let groups = 0;

    for (const [, rows] of byAddress) {
      if (rows.length < 2) continue;
      groups++;

      const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt);
      const keep = ordered[0];
      const drop = ordered.slice(1);

      // Never orphan a conversion: if a row being dropped is the only one that
      // records which account this person became, leave the whole group.
      const keepHasLink = Boolean(keep.convertedUserId);
      const dropHoldsOnlyLink = drop.some((d) => d.convertedUserId && !keepHasLink);
      if (dropHoldsOnlyLink) {
        refused.push(keep.email);
        continue;
      }

      kept.push(keep.referenceCode);
      for (const d of drop) {
        if (!dryRun) await ctx.db.delete(d._id);
        deleted++;
      }
    }

    return { groups, deleted, kept, refused };
  },
});

/**
 * Removes a single application by its reference code.
 *
 * There was no way to delete one at all — not a test submission, not spam, not
 * a duplicate somebody asked to have withdrawn. The intake is public and
 * unauthenticated, so the admissions queue accumulates whatever is sent to it,
 * and every one of those rows is something an admin has to read past.
 *
 * REFUSES an application that already converted. Deleting a row that produced
 * an ORBIT account would sever the only record connecting that person to the
 * decision that admitted them, which is exactly the trail an admissions process
 * has to keep. Withdraw the account first if that is really the intent.
 *
 * Internal, so it needs deployment credentials rather than an admin session,
 * and it audits what it removed.
 */
export const deleteApplicationByReference = internalMutation({
  args: { referenceCode: v.string(), reason: v.string() },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
    cancelledEmails: v.optional(v.number()),
  }),
  handler: async (ctx, { referenceCode, reason }) => {
    const row = await ctx.db
      .query('applications')
      .withIndex('by_reference', (q) => q.eq('referenceCode', referenceCode))
      .unique();

    if (!row) return { success: false as const, error: 'No application with that reference' };
    if (row.convertedUserId) {
      return {
        success: false as const,
        error: 'This application produced an ORBIT account. Deleting it would break the '
          + 'record of how that person was admitted.',
      };
    }

    // Anything queued to this applicant is about an application that will not
    // exist. Cancelled rather than left, so it cannot be sent by a later drain.
    let cancelledEmails = 0;
    for (const mail of await ctx.db
      .query('emailQueue')
      .withIndex('by_recipient', (q) => q.eq('recipientEmail', row.email))
      .collect()) {
      if (mail.status !== 'pending') continue;
      await ctx.db.patch(mail._id, {
        status: 'cancelled',
        cancelledAt: Date.now(),
        errorMessage: `Application ${referenceCode} deleted: ${reason}`,
      });
      cancelledEmails++;
    }

    await ctx.db.insert('auditLogs', {
      userEmail: 'system',
      userRoles: [],
      action: 'admin.application_deleted',
      tableName: 'applications',
      recordId: row._id,
      oldValues: { referenceCode, email: row.email, status: row.status },
      newValues: { reason },
      success: true,
      createdAt: Date.now(),
    });

    await ctx.db.delete(row._id);
    return { success: true as const, cancelledEmails };
  },
});

/**
 * The admissions export: every application, as the columns the spreadsheet had.
 *
 * REPLACES THE GOOGLE SHEET. The sheet was disconnected in both directions —
 * its readback was an unattributable approval path, and its writeback kept a
 * standing copy of the whole intake's names, phone numbers, institutions and
 * matriculation numbers in a document shared by link and inherited by whoever
 * had access last term. This returns the same information to a named admin who
 * is signed in, generated on demand, and leaves no second copy anywhere.
 *
 * REUSES `SHEET_HEADERS` and `applicationToRow` rather than restating them, so
 * the export cannot drift from the definition that was reviewed — and so the
 * header/row length assertion inside `applicationToRow` still guards it. That
 * assertion exists because a column added to one list and not the other shifts
 * every value after it into the wrong column, silently.
 *
 * NO FILE CONTENT, deliberately, and for the same reason as the sheet: the
 * passport photograph and the SIWES letter stay in ORBIT behind a route that
 * checks the caller's session. A downloaded workbook is forwarded and copied
 * exactly like a shared sheet was, so putting an identity document in one turns
 * "send this to a colleague" into "hand over a passport photo". Each row says
 * whether the document exists and where to view it.
 */
export const exportRows = query({
  args: { token: v.string() },
  returns: v.object({
    headers: v.array(v.string()),
    rows: v.array(v.array(v.string())),
    generatedAt: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    /**
     * Bounded, unlike the sheet flush it replaces.
     *
     * `.collect()` on a table that grows with every public form submission is
     * the unbounded read already fixed twice in this file. 5,000 is far above
     * any real intake — the first was 252 — and a truncated export says so
     * rather than quietly handing back a partial roll.
     */
    const LIMIT = 5000;
    const applications = await ctx.db.query('applications').take(LIMIT + 1);
    const truncated = applications.length > LIMIT;

    return {
      headers: SHEET_HEADERS,
      rows: applications.slice(0, LIMIT).map(applicationToRow),
      generatedAt: Date.now(),
      truncated,
    };
  },
});
