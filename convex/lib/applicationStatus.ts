/**
 * The admissions state machine: an application is either submitted or approved.
 *
 * Deliberately two states. It carried six — submitted, under_review, approved,
 * waitlisted, rejected, converted — which sounds richer and was not: nothing in
 * the platform behaved differently for any of them, so five of the six were
 * private notes stored in a status column, and `converted` in particular claimed
 * an ORBIT account existed while nothing created one or checked.
 *
 * Two states mean one decision, and the decision is visible.
 *
 * In lib/ rather than in the function module because the generated `api` type
 * is at TypeScript's inference limit and only tolerates thin handlers — and
 * because the admin screen, the bulk action and the sheet sync then consult one
 * rule instead of three that have to agree.
 */

export const STATUSES = ['submitted', 'approved'] as const;

export type ApplicationStatus = (typeof STATUSES)[number];

/**
 * APPROVAL IS ONE-WAY.
 *
 * An approval is a decision communicated to a person. Letting it be reversed in
 * a dropdown — or, now that the sheet writes back, by a stray paste or an
 * autofill drag — means someone can be un-admitted silently and no one finds
 * out. So the only transition that exists is submitted -> approved.
 */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return from === 'submitted' && to === 'approved';
}

/** Why a transition was refused, in words an admin can act on. */
export function refusalReason(from: string, to: string): string {
  if (!(STATUSES as readonly string[]).includes(to)) {
    return `Status must be one of: ${STATUSES.join(', ')}`;
  }
  if (from === 'approved') {
    return 'Approved applications cannot be changed.';
  }
  return `Cannot move an application from ${from} to ${to}.`;
}

/** True once the decision is fixed and the row should render as read-only. */
export function isTerminal(status: string): boolean {
  return status === 'approved';
}
