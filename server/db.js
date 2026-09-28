import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'knowl.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const DEFAULT_USER_ID = 'default-user';
const DEFAULT_WORKSPACE_ID = 'default-workspace';

// ─── Tenancy tables ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    password_hash TEXT,
    display_name  TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member',
    joined_at    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
`);

// ─── Graph tables (legacy shape — migration upgrades to multi-tenant) ─────
db.exec(`
  CREATE TABLE IF NOT EXISTS graphs (
    topic      TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    topic      TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS edges (
    id         TEXT PRIMARY KEY,
    topic      TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`);

// ─── Migrations (idempotent) ──────────────────────────────────────────────
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}

// M1: multi-tenant shape (Phase 1)
const migrateMultiTenant = db.transaction(() => {
  if (columnExists('graphs', 'workspace_id')) return;

  const now = Date.now();

  db.prepare(`
    INSERT OR IGNORE INTO users (id, email, display_name, created_at)
    VALUES (?, NULL, 'Default User', ?)
  `).run(DEFAULT_USER_ID, now);

  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, name, owner_id, created_at)
    VALUES (?, 'Default Workspace', ?, ?)
  `).run(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, now);

  db.prepare(`
    INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
    VALUES (?, ?, 'owner', ?)
  `).run(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, now);

  db.exec(`
    CREATE TABLE graphs_v2 (
      workspace_id TEXT NOT NULL,
      topic        TEXT NOT NULL,
      label        TEXT NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, topic)
    );
  `);
  db.prepare(`
    INSERT INTO graphs_v2 (workspace_id, topic, label, updated_at)
    SELECT ?, topic, label, updated_at FROM graphs
  `).run(DEFAULT_WORKSPACE_ID);
  db.exec(`DROP TABLE graphs;`);
  db.exec(`ALTER TABLE graphs_v2 RENAME TO graphs;`);

  db.exec(`ALTER TABLE nodes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}';`);
  db.exec(`ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}';`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_ws_topic ON nodes(workspace_id, topic);
    CREATE INDEX IF NOT EXISTS idx_edges_ws_topic ON edges(workspace_id, topic);
  `);
});
migrateMultiTenant();

// M2: memory metadata on nodes (Phase 2)
// viewed_at: ms timestamp of last open. viewed_count: cumulative opens.
// edited_at: ms timestamp of last write (auto-bumped on putNode).
// recall_score: 0.0–1.0, set by Test mode; NULL = never tested.
const migrateMemoryMetadata = db.transaction(() => {
  if (!columnExists('nodes', 'viewed_at')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN viewed_at    INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`ALTER TABLE nodes ADD COLUMN viewed_count INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`ALTER TABLE nodes ADD COLUMN edited_at    INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`ALTER TABLE nodes ADD COLUMN recall_score REAL;`);
    db.exec(`UPDATE nodes SET edited_at = updated_at WHERE edited_at = 0;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_viewed_at ON nodes(workspace_id, viewed_at);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_recall   ON nodes(workspace_id, recall_score);`);
  }
});
migrateMemoryMetadata();

// M3: chat persistence + suggestion proposals (Phase 2)
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    canvas_key   TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    meta         TEXT,
    ts           INTEGER NOT NULL,
    streaming    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_canvas
    ON chat_messages(workspace_id, canvas_key, ts);

  CREATE TABLE IF NOT EXISTS node_suggestions (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    canvas_key   TEXT NOT NULL,
    type         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_node_suggestions_canvas
    ON node_suggestions(workspace_id, canvas_key, status);
`);

// M5: email verification + password reset tokens (pre-launch round 3)
// Adds users.email_verified_at + two short-lived token tables. Tokens are
// random hex strings (server/db.js issues via crypto.randomBytes); they live
// 7d for verification and 1h for password reset. Expired rows are pruned by
// the daily cron in jobs.js.
const migrateEmailTokens = db.transaction(() => {
  if (!columnExists('users', 'email_verified_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verified_at INTEGER;`);
  }
});
migrateEmailTokens();

db.exec(`
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_verification_user
    ON email_verification_tokens(user_id);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_user
    ON password_reset_tokens(user_id);
`);

// M4: agent trace persistence (Phase 4 — tool-calling Agent)
// One row per agent turn. tool_calls is a JSON array of
// {id, name, input, result?, error?, duration_ms, ts}.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_traces (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    canvas_key      TEXT NOT NULL,
    chat_message_id TEXT,
    user_message    TEXT,
    iterations      INTEGER NOT NULL DEFAULT 0,
    tool_calls      TEXT NOT NULL DEFAULT '[]',
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    total_cost      REAL    NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'running',
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    meta            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_traces_canvas
    ON agent_traces(workspace_id, canvas_key, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_traces_status
    ON agent_traces(workspace_id, status);
`);

// ─── User helpers ─────────────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export const findUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email);

export const findUserById = (id) =>
  db.prepare('SELECT id, email, display_name, created_at, email_verified_at FROM users WHERE id = ?').get(id);

// Separate query that includes password_hash — only call this when actually
// re-authenticating (e.g. confirming account deletion). Keep findUserById
// password-free so it can't accidentally leak the hash via /me etc.
export const getPasswordHashForUser = (id) =>
  db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash;

export function createUser({ id, email, password, display_name }) {
  const userId = id || crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, email || null, password ? hashPassword(password) : null, display_name || null, now);
  return findUserById(userId);
}

// ─── Session helpers ──────────────────────────────────────────────────────
export function createSession(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = ttlMs ? now + ttlMs : null;
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, userId, now, now, expires_at);
  return { token, expires_at };
}

export function findSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now(), token);
  return row;
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ─── Workspace helpers ────────────────────────────────────────────────────
export function listWorkspacesForUser(userId) {
  return db.prepare(`
    SELECT w.id, w.name, w.owner_id, w.created_at, wm.role
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY w.created_at ASC
  `).all(userId);
}

export function getDefaultWorkspaceForUser(userId) {
  return db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? ORDER BY w.created_at ASC LIMIT 1
  `).get(userId)?.id;
}

export function isWorkspaceMember(workspaceId, userId) {
  return !!db.prepare(`
    SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId);
}

export const createWorkspace = db.transaction(({ name, ownerId }) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, name, ownerId, now);
  db.prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
    VALUES (?, ?, 'owner', ?)
  `).run(id, ownerId, now);
  return { id, name, owner_id: ownerId, created_at: now, role: 'owner' };
});

