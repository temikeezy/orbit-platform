/**
 * Bounds for AUTHENTICATED writes.
 *
 * Deliberately NOT shared with lib/intake.ts, and the difference is the whole
 * point of a separate file. `intake.ts` TRUNCATES: a member of the public
 * filling in an application cannot be walked through a field-by-field error
 * round-trip cheaply, and a shortened address is better than a refused
 * application. Here, a signed-in member typing a logbook entry is on the other
 * side of that trade — silently slicing the tail off work they believe they have
 * saved is the worse outcome by a wide margin. So this REJECTS.
 *
 * If you find yourself reconciling the two, don't. They disagree on purpose.
 *
 * Every function in Convex already declares `v.string()` on its arguments, which
 * checks the TYPE and nothing else: length, format and content were entirely
 * unbounded on every authenticated write in the system. Convex's own document
 * limit is 1MiB, so this was never a crash vector — it is a cost, feed-rendering
 * and outbound-email vector, since message content is interpolated into mail
 * that ORBIT sends from its own domain.
 */

export class InputError extends Error {}

/**
 * The bounds, in one table.
 *
 * The same shape as LIMITS in lib/rateLimit.ts, and for the same reason: a
 * number that appears inline in one mutation is a magic number, and a number
 * that appears in a named table with a comment is a policy someone can argue
 * with.
 *
 * Every value here was set AFTER measuring the longest value of that field in
 * production, which is the step that matters. A bound below an existing value
 * does not stop bad input — it makes an honest row that is already saved
 * impossible to edit, and the person who hits it has done nothing wrong and
 * cannot fix it. The longest post in production is 2,061 characters; a 2,000
 * bound would have been a bug shipped as a security fix.
 */
export const FIELD = {
  fullName: 120,
  bio: 2_000,
  location: 160,
  socialHandle: 80,

  postContent: 10_000,
  postReply: 5_000,

  message: 10_000,
  chatMessage: 2_000,

  taskTitle: 200,
  taskDescription: 10_000,
  submissionText: 20_000,

  logTitle: 200,
  logSection: 5_000,
  evidenceLink: 500,
  evidenceLinkCount: 20,

  url: 500,
} as const;

/** Trimmed, non-empty, and no longer than `max`. */
export function text(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean) throw new InputError(`${label} is required.`);
  if (clean.length > max) {
    throw new InputError(`${label} must be ${max.toLocaleString()} characters or fewer.`);
  }
  return clean;
}

/**
 * Absent stays absent; blank stays BLANK.
 *
 * An earlier version of this mapped `''` to `undefined`, reasoning that
 * logbook.saveDailyLog strips undefined keys before patching and a coerced blank
 * would wipe a field the member had not touched. That reasoning was wrong in a
 * way worth recording, because it is the tempting mistake: the logbook form
 * already sends `|| undefined` for every optional field, so it was never at
 * risk — while EditProfilePage sends every field on every save, so mapping blank
 * to absent made it IMPOSSIBLE TO CLEAR A BIO. The save reported success and
 * changed nothing.
 *
 * "Not supplied" and "supplied as empty" are different intentions and only the
 * caller knows which it meant. This preserves both and decides neither.
 */
export function optionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (clean.length > max) {
    throw new InputError(`${label} must be ${max.toLocaleString()} characters or fewer.`);
  }
  return clean;
}

/**
 * A user-supplied string that will be rendered as a link IF it looks like one.
 *
 * Deliberately weaker than `httpUrl`, for fields that already hold years of
 * free text. Daily-log evidence links are typed into a box that has never
 * validated anything, so real rows contain `mailto:` addresses, bare filenames
 * and "the shared Drive folder". Running `httpUrl` over them means an intern
 * editing a log for an unrelated reason cannot save it, and cannot see why.
 *
 * So: bound the length and refuse the schemes that execute, but let ordinary
 * text through. The client decides whether to linkify — `safeExternalUrl` in
 * src/lib/utils/url.ts renders anything that is not a real http(s) URL as plain
 * text, which is the correct place for that judgement. What must never happen is
 * a `javascript:` value reaching the database, and that is what this stops.
 */
