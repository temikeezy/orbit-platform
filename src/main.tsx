import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.tsx';
import { ConvexProvider } from 'convex/react';
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx';
import { convex } from './lib/convex.ts';
import { initMonitoring } from './lib/monitoring.ts';
import './index.css';

initMonitoring();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Convex is the only backend. The provider carries the WebSocket that
          makes `useQuery` live; the imperative modules use the HTTP client. */}
      <ConvexProvider client={convex}>
        <ErrorBoundary>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              borderRadius: '8px',
              background: '#1e293b',
              color: '#f1f5f9',
              fontSize: '14px',
            },
            success: {
              iconTheme: { primary: '#2DD881', secondary: '#1e293b' },
            },
            error: {
              iconTheme: { primary: '#ef4444', secondary: '#1e293b' },
            },
          }}
        />
        </ErrorBoundary>
      </ConvexProvider>
    </BrowserRouter>
  </StrictMode>
);

/**
 * Reload once when a new service worker takes over.
 *
 * The worker is built with `skipWaiting` + `clientsClaim`, so a fresh deploy
 * activates and claims open pages immediately — but claiming does not reload
 * anything. The tab carries on running the JavaScript it already loaded, which
 * means a user who last opened ORBIT before a deploy is routing through the OLD
 * router: any route added since is unknown to it, and clicking a link to one
 * renders "not found" for a page that exists.
 *
 * That is not hypothetical. A supervisor clicked an emailed link to
 * /tasks/proposals and got "Task not found", because their cached bundle had no
 * such route and parsed "proposals" as a task id. The same stale-worker
 * behaviour produced two false "your fix didn't work" reports during the Convex
 * migration.
 *
 * `refreshing` guards the reload: `controllerchange` can fire more than once,
 * and an unguarded reload here is an infinite loop.
 */
if ('serviceWorker' in navigator) {
  /**
   * Only when an EXISTING worker is replaced.
   *
   * `controllerchange` also fires the first time a worker claims a page that
   * had none — every first visit — and reloading there interrupts a page that
   * is already current, aborting whatever it had in flight. The e2e suite
   * caught it immediately as "Failed to fetch" on a stream that loads fine.
   * A null controller at startup means there is nothing stale to escape.
   */
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
