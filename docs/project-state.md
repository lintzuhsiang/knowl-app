# knowl-app — Project State Checkpoint

**Last updated:** 2026-05-20 (round 3)
**Purpose:** Hand-off doc to start a fresh AI session without re-processing prior conversation history. Paste this into a new chat → ask the AI to confirm understanding → start work.

---

## 1. What this is

A personal knowledge-graph app: React canvas of nodes + edges, with an AI agent that helps the user surface latent structure (curiosity prosthesis, not Q&A). Built solo, for personal/indie use, ~50 nodes per canvas, max ~1000 users target.

**Stack:**
- Frontend: React 18 + Vite, no framework router, no Redux. iOS via Capacitor 8.
- Backend: Node 20 + Express 5, `better-sqlite3` (single-process synchronous SQLite).
- LLM: Google Gemini 2.5 Pro via streaming + function calling. Single API key, server-side.
- Auth: bcrypt + DB sessions (also supports legacy AUTH_SECRET shared-token mode).

---

## 2. Phases completed (high-level)

| Phase | What it did | Key files |
|---|---|---|
| **Phase 1** | All LLM moved server-side via SSE. Multi-tenant schema (users / workspaces / sessions). Frontend never sees Gemini key. | `server/routes/ai.js`, `server/routes/auth.js`, `server/lib/llm/` |
| **Phase 2 M1** | Memory metadata (viewed_at / recall_score / edited_at), chat_messages persistence, node_suggestions table | `server/db.js` |
| **Phase 2 M2** | Structural Context Pack — replaces flat "all node titles" injection with breadcrumb + drill-parent body + hierarchy + edges | `src/lib/graphHelpers.js#buildContextPack` |
| **Phase 3 M3-α** | Slash command infra (parser + autocomplete + mode chip). `/warmup` mode end-to-end. | `src/lib/slashCommands.js`, `src/lib/modes/warmup.js`, `src/components/SlashAutocomplete.jsx` |
| **Phase 3 M3-β** | `/quiz` (closed-book + EMA scoring + decision-tree judging), `/rehearse` (role-play), `/audit` (one-shot LLM scan → suggestions). Bugs fixed in studioModes.js. | `src/lib/modes/{quiz,rehearse,audit}.js` |
| **Phase 4 M4-α** | Hand-rolled agent loop (no LangGraph). 10 tools (8 read + 2 algo discovery). agent_traces DB. Free chat → Agent. Tool cards UI. | `server/lib/agent/{loop,tools}.js`, `server/routes/agent.js`, `src/components/AgentToolCard.jsx` |
| **Phase 4 M4-β** | 6 propose tools. One-click apply. `useGraphMutation.mutCanvas` for atomic node+edge ops. | `src/lib/applySuggestion.js` |
| **Phase 4 M4-α.5** | 5 LLM-powered discovery tools (suggest_bridges / expand_concept / infer_implicit_concepts / find_conceptual_gaps / infer_node_overlap). Sub-LLM helper. | `server/lib/agent/subllm.js` |
| **Phase 4 M4-γ** (partial) | Stop button + `confirm_with_user` (blocking) + `hand_off_to_mode`. | Inside `loop.js` + `ChatPanel.jsx` |
| **App.jsx Wave 1** | Extracted `useGraphMutation`, `useDrillState`, `useCanvasViewport` hooks | `src/hooks/*.js` |
| **App.jsx Wave 2 (half)** | Extracted `useNodeSelection`. `<Canvas>` element extraction NOT done. | `src/hooks/useNodeSelection.js` |
| **AuthGate v2** | Login / Register / Token tabs. Workspace_id auto-stored on login. | `src/components/AuthGate.jsx` |
| **iOS audit** | Safe-area CSS, webkit-touch-callout, configurable `API_BASE`. Not yet device-tested. | `index.html`, `src/lib/api.js`, `src/api/graphSync.js` |
| **Rate limit + budget + backups** | 6 rate limiters, daily token budget enforcement, backup cron, cleanup cron, /healthz | `server/middleware/{rate-limit,token-budget}.js`, `server/lib/jobs.js` |

---

## 3. Architecture

```
┌──────────────────────────────────────┐
│ React (Vite)                         │
│  - App.jsx (1500 lines, partly refactored to hooks) │
│  - ChatPanel: free-chat = Agent loop │
│  - Slash modes: warmup / quiz / rehearse / audit │
│  - Drill-in sub-canvases             │
└──────────────────────────────────────┘
        │ SSE / REST (auth: x-auth-token, x-workspace-id headers)
        ▼
┌──────────────────────────────────────┐
│ Express server                       │
│  /api/auth (login/register/sessions) │
│  /api/db   (graph CRUD, memory, chat, suggestions) │
│  /api/ai/chat   (streaming text)     │
│  /api/ai/agent  (streaming agent loop with tools) │
│  /api/ai/agent/confirm (resolves confirm_with_user blocks) │
│  /healthz (real DB ping)             │
└──────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────┐
│ SQLite (better-sqlite3, WAL mode)    │
│  users / sessions / workspaces       │
│  graphs / nodes / edges              │
│  chat_messages / node_suggestions    │
│  agent_traces                        │
└──────────────────────────────────────┘
```