export const DEFAULTS = { USER_ID: DEFAULT_USER_ID, WORKSPACE_ID: DEFAULT_WORKSPACE_ID };

// ─── Email verification + password reset token helpers ──────────────────────
const EMAIL_VERIFY_TTL_MS  = 7 * 24 * 60 * 60 * 1000;   // 7 days
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;            // 1 hour

/** Issue a verification token for a (user, email) pair. Returns the token. */
export function createEmailVerificationToken(userId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(`
    INSERT INTO email_verification_tokens (token, user_id, email, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, userId, email, now + EMAIL_VERIFY_TTL_MS, now);
  return token;
}

/**
 * Look up + atomically consume a verification token. Returns the matching
 * row on success, null if not found / expired / already used. Marks the
 * user as verified inside a transaction so partial state can't leak.
 */
export const consumeEmailVerificationToken = db.transaction((token) => {
  const row = db.prepare(`
    SELECT * FROM email_verification_tokens WHERE token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM email_verification_tokens WHERE token = ?`).run(token);
    return null;
  }
  db.prepare(`UPDATE users SET email_verified_at = ? WHERE id = ?`)
    .run(Date.now(), row.user_id);
  // Consume by deletion — verification tokens are single-use
  db.prepare(`DELETE FROM email_verification_tokens WHERE token = ?`).run(token);
  // Drop any older pending verification rows for the same user
  db.prepare(`DELETE FROM email_verification_tokens WHERE user_id = ?`).run(row.user_id);
  return row;
});

/** Issue a password reset token. Returns the token string. */
export function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // Invalidate any prior unused reset tokens for this user — one in flight at a time
  db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL`).run(userId);
  db.prepare(`
    INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now + PASSWORD_RESET_TTL_MS, now);
  return token;
}

/**
 * Validate + consume a password reset token. On success: updates the user's
 * password_hash, marks the token used, and DELETES every active session for
 * the user (forces re-login everywhere — standard practice after pw reset).
 * Returns the user_id on success, null on failure.
 */
export const consumePasswordResetToken = db.transaction((token, newPassword) => {
  const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;

  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .run(hashPassword(newPassword), row.user_id);
  db.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE token = ?`)
    .run(Date.now(), token);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id);
  return row.user_id;
});

