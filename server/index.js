// IMPORTANT: Sentry must be imported and init'd BEFORE express so its
// instrumentation can wrap the http module. Keep this block at the very top.
import { initSentry, sentryRequestHandler, sentryErrorHandler } from './lib/sentry.js';
initSentry();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import graphRouter from './routes/graph.js';
import notionRouter from './routes/notion.js';
import authRouter from './routes/auth.js';
import aiRouter from './routes/ai.js';
import agentRouter from './routes/agent.js';
import { requireAuth } from './middleware/auth.js';
import {
  loginLimiter, registerLimiter,
  aiAgentLimiter, aiChatLimiter,
  dbReadLimiter, viewTrackingLimiter, confirmLimiter,
  forgotPasswordLimiter, resetPasswordLimiter,
} from './middleware/rate-limit.js';
import {
  tokenBudgetMiddleware, tokenBudgetStatusHandler,
} from './middleware/token-budget.js';
import { findSession } from './db.js';
import { startJobs } from './lib/jobs.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Trust ALB / proxy so req.ip reflects the real client (rate-limit accuracy).
// 1 = trust one hop (typical: behind one ALB). Set to higher if multi-proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// ── Security headers (helmet) ────────────────────────────────────────────────
// We're a pure JSON / SSE API — never serve HTML — so CSP and the
// embedder-policy lockdown are irrelevant. We DO want HSTS, frameguard,
// noSniff, referrer policy, and the rest of the safe defaults.
//
// crossOriginResourcePolicy is relaxed to 'cross-origin' because the SPA may
// be served from a different origin (e.g. api.knowl.com vs app.knowl.com)
// and the default 'same-origin' would block legitimate fetches.
//
// If this Express ever starts serving the SPA HTML too, re-enable CSP with
// directives that allow Google Fonts + inline styles (React inline `style`).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS — wide-open in dev, lock to specific origins in production.
// Set CORS_ORIGIN=https://app.example.com,https://www.example.com (csv).
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));

app.use(express.json({ limit: '10mb' }));

// Sentry request scope — no-op if SENTRY_DSN unset. Sits after body parser so
// the scope has access to req.user once requireAuth fires downstream.
app.use(sentryRequestHandler());

// ── Health / status ──────────────────────────────────────────────────────────
// Original health (kept for AuthGate compat — reports auth state).
app.get('/api/db/health', (req, res) => {
  const needsAuth = !!process.env.AUTH_SECRET;
  const token = req.headers['x-auth-token'];
  let authed = !needsAuth;
  if (token) {
    if (process.env.AUTH_SECRET && token === process.env.AUTH_SECRET) authed = true;
    else if (findSession(token)) authed = true;
  }
  res.json({ ok: true, ts: Date.now(), needsAuth, authed });
});

// Deep health check — used by ALB target groups. Pings DB so we know if SQLite is up.
app.get('/healthz', async (req, res) => {
  try {
    // Use the same DB module the rest of the app uses
    const { default: db } = await import('./db.js');
    db.prepare('SELECT 1').get();
    res.json({ ok: true, db: 'up', uptime: Math.floor(process.uptime()) });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

// ── Auth routes (with anti-bruteforce rate limits) ──────────────────────────
// Path-specific limiters MUST come before the router mount so they intercept first.
app.use('/api/auth/login',            loginLimiter);
app.use('/api/auth/register',         registerLimiter);
app.use('/api/auth/forgot-password',  forgotPasswordLimiter);
app.use('/api/auth/reset-password',   resetPasswordLimiter);
app.use('/api/auth/verify-email',     resetPasswordLimiter); // share — token-guessing threat is the same
app.use('/api/auth', authRouter);

// Token budget status — small read-only endpoint for the frontend to show usage
app.get('/api/auth/budget', requireAuth, tokenBudgetStatusHandler);

// ── Data routes (per-user rate-limited) ──────────────────────────────────────
// View tracking is high-frequency — its own wider limiter wins via path specificity.
app.use('/api/db/nodes/:nodeId/view', requireAuth, viewTrackingLimiter);
app.use('/api/db', requireAuth, dbReadLimiter, graphRouter);
app.use('/api/db/notion', requireAuth, notionRouter);

// ── AI routes (rate-limited + token budget enforced) ─────────────────────────
// Order: auth → rate-limit → budget → router. The router itself doesn't
// reapply auth (requireAuth is idempotent — see auth.js).
app.use('/api/ai/chat',    requireAuth, aiChatLimiter,  tokenBudgetMiddleware);
app.use('/api/ai/agent',   requireAuth, aiAgentLimiter, tokenBudgetMiddleware);
app.use('/api/ai/agent/confirm', requireAuth, confirmLimiter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/ai', requireAuth, agentRouter);

// Sentry error handler must come AFTER all routes but BEFORE any final
// error-rendering middleware. Forwards 5xx errors to Sentry, lets 4xx pass.
app.use(sentryErrorHandler());

app.listen(PORT, () => {
  console.log(`knowl server running on http://localhost:${PORT}`);
  // Start backup + cleanup cron jobs after the server is accepting connections.
  // (Set DISABLE_JOBS=1 to skip — useful in tests / dev.)
  startJobs();
});
