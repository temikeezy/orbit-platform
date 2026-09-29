/**
 * The SIWES acceptance letter, as data.
 *
 * A university's Industrial Liaison Unit will not accept a placement until it
 * holds a letter on the host organisation's headed paper saying the student was
 * taken. Until this existed that letter was typed by hand for every accepted
 * applicant, from a Word file, with the name and the department pasted in — so
 * the wording drifted between letters and the wrong student's name reached a
 * university at least as often as anyone admits.
 *
 * The wording here is `docs/templates/SIWES-acceptance-letter-template.docx`,
 * VERBATIM. Only that template's placeholders vary: `{{LETTER_DATE}}`,
 * `{{STUDENT_NAME}}`, `{{STUDENT_LEVEL}}`, `{{DEPARTMENT}}`, `{{UNIVERSITY}}`
 * and `{{HR_SIGNATORY_NAME}}`, plus the pronouns the template leaves as
 * "He/She" and "his/her". Nothing else in `buildAcceptanceLetter` should become
 * configurable without a new signed template to copy from — an acceptance
 * letter is a commitment made in the organisation's name, and "someone edited
 * the template" is not a defence anyone wants to make.
 *
 * PURE, and in lib/ so three callers share one copy: the Convex query that
 * gates it, the printable view that renders it, and the unit test that pins the
 * wording. Same reason as lib/applicationStatus.ts — a rule that lives in one
 * function cannot be enforced in two places and forgotten in the third.
 */

import { DEFAULT_ORG_NAME, orgName } from './org';

/** The setting holding who signs. */
export const ACCEPTANCE_LETTER_SETTING = 'acceptance_letter_config';

/**
 * The accepting organisation. A CONSTANT, deliberately.
 *
 * It was briefly an admin-editable setting, which was a mistake: it is not one
 * of the template's placeholders, it appears in two body sentences as well as
 * over the signature, and it names the legal entity undertaking to host the
 * student. An acceptance letter whose organisation name was edited is a
 * different commitment by a different body, and no screen should be able to
 * make one. Changing it needs a new signed template, not a text input.
 */
/** Default operator name; the live value is orgName() (ORBIT_ORG_NAME). */
export const ORGANISATION_NAME = DEFAULT_ORG_NAME;

export interface AcceptanceLetterConfig {
  /**
   * The named human who signs, RESOLVED.
   *
   * The stored setting holds a staff account id rather than a typed name — see
   * `acceptanceLetters.config`, which looks it up. So a signatory who changes
   * their name in ORBIT changes it on every letter printed afterwards, and a
   * name cannot drift from the person it belongs to because nobody retypes it.
   * Empty until a super admin chooses someone.
   */
  signatoryName: string;
  /**
   * Their job title, under the signature.
   *
   * Configurable where the organisation name is not: the template's "HR
   * Associate" describes whoever currently signs, and a successor with a
   * different title would otherwise be misdescribed on every letter. It appears
   * only in the signature block — it rewrites no sentence.
   */
  signatoryTitle: string;
}

export const DEFAULT_LETTER_CONFIG: AcceptanceLetterConfig = {
  signatoryName: '',
  signatoryTitle: 'HR Associate',
};

/**
 * Reads the stored setting, tolerating anything.
 *
 * A malformed or half-written setting must not stop a letter being produced —
 * the missing value is reported to the admin by `missing` below and the rest of
 * the letter still renders, which is more useful than an error page on the
 * afternoon a cohort's letters are due.
 */
export function readLetterConfig(raw: unknown): AcceptanceLetterConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_LETTER_CONFIG };

  const value = raw as Record<string, unknown>;
  const text = (key: keyof AcceptanceLetterConfig): string => {
    const candidate = value[key];
    return typeof candidate === 'string' && candidate.trim() !== ''
      ? candidate.trim()
      : DEFAULT_LETTER_CONFIG[key];
  };

  return {
    signatoryName: text('signatoryName'),
    signatoryTitle: text('signatoryTitle'),
  };
}

