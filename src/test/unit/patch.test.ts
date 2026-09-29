import { describe, it, expect } from 'vitest';
import { defined } from '../../../convex/lib/patch';

/**
 * The guard against a patch erasing what the caller simply did not mention.
 *
 * `ctx.db.patch(id, { field: undefined })` REMOVES the field, so a patch built
 * from optional arguments turns every omitted argument into an instruction to
 * wipe. `defined()` is the single named answer to that, and it had no test — a
 * filter loosened to `!= null` or `Boolean(value)` would still look correct at
 * a glance while silently changing which fields survive a partial save.
 *
 * The distinction these cases exist to pin: `undefined` means "not supplied,
 * keep what is stored"; `null`, `''`, `0` and `false` are values a caller
 * deliberately sent and must reach the database intact.
 */

describe('defined', () => {
  it('drops undefined, which is what would erase a stored field', () => {
    expect(defined({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it('keeps null — clearing a field on purpose is not the same as omitting it', () => {
    // saveCohort and the intern profile both rely on this: null is how a client
    // says "unset the supervisor", and treating it like undefined would make
    // that impossible to express.
    expect(defined({ supervisor: null })).toEqual({ supervisor: null });
  });

  it('keeps the falsy values a filter written as Boolean(value) would eat', () => {
    expect(defined({ count: 0, note: '', active: false })).toEqual({
      count: 0,
      note: '',
      active: false,
    });
  });

  it('returns an empty patch when nothing was supplied', () => {
    // The seeded-from-an-empty-object case: ensureInternProfile could otherwise
    // wipe an intern's institution and supervisor in one call.
    expect(defined({ a: undefined, b: undefined })).toEqual({});
    expect(defined({})).toEqual({});
  });

  it('does not mutate its input', () => {
    const input = { a: 1, b: undefined };
    defined(input);
    expect(input).toEqual({ a: 1, b: undefined });
    expect('b' in input).toBe(true);
  });

  it('keeps nested objects and arrays by reference rather than copying them', () => {
    const nested = { deep: true };
    const list = [1, 2];
    const out = defined({ nested, list, gone: undefined });
    expect(out).toEqual({ nested, list });
    expect(out.nested).toBe(nested);
    expect(out.list).toBe(list);
  });
});
