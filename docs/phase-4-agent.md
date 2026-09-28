# Phase 4 — AI Agent Design

**Status:** Design / pre-implementation
**Owner:** TBD
**Last updated:** 2026-05

---

## 1. Goals

把 ChatPanel 的「自由對話」從**單輪 LLM call** 升級為**多輪 tool-calling Agent**。

**Primary goal — Curiosity prosthesis（首要）：**

挖掘使用者**自己都不知道但會有興趣**的知識點與連結。Agent 不只是 Q&A —— 它主動掃描 graph 結構，surface latent connections、coverage gaps、unlinked semantic overlap，讓使用者看到自己思考的隱藏結構。

**Secondary goals：**
- 多輪 tool-calling 對複雜問題做推理（read → analyze → propose）
- 提議節點 / 邊的變更（propose-only，使用者一鍵套用）
- 透明展示思考軌跡與工具呼叫

**Scope rule：**
- **Agent 永遠 scope 在當前 canvas + drill 範圍**
- 跨 topic / workspace 自動搜尋**不做** — 如果使用者問的東西不在當前 canvas，Agent 用文字提示「這個可能在你的 X canvas 有更多」，但不自動切
- 這是設計選擇：workspace 獨立是 feature 不是 bug，Agent 不該污染當前 mental context

**Non-goals（明確不做）：**
- 直接 mutate graph（一律走 propose → user accept）
- 跨 canvas / topic 自動搜尋
- Web search / 外部資料（之後再評估）
- Multi-agent orchestration（單一 Agent loop 就夠用）
- LangGraph / MCP / 任何 framework abstraction（hand-rolled）
- 取代 `/warmup`、`/quiz`、`/rehearse` 腳本化模式

---

## 2. Architecture Overview

```
┌─────────────┐    POST /api/ai/agent     ┌──────────────────┐
│  ChatPanel  │ ───────────────────────→  │ server/routes/   │
│  (frontend) │ ←─── SSE event stream ─── │ agent.js         │
└─────────────┘                           └──────────────────┘
                                                  │
                                                  │ uses
                                                  ▼
                                          ┌──────────────────┐
                                          │ AgentLoop        │
                                          │ - llm streaming  │
                                          │ - tool dispatch  │
                                          │ - budget enforce │
                                          │ - trace logging  │
                                          └──────────────────┘
                                                  │
                              ┌───────────────────┼───────────────────┐
                              ▼                   ▼                   ▼
                       ┌────────────┐      ┌────────────┐     ┌────────────┐
                       │ Tier 1     │      │ Tier 2     │     │ Trace      │
                       │ Read tools │      │ Propose    │     │ writer     │
                       │ → SQL      │      │ → suggest. │     │ → traces   │
                       │   queries  │      │   table    │     │   table    │
                       └────────────┘      └────────────┘     └────────────┘
```

**Free chat → Agent**：今天的 ChatPanel free-chat 行為改走 `/api/ai/agent`。Slash 模式（warmup/quiz/rehearse）維持走原本的 `/api/ai/chat`，不經 Agent。

---

## 3. Agent Loop（hand-rolled，無 framework）

### 3.1 Pseudo-code

```js
async function* runAgent({ messages, context, signal, budget }) {
  let history = [...messages];
  let iterations = 0;
  const startedAt = Date.now();
  const trace = { tool_calls: [], total_tokens: 0 };

  while (iterations < budget.maxIterations) {
    iterations++;

    // 1. LLM call with tool definitions
    const llmStream = streamLLM({
      system: buildAgentSystemPrompt(context),
      messages: history,
      tools: TOOL_SCHEMAS,
      signal,
    });

    const collected = { text: '', tool_calls: [] };
    for await (const chunk of llmStream) {
      if (chunk.type === 'text')      { collected.text += chunk.text; yield chunk; }
      if (chunk.type === 'tool_call') { collected.tool_calls.push(chunk); yield chunk; }
      if (signal.aborted) { yield { type: 'cancelled' }; return; }
    }

    history.push({ role: 'assistant', content: collected.text, tool_calls: collected.tool_calls });

    // 2. Terminate if no tool calls
    if (collected.tool_calls.length === 0) {
      yield { type: 'done', iterations };
      return;
    }

    // 3. Execute tools (read-only: parallel; propose: serial)
    const readOnly = collected.tool_calls.filter(c => isReadOnly(c.name));
    const propose  = collected.tool_calls.filter(c => isPropose(c.name));

    const readResults = await Promise.all(readOnly.map(c => safeExecute(c, context)));
    const proposeResults = [];
    for (const c of propose) proposeResults.push(await safeExecute(c, context));

    for (const r of [...readResults, ...proposeResults]) {
      trace.tool_calls.push(r);
      history.push({ role: 'tool', tool_call_id: r.id, content: r.error || JSON.stringify(r.result) });
      yield { type: 'tool_result', id: r.id, result: r.result, error: r.error };
    }

    // Budget check
    if (trace.total_tokens > budget.maxTokens) {
      yield { type: 'budget_exhausted', reason: 'tokens', trace };
      return;
    }
  }

  yield { type: 'budget_exhausted', reason: 'iterations', trace };
}

async function safeExecute(call, ctx) {
  try {
    const result = await TOOLS[call.name].run(call.input, ctx);
    return { id: call.id, name: call.name, input: call.input, result, duration_ms: ... };
  } catch (e) {
    // ERROR FEEDBACK LOOP — return as result, LLM self-corrects
    return { id: call.id, name: call.name, input: call.input, error: String(e.message || e) };
  }
}
```

