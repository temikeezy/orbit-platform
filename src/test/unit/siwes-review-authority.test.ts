import { describe, it, expect } from 'vitest';
import { canReviewProfile } from '../../../convex/siwes';
import type { Doc } from '../../../convex/_generated/dataModel';
import type { QueryCtx } from '../../../convex/_generated/server';

/**
 * `canReviewProfile` has THREE routes to logbook-review authority: admin,
 * direct `iihSupervisorId`, and department lead (`intern.departmentId` ->
 * `department.leadUserId`). This file exists because nothing else in the
 * suite exercises the real function — `siwes-role-access.test.ts` mocks the
 * Convex layer entirely, and `convex-client-swap.test.ts` only checks that
 * the review-queue query does not throw for a caller with no reviewable
 * interns.
 *
 * The department-lead route is NOT a legacy corner case. `PlacementModal.tsx`
 * tells the admin placing a SIWES intern, in the product itself: "Without a
 * supervisor or a department, nobody can review this person's logbook" — an
 * individual supervisor is optional, and department-only assignment is a
 * live, sanctioned path. `scheduled.ts` and `notificationsInternal.ts` both
 * fall back to the department lead for the same reason, and the former's own
 * comment records that omitting this fallback once already caused real weeks
 * to sit "unsigned with nobody reminded". These tests pin the three-route
 * contract so a future attempt to remove the department route fails here
 * first, loudly, rather than silently in production against real interns.
 */

function fakeCtx(docs: Record<string, unknown>): QueryCtx {
  return {
    db: {
      get: async (id: string) => (docs[id] as never) ?? null,
    },
  } as unknown as QueryCtx;
}

function user(fields: { _id: string; roles?: string[]; departmentId?: string; iihSupervisorId?: string }): Doc<'users'> {
  return fields as unknown as Doc<'users'>;
}

describe('canReviewProfile', () => {
  const intern = user({ _id: 'intern1', departmentId: 'dept1' });

  it('lets an admin review any intern, with no assignment at all', async () => {
    const admin = user({ _id: 'admin1', roles: ['admin'] });
    const ctx = fakeCtx({});
    await expect(canReviewProfile(ctx, intern, admin)).resolves.toBe(true);
  });

  it('lets a super_admin review any intern', async () => {
    const superAdmin = user({ _id: 'sa1', roles: ['super_admin'] });
    const ctx = fakeCtx({});
    await expect(canReviewProfile(ctx, intern, superAdmin)).resolves.toBe(true);
  });

  it('lets the directly-assigned iihSupervisorId review, department or not', async () => {
    const supervisor = user({ _id: 'sup1', roles: [] });
    const supervised = user({ _id: 'intern2', iihSupervisorId: 'sup1' });
    const ctx = fakeCtx({});
    await expect(canReviewProfile(ctx, supervised, supervisor)).resolves.toBe(true);
  });

  /**
   * THE LOAD-BEARING CASE. No iihSupervisorId at all — only a department, and
   * the caller leads it. This is exactly what PlacementModal.tsx describes as
   * sufficient, and exactly what conversion produces for an applicant placed
   * into a department without naming an individual supervisor.
   */
  it('lets a department lead review an intern with no individual supervisor', async () => {
    const lead = user({ _id: 'lead1', roles: [] });
    const ctx = fakeCtx({ dept1: { _id: 'dept1', leadUserId: 'lead1' } });
    await expect(canReviewProfile(ctx, intern, lead)).resolves.toBe(true);
  });

  it('needs no separate moderator role for the department-lead route', async () => {
    // The docstring on canReviewProfile is explicit that requiring a second
    // `moderator` grant on top of leading a department was itself a bug: it
    // locked a lead out of the queue they were responsible for.
    const lead = user({ _id: 'lead2', roles: [] });
    const ctx = fakeCtx({ dept1: { _id: 'dept1', leadUserId: 'lead2' } });
    await expect(canReviewProfile(ctx, intern, lead)).resolves.toBe(true);
  });

  it('refuses someone who is neither admin, supervisor, nor the department lead', async () => {
    const stranger = user({ _id: 'stranger1', roles: [] });
    const ctx = fakeCtx({ dept1: { _id: 'dept1', leadUserId: 'someone-else' } });
    await expect(canReviewProfile(ctx, intern, stranger)).resolves.toBe(false);
  });

  it('refuses review when the intern has neither a supervisor nor a department', async () => {
    // The gap that exists today regardless of this change: conversion can
    // leave both fields unset. Not a regression to fix here — captured so a
    // future change to the "must a reviewer exist" guarantee is deliberate.
    const unassigned = user({ _id: 'intern3' });
    const stranger = user({ _id: 'stranger2', roles: [] });
    const ctx = fakeCtx({});
    await expect(canReviewProfile(ctx, unassigned, stranger)).resolves.toBe(false);
  });
});