/** Cron cleanup — drop tokens past their expiry plus a grace window. */
export function deleteExpiredEmailTokens() {
  const r1 = db.prepare(`DELETE FROM email_verification_tokens WHERE expires_at < ?`).run(Date.now());
  // Keep used reset tokens for 30d for audit, then nuke
  const r2 = db.prepare(`
    DELETE FROM password_reset_tokens
     WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)
  `).run(Date.now(), Date.now() - 30 * 86400000);
  return { verification: r1.changes, reset: r2.changes };
}

// ─── Graph metadata (workspace-scoped) ────────────────────────────────────
export const listGraphs = (workspaceId) =>
  db.prepare('SELECT topic, label, updated_at FROM graphs WHERE workspace_id = ?').all(workspaceId);

export const getGraph = (workspaceId, topic) => {
  const meta = db.prepare('SELECT * FROM graphs WHERE workspace_id = ? AND topic = ?').get(workspaceId, topic);
  if (!meta) return null;
  const nodes = db.prepare('SELECT data FROM nodes WHERE workspace_id = ? AND topic = ?').all(workspaceId, topic);
  const edges = db.prepare('SELECT data FROM edges WHERE workspace_id = ? AND topic = ?').all(workspaceId, topic);
  const nodeMap = {};
  for (const row of nodes) {
    const n = JSON.parse(row.data);
    nodeMap[n.id] = n;
  }
  return {
    topic: meta.topic,
    label: meta.label,
    updated_at: meta.updated_at,
    nodeMap,
    edges: edges.map(r => JSON.parse(r.data)),
  };
};

export const putGraph = db.transaction((workspaceId, topic, label, nodeMap, edgeList, updated_at) => {
  const now = updated_at || Date.now();

  const existing = db.prepare('SELECT updated_at FROM graphs WHERE workspace_id = ? AND topic = ?')
    .get(workspaceId, topic);
  if (!existing || now >= existing.updated_at) {
    db.prepare(`
      INSERT INTO graphs (workspace_id, topic, label, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, topic) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
    `).run(workspaceId, topic, label, now);
  }

  const upsertNode = db.prepare(`
    INSERT INTO nodes (id, workspace_id, topic, data, updated_at, edited_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      topic        = excluded.topic,
      data         = excluded.data,
      updated_at   = excluded.updated_at,
      edited_at    = excluded.edited_at
    WHERE excluded.updated_at >= nodes.updated_at
  `);
  for (const node of Object.values(nodeMap)) {
    upsertNode.run(node.id, workspaceId, topic, JSON.stringify(node), now, now);
  }

  const incomingIds = Object.keys(nodeMap);
  const existingNodes = db.prepare('SELECT id FROM nodes WHERE workspace_id = ? AND topic = ?')
    .all(workspaceId, topic).map(r => r.id);
  const toDelete = existingNodes.filter(id => !incomingIds.includes(id));
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM nodes WHERE workspace_id = ? AND id IN (${placeholders})`)
      .run(workspaceId, ...toDelete);
  }

  const upsertEdge = db.prepare(`
    INSERT INTO edges (id, workspace_id, topic, data, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      topic        = excluded.topic,
      data         = excluded.data,
      updated_at   = excluded.updated_at
    WHERE excluded.updated_at >= edges.updated_at
  `);
  for (const edge of edgeList) {
    upsertEdge.run(edge.id, workspaceId, topic, JSON.stringify(edge), now);
  }

  const incomingEdgeIds = edgeList.map(e => e.id);
  const existingEdges = db.prepare('SELECT id FROM edges WHERE workspace_id = ? AND topic = ?')
    .all(workspaceId, topic).map(r => r.id);
  const edgesToDelete = existingEdges.filter(id => !incomingEdgeIds.includes(id));
  if (edgesToDelete.length > 0) {
    const placeholders = edgesToDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND id IN (${placeholders})`)
      .run(workspaceId, ...edgesToDelete);
  }

  return { topic, updated_at: now };
});