**Canvas key convention:** `topic` (root) or `topic::drill::nodeId::drill::nodeId2` (drilled-in). Every per-canvas table (nodes/edges/chat_messages/agent_traces/suggestions) uses `canvas_key` or `topic` column scoped by `workspace_id`.

---

## 4. Database schema (key tables only)

```sql
users(id, email, password_hash, display_name, created_at)
sessions(token PK, user_id, expires_at)
workspaces(id, name, owner_id, created_at)
workspace_members(workspace_id, user_id, role, joined_at)

graphs(workspace_id, topic PK-composite, label, updated_at)
nodes(id PK, workspace_id, topic, data JSON, updated_at,
      viewed_at, viewed_count, edited_at, recall_score)
edges(id PK, workspace_id, topic, data JSON, updated_at)

chat_messages(id PK, workspace_id, canvas_key, role, content, meta JSON, ts, streaming)
  -- meta.tokens stores Gemini totalTokenCount per assistant turn (for budget)
  -- meta.mode = 'warmup'|'quiz'|'rehearse' if mode session
  -- meta.agent = true if agent loop produced this

node_suggestions(id PK, workspace_id, canvas_key, type, payload JSON, status, created_at, resolved_at)
  -- type: 'merge'|'conflict'|'edge'|'create'|'update'|'delete'|'unlink'
  -- status: 'pending'|'accepted'|'dismissed'

agent_traces(id PK, workspace_id, canvas_key, chat_message_id, user_message,
             iterations, tool_calls JSON, total_tokens, total_cost, status,
             started_at, ended_at, meta JSON)
```

---

## 5. Frontend structure

```
src/
├── App.jsx                 1500 lines — partially refactored; canvas SVG render
│                           + drag/draw/lasso still inline (Wave 2/3 pending)
├── lib/
│   ├── api.js              apiStream / agentStream / resolveAgentConfirm
│   ├── slashCommands.js    parser + COMMANDS registry + autocomplete
│   ├── applySuggestion.js  per-type apply (merge/edge/create/update/delete/unlink/conflict)
│   ├── graphHelpers.js     buildGraph / buildContextPack / formatContextPack
│   └── modes/
│       ├── warmup.js       picker + system prompt
│       ├── quiz.js         picker + judging tags + EMA + summary
│       ├── rehearse.js     role presets + STATE:DONE protocol
│       └── audit.js        one-shot scan prompt + parser
├── hooks/
│   ├── useServerSync.js    auth gate + startup load + polling
│   ├── useGraphMutation.js mut / mutCanvas / pushUndo / undo / inline notes
│   ├── useDrillState.js    drillPath / canvasKey / drillParentNode
│   ├── useCanvasViewport.js pan / zoom / onWheel / refs
│   ├── useNodeSelection.js sel / hov / focusNodeId / selRef / selNodes
│   ├── useAIFeatures.js    gap scan / fusion / auto-link (pre-Phase-4 features)
│   ├── useKeyboardShortcuts.js
│   └── useNodeInput.js
├── components/
│   ├── panels/
│   │   ├── ChatPanel.jsx      900 lines — free chat (agent) + modes + suggestions
│   │   ├── StudioPanel.jsx    pre-Phase-4 mode UI; still works
│   │   └── TensionPanel.jsx
│   ├── SlashAutocomplete.jsx
│   ├── AgentToolCard.jsx     collapsible tool call rendering
│   ├── SuggestionCard.jsx    7 suggestion types
│   ├── AuthGate.jsx          login / register / token tabs
│   └── ...                   KNode, Edges, TopBar, modals, etc.
└── api/graphSync.js          fetch helpers + auth headers + API_BASE config
```

---

## 6. Slash commands (all in ChatPanel)

| Command | Type | What it does |
|---|---|---|
| `/warmup [scope]` | Mode | Light recall, picks stale/recently-edited nodes |
| `/quiz [scope]` | Mode | Closed-book test, 5 questions, judges via tags, updates `recall_score` (EMA) |
| `/rehearse <role>` | Mode | Role-play (interviewer / examiner / colleague / skeptic / `custom: ...` / freeform). Ends with `[STATE:DONE]` after 8-10 turns |
| `/audit` | Action | One-shot LLM scan → writes merge/conflict/edge suggestions |
| `/clear` | Action | Wipes chat history for current canvas |
| `/exit` | Action | Leave current mode, back to free chat (= Agent) |

Default free chat (no slash) goes through **Agent loop**, not plain LLM call.

---

## 7. Agent tools inventory (23 total)

**Tier 1 — Read (parallel, cheap):**
`search_nodes`, `read_node`, `list_nodes`, `traverse`, `list_topics`, `get_user_focus`, `get_memory_stats`, `find_orphans`

