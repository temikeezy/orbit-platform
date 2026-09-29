/**
 * The SIWES acceptance letter, as an A4 PDF.
 *
 * WHY THIS EXISTS. The letter is what a university's Industrial Liaison Unit
 * needs before it will accept a placement, and until now the only way to produce
 * one was for an admin to open the print view and print it, one applicant at a
 * time. With 71 SIWES applicants that is 71 manual steps between someone being
 * accepted and being able to register at their own institution. Attaching it to
 * the acceptance email removes the step entirely.
 *
 * WHY IT IS SAFE TO HAVE TWO RENDERERS. `buildAcceptanceLetter` in
 * lib/acceptanceLetter.ts is the single source of the letter's WORDS — the date
 * line, the recipient block, the subject, every paragraph, the signatory. Both
 * this and the React print view consume it and neither composes prose of its
 * own. What is duplicated is layout, not content, so the two can differ in
 * margins without ever differing in what the letter says.
 *
 * NODE ONLY, AND NOT YET WIRED. pdf-lib cannot run in Convex's V8 isolate, so
 * anything importing this must be a `"use node"` module. Nothing imports it yet
 * — the attachment path through convex/email.ts is still to be built, and an
 * earlier version of this comment claimed otherwise, which was false.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { AcceptanceLetter } from './acceptanceLetter';
import { LETTER_CLOSING } from './acceptanceLetter';
import { orgName } from './org';

/** A4 in PDF points (1pt = 1/72in). 210 x 297mm. */
const PAGE = { width: 595.28, height: 841.89 };

/**
 * Margins matching the print stylesheet's `@page orbit-letter`: 14mm top,
 * 20mm sides, 12mm bottom. Kept in step deliberately — a letter that prints
 * differently depending on which route produced it is the failure this whole
 * module has to avoid.
 */
const MM = 2.834645669;
const MARGIN = { top: 14 * MM, right: 20 * MM, bottom: 12 * MM, left: 20 * MM };

const BODY_SIZE = 11;
const LINE_GAP = 1.45;
const INK = rgb(0, 0, 0);

interface Cursor {
  page: PDFPage;
  y: number;
}

/**
 * Greedy wrap against the font's real measurements rather than a character
 * count — the sample letter runs long institution names through this, and
 * guessing at width is how a line ends up in the margin.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines: string[] = [];
  let line = words[0];

  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

export interface LetterPdfOptions {
  /** The IIH letterhead mark, as PNG bytes. Omitted, the letter still renders. */
  logoPng?: Uint8Array;
  /**
   * The signatory's handwritten signature, drawn into the gap the closing
   * already reserves.
   *
   * PNG or JPEG — a phone photograph of a signature is a JPEG, and requiring a
   * conversion step is how the image ends up not being used at all.
   *
   * OPTIONAL, AND SILENTLY SO. A letter without a signature image is still a
   * valid letter on headed paper with a typed name, which is what every one of
   * these has carried so far. An acceptance letter that fails to render because
   * an image was the wrong format costs an applicant their university
   * placement; a missing squiggle does not.
   */
  signatureImage?: { bytes: Uint8Array; format: 'png' | 'jpg' };
}

/**
 * How tall the signature is drawn, in points. Width follows from the image's
 * own aspect ratio — never set both, or the signature is stretched.
 */
const SIGNATURE_HEIGHT = 50;

export async function renderAcceptanceLetterPdf(
  letter: AcceptanceLetter,
  options: LetterPdfOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(letter.subject);
  doc.setCreator(`ORBIT — ${orgName()}`);

  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

  const contentWidth = PAGE.width - MARGIN.left - MARGIN.right;
  const cursor: Cursor = { page: doc.addPage([PAGE.width, PAGE.height]), y: PAGE.height - MARGIN.top };

  /** Starts a new page when the next block will not fit above the bottom margin. */
  const ensure = (needed: number) => {
    if (cursor.y - needed >= MARGIN.bottom) return;
    cursor.page = doc.addPage([PAGE.width, PAGE.height]);
    cursor.y = PAGE.height - MARGIN.top;
  };

  const draw = (
    text: string,
    opts: { font?: PDFFont; size?: number; align?: 'left' | 'right'; gap?: number } = {},
  ) => {
    const font = opts.font ?? body;
    const size = opts.size ?? BODY_SIZE;
    for (const line of wrap(text, font, size, contentWidth)) {
      ensure(size * LINE_GAP);
      const width = font.widthOfTextAtSize(line, size);
      cursor.page.drawText(line, {
        x: opts.align === 'right' ? PAGE.width - MARGIN.right - width : MARGIN.left,
        y: cursor.y - size,
        size,
        font,
        color: INK,
      });
      cursor.y -= size * LINE_GAP;
    }
    if (opts.gap) cursor.y -= opts.gap;
  };

  // Letterhead. Drawn rather than assumed to be pre-printed on the paper — the
  // print view carries the mark inside the document for the same reason.
  if (options.logoPng?.length) {
    try {
      const png = await doc.embedPng(options.logoPng);
      const height = 46;
      const width = (png.width / png.height) * height;
      ensure(height + 12);
      cursor.page.drawImage(png, { x: MARGIN.left, y: cursor.y - height, width, height });
      cursor.y -= height + 18;
    } catch {
      // A letterhead that fails to embed must not cost the applicant the letter.
    }
  }

  draw(letter.dateLine, { align: 'right', gap: 14 });

  for (const line of letter.recipientLines) draw(line);
  cursor.y -= 14;

  draw(letter.subject.toUpperCase(), { font: bold, gap: 12 });
  draw(letter.salutation, { gap: 10 });

  for (const paragraph of letter.paragraphs) draw(paragraph, { gap: 10 });

  cursor.y -= 8;
  draw(LETTER_CLOSING, { gap: 6 });

  /**
   * The signature sits between "Yours faithfully," and the typed name.
   *
   * Drawn at a fixed HEIGHT with the width derived from the image, so a
   * signature photographed at any resolution lands the same size and is never
   * stretched. Setting both dimensions is what skews it — the same mistake the
   * app header made with its logo.
   */
  let signatureDrawn = false;
  if (options.signatureImage?.bytes.length) {
    try {
      const img =
        options.signatureImage.format === 'png'
          ? await doc.embedPng(options.signatureImage.bytes)
          : await doc.embedJpg(options.signatureImage.bytes);

      const scale = SIGNATURE_HEIGHT / img.height;
      const width = img.width * scale;

      ensure(SIGNATURE_HEIGHT + 6);
      cursor.y -= SIGNATURE_HEIGHT;
      cursor.page.drawImage(img, {
        x: MARGIN.left,
        y: cursor.y,
        width,
        height: SIGNATURE_HEIGHT,
      });
      cursor.y -= 6;
      signatureDrawn = true;
    } catch {
      // A corrupt or unsupported image must not cost anyone their letter.
      signatureDrawn = false;
    }
  }

  // Falls back to the blank space the letter has always left when there is no
  // image to draw — so an unsigned letter still has somewhere to sign by hand.
  if (!signatureDrawn) cursor.y -= 38;

  draw(letter.signatory.name, { font: bold });
  draw(letter.signatory.title);
  draw(letter.signatory.organisation);

  return doc.save();
}

/** `Acceptance Letter - Aisha Bello.pdf`, safe for any filesystem. */
export function letterFileName(fullName: string): string {
  const clean = fullName.replace(/[^A-Za-z0-9 .-]/g, '').trim() || 'Applicant';
  return `Acceptance Letter - ${clean}.pdf`;
}