export function linkOrText(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean) throw new InputError(`${label} is required.`);
  if (clean.length > max) {
    throw new InputError(`${label} must be ${max} characters or fewer.`);
  }

  if (clean.startsWith('//') || clean.startsWith('/\\') || clean.startsWith('\\')) {
    throw new InputError(`${label} must not start with a slash pair.`);
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  if (scheme && !['http', 'https', 'mailto', 'ftp', 'ftps'].includes(scheme[1].toLowerCase())) {
    throw new InputError(`${label} uses a link type that is not allowed.`);
  }

  return clean;
}

/**
 * A whole number inside a range.
 *
 * `v.number()` accepts NaN, Infinity, -5 and 1e9 alike, so a validator alone is
 * not a bound. Rejects rather than clamps, per this file's contract: the caller
 * is signed in and can be told what was wrong.
 */
export function wholeNumber(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new InputError(`${label} must be a whole number.`);
  }
  if (value < min || value > max) {
    throw new InputError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * What a task may be worth, and what a submission may score.
 *
 * 20 is not arbitrary — `LEVELS_SYSTEM.md` states "max 20 points per task", and
 * the level thresholds are built on that assumption. Three callers disagreed
 * about it: the full-page task form enforced 5-20, the admin modal enforced
 * only "> 0", and the MCP tool defaulted to 10 with no ceiling at all. Nothing
 * server-side enforced anything, so the loosest caller set the real policy —
 * and with the agent drafting tasks over MCP, the loosest caller became the
 * main one.
 *
 * The floor is 1 rather than 5 deliberately: 5 is the form's house style, not a
 * rule, and rejecting a legitimate 2-point task is a worse failure than
 * allowing one.
 */
export const TASK_POINTS = { min: 1, max: 20 } as const;

/** The submission types every renderer in the app knows how to display. */
export const SUBMISSION_TYPES = ['text', 'link', 'file'] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];