export const putNode = (workspaceId, id, topic, data, updated_at = Date.now()) => {
  db.prepare(`
    INSERT INTO nodes (id, workspace_id, topic, data, updated_at, edited_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      topic        = excluded.topic,
      data         = excluded.data,
      updated_at   = excluded.updated_at,
      edited_at    = excluded.edited_at
    WHERE excluded.updated_at >= nodes.updated_at
  `).run(id, workspaceId, topic, JSON.stringify(data), updated_at, updated_at);
};

export const deleteNode = (workspaceId, id) => {
  db.prepare('DELETE FROM nodes WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
};

export const putEdge = (workspaceId, id, topic, data, updated_at = Date.now()) => {
  db.prepare(`
    INSERT INTO edges (id, workspace_id, topic, data, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      topic        = excluded.topic,
      data         = excluded.data,
      updated_at   = excluded.updated_at
    WHERE excluded.updated_at >= edges.updated_at
  `).run(id, workspaceId, topic, JSON.stringify(data), updated_at);
};

export const deleteEdge = (workspaceId, id) => {
  db.prepare('DELETE FROM edges WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
};

// ─── Memory metadata helpers ──────────────────────────────────────────────
export const bumpNodeView = (workspaceId, id, ts = Date.now()) => {
  db.prepare(`
    UPDATE nodes
       SET viewed_at = ?, viewed_count = viewed_count + 1
     WHERE workspace_id = ? AND id = ?
  `).run(ts, workspaceId, id);
};

export const setNodeRecall = (workspaceId, id, score, ts = Date.now()) => {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0));
  db.prepare(`
    UPDATE nodes
       SET recall_score = ?, viewed_at = ?, viewed_count = viewed_count + 1
     WHERE workspace_id = ? AND id = ?
  `).run(clamped, ts, workspaceId, id);
};

/**
 * Returns memory metadata for one or many nodes (joined view).
 * Useful for warmup/test mode to pick stale / low-recall nodes.
 */
export const getMemoryStats = (workspaceId, topic) => {
  return db.prepare(`
    SELECT id, viewed_at, viewed_count, edited_at, recall_score
      FROM nodes
     WHERE workspace_id = ? AND topic = ?
  `).all(workspaceId, topic);
};

