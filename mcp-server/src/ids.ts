import { fn } from './functions.js';
import type { OrbitClient } from './client.js';

/**
 * Accepts pre-migration Postgres uuids wherever a Convex id is expected.
 *
 * Every ORBIT id an agent has ever seen — in its own notes, in a pasted
 * `/tasks/<uuid>` link, in a previous conversation — is a Postgres uuid. Convex
 * ids look nothing like them, so without this the first thing an agent does
 * after cutover is pass an id it already knows and get a validator error with
 * nothing actionable in it.
 *
 * `legacyId` is dropped from the schema once cutover is verified, at which point
 * this whole module goes with it. Until then it is the difference between an
 * agent's accumulated context staying useful and being silently invalidated.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvableTable =
  | 'users'
  | 'streams'
  | 'tasks'
  | 'submissions'
  | 'posts'
  | 'postReplies'
  | 'messages';

/** Resolutions are immutable once made, so they are cached for the process. */
const cache = new Map<string, string>();

export class UnknownIdError extends Error {
  constructor(table: ResolvableTable, id: string) {
    super(
      `No ${table} row matches the legacy id ${id}. It may predate the import, or ` +
        `belong to a different table.`,
    );
  }
}

/**
 * Returns a Convex id, resolving through `legacyId` when given a uuid.
 *
 * Anything that is not uuid-shaped passes through untouched — Convex validates
 * it, and its error names the expected table, which is a better message than
 * anything this function could invent.
 */
export async function resolveId(
  client: OrbitClient,
  table: ResolvableTable,
  id: string,
): Promise<string> {
  const trimmed = id.trim();
  if (!UUID.test(trimmed)) return trimmed;

  const key = `${table}:${trimmed.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const resolved = await client.query(fn.resolveLegacyId, { table, legacyId: trimmed });
  if (!resolved) throw new UnknownIdError(table, trimmed);

  cache.set(key, resolved);
  return resolved;
}

/** Optional variant, for tool arguments that may be omitted. */
export async function resolveOptionalId(
  client: OrbitClient,
  table: ResolvableTable,
  id: string | undefined,
): Promise<string | undefined> {
  return id === undefined ? undefined : resolveId(client, table, id);
}