/** Membership of a closed set, with the set named in the error so it is actionable. */
export function oneOf<T extends string>(value: string, label: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InputError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * YYYY-MM-DD, and a real date.
 *
 * The shape check alone accepts 2026-02-31 and 2026-13-01, which then sort
 * correctly as strings and are wrong as dates — the failure surfaces weeks later
 * in a report nobody connects to the form that accepted it.
 */
export function isoDate(value: string, label: string): string {
  const clean = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new InputError(`${label} must be a date in YYYY-MM-DD form.`);
  }
  const parsed = new Date(`${clean}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
    throw new InputError(`${label} is not a real date.`);
  }
  return clean;
}

/**
 * An http(s) URL, or a bare host upgraded to https.
 *
 * This is the server half of the stored-XSS fix in src/lib/utils/url.ts, and it
 * has to agree with it: these values are rendered as hrefs in someone else's
 * browser — an applicant's portfolio link read by an admin, an intern's evidence
 * link read by their supervisor — and React renders `javascript:` hrefs rather
 * than blocking them.
 *
 * Rejecting `//host` and `/\host` matters as much as rejecting `javascript:`:
 * both parse as valid https URLs against our own origin and would otherwise pass
 * every check here while pointing somewhere else entirely.
 */
export function httpUrl(value: string, label: string, max: number = FIELD.url): string {
  const clean = value.trim();
  if (!clean) throw new InputError(`${label} is required.`);
  if (clean.length > max) {
    throw new InputError(`${label} must be ${max} characters or fewer.`);
  }

  if (clean.startsWith('//') || clean.startsWith('/\\') || clean.startsWith('\\')) {
    throw new InputError(`${label} must be a full web address.`);
  }

  // Matches the RFC 3986 scheme shape rather than looking for `://`. Testing for
  // slashes would treat `javascript:alert(1)` as a bare host and prefix it into
  // `https://javascript:alert(1)`, which parses, has a hostname, and would be
  // handed back as valid — the check laundering the payload.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(clean);

  /**
   * A bare host must actually LOOK like one before it is upgraded.
   *
   * Without this, `new URL('https://' + x)` accepts almost anything: `N/A`
   * becomes `https://n/A` and `notes` becomes `https://notes/`, both of which
   * parse, have a hostname, and are stored as valid URLs. The guard then renders
   * them as real links that go nowhere — free text laundered into an anchor,
   * which is worse than refusing it, because it looks deliberate.
   *
   * A dot with something either side, and no spaces. Not a hostname grammar;
   * enough to tell "example.com/x" from "N/A".
   */
  if (!hasScheme && !/^[^\s/]+\.[^\s/.]{2,}(\/|$|\?|#)/.test(clean)) {
    throw new InputError(`${label} must be a full web address.`);
  }

  const candidate = hasScheme ? clean : `https://${clean}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InputError(`${label} must be a valid web address.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InputError(`${label} must start with http:// or https://.`);
  }
  if (!parsed.hostname) throw new InputError(`${label} must include a site address.`);

  return parsed.toString();
}

export function optionalHttpUrl(
  value: string | undefined,
  label: string,
  max: number = FIELD.url,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) return undefined;
  return httpUrl(value, label, max);
}

/** A bounded array, with a validator applied to each item. */
export function list<T>(
  values: readonly unknown[] | undefined,
  label: string,
  opts: { max: number; each: (value: string, label: string) => T },
): T[] {
  if (!values) return [];
  if (values.length > opts.max) {
    throw new InputError(`${label} is limited to ${opts.max} entries.`);
  }
  return values.map((value, i) => {
    if (typeof value !== 'string') {
      throw new InputError(`${label} entry ${i + 1} is not valid.`);
    }
    return opts.each(value, `${label} entry ${i + 1}`);
  });
}

/**
 * The self-service social links blob.
 *
 * `socialLinks: v.optional(v.any())` on a mutation any member can call is an
 * arbitrary-JSON store returned to every reader by publicUser(). It is the third
 * instance of a defect class this codebase has already fixed twice, with the
 * comments to prove it — posts.metadata and dailyLogs.evidenceLinks. Unknown
 * keys are dropped rather than rejected, so an older client sending an extra
 * field does not start failing.
 *
 * `linkedin` goes through httpUrl because it is the one rendered as a raw href;
 * twitter and github are interpolated into a fixed https:// prefix by the
 * profile page and are handles, not URLs.
 */
export function socialLinks(value: unknown): { twitter?: string; linkedin?: string; github?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('Social links are not in a recognised format.');
  }

  const raw = value as Record<string, unknown>;
  const out: { twitter?: string; linkedin?: string; github?: string } = {};

  for (const key of ['twitter', 'github'] as const) {
    const v = raw[key];
    if (typeof v === 'string') {
      const clean = optionalText(v.replace(/^@/, ''), `${key} handle`, FIELD.socialHandle);
      if (clean) out[key] = clean;
    }
  }

  if (typeof raw.linkedin === 'string') {
    const clean = optionalHttpUrl(raw.linkedin, 'LinkedIn URL');
    if (clean) out.linkedin = clean;
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Bridges throwing validators to the `{ success, error }` convention the
 * mutations here already use.
 *
 * Rethrows anything that is not an InputError. That is the important line: a
 * genuine bug inside a validation block must not be reported to a member as
 * though they had mistyped something, because then it is invisible — the person
 * assumes they were at fault and nobody ever hears about it.
 */
export function validate<T>(build: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: build() };
  } catch (err) {
    if (err instanceof InputError) return { ok: false, error: err.message };
    throw err;
  }
}
