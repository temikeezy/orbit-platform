# ORBIT Security Model

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge reports within a few working days and will credit you in the fix unless you prefer otherwise.

In scope: this codebase — authentication and sessions, the authorisation checks on Convex functions, file access, the public application intake, email handling, and the automation runner. Out of scope: vulnerabilities in a specific organisation's deployment configuration (report those to that organisation), and denial-of-service against someone else's deployment.

The rest of this document is the security model itself, written for anyone changing the code.


Read this before making a security decision about ORBIT. It describes the system as it stands on 2026-09-29, on Convex. Any document in this repo still describing Supabase RLS, `SECURITY DEFINER` functions or `p_token` RPCs is wrong and should be fixed, not trusted.

## The central invariant

**Convex has no row-level security and cannot have any.** Authorization is enforced **entirely at the function level**: every public query, mutation and action resolves a bearer token to a user and checks that user's roles itself. Nothing underneath catches a mistake — a missing `requireAdmin` is not defence-in-depth failing; it is the only defence, absent.

```ts
export const someMutation = mutation({
  args: { token: v.string(), /* ... */ },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.token);      // or requireAdmin / requireModerator
    // ... the function is now responsible for every check that matters
  },
});
```

`requireUser` (`convex/lib/auth.ts`) resolves the token to a `sessions` row, checks `expiresAt`, and loads the user; `requireAdmin` and `requireModerator` add a role check.

Of the **196 public functions**, exactly **4** skip this deliberately (a further **128** functions are internal and unreachable from any client):

| Function | Why |
|---|---|
| `levels.infoForPoints` | Public reference data (what each point threshold unlocks) |
| `levels.list` | The level ladder, same class. It declares `token: v.optional(v.string())` and never resolves it — the frontend calls it with `{}` to render a signed-out progress view. The argument is vestigial, not a check |
| `mcp.authenticate` | Runs before a token exists; this is where one is minted |
| `zoho.exchangeOAuthCode` | Redeems a short-lived, single-use exchange code from the OAuth callback; the code is the credential |

**This is enforced mechanically.** `src/test/unit/convex-authz-surface.test.ts` fails the build if a public function declares no token, never resolves it, or makes it optional, and its allowlist fails when an entry goes stale. A fifth exemption is a deliberate edit to that file. Any new public function takes `token: v.string()` and resolves it; skipping that needs a stated reason, because the next reviewer cannot otherwise tell "deliberate" from "forgotten."

## What "public" means here

`convex/schema.ts` defines 45 tables, none with a policy. The only thing between an anonymous request and any row is handler code in the 40 modules under `convex/`. `httpAction`s (`convex/http.ts`) and every public `query`/`mutation`/`action` run for anyone who calls them by name with well-typed arguments. With no RLS and no schema-level constraint beyond types, bounding what a caller can write is code, not configuration — hence `convex/lib/input.ts` and `intake.ts` (below).

**The user shape that leaves the server.** `publicUser()` in `convex/lib/auth.ts` is the **only** user shape allowed to cross the wire; it strips `passwordHash` and `tempPassword`. Every function returning a user, directly or nested, goes through it — never `return user`. The Supabase build served password hashes to anyone holding the anon key by making exactly that mistake.

## Authentication

- Sessions are `sessions` rows: `{ userId, token, expiresAt, isMcp?, mcpCredential? }`. The token is 32 bytes of CSPRNG output, hex-encoded (`randomToken()`). The client keeps it in `localStorage` as `orbit_auth_token_v2`.
- Human sessions expire server-side after 7 days; expiry is checked on every read (`userFromToken`, `isMcpSession`). No client-side expiry check matters.
- Sign-in is by password (bcrypt), magic link (selector/verifier; the verifier is bcrypt-hashed and never stored or logged in plaintext), or Zoho OAuth for `iih.ng` staff.
- A user may hold several concurrent sessions (multiple devices) — deliberate; the Postgres predecessor's one-token-per-row design signed a phone out when a laptop signed in.
- **Session tokens travel as Convex function arguments**, so live bearer tokens land in Convex's function invocation log and any configured log drain. Anyone with dashboard read access can replay a session for the rest of its TTL. This is architectural; only moving identity into a header or `ctx.auth` fixes it. **Operational mitigation: confirm no log drain is configured on production, and treat Convex dashboard access as equivalent to session-hijack access.**

### Role demotion does not revoke sessions — deliberately

`requireAdmin` and `requireModerator` re-read the user's `roles` from the database on every call. A demoted admin's token still resolves to a live session, but their next admin-gated call re-checks roles and refuses; there is no window in which they can still act. Do not "fix" this with revocation logic — it is code and bug surface for no security gain. The exception is **MCP access**: MCP sessions belong to an account that authenticates by shared secret, so `mcpEnabled: false` must be immediate, and demotion clears it and drops `isMcp` sessions (`adminSetRoles`).

