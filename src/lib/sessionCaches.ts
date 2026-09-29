/**
 * In-memory caches that must not outlive a session.
 *
 * `settingsApi` holds admin settings for 60 seconds and serves them BEFORE any
 * token check while warm; `levelUtils` holds the level ladder. Neither lives in
 * localStorage, so clearing storage on sign-out left both standing — on a shared
 * machine the next person to sign in within that window could be served the
 * previous admin's settings with no server authorization anywhere in the path.
 *
 * A registry rather than direct imports, because `auth.ts` is what knows a
 * session ended, and both cache owners already import `auth.ts` — calling them
 * from there directly would make the import graph circular. Owners register
 * themselves; auth just says "the session is over".
 */
type ClearFn = () => void;

const registered = new Set<ClearFn>();

/** Called by a module that keeps session-scoped state in memory. */
export function registerSessionCache(clear: ClearFn): void {
  registered.add(clear);
}

/** Called on sign-out, and on a server-rejected session. */
export function clearSessionCaches(): void {
  for (const clear of registered) {
    try {
      clear();
    } catch {
      // One misbehaving cache must not stop the others being cleared, and a
      // failure here must never block a sign-out.
    }
  }
}
