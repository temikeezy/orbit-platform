/**
 * Building a Convex patch without deleting the fields you left out.
 *
 * `ctx.db.patch(id, { field: undefined })` REMOVES `field`. It does not leave it
 * alone. That is a reasonable primitive and a terrible default when the patch is
 * assembled from optional arguments, because every argument the caller did not
 * supply becomes an instruction to erase.
 *
 * This has bitten the codebase more than once — `ensureInternProfile` seeded
 * from an empty object could wipe an intern's institution and supervisor, and
 * `saveCohort` drops any cohort field a client did not send. Both are the same
 * one-line mistake, so it is named once here rather than reimplemented at each
 * call site with a slightly different filter.
 *
 * Use it for the part of a patch derived from optional input. Keep the fields
 * you always mean to write — `updatedAt`, a status you are deliberately setting
 * — outside it, so an intentional write is never filtered out by accident.
 */
export function defined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
