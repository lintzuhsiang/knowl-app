/**
 * Rate-limit middleware configs.
 *
 * Uses express-rate-limit's in-memory store. Fine for single-instance deploy
 * (Path A in deployment doc). For multi-instance you'd swap in a Redis store
 * (rate-limit-redis package). All limits are per-window — when the window
 * rolls over, the count resets.
 *
 * Keying:
 *   - Auth routes  → keyed by IP (anti-bruteforce; no user yet)
 *   - Authed routes → keyed by user_id when available, else by IP
 *
 * Returns 429 with retry-after when triggered. Frontend should surface this
 * as a toast / banner — see Toast handling in ChatPanel.
 */

import rateLimit from 'express-rate-limit';

const minute = 60 * 1000;

// Key extractor: prefer authenticated user id; fall back to IP. The auth
// middleware sets req.user before these limiters run for /api/* routes.
const userOrIpKey = (req) => req.user?.id || req.ip;

// Standardized 429 body so frontend can pattern-match
function rateLimitHandler(req, res /*, next, options */) {
  const retryAfter = res.getHeader('Retry-After');
  res.status(429).json({
    error: 'Too many requests',
    code: 'RATE_LIMITED',
    retry_after_seconds: typeof retryAfter === 'string' ? parseInt(retryAfter, 10) : retryAfter,
  });
}

// ── Auth: anti-bruteforce ──
export const loginLimiter = rateLimit({
  windowMs: 15 * minute,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // IP only — these run before authentication
  handler: rateLimitHandler,
});

export const registerLimiter = rateLimit({
  windowMs: 60 * minute,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// ── LLM routes: cost guard ──
// Catches obvious abuse (loops). Token budget enforcement (see token-budget.js)
// handles the slower-burn case where a user makes many cheap calls.
export const aiAgentLimiter = rateLimit({
  windowMs: 10 * minute,
  max: 30,                              // 30 agent turns / 10min per user
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

export const aiChatLimiter = rateLimit({
  windowMs: 10 * minute,
  max: 60,                              // 60 chat turns / 10min per user
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

// ── Data routes: chatty endpoints, generous cap ──
// Catches runaway frontend loops (bug or malicious). Normal interactive use
// stays well under this.
export const dbReadLimiter = rateLimit({
  windowMs: 1 * minute,
  max: 600,                             // 600 reads/min per user
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

// View tracking fires on every drill; needs a wider cap of its own.
export const viewTrackingLimiter = rateLimit({
  windowMs: 1 * minute,
  max: 200,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

// ── Confirm endpoint: agent's tool-result reply ──
// Should be once per agent turn — tight cap catches abuse.
export const confirmLimiter = rateLimit({
  windowMs: 1 * minute,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

// ── Email flow: anti-bruteforce + anti-enumeration ──
// Forgot-password is keyed by IP because the user isn't authed yet.
// The endpoint itself always returns 200 regardless of whether the email
// exists (anti-enumeration), but a 3/h cap prevents mass scanning.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * minute,
  max: 3,
  standardHeaders: true, legacyHeaders: false,
  handler: rateLimitHandler,
});

// Reset-password and verify-email: tighter — token guessing is the threat.
// 10/15min by IP catches automated probing without blocking real users who
// click the link twice.
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * minute,
  max: 10,
  standardHeaders: true, legacyHeaders: false,
  handler: rateLimitHandler,
});