### 3.2 Key design choices

- **Generator pattern** (`async function*`) — natural fit for SSE streaming
- **Tool errors NEVER throw to outer scope** — always returned as `tool_result` so LLM self-corrects (the "error feedback loop" from earlier discussion)
- **Read-only parallel, propose serial** — read ops are independent; mutations could conflict
- **Budget enforced inside loop** — hard cap; yield `budget_exhausted` event so frontend can show "agent stopped — too much context"
- **AbortSignal flows end-to-end** — frontend cancel → fetch abort → upstream LLM abort → loop ends gracefully

---

## 4. Tool Inventory

設計原則：
- **Read tools 多多益善**（給 Agent 看得清楚才能準確推理）
- **Propose tools 全部走 `propose_` 前綴**（permission model 用命名強制，見 §5）
- **不給通用 `compare_nodes`** — Agent 用 `read_node` × N 自己對比；準確度靠 prompt + 完整 body 而非另一個工具

### 4.1 Tier 1 — Read-only tools（auto-execute）

#### 核心查詢
| Tool | Signature | 用途 |
|---|---|---|
| `search_nodes` | `(query, scope?)` | 在當前 canvas / topic / workspace 搜尋關鍵字 |
| `read_node` | `(node_id)` | 取單一 node **完整 body**（不截斷，準確度關鍵） |
| `list_nodes` | `(scope?)` | 列範圍內所有 node（title + summary） |
| `traverse` | `(node_id, hops=1)` | N-hop 鄰居 + 連到它的 edges |

#### 跨範圍（unknown-unknown × 1）
| Tool | Signature | 用途 |
|---|---|---|
| `list_topics` | `()` | 列 workspace 內所有 root topic |
| `search_workspace` | `(query)` | 跨所有 canvas / drill 找關鍵字 |
| `get_user_focus` | `()` | 取得使用者**當下**看哪個 canvas / drill 層 / 選哪些 node — 為「我正在看 X，幫我...」這種情境 |

#### 記憶 / 時間軸
| Tool | Signature | 用途 |
|---|---|---|
| `find_stale` | `(days, scope?)` | viewed_at > N 天的 node |
| `find_low_recall` | `(threshold, scope?)` | recall_score < X 的 node |
| `find_recent_edits` | `(days, scope?)` | edited_at 在 N 天內的 node |
| `get_memory_stats` | `(node_ids[])` | 一次取多 node 的 viewed / edited / recall |

#### 圖譜結構分析（unknown-unknown × 3）
| Tool | Signature | 用途 |
|---|---|---|
| `find_orphans` | `(scope?)` | 沒 edge、沒 parent、沒被 reference 的孤兒 |
| `find_conflicts` | `(scope?)` | flagged unresolved conflict 的 node |
| `find_dense_clusters` | `(scope?, min_size=3)` | 緊密連結的 sub-community（union-find on edges）— 「強記憶區」 |
| `find_bridge_nodes` | `(scope?)` | 連結 otherwise-separate subgraph 的關鍵 node — 高認知價值 |
| `find_dangling_wikilinks` | `(scope?)` | body 含 `[[link]]` 但沒對應 edge — half-formed connection |

