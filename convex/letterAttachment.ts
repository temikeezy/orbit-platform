'use node';

/**
 * Builds the SIWES acceptance letter for a queued approval email.
 *
 * `"use node"` because pdf-lib cannot run in Convex's V8 isolate. It lives in
 * its own module rather than inside email.ts so that the drain — which is also
 * a node action — pulls in the PDF machinery only when a letter is actually
 * wanted, and every V8 module stays clear of it entirely.
 *
 * Returns null rather than throwing whenever a letter cannot be built. An
 * acceptance that arrives without its attachment is a missing document someone
 * can chase; an acceptance that fails to send because the attachment broke is a
 * person who never learns they were accepted.
 */
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { buildAcceptanceLetter, readLetterConfig } from './lib/acceptanceLetter';
import { renderAcceptanceLetterPdf, letterFileName } from './lib/letterPdf';
import { IIH_LETTERHEAD_PNG_BASE64 } from './lib/letterhead';
import { SIGNATURE_PNG_BASE64, signatureBelongsTo } from './lib/signature';

export const buildForApplication = internalAction({
  args: { applicationId: v.id('applications') },
  returns: v.union(
    v.null(),
    v.object({ filename: v.string(), contentBase64: v.string(), contentType: v.string() }),
  ),
  /** Annotated for the same TS7022 reason as tasks.create — see that comment. */
  handler: async (
    ctx,
    { applicationId },
  ): Promise<{ filename: string; contentBase64: string; contentType: string } | null> => {
    try {
      const data = await ctx.runQuery(internal.acceptanceLetters.letterInputs, { applicationId });
      if (!data) return null;

      const letter = buildAcceptanceLetter(
        data.candidate,
        readLetterConfig(data.config),
        new Date(),
      );

      const logo = Uint8Array.from(Buffer.from(IIH_LETTERHEAD_PNG_BASE64, 'base64'));

      /**
       * Only stamped when the configured signatory is the person who signed it.
       * A signatory change must not carry the previous person's signature onto
       * letters bearing the new person's name — see lib/signature.ts.
       */
      const signatureImage = signatureBelongsTo(letter.signatory.name)
        ? {
            bytes: Uint8Array.from(Buffer.from(SIGNATURE_PNG_BASE64, 'base64')),
            format: 'png' as const,
          }
        : undefined;

      const pdf = await renderAcceptanceLetterPdf(letter, { logoPng: logo, signatureImage });

      return {
        filename: letterFileName(data.candidate.fullName),
        contentBase64: Buffer.from(pdf).toString('base64'),
        contentType: 'application/pdf',
      };
    } catch (error) {
      console.error('acceptance letter could not be built', applicationId, error);
      return null;
    }
  },
});