// ─── Chat persistence helpers ─────────────────────────────────────────────
export function appendChatMessage(workspaceId, canvasKey, { id, role, content, meta, streaming }) {
  const msgId = id || crypto.randomUUID();
  const ts = Date.now();
  db.prepare(`
    INSERT INTO chat_messages (id, workspace_id, canvas_key, role, content, meta, ts, streaming)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msgId, workspaceId, canvasKey, role, content || '',
    meta ? JSON.stringify(meta) : null, ts, streaming ? 1 : 0,
  );
  return { id: msgId, ts };
}

export function updateChatMessage(workspaceId, id, { content, meta, streaming }) {
  // Only allow updating fields we explicitly support; never the role/canvas/ts
  const fields = [];
  const args = [];
  if (content !== undefined) { fields.push('content = ?'); args.push(content); }
  if (meta !== undefined)    { fields.push('meta = ?');    args.push(meta ? JSON.stringify(meta) : null); }
  if (streaming !== undefined) { fields.push('streaming = ?'); args.push(streaming ? 1 : 0); }
  if (fields.length === 0) return;
  args.push(workspaceId, id);
  db.prepare(`
    UPDATE chat_messages SET ${fields.join(', ')}
     WHERE workspace_id = ? AND id = ?
  `).run(...args);
}

export function listChatMessages(workspaceId, canvasKey, { limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT id, role, content, meta, ts, streaming
      FROM chat_messages
     WHERE workspace_id = ? AND canvas_key = ?
     ORDER BY ts ASC
     LIMIT ?
  `).all(workspaceId, canvasKey, limit);
  return rows.map(r => ({
    ...r,
    meta: r.meta ? JSON.parse(r.meta) : null,
    streaming: !!r.streaming,
  }));
}

export function clearChatMessages(workspaceId, canvasKey) {
  db.prepare(`DELETE FROM chat_messages WHERE workspace_id = ? AND canvas_key = ?`)
    .run(workspaceId, canvasKey);
}

/**
 * Marks any messages that were left in `streaming=1` state — usually because
 * the connection dropped or the server restarted mid-stream. Called on server
 * startup to clean up zombie rows. Returns count of fixed rows.
 */
export function reapStreamingMessages() {
  const r = db.prepare(`
    UPDATE chat_messages SET streaming = 0
     WHERE streaming = 1
  `).run();
  return r.changes;
}
const reaped = reapStreamingMessages();
if (reaped > 0) console.log(`[knowl] reaped ${reaped} interrupted streaming message(s)`);

// ─── Suggestion helpers (merge / conflict / edge proposals) ───────────────
export function createSuggestion(workspaceId, canvasKey, type, payload) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO node_suggestions (id, workspace_id, canvas_key, type, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, workspaceId, canvasKey, type, JSON.stringify(payload), now);
  return { id, type, payload, status: 'pending', created_at: now };
}

export function listSuggestions(workspaceId, canvasKey, { status = 'pending' } = {}) {
  return db.prepare(`
    SELECT id, type, payload, status, created_at, resolved_at
      FROM node_suggestions
     WHERE workspace_id = ? AND canvas_key = ? AND status = ?
     ORDER BY created_at DESC
  `).all(workspaceId, canvasKey, status).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function resolveSuggestion(workspaceId, id, status) {
  if (!['accepted', 'dismissed'].includes(status)) {
    throw new Error(`invalid suggestion status: ${status}`);
  }
  db.prepare(`
    UPDATE node_suggestions SET status = ?, resolved_at = ?
     WHERE workspace_id = ? AND id = ?
  `).run(status, Date.now(), workspaceId, id);
}

// ─── Agent trace helpers (Phase 4) ────────────────────────────────────────
export function createAgentTrace(workspaceId, canvasKey, { userMessage, meta }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO agent_traces (id, workspace_id, canvas_key, user_message, status, started_at, meta)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
  `).run(
    id, workspaceId, canvasKey, userMessage || null,
    Date.now(), meta ? JSON.stringify(meta) : null,
  );
  return id;
}

export function updateAgentTrace(workspaceId, id, patch) {
  const fields = [];
  const args = [];
  if (patch.iterations    !== undefined) { fields.push('iterations = ?');    args.push(patch.iterations); }
  if (patch.tool_calls    !== undefined) { fields.push('tool_calls = ?');    args.push(JSON.stringify(patch.tool_calls)); }
  if (patch.total_tokens  !== undefined) { fields.push('total_tokens = ?');  args.push(patch.total_tokens); }
  if (patch.total_cost    !== undefined) { fields.push('total_cost = ?');    args.push(patch.total_cost); }
  if (patch.status        !== undefined) { fields.push('status = ?');        args.push(patch.status); }
  if (patch.ended_at      !== undefined) { fields.push('ended_at = ?');      args.push(patch.ended_at); }
  if (patch.chat_message_id !== undefined) { fields.push('chat_message_id = ?'); args.push(patch.chat_message_id); }
  if (fields.length === 0) return;
  args.push(workspaceId, id);
  db.prepare(`UPDATE agent_traces SET ${fields.join(', ')} WHERE workspace_id = ? AND id = ?`).run(...args);
}

export function listAgentTraces(workspaceId, canvasKey, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT id, canvas_key, user_message, iterations, total_tokens, total_cost,
           status, started_at, ended_at
      FROM agent_traces
     WHERE workspace_id = ? AND canvas_key = ?
     ORDER BY started_at DESC
     LIMIT ?
  `).all(workspaceId, canvasKey, limit);
}

