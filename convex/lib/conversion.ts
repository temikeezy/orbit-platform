import { escapeHtml } from './html';

/**
 * Turning an approved application into an ORBIT member.
 *
 * The confirmation email an applicant already receives says two things that
 * were not true: "we will email you at this address when there is a decision"
 * and "you do not have an ORBIT account yet — one is created if you are
 * accepted". Approving set a status and did neither. This closes both.
 *
 * Pure helpers only, in lib/ — see convex/lib/sheets.ts for why the function
 * modules have to stay thin.
 */

/** A slug candidate from a name; uniqueness is settled against the table. */
export function slugCandidate(fullName: string, email: string): string {
  const base = fullName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // A name of only punctuation or non-Latin script leaves nothing usable, and a
  // blank slug collides with every other blank one.
  return base || email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'member';
}

import { appUrl } from './appUrl';
import { orgName, orgShortName } from './org';
import { emailButton } from './emailShell';

/**
 * The acknowledgement, sent the moment an application is received.
 *
 * Its job is to answer the three questions an applicant has the second after
 * they press Submit — did it arrive, what happens now, and when do I hear back
 * — because an acknowledgement that answers none of them generates exactly the
 * follow-up mail and re-submissions it was meant to prevent.
 *
 * It commits to nothing the platform does not do. Admissions has two states,
 * submitted and approved, and there is no rejection email — so this promises
 * contact only if the application succeeds rather than "a decision either way",
 * which is what it said until a review pointed out nothing would ever send it.
 * What it does promise on acceptance — a start date and first-week details —
 * `approvalEmail` below carries, and the two live together so they cannot drift
 * apart.
 *
 * NO DATE IS INVENTED. Review timeframes are the team's to state, so this says
 * what will happen rather than when.
 */
export function acknowledgementEmail(
  fullName: string,
  referenceCode: string,
  /**
   * Which programme they applied for. Decides two sentences that were wrong for
   * part of the intake when this email was generic: SIWES placements are virtual
   * wherever the student lives, and only SIWES students keep a logbook.
   */
  programmeType?: string,
): { subject: string; bodyHtml: string; bodyText: string } {
  const name = escapeHtml(fullName || 'there');
  const reference = escapeHtml(referenceCode);
  const siwes = programmeType === 'siwes';

  const participation = siwes
    ? 'SIWES placements run virtually, wherever you are based.'
    : 'ORBIT sets your participation mode during review. Applicants based in Ilorin '
      + 'attend in person one day a week, on Mondays; applicants outside Ilorin '
      + 'participate virtually.';

  // Only SIWES students have a logbook — see carriesLogbook in lib/programme.ts.
  const firstStep = siwes
    ? 'so you can sign in and begin your logbook'
    : 'so you can sign in and see the work waiting in your stream';

  return {
    subject: `We have your application — ${referenceCode}`,
    bodyHtml:
      `<p>Hi ${name},</p>` +
      `<p>Thanks for applying to the ${escapeHtml(orgName())}. Your application and your ` +
      `uploaded documents have been received, and the ORBIT team will review them.</p>` +
      `<p><strong>Your reference:</strong> ${reference}<br>` +
      `Please keep it — quote it in any correspondence about your application.</p>` +
      `<p><strong>What happens next</strong></p>` +
      `<ol>` +
      `<li><strong>Review.</strong> The team reviews each application, including your ` +
      `institution details and placement letter.</li>` +
      `<li><strong>Decision.</strong> If your application is successful we will email you at ` +
      `this address. Please watch your inbox, and check your spam or promotions folder. We ` +
      `are not able to reply to every application individually.</li>` +
      `<li><strong>Commencement.</strong> If you are accepted, that email will confirm ` +
      `your start date and what to expect in your first week, and an ORBIT account will ` +
      `be created for you ${firstStep}.</li>` +
      `</ol>` +
      `<p><strong>How participation works.</strong> ${participation} Your cohort and ` +
      `supervisor are assigned by the team after acceptance.</p>` +
      `<p><strong>Please do not re-apply.</strong> Sending the form again does not speed ` +
      `up review, and duplicate applications are set aside. There is nothing else for you ` +
      `to do right now. Applying does not create an ORBIT account: if you are accepted we ` +
      `will create one for you, or use your existing account if you already have one.</p>` +
      `<p style="color:#666;font-size:12px">If you did not apply, someone may have entered ` +
      `your address by mistake. You can ignore this — no account has been created and we ` +
      `will not email you again about it.</p>` +
      `<p style="color:#666;font-size:12px">This message was sent automatically from an ` +
      `unmonitored address; please do not reply to it.<br>${escapeHtml(appUrl())}</p>`,
    bodyText:
      `Hi ${fullName || 'there'},\n\n` +
      `Thanks for applying to the ${orgName()}. Your application and your ` +
      `uploaded documents have been received, and the ORBIT team will review them.\n\n` +
      `Your reference: ${referenceCode}\n` +
      `Please keep it — quote it in any correspondence about your application.\n\n` +
      `WHAT HAPPENS NEXT\n\n` +
      `1. Review. The team reviews each application, including your institution details ` +
      `and placement letter.\n` +
      `2. Decision. If your application is successful we will email you at this address. ` +
      `Please watch your inbox, and check your spam or promotions folder. We are not able ` +
      `to reply to every application individually.\n` +
      `3. Commencement. If you are accepted, that email will confirm your start date and ` +
      `what to expect in your first week, and an ORBIT account will be created for you ` +
      `${firstStep}.\n\n` +
      `HOW PARTICIPATION WORKS\n\n` +
      `${participation} Your cohort and supervisor are assigned by the team after ` +
      `acceptance.\n\n` +
      `PLEASE DO NOT RE-APPLY\n\n` +
      `Sending the form again does not speed up review, and duplicate applications are set ` +
      `aside. There is nothing else for you to do right now. Applying does not create an ` +
      `ORBIT account: if you are accepted we will create one for you, or use your existing ` +
      `account if you already have one.\n\n` +
      `If you did not apply, someone may have entered your address by mistake. You can ` +
      `ignore this; we will not email you again about it.\n\n` +
      `This message was sent automatically from an unmonitored address; please do not ` +
      `reply to it.\n${appUrl()}`,
  };
}

