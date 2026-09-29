import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LETTER_CONFIG,
  LETTER_CLOSING,
  ORGANISATION_NAME,
  buildAcceptanceLetter,
  formatDepartment,
  formatLetterDate,
  formatLevel,
  letterDateInputValue,
  parseLetterDateInput,
  pronounsFor,
  readLetterConfig,
} from '../../../convex/lib/acceptanceLetter';
import { renderAcceptanceLetterPdf } from '../../../convex/lib/letterPdf';
import { SIGNATURE_PNG_BASE64, signatureBelongsTo } from '../../../convex/lib/signature';

/**
 * The acceptance letter's wording, pinned.
 *
 * This is the one test in the suite whose job is to FAIL when someone improves
 * the prose. The letter is a commitment issued in IIH's name and signed by a
 * named person; the template it copies —
 * `docs/templates/SIWES-acceptance-letter-template.docx` — was signed off once,
 * and a wording change that reaches a university unnoticed cannot be recalled.
 * So the three paragraphs are asserted verbatim rather than by keyword: if a
 * change to them is genuinely wanted, it should require editing this file and
 * saying so.
 *
 * The last block here rebuilds the signed sample
 * (`SIWES-acceptance-letter-sample.docx`) from its own facts and compares the
 * result to the document a university actually received. That is the assertion
 * that catches a drift the template alone would not.
 */

const SIGNED: typeof DEFAULT_LETTER_CONFIG = {
  ...DEFAULT_LETTER_CONFIG,
  signatoryName: 'Aisha Bello',
};

const CANDIDATE = {
  fullName: 'Ibrahim Yusuf',
  levelOrYear: '400 level',
  department: 'Computer Science',
  university: 'University of Ilorin',
};

describe('formatLetterDate', () => {
  it('renders the sample format: weekday, ordinal day, month, year', () => {
    expect(formatLetterDate(new Date(2026, 6, 6))).toBe('Monday 6th July 2026');
  });

  it('uses the right ordinal suffix', () => {
    const on = (day: number) => formatLetterDate(new Date(2026, 2, day)).split(' ')[1];

    expect(on(1)).toBe('1st');
    expect(on(2)).toBe('2nd');
    expect(on(3)).toBe('3rd');
    expect(on(4)).toBe('4th');
    expect(on(21)).toBe('21st');
    expect(on(22)).toBe('22nd');
    expect(on(23)).toBe('23rd');
  });

  it('does not call the 11th "11st" — the teens are the exception', () => {
    const on = (day: number) => formatLetterDate(new Date(2026, 2, day)).split(' ')[1];

    expect(on(11)).toBe('11th');
    expect(on(12)).toBe('12th');
    expect(on(13)).toBe('13th');
  });
});

describe('formatLevel', () => {
  it('normalises however the applicant typed a level', () => {
    expect(formatLevel('400 level')).toBe('400-level');
    expect(formatLevel('400')).toBe('400-level');
    expect(formatLevel('400L')).toBe('400-level');
    expect(formatLevel('300 LEVEL')).toBe('300-level');
    expect(formatLevel('300-Level')).toBe('300-level');
  });

  /**
   * A level that is not a level number is left alone. Forcing "Year 3" into
   * "3-level" would state something false about the student on a document their
   * university files.
   */
  it('passes through anything that is not a bare level number', () => {
    expect(formatLevel('Year 3')).toBe('Year 3');
    expect(formatLevel('HND II')).toBe('HND II');
  });

  it('is empty for an absent level', () => {
    expect(formatLevel(null)).toBe('');
    expect(formatLevel('   ')).toBe('');
  });
});

describe('formatDepartment', () => {
  it('strips a leading "Department of" so the sentence does not say it twice', () => {
    expect(formatDepartment('Department of Computer Science')).toBe('Computer Science');
    expect(formatDepartment('the department of Mass Communication')).toBe('Mass Communication');
  });

  it('leaves an ordinary department name alone', () => {
    expect(formatDepartment('Computer Science')).toBe('Computer Science');
  });
});