**Tier 1.5a — Algorithmic discovery (cheap):**
`find_dormant_threads`, `find_unexplored_neighbors`

**Tier 1.5b — LLM-powered discovery (~5x cost — uses sub-LLM):**
`suggest_bridges`, `expand_concept`, `infer_implicit_concepts`, `find_conceptual_gaps`, `infer_node_overlap`

**Tier 2 — Propose (max 1 per turn, writes to `node_suggestions`):**
`propose_create_node`, `propose_update_node`, `propose_delete_node`, `propose_link_nodes`, `propose_unlink`, `propose_merge_nodes`

**Tier 3 — Control:**
`confirm_with_user` (BLOCKS until user clicks dialog option, 120s timeout)
`hand_off_to_mode` (returns clickable button → enter /warmup / /quiz / etc.)

**Permission enforcement:** by naming convention (`propose_*`). No mutation tool exists. No policy engine.

---

## 8. Design decisions made (with rationale)

| Decision | Choice | Why |
|---|---|---|
| LLM provider | Gemini 2.5 Pro only | One key, momentum > flexibility |
| Vector DB? | **No** | 50 nodes; context pack covers it |
| MCP / LangGraph? | **No** | Single client + provider; framework cost > value |
| RAG? | **No** — replaced by Structural Context Pack | Graph structure > semantic similarity for this product |
| Multi-AI consensus? | **Future (`/perspectives` user-triggered, no auto-synth)** | Synthesis collapses divergence |
| `compare_nodes` agent tool? | **No** | Forces `read_node × N`, higher accuracy |
| Cross-canvas auto-search? | **No** | Workspace isolation is a feature |
| Agent role | **Curiosity prosthesis** (proactive discovery), not Q&A | User's framing — agent's main value is surfacing unknown-unknowns |
| Proactive discovery throttle | Only when `get_user_focus.returning_from_gap === true` | Avoid spam |
| Auth | bcrypt + DB sessions + optional legacy AUTH_SECRET | Standard, working |
| Token in localStorage vs HttpOnly cookie | localStorage for v1 | Simpler; revisit at scale |
| SQLite vs Postgres | **SQLite for v1** | 1000 users fits; migration is 2-3 days when needed |
| Multi-instance deploy | **No (Path A — single EC2)** | Has `pendingConfirms` in-process Map; OK for <5K users |
| Trace storage | SQLite `agent_traces` | Same store; cron retention 90d |
| Cancel UX | Stop button + AbortController end-to-end | iOS-friendly (no EventSource quirks) |

---

## 9. Open debt (prioritized)