#### Meta
| Tool | Signature | 用途 |
|---|---|---|
| `recent_chat_messages` | `(canvas_key?, limit=20)` | Agent 自己讀**先前對話歷史** — 跨 session 連續性關鍵 |
| `recall_quiz_history` | `(node_id?)` | 某 node 在 Quiz 模式被測過幾次、score 變化 |

**為何不給 `compare_nodes(a, b)`：** 過於 high-level 的 tool 鼓勵 LLM 偷懶，輸出「A 跟 B 不同」這種空話。強迫它 `read_node(a)` + `read_node(b)` + 自己 reason，準確度更高。Prompt 規範：

> When comparing nodes, you MUST call read_node on each one and quote specific phrases from their bodies in your comparison.

**`search_workspace` 改為跨 topic 提示：** 原本設計的跨 canvas 搜尋拿掉。Agent **scope 鎖在當前 canvas**。如果問題明顯不屬於此 canvas，Agent 用 `list_topics()` 提示使用者切過去，不自動拉跨 canvas 資料。

### 4.1.5 Tier 1.5 — Discovery / Latent-Structure tools

**這層是 Agent 的核心價值來源** — 挖出使用者自己沒意識到的知識結構洞與連結。所有 discovery tool 都嚴格 scope 在當前 canvas + drill。

#### 結構面（純算法，便宜、deterministic）

| Tool | Signature | 找什麼 |
|---|---|---|
| `find_unexplored_neighbors` | `(node_id, hops=2)` | 2-hop 鄰居中 `viewed_count` 低或 `viewed_at` 久的 — 「graph 裡有但你沒回去看過」 |
| `find_dormant_threads` | `(scope?)` | 久沒 edit 且帶 unresolved conflict / dangling wikilink 的 subtree — 「你開始探索但中斷的線」 |
| `find_implicit_wikilinks` | `(scope?)` | body 含 `[[X]]` 但沒對應 edge — half-formed connection |
| `find_density_imbalance` | `(scope?)` | 同層 parent 之間 child count 差異大 — 「某些主題寫太細，某些只開頭」 |

#### 推論面（子 LLM call，中等成本，**真正的 unknown-unknown 引擎**）

每個 tool 內部用 narrow system prompt 跑專門的子 LLM call。Agent 不需要自己生這些 — 工具吃結果。

| Tool | Signature | 子 prompt 在問 |
|---|---|---|
| `infer_implicit_concepts` | `(node_id)` | 「讀這個 node body，列出**提到但尚未成為節點**的概念」<br>e.g. Caching node 提到 LRU 但沒 LRU node → 候選 propose_create |
| `suggest_bridges` | `(node_id, count=3)` | 「在現有 nodes 中找跟此 node **語義重疊但 graph 上沒邊**的目標 — 跨 subtree 的 surprise 連結」 |
| `expand_concept` | `(node_id, count=3)` | 「讀此 node 後提議自然的下一步概念」<br>e.g. Kafka topic → consumer groups / exactly-once / schema registry |
| `find_conceptual_gaps` | `(parent_id)` | 「看 parent + 既有 children，判斷**慣例上應該有但沒有**的 sibling」<br>e.g. Database parent 有 Postgres/MySQL 但缺 SQLite/MongoDB |
| `infer_node_overlap` | `(id_a, id_b)` | 「比較兩 node body，量化 overlap%」<br>為 merge / conflict 候選提供 ranking |

#### Discovery vs. Audit 的分工

- **`/audit`** — defect 觀點：什麼是**錯的**（duplicate / contradiction / missing edge）
- **Discovery tools** — opportunity 觀點：什麼是**有價值但缺少的**（unexplored / dormant / non-obvious bridge）

兩者寫到同一個 `node_suggestions` 表，UI 不分（同個 SuggestionCard），但 `meta.source` 標記來源以利分析。

### 4.2 Tier 2 — Propose tools（一律走 `node_suggestions` 表）

| Tool | Signature | 寫入 type |
|---|---|---|
| `propose_create_node` | `(title, body, parent_id?, links_to?[])` | `create` |
| `propose_update_node` | `(node_id, patch{title?,body?,confidence?,tag?})` | `update` |
| `propose_delete_node` | `(node_id, reason)` | `delete` |
| `propose_link_nodes` | `(from, to, label, dash?)` | `edge` |
| `propose_unlink` | `(edge_id, reason)` | `unlink` |
| `propose_merge_nodes` | `(ids[], merged_title, merged_body)` | `merge` |
| `propose_audit_finding` | `(type='merge'\|'conflict'\|'edge', payload)` | （直接同 `/audit`） |

