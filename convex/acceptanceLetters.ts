import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { hasRole, requireAdmin, requireModerator } from './lib/auth';
import {
  ACCEPTANCE_LETTER_SETTING,
  AcceptanceLetterConfig,
  DEFAULT_LETTER_CONFIG,
  readLetterConfig,
} from './lib/acceptanceLetter';

/**
 * Who signs SIWES acceptance letters, and on whose behalf.
 *
 * The letters themselves are NOT stored. One is a pure function of an approved
 * application row plus a date — see lib/acceptanceLetter.ts — so a table of
 * generated letters would hold nothing that could not be rebuilt, and would go
 * stale the moment an admin corrected a misspelt institution on the application
 * it came from. What does need storing is the signatory, because it is the only
 * value on the letter that is neither a fact about the candidate nor a choice
 * belonging to whoever prints it: every letter IIH sends is signed by the same
 * person, and each admin retyping the name is how two universities receive
 * letters signed by two spellings of it.
 */

/** Bounds on the stored strings. These print onto a letter; they are not prose. */
const MAX_FIELD = 120;

/**
 * How many candidates one CALL returns. Not how many a batch can hold.
 *
 * This used to be a hard ceiling with a `truncated` flag, which meant the
 * 501st approved applicant could not be printed at all — the flag told the
 * admin they were missing letters without giving them any way to get them, and
 * the advice it came with ("narrow the filter") pointed at a filter this query
 * never consulted. A page size plus a cursor costs almost nothing and removes
 * the dead end; the client walks it to exhaustion in `acceptedCandidates`.
 */
const PAGE_SIZE = 500;

/**
 * The most a single run will gather, across all pages.
 *
 * Still a limit, but a far higher one, and it exists to stop a runaway loop
 * rather than to bound the cohort — every intake IIH has ever run fits inside
 * it many times over. Reaching it is reported, and reported honestly: at this
 * point the right answer is a real export, not more pages.
 */
const RUN_CEILING = 5000;

/**
 * Whether an account may be named as the signatory.
 *
 * One predicate for the picker and both write paths. They had drifted: the
 * picker excluded dummy accounts and the two mutations did not, so a name the
 * list would never offer could still be stored through either door.
 */
function maySign(u: {
  isDeleted?: boolean;
  isActive?: boolean;
  isDummy?: boolean;
  roles: string[];
}): boolean {
  return (
    !u.isDeleted &&
    u.isActive === true &&
    !u.isDummy &&
    u.roles.some((r) => ['moderator', 'admin', 'super_admin'].includes(r))
  );
}

export const config = query({
  args: { token: v.string() },
  /**
   * Moderator-gated, matching `applications.list`.
   *
   * A moderator already reads the admissions queue, and this returns a staff
   * member's name and job title — the two facts their ORBIT profile carries
   * anyway. Deciding to accept someone stays admin-only; printing the letter
   * that follows from a decision already taken is clerical work.
   */
  handler: async (ctx, { token }) => {
    await requireModerator(ctx, token);

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', ACCEPTANCE_LETTER_SETTING))
      .unique();

    const stored = readLetterConfig(row?.settingValue);
    const signatoryUserId = (row?.settingValue as { signatoryUserId?: Id<'users'> } | undefined)
      ?.signatoryUserId;

    /**
     * The NAME COMES FROM THE ACCOUNT, not from the setting.
     *
     * Storing an id and resolving it here is what stops the name on a letter
     * drifting from the person it belongs to: a correction to their profile
     * reaches every letter printed afterwards, and nobody retypes anything.
     *
     * The stored name survives as a fallback for two cases that both really
     * happen — a configuration written before this was a picker, and a
     * signatory whose account was later deactivated or deleted. A letter that
     * suddenly prints unsigned because someone was offboarded is a worse
     * failure than one bearing a name that needs updating.
     */
    const live = signatoryUserId ? await ctx.db.get(signatoryUserId) : null;

    // Trashed and deactivated rows still come back from `get`, so "deleted or
    // deactivated falls back to the snapshot" was only true of a HARD delete
    // until this check existed. Now the fallback means what it says.
    const usable = live && !live.isDeleted && live.isActive ? live : null;

    return {
      ...stored,
      signatoryUserId: signatoryUserId ?? null,
      signatoryName: usable?.fullName || stored.signatoryName,
    };
  },
});

