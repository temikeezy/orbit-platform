import { Doc, Id } from '../_generated/dataModel';
import { QueryCtx, MutationCtx } from '../_generated/server';

/**
 * What an admin decides about an applicant before approving them.
 *
 * The concept note is explicit that ORBIT assigns participation mode after
 * review and that applicants do not choose it. The platform derived it from the
 * applicant's free-text location at intake and then copied that verbatim into
 * the account, so "review settled it" was not true of any application: the
 * approval email announced a mode nobody had looked at, and the team corrected
 * it afterwards on the created account, by which point the applicant had
 * already been told something else.
 *
 * These rules live in lib/ so the three callers cannot disagree — the assign
 * action, the approve action that carries a placement with it, and the
 * conversion sweep that consumes the result. It is also what keeps
 * applications.ts thin; see the note in lib/sheets.ts about the generated `api`
 * type sitting at TypeScript's inference limit.
 */

/** The platform's vocabulary. `remote` is not one of these — see lib/conversion.ts. */
export const PARTICIPATION_MODES = ['virtual', 'hybrid', 'physical'] as const;

export interface PlacementInput {
  participationMode?: string;
  physicalDay?: number;
  cohortId?: Id<'cohorts'>;
  streamId?: Id<'streams'>;
  supervisorId?: Id<'users'>;
  departmentId?: Id<'departments'>;
  modeOverrideReason?: string;
}

export type PlacementResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validates a placement and derives what it can, or refuses with a reason an
 * admin can act on.
 *
 * Refusals are worded for the person clicking, not for a log: "that stream is
 * not active" is actionable, "invalid streamId" is not.
 */
export async function resolvePlacement(
  ctx: QueryCtx | MutationCtx,
  application: Doc<'applications'>,
  input: PlacementInput,
): Promise<PlacementResult> {
  const patch: Record<string, unknown> = {};

  if (input.participationMode !== undefined) {
    if (!(PARTICIPATION_MODES as readonly string[]).includes(input.participationMode)) {
      return {
        ok: false,
        error: `Participation mode must be one of: ${PARTICIPATION_MODES.join(', ')}.`,
      };
    }

    /**
     * An override has to say why.
     *
     * Not bureaucracy: the derived mode encodes "this person said they are in
     * Ilorin", and overriding it is a decision about someone's travel and
     * attendance obligations for twelve weeks. The reason is what the next
     * person to open the record reads instead of guessing.
     */
    const overriding = input.participationMode !== application.preferredParticipationMode;
    const reason = input.modeOverrideReason?.trim();

    if (overriding && !reason) {
      return {
        ok: false,
        error:
          `This applicant's location suggests ${application.preferredParticipationMode}. ` +
          'Give a short reason for assigning a different mode.',
      };
    }

    patch.assignedParticipationMode = input.participationMode;
    patch.modeOverrideReason = overriding ? reason : undefined;

    /**
     * A physical day is meaningless off-site, so it is cleared rather than
     * carried. Leaving a stale Monday on someone moved to virtual would put
     * them in the on-site attendance sweep for a day they are not expected.
     */
    if (input.participationMode === 'virtual') {
      patch.assignedPhysicalDay = undefined;
    }
  }

  if (input.physicalDay !== undefined) {
    const mode = input.participationMode ?? application.preferredParticipationMode;
    if (mode === 'virtual') {
      return { ok: false, error: 'A virtual participant has no on-site day.' };
    }
    if (!Number.isInteger(input.physicalDay) || input.physicalDay < 0 || input.physicalDay > 6) {
      return { ok: false, error: 'Pick a day of the week.' };
    }
    patch.assignedPhysicalDay = input.physicalDay;
  }

  if (input.cohortId !== undefined) {
    const cohort = await ctx.db.get(input.cohortId);
    if (!cohort) return { ok: false, error: 'That cohort no longer exists.' };
    patch.assignedCohortId = cohort._id;
  }

  if (input.streamId !== undefined) {
    const stream = await ctx.db.get(input.streamId);
    if (!stream) return { ok: false, error: 'That stream no longer exists.' };
    if (!stream.isActive) {
      return { ok: false, error: `${stream.name} is not active — pick a running stream.` };
    }
    patch.assignedStreamId = stream._id;
  }

  if (input.supervisorId !== undefined) {
    const supervisor = await ctx.db.get(input.supervisorId);
    if (!supervisor || supervisor.isDeleted || !supervisor.isActive) {
      return { ok: false, error: 'That supervisor is not an active member of staff.' };
    }
    patch.assignedSupervisorId = supervisor._id;
  }

  if (input.departmentId !== undefined) {
    const department = await ctx.db.get(input.departmentId);
    if (!department) return { ok: false, error: 'That department no longer exists.' };
    patch.assignedDepartmentId = department._id;
  }

  return { ok: true, patch };
}

/** True when anything about the placement has been decided. */
export function hasPlacement(input: PlacementInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}