### super_admin

`super_admin` **cannot be granted or revoked through the application at all** — not by an admin, not by another super_admin. `adminSetRoles` refuses both directions (`convex/users.ts`), and a super_admin cannot demote themselves. The only route is a temporary `internalMutation` run with deployment credentials, which is already owner-level database access and unreachable from a browser, MCP session or HTTP route (procedure in `MCP_CONNECTION_GUIDE.md`).

The reasoning: this is the role that can rewrite every other role, so it is the account worth stealing. If a super_admin could mint peers, one compromised session could establish permanent independent access and strip the real owner on the way out. Revocation is closed for the same reason as granting: a session that can demote the owner has taken the platform. This roster should change roughly once a year, and only by someone who can already read the whole database. The holders are two IIH staff (owner-a@example.org, owner-b@example.org) and that is the intended size. A super_admin's *other* roles edit normally; the lock is on the bit, not the account. (a staff member is admin and moderator, not super_admin, by decision.)

> **Known gap.** `adminCreateUser` still accepts `super_admin` in its roles array when the caller is a super_admin, so a new super_admin *account* can be created though an existing one cannot be promoted. Closing it breaks the e2e `globalSetup`, which mints its `super_admin` fixture through that mutation on the dev deployment; doing it properly needs a harness seeding path that is not a public mutation. Until then, account creation is the remaining way a compromised super_admin session could persist.

## MCP (agent) access

An MCP session is an ordinary 15-minute session on a real ORBIT account, minted by `mcp.authenticate` from a shared secret. It calls the same public functions a browser does, under the same `requireAdmin`/`requireModerator`/rate-limit checks. Credential roster, revocation and audit attribution are in `MCP_CONNECTION_GUIDE.md`; read it before touching `convex/mcp.ts`. MCP is one of two ways the ORBIT Agent acts — the other is the unattended runner, below, which does not use MCP.

## The unattended agent

As of 2026-09-29 no person operates the portal: marking, admissions screening, logbook review, weekly task writing, helpdesk replies and cohort rollover are done by the ORBIT Agent. Staff roles and screens still work, and a person acting first always wins. Design and verification are in `docs/AUTOMATION_LOG.md`.

**Where the authority sits.** The split is deliberate: model calls run on the agent's Mac mini (`scripts/agent/cycle.sh`, launchd agent `ng.iih.orbit-agent`, every 8 hours), because the subscriptions can only be used there; every rule, timer and fallback runs in Convex crons, so a Mac outage delays work but never strands it.

- **All of it is internal functions** (`agentAdmissions`, `agentSupervision`, `agentTasks`, `agentCohorts`, `agentSupport`, `agentOps`, `lib/agentFallback`, and the `tasks.*` agent entry points). Internal functions need deployment credentials, not a login, so the automation adds **no public surface**: the count above is unchanged and no session token can reach any of it. The runner calls them with `npx convex run`.
- **Every decision is attributed** to the ORBIT Agent account (`orbit.agent@iih.ng`), and audit actions are prefixed `agent.` (`agent.application_admitted`, `agent.tasks_published`, `agent.cohort_created`/`activated`/`completed`/`carried_over`). A platform decision never appears under a staff member's name.
- **Guards, not judgement, decide outcomes.** A mark is written only when two readers agree within 25% of the task's points (a third breaks ties); disagreement, unreadable or unsupported work is set aside, and the Convex-side fallback settles it later on fixed timers. Marking writes refuse a submission that is no longer `submitted` (a person reviewed it first, so it is never overwritten) and, via `expectUpdatedAt`, one the intern changed after it was read. Anomaly flags withdraw flagged low marks for full settlement.

**Model calls read untrusted text.** Intern submissions, logbook entries, messages and applications are attacker-controlled input to an LLM. The containment is structural, not a request to behave:

- Every `claude -p` runs with `--tools "" --strict-mcp-config`: no tools and no MCP connectors, from an empty temporary working directory. Image marking is the one exception — `--tools Read`, confined to the image folder.
- Codex runs `--sandbox read-only` from the same empty directory.
- Conversation text is passed to models as JSON, not spliced into prompt prose.
- Admissions screeners never see name, email, phone, matric number or documents.
- This was verified with a prompt-injection canary. A successful injection therefore has no tool, connector or file to reach; the worst case is one bad mark, screening or reply, which the two-reader agreement and the timers exist to contain, and which staff can still override.