describe('buildAcceptanceLetter', () => {
  const letter = buildAcceptanceLetter(CANDIDATE, SIGNED, new Date(2026, 6, 6));

  it('dates the letter as the sample does', () => {
    expect(letter.dateLine).toBe('Monday 6th July 2026');
  });

  it('addresses the Industrial Liaison Unit at the applicant’s university', () => {
    expect(letter.recipientLines).toEqual([
      'The Industrial Liaison Officer',
      'Industrial Liaison Unit',
      'University of Ilorin',
    ]);
  });

  it('builds the RE: line from the student name, in capitals', () => {
    expect(letter.subject).toBe('RE: ACCEPTANCE OF IBRAHIM YUSUF FOR SIWES PLACEMENT');
  });

  it('opens as the sample does', () => {
    expect(letter.salutation).toBe('Dear Sir/Madam,');
    expect(LETTER_CLOSING).toBe('Yours faithfully,');
  });

  // VERBATIM. See the note at the top of this file before changing any of it.
  it('reproduces the template word for word', () => {
    expect(letter.paragraphs).toEqual([
      'We acknowledge receipt of your request for the placement of Ibrahim Yusuf, a 400-level student of the Department of Computer Science, University of Ilorin.',
      'We are pleased to inform you that Ilorin Innovation Hub has accepted Ibrahim Yusuf for the Student Industrial Work Experience Scheme (SIWES). He/She will undergo his/her industrial training at our organization for the approved duration of the programme.',
      'Thank you for considering Ilorin Innovation Hub as a training partner. We look forward to supporting his/her professional development.',
    ]);
  });

  /**
   * The template puts `{{STUDENT_NAME}}` in this slot, not a pronoun.
   *
   * Worth its own assertion because "has accepted him/her" is the obvious thing
   * to write and is what this code did until the template was read closely.
   *
   * Note the signed sample says "has accepted him" — it predates the template
   * and was written for one student. The directive makes the TEMPLATE
   * authoritative, so the name is correct and the sample is not the check.
   */
  it('names the student again in the acceptance sentence', () => {
    expect(letter.paragraphs[1]).toContain('has accepted Ibrahim Yusuf for the');
    expect(letter.paragraphs[1]).not.toContain('accepted him/her');
  });

  /**
   * The sample says "organization". A British-spelling pass over this codebase
   * would "correct" it to "organisation" and change a signed document nobody
   * meant to change — so the z is asserted on its own, where the failure names
   * the reason.
   */
  it('keeps the sample’s "organization" spelling', () => {
    expect(letter.paragraphs[1]).toContain('at our organization');
    expect(letter.paragraphs[1]).not.toContain('organisation');
  });

  it('signs with the configured signatory', () => {
    expect(letter.signatory).toEqual({
      name: 'Aisha Bello',
      title: 'HR Associate',
      organisation: 'Ilorin Innovation Hub',
    });
  });

  it('reports nothing missing when the application is complete', () => {
    expect(letter.missing).toEqual([]);
  });
});

describe('buildAcceptanceLetter with an incomplete application', () => {
  /**
   * The clause is DROPPED, not left as a gap — and the omission is reported.
   *
   * A letter reading "a  student of the Department of , " is unusable; one that
   * quietly omits the department reads as complete and is not. So the sentence
   * stays grammatical and `missing` is the signal the admin acts on.
   */
  it('drops the level clause and names it as missing', () => {
    const letter = buildAcceptanceLetter(
      { ...CANDIDATE, levelOrYear: null },
      SIGNED,
      new Date(2026, 6, 6),
    );

    expect(letter.paragraphs[0]).toBe(
      'We acknowledge receipt of your request for the placement of Ibrahim Yusuf, a student of the Department of Computer Science, University of Ilorin.',
    );
    expect(letter.missing).toEqual(['level']);
  });

  it('drops the department clause and names it as missing', () => {
    const letter = buildAcceptanceLetter(
      { ...CANDIDATE, department: '' },
      SIGNED,
      new Date(2026, 6, 6),
    );

    expect(letter.paragraphs[0]).toBe(
      'We acknowledge receipt of your request for the placement of Ibrahim Yusuf, a 400-level student, University of Ilorin.',
    );
    expect(letter.missing).toEqual(['department']);
  });

  it('leaves the university out of the address block and names it as missing', () => {
    const letter = buildAcceptanceLetter(
      { ...CANDIDATE, university: null },
      SIGNED,
      new Date(2026, 6, 6),
    );

    expect(letter.recipientLines).toEqual([
      'The Industrial Liaison Officer',
      'Industrial Liaison Unit',
    ]);
    expect(letter.missing).toEqual(['university']);
  });

  it('reports an unset signatory, because an unsigned letter looks finished', () => {
    const letter = buildAcceptanceLetter(CANDIDATE, DEFAULT_LETTER_CONFIG, new Date(2026, 6, 6));

    expect(letter.signatory.name).toBe('');
    expect(letter.missing).toEqual(['HR signatory']);
  });
});

