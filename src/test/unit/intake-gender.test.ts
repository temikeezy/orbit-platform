import { describe, it, expect } from 'vitest';
import { validateApplication } from '../../../convex/lib/intake';

/**
 * Gender, as the public application form supplies it.
 *
 * This is the only enumerated field in an intake made almost entirely of free
 * text, and it is the only one that drops an answer instead of truncating it —
 * see `genderField` in `convex/lib/intake.ts` for why. The value's single
 * consumer is the SIWES acceptance letter, which prints it as a pronoun on a
 * document a university keeps, so what reaches the database matters more here
 * than the length of the string that was typed.
 */

/** A one-pixel PNG, so the payload clears the passport-photo check. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

function submit(overrides: Record<string, unknown> = {}) {
  return validateApplication({
    programme_type: 'siwes',
    full_name: 'Ibrahim Yusuf',
    email: 'ibrahim@example.com',
    phone: '08030000000',
    location: 'Ilorin, Kwara State',
    institution_name: 'University of Ilorin',
    course_of_study: 'Computer Science',
    matric_number: '19/30GC001',
    level_or_year: '400 level',
    siwes_start_date: '2026-09-01',
    siwes_end_date: '2027-02-28',
    emergency_contact_name: 'Halima Yusuf',
    emergency_contact_phone: '08040000000',
    consent_logbook: true,
    consent_data_use: true,
    passport_photo: { name: 'p.png', type: 'image/png', size: 70, data_url: PNG },
    siwes_letter: { name: 'l.pdf', type: 'application/pdf', size: 10, data_url: PDF },
    ...overrides,
  }).row;
}

describe('intake gender', () => {
  it('keeps the two answers the letter can act on', () => {
    expect(submit({ gender: 'male' }).gender).toBe('male');
    expect(submit({ gender: 'female' }).gender).toBe('female');
  });

  it('accepts however the form cased it', () => {
    expect(submit({ gender: 'Male' }).gender).toBe('male');
    expect(submit({ gender: ' FEMALE ' }).gender).toBe('female');
  });

  /**
   * Declining is a first-class answer, and it has to be indistinguishable from
   * not answering: both leave the letter on the approved template's own
   * "He/She … his/her" rather than on a guess.
   */
  it('stores nothing when the applicant declines to say', () => {
    expect(submit({ gender: '' }).gender).toBeUndefined();
    expect(submit({}).gender).toBeUndefined();
  });

  /**
   * The one field here that drops rather than truncates. Everything else in
   * this form is prose a human wrote and a shortened version is still theirs;
   * this is an enumeration whose only use is choosing a word to print, so an
   * answer outside the set has to become absent rather than be stored and
   * later read as if ORBIT had put it there.
   */
  it('drops anything outside the set instead of storing it', () => {
    expect(submit({ gender: 'other' }).gender).toBeUndefined();
    expect(submit({ gender: 'prefer not to say' }).gender).toBeUndefined();
    expect(submit({ gender: '<script>alert(1)</script>' }).gender).toBeUndefined();
    expect(submit({ gender: 42 }).gender).toBeUndefined();
  });

  it('does not make the application depend on it', () => {
    expect(submit({}).fullName).toBe('Ibrahim Yusuf');
  });
});
