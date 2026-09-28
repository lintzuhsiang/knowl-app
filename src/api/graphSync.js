/**
 * graphSync.js — bridge between the knowl frontend and the Express/SQLite backend.
 *
 * Strategy:
 *  - localStorage is the immediate source of truth (zero latency for UI)
 *  - Server is kept in sync via fire-and-forget PUTs
 *  - On app startup, server wins if it has a newer timestamp
 *  - If server is unreachable, app works fully offline
 *  - Auth token (if required) is stored in localStorage
 */

/**
 * API base URL resolution.
 *
 *   - Dev (browser):   '/api/db' → Vite proxy → :3001
 *   - Production web:  '/api/db' → same-origin
 *   - Capacitor / iOS: window.KNOWL_API_BASE if set (e.g. "https://api.knowl.app/api/db")
 *                      OR VITE_API_BASE at build time
 *
 * For Capacitor builds you MUST either:
 *   1. Set `server.url` in capacitor.config.json (points the WebView at your
 *      web origin, e.g. https://app.knowl.com — then '/api/db' is same-origin), OR
 *   2. Set VITE_API_BASE in .env.production before `npm run build` (absolute URL).
 *
 * For dev iOS testing, capacitor.config.json's `server.url` points at the
 * dev machine's LAN address, so relative paths just work through Vite proxy.
 */
const API_BASE = (
  (typeof window !== 'undefined' && window.KNOWL_API_BASE) ||
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) ||
  ''
);
const SERVER = `${API_BASE}/api/db`;
const AUTH_KEY = 'knowl_auth_token';
const WORKSPACE_KEY = 'knowl_workspace_id';

// ─── Auth token ──────────────────────────────────────────────────────────────
export function getAuthToken() { return localStorage.getItem(AUTH_KEY) || ''; }
export function setAuthToken(token) { localStorage.setItem(AUTH_KEY, token); }
export function clearAuthToken() { localStorage.removeItem(AUTH_KEY); }

// ─── Workspace selection (multi-tenant) ──────────────────────────────────────
export function getWorkspaceId() { return localStorage.getItem(WORKSPACE_KEY) || ''; }
export function setWorkspaceId(id) {
  if (id) localStorage.setItem(WORKSPACE_KEY, id);
  else localStorage.removeItem(WORKSPACE_KEY);
}

function authHeaders() {
  const headers = {};
  const token = getAuthToken();
  if (token) headers['x-auth-token'] = token;
  const ws = getWorkspaceId();
  if (ws) headers['x-workspace-id'] = ws;
  return headers;
}

function authFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
}

// ─── Health check ────────────────────────────────────────────────────────────
let _serverAvailable = null; // null = untested, true/false = known

/**
 * Returns { ok, needsAuth, authed } or { ok: false } if unreachable.
 */
export async function checkServer() {
  try {
    const r = await authFetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    _serverAvailable = r.ok;
    return data; // { ok, ts, needsAuth, authed }
  } catch {
    _serverAvailable = false;
    return { ok: false, needsAuth: false, authed: false };
  }
}

export function isServerAvailable() { return _serverAvailable; }

// ─── Load graph on startup ────────────────────────────────────────────────────
/**
 * Returns merged graph state:
 * 1. Start with SEED (hardcoded default)
 * 2. Overlay localStorage
 * 3. Overlay server data if server has anything newer
 */
