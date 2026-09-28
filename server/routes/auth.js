import { Router } from 'express';
import {
  createUser, findUserByEmail, findUserById, verifyPassword,
  getPasswordHashForUser,
  createSession, deleteSession,
  listWorkspacesForUser, createWorkspace,
  exportUserData, deleteUserCompletely,
  createEmailVerificationToken, consumeEmailVerificationToken,
  createPasswordResetToken, consumePasswordResetToken,
  DEFAULTS,
} from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { invalidateUsageCache } from '../middleware/token-budget.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/mail.js';
import { captureException } from '../lib/sentry.js';

const router = Router();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

router.post('/register', (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (findUserByEmail(email)) return res.status(409).json({ error: 'Email already in use' });

    const user = createUser({ email, password, display_name });
    const ws = createWorkspace({
      name: `${display_name || email}'s workspace`,
      ownerId: user.id,
    });
    const { token } = createSession(user.id, SESSION_TTL_MS);

    // Fire-and-forget verification email. Failure here must NOT block
    // registration — the user can request a resend from AccountSettings.
    try {
      const verifyToken = createEmailVerificationToken(user.id, user.email);
      sendVerificationEmail({ to: user.email, token: verifyToken }).catch(err => {
        console.error('[auth/register] verification email failed:', err.message);
        captureException(err, { route: 'register', user_id: user.id });
      });
    } catch (err) {
      console.error('[auth/register] failed to issue verify token:', err.message);
    }

    res.json({ token, user, default_workspace_id: ws.id, workspaces: [ws] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const row = findUserByEmail(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { token } = createSession(row.id, SESSION_TTL_MS);
    const user = findUserById(row.id);
    const workspaces = listWorkspacesForUser(row.id);
    res.json({ token, user, workspaces, default_workspace_id: workspaces[0]?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  deleteSession(req.headers['x-auth-token']);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    workspaces: listWorkspacesForUser(req.user.id),
    current_workspace_id: req.workspaceId,
  });
});

router.get('/workspaces', requireAuth, (req, res) => {
  res.json(listWorkspacesForUser(req.user.id));
});

router.post('/workspaces', requireAuth, (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.json(createWorkspace({ name, ownerId: req.user.id }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Email verification + password reset ──────────────────────────────────
/**
 * POST /api/auth/verify-email
 * Body: { token }
 *
 * Consumes a verification token issued at register. Single-use; expires in
 * 7 days. Unauthenticated — the token IS the credential.
 */
router.post('/verify-email', (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const row = consumeEmailVerificationToken(token);
    if (!row) return res.status(410).json({ error: 'Token invalid or expired' });
    res.json({ ok: true, email: row.email });
  } catch (e) {
    captureException(e, { route: 'verify-email' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/resend-verification
 * Authenticated. Re-issues a verification token and sends the email. Used
 * by AccountSettingsModal when the user clicks "Resend verification email"
 * on the unverified banner.
 */
router.post('/resend-verification', requireAuth, (req, res) => {
  try {
    if (!req.user.email) {
      return res.status(400).json({ error: 'Account has no email to verify' });
    }
    if (req.user.email_verified_at) {
      return res.status(409).json({ error: 'Email already verified' });
    }
    const token = createEmailVerificationToken(req.user.id, req.user.email);
    sendVerificationEmail({ to: req.user.email, token }).catch(err => {
      console.error('[auth/resend-verification] send failed:', err.message);
      captureException(err, { route: 'resend-verification', user_id: req.user.id });
    });
    res.json({ ok: true });
  } catch (e) {
    captureException(e, { route: 'resend-verification' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 *
 * ALWAYS returns 200 regardless of whether the email is registered.
 * Returning a different status for "no such email" would let an attacker
 * enumerate registered emails. Real users see "we sent a reset link if
 * the email matches an account" either way.
 */
router.post('/forgot-password', (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = findUserByEmail(email.trim());
    if (user) {
      const token = createPasswordResetToken(user.id);
      sendPasswordResetEmail({ to: user.email, token }).catch(err => {
        console.error('[auth/forgot-password] send failed:', err.message);
        captureException(err, { route: 'forgot-password', user_id: user.id });
      });
    }
    // Anti-enumeration: same response shape whether or not the email matched
    res.json({ ok: true });
  } catch (e) {
    captureException(e, { route: 'forgot-password' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/reset-password
 * Body: { token, password }
 *
 * Consuming the token: updates password_hash, marks token used, AND deletes
 * every active session for the user (forces re-login everywhere — defense
 * against the case where a compromised account is being recovered).
 */
router.post('/reset-password', (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const userId = consumePasswordResetToken(token, password);
    if (!userId) return res.status(410).json({ error: 'Token invalid, used, or expired' });

    res.json({ ok: true });
  } catch (e) {
    captureException(e, { route: 'reset-password' });
    res.status(500).json({ error: e.message });
  }
});

// ─── GDPR endpoints ────────────────────────────────────────────────────────
/**
 * GET /api/auth/me/export
 *
 * Right of access (GDPR Art. 15). Returns a JSON dump of every row that
 * touches the caller's identity — user record, sessions metadata, all
 * workspaces they're a member of, plus every workspace's graphs / nodes /
 * edges / chat_messages / node_suggestions / agent_traces.
 *
 * Frontend typically downloads this as `knowl-export-YYYY-MM-DD.json`. We set
 * a Content-Disposition hint so curl / browsers do the right thing.
 */
router.get('/me/export', requireAuth, (req, res) => {
  try {
    const data = exportUserData(req.user.id);
    if (!data) return res.status(404).json({ error: 'User not found' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="knowl-export-${stamp}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(data, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/auth/me
 * Body: { password: "...", confirm: "DELETE MY ACCOUNT" }
 *
 * Right of erasure (GDPR Art. 17). Hard-deletes the user, their sessions,
 * and every solo workspace they own. Shared workspaces (where someone else
 * is a member) get ownership transferred to the oldest other member rather
 * than nuked — destroying co-members' data isn't ours to do.
 *
 * Two layers of protection beyond the session token:
 *   1. Re-authentication: must re-send the account password. Skipped for
 *      accounts that don't have one (open-dev mode legacy users).
 *   2. Typed confirmation string — prevents one-click accidents.
 *
 * The default-user account (open-dev / legacy AUTH_SECRET mode) is refused
 * because it's a shared identity, not a real user.
 */
router.delete('/me', requireAuth, (req, res) => {
  try {
    if (req.user.id === DEFAULTS.USER_ID) {
      return res.status(403).json({
        error: 'Cannot delete the default account (used by open-dev / legacy auth mode)',
      });
    }

    const { password, confirm } = req.body || {};

    if (confirm !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({
        error: 'Confirmation required',
        hint: 'Send {"password":"...","confirm":"DELETE MY ACCOUNT"}',
      });
    }

    const passwordHash = getPasswordHashForUser(req.user.id);
    if (passwordHash) {
      if (!password) {
        return res.status(400).json({ error: 'Password required to confirm deletion' });
      }
      if (!verifyPassword(password, passwordHash)) {
        return res.status(401).json({ error: 'Password verification failed' });
      }
    }

    const result = deleteUserCompletely(req.user.id);
    if (!result) return res.status(404).json({ error: 'User not found' });

    // Token-budget cache holds aggregates keyed by user_id — drop it so the
    // 30s TTL doesn't leak a freshly-deleted user's numbers.
    invalidateUsageCache(req.user.id);

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
