import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import {
  AcceptanceLetterConfig,
  LetterCandidate,
  readLetterConfig,
} from '../../../convex/lib/acceptanceLetter';

/**
 * SIWES acceptance letters.
 *
 * The letters themselves are never fetched — one is assembled in the browser by
 * `buildAcceptanceLetter` from a candidate plus a date, so printing costs no
 * round trip. What does cross the wire is the signatory and, for a batch, the
 * list of who was accepted.
 */

/** What a batch run returns: the candidates, and whether they are all of them. */
export interface AcceptedCandidateBatch {
  candidates: LetterCandidate[];
  /**
   * True only when the run hit its safety ceiling with pages still to come.
   *
   * Normal runs are complete and this is false however many applicants there
   * are — the ceiling exists to stop a runaway loop, not to bound a cohort.
   */
  truncated: boolean;
  ceiling: number;
}

/** Same shape as the other api modules: the session or a clear refusal. */
function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

export const acceptanceLettersApi = {
  /**
   * The stored signatory, or the defaults.
   *
   * Run back through `readLetterConfig` rather than trusted as-is: the same
   * normalisation the server applies is what makes an unset or half-written
   * setting render a letter instead of an error.
   */
  async getConfig(): Promise<AcceptanceLetterConfig & { signatoryUserId: string | null }> {
    const stored = await convex.query(api.acceptanceLetters.config, { token: requireToken() });
    return {
      ...readLetterConfig(stored),
      // Carried through so the Settings picker can preselect who is chosen.
      signatoryUserId: (stored as { signatoryUserId?: string | null })?.signatoryUserId ?? null,
    };
  },

  /** Staff who may be named as the signatory. */
  async signatoryCandidates(): Promise<{ id: string; fullName: string; email: string }[]> {
    return convex.query(api.acceptanceLetters.signatoryCandidates, { token: requireToken() });
  },

  async saveConfig(input: {
    signatoryUserId: string;
    signatoryTitle: string;
  }): Promise<AcceptanceLetterConfig> {
    const result = await convex.mutation(api.acceptanceLetters.saveConfig, {
      token: requireToken(),
      signatoryUserId: input.signatoryUserId as never,
      signatoryTitle: input.signatoryTitle,
    });

    if (!result.success) throw new Error(result.error);
    return result.config;
  },

  /**
   * Everyone approved, for a batch run.
   *
   * Read from the server rather than filtered out of the admissions table the
   * screen already holds. That table arrives capped at 100 and carries whatever
   * status filter the admin last chose, so "letters for everyone accepted"
   * built from it is the first hundred of the current filter — which looks,
   * to whoever prints it, exactly like everyone.
   */
  async acceptedCandidates(): Promise<AcceptedCandidateBatch> {
    const token = requireToken();
    const candidates: LetterCandidate[] = [];

    let cursor: string | null = null;
    let ceiling = 0;
    let isDone = false;

    // Walked to exhaustion rather than stopped at the first page. Whoever
    // clicked expects letters for everyone approved, and a run that quietly
    // returns the newest few hundred of them looks identical to one that
    // returned all of them — right up until a university asks in September why
    // it never received one.
    while (!isDone && candidates.length < (ceiling || Infinity)) {
      // Annotated because `cursor` is both an input to this call and assigned
      // from its result, which TypeScript cannot infer its way around.
      const page: {
        candidates: LetterCandidate[];
        continueCursor: string;
        isDone: boolean;
        ceiling: number;
      } = await convex.query(api.acceptanceLetters.acceptedCandidates, { token, cursor });

      candidates.push(...page.candidates);
      ceiling = page.ceiling;
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    return { candidates, truncated: !isDone, ceiling };
  },
};