/**
 * The approval email.
 *
 * NO PASSWORD IS SENT. The account is created without one and the applicant
 * signs in with a magic link they request themselves — a password in an inbox
 * outlives the email, and a link generated at approval time would expire long
 * before most people read it.
 */
/**
 * Stands in for the sign-in link until the message is actually sent.
 *
 * Deliberately not a URL: if substitution ever failed, a broken placeholder is
 * visible and reportable, where a plausible-looking dead link is neither.
 */
export const SIGN_IN_LINK_PLACEHOLDER = 'ORBIT_SIGN_IN_LINK_PENDING';

export function approvalEmail(
  fullName: string,
  referenceCode: string,
  /**
   * The commencement details, as far as they are known at approval.
   *
   * The acknowledgement email promises this message will carry them, so it has
   * to. `startDate` is the applicant's own stated SIWES start date and
   * `participationMode` is what review settled on — both are on the application,
   * so neither invents a commitment the team has not made. Anything still to be
   * decided is named as such rather than left out, because "when do I start" is
   * the first question this email has to answer.
   */
  commencement: {
    /**
     * A ready-to-use sign-in link. When present this email IS the way in, and
     * no second message is needed; when absent it falls back to telling them
     * how to request one, which is what it did before.
     */
    signInLink?: string;
    startDate?: string;
    /**
     * Today, as `YYYY-MM-DD` in WAT. Supplied by the caller rather than read
     * from the clock so this stays a pure function the unit tests can pin.
     * Omitted, the email falls back to naming the date, which is the old
     * behaviour.
     */
    today?: string;
    participationMode?: string;
    cohortName?: string;
    streamName?: string;
    supervisorName?: string;
    /**
     * Which programme they actually applied for. Decides whether this email
     * mentions a logbook at all — see the first-week paragraph below.
     */
    programmeType?: string;
  } = {},
): {
  subject: string;
  bodyHtml: string;
  bodyText: string;
} {
  const name = escapeHtml(fullName || 'there');
  const reference = escapeHtml(referenceCode);

  // Named when we know it: "the start date on your application" was wrong for
  // anyone whose SIWES letter disagrees with the cohort's fixed start.
  const cohortClause = commencement.cohortName
    ? ` with ${escapeHtml(commencement.cohortName)}`
    : '';
  const cohortClauseText = commencement.cohortName ? ` with ${commencement.cohortName}` : '';

  /**
   * NO DATE. The placement begins immediately.
   *
   * This used to name the cohort's start date, which for ORBIT 2.0 was
   * 2026-08-17 — already gone by the time anyone was accepted, so every one of
   * the 246 acceptances would have said "begins on" a date in the past. A
   * conditional was tried first and was still the wrong shape: there is one
   * cohort, it has started, and an accepted applicant starts when they read
   * this. Saying so plainly beats computing a date nobody needs.
   *
   * `startDate` and `today` are still accepted so callers do not break, and are
   * deliberately unused here.
   */
  const start = `Your placement${cohortClause} <strong>begins immediately</strong>.`;
  const startText = `Your placement${cohortClauseText} begins immediately.`;

  /**
   * Stream and supervisor, when review has settled them.
   *
   * The acknowledgement email promises the decision message will say what to
   * expect, and "you will be told later" is what it says today. When the
   * placement is known there is no reason to make someone sign in to find out
   * who they report to.
   */
  const placement = commencement.streamName
    ? `<p><strong>Your stream.</strong> You are joining ` +
      `<strong>${escapeHtml(commencement.streamName)}</strong>` +
      (commencement.supervisorName
        ? `, supervised by ${escapeHtml(commencement.supervisorName)}`
        : '') +
      `.</p>`
    : '';

  const placementText = commencement.streamName
    ? `YOUR STREAM\n\nYou are joining ${commencement.streamName}` +
      (commencement.supervisorName ? `, supervised by ${commencement.supervisorName}` : '') +
      `.\n\n`
    : '';

  const mode = participationSentence(commencement.participationMode);

  /**
   * THE LOGBOOK SENTENCE IS SIWES-ONLY.
   *
   * This paragraph used to tell every approved applicant to "start your daily
   * logbook entries". Only SIWES students keep a logbook — it exists to be
   * inspected by a university's Industrial Liaison Unit, and nobody else has an
   * institution expecting one (see carriesLogbook in lib/programme.ts). On the
   * current intake that is 71 of 246 people, so the old wording instructed 175
   * interns, NYSC members and volunteers to begin something that does not exist
   * on their account — an instruction they cannot follow and would reasonably
   * write in about.
   */
  /**
   * ONE EMAIL, NOT TWO.
   *
   * This used to say "go to the site and choose Send me a magic link", which
   * cost a second email and a round trip before anyone could get in. The link
   * is now carried here, so acceptance and sign-in are the same message.
   *
   * The window is 24 hours (MAGIC_LINK_TTL_MS) — long enough to survive being
   * read the next morning, and the reason that value was raised. If it does
   * lapse, the fallback wording below is what they get, and requesting a fresh
   * link from the sign-in page still works.
   */
  const signIn = commencement.signInLink
    ? {
        html:
          `<p><strong>To sign in:</strong> use the button below. It signs you in ` +
          `directly — there is no password to remember.</p>` +
          emailButton(commencement.signInLink, 'Sign in to ORBIT') +
          `<p style="font-size:13px;color:#66736D">This link works for 24 hours and can be ` +
          `used once. If it has expired, go to <a href="${appUrl()}">${appUrl()}</a>, enter ` +
          `this email address and choose “Send me a magic link”.</p>`,
        text:
          `TO SIGN IN\n\n` +
          `Use this link — it signs you in directly, with no password to remember:\n` +
          `${commencement.signInLink}\n\n` +
          `It works for 24 hours and can be used once. If it has expired, go to ` +
          `${appUrl()}, enter this email address and choose "Send me a magic link".\n\n`,
      }
    : {
        html:
          `<p><strong>To sign in:</strong> go to <a href="${appUrl()}">${appUrl()}</a>, enter ` +
          `this email address and choose <em>Send me a magic link</em>. We will email you a ` +
          `link that signs you in — there is no password to remember.</p>`,
        text:
          `TO SIGN IN\n\n` +
          `Go to ${appUrl()}, enter this email address and choose "Send me a magic link". ` +
          `We will email you a link that signs you in — there is no password to remember.\n\n`,
      };

  const isSiwes = commencement.programmeType === 'siwes';

  const firstWeek = isSiwes
    ? {
        html:
          `<p><strong>Your first week.</strong> Sign in and check your profile details are ` +
          `correct. Your cohort, department and ${escapeHtml(orgShortName())} supervisor are assigned by the team and ` +
          `will appear on your profile — once they do, start your daily logbook entries. The ` +
          `team will be in touch about orientation and reporting arrangements.</p>`,
        text:
          `YOUR FIRST WEEK\n\n` +
          `Sign in and check your profile details are correct. Your cohort, department and ` +
          `${orgShortName()} supervisor are assigned by the team and will appear on your profile — once ` +
          `they do, start your daily logbook entries. The team will be in touch about ` +
          `orientation and reporting arrangements.\n\n`,
      }
    : {
        html:
          `<p><strong>Your first week.</strong> Sign in and check your profile details are ` +
          `correct. Your stream and the team supporting you will appear on your profile. The ` +
          `team will be in touch about orientation and how work is assigned.</p>`,
        text:
          `YOUR FIRST WEEK\n\n` +
          `Sign in and check your profile details are correct. Your stream and the team ` +
          `supporting you will appear on your profile. The team will be in touch about ` +
          `orientation and how work is assigned.\n\n`,
      };

  return {
    subject: 'Your ORBIT application has been approved',
    bodyHtml:
      `<p>Hi ${name},</p>` +
      `<p>Your application to the ${escapeHtml(orgName())} has been <strong>approved</strong>. ` +
      `Welcome.</p>` +
      `<p>An ORBIT account has been created for you using this email address.</p>` +
      signIn.html +
      `<p><strong>Commencement.</strong> ${start} ${mode.html}</p>` +
      placement +
      firstWeek.html +
      `<p><strong>Your reference:</strong> ${reference}</p>`,
    bodyText:
      `Hi ${fullName || 'there'},\n\n` +
      `Your application to the ${orgName()} has been approved. Welcome.\n\n` +
      `An ORBIT account has been created for you using this email address.\n\n` +
      signIn.text +
      `COMMENCEMENT\n\n${startText} ${mode.text}\n\n` +
      placementText +
      firstWeek.text +
      `Your reference: ${referenceCode}\n`,
  };
}