export async function loadGraphFromServer() {
  try {
    const r = await authFetch(`${SERVER}/graphs`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    _serverAvailable = true;

    const metas = await r.json(); // [{topic, label, updated_at}]
    if (!metas.length) return null;

    const result = {};
    await Promise.all(metas.map(async ({ topic }) => {
      const gr = await authFetch(`${SERVER}/graphs/${topic}`, { signal: AbortSignal.timeout(3000) });
      if (!gr.ok) return;
      result[topic] = await gr.json();
    }));

    return Object.keys(result).length ? result : null;
  } catch {
    _serverAvailable = false;
    return null;
  }
}

// ─── Save graph (fire and forget) ────────────────────────────────────────────
/**
 * `graph` is the full graph object keyed by topic:
 * { "system-design": { label, nodeMap, edges }, ... }
 */
export function saveGraphToServer(graph) {
  if (_serverAvailable === false) return; // skip if known offline

  const now = Date.now();
  for (const [topic, data] of Object.entries(graph)) {
    authFetch(`${SERVER}/graphs/${topic}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: data.label || topic,
        nodeMap: data.nodeMap || {},
        edges: data.edges || [],
        inlineNotes: data.inlineNotes || [],
        updated_at: now,
      }),
    }).then(r => {
      _serverAvailable = r.ok;
    }).catch(() => {
      _serverAvailable = false;
    });
  }
}

// ─── Debounce helper ─────────────────────────────────────────────────────────
const timers = {};
export function debouncedSave(graph, delay = 1500) {
  clearTimeout(timers._save);
  timers._save = setTimeout(() => saveGraphToServer(graph), delay);
}

// ─── Sync polling (multi-device) ─────────────────────────────────────────────
/**
 * Polls server every `interval` ms while tab is visible.
 * Calls `onUpdate(serverGraph)` when server has data.
 * Returns cleanup function.
 */
export function startSyncPolling(onUpdate, interval = 30000) {
  const id = setInterval(async () => {
    if (document.hidden) return;
    if (_serverAvailable === false) return;
    const serverData = await loadGraphFromServer();
    if (serverData) onUpdate(serverData);
  }, interval);
  return () => clearInterval(id);
}

// ─── Online/offline reconnect ────────────────────────────────────────────────
/**
 * When browser comes back online, re-check server and sync.
 * `getLocalGraph` returns current graph state.
 * `onServerData` merges server data into local state.
 * Returns cleanup function.
 */
export function setupOnlineSync(getLocalGraph, onServerData, onStatusChange) {
  const handleOnline = async () => {
    const health = await checkServer();
    if (health.ok && health.authed) {
      onStatusChange?.('saving');
      const serverData = await loadGraphFromServer();
      if (serverData) onServerData(serverData);
      saveGraphToServer(getLocalGraph());
      onStatusChange?.('saved');
    } else {
      onStatusChange?.('offline');
    }
  };

  const handleOffline = () => {
    _serverAvailable = false;
    onStatusChange?.('offline');
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

// ─── Memory metadata ─────────────────────────────────────────────────────────
/** Fire-and-forget view tracking. Call when a node is opened / drilled into. */
export function trackNodeView(nodeId) {
  if (_serverAvailable === false) return;
  authFetch(`${SERVER}/nodes/${encodeURIComponent(nodeId)}/view`, { method: 'POST' })
    .catch(() => { /* silent */ });
}

/** Update recall_score for a node (0..1). Used after Test mode answers. */
export function setNodeRecall(nodeId, score) {
  return authFetch(`${SERVER}/nodes/${encodeURIComponent(nodeId)}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ score }),
  });
}

/** Fetch memory stats (viewed_at / recall_score / etc) for a topic. */
export async function loadMemoryStats(topic) {
  try {
    const r = await authFetch(`${SERVER}/memory/${encodeURIComponent(topic)}`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// ─── Chat history persistence ────────────────────────────────────────────────
/** Load persisted chat history for a canvas (root topic or drill-in key). */
export async function loadChatHistory(canvasKey) {
  try {
    const r = await authFetch(`${SERVER}/chat/${encodeURIComponent(canvasKey)}`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/**
 * Append a single message to a canvas's history. Fire-and-forget by default
 * (the AI route persists the user/assistant pair itself via `persist:` flag —
 * this helper is for manual messages like "/clear" markers or system events).
 */
export function appendChatMessage(canvasKey, { role, content, meta }) {
  if (_serverAvailable === false) return;
  authFetch(`${SERVER}/chat/${encodeURIComponent(canvasKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, content, meta }),
  }).catch(() => { /* silent */ });
}

/** Clear all chat history for a canvas. */
export function clearChatHistory(canvasKey) {
  return authFetch(`${SERVER}/chat/${encodeURIComponent(canvasKey)}`, { method: 'DELETE' });
}

// ─── Suggestions (merge / conflict proposals) ────────────────────────────────
export async function loadSuggestions(canvasKey, status = 'pending') {
  try {
    const r = await authFetch(
      `${SERVER}/suggestions/${encodeURIComponent(canvasKey)}?status=${status}`
    );
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

export async function createSuggestion(canvasKey, type, payload) {
  const r = await authFetch(`${SERVER}/suggestions/${encodeURIComponent(canvasKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  });
  return r.ok ? r.json() : null;
}

export function resolveSuggestion(id, status) {
  return authFetch(`${SERVER}/suggestions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }), // 'accepted' | 'dismissed'
  });
}

// ─── Notion import ────────────────────────────────────────────────────────────
/**
 * text: raw string from file read (markdown or JSON)
 * topic: current topic slug
 * Returns { mappings, edges } for use with FusionModal, or throws on error.
 */
export async function importFromNotion(text, topic) {
  const r = await authFetch(`${SERVER}/notion/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, topic }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Import failed' }));
    throw new Error(err.error || 'Import failed');
  }
  return r.json(); // { mappings, edges, nodeCount }
}