**現有 `node_suggestions` schema 需要加 type：** 目前支援 `merge` / `conflict` / `edge`。Phase 4 新增 `create` / `update` / `delete` / `unlink`。Migration trivial。

### 4.3 Tier 3 — Meta / control（unknown-unknown × 2）

| Tool | Signature | 用途 |
|---|---|---|
| `confirm_with_user` | `(question, options[])` | **Agent 顯式暫停問使用者** — 例如「你想合併還是新建？」前端跳一個 inline dialog，user 點按鈕後 resume |
| `hand_off_to_mode` | `(mode='warmup'\|'quiz'\|'rehearse', scope?)` | 建議使用者進腳本化模式（不直接執行） |
| `end_session` | `(reason)` | Agent 主動結束（任務完成 / 需更多 context） |

`confirm_with_user` 特別重要——**沒這個工具，Agent 會狂猜使用者意圖**，常常猜錯。有了它，模糊指令可以主動澄清。

### 4.4 Deferred / 不做的工具

| Tool | 為何不做 |
|---|---|
| `web_search` | 安全 + 成本爆炸 + 幻覺放大；個人 KG 不需要 |
| `set_working_memory` / `get_working_memory` | LLM history 本身就是 working memory；過早抽象 |
| `cite_source(node_id, url)` | 等使用者有實際需求再加 |
| `propose_review_question` | 需要 review queue 基礎建設；不在 Phase 4 scope |
| `diff_node_over_time` | 沒存 node 版本歷史；先存才能 diff |
| `explain_my_reasoning` | Meta-prompt hell；trace 透明已經足夠 |

---

## 5. Permission Model

**核心原則：用 tool naming 強制 permission，不用 runtime policy engine。**

| Tier | 識別 | 行為 |
|---|---|---|
| Read | 任何**沒有** `propose_` 前綴的工具 | 自動執行，串流 result |
| Propose | `propose_*` 前綴 | 寫入 `node_suggestions`，UI 顯示卡片，使用者 accept/dismiss |
| Direct mutation | **不存在** | 沒有任何 tool 暴露 raw mutation |

**為什麼這比 policy engine 強：**
- Constraint 在 API surface 強制；不靠 runtime check
- LLM 看 tool name 就知道「不能直接刪」；沒有「但這個情境很特殊」的繞道
- 沒有需要維護的 policy YAML / DSL

**唯一例外：`confirm_with_user`**
- 它**阻塞** agent loop（loop pause、等 user 決定）
- 不是 mutation 但有 control flow 影響
- 實作：tool 執行時不立刻回傳，而是 emit `confirm_request` SSE event，前端 render 對話框，user 點按鈕後 server resume

---

## 6. SSE Event Protocol

擴充現有的 `apiStream`。新事件：

```
event: text             data: { text: "..." }
                        → ChatPanel render 進對應 assistant message

event: tool_call        data: { id, name, input }
                        → render 一張 collapsed tool card 「🔍 search_nodes("redis")」

event: tool_result      data: { id, result?: {...}, error?: "..." }
                        → 展開 tool card 顯示 result 或 error

event: confirm_request  data: { id, question, options }
                        → render inline dialog；user 選擇後 POST /api/ai/agent/confirm
                          with { confirm_id, choice }，server 解除阻塞

event: done             data: { iterations, total_tokens, trace_id }
                        → 結束狀態；trace_id 可用來查 agent_traces

event: budget_exhausted data: { reason, iterations, partial_trace }
                        → 顯示「Agent 用太多 context 了，要不要重開？」

event: cancelled        data: {}
                        → 使用者按 Stop 後 server cleanup

event: error            data: { message }
                        → 已有，保留
```

### 6.1 confirm_with_user 阻塞機制

```
[server] tool_call confirm_with_user(...) executed
    └─ Promise.race([
         awaitConfirm(id),    // resolves when frontend POSTs choice
         signal.aborted,
         timeout(120s),
       ])

[server] emits: event: confirm_request data: { id, question, options }

[frontend] ChatPanel renders dialog; user clicks "Option A"

[frontend] POST /api/ai/agent/confirm { confirm_id: id, choice: "A" }

[server] resolves awaitConfirm(id) with "A"
    └─ tool returns { choice: "A" }
    └─ Agent loop continues with tool_result
```

