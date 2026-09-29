/**
 * Deletes the stale `supabase-api` runtime cache.
 *
 * The service worker used to run a NetworkFirst rule over `*.supabase.co` with
 * a 5-minute expiry. That rule is gone from vite.config.ts, but removing a rule
 * does NOT remove the cache it created — an installed client keeps the entries,
 * and with `registerType: 'autoUpdate'` it keeps them until the worker updates.
 * Nothing reads that cache any more, so it is dead bytes on every existing
 * client's disk, and while Supabase was still reachable it could have served a
 * response that outlived a sign-out.
 *
 * Imported by the generated worker, so this runs in the worker's own scope on
 * every activation. It is idempotent: once the cache is gone, `delete` returns
 * false and this is a no-op. Safe to remove from the build once every client
 * has updated — but it costs nothing to leave.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('supabase-api'))
            .map((name) => caches.delete(name)),
        ),
      )
      .catch(() => {
        // A client that cannot enumerate caches is not a client we can fix
        // here, and failing activation would leave it on the OLD worker —
        // exactly the state this is trying to get it out of.
      }),
  );
});
