import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/react';
import { beforeSend } from '../../lib/monitoring';

/**
 * Production has never had a Sentry DSN, so nothing has ever left the browser.
 * The moment one is configured, every breadcrumb and request URL starts being
 * sent to a third party — and MagicLinkPage accepts the sign-in token from
 * `searchParams` as well as the fragment, so `?token=<live one-time credential>`
 * is a URL this app genuinely visits.
 *
 * These tests exist because that failure is silent and external: if the scrubber
 * regresses, ORBIT behaves identically and the credential is simply gone.
 */

const event = (partial: Partial<ErrorEvent>): ErrorEvent => partial as ErrorEvent;

describe('Sentry beforeSend scrubber', () => {
  it('strips the query string from the request URL', () => {
    const out = beforeSend(
      event({ request: { url: 'https://orbit2.iih.ng/magic?token=abc123secret' } }),
    );
    expect(out.request?.url).toBe('https://orbit2.iih.ng/magic');
    expect(JSON.stringify(out)).not.toContain('abc123secret');
  });

  it('strips the fragment too', () => {
    const out = beforeSend(
      event({ request: { url: 'https://orbit2.iih.ng/magic#token=abc123secret' } }),
    );
    expect(out.request?.url).toBe('https://orbit2.iih.ng/magic');
  });

  it('drops query_string, which would otherwise ship what the URL strip removed', () => {
    const out = beforeSend(
      event({ request: { url: 'https://orbit2.iih.ng/magic', query_string: 'token=abc123secret' } }),
    );
    expect(out.request?.query_string).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('abc123secret');
  });

  it('redacts token-shaped params inside breadcrumb messages', () => {
    const out = beforeSend(
      event({
        breadcrumbs: [
          { message: 'navigated to /magic?token=abc123secret', timestamp: 0 },
        ],
      }),
    );
    expect(JSON.stringify(out)).not.toContain('abc123secret');
  });

  it('redacts by key name anywhere in extras, at any depth', () => {
    const out = beforeSend(
      event({
        extra: {
          harmless: 'keep me',
          nested: {
            token: 'abc123secret',
            authorization: 'Bearer abc123secret',
            orbit_auth_token_v2: 'abc123secret',
            deeper: { password: 'hunter2', secret: 'shh' },
          },
        },
      }),
    );

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('abc123secret');
    expect(serialised).not.toContain('hunter2');
    // Redaction must not be so broad that it destroys the diagnostic value of
    // the report — the whole point of sending it is to be able to read it.
    expect(serialised).toContain('keep me');
  });

  it('scrubs the exception message, where a thrown URL commonly lands', () => {
    const out = beforeSend(
      event({
        exception: {
          values: [{ type: 'Error', value: 'GET /magic?token=abc123secret failed' }],
        },
      }),
    );
    expect(JSON.stringify(out)).not.toContain('abc123secret');
  });

  it('survives an event with none of the fields it scrubs', () => {
    // beforeSend runs on every event; throwing here would suppress error
    // reporting entirely, which is worse than the leak it guards against.
    expect(() => beforeSend(event({}))).not.toThrow();
  });

  it('does not hang on a deeply nested structure', () => {
    let deep: Record<string, unknown> = { token: 'abc123secret' };
    for (let i = 0; i < 50; i++) deep = { nested: deep };

    const out = beforeSend(event({ extra: deep }));
    // Depth-bounded, so the innermost value may survive; what matters is that
    // it terminates rather than that it reaches the bottom.
    expect(out).toBeDefined();
  });
});