**What the runner machine holds.** The Mac mini holds deployment credentials (the logged-in Convex CLI session, which `convex:deploy` deliberately runs with `CONVEX_DEPLOY_KEY` unset) and the Claude and Codex subscription logins. **Compromise of that Mac is deployment-level access: full read/write of production data, including session tokens, and the ability to deploy code.** Treat it as production infrastructure. Everything depends on it staying on and logged in; the runner flags `UNHEALTHY` (every row failed on our side, typically an expired CLI login or usage pool) and `BACKUP_FAILED` in `~/.openclaw/workspace/logs/orbit-agent/`.

## Rate limiting

`convex/lib/rateLimit.ts` — fixed-window, keyed per account, email or address depending on the endpoint, against a `LIMITS` table and a consulted `blockedIps` table. It matters because inherited password hashes are cheap to attack and several endpoints are unauthenticated by necessity (login, magic link, Zoho callback, public application intake).

`RATE_LIMITS_DISABLED=true` is a development escape hatch and **must never be set on production**; `mcp.deploymentFlags` reports it.

Limits are anti-automation bounds, not quotas. Per-account and per-email caps can be tight; per-IP caps must be loose, because an ORBIT address is routinely the whole Ilorin hub behind one NAT. The comment block atop `LIMITS` has the numbers and the incidents behind them (`oauthCallback` was once 10/hour on the primary staff sign-in path — Monday-morning arrivals would have locked the platform for the hour).

## Input validation: two policies, deliberately

Do not reconcile these.

- **`convex/lib/input.ts` — REJECTS.** Authenticated writes (logbook, posts, messages). Out-of-bound input throws and the member sees why; silently truncating work someone believes they saved is the worse outcome.
- **`convex/lib/intake.ts` — TRUNCATES.** The public application form only. A shortened value beats refusing a genuine applicant over a length mistake.

Both validate URLs before they become an `href` (`httpUrl`/`optionalHttpUrl`, `portfolioLink`), rejecting `javascript:` and protocol-relative values. `src/lib/utils/url.ts` (`safeExternalUrl`, `SafeLink`) is the client half, guarding rows written before the server check existed. Keep both: the server check does not protect existing rows, and the client check alone is one new writer from being bypassed.

## Storage and file access

Convex storage has **no ownership model**: `ctx.storage.delete(id)` works for anyone holding an id, and ids appear in ordinary reads. The `uploads` table layers ownership on top — first attach claims the id, another user's attach is refused, and an object is deleted only on a claim the same call created. Before it existed, any member could delete any platform file. Do not remove or bypass it.

Private files (submission attachments, applicant photos and SIWES letters, private-stream feed images) are never given out via `ctx.storage.getUrl()`, which is an unauthenticated, non-expiring capability URL. They go through authenticated routes in `convex/http.ts` (`/applications/document`, `/submissions/file`, `/posts/image`) that re-check session and role/membership and audit every request. New private file types follow that pattern.

## Secrets and environment variables

Never commit credentials. `.gitignore` blocks `ADMIN_CREDENTIALS.md`, `*.secrets`, `.env.local`. Frontend build-time variables (Netlify build environment): `VITE_CONVEX_URL` (required), `VITE_SENTRY_DSN` (optional). Convex-side secrets (`npx convex env set`, per deployment), never in the repo:

- `SMTP_USER` / `SMTP_PASSWORD` — ZeptoMail
- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REDIRECT_URI` / `ALLOWED_OAUTH_DOMAINS`
- The MCP roster: `MCP_CREDENTIALS`, `MCP_SECRET_<NAME>`, `MCP_ACTOR_<NAME>`
- `APP_URL` / `EXTRA_ALLOWED_ORIGINS` — CORS/redirect origins
- `RATE_LIMITS_DISABLED` — must be **unset** on production
- `MIGRATION_SECRET` — should exist on neither deployment; check periodically (`npx convex env list --prod`). A set value once gated four public mutations that wrote arbitrary rows to arbitrary tables (`convex/migrations.ts`, now deleted).

`adminSettings.list` once returned the SMTP password and Zoho client secret in plaintext to any `admin`. Masking on read fixed the disclosure but not the cause: on 2026-09-20 the settings rows still held byte-identical copies of live production credentials that no server code read (`convex/email.ts` and `convex/http.ts` use the environment). Those copies existed only to be exported, backed up and missed in a rotation. They are no longer written: `stripSecrets` (`convex/lib/settingSecrets.ts`) drops the fields on every write, `purgeStoredCredentials` cleared existing values, and the Settings screen names the environment variable instead. `maskSecrets` remains for reads and audit rows.

**If you add a secret-shaped setting, put it on `SECRET_FIELDS` — then ask why it is in the database at all.** The environment is the source of truth; a settings row is a second copy rotation will not reach.

### Rotating the ZeptoMail password or Zoho client secret

Both deployments hold the **same** value (byte-identical on 2026-09-20), so rotating only `--prod` leaves dev on a revoked credential that fails later as a confusing auth error.

1. Rotate at the provider.
2. Set it on **both**, production first:
   ```bash
   env -u CONVEX_DEPLOY_KEY npx convex env set --prod SMTP_PASSWORD '<new>'
   env -u CONVEX_DEPLOY_KEY npx convex env set        SMTP_PASSWORD '<new>'
   ```
   (`env -u CONVEX_DEPLOY_KEY` for the reason in CLAUDE.md.)
3. Prove it — nothing reports a bad SMTP password until something sends:
   ```bash
   env -u CONVEX_DEPLOY_KEY npx convex run --prod email:sendOne \
     '{"to":"<your address>","subject":"rotation check","html":"<p>ok</p>"}'
   ```
   A message id back means ZeptoMail accepted it. For Zoho, do a real OAuth sign-in.
4. Nothing else needs touching: the credentials live only in deployment environment variables — not in `adminSettings`, Netlify (which holds only `VITE_CONVEX_URL`), git history or the working tree (all checked 2026-09-20).

**Dev holds a live production credential and arguably should not.** It is harmless only because dev sets `EMAIL_SINK` and `EMAIL_PAUSED`. A second ZeptoMail sending identity for dev would be strictly better. (Production has `EMAIL_PAUSED` unset, verified 2026-09-29; mail flows.)

## Password storage

Passwords are bcrypt. New hashes use cost 10; hashes inherited from Postgres were pgcrypto cost 6, cheap to attack, which is part of why login rate limiting matters. A successful sign-in rehashes at cost 10 if the stored hash is cost 4–9 (`BCRYPT_COST_TO_UPGRADE`, `convex/auth.ts`). This is a live, gradual migration with no bulk step: an owner who never signs in again keeps a weak hash indefinitely. Do not assume every production hash is cost 10.

`adminCreateUser` and `adminResetPassword` no longer store the temporary password; it is returned once, to the issuing admin. The `tempPassword` schema field remains (Convex will not drop a field while documents carry a value) and is cleared on the owner's next sign-in or the next `adminResetPassword`. When auditing an account for a cleartext credential, check whether it has signed in or been reset since — do not assume the field is empty.

## Backups

Convex takes its own platform snapshots; those are not a portable backup you control. ORBIT now takes one: the runner's weekly step runs `npx convex export --prod` (data only, no file storage) into `~/orbit-backups` on the agent's Mac, verifies it with `unzip -t`, and keeps the newest 4. The admin Settings page states what the weekly export covers and gives the manual command; for a backup before a risky change, or one that includes file storage, take it by hand:

```bash
npm run convex:export -- --prod --include-file-storage
```

**An export is as sensitive as production.** It contains **live session tokens and personal data** — a copy can replay any unexpired session and identifies applicants who are not ORBIT users. Protections: the directory and files are owner-only, FileVault is required (the step refuses to run without it), the directory is excluded from Time Machine, and each export is verified after writing. **Residual risk: the archives are not separately encrypted**, so their protection is the disk's and the account's. Anyone who can read that user's files or an unlocked session can read the data. Do not copy an export off the machine, attach it anywhere, or leave hand-taken ones lying around; delete them once the risky change is done.

## Security review checklist

Before a change touching auth, roles or data exposure:

- `npm run typecheck` (includes `convex/` via `tsconfig.convex.json`), `npm test`, `npm run build`, `npm run lint` pass
- Every new public function touching non-public data takes `token: v.string()` and calls `requireUser`/`requireAdmin`/`requireModerator`; agent automation is `internal*` and adds no public surface
- Every function returning a user goes through `publicUser()`
- New authenticated-write text fields are bounded in `input.ts`'s `FIELD` table; public-form fields follow `intake.ts` truncation
- New hrefs from user strings use `httpUrl`/`optionalHttpUrl` (server) and `safeExternalUrl`/`SafeLink` (client)
- New private files are served through an authenticated `httpAction`, never `ctx.storage.getUrl()`
- New rate-limited endpoints use `checkRateLimit` with a caller-uncontrollable key (server-read IP, account id), never a caller-supplied argument
- Any new model call over intern or applicant text runs with no tools, no MCP and an empty working directory, and gets conversation text as JSON
- Error messages to a client do not disclose secrets, stack traces or Convex internals

## Historical

`SECURITY_IMPLEMENTATION_SUMMARY.md` (IIH-internal, not published) archives the 2025 Postgres/Supabase hardening pass; it does not describe the current system. `docs/CONVEX_MIGRATION.md` (IIH-internal, not published) logs the migration and every defect it found — read it to understand why a Convex-side check exists.