export function getAgentTrace(workspaceId, id) {
  const row = db.prepare(`
    SELECT * FROM agent_traces WHERE workspace_id = ? AND id = ?
  `).get(workspaceId, id);
  if (!row) return null;
  return {
    ...row,
    tool_calls: JSON.parse(row.tool_calls || '[]'),
    meta: row.meta ? JSON.parse(row.meta) : null,
  };
}

// ─── Usage aggregation (token budget enforcement) ────────────────────────
/**
 * List all workspace IDs the user owns or is a member of.
 * Used to aggregate token usage across all of a user's workspaces.
 */
export function getUserWorkspaceIds(userId) {
  return db.prepare(`
    SELECT workspace_id FROM workspace_members WHERE user_id = ?
  `).all(userId).map(r => r.workspace_id);
}

/**
 * Sum a user's LLM token usage in a recent window. Aggregates across all
 * of the user's workspaces. Counts:
 *   - agent_traces.total_tokens (Phase 4 agent calls)
 *   - chat_messages.meta.tokens (chat / mode sessions — set in ai.js route)
 */
export function getUserTokenUsage(userId, sinceMs) {
  const wsIds = getUserWorkspaceIds(userId);
  if (wsIds.length === 0) return 0;

  const placeholders = wsIds.map(() => '?').join(',');

  const agentRow = db.prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS sum
      FROM agent_traces
     WHERE workspace_id IN (${placeholders})
       AND started_at > ?
  `).get(...wsIds, sinceMs);

  // chat_messages stores per-assistant-turn tokens in meta.tokens (if known)
  const chatRow = db.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(meta, '$.tokens') AS INTEGER)), 0) AS sum
      FROM chat_messages
     WHERE workspace_id IN (${placeholders})
       AND ts > ?
       AND role = 'assistant'
       AND meta IS NOT NULL
  `).get(...wsIds, sinceMs);

  return (agentRow.sum || 0) + (chatRow.sum || 0);
}

// ─── Cleanup helpers (called by scheduled jobs) ──────────────────────────
/**
 * Delete expired sessions. Returns number of deleted rows.
 * Run nightly via cron.
 */
export function deleteExpiredSessions() {
  const r = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  return r.changes;
}

/**
 * Delete agent traces older than the retention window (default 90 days).
 * Returns number of deleted rows.
 */
export function deleteOldAgentTraces(retentionDays = 90) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const r = db.prepare(`DELETE FROM agent_traces WHERE started_at < ?`).run(cutoff);
  return r.changes;
}

/**
 * Delete resolved suggestions older than retention (default 30 days).
 * Pending suggestions are never auto-deleted.
 */
export function deleteOldResolvedSuggestions(retentionDays = 30) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const r = db.prepare(`
    DELETE FROM node_suggestions
     WHERE status != 'pending' AND resolved_at < ?
  `).run(cutoff);
  return r.changes;
}