describe('pronouns', () => {
  const paragraphsFor = (gender?: string | null) =>
    buildAcceptanceLetter({ ...CANDIDATE, gender }, SIGNED, new Date(2026, 6, 6)).paragraphs;

  it('resolves a stated gender', () => {
    expect(pronounsFor('male')).toEqual({ subject: 'He', possessive: 'his' });
    expect(pronounsFor('female')).toEqual({ subject: 'She', possessive: 'her' });
    expect(pronounsFor('Male')).toEqual({ subject: 'He', possessive: 'his' });
  });

  /**
   * Absent, declined and unrecognised all land in the same place.
   *
   * "He/She … his/her" is the approved template's own text, so a letter
   * carrying it is the template as written — not a letter missing a value. The
   * alternative is inferring a pronoun from a name on a document a university
   * files permanently, which is a worse error and an unrecallable one.
   */
  it('falls back to the template’s own slashed form', () => {
    for (const value of [undefined, null, '', '   ', 'prefer not to say', 'other']) {
      expect(pronounsFor(value)).toEqual({ subject: 'He/She', possessive: 'his/her' });
    }
  });

  it('writes the resolved pronouns into both paragraphs that use them', () => {
    const male = paragraphsFor('male');
    expect(male[1]).toContain('He will undergo his industrial training');
    expect(male[2]).toContain('supporting his professional development');

    const female = paragraphsFor('female');
    expect(female[1]).toContain('She will undergo her industrial training');
    expect(female[2]).toContain('supporting her professional development');
  });

  /**
   * A gender nobody supplied is not an omission the admin has to act on, so it
   * stays out of `missing` — otherwise every applicant who applied before the
   * field existed carries a warning, and the warnings that matter get lost.
   */
  it('does not report an absent gender as missing', () => {
    expect(buildAcceptanceLetter(CANDIDATE, SIGNED, new Date(2026, 6, 6)).missing).toEqual([]);
  });
});

/**
 * The template, filled with the signed sample's facts.
 *
 * `docs/templates/SIWES-acceptance-letter-sample.docx` is a letter a real
 * university received for a real student, so its values are a far better test
 * case than invented ones — a real institution name with a comma in it, a real
 * multi-part personal name.
 *
 * It is NOT a byte-for-byte reproduction of that document, and must not be
 * mistaken for one. The sample says "has accepted him" where the template says
 * `{{STUDENT_NAME}}`; the sample predates the template and the directive makes
 * the template authoritative. Every other line does match the sample exactly,
 * including the pronouns — which is the part worth pinning, since it is what
 * `gender` has to survive the whole path to produce.
 */
