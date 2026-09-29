import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ORG_NAME, ORG_SHORT_NAME, OAUTH_DOMAIN_HINT } from '../../config/org';
import { Link } from 'react-router-dom';
import { Mail, Lock, Loader2, FlaskConical } from 'lucide-react';
// Official Zoho wordmark, from https://www.zoho.com/branding/
// (zohowebstatic.com/sites/zweb/images/commonroot/zoho-logo-web.svg). Vendored
// rather than hotlinked so the login page has no third-party request before the
// user is authenticated, and so the asset cannot change under us.
import zohoLogo from '../../assets/zoho-logo.svg';

const SITE_NAME = 'ORBIT';
/**
 * The real ORBIT wordmark, bundled.
 *
 * Was https://ilorininnovationhub.com/public/orbit.png, which 404s — so the
 * SIGN-IN SCREEN led with a broken image, and it is the first thing every new
 * intern sees. A first fix used the PWA app icon; this is the actual logo.
 */
import orbitLogo from '../../assets/orbit-logo.png';
const SITE_LOGO = orbitLogo;
const IS_DEV = import.meta.env.DEV;

const DEV_ACCOUNTS = [
  { label: 'Admin', email: 'demo.admin@orbit.test', password: 'DemoAdmin123!', badge: 'admin' },
  { label: 'Stream Lead', email: 'demo.lead1@orbit.test', password: 'Lead1Pass!', badge: 'lead' },
  { label: 'Intern', email: 'demo.intern1@orbit.test', password: 'Intern123!', badge: 'intern' },
] as const;