/**
 * Run SQLite's VACUUM to reclaim disk space after large deletes.
 * Expensive (locks DB briefly) — only call from off-peak cron.
 */
export function vacuumDb() {
  db.exec('VACUUM');
}

/**
 * Take an atomic snapshot of the database file. Uses better-sqlite3's
 * .backup() which is safe to run while the DB is being written to.
 * @returns Promise<void>
 */
export function backupDb(destinationPath) {
  return db.backup(destinationPath);
}

// ─── GDPR helpers (right of access + right of erasure) ──────────────────────
/**
 * Build the full personal-data export for a user.
 *
 * Returns a JSON-serializable object containing every row that touches this
 * user identity:
 *   - users row (without password_hash)
 *   - active sessions (metadata only — tokens omitted; tokens are credentials,
 *     not personal data, and leaking them defeats the security of the export)
 *   - every workspace the user is a member of, with the user's role
 *   - for each workspace: graphs / nodes / edges / chat_messages /
 *     node_suggestions / agent_traces
 *
 * Note on shared workspaces: chat_messages and agent_traces are scoped by
 * workspace_id, not user_id (no author column). For a workspace shared with
 * others, the export includes the entire workspace's chat/trace history —
 * which the requesting user did have access to. The `shared` flag on each
 * workspace lets the user understand that distinction.
 */
export function exportUserData(userId) {
  const user = findUserById(userId);
  if (!user) return null;

  const sessions = db.prepare(`
    SELECT created_at, last_used_at, expires_at
      FROM sessions WHERE user_id = ?
     ORDER BY created_at DESC
  `).all(userId);

  const memberships = db.prepare(`
    SELECT w.id, w.name, w.owner_id, w.created_at, wm.role, wm.joined_at
      FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = ?
     ORDER BY w.created_at ASC
  `).all(userId);

  const workspaces = memberships.map(ws => {
    const memberCount = db.prepare(
      `SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?`
    ).get(ws.id).n;

    const graphs = db.prepare(`
      SELECT topic, label, updated_at FROM graphs WHERE workspace_id = ?
    `).all(ws.id);

    const nodes = db.prepare(`
      SELECT id, topic, data, updated_at,
             viewed_at, viewed_count, edited_at, recall_score
        FROM nodes WHERE workspace_id = ?
    `).all(ws.id).map(r => ({ ...r, data: JSON.parse(r.data) }));

    const edges = db.prepare(`
      SELECT id, topic, data, updated_at FROM edges WHERE workspace_id = ?
    `).all(ws.id).map(r => ({ ...r, data: JSON.parse(r.data) }));

    const chat_messages = db.prepare(`
      SELECT id, canvas_key, role, content, meta, ts, streaming
        FROM chat_messages WHERE workspace_id = ?
       ORDER BY ts ASC
    `).all(ws.id).map(r => ({
      ...r,
      meta: r.meta ? JSON.parse(r.meta) : null,
      streaming: !!r.streaming,
    }));

    const node_suggestions = db.prepare(`
      SELECT id, canvas_key, type, payload, status, created_at, resolved_at
        FROM node_suggestions WHERE workspace_id = ?
    `).all(ws.id).map(r => ({ ...r, payload: JSON.parse(r.payload) }));

    const agent_traces = db.prepare(`
      SELECT id, canvas_key, chat_message_id, user_message, iterations,
             tool_calls, total_tokens, total_cost, status,
             started_at, ended_at, meta
        FROM agent_traces WHERE workspace_id = ?
    `).all(ws.id).map(r => ({
      ...r,
      tool_calls: JSON.parse(r.tool_calls || '[]'),
      meta: r.meta ? JSON.parse(r.meta) : null,
    }));

    return {
      ...ws,
      shared: memberCount > 1,
      member_count: memberCount,
      graphs, nodes, edges,
      chat_messages, node_suggestions, agent_traces,
    };
  });

  return {
    exported_at: Date.now(),
    user,
    sessions,
    workspaces,
  };
}