describe('the template, filled with the signed sample’s facts', () => {
  const ONIYE = {
    fullName: 'Muhammad Onaopepo Oniye',
    levelOrYear: '400 level',
    department: 'Computer Engineering',
    university: 'Federal University of Technology, Minna',
    gender: 'male',
  };

  const letter = buildAcceptanceLetter(
    ONIYE,
    { ...DEFAULT_LETTER_CONFIG, signatoryName: 'Jane Doe' },
    new Date(2026, 6, 7),
  );

  it('addresses and titles the letter as the sample does', () => {
    expect(letter.recipientLines).toEqual([
      'The Industrial Liaison Officer',
      'Industrial Liaison Unit',
      'Federal University of Technology, Minna',
    ]);
    expect(letter.subject).toBe(
      'RE: ACCEPTANCE OF MUHAMMAD ONAOPEPO ONIYE FOR SIWES PLACEMENT',
    );
  });

  it('matches the sample line for line, but names the student where the sample said "him"', () => {
    expect(letter.paragraphs).toEqual([
      'We acknowledge receipt of your request for the placement of Muhammad Onaopepo Oniye, a 400-level student of the Department of Computer Engineering, Federal University of Technology, Minna.',
      'We are pleased to inform you that Ilorin Innovation Hub has accepted Muhammad Onaopepo Oniye for the Student Industrial Work Experience Scheme (SIWES). He will undergo his industrial training at our organization for the approved duration of the programme.',
      'Thank you for considering Ilorin Innovation Hub as a training partner. We look forward to supporting his professional development.',
    ]);
  });

  it('signs it as the sample is signed', () => {
    expect(letter.signatory).toEqual({
      name: 'Jane Doe',
      title: 'HR Associate',
      organisation: 'Ilorin Innovation Hub',
    });
  });

  /**
   * The sample's own date line reads "Monday 7th July 2026", and 7 July 2026
   * was a Tuesday — a typo that survived into a signed document precisely
   * because the weekday was typed by hand. Deriving it is the fix, so this
   * asserts the correct weekday rather than the sample's.
   */
  it('derives the weekday rather than trusting the sample’s', () => {
    expect(letter.dateLine).toBe('Tuesday 7th July 2026');
  });
});

describe('readLetterConfig', () => {
  it('falls back to the defaults for an unset or malformed setting', () => {
    expect(readLetterConfig(undefined)).toEqual(DEFAULT_LETTER_CONFIG);
    expect(readLetterConfig(null)).toEqual(DEFAULT_LETTER_CONFIG);
    expect(readLetterConfig('Aisha Bello')).toEqual(DEFAULT_LETTER_CONFIG);
    expect(readLetterConfig({ signatoryName: '   ' })).toEqual(DEFAULT_LETTER_CONFIG);
  });

  it('keeps a stored signatory and trims it', () => {
    expect(readLetterConfig({ signatoryName: '  Aisha Bello  ' })).toEqual({
      ...DEFAULT_LETTER_CONFIG,
      signatoryName: 'Aisha Bello',
    });
  });
});

describe('letter date input', () => {
  it('round-trips through the date input', () => {
    const value = letterDateInputValue(new Date(2026, 6, 6));
    expect(value).toBe('2026-07-06');
    expect(formatLetterDate(parseLetterDateInput(value)!)).toBe('Monday 6th July 2026');
  });

  /**
   * `new Date('2026-07-06')` is UTC midnight, which is the 5th in any negative
   * offset — so the letter would carry the day before the one that was picked.
   */
  it('reads the input as a local date, not as UTC', () => {
    const parsed = parseLetterDateInput('2026-07-06')!;
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(6);
  });

  it('refuses a half-typed or impossible date rather than rolling it forward', () => {
    expect(parseLetterDateInput('')).toBeNull();
    expect(parseLetterDateInput('2026-07')).toBeNull();
    expect(parseLetterDateInput('2026-02-31')).toBeNull();
  });
});

describe('the department clause', () => {
  /**
   * Faculty must not stand in for the department.
   *
   * The sentence is "of the Department of {X}". Applicants who answer the
   * faculty question answer it as "Faculty of Engineering", so using it as a
   * fallback prints "of the Department of Faculty of Engineering" — and, worse,
   * fills `missing` so the admin is never told to correct the record. A blank
   * department is visible; a wrong one is not.
   */
  it('strips a leading "Faculty of" rather than doubling the noun', () => {
    expect(formatDepartment('Faculty of Engineering')).toBe('Engineering');
    expect(formatDepartment('the faculty of Life Sciences')).toBe('Life Sciences');
  });

  it('still reports a department nobody supplied', () => {
    const letter = buildAcceptanceLetter(
      { ...CANDIDATE, department: null },
      SIGNED,
      new Date(2026, 6, 6),
    );

    expect(letter.missing).toContain('department');
    expect(letter.paragraphs[0]).not.toContain('Department of');
  });
});

