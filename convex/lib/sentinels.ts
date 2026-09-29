/**
 * Values shared verbatim between the server and the browser.
 *
 * This file must stay free of every Convex import. `SettingsPage.tsx` used to
 * import the sentinel straight from `convex/adminSettings`, which pulled that
 * module — and through it `_generated/server` and `lib/auth` — into the client
 * bundle. Convex noticed and warned on every admin page load: "Convex functions
 * should not be imported in the browser. This will throw an error in future
 * versions of `convex`."
 *
 * Sharing a constant is legitimate; sharing it through a module that also
 * defines queries and mutations is what shipped server code to the browser.
 */

/** The placeholder a masked secret carries. Writing it back means "unchanged". */
export const SECRET_UNCHANGED = '__unchanged__';