/**
 * Staff who can be named as the signatory.
 *
 * Interns are excluded: the signature commits IIH to hosting someone, which is
 * not a thing a participant signs. Admin-gated because it lists staff accounts,
 * and choosing is a super-admin act anyway.
 */
export const signatoryCandidates = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    const staff = await ctx.db.query('users').take(2000);

    return staff
      .filter(maySign)
      .map((u) => ({ id: u._id, fullName: u.fullName, email: u.email }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

/**
 * Sets the signatory. Admin only, audited.
 *
 * CREATES the row when absent, unlike `adminSettings.set`, which refuses unknown
 * keys because its keys come from migrations. This key is defined by this
 * feature, so refusing to create it would leave the signatory unsettable on a
 * fresh deployment and every letter would print with a blank signature — the
 * same reasoning `files.setSiteLogo` applies.
 */
export const saveConfig = mutation({
  args: {
    token: v.string(),
    /** The staff account that signs. Their name is read from it at print time. */
    signatoryUserId: v.id('users'),
    signatoryTitle: v.string(),
  },
  handler: async (ctx, { token, signatoryUserId, signatoryTitle }) => {
    const admin = await requireAdmin(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return {
        success: false as const,
        error: 'Only a super admin can choose who signs acceptance letters.',
      };
    }

    /**
     * The chosen account must exist, be usable, and be staff.
     *
     * This name goes onto a document sent to a university in IIH's name, so an
     * id that resolves to a deactivated account — or to an intern — is refused
     * here rather than discovered as a blank signature line on the afternoon a
     * cohort's letters are due.
     */
    const signatory = await ctx.db.get(signatoryUserId);
    if (!signatory || !maySign(signatory)) {
      return { success: false as const, error: 'That account is not available to sign.' };
    }

    const name = signatory.fullName.trim();
    if (!name) {
      return { success: false as const, error: 'That account has no name to sign with.' };
    }

    // REJECTS rather than truncates — this is an authenticated write, so
    // `lib/input.ts`'s rule applies, not `lib/intake.ts`'s. Silently storing
    // "Jane Do" would put a clipped name under a signature on every
    // letter that followed, and the admin who typed it would never be told.
    const title = signatoryTitle.trim() || DEFAULT_LETTER_CONFIG.signatoryTitle;
    for (const [label, field] of [
      ['signatory name', name],
      ['signatory title', title],
    ] as const) {
      if (field.length > MAX_FIELD) {
        return {
          success: false as const,
          error: `The ${label} must be ${MAX_FIELD} characters or fewer.`,
        };
      }
    }

    const value = {
      signatoryUserId,
      // A snapshot, not the source of truth. `config` prefers the live account
      // and falls back to this if the signatory is later offboarded.
      signatoryName: name,
      signatoryTitle: title,
    } satisfies AcceptanceLetterConfig & { signatoryUserId: Id<'users'> };

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', ACCEPTANCE_LETTER_SETTING))
      .unique();

    const now = Date.now();

    if (row) {
      await ctx.db.patch(row._id, { settingValue: value, updatedBy: admin._id, updatedAt: now });
    } else {
      await ctx.db.insert('adminSettings', {
        settingKey: ACCEPTANCE_LETTER_SETTING,
        settingValue: value,
        category: 'general',
        description: 'Signatory printed on SIWES acceptance letters',
        updatedBy: admin._id,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.setting_changed',
      tableName: 'adminSettings',
      recordId: row?._id,
      oldValues: row ? { settingValue: row.settingValue } : undefined,
      newValues: { settingValue: value },
      success: true,
      createdAt: now,
    });

    return { success: true as const, config: value };
  },
});

/**
 * One page of approved SIWES applicants, reduced to what a letter needs.
 *
 * The batch cannot be built from the admissions table the screen already holds.
 * That list arrives through `callSiwesRpc`, which passes no limit — so
 * `applications.list` caps it at 100 — and it carries whatever status filter the
 * admin last chose. Generating "letters for everyone accepted" from it produces
 * the first hundred of the current filter and looks, to whoever prints it, like
 * everyone. This reads the approved index directly.
 *
 * PAGED, and the client walks every page. The earlier version returned a single
 * capped slice with a `truncated` flag, which named the problem without giving
 * anyone a way out of it: past the cap an applicant simply could not be printed.
 *
 * Moderator-gated, matching `config` above: printing letters that follow from a
 * decision already taken is clerical work, and deciding stays admin-only.
 *
 * WHAT A LETTER NEEDS, not the application row. A name, a level, a department,
 * a university and the one word that picks a pronoun; an applicant's phone
 * number, matric number and passport photo have no business in a payload whose
 * only purpose is to be printed. The shape is `LetterCandidate` so the print
 * view takes it directly.
 */
/**
 * Seeds the signatory from the command line, by email.
 *
 * INTERNAL, so it is reachable only with deploy credentials — never from a
 * session, never from the browser. It exists because choosing a signatory is
 * deliberately super-admin-only, and a fresh deployment has no super admin
 * signed in to choose one: without this, the first letter on any new
 * environment prints unsigned until somebody logs in.
 *
 * It does NOT loosen the public control. `saveConfig` keeps its super-admin
 * gate, the Settings screen keeps working, and anyone with a session still
 * needs that role to change who signs. This is the same authority a deploy key
 * already carries over the whole deployment, expressed as one narrow function
 * rather than a widened permission.
 *
 *   npx convex run acceptanceLetters:bootstrapSignatory \
 *     '{"email":"someone@iih.ng","signatoryTitle":"HR Associate"}' --prod
 */
export const bootstrapSignatory = internalMutation({
  args: { email: v.string(), signatoryTitle: v.optional(v.string()) },
  handler: async (ctx, { email, signatoryTitle }) => {
    const normalised = email.trim().toLowerCase();

    const signatory = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();

    // The same checks the public mutation makes. A bootstrap that skipped them
    // would be a way to put an intern's name, or a deactivated account's, on a
    // letter bound for a university.
    if (!signatory || !maySign(signatory)) {
      return { success: false as const, error: `${normalised} is not an account that may sign.` };
    }

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', ACCEPTANCE_LETTER_SETTING))
      .unique();

    const name = signatory.fullName.trim();
    if (!name) {
      return { success: false as const, error: `${normalised} has no name to sign with.` };
    }

    // REJECTS rather than truncates, matching `saveConfig`. A silently clipped
    // job title under a signature is the same defect whichever door it came in
    // through — see the rule at the top of lib/input.ts.
    const title = signatoryTitle?.trim() || DEFAULT_LETTER_CONFIG.signatoryTitle;
    if (name.length > MAX_FIELD) {
      return { success: false as const, error: `${normalised} has a name too long to sign with.` };
    }
    if (title.length > MAX_FIELD) {
      return {
        success: false as const,
        error: `The signatory title must be ${MAX_FIELD} characters or fewer.`,
      };
    }

    const now = Date.now();
    const value = { signatoryUserId: signatory._id, signatoryName: name, signatoryTitle: title };

    if (row) {
      await ctx.db.patch(row._id, { settingValue: value, updatedAt: now });
    } else {
      await ctx.db.insert('adminSettings', {
        settingKey: ACCEPTANCE_LETTER_SETTING,
        settingValue: value,
        category: 'general',
        description: 'Signatory printed on SIWES acceptance letters',
        createdAt: now,
        updatedAt: now,
      });
    }

    // Audited like any other change to this setting, and marked as having come
    // from the command line rather than from a person on a screen.
    await ctx.db.insert('auditLogs', {
      // No actor: nobody signed in to do this. Naming the signatory as the
      // author — including by indexing the audit row under their userId — puts
      // a change in their name that they did not make. The subject travels in
      // newValues instead.
      userEmail: 'cli@deploy-key',
      userRoles: ['deploy-key'],
      action: 'admin.setting_changed',
      tableName: 'adminSettings',
      recordId: row?._id,
      oldValues: row ? { settingValue: row.settingValue } : undefined,
      newValues: { settingValue: value, via: 'bootstrapSignatory (CLI)', subjectUserId: signatory._id },
      success: true,
      createdAt: now,
    });

    return { success: true as const, signatory: signatory.fullName, title: value.signatoryTitle };
  },
});

export const acceptedCandidates = query({
  args: { token: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { token, cursor }) => {
    await requireModerator(ctx, token);

    // SIWES ONLY. `applications` also carries internship, NYSC and volunteer
    // rows, and approving one of those is a normal thing to do — but this
    // letter is titled "FOR SIWES PLACEMENT" and addressed to a university's
    // Industrial Liaison Unit, which a volunteer does not have. Without this
    // filter a batch run posts a SIWES acceptance for every approved applicant
    // of any kind, to an office that has never heard of them.
    //
    // Filtered rather than indexed: `by_status_and_time` already bounds the
    // scan to approved rows, and the programme split within those is small
    // enough that a second index earns nothing.
    const page = await ctx.db
      .query('applications')
      .withIndex('by_status_and_time', (q) => q.eq('status', 'approved'))
      .order('desc')
      .filter((q) => q.eq(q.field('programmeType'), 'siwes'))
      .paginate({ numItems: PAGE_SIZE, cursor: cursor ?? null });

    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      ceiling: RUN_CEILING,
      // No id and no reference code: neither reaches the page, and an
      // applicant identifier in a payload whose only purpose is to be printed
      // is one more thing to explain if it ever leaks.
      candidates: page.page.map((a) => ({
        fullName: a.fullName,
        levelOrYear: a.levelOrYear ?? null,
        // `courseOfStudy` ONLY. Faculty reads like a reasonable fallback and is
        // not one: the sentence is "of the Department of {X}", and a faculty
        // answer is typically "Faculty of Engineering", which prints as "of the
        // Department of Faculty of Engineering" — and fills the field, so the
        // missing-department warning never fires and nobody corrects the record.
        department: a.courseOfStudy ?? null,
        university: a.institutionName ?? null,
        gender: a.gender ?? null,
      })),
    };
  },
});

/**
 * Everything a letter needs for one application, in a single read.
 *
 * The node action that renders the PDF cannot touch the database directly, so it
 * asks for this. Returns null for anyone who should not receive a letter, which
 * is the same rule the batch query applies: SIWES only. An internship, NYSC or
 * volunteer acceptance carries no attachment because their institution is not
 * expecting one — 175 of the current 246 applicants.
 */
export const letterInputs = internalQuery({
  args: { applicationId: v.id('applications') },
  /**
   * Annotated for the same TS7022 reason as tasks.create: a node action reads
   * this result, so an inferred type routes back through the generated api type
   * — which includes this function — and TypeScript reports the cycle as
   * implicit `any` in unrelated modules rather than as anything to do with here.
   */
  handler: async (
    ctx,
    { applicationId },
  ): Promise<{
    candidate: {
      fullName: string;
      levelOrYear: string | null;
      department: string | null;
      university: string | null;
      gender: string | null;
    };
    config: unknown;
  } | null> => {
    const application = await ctx.db.get(applicationId);
    if (!application) return null;
    if (application.programmeType !== 'siwes') return null;

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', ACCEPTANCE_LETTER_SETTING))
      .unique();

    return {
      candidate: {
        fullName: application.fullName,
        levelOrYear: application.levelOrYear ?? null,
        department: application.courseOfStudy ?? null,
        university: application.institutionName ?? null,
        gender: application.gender ?? null,
      },
      config: row?.settingValue ?? null,
    };
  },
});
