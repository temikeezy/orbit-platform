import { describe, expect, it } from 'vitest';
import { cohortForNewAdmission, mondayAfter, planCohorts } from '../../../convex/lib/cohortRollover';

const orbit2 = { id: 'c1', name: 'ORBIT 2.0', status: 'active', startDate: '2026-08-17', endDate: '2026-11-06' };

describe('planCohorts', () => {
  it('does nothing while the cohort has more than three weeks left', () => {
    expect(planCohorts([orbit2], '2026-10-01')).toEqual({ create: null, activate: [], complete: [] });
  });

  it('opens the next cohort as a draft three weeks out, the Monday after, same length', () => {
    const plan = planCohorts([orbit2], '2026-10-16');
    expect(plan.create).toEqual({
      name: 'ORBIT November 2026', startDate: '2026-11-09', endDate: '2027-01-29', copyFrom: 'c1',
    });
  });

  it('does not open a second draft once one exists', () => {
    const draft = { id: 'c2', name: 'ORBIT November 2026', status: 'draft', startDate: '2026-11-09', endDate: '2027-01-29' };
    expect(planCohorts([orbit2, draft], '2026-10-20').create).toBeNull();
  });

  it('activates the draft on its start date and completes the ended cohort', () => {
    const draft = { id: 'c2', name: 'n', status: 'draft', startDate: '2026-11-09', endDate: '2027-01-29', byAgent: true };
    expect(planCohorts([orbit2, draft], '2026-11-09')).toMatchObject({ activate: ['c2'], complete: ['c1'] });
  });

  it('keeps the ended cohort active over the weekend until its successor starts', () => {
    const draft = { id: 'c2', name: 'n', status: 'draft', startDate: '2026-11-09', endDate: '2027-01-29', byAgent: true };
    expect(planCohorts([orbit2, draft], '2026-11-07')).toMatchObject({ activate: [], complete: [] });
  });

  it('never activates a draft it did not open', () => {
    const stray = { id: 'old', name: 'Forgotten', status: 'draft', startDate: '2026-01-01', endDate: '2026-03-01' };
    expect(planCohorts([orbit2, stray], '2026-10-01').activate).toEqual([]);
  });

  it('never completes a cohort before its end date', () => {
    expect(planCohorts([orbit2], '2026-11-06').complete).toEqual([]);
  });
});

describe('mondayAfter', () => {
  it('is strictly after, even from a Monday', () => {
    expect(mondayAfter('2026-11-06')).toBe('2026-11-09');
    expect(mondayAfter('2026-11-09')).toBe('2026-11-16');
  });
});

describe('cohortForNewAdmission', () => {
  const draft = { id: 'c2', name: 'n', status: 'draft', startDate: '2026-11-09', endDate: '2027-01-29' };
  it('uses the active cohort while it has two weeks or more left', () => {
    expect(cohortForNewAdmission([orbit2, draft], '2026-10-20')).toBe('c1');
  });
  it('uses the incoming cohort in the final fortnight', () => {
    expect(cohortForNewAdmission([orbit2, draft], '2026-10-26')).toBe('c2');
  });
  it('falls back to the active cohort when nothing is incoming', () => {
    expect(cohortForNewAdmission([orbit2], '2026-10-26')).toBe('c1');
  });
});