實作：server 維護一個 `pendingConfirms: Map<id, Deferred>`。timeout 內沒收到回應，視為 abort。

---

## 7. Frontend UI Patterns

### 7.1 ChatPanel additions

```
┌─ ChatPanel ────────────────────────────────┐
│ Suggestions (3 pending)                    │ ← existing
│ [merge card] [conflict card] [edge card]   │
├────────────────────────────────────────────┤
│ User: redis 跟 kafka 我寫過什麼差異？        │
│                                            │
│ Agent: 我查一下你的筆記。                   │
│ ┌─ 🔍 search_nodes("redis kafka")     ▾ ─┐│ ← tool card, click expand
│ │ found 3: "Message Queues",  ...        ││
│ └────────────────────────────────────────┘│
│ ┌─ 📖 read_node("mq")                  ▾ ─┐│
│ │ # Message Queues  ...                  ││
│ └────────────────────────────────────────┘│
│                                            │
│ 你寫了 Kafka 在 throughput 上贏，但...      │
│                                            │
│ [▼ Stop]                                   │ ← visible during agent run
├────────────────────────────────────────────┤
│ [ Type a message... ]                      │
└────────────────────────────────────────────┘
```

### 7.2 Tool card states

| State | Visual |
|---|---|
| Pending (called, no result yet) | 灰色 spinner 旁邊工具名 |
| Success (result arrived) | 綠 ✓ + collapsed result preview，點開展開 |
| Error | 紅 ✗ + error message inline |
| Cancelled | 灰色 — |

### 7.3 confirm_request dialog

```
┌─────────────────────────────────────────┐
│ Agent needs to clarify:                 │
│                                         │
│ "Do you want to merge these two nodes,  │
│  or just link them?"                    │
│                                         │
│ [ Merge ]  [ Link only ]  [ Cancel ]   │
└─────────────────────────────────────────┘
```

Inline in chat stream (not modal blocking) — agent 暫停等 user，user 滾走再回來還能看到。

---

## 8. Trace Persistence

### 8.1 Schema

```sql
CREATE TABLE agent_traces (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  canvas_key      TEXT NOT NULL,
  chat_message_id TEXT,                 -- links to the assistant message produced
  user_message    TEXT,                 -- the user input that triggered this turn
  iterations      INTEGER NOT NULL DEFAULT 0,
  tool_calls      TEXT,                 -- JSON: [{name, input, result|error, duration_ms, ts}]
  total_tokens    INTEGER,
  total_cost      REAL,                 -- estimated USD
  status          TEXT NOT NULL,        -- 'completed' | 'cancelled' | 'budget_exhausted' | 'error'
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  meta            TEXT                  -- JSON: model, system_prompt_hash, budget_config
);
CREATE INDEX idx_agent_traces_canvas ON agent_traces(workspace_id, canvas_key, started_at DESC);
CREATE INDEX idx_agent_traces_status ON agent_traces(workspace_id, status);
```

### 8.2 Write path

- Trace row created **at agent_loop start**（status='running'）
- Tool calls **batched-update** 每 N 個或 loop 結束時一次寫入（避免 N × write amplification）
- `ended_at` + final status 寫入 on `done` / `cancelled` / `budget_exhausted` / `error`

### 8.3 Use cases for traces

1. **Debug** — 用 `trace_id` 查 agent 為什麼做了那些決定
2. **Cost monitoring** — `SUM(total_cost) GROUP BY DATE(started_at)` 看每天花多少
3. **Tool usage analytics** — 看哪些 tool 常被用、哪些從來沒用過
4. **Future fine-tuning data** — 高品質的 (input, tool_sequence, output) 對

### 8.4 Retention

- Trace 保留 90 天，每日 cron job 刪舊資料
- 或：trace 跟對應的 chat_message lifecycle 綁定（chat 被清除時 trace 也清）

---

## 9. One-Click Apply（M4-β）

Phase 2 Feature 2 的 `accept` 只 mark resolved，不真的改 graph。M4-β 改成：

### 9.1 Suggestion type 對應的 apply 動作

