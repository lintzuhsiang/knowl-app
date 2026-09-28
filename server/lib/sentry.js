/**
 * Sentry initialization for the Express backend.
 *
 * Activation is env-gated — if SENTRY_DSN is unset, every export becomes a
 * no-op. This lets dev / CI / local runs skip Sentry entirely without code
 * changes, while production only needs the env var set.
 *
 * Env knobs:
 *   SENTRY_DSN              required to activate; otherwise no-op
 *   SENTRY_ENVIRONMENT      defaults to NODE_ENV or 'development'
 *   SENTRY_TRACES_SAMPLE_RATE  defaults to 0.1 (10% of requests traced)
 *   SENTRY_RELEASE          optional commit SHA — set by CI to tag releases
 *
 * Usage in server/index.js:
 *   import { initSentry, sentryRequestHandler, sentryErrorHandler } from './lib/sentry.js';
 *   initSentry();                              // call BEFORE creating the app
 *   app.use(sentryRequestHandler());           // before routes
 *   // ... routes ...
 *   app.use(sentryErrorHandler());             // after routes, before final handler
 */

import * as Sentry from '@sentry/node';

let enabled = false;

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN unset — error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    // Don't capture PII by default — the agent sees user notes, we shouldn't
    // ship them to Sentry. Override per-event if you need request bodies for
    // a specific issue.
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip the auth token from request headers if present
      if (event.request?.headers) {
        delete event.request.headers['x-auth-token'];
        delete event.request.headers['cookie'];
        delete event.request.headers['authorization'];
      }
      return event;
    },
  });
  enabled = true;
  console.log(`[sentry] initialized (env=${process.env.SENTRY_ENVIRONMENT || 'development'})`);
}

/**
 * Express middleware that opens a Sentry scope per request. Tags it with
 * userId / workspaceId after requireAuth populates them so Sentry events
 * are tied to the actual user.
 */
export function sentryRequestHandler() {
  return (req, res, next) => {
    if (!enabled) return next();
    Sentry.withScope((scope) => {
      // Tag user/workspace lazily — these get set by requireAuth on routes
      // that need auth. For unauthenticated endpoints (login/register/healthz)
      // they stay null.
      res.on('finish', () => {
        if (req.user?.id) scope.setUser({ id: req.user.id });
        if (req.workspaceId) scope.setTag('workspace_id', req.workspaceId);
      });
      next();
    });
  };
}

/**
 * Express error handler. Mount AFTER all routes but BEFORE your final
 * error-rendering middleware. Forwards 5xx errors to Sentry; 4xx are
 * user errors and not worth alerting on.
 */
export function sentryErrorHandler() {
  return (err, req, res, next) => {
    if (!enabled) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      Sentry.captureException(err);
    }
    next(err);
  };
}

/** Manual capture — for catch blocks that don't bubble up to express. */
export function captureException(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function captureMessage(msg, level = 'info') {
  if (!enabled) return;
  Sentry.captureMessage(msg, level);
}
