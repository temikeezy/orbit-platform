import { existsSync, readFileSync, rmSync } from 'node:fs';
import { adminToken, client, destroyUser } from './orbit';
import { MANIFEST, STATE_DIR, type Manifest } from './global-setup';

/**
 * Removes this run's actors, and with them everything that cascades.
 *
 * Submissions, points-ledger rows, posts, daily logs, weekly summaries and
 * attendance have no delete of their own — permanently deleting the owning user
 * is the only way they go. That is the whole reason actors are disposable and
 * the scaffold is not: the scaffold's stream and task CANNOT be deleted, only
 * deactivated, so they are reused rather than recreated.
 */
async function globalTeardown() {
  if (!existsSync(MANIFEST)) return;

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

  try {
    const convex = client();
    const token = await adminToken(convex);

    for (const user of manifest.users) {
      await destroyUser(convex, token, user.id);
    }

    console.log(`[e2e] run ${manifest.runId}: removed ${manifest.users.length} actors`);
  } catch (error) {
    // Never fail the run on teardown — the tests already reported their result,
    // and leftovers are identifiable by the run id stamped into every address.
    console.warn(`[e2e] teardown incomplete for run ${manifest.runId}:`, error);
  } finally {
    // Session tokens live in these files. Removing them keeps a working
    // credential for four accounts out of the working tree.
    rmSync(STATE_DIR, { recursive: true, force: true });
  }
}

export default globalTeardown;