/**
 * What a letter needs from a candidate.
 *
 * Deliberately not the application row: the same letter has to be producible
 * from an intern record once an application has been converted, and a shape
 * with four fields can be satisfied by both without either table's naming
 * leaking into the wording.
 */
export interface LetterCandidate {
  fullName: string;
  /** Free text as typed: "300 level", "400", "Year 3". */
  levelOrYear?: string | null;
  /** The academic department — the intake form calls it "Course or department". */
  department?: string | null;
  university?: string | null;
  /**
   * Drives the letter's pronouns. Optional, and expected to be absent often.
   *
   * The intake form only began asking once this feature did; every applicant
   * taken before that has none, and the form lets anyone decline to answer.
   */
  gender?: string | null;
}

/** The two pronoun slots the template leaves open. */
export interface LetterPronouns {
  /** Sentence-initial in the template: "He/She will undergo…". */
  subject: string;
  /** "…his/her industrial training", "…his/her professional development". */
  possessive: string;
}

/**
 * Pronouns for the letter, falling back to the template's own slashed form.
 *
 * The fallback is not a degraded letter — "He/She will undergo his/her
 * industrial training" is exactly what the approved template says, so a letter
 * carrying it is the template as written rather than one missing a value. That
 * is why an absent gender is NOT reported in `missing` below: flagging it would
 * put a warning on every applicant who applied before the field existed, and
 * bury the omissions that genuinely stop a letter reading as English.
 *
 * Anything unrecognised takes the fallback too. A letter that guesses wrong
 * about a student is worse than one that offers both, and it cannot be recalled
 * from the university that filed it.
 */
export function pronounsFor(gender?: string | null): LetterPronouns {
  switch (gender?.trim().toLowerCase()) {
    case 'male':
    case 'm':
      return { subject: 'He', possessive: 'his' };
    case 'female':
    case 'f':
      return { subject: 'She', possessive: 'her' };
    default:
      return { subject: 'He/She', possessive: 'his/her' };
  }
}

export interface AcceptanceLetter {
  dateLine: string;
  /** The Industrial Liaison Unit block, university included. */
  recipientLines: string[];
  subject: string;
  salutation: string;
  paragraphs: string[];
  signatory: { name: string; title: string; organisation: string };
  /**
   * Placeholders that could not be filled, in words.
   *
   * The letter still renders without them — the clause is dropped rather than
   * printed as an empty gap — so this is the ONLY signal that something is
   * absent. Show it before anyone prints; a letter that quietly omits the
   * department reads as complete and is not.
   */
  missing: string[];
}

const ORDINALS: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };

/** "Monday 7th July 2026" — the sample's format, which is not a locale option. */
export function formatLetterDate(date: Date): string {
  const day = date.getDate();
  // 11th, 12th, 13th are the exceptions the last-digit rule gets wrong.
  const suffix = day >= 11 && day <= 13 ? 'th' : (ORDINALS[day % 10] ?? 'th');

  const weekday = date.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = date.toLocaleDateString('en-GB', { month: 'long' });

  return `${weekday} ${day}${suffix} ${month} ${date.getFullYear()}`;
}

/**
 * "300 level", "300", "300L" -> "300-level", to match the sample's "400-level".
 *
 * Anything that is not a bare level number is passed through untouched. A
 * student who wrote "Year 3" or "HND II" gets "a Year 3 student", which reads
 * correctly; forcing those into "3-level" would state something false about
 * them on a letter their university keeps.
 */
export function formatLevel(raw?: string | null): string {
  const value = raw?.trim();
  if (!value) return '';

  const bare = value.match(/^(\d{3,4})\s*(?:l|lvl|level)?$/i);
  if (bare) return `${bare[1]}-level`;

  const hyphenated = value.match(/^(\d{3,4})\s*-\s*level$/i);
  if (hyphenated) return `${hyphenated[1]}-level`;

  return value;
}

/**
 * Strips a leading "Department of" / "Faculty of", so the sentence does not say
 * it twice.
 *
 * The intake field is labelled "Course or department" and applicants answer it
 * both ways — roughly one in six types the full "Department of Computer
 * Science", which the template's own "of the Department of X" then doubles.
 * "Faculty of X" arrives the same way and doubles just as badly.
 */
