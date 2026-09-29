import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import { fn } from './functions.js';
import type { Config } from './env.js';

/**
 * The Convex client, and the session lifecycle around it.
 *
 * The server holds no long-lived credential beyond the shared secret. It
 * exchanges that for a 15-minute session and re-mints as needed, so:
 *
 *  - revoking MCP access in Admin > Users takes effect within one session, and
 *    immediately for a session already issued (the mutation deletes it);
 *  - a token captured from this process's memory expires on its own;
 *  - the actor's account state (deactivated, deleted, demoted) is re-checked at
 *    every exchange rather than once at startup, which is all the Supabase
 *    version ever did.
 */

/** Re-mint this far before the deadline rather than racing it. */
const REFRESH_MARGIN_MS = 60_000;

export interface Actor {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

/** What a write reports to the audit log. */
export interface AuditSpec {
  action: string;
  tableName?: string;
  recordId?: string;
  values?: Record<string, unknown>;
  success?: boolean;
  errorMessage?: string;
}

export class ConvexAuthError extends Error {}

/**
 * Convex wraps handler errors in framing that is useless to an agent
 * ("[CONVEX M(tasks:create)] [Request ID: ...] Server Error Uncaught Error: ...").
 * The agent needs the sentence a human wrote.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const message = error.message;
  const uncaught = message.match(/Uncaught Error:\s*([^\n]+)/);
  if (uncaught) return uncaught[1].trim().replace(/\s+at\s+handler.*$/, '');

  const convexError = message.match(/\[CONVEX [^\]]+\]\s*(?:\[Request ID: [^\]]+\]\s*)?(.+)/s);
  if (convexError) return convexError[1].split('\n')[0].trim();

  return message;
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && /\bUnauthorized\b/.test(error.message);
}

export class OrbitClient {
  private readonly convex: ConvexHttpClient;
  private token: string | null = null;
  private expiresAt = 0;
  private actorValue: Actor | null = null;
  /** Serialises concurrent re-auth so a burst of tool calls mints one session. */
  private pending: Promise<void> | null = null;

  constructor(private readonly config: Config) {
    this.convex = new ConvexHttpClient(config.convexUrl);
  }

  get actor(): Actor {
    if (!this.actorValue) throw new Error('Not authenticated');
    return this.actorValue;
  }

  /** Exchanges the shared secret for a session. Safe to call concurrently. */
  async authenticate(): Promise<void> {
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const result = await this.convex.mutation(fn.authenticate, { secret: this.config.secret });

      if (!result.success) {
        this.token = null;
        this.actorValue = null;
        throw new ConvexAuthError(result.error);
      }

      this.token = result.token;
      this.expiresAt = result.expiresAt;
      this.actorValue = result.actor;
    })().finally(() => {
      this.pending = null;
    });

    return this.pending;
  }

  private async freshToken(): Promise<string> {
    if (!this.token || Date.now() > this.expiresAt - REFRESH_MARGIN_MS) {
      await this.authenticate();
    }
    return this.token!;
  }

  /**
   * Runs a call with a valid token, re-authenticating once if the deployment
   * rejects it anyway.
   *
   * The retry matters because expiry is not the only way a token dies: the
   * sweeper cron, an admin toggling MCP access off and on, or a redeploy can all
   * invalidate one mid-session. Retried exactly once — a persistent
   * "Unauthorized" means access was revoked, and hammering it would bury the
   * real reason under a retry loop.
   */
  private async withSession<T>(run: (token: string) => Promise<T>): Promise<T> {
    const token = await this.freshToken();
    try {
      return await run(token);
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      await this.authenticate();
      return run(this.token!);
    }
  }

  /**
   * The `as never` on the argument is unavoidable, and is contained to these two
   * lines. ConvexHttpClient types its args as `OptionalRestArgs<Ref>`, a
   * conditional on whether the function takes arguments at all; with `Args` still
   * generic here TS cannot evaluate that conditional. Every call site is checked
   * against the declarations in functions.ts, which is where the real contract
   * lives.
   */
  async query<Args extends { token: string }, Ret>(
    ref: FunctionReference<'query', 'public', Args, Ret>,
    args: Omit<Args, 'token'>,
  ): Promise<Ret> {
    return this.withSession((token) => this.convex.query(ref, { ...args, token } as never));
  }

  async mutation<Args extends { token: string }, Ret>(
    ref: FunctionReference<'mutation', 'public', Args, Ret>,
    args: Omit<Args, 'token'>,
  ): Promise<Ret> {
    return this.withSession((token) => this.convex.mutation(ref, { ...args, token } as never));
  }

  /**
   * A write, plus its audit record. The ONLY way a tool performs a mutation.
   *
   * The Supabase version called `auditMcpAction` by hand at the end of each
   * tool, and five of the twenty-five simply did not — `update_setting`,
   * `mark_message_read` and the three that returned early on error wrote nothing
   * at all. Routing every write through one function is what makes the audit
   * trail a property of the design rather than a thing each tool remembers.
   *
   * `deriveAudit` runs against the RESULT, so the audit row can carry the id the
   * mutation assigned.
   */
  async mutateAudited<Args extends { token: string }, Ret>(
    ref: FunctionReference<'mutation', 'public', Args, Ret>,
    args: Omit<Args, 'token'>,
    audit: {
      action: string;
      tableName?: string;
      /** Extra detail, read from the result. Called only when the write succeeded. */
      onSuccess?: (result: Ret) => { recordId?: string; values?: Record<string, unknown> };
    },
  ): Promise<Ret> {
    // The ACTION is known before the call, independent of how it turns out.
    // Deriving it from the result meant a thrown error had no action name to
    // record — which is how denials ended up unaudited.
    let result: Ret;

    try {
      result = await this.mutation(ref, args);
    } catch (error) {
      await this.audit({
        action: audit.action,
        tableName: audit.tableName,
        success: false,
        errorMessage: describeError(error),
      });
      throw error;
    }

    // An expected refusal — `{ success: false, error }` — is a denial too, and
    // was previously as invisible as a thrown one. Only successes were recorded,
    // so the log held no trace of a rejected privilege change.
    const reported = result as unknown as { success?: boolean; error?: string };
    if (reported?.success === false) {
      await this.audit({
        action: audit.action,
        tableName: audit.tableName,
        success: false,
        errorMessage: reported.error,
      });
      return result;
    }

    const detail = audit.onSuccess?.(result);
    await this.audit({
      action: audit.action,
      tableName: audit.tableName,
      recordId: detail?.recordId,
      values: detail?.values,
    });

    return result;
  }

  /**
   * Writes an audit row. Never throws.
   *
   * A failed audit must not turn a completed write into a reported failure — the
   * write already happened, and telling the agent it failed invites a retry that
   * duplicates it. Surfaced on stderr instead, matching the previous behaviour.
   */
  async audit(spec: AuditSpec): Promise<void> {
    try {
      await this.mutation(fn.recordAudit, {
        action: spec.action,
        tableName: spec.tableName,
        recordId: spec.recordId,
        values: spec.values,
        success: spec.success,
        errorMessage: spec.errorMessage,
      });
    } catch (error) {
      console.error(`MCP audit failed for ${spec.action}: ${describeError(error)}`);
    }
  }
}
