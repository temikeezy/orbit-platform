/**
 * Validation for the public application form.
 *
 * Lifted from `netlify/functions/orbit-application.mts` and kept deliberately
 * separate from the httpAction, because this is the only part of the intake that
 * is pure — given a payload it either returns a clean row or throws a message
 * meant for the applicant to read. That makes it the part worth reading closely,
 * since it is the only validation standing between the open internet and a
 * database row.
 */


const PROGRAMME_TYPES = new Set(['siwes', 'internship', 'nysc', 'volunteer']);

import { TRACK_SLUGS } from './tracks';

export const PASSPORT_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const SIWES_LETTER_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const PASSPORT_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const SIWES_LETTER_MAX_BYTES = 5 * 1024 * 1024;

export class IntakeError extends Error {}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Gender, narrowed to the values the acceptance letter can act on.
 *
 * The only field here that REJECTS rather than truncates, and it does it
 * silently: this is an enumeration, not prose, so an answer outside the set
 * becomes absent instead of being stored as whatever the internet typed. The
 * form's own "Prefer not to say" has to land in the same place as no answer at
 * all, and `pronounsFor` in lib/acceptanceLetter.ts treats both as the
 * template's "He/She". Nothing downstream should read a gender ORBIT did not
 * put here itself.
 */
function genderField(value: unknown): 'male' | 'female' | undefined {
  switch (text(value, 20).toLowerCase()) {
    case 'male':
      return 'male';
    case 'female':
      return 'female';
    default:
      return undefined;
  }
}

function required(value: unknown, label: string, max = 500): string {
  const clean = text(value, max);
  if (!clean) throw new IntakeError(`${label} is required`);
  return clean;
}

function emailField(value: unknown, label: string): string {
  const clean = required(value, label, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new IntakeError(`${label} is invalid`);
  return clean;
}

/**
 * The applicant's portfolio link.
 *
 * This was length-checked and nothing else, and it is the single most exposed
 * untrusted value in ORBIT: written by anyone on the internet through the open
 * application form, then rendered as an `href` on the admin review screen. React
 * renders `javascript:` hrefs rather than blocking them, and the session token
 * lives in localStorage — so one admin clicking one applicant's link was a full
 * account takeover, by design of the attacker and by accident of ours.
 *
 * DROPPED rather than refused, which is this file's convention and the right one
 * here: a whole application must not be rejected over an optional field, and an
 * admin who cannot see a portfolio link will ask. Bare hosts are upgraded, since
 * "myportfolio.com" typed without a scheme is what most people submit.
 */
function portfolioLink(value: unknown): string | undefined {
  const clean = text(value, 500);
  if (!clean) return undefined;

  if (clean.startsWith('//') || clean.startsWith('/\\') || clean.startsWith('\\')) return undefined;

  // The RFC 3986 scheme shape, not `://` — otherwise `javascript:alert(1)` is
  // read as a bare host and prefixed into something that parses as valid https.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(clean) ? clean : `https://${clean}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!url.hostname) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function optionalDate(value: unknown): string | undefined {
  const clean = text(value, 10);
  if (!clean) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new IntakeError('Date format must be YYYY-MM-DD');
  return clean;
}

/**
 * Ilorin-based applicants default to hybrid with a Monday on site; everyone else
 * is virtual. Derived from the stated location rather than asked, exactly as
 * before — the form never offered the choice.
 *
 * SIWES IS ALWAYS VIRTUAL, wherever the student lives. The scheme runs to a
 * university's calendar and its students are placed from institutions all over
 * the country; committing an Ilorin-based SIWES student to a weekly day on site
 * is a commitment the Hub has decided not to make. Location still decides the
 * mode for every other programme.
 */
function participationPolicy(location: string, programmeType?: string) {
  const isIlorin = /\bilorin\b/i.test(location);
  const onSite = isIlorin && programmeType !== 'siwes';
  return {
    preferredParticipationMode: onSite ? 'hybrid' : 'virtual',
    availablePhysicalDay: onSite ? 1 : undefined,
  };
}

function trackInterests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => text(v, 80)).filter((v) => TRACK_SLUGS.has(v)).slice(0, 3);
}

export interface DecodedFile {
  bytes: Uint8Array;
  name?: string;
  mimeType: string;
  size: number;
}

/**
 * Decodes one `data:` URL from the payload.
 *
 * The declared mime type must match the one inside the data URL — otherwise a
 * caller can label a PDF as `image/png`, pass the allow-list, and have it stored
 * and later served with an attacker-chosen content type.
 */
function decodeFile(
  value: unknown,
  options: { label: string; required: boolean; allowedTypes: Set<string>; maxBytes: number; allowedDescription: string },
): DecodedFile | undefined {
  if (!value || typeof value !== 'object') {
    if (options.required) throw new IntakeError(`${options.label} is required`);
    return undefined;
  }

  const file = value as Record<string, unknown>;
  const name = text(file.name, 220) || undefined;
  const mimeType = text(file.type, 80).toLowerCase();

  if (!options.allowedTypes.has(mimeType)) {
    throw new IntakeError(`${options.label} must be ${options.allowedDescription}`);
  }

  const dataUrl = text(file.data_url, options.maxBytes * 2);
  const match = dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[1].toLowerCase() !== mimeType) {
    throw new IntakeError(`${options.label} data is invalid`);
  }

  // atob rather than Buffer: this runs in Convex's V8 isolate, not Node.
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  if (!bytes.length) throw new IntakeError(`${options.label} is empty`);
  if (bytes.length > options.maxBytes) {
    throw new IntakeError(
      `${options.label} must be ${Math.floor(options.maxBytes / (1024 * 1024))} MB or smaller`,
    );
  }

  /**
   * The BYTES must match the declared type.
   *
   * Until now the only check was that the data-url prefix agreed with the
   * `type` field — both supplied by the same caller, so anything at all could
   * be stored as `image/png` and later served with that content type to a
   * reviewer. The browser's `accept` attribute is a convenience, not a
   * boundary; this is the boundary.
   */
  if (!looksLike(bytes, mimeType)) {
    throw new IntakeError(`${options.label} is not a valid ${mimeType.split('/')[1]} file`);
  }

  return { bytes, name, mimeType, size: bytes.length };
}

