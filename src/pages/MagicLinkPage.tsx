import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { logError } from '../lib/monitoring';

/**
 * Redeems a magic sign-in link.
 *
 * This route did not exist. `orbit_request_magic_link` has always emailed a link
 * to `/magic?token=…`, which fell through to the SPA's catch-all and rendered the
 * login page — so every magic link ever sent appeared to do nothing, and the
 * feature looked broken rather than missing.
 *
 * The token here is a one-time magic token (its own column), NOT a session token:
 * `orbit_verify_magic_link` exchanges it for a 7-day session and clears it, so the
 * emailed link cannot be replayed.
 */
export function MagicLinkPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { loginWithMagicLink } = useAuth();

  useEffect(() => {
    /**
     * The fragment first, the query string as a fallback.
     *
     * New links carry the token after `#`, which the browser never sends to a
     * server and never leaks in a `Referer` — a query string put a live
     * credential into Netlify's logs for the hour it was valid. Links emailed
     * before that change still work, and are still worth honouring: the
     * alternative is telling someone their link is broken because we improved
     * it after they received it.
     *
     * Either way it is erased from the address bar immediately, so it does not
     * survive in history or get copied out of the URL bar.
     */
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('token') ?? searchParams.get('token');

    if (token) {
      window.history.replaceState(null, '', '/magic');
    }

    const redeem = async () => {
      if (!token) {
        setError('This sign-in link is missing its token.');
        return;
      }

      try {
        // Through the CONTEXT, not authService directly.
        //
        // authService.loginWithMagicLink writes the session to localStorage but
        // knows nothing about React state. Calling it straight from here signed
        // the user in and then navigated with `navigate('/')` — a client-side
        // route change, which does not re-run AuthProvider's boot. So `user`
        // stayed null and the app rendered the LOGIN PAGE to someone who had
        // just successfully signed in. The session was real: a manual reload
        // showed them logged in. Clicking a magic link and landing on the login
        // form reads as "magic links are broken", and it is how this was
        // reported.
        //
        // The context's wrapper calls setUser, which is what LoginPage has
        // always used.
        //
        // Verified against CONVEX, which is what minted it. `requestMagicLink`
        // already posts to Convex, so verifying against Supabase meant every
        // emailed link was rejected as invalid.
        const result = await loginWithMagicLink(token);

        if (!result.success) {
          setError(result.error || 'This sign-in link is invalid or has expired.');
          return;
        }

        // Strip the token from the URL before navigating so it does not linger in
        // history, or leak via the Referer header on the next request.
        window.history.replaceState({}, document.title, window.location.pathname);

        navigate('/', { replace: true });
      } catch (err) {
        logError(err, { context: 'MagicLinkPage.redeem' });
        setError('Could not complete sign-in. Please request a new link.');
      }
    };

    redeem();
    // Runs once on mount; the token comes from the URL and does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
          <div className="mx-auto h-14 w-14 bg-red-100 rounded-full flex items-center justify-center">
            <AlertCircle className="h-8 w-8 text-red-600" />
          </div>
          <h1 className="mt-4 text-xl font-bold text-slate-800">Sign-in link problem</h1>
          <p className="mt-2 text-slate-600">{error}</p>
          <Link
            to="/login"
            className="mt-6 inline-flex justify-center px-5 py-2.5 rounded-lg bg-iih-green text-orbit-ink font-semibold hover:opacity-90 transition-opacity"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas flex items-center justify-center p-4">
      <div className="text-center">
        <Loader2 className="h-10 w-10 text-iih-green animate-spin mx-auto" />
        <p className="mt-4 text-slate-600">Signing you in…</p>
      </div>
    </div>
  );
}

export default MagicLinkPage;