export function LoginPage() {
  const { login, requestMagicLink } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(email, password);

    if (!result.success) {
      setError(result.error || 'Login failed');
    }

    setLoading(false);
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await requestMagicLink(email);

    if (result.success) {
      setMagicLinkSent(true);
    } else {
      setError(result.error || 'Failed to send magic link');
    }

    setLoading(false);
  };

  const handleQuickLogin = async (email: string, password: string) => {
    setError('');
    setLoading(true);
    const result = await login(email, password);
    if (!result.success) setError(result.error || 'Login failed');
    setLoading(false);
  };

  const handleZohoLogin = () => {
    // Convex's /zoho/init, not the Supabase edge function. httpActions live on
    // .convex.site; queries and mutations on .convex.cloud.
    const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

    if (!convexUrl) {
      setError('Single sign-on is not configured.');
      return;
    }

    window.location.href = `${convexUrl.replace('.convex.cloud', '.convex.site')}/zoho/init`;
  };

  if (magicLinkSent) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center p-4">
        <div className="orbit-panel w-full max-w-md p-8 text-center">
          <div className="w-16 h-16 bg-orbit-mint rounded-lg flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-iih-green-dark" />
          </div>
          <h2 className="text-2xl font-bold text-orbit-ink mb-2">Check your email</h2>
          <p className="text-orbit-muted mb-6">
            We've sent a magic link to <span className="font-medium">{email}</span>.
            Click the link in the email to sign in.
          </p>
          <button
            onClick={() => {
              setMagicLinkSent(false);
              setShowMagicLink(false);
            }}
            className="text-iih-green hover:text-iih-green-dark font-medium"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas flex items-center justify-center p-4">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-lg border border-orbit-line bg-orbit-surface shadow-orbit-md md:grid-cols-[0.9fr_1.1fr]">
        <div className="hidden bg-orbit-ink p-8 text-white md:flex md:flex-col md:justify-between">
          <div>
            <div className="mb-6 inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase text-iih-green">
              ORBIT Control
            </div>
            <h1 className="text-3xl font-bold text-white">Internship operations, logs, and community in one place.</h1>
            <p className="mt-4 text-sm leading-6 text-slate-300">
              Streams, task reviews, SIWES logbooks, attendance, supervisor sign-off, and cohort reporting for {ORG_NAME}.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {['SIWES logs', 'Stream tasks', 'Review queues', 'Cohort reports'].map((item) => (
              <div key={item} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200">
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 sm:p-8">
        <div className="text-center mb-8">
          <img
            src={SITE_LOGO}
            alt={`${SITE_NAME} Logo`}
            className="h-20 w-auto mx-auto mb-4 object-contain"
          />
          <p className="text-orbit-muted">Sign in to your ORBIT workspace</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        {!showMagicLink ? (
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-orbit-graphite mb-2">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="orbit-input pl-10"
                  placeholder="your@email.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-orbit-graphite mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="orbit-input pl-10"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-iih-green hover:bg-iih-green-dark text-orbit-ink font-bold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}
              Sign In
            </button>
          </form>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <div>
              <label htmlFor="magic-email" className="block text-sm font-semibold text-orbit-graphite mb-2">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="magic-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="orbit-input pl-10"
                  placeholder="your@email.com"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-iih-green hover:bg-iih-green-dark text-orbit-ink font-bold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}
              Send Magic Link
            </button>
          </form>
        )}

        {/* Zoho SSO is how every staff member signs in, but it was a small grey
            underlined link below the fold of the form, reading as fine print.
            Promoted to a standard federated-sign-in button: same weight as the
            primary action, matching the Google/Microsoft convention users
            already recognise. */}
        {/* Switches the form above between password and magic link, so it belongs
            with the form rather than down among the page's other links. */}
        <div className="mt-4 text-center">
          <button
            onClick={() => setShowMagicLink(!showMagicLink)}
            className="text-sm font-medium text-iih-green hover:text-iih-green-dark"
          >
            {showMagicLink ? 'Sign in with password instead' : 'Send me a magic link instead'}
          </button>
        </div>

        <div className="mt-5">
          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-3 text-xs font-medium uppercase tracking-wide text-slate-400">
                or
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleZohoLogin}
            disabled={loading}
            // Without this the name concatenates to "Sign in withZoho" — the
            // label text and the logo's alt are adjacent nodes, so the visual
            // gap contributes no whitespace to the accessible name.
            aria-label="Sign in with Zoho"
            className="mt-4 w-full flex items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white py-3 px-4 font-semibold text-orbit-graphite shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-iih-green focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>Sign in with</span>
            {/* The asset is the ZOHO wordmark, so the button reads
                "Sign in with [ZOHO]" — repeating the word alongside it would be
                redundant. alt carries the name into the accessible label. */}
            {/* h-7, not the h-4 an icon would take: this asset is the four-square
                lockup with "ZOHO" set beneath it, so at icon size the mark
                collapses into unreadable coloured specks. */}
            <img src={zohoLogo} alt="Zoho" className="h-7 w-auto shrink-0" />
          </button>
          <p className="mt-2 text-center text-xs text-slate-500">
            For {ORG_SHORT_NAME} staff with an @{OAUTH_DOMAIN_HINT} account
          </p>
        </div>

        {/* Applying is a different intent from signing in — it is for people who
            have no account at all. It used to sit above the magic-link toggle,
            splitting the sign-in options around it, so the page read as one flat
            list of unrelated links. The three ways to sign in (password, magic
            link, Zoho) are now grouped together above, and this is separated by a
            rule. */}
        <div className="mt-8 border-t border-slate-200 pt-5 text-center">
          <p className="text-sm text-slate-500">Don't have an ORBIT account yet?</p>
          <Link
            to="/apply"
            className="mt-1 inline-block text-sm font-semibold text-iih-green hover:text-iih-green-dark"
          >
            Apply for ORBIT / SIWES placement
          </Link>
        </div>

        {IS_DEV && (
          <div className="mt-6 border-t-2 border-dashed border-amber-300 pt-5">
            <div className="flex items-center gap-2 mb-3">
              <FlaskConical className="w-4 h-4 text-amber-600" />
              <span className="text-xs font-semibold text-amber-700 uppercase tracking-wider">
                Dev Mode — Quick Login
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {DEV_ACCOUNTS.map(({ label, email, password, badge }) => (
                <button
                  key={email}
                  onClick={() => handleQuickLogin(email, password)}
                  disabled={loading}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-800 transition-colors disabled:opacity-50 text-center"
                >
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    badge === 'admin' ? 'bg-red-100 text-red-700' :
                    badge === 'lead'  ? 'bg-blue-100 text-blue-700' :
                                        'bg-green-100 text-green-700'
                  }`}>
                    {label}
                  </span>
                  <span className="text-xs text-amber-600 leading-tight">{email}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-amber-500 mt-2 text-center">
              Demo data must be installed via Admin → Settings → Seed Data
            </p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