/** What the assigned participation mode means in practice, in one sentence. */
function participationSentence(mode?: string): { html: string; text: string } {
  // `virtual`, not `remote`. The platform's vocabulary is
  // virtual | hybrid | physical — see src/types/database.ts and
  // lib/intake.ts — and matching on the wrong word silently sent every
  // applicant outside Ilorin the "to be confirmed" fallback instead.
  if (mode === 'virtual') {
    const s =
      'You have been placed on virtual participation, so you will take part online ' +
      'rather than attending the Hub.';
    return { html: s, text: s };
  }

  if (mode === 'physical' || mode === 'hybrid') {
    const s =
      'You have been placed on in-person participation: you attend the Ilorin ' +
      'Innovation Hub one day a week, on Mondays, and work remotely the rest of the week.';
    return { html: s, text: s };
  }

  const s = 'Your participation mode will be confirmed by the team.';
  return { html: s, text: s };
}

/**
 * The holding note that goes out ahead of the acceptances.
 *
 * Every applicant is being accepted, so this says so plainly rather than hedging
 * on an outcome — an earlier draft used neutral "successful or not" wording,
 * which is the right shape when some will be turned down and needlessly cold
 * when none will be.
 */
export function holdingEmail(
  fullName: string,
  referenceCode: string,
): { subject: string; bodyHtml: string; bodyText: string } {
  const name = escapeHtml((fullName || 'there').split(' ')[0]);
  const plain = (fullName || 'there').split(' ')[0];
  const reference = escapeHtml(referenceCode);

  return {
    subject: 'Your ORBIT application — an update',
    bodyHtml:
      `<p>Hi ${name},</p>` +
      `<p>Thank you for applying to the ${escapeHtml(orgName())}.</p>` +
      `<p>We are pleased to tell you that your place on ORBIT is <strong>confirmed</strong>. ` +
      `Your full acceptance email follows later today, and it will carry everything you need ` +
      `to sign in and get started — including your stream and a link that logs you straight in.</p>` +
      `<p>You do not need to reply to this message or send anything further. Please keep an eye ` +
      `on your inbox, and check your spam folder in case our message lands there.</p>` +
      `<p><strong>Application reference:</strong> ${reference}</p>` +
      `<p>Welcome aboard.</p>`,
    bodyText:
      `Hi ${plain},\n\n` +
      `Thank you for applying to the ${orgName()}.\n\n` +
      `We are pleased to tell you that your place on ORBIT is confirmed. Your full ` +
      `acceptance email follows later today, and it will carry everything you need to sign ` +
      `in and get started — including your stream and a link that logs you straight in.\n\n` +
      `You do not need to reply to this message or send anything further. Please keep an eye ` +
      `on your inbox, and check your spam folder in case our message lands there.\n\n` +
      `Application reference: ${referenceCode}\n\n` +
      `Welcome aboard.\n`,
  };
}