export function formatDepartment(raw?: string | null): string {
  const value = raw?.trim();
  if (!value) return '';
  return value.replace(/^(?:the\s+)?(?:department|faculty)\s+of\s+/i, '').trim();
}

/**
 * The letter, assembled from the template.
 *
 * The second paragraph NAMES the student rather than saying "accepted him/her":
 * `{{STUDENT_NAME}}` sits in that slot in the template, which the directive
 * makes authoritative.
 *
 * The signed sample DIFFERS here — it reads "has accepted him", because it was
 * written for one student before the wording was generalised into a template.
 * That is the one place the two documents disagree, and the template wins. Do
 * not "restore" the pronoun by reading the sample and assuming the template
 * drifted from it.
 */
export function buildAcceptanceLetter(
  candidate: LetterCandidate,
  config: AcceptanceLetterConfig,
  letterDate: Date,
  /** Browser callers pass the build-time name; the server reads ORBIT_ORG_NAME. */
  organisation: string = orgName(),
): AcceptanceLetter {
  const name = candidate.fullName.trim();
  const level = formatLevel(candidate.levelOrYear);
  const department = formatDepartment(candidate.department);
  const university = candidate.university?.trim() ?? '';
  const org = organisation;
  const pronouns = pronounsFor(candidate.gender);

  const missing: string[] = [];
  if (!name) missing.push('student name');
  if (!level) missing.push('level');
  if (!department) missing.push('department');
  if (!university) missing.push('university');
  if (!config.signatoryName) missing.push('HR signatory');

  // Each clause is dropped rather than left as a gap, so a record missing one
  // field still produces a sentence that reads as English.
  const studentClause = [
    `a ${level ? `${level} ` : ''}student`,
    department ? ` of the Department of ${department}` : '',
    university ? `, ${university}` : '',
  ].join('');

  return {
    dateLine: formatLetterDate(letterDate),
    recipientLines: [
      'The Industrial Liaison Officer',
      'Industrial Liaison Unit',
      university,
    ].filter(Boolean),
    subject: `RE: ACCEPTANCE OF ${name.toUpperCase()} FOR SIWES PLACEMENT`,
    salutation: 'Dear Sir/Madam,',
    paragraphs: [
      `We acknowledge receipt of your request for the placement of ${name}, ${studentClause}.`,
      `We are pleased to inform you that ${org} has accepted ${name} for the Student Industrial Work Experience Scheme (SIWES). ${pronouns.subject} will undergo ${pronouns.possessive} industrial training at our organization for the approved duration of the programme.`,
      `Thank you for considering ${org} as a training partner. We look forward to supporting ${pronouns.possessive} professional development.`,
    ],
    signatory: {
      name: config.signatoryName,
      title: config.signatoryTitle,
      organisation: org,
    },
    missing,
  };
}

/**
 * The complimentary close, kept here with the rest of the wording.
 *
 * Not a field on `AcceptanceLetter` because it never varies with the candidate —
 * but it is still wording from the signed sample, and a renderer that hardcodes
 * its own is a second place the letter can be changed.
 */
export const LETTER_CLOSING = 'Yours faithfully,';

/** `YYYY-MM-DD`, for an `<input type="date">` value. */
export function letterDateInputValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Reads an `<input type="date">` value back as a LOCAL date.
 *
 * `new Date('2026-07-07')` parses as UTC midnight, which in any negative offset
 * is the 6th locally — so a letter would carry the day before the one the admin
 * picked. Building from parts keeps the date the date. Returns null rather than
 * an Invalid Date, so a half-typed input cannot reach `formatLetterDate`.
 */
export function parseLetterDateInput(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  // Rejects 2026-02-31, which the constructor rolls forward into March.
  return date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) ? date : null;
}

// A `acceptanceLetterFileName` helper lived here and was never called. The
// print view names a saved PDF by setting `document.title`, which is the only
// mechanism a browser's "Save as PDF" actually honours — a slug we compute
// ourselves cannot reach the file picker. Deleted rather than kept "in case",
// since a second naming scheme that never runs is a thing to keep in sync for
// no return.