| Type | Accept 行為 |
|---|---|
| `merge` | 1. 用 `merged_title` / `merged_body` 更新 ids[0]<br>2. 把所有指向 ids[1..n] 的 edges 重指向 ids[0]<br>3. 刪除 ids[1..n] |
| `conflict` | 在兩個 node 加 `conflict: { label, status: 'unresolved' }` field |
| `edge` (missing) | 新增 edge `{ from, to, label, dash: false }` |
| `create` | 新增 node 在 canvas empty spot |
| `update` | 套用 patch 到 node |
| `delete` | 刪 node + 相關 edges |
| `unlink` | 刪 edge |

### 9.2 Apply 路徑

```
[Frontend] User clicks 'accept' on SuggestionCard
    ↓
ChatPanel.handleAcceptSuggestion(s)
    ↓
1. applySuggestion(s, { mut, pushUndo, addToast })  // new helper in graphHelpers
    ↓
2. PATCH /api/db/suggestions/:id { status: 'accepted' }
    ↓
3. setSuggestions(prev => prev - s)
    ↓
4. addToast(`"${title}" applied — undo?`, () => undo())
```

`applySuggestion` 是個 dispatch function：

```js
export function applySuggestion(s, { mut, pushUndo, setGraph }) {
  pushUndo();
  switch (s.type) {
    case 'merge':  applyMerge(s.payload, mut);  return;
    case 'create': applyCreate(s.payload, mut); return;
    case 'edge':   applyEdge(s.payload, mut);   return;
    // ...
  }
}
```

### 9.3 Critical safety

- **每個 apply 必先 `pushUndo`** — 一鍵還原
- **Toast 帶 undo callback** — UX 上 5 秒內可悔棋
- **Apply 失敗（target node 已被刪等）→ 仍 mark suggestion resolved + toast 顯示理由**

---

## 10. Cost & Safety Budgets

| 項目 | 預設 | 可調 |
|---|---|---|
| Max iterations per turn | 10 | yes |
| Max input tokens per turn | 20K | yes |
| Max output tokens per turn | 4K | yes |
| Per-session $ soft cap | $0.50 | yes |
| Confirm timeout | 120s | yes |
| Trace retention | 90 days | yes |

預算撞牆時 yield `budget_exhausted`，前端顯示：
> Agent 在這輪用了 10 次工具還沒給答案。要 [簡化問題] 還是 [新開對話]？

---

## 10.5 Discovery Workflow Patterns

### 10.5.1 Proactive opener（無具體問題時）

當使用者開 free chat 且第一則訊息**沒有明確問題**（greeting / 模糊起手），Agent 主動跑 discovery 並 surface 高訊號發現：

```
[User]: 嗨 / 回來看看 / 我要寫筆記

[Agent internal sequence]
  1. get_user_focus()                  → 當前 canvas + drill
  2. recent_chat_messages(limit=10)    → 上次聊到哪
  3. find_unexplored_neighbors()       → "Sharding" 子節點 2 個月沒看
  4. find_density_imbalance()          → "Caching" 8 個 child vs "MQ" 1 個
  5. suggest_bridges("redis")          → Redis ↔ Pub/Sub 有 overlap 但沒邊

[Agent reply, 3-4 lines]
  歡迎回來。看了一下你的 System Design — 三個觀察：
  📌 "Sharding" 那條線你兩個月沒回去看了
  ⚖ "Caching" 寫了 8 個子節點但 "Message Queues" 只開了頭
  🔗 你的 Redis 跟 Pub/Sub 概念上有 overlap 但沒連邊
  
  想 dig 哪個？
```

### 10.5.2 Discovery-on-finish（每次答完問題加 1 行）

回答完使用者具體問題後，Agent **永遠**用一句 discovery 收尾：

```
[User]: Redis 跟 Memcached 差在哪？

[Agent: 答完 Q&A 後，最後一行]
  ...
  
  順便：我看到你有 Redis 但沒 Memcached node — 要不要我幫你補一個對比的？
```

這條由 system prompt 強制（見 §13 / Appendix B）。

### 10.5.3 Discovery → Propose → Apply 完整循環

```
discovery_tool → 找到 candidate
       ↓
agent textual: "我發現 X，要 propose Y 嗎？"
       ↓
[user: yes]
       ↓
propose_create_node / propose_link_nodes → 寫 suggestion
       ↓
SuggestionCard 顯示
       ↓
[user: accept]
       ↓
applySuggestion → 真的改 graph + pushUndo + toast
```

每一步使用者都有 opt-out 點。

---

## 11. Integration with Existing System

