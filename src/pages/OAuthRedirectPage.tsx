import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { convexSiteUrl } from '../lib/convex';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';

export function OAuthRedirectPage() {
  const navigate = useNavigate();
  const { loginWithZoho } = useAuth();
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    const handleOAuthCallback = async () => {
      try {
        const params = new URLSearchParams(window.location.search);

        const success = params.get('success');
        const errorParam = params.get('error');
        const code = params.get('code');
        const state = params.get('state');

        // A RAW Zoho callback: Zoho redirects the browser straight here with
        // ?code=&state=, because its registered redirect URI is this app URL.
        // Those params are Zoho's authorization code, NOT the one-time code this
        // page exchanges below — so hand them to the Convex callback, which
        // performs the token exchange, resolves/creates the user, mints a
        // one-time code, and redirects back here with ?success=true&code=<ours>.
        //
        // Bouncing through it this way means the Zoho app's registered redirect
        // URI can stay as the plain app URL — no Zoho console change — while the
        // secret-bearing token exchange still happens server-side.
        //
        // STRAIGHT TO CONVEX. This used to hit `/api/zoho-oauth-callback`, a
        // Supabase edge function reached through an `/api/* -> functions/v1/*`
        // proxy in netlify.toml. That proxy was deliberately removed at cutover,
        // so the browser landed on a path that no longer existed and Zoho
        // sign-in — the way every staff member signs in — stopped working
        // silently: no error, just the app URL with a code in the query string.
        //
        // Detected by "has code but no success flag", which is unambiguous: our
        // own callback always sets success.
        if (code && !success && !errorParam) {
          const forward = new URLSearchParams({ code });
          if (state) forward.set('state', state);
          window.location.replace(`${convexSiteUrl}/zoho/callback?${forward.toString()}`);
          return;
        }

        // Capture which params actually arrived BEFORE clearing them, so a
        // failure can say what came back instead of a generic message. Values are
        // deliberately not shown — only key names and lengths — because `code`
        // is a live credential and must not be rendered or logged.
        const received = Array.from(params.keys());
        const paramSummary = received.length
          ? received.map((k) => `${k}(${(params.get(k) || '').length})`).join(', ')
          : 'none';

        // Clear all OAuth params from URL immediately
        window.history.replaceState({}, document.title, window.location.pathname);

        if (success === 'false' || errorParam) {
          setError(errorParam || 'Authentication failed. Please try again.');
          setProcessing(false);
          return;
        }

        if (success === 'true' && code) {
          // Exchange the one-time code server-side for a real session.
          // This prevents URL token injection attacks.
          // Exchanged against CONVEX. Going to Supabase here persisted a
          // SUPABASE token and a uuid-shaped user under the _v2 keys — the
          // cross-backend contamination the key versioning exists to prevent,
          // and a session Convex cannot revoke, expire or deactivate.
          //
          // Through the CONTEXT, not authService directly. The service writes
          // the session to localStorage but knows nothing about React state,
          // and the `navigate('/')` below is a client-side route change that
          // does not re-run AuthProvider's boot — so `user` stayed null and
          // ProtectedRoute rendered the LOGIN PAGE to someone who had just
          // signed in through Zoho, until a manual reload. The context's
          // wrapper calls setUser; MagicLinkPage documents the same trap.
          const result = await loginWithZoho(code);

          if (!result.success) {
            setError(result.error || 'Failed to complete authentication. Please try again.');
            setProcessing(false);
            return;
          }

          navigate('/', { replace: true });
          return;
        }

        // Include which parameters actually came back. "Invalid OAuth response"
        // alone gave no way to tell apart: Zoho returning nothing, a stale cached
        // JS chunk running the old logic, or the bounce above not firing.
        setError(
          `Invalid OAuth response. Please try again. (received: ${paramSummary})`,
        );
        setProcessing(false);
      } catch {
        setError('An unexpected error occurred. Please try again.');
        setProcessing(false);
      }
    };

    handleOAuthCallback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (processing) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
          <Loader2 className="w-16 h-16 animate-spin text-iih-green mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-slate-800 mb-2">Signing you in...</h2>
          <p className="text-slate-600">Please wait while we complete your authentication.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-8 h-8 text-red-600" />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Authentication Failed</h2>
        <p className="text-slate-600 mb-6">{error}</p>
        <a
          href="/"
          className="inline-block bg-iih-green hover:bg-iih-green-dark text-white font-medium py-3 px-6 rounded-lg transition-colors"
        >
          Back to Login
        </a>
      </div>
    </div>
  );
}
