/**
 * Organisation identity for the browser. Vite build-time variables, so they
 * are baked in at build (like VITE_CONVEX_URL). Defaults reproduce the original
 * operator (Ilorin Innovation Hub) exactly.
 *
 * Server counterpart: convex/lib/org.ts (Convex env ORBIT_ORG_*).
 */
const env = import.meta.env as Record<string, string | undefined>;

function read(name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

export const ORG_NAME = read('VITE_ORG_NAME', 'Ilorin Innovation Hub');
export const ORG_SHORT_NAME = read('VITE_ORG_SHORT_NAME', 'IIH');
export const ORG_URL = read('VITE_ORG_URL', 'https://iih.ng');
/** Email domain of staff who sign in through the organisation's identity provider. */
export const OAUTH_DOMAIN_HINT = read('VITE_OAUTH_DOMAIN_HINT', 'iih.ng');
/** Name shown in the footer copyright line ("Orbit by <name>"). */
export const ORG_COPYRIGHT_NAME = read('VITE_ORG_COPYRIGHT_NAME', 'Innovation Incubation Hub');
