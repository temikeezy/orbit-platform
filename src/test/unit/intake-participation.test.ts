import { describe, it, expect } from 'vitest';
import { validateApplication } from '../../../convex/lib/intake';

/**
 * How participation mode is decided at intake.
 *
 * The form never asks. It is derived from the stated location — Ilorin means a
 * weekly day on site, anywhere else means virtual — which is why these tests
 * exercise `location` rather than any mode field.
 *
 * SIWES IS THE EXCEPTION, and it is the whole reason this file exists. A SIWES
 * placement runs virtually wherever the student lives, so an Ilorin address no
 * longer buys a Monday on site. Getting this wrong is not a display bug: the
 * acceptance email tells the applicant, in as many words, that they attend the
 * Hub on Mondays, and 50 SIWES students were on course to be told exactly that.
 */
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

describe('participation mode at intake', () => {
  it('keeps a SIWES applicant virtual even in Ilorin', () => {
    const row = submit({ programme_type: 'siwes', location: 'Ilorin, Kwara State' });
    expect(row.preferredParticipationMode).toBe('virtual');
    // No on-site day, or the roster would still expect them at the Hub.
    expect(row.availablePhysicalDay).toBeUndefined();
  });

  it('still puts an Ilorin applicant on any other programme in person', () => {
    for (const programme of ['internship', 'nysc', 'volunteer']) {
      const row = submit({ programme_type: programme, location: 'Ilorin, Kwara State' });
      expect(row.preferredParticipationMode).toBe('hybrid');
      expect(row.availablePhysicalDay).toBe(1);
    }
  });

  it('keeps everyone outside Ilorin virtual, whatever the programme', () => {
    for (const programme of ['siwes', 'internship', 'nysc', 'volunteer']) {
      const row = submit({ programme_type: programme, location: 'Lagos' });
      expect(row.preferredParticipationMode).toBe('virtual');
      expect(row.availablePhysicalDay).toBeUndefined();
    }
  });
});
