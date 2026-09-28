/**
 * Auth + workspace resolution.
 *
 *  - If AUTH_SECRET is set: token must be either the master secret (→ default user)
 *    or a valid session token from /api/auth/login.
 *  - If AUTH_SECRET is unset: open dev mode — auto-attach to default user.
 *
 *  - Workspace is resolved from the `x-workspace-id` header. Falls back to the
 *    caller's first workspace. Membership is enforced before the route runs.
 *
 * Populates `req.user` and `req.workspaceId` for downstream handlers.
 */
import {
  findSession, findUserById, isWorkspaceMember,
  getDefaultWorkspaceForUser, DEFAULTS,
} from '../db.js';

export function requireAuth(req, res, next) {
  // Idempotent — when multiple middleware chains stack requireAuth (e.g.
  // rate-limit chain + router-level chain) just pass through if already set.
  if (req.user && req.workspaceId) return next();

  const token = req.headers['x-auth-token'];
  let userId = null;

  if (process.env.AUTH_SECRET) {
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    if (token === process.env.AUTH_SECRET) {
      userId = DEFAULTS.USER_ID;
    } else {
      const session = findSession(token);
      if (session) userId = session.user_id;
    }
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  } else {
    // Open dev mode — still resolve to a real user for tenancy correctness.
    if (token) {
      const session = findSession(token);
      if (session) userId = session.user_id;
    }
    if (!userId) userId = DEFAULTS.USER_ID;
  }

  const user = findUserById(userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const requestedWs = req.headers['x-workspace-id'];
  const workspaceId = requestedWs || getDefaultWorkspaceForUser(userId);
  if (!workspaceId) return res.status(403).json({ error: 'No workspace available' });

  if (!isWorkspaceMember(workspaceId, userId)) {
    return res.status(403).json({ error: 'Forbidden: not a member of this workspace' });
  }

  req.user = user;
  req.workspaceId = workspaceId;
  next();
}