describe('the organisation name', () => {
  /**
   * Not configurable, and this is the test that keeps it that way.
   *
   * It is not one of the template's placeholders, it appears in two body
   * sentences as well as over the signature, and it names the entity
   * undertaking to host the student. It was briefly an editable setting; a
   * letter whose organisation had been edited is a commitment by a different
   * body, which is not a thing an admin screen should be able to produce.
   */
  it('is fixed, and a stored setting cannot move it', () => {
    const tampered = readLetterConfig({
      signatoryName: 'Aisha Bello',
      organisationName: 'Some Other Hub',
    });

    expect(tampered).not.toHaveProperty('organisationName');

    const letter = buildAcceptanceLetter(CANDIDATE, tampered, new Date(2026, 6, 6));
    expect(letter.signatory.organisation).toBe(ORGANISATION_NAME);
    expect(letter.paragraphs[1]).toContain('Ilorin Innovation Hub has accepted');
    expect(letter.paragraphs.join(' ')).not.toContain('Some Other Hub');
  });
});

/**
 * The signature image on the letter.
 *
 * `renderAcceptanceLetterPdf` swallows an unusable signature on purpose — an
 * applicant must not lose their university placement because an image was the
 * wrong format. That silence is correct in production and dangerous in a test
 * suite: the first version of the embedded PNG was mangled to 31 bytes and the
 * letter still rendered, looking exactly like a letter that had simply not been
 * given a signature. These assert the difference the eye cannot see.
 */
describe('the signature on the acceptance letter', () => {
  const candidate = {
    fullName: 'Aisha Bello',
    levelOrYear: '400 level',
    department: 'Computer Science',
    university: 'University of Ilorin',
    gender: 'female',
  };
  const letterFor = (signatoryName: string) =>
    buildAcceptanceLetter(
      candidate,
      readLetterConfig({ signatoryName, signatoryTitle: 'HR Associate' }),
      new Date('2026-08-28T09:00:00Z'),
    );
  const signature = () => ({
    bytes: Uint8Array.from(Buffer.from(SIGNATURE_PNG_BASE64, 'base64')),
    format: 'png' as const,
  });

  it('carries a real PNG, not a mangled one', () => {
    const bytes = Buffer.from(SIGNATURE_PNG_BASE64, 'base64');
    // The exact failure that shipped once: a base64 literal broken during
    // generation decoded to 31 bytes and was silently discarded at render.
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('actually embeds the image, rather than quietly skipping it', async () => {
    const letter = letterFor('Jane Doe');
    const withSig = await renderAcceptanceLetterPdf(letter, { signatureImage: signature() });
    const without = await renderAcceptanceLetterPdf(letter);
    // A silently-dropped signature produces a PDF the same size as no signature
    // at all, which is precisely how the broken build looked correct.
    expect(withSig.length).toBeGreaterThan(without.length + 5_000);
  });

  it('refuses to sign for anyone but its owner', async () => {
    // Changing the signatory must not stamp the previous person's signature
    // under the new person's typed name.
    expect(signatureBelongsTo('Jane Doe')).toBe(true);
    expect(signatureBelongsTo('  jane   doe ')).toBe(true);
    expect(signatureBelongsTo('John Roe')).toBe(false);
    expect(signatureBelongsTo(undefined)).toBe(false);
  });

  it('still produces a letter when the image is unusable', async () => {
    // The deliberate silence: a corrupt image costs a squiggle, not a placement.
    const letter = letterFor('Jane Doe');
    const pdf = await renderAcceptanceLetterPdf(letter, {
      signatureImage: { bytes: new Uint8Array([1, 2, 3, 4]), format: 'png' },
    });
    expect(pdf.length).toBeGreaterThan(1_000);
  });
});