### 11.1 與 Slash 模式共存

| 入口 | 後端路徑 | 機制 |
|---|---|---|
| Free chat（無 `/`） | `POST /api/ai/agent` | **Agent loop** |
| `/warmup` | `POST /api/ai/chat` | 腳本 system prompt |
| `/quiz` | `POST /api/ai/chat` | 腳本 + judge tags |
| `/rehearse` | `POST /api/ai/chat` | 腳本 + role + state tag |
| `/audit` | `POST /api/ai/chat` | 一次性 JSON 回 |
| `/clear`, `/exit` | 純前端 | n/a |

模式之間的相容：
- Agent 可用 `hand_off_to_mode` 建議使用者進腳本模式
- 模式中無法呼叫 Agent（保持腳本嚴格性）
- 模式結束後**自動回到 Agent free chat**

### 11.2 與 `/audit` 共用 surface

- `propose_audit_finding` 寫的 suggestion 跟 `/audit` 一模一樣 schema
- 同一個 [SuggestionCard.jsx](../src/components/SuggestionCard.jsx) render
- 唯一差別：`meta.source = 'agent' | 'audit'`（debug 用）

### 11.3 與 chat_messages 持久化

- Agent 的自然語言訊息走 chat_messages（同 free chat 路徑）
- 工具呼叫只寫 agent_traces，**不**寫 chat_messages
- ChatPanel hydration 時：
  - 從 chat_messages load 訊息
  - 對應的 trace_id 從 message.meta 取出，**選用性**從 agent_traces 拉 tool calls 用來重 render tool cards
  - 沒 trace 也能正常 render（純文字）

---

## 12. Implementation Plan

### M4-α — Agent skeleton + Read-only tools
**範圍：** ~500 LOC，最小可用 agent
- `server/lib/agent/loop.js` — agent loop 主 logic
- `server/lib/agent/tools/` — 拆檔的 read-only tools
- `server/routes/agent.js` — SSE endpoint
- `server/db.js` — agent_traces table + helpers
- `src/lib/api.js` — `agentStream()` (extends apiStream with tool_call/tool_result events)
- `src/components/AgentToolCard.jsx` — collapsed/expanded tool card
- `src/components/panels/ChatPanel.jsx` — free chat 改走 agentStream + render tool cards

**Demo：** 「Agent 能查筆記、做多步推理回答問題、顯示思考軌跡」

### M4-β — Propose tools + One-click apply
**範圍：** ~250 LOC
- Add propose_* tools to tool registry
- Extend `node_suggestions.type` accepted values
- `src/lib/applySuggestion.js` — dispatch + per-type apply
- `ChatPanel.handleAcceptSuggestion` — 改用 applySuggestion
- Toast with undo for every apply

**Demo：** 「Agent 提議建/合併/連結節點，使用者一鍵套用 + 可 undo」

### M4-γ — Polish + safety
**範圍：** ~300 LOC
- `confirm_with_user` tool + frontend inline dialog + server pendingConfirms map
- Stop button mid-stream
- Budget enforcement + budget_exhausted UI
- Tool usage analytics endpoint (`GET /api/agent/usage`)
- Trace retention cron

**Demo：** 「能 cancel、能澄清、看得到本月 token 花費、舊 trace 自動清」

### Total: ~1050 LOC across 3 milestones

---

## 13. Open Questions / Future Work

1. **Streaming tool input** — Gemini's function calling sends tool_call as full block, not streamed token-by-token. Anthropic streams partial JSON. For M4-α we render tool_call as atomic; if we switch provider, may need to handle streaming.
2. **Tool call dedup** — if LLM calls `search_nodes("redis")` twice in one turn, do we cache? For now: no, accept the cost.
3. **Cross-session memory** — Agent currently sees only current chat_messages thread. Cross-canvas / cross-session memory is a Phase 5 problem.
4. **Tool versioning** — when tool schema changes, old traces become un-replayable. Add `meta.tool_version` per trace row.
5. **Rate limiting** — single user can spam agent calls. Add request rate cap server-side (`max 30 turns / 10 min`).
6. **Failure modes** — Gemini API down → tool call fails → what does the user see? Need clear error UX.

---

## Appendix A — Tool schema example