/** Magic numbers for the four types intake accepts. */
function looksLike(bytes: Uint8Array, mimeType: string): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);

  switch (mimeType) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/webp':
      // 'RIFF' .... 'WEBP' — the size field sits between the two.
      return starts(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46);
    default:
      // An unlisted type never reaches here — allowedTypes is checked above —
      // but failing closed is the right default if that ever changes.
      return false;
  }
}

export interface ValidatedApplication {
  row: Record<string, unknown>;
  photo: DecodedFile;
  letter?: DecodedFile;
}

/** Throws IntakeError with a message intended for the applicant. */
export function validateApplication(payload: Record<string, unknown>): ValidatedApplication {
  const programmeType = text(payload.programme_type, 40) || 'siwes';
  if (!PROGRAMME_TYPES.has(programmeType)) throw new IntakeError('Programme type is invalid');

  const consentLogbook = payload.consent_logbook === true;
  const consentDataUse = payload.consent_data_use === true;
  if (!consentLogbook || !consentDataUse) {
    throw new IntakeError('SIWES/logbook and data-use consent are required');
  }

  const siwesStartDate = optionalDate(payload.siwes_start_date);
  const siwesEndDate = optionalDate(payload.siwes_end_date);
  const location = required(payload.location, 'Current location', 160);
  const policy = participationPolicy(location, programmeType);

  const photo = decodeFile(payload.passport_photo, {
    label: 'Passport photo',
    required: true,
    allowedTypes: PASSPORT_PHOTO_TYPES,
    maxBytes: PASSPORT_PHOTO_MAX_BYTES,
    allowedDescription: 'a JPG, PNG, or WebP image',
  });
  if (!photo) throw new IntakeError('Passport photo is required');

  const letter = decodeFile(payload.siwes_letter, {
    label: 'SIWES form or letter',
    required: programmeType === 'siwes',
    allowedTypes: SIWES_LETTER_TYPES,
    maxBytes: SIWES_LETTER_MAX_BYTES,
    allowedDescription: 'a PDF, JPG, PNG, or WebP file',
  });

  if (programmeType === 'siwes') {
    required(payload.institution_name, 'Institution name', 180);
    required(payload.course_of_study, 'Course of study', 180);
    required(payload.matric_number, 'Matriculation number', 80);
    if (!siwesStartDate || !siwesEndDate) {
      throw new IntakeError('SIWES start and end dates are required');
    }
    if (siwesEndDate < siwesStartDate) {
      // String compare, not Date: both are already validated YYYY-MM-DD, which
      // sorts correctly as text. `new Date(...)` on a bare date string is parsed
      // as UTC midnight and drags a timezone into a comparison that has none.
      throw new IntakeError('SIWES end date cannot be before start date');
    }
  }

  return {
    photo,
    letter,
    row: {
      programmeType,
      status: 'submitted',
      fullName: required(payload.full_name, 'Full name', 180),
      email: emailField(payload.email, 'Email'),
      phone: required(payload.phone, 'Phone number', 60),
      gender: genderField(payload.gender),
      location,
      institutionName: text(payload.institution_name, 180) || undefined,
      faculty: text(payload.faculty, 180) || undefined,
      courseOfStudy: text(payload.course_of_study, 180) || undefined,
      matricNumber: text(payload.matric_number, 80) || undefined,
      levelOrYear: text(payload.level_or_year, 80) || undefined,
      siwesStartDate,
      siwesEndDate,
      institutionSupervisorName: text(payload.institution_supervisor_name, 180) || undefined,
      institutionSupervisorEmail: text(payload.institution_supervisor_email, 254) || undefined,
      institutionSupervisorPhone: text(payload.institution_supervisor_phone, 60) || undefined,
      preferredParticipationMode: policy.preferredParticipationMode,
      availablePhysicalDay: policy.availablePhysicalDay,
      trackInterests: trackInterests(payload.track_interests),
      skillsSummary: text(payload.skills_summary, 1500) || undefined,
      motivation: text(payload.motivation, 1800) || undefined,
      portfolioUrl: portfolioLink(payload.portfolio_url),
      siwesLetterFileName: letter?.name,
      emergencyContactName: required(payload.emergency_contact_name, 'Emergency contact name', 180),
      emergencyContactPhone: required(payload.emergency_contact_phone, 'Emergency contact phone', 60),
      consentLogbook,
      consentDataUse,
    },
  };
}

/** Honeypot. A real applicant never fills this in; a bot fills in everything. */
export function isHoneypotTripped(payload: Record<string, unknown>): boolean {
  return Boolean(text(payload.website, 100));
}
