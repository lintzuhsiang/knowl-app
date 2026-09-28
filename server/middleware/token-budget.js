/**
 * Token-budget enforcement middleware.
 *
 * Aggregates a user's LLM token usage in the last 24h across all their
 * workspaces (chat + agent). If they exceed the daily cap, returns 429 with
 * structured info so the frontend can show "you've hit your daily limit".
 *
 * Limits are env-configurable. Default is generous enough for personal use,
 * tight enough that a runaway client can't burn $50 in one afternoon.
 *
 * Caching: aggregating across many traces gets expensive. We cache per-user
 * usage in memory with a 30s TTL. Allowed to be slightly stale — at most
 * 30 seconds of overshoot per user.
 */

import { getUserTokenUsage } from '../db.js';

const DAILY_TOKEN_BUDGET = parseInt(process.env.LLM_DAILY_TOKEN_BUDGET || '200000', 10);
const CACHE_TTL_MS = 30 * 1000;

/** Map<userId, { value: number, ts: number }> */
const usageCache = new Map();

function readUsage(userId) {
  const cached = usageCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  const since = Date.now() - 24 * 3600 * 1000;
  const value = getUserTokenUsage(userId, since);
  usageCache.set(userId, { value, ts: Date.now() });
  return value;
}

/** Invalidate cache after a known burst (e.g. agent finishes a turn). */
export function invalidateUsageCache(userId) {
  if (userId) usageCache.delete(userId);
}

/**
 * Express middleware. Mount AFTER requireAuth so req.user is set.
 *
 *   app.use('/api/ai', requireAuth, tokenBudgetMiddleware, aiRouter)
 *
 * Skips enforcement if:
 *   - No req.user (shouldn't happen post-requireAuth, but defensive)
 *   - User has `daily_token_budget_override` column == 0 (admin / unlimited)
 *   - LLM_DAILY_TOKEN_BUDGET env var is 0
 */
export function tokenBudgetMiddleware(req, res, next) {
  if (!req.user?.id) return next();
  if (DAILY_TOKEN_BUDGET === 0) return next();

  const used = readUsage(req.user.id);
  if (used >= DAILY_TOKEN_BUDGET) {
    // Reset at next UTC midnight
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
      0, 0, 0, 0
    ));
    return res.status(429).json({
      error: 'Daily token budget exceeded',
      code: 'TOKEN_BUDGET_EXCEEDED',
      used,
      limit: DAILY_TOKEN_BUDGET,
      resets_at: tomorrow.getTime(),
    });
  }
  next();
}

/** Read-only endpoint for the frontend to show "X of Y tokens used today". */
export function tokenBudgetStatusHandler(req, res) {
  if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
  const used = readUsage(req.user.id);
  res.json({
    used,
    limit: DAILY_TOKEN_BUDGET,
    remaining: Math.max(0, DAILY_TOKEN_BUDGET - used),
    pct: DAILY_TOKEN_BUDGET ? Math.min(100, Math.round((used / DAILY_TOKEN_BUDGET) * 100)) : 0,
  });
}