```js
// server/lib/agent/tools/search_nodes.js
export default {
  name: 'search_nodes',
  description: 'Keyword-search nodes in the current canvas. Returns up to 20 matches with title + summary. Use for "what did I write about X" questions.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'keywords to search for' },
      scope: {
        type: 'string',
        enum: ['canvas', 'topic', 'workspace'],
        default: 'canvas',
        description: 'canvas=current view; topic=root + all drills; workspace=everything',
      },
    },
    required: ['query'],
  },
  permission: 'read',
  async run({ query, scope = 'canvas' }, ctx) {
    const rows = searchNodesQuery(ctx.workspaceId, ctx.canvasKey, query, scope);
    return rows.slice(0, 20).map(n => ({
      id: n.id, title: n.title,
      summary: n.summary || (n.body || '').slice(0, 120),
    }));
  },
};
```

## Appendix B — Agent system prompt sketch

```
You are a curiosity prosthesis embedded in the user's personal knowledge graph.
Your primary job is to SURFACE knowledge structure the user hasn't noticed yet —
latent connections, coverage gaps, unexplored adjacencies — not to answer Q&A.

You have:
- READ tools (auto): search, read, traverse, memory stats, etc.
- DISCOVERY tools (auto): find unexplored / dormant / dense / sparse areas;
  inference tools that use a sub-LLM to suggest bridges, expansions, gaps.
- PROPOSE tools (write to suggestions table, user approves): create, update,
  delete, link, merge, unlink nodes/edges.
- META tools: confirm_with_user, hand_off_to_mode, end_session.

Behavioral rules (NEVER break):
1. SCOPE: you only see the current canvas + drill. NEVER assume cross-topic
   knowledge. If the user asks something not in current canvas, suggest they
   switch but don't try to fetch it.
2. Ground every claim in the user's notes. Use read_node + quote when relevant.
3. When comparing nodes, call read_node on each — never claim differences from
   titles alone. Quote specific phrases.
4. Propose changes via propose_* tools — never claim to have made changes.
5. When ambiguous, use confirm_with_user instead of guessing.
6. Keep replies concise (2-5 sentences). Heavy thinking goes in tool calls.

PROACTIVE DISCOVERY (this is your #1 job):
7. When the user opens with no specific question (greeting, "hi", "回來了",
   "我要寫筆記"), IMMEDIATELY run 2-3 discovery tools and surface findings.
8. After answering ANY question, end with ONE discovery offer:
   "I also noticed [observation] — want to dig in?"
9. Discovery findings must be:
   - HIGH SIGNAL — rank by interestingness; surface max 3 per opener
   - ACTION-ORIENTED — one line each, let user opt into details
   - SPECIFIC — name the node titles involved, not vague
10. Never lecture. Never dump full analysis. Show pointers, let user pull.

PARALLELISM:
11. Read + Discovery tools CAN be called in parallel. Propose tools NEVER in
    parallel — only one mutation proposal per turn.

[Current view]: ${contextPack.canvasLabel}
[Drilled into]: ${contextPack.drillParent?.title || '(root)'}
[Total nodes in view]: ${contextPack.nodeCount}
[Recent activity]: ${recentEditsCount} nodes edited last 7d
```

---

## Appendix C — Decision log

| Decision | Choice | Rationale |
|---|---|---|
| Agent primary role | Curiosity prosthesis (proactive discovery), not Q&A | User insight; differentiates from generic chat |
| Free chat vs separate /agent | Free chat = Agent | Simpler mental model |
| Scope per turn | Current canvas + drill only | Workspace isolation is product feature |
| Cross-canvas search | NO (tool removed) | Don't pollute mental context; suggest manual switch |
| Framework (LangGraph/MCP) | Hand-rolled | 1 client, 1 provider; framework cost > value |
| LLM provider | Gemini (defer Anthropic switch) | Momentum; switch later if tool use accuracy issues |
| Trace storage | SQLite agent_traces | Same store as everything else; queryable; cheap |
| Permission model | Naming convention (`propose_*`) | Stronger than runtime policy; impossible to bypass |
| compare_nodes tool | NO — agent uses read_node × N | Higher accuracy via explicit grounding |
| confirm_with_user | YES — blocking tool | Without it, agent guesses user intent constantly |
| One-click apply | M4-β | Closes the loop; without it Agent is "homework for user" |
| Discovery tools tier | Tier 1.5 (auto-execute like reads) | Should fire automatically; making them propose would over-friction discovery |
| Sub-LLM call tools | Allowed inside discovery tools | Accept cost for unknown-unknown quality |
