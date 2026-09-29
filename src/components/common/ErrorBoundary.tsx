import { Component, Fragment, ReactNode } from 'react';
import { AlertCircle, Home, RefreshCw } from 'lucide-react';
import { logError } from '../../lib/monitoring';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * Recorded on the logged error so a caught crash can be traced back to
   * which boundary caught it — there is more than one now (see App.tsx's
   * route-level boundary), and "ErrorBoundary caught something" is not
   * useful on its own once that is true.
   */
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /**
   * Bumped on every reset and used as a `key` on the recovered subtree, so
   * "Try again" always mounts a genuinely fresh instance rather than one
   * React might otherwise be tempted to reuse.
   */
  resetCount: number;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, resetCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Pick<State, 'hasError' | 'error'> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // The one place a crash is guaranteed to land — every render error in
    // the tree below this boundary ends up here — was, until now, the one
    // place that did not report it. It only ever went to a console nobody
    // watches in production.
    logError(error, { boundary: this.props.name ?? 'unnamed', componentStack: info.componentStack });

    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught:', error, info.componentStack);
    }
  }

  handleReset = () => {
    this.setState((prev) => ({ hasError: false, error: null, resetCount: prev.resetCount + 1 }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="min-h-[200px] flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-red-600" />
            </div>
            <h2 className="text-lg font-semibold text-slate-800 mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-500 mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 bg-iih-green hover:bg-iih-green-dark text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                Try again
              </button>
              {/*
                A plain anchor, not a router Link. A deterministic crash —
                bad cached data, not a one-off render glitch — throws again
                the instant "Try again" remounts, trapping someone on a dead
                page with no way out but the URL bar. A full navigation lands
                on a route that does not carry whatever caused the crash,
                instead of reproducing it.
              */}
              <a
                href="/"
                className="inline-flex items-center gap-2 border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium px-4 py-2 rounded-lg transition-colors text-sm"
              >
                <Home className="w-4 h-4" />
                Go home
              </a>
            </div>
          </div>
        </div>
      );
    }

    return <Fragment key={this.state.resetCount}>{this.props.children}</Fragment>;
  }
}