### 🔴 Must-do before public launch
- [x] HTTPS termination — both options wired: `deploy/nginx/knowl.conf` (Let's Encrypt) + `deploy/alb-acm.md` (ALB + ACM). Pick at deploy time
- [x] `helmet` middleware (HSTS / X-Frame-Options / nosniff / referrer; CSP disabled — API-only server, re-enable when serving HTML)
- [x] Email verification + forgot-password flow — provider-agnostic `sendMail()` abstract in `server/lib/mail.js` (console / resend / sendgrid / ses). DB schema M5: `users.email_verified_at` + `email_verification_tokens` + `password_reset_tokens`. Routes: `verify-email`, `resend-verification`, `forgot-password` (anti-enumeration: always 200), `reset-password` (drops all sessions on success). AuthGate has Forgot/Reset modes + URL `?verify=`/`?reset=` token handling. AccountSettings shows unverified banner. Default provider is `console` — logs the link to stdout, swap to real provider via `MAIL_PROVIDER` env var
- [x] GDPR endpoints: `GET /api/auth/me/export`, `DELETE /api/auth/me` (typed-confirm + password re-auth; shared workspaces transfer ownership). Frontend UI in `AccountSettingsModal.jsx`
- [ ] Privacy Policy + Terms of Service (legal copy — deferred per user)
- [x] Sentry — backend (`server/lib/sentry.js`) + frontend (`src/lib/sentry.js`) both env-gated. ErrorBoundary wired in `main.jsx`. Activate by setting `SENTRY_DSN` + `VITE_SENTRY_DSN`
- [ ] AWS billing alarm + Gemini quota alarm (console config, not code)
- [ ] `.env.example` API key — rotate the key that was in git history (one-off ops task)

### 🟡 Should-do soon
- [ ] iOS Capacitor production build + device test (Path A in deployment doc)
- [ ] App.jsx Wave 2 second half: extract `<Canvas>` element
- [ ] App.jsx Wave 3: drag / draw / lasso → `useCanvasInteraction` hook
- [x] Workspace switcher UI — `AccountSettingsModal` shows all workspaces with role badge, current one highlighted, click to switch (writes localStorage + reload). Inline "Create new workspace" input. Uses existing `/api/auth/workspaces` GET+POST endpoints
- [x] SSE visibilitychange handler: when hidden >10s and we return to foreground, abort stale stream so UI unfreezes (no auto-reconnect — user retries manually)
- [ ] Confirm dialog tap-target audit for small screens
- [ ] StudioPanel migration to contextPack (still uses flat ctx)
- [ ] Decide: deprecate StudioPanel or keep coexisting with ChatPanel slash modes

### 🟢 Polish / future
- [ ] `/perspectives` multi-LLM brainstorm (deferred — design noted)
- [ ] Closed-book visual blur for /quiz
- [ ] Mode sub-commands (`/hint`, `/skip`, `/score`, `/end`)
- [ ] Audit auto-trigger on node edit (debounced)
- [ ] Discovery cache (5min TTL — avoid repeated sub-LLM)
- [x] Trace viewer UI — `TraceViewerModal.jsx` opens from ChatPanel header "Traces" button. List of recent agent runs on current canvas with status / iterations / token cost / duration. Click a row to lazy-load + expand the full tool_calls timeline with input/result JSON per call
- [ ] Theme toggle UI
- [ ] Suggestion continuation: after accept, agent auto-proposes next step
- [ ] Agent inline node mention → click-to-focus

### 🟢 Explicitly NOT doing (don't re-suggest)
- Kubernetes / EKS / microservices / Kafka / GraphQL
- Vector DB (sqlite-vec / pgvector / Pinecone)
- Cross-canvas auto-search
- MCP server (until external distribution becomes a goal)
- LangGraph or any agent framework
- Multi-region deploy
- Full FSRS / SM-2 spaced repetition (EMA is enough)
- Web search tool inside agent

---

## 10. Deployment

### Current: dev only (no production deploy yet)
- `npm run dev` → Vite on :3000 + Express on :3001 + Capacitor pointing at LAN IP
- `knowl.db` in repo root (gitignored now)
- `backups/` dir gitignored

### Deploy artifacts (built, not yet deployed)
- [`Dockerfile`](../Dockerfile) — multi-stage frontend build + Node 20 alpine runtime with tini. Volumes `/data` (SQLite) + `/backups`
- [`.dockerignore`](../.dockerignore) — keeps node_modules / *.db / ios / docs out
- [`deploy/nginx/knowl.conf`](../deploy/nginx/knowl.conf) — full nginx reverse-proxy config with SSE-aware `proxy_buffering off`, rate-limit zone, TLS hardening
- [`deploy/alb-acm.md`](../deploy/alb-acm.md) — ALB + ACM variant if you want zero-downtime + managed health checks
- [`ecosystem.config.cjs`](../ecosystem.config.cjs) — PM2 single-instance config for non-Docker deploys
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — push-to-main builds Docker image, ships via scp, restarts container, curl /healthz to verify
- [`docs/deploy.md`](deploy.md) — end-to-end Path A recipe (provision → secrets → first deploy → day-2 ops → rollback)

### Plan: AWS Path A (single EC2 + SQLite, ~$25–40/month)
Choose at deploy time:
- **nginx + Let's Encrypt** (~$25/mo, brief downtime on deploy) — use the nginx config
- **ALB + ACM** (~$40/mo, zero-downtime + auto health-check restart) — see alb-acm.md

S3 backup hooks already wired (`S3_BACKUP_BUCKET` env var triggers daily upload).

### Future: AWS Path B (~$200/month)
Needs SQLite → Postgres migration first. Then ECS Fargate + RDS Multi-AZ + ElastiCache.

---

## 11. Conventions / patterns used

- **Tool naming = permission**: read tools have any name, propose tools have `propose_` prefix. Enforced in `isReadOnly` / `isPropose` / `isControl`.
- **SSE event channels**: `token` / `tool_call` / `tool_result` / `confirm_request` / `meta` / `done` / `error` / `cancelled` / `budget_exhausted`.
- **Mode tag protocol**: `[JUDGE:X][STATE:Y]` (quiz), `[STATE:Y]` (rehearse). Stripped at render time.
- **Proposal-not-mutation pattern**: All agent mutations write to `node_suggestions` → user accepts → `applySuggestion` runs `pushUndo` + `mutCanvas`.
- **Hook order in App.jsx** matters because of TDZ — useServerSync (provides authNeeded) → useCanvasViewport → useDrillState → canvasKeyRef → useGraphMutation → useAIFeatures → useNodeInput.
- **Idempotent `requireAuth`**: chains can re-stack it without redundant DB lookup.
- **Cache invalidation**: `tokenBudgetMiddleware` has 30s TTL; not invalidated proactively (acceptable staleness).
- **Capacitor production**: must set `VITE_API_BASE` or `window.KNOWL_API_BASE` to absolute URL; remove `server.url` from capacitor.config.json.

---

## 12. How to use this doc to start a fresh session

1. Paste this entire file as first message to a new chat
2. Say: "I want to [specific feature/fix]. Confirm you understand the current state, then propose a plan."
3. Don't waste context re-explaining what's done. The new session will ask follow-up questions about the specific area.
4. When you finish a milestone in the new session, **update this doc** before closing.

---

## 13. File locations cheat-sheet

| Need | File |
|---|---|
| Add a new agent tool | `server/lib/agent/tools.js` |
| Change agent system prompt | `server/lib/agent/loop.js#buildAgentSystemPrompt` |
| Add a slash command | `src/lib/slashCommands.js` + dispatcher in `ChatPanel.jsx#handleSlash` |
| Add a suggestion type | `src/lib/applySuggestion.js` + render in `SuggestionCard.jsx` |
| Change rate limits | `server/middleware/rate-limit.js` |
| Change token budget | `LLM_DAILY_TOKEN_BUDGET` env var, or `server/middleware/token-budget.js` |
| Add a cron job | `server/lib/jobs.js#startJobs` |
| Schema migration | `server/db.js` top-of-file `db.exec(...)` blocks |
| Hook for new state | `src/hooks/use*.js` |
| Phase 4 Agent design ref | `docs/phase-4-agent.md` |
| Security headers (helmet) | `server/index.js` — re-enable CSP here if you start serving HTML |
| GDPR export / delete | `server/db.js#exportUserData` + `deleteUserCompletely`; routes in `server/routes/auth.js`; UI in `src/components/AccountSettingsModal.jsx` |
| Sentry init (server) | `server/lib/sentry.js` — env-gated, hooked in `server/index.js` top + bottom |
| Sentry init (frontend) | `src/lib/sentry.js` — ErrorBoundary wraps App in `src/main.jsx` |
| Deploy: Dockerfile / nginx / ALB / CI | `Dockerfile`, `deploy/nginx/knowl.conf`, `deploy/alb-acm.md`, `.github/workflows/deploy.yml`, `docs/deploy.md` |
| Add an env var | `.env.example` (document) + read in code via `process.env.X` |
| Email send / template | `server/lib/mail.js` — `sendMail()` + `sendVerificationEmail` + `sendPasswordResetEmail` |
| Add auth endpoint | `server/routes/auth.js` + rate limiter in `server/middleware/rate-limit.js` + mount in `server/index.js` |
| Trace viewer / debug | `src/components/TraceViewerModal.jsx` — opened from ChatPanel "Traces" button |
| Workspace switcher | `src/components/AccountSettingsModal.jsx` — uses `/api/auth/me` + `/api/auth/workspaces` |

---

## 14. Environment variables — complete reference

Group these into `.env` (server) and `.env.production` (frontend build). The `.env.example` in the repo is currently behind — flag in next session to update.

### Server (Node) — required
| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (none) | **Required.** Server-side LLM key — frontend never sees it |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Override model |
| `PORT` | `3001` | Express bind port |
| `DB_PATH` | `./knowl.db` | SQLite file location |

### Server — auth / security
| Var | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | (unset) | Legacy shared-secret token mode. If unset, runs in "open dev mode" (single default user). If set + matches request token → admin path. |
| `CORS_ORIGIN` | `*` | CSV list of allowed origins for production (e.g. `https://app.knowl.com,https://www.knowl.com`) |
| `TRUST_PROXY` | (unset) | Set `1` when behind ALB/nginx so `req.ip` is correct (rate-limit accuracy) |

### Server — LLM cost / budget
| Var | Default | Purpose |
|---|---|---|
| `LLM_DAILY_TOKEN_BUDGET` | `200000` | Per-user 24h cap; set `0` to disable enforcement |

### Server — cron / backup
| Var | Default | Purpose |
|---|---|---|
| `BACKUP_DIR` | `./backups` | Local backup snapshot directory |
| `BACKUP_RETENTION_DAYS` | `7` | Days of local backups kept before rotation |
| `TRACE_RETENTION_DAYS` | `90` | Days of `agent_traces` kept |
| `DISABLE_JOBS` | (unset) | Set `1` to skip starting cron (dev/tests) |
| `S3_BACKUP_BUCKET` | (unset) | If set, daily backup uploads to S3 (`npm i @aws-sdk/client-s3` first) |
| `S3_BACKUP_PREFIX` | `backups/` | S3 key prefix |
| `AWS_REGION` | `us-east-1` | For S3 client |

### Server — LLM provider routing (future)
| Var | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | Reserved for future Anthropic / OpenAI swap |

### Frontend (Vite) — build time only
| Var | Default | Purpose |
|---|---|---|
| `VITE_API_BASE` | `''` | Absolute API URL for production iOS / cross-origin builds (e.g. `https://api.knowl.com`) |

### Frontend (Capacitor iOS) — runtime
Inject in `main.jsx` before mount if needed:
```js
window.KNOWL_API_BASE = 'https://api.knowl.com'; // overrides VITE_API_BASE at runtime
```

---

## 15. Manual smoke tests

The project has **no automated test suite** — the user verifies manually. Use these recipes after touching each area.

### Auth (Phase 1 + AuthGate v2)
```bash
# Register a new user
curl -s -X POST localhost:3001/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"hunter22","display_name":"Test"}'
# → { token, user, default_workspace_id }

# Login
curl -s -X POST localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"hunter22"}'
```
UI: open app fresh → AuthGate appears → tabs (Sign in / Register / Token) → register → workspace auto-loaded.

### Graph CRUD
- Open canvas, double-click → create node → check `nodes` table has row scoped to your workspace.
- Drill into a node → `topic` column has `::drill::` suffix.

### Chat persistence (Phase 2 M1)
- Send free-chat message → reload page → message comes back.
- Send message, force-quit tab mid-stream → reload → message tagged `interrupted` (amber border).

### Context Pack (Phase 2 M2)
- DevTools Network → POST `/api/ai/agent` body → `contextPack.breadcrumb` reflects drill state.
- Drill in → context pack shrinks to sub-canvas.

### Slash commands (Phase 3)
- Type `/` → autocomplete dropdown.
- `/warmup` → AI greets with a specific stale-node reference.
- `/quiz` → 5 questions, judges, `recall_score` updates: `sqlite3 knowl.db "SELECT id, recall_score FROM nodes WHERE recall_score IS NOT NULL;"`
- `/rehearse interviewer` → AI plays role, ends after ~8 turns with feedback + `[STATE:DONE]`.
- `/audit` → suggestions appear inline.

### Agent (Phase 4)
- Free chat (no slash) → invokes agent → tool cards appear inline (search_nodes / read_node / etc.).
- Trace row: `sqlite3 knowl.db "SELECT id, iterations, total_tokens, status FROM agent_traces ORDER BY started_at DESC LIMIT 1;"`
- Click Stop button mid-stream → `status='cancelled'`.
- Propose tool fires → SuggestionCard appears immediately above messages → click Accept → graph mutates + toast appears with undo.

### Confirm dialog (M4-γ)
- Induce ambiguous request ("merge or link these?") → agent calls `confirm_with_user` → inline dialog with buttons → click → agent resumes.

### Rate limit + token budget
```bash
# Trigger login rate limit (5/15min)
for i in {1..6}; do curl -s -X POST localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"x@x.com","password":"x"}' -w '%{http_code}\n' -o /dev/null; done
# → 401 401 401 401 401 429

# Trigger token budget (low cap to test)
LLM_DAILY_TOKEN_BUDGET=500 npm run dev:server
# Chat a few times → second/third call → frontend shows 🛑 banner

# Read budget status
curl -s localhost:3001/api/auth/budget -H "x-auth-token: $TOKEN" | jq
```

### Backup cron
```bash
node --input-type=module -e \
  "import('./server/lib/jobs.js').then(m => m.jobs.runBackup());"
ls backups/  # → knowl-YYYY-MM-DD.db
```

### Cleanup cron
```bash
node --input-type=module -e \
  "import('./server/lib/jobs.js').then(m => m.jobs.runSessionCleanup());"
```

### Email flow (provider stub mode)
```bash
# Register a new account → verify token gets logged to stdout
curl -s -X POST localhost:3001/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"hunter22","display_name":"Test"}'
# Watch server logs for the ━ STUB ━ block with the verify URL.
# Copy the token from that URL and:
curl -s -X POST localhost:3001/api/auth/verify-email \
  -H 'content-type: application/json' \
  -d '{"token":"<paste here>"}'
# → { ok: true, email: "a@b.com" }

# Forgot password — always 200 to prevent enumeration
curl -s -X POST localhost:3001/api/auth/forgot-password \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com"}'
# Reset link logged to stdout; extract token from it and:
curl -s -X POST localhost:3001/api/auth/reset-password \
  -H 'content-type: application/json' \
  -d '{"token":"<paste here>","password":"newpw1"}'
# → { ok: true } and all existing sessions for that user are deleted
```

### Trace viewer
- Open chat panel → click "Traces" in header → list of agent runs shows
- Click a row → expand to see tool_calls timeline with input/result JSON
- Verify directly: `sqlite3 knowl.db "SELECT id, iterations, total_tokens, status FROM agent_traces ORDER BY started_at DESC LIMIT 5;"`

### Workspace switching
- AccountSettings (⚙ in top bar) → Workspaces section shows all
- Click a non-current workspace → page reloads scoped to it
- Type in "New workspace name" → Create → reload into the new one

### Health check (ALB ready)
```bash
curl -s localhost:3001/healthz | jq
# → { ok: true, db: "up", uptime: 42 }
```

### Security headers (helmet)
```bash
curl -sI localhost:3001/healthz | grep -E '(strict-transport|x-frame|x-content|referrer|cross-origin)'
# Should see: strict-transport-security, x-frame-options: SAMEORIGIN,
# x-content-type-options: nosniff, referrer-policy, cross-origin-resource-policy: cross-origin
```

### GDPR — data export
```bash
curl -s localhost:3001/api/auth/me/export \
  -H "x-auth-token: $TOKEN" \
  -o knowl-export.json
jq '.user.email, (.workspaces | length), (.workspaces[0].nodes | length)' knowl-export.json
```

### GDPR — delete account (destructive)
```bash
# Wrong confirm string → 400
curl -s -X DELETE localhost:3001/api/auth/me \
  -H "x-auth-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"password":"hunter22","confirm":"yes"}'

# Correct flow → 200 with { ok, deleted_workspaces, transferred_workspaces, left_workspaces }
curl -s -X DELETE localhost:3001/api/auth/me \
  -H "x-auth-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"password":"hunter22","confirm":"DELETE MY ACCOUNT"}'

# Subsequent request with same token → 401 (session cascaded with user)
curl -s localhost:3001/api/auth/me -H "x-auth-token: $TOKEN" -w "\n%{http_code}\n"
```

---

## 16. Common gotchas / footguns

Things that bit us or future sessions will hit. **Read this before debugging weird behavior.**

### Hook ordering in App.jsx
React's TDZ (temporal dead zone) bites when one hook's closure references another hook's value that hasn't been declared yet. Real example we hit: `useDrillState` wanted to call `setNodeChatId` (from `useNodeInput`) inside its `clearOnDrill` callback, but `useNodeInput` is declared later. **Fix pattern**: define action wrappers (`drillInto`/`drillBack`) AFTER all hooks they depend on, even if it spreads them around. Don't try to inject all setters into a hook.

### `pushUndo` returns the snapshot
Callers that want toast-with-undo do:
```js
const saved = pushUndo();
mut(nm => { delete nm[id]; });
addToast('Deleted', () => setGraph(saved));
```
Don't refactor to `pushUndo()` without return — many call sites depend on it.

### `meta` field reuse on chat_messages
`chat_messages.meta` is JSON storing **anything**: `tokens` (for budget aggregation), `mode` (which slash mode produced it), `agent: true`, `interrupted: true`, `system: true`, `transient: true`, `error: "..."`. **Don't break the schema** — additive only. `getUserTokenUsage` SQL does `json_extract(meta, '$.tokens')`.

### canvas_key string format is load-bearing
`topic::drill::id1::drill::id2` is parsed in multiple places (`useDrillState`, `buildContextPack`, tools.js `get_user_focus`). Changing the separator is a multi-file refactor.

### Single-process state that breaks on multi-instance
- `routes/agent.js` → `pendingConfirms` Map
- `middleware/token-budget.js` → `usageCache` Map
- `middleware/rate-limit.js` → default in-memory store
These work in single-instance deploy (Path A). For Path B you need Redis-backed alternatives — comment in each file flags this.

### iOS Capacitor: `server.url` in `capacitor.config.json`
Currently `http://192.168.254.65:3000` — **a dev-only config** pointing iOS to your Mac on LAN. For production iOS build, remove this property entirely and set `VITE_API_BASE` instead.

### Prompt cache TTL
Anthropic prompt cache is **5 minutes**. Long gaps between conversation turns = cache miss = full input price. For long sessions, work in concentrated bursts.

### `requireAuth` is idempotent
Don't re-add early returns assuming it only runs once. The chain `app.use('/api/ai/chat', requireAuth, aiChatLimiter, tokenBudgetMiddleware) → app.use('/api/ai', requireAuth, aiRouter)` runs `requireAuth` twice on `/api/ai/chat`. Idempotent guard in `auth.js` makes the second pass a no-op.

### SSE + ALB idle timeout
ALB default idle timeout is 60s. Long agent runs would die. **Must** increase target-group idle timeout to 600s+ (frontend heartbeat `: ping\n\n` every 15s helps but doesn't fully solve it).

### `better-sqlite3` is synchronous
All DB calls block the event loop. Fine at our scale. Don't `await` them — they're sync. Don't be tempted to wrap in Promise.

### Streaming JSON parsing for tool calls
Gemini sends `functionCall` parts as **complete** blocks, not streamed token-by-token. Our loop assumes atomic tool_call events. If we ever switch to Anthropic, partial JSON streaming becomes a concern.

### `crypto.randomUUID` runtime
Used **server-side only** (`server/db.js`, `routes/agent.js`). If you ever add it client-side, iOS Safari < 15.4 will fail.

---

## 17. Deferred feature: `/perspectives` multi-AI brainstorm

User explicitly asked to note this for later. **Don't implement without re-reading their constraints.**

**What:** A user-triggered slash command that asks 2+ LLM providers the same brainstorm question in parallel, shows side-by-side cards, and lets the user "capture as node" the response(s) they like.

**Use case:** First-version node generation at the start of a topic, or moments when the user wants divergent perspectives before committing to a direction.

**Critical user constraint:**
> "結果用戶要自己一直改這些節點，這我們不要" — the user explicitly does NOT want the AI to produce mediocre nodes that the user then has to fix. Quality bar must be high enough that capture is a delete-or-keep decision, not a rewrite.

**Design notes (already discussed, not built):**
- User-triggered only, not agent-auto. Auto-trigger has too many false positives.
- 2 providers default (Claude + Gemini), 3rd opt-in. NOT auto-synthesize.
- Side-by-side cards, not blended summary.
- Each response has "✚ capture as node" button → `propose_create_node`.
- Synthesis (if user opts in) done by a 3rd model, not one of the two answerers.
- Self-consistency alternative: same model × 3 temperatures might be cheaper if cross-provider drift not needed.

**Won't matter at all if:** the user is in their KG to retrieve, not to brainstorm. Mostly for the "I'm starting a new topic" cold-start moment + occasional "I'm stuck, give me angles" moment.

**Estimated scope:** ~450 LOC across Anthropic provider wrapper + OpenAI provider wrapper + slash command + PerspectiveCard component + capture-to-node integration.

---

## 18. Last session continuation pointer

**Most recently completed (last session):**
Pre-launch round 3 — closing the auth-flow gap + visibility. (1) **Email flow** complete: provider-agnostic `server/lib/mail.js` (console / resend / sendgrid / ses, default `console` logs to stdout so dev never breaks). DB schema M5: `users.email_verified_at` + `email_verification_tokens` + `password_reset_tokens`. Routes `verify-email` / `resend-verification` / `forgot-password` (always-200 anti-enumeration) / `reset-password` (deletes all sessions for that user on success). AuthGate gets Forgot link + reset mode + URL `?verify=` / `?reset=` token handling. AccountSettings shows unverified banner with resend button. Daily cron prunes expired tokens. New rate limiters: forgot-password (3/h), reset-password / verify-email (10/15min). (2) **Workspace switcher** added inside AccountSettings — lists all workspaces with role chip + current marker; click to switch; inline "Create new workspace" form. (3) **TraceViewerModal** added — `agent_traces` finally has a UI: opens from ChatPanel header "Traces" button, lists past runs with iter/tokens/duration/status, expandable rows lazy-load full tool_calls timeline with input/result JSON per call.

**Earlier rounds:**
Round 2 — Sentry backend + frontend (env-gated, ErrorBoundary, PII strip), SSE visibilitychange handler, all deploy artifacts (Dockerfile / nginx / ALB / PM2 / GitHub Actions / .env.example / deploy.md).
Round 1 — helmet + GDPR endpoints + AccountSettingsModal initial cut.

**Earlier this branch:**
Round 1: helmet + GDPR endpoints (backend only). Earlier still: rate limiting (6 limiters) + per-user daily token budget + backup cron + cleanup cron + weekly VACUUM + real `/healthz`.

**Natural next steps in order:**

1. **Run `npm install`** — pulls @sentry/node, @sentry/react, helmet from rounds 1-2 (no new deps in round 3; mail providers are lazy-imported only when used). Then `npm run dev` should boot cleanly; without `MAIL_PROVIDER` set, verification emails print to stdout instead of sending.

2. **External services + creds** (when ready to actually launch):
   - **Sentry**: create project → set `SENTRY_DSN` + `VITE_SENTRY_DSN` in `/etc/knowl/env` and GitHub secrets
   - **Mail**: pick Resend (easiest) / SendGrid / SES → set `MAIL_PROVIDER` + provider key + `MAIL_FROM` + `APP_BASE_URL`
   - **UptimeRobot**: monitor `/healthz` every 5min
   - **AWS Billing**: $100/mo budget + email alarm
   - **Google Cloud**: Gemini API quota alert

3. **Provision the AWS box** following `docs/deploy.md` — EC2 + EBS + DNS + certbot (nginx variant) OR ALB + ACM (managed variant). Drop a populated `/etc/knowl/env` at 0600 perms.

4. **Legal copy** (still deferred): Privacy Policy + ToS. Use Termly / iubenda + lawyer review.

5. **Rotate the leaked Gemini key** in git history. One-off ops task.

6. **iOS Capacitor production build** — last untested path. visibilitychange handler from round 2 should make background→foreground bearable; verify on real device.

7. (Optional) **App.jsx Wave 2 / 3** — Canvas element extraction + canvas-interaction hook. Tech debt; not blocking launch.

3. **iOS Capacitor verification** — Path A app needs to actually work on iPhone. The audit (§17 in `phase-4-agent.md`) plus the safe-area CSS done last session, but no device testing happened.

4. **App.jsx Wave 2 second half** — extract `<Canvas>` SVG render block (~400 lines, drag handlers tangled). Pure internal cleanup, defer until pre-launch settles.

5. **`/perspectives` brainstorm feature** — deferred per §17 here.

**To start the next session:** paste this doc → say "I want to do [X from above]" → AI reads, confirms understanding, proposes a step-by-step plan. Don't waste tokens re-explaining context that's in this doc.

---

## 19. Token-budget meta-note for the AI reading this

If this is a fresh session and you're processing this doc cold: **don't re-read every source file mentioned here**. Read only the specific files relevant to the task the user is asking about. Section §13 (file cheat-sheet) tells you which 1-3 files to touch for a given change. The whole codebase is ~5000 lines — reading it all would cost a small fortune in input tokens and give you nothing extra over this state doc.

When in doubt, **ask the user for the specific file or commit you should look at** before reading anything large.
