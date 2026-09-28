/**
 * Sentry init for the React frontend.
 *
 * Env-gated like the backend — set `VITE_SENTRY_DSN` in `.env.production`
 * (or `window.KNOWL_SENTRY_DSN` at runtime for Capacitor builds) to activate.
 * No DSN → all exports are no-ops.
 *
 * Sentry captures unhandled errors, unhandled promise rejections, and React
 * error boundary throws. We strip auth tokens from any captured fetch
 * requests so they don't leak into the dashboard.
 */

import * as Sentry from '@sentry/react';

let enabled = false;

export function initSentry() {
  const dsn =
    (typeof window !== 'undefined' && window.KNOWL_SENTRY_DSN) ||
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SENTRY_DSN);

  if (!dsn) {
    if (typeof console !== 'undefined') {
      console.log('[sentry] VITE_SENTRY_DSN unset — frontend error tracking disabled');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env?.MODE || 'production',
    release: import.meta.env?.VITE_SENTRY_RELEASE,
    tracesSampleRate: parseFloat(import.meta.env?.VITE_SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    integrations: [
      Sentry.browserTracingIntegration(),
    ],
    // Don't capture PII by default — agent text + node bodies are sensitive
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip auth headers from any captured fetch breadcrumb
      const breadcrumbs = event.breadcrumbs || [];
      for (const b of breadcrumbs) {
        if (b.category === 'fetch' && b.data?.request_headers) {
          delete b.data.request_headers['x-auth-token'];
          delete b.data.request_headers['Authorization'];
        }
      }
      return event;
    },
  });
  enabled = true;
  console.log('[sentry] frontend initialized');
}

/** Tag the current Sentry scope with the logged-in user id. */
export function setUser(userId) {
  if (!enabled) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Manual capture for catch blocks. */
export function captureException(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** React error boundary wrapper. Use to wrap the app root. */
export const ErrorBoundary = Sentry.ErrorBoundary;