/**
 * Hard-delete a user and all data they own.
 *
 * Strategy:
 *   1. For workspaces the user OWNS solo (only member) → delete all
 *      workspace-scoped data first (no FK cascade because workspace_id is a
 *      plain TEXT column, not a foreign key), then the workspace.
 *   2. For workspaces the user OWNS but others are members → transfer
 *      ownership to the oldest member so other members aren't kicked out.
 *      (Alternative: nuke shared workspaces — but that destroys other people's
 *      data, which we can't do under GDPR for the requesting user alone.)
 *   3. For workspaces the user is just a MEMBER of → ON DELETE CASCADE on
 *      workspace_members handles removal when we delete the user row.
 *   4. Delete the user — cascades sessions + workspace_members.
 *
 * Wrapped in a transaction so partial failure leaves no orphans.
 *
 * Returns { deleted_workspaces, transferred_workspaces, left_workspaces }.
 */
export const deleteUserCompletely = db.transaction((userId) => {
  const user = findUserById(userId);
  if (!user) return null;

  const owned = db.prepare(`
    SELECT id FROM workspaces WHERE owner_id = ?
  `).all(userId).map(r => r.id);

  const deletedWorkspaces = [];
  const transferredWorkspaces = [];

  for (const wsId of owned) {
    const otherMembers = db.prepare(`
      SELECT user_id, joined_at FROM workspace_members
       WHERE workspace_id = ? AND user_id != ?
       ORDER BY joined_at ASC
    `).all(wsId, userId);

    if (otherMembers.length === 0) {
      // Solo workspace — hard delete all data
      db.prepare(`DELETE FROM nodes            WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM edges            WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM graphs           WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM chat_messages    WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM node_suggestions WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM agent_traces     WHERE workspace_id = ?`).run(wsId);
      db.prepare(`DELETE FROM workspaces       WHERE id = ?`).run(wsId);
      deletedWorkspaces.push(wsId);
    } else {
      // Shared workspace — transfer ownership to oldest other member.
      // The departing user's workspace_members row gets cascaded when the
      // user row is deleted below.
      const newOwner = otherMembers[0].user_id;
      db.prepare(`UPDATE workspaces        SET owner_id = ? WHERE id = ?`).run(newOwner, wsId);
      db.prepare(`UPDATE workspace_members SET role = 'owner'
                   WHERE workspace_id = ? AND user_id = ?`).run(wsId, newOwner);
      transferredWorkspaces.push({ id: wsId, new_owner: newOwner });
    }
  }

  // Workspaces the user was only a member of — count for the response.
  // (Cascade removes their workspace_members row when we drop the user.)
  const leftWorkspaces = db.prepare(`
    SELECT workspace_id FROM workspace_members
     WHERE user_id = ? AND workspace_id NOT IN (
       SELECT id FROM workspaces WHERE owner_id = ?
     )
  `).all(userId, userId).map(r => r.workspace_id);

  // Final blow — cascades sessions, workspace_members.
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);

  return {
    deleted_workspaces: deletedWorkspaces,
    transferred_workspaces: transferredWorkspaces,
    left_workspaces: leftWorkspaces,
  };
});

/**
 * Reap traces left in 'running' state from a crashed server. Same idea as
 * reapStreamingMessages — mark them as 'interrupted' on startup.
 */
export function reapRunningTraces() {
  const r = db.prepare(`
    UPDATE agent_traces SET status = 'interrupted', ended_at = ?
     WHERE status = 'running'
  `).run(Date.now());
  return r.changes;
}
const reapedTraces = reapRunningTraces();
if (reapedTraces > 0) console.log(`[knowl] reaped ${reapedTraces} interrupted agent trace(s)`);

export default db;
