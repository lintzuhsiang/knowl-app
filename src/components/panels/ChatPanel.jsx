import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { api, apiStream, agentStream, resolveAgentConfirm, getText, parseJ } from "../../lib/api";
import AgentToolCard from "../AgentToolCard";
import {
  loadChatHistory, loadMemoryStats, clearChatHistory, setNodeRecall,
  loadSuggestions, createSuggestion, resolveSuggestion,
} from "../../api/graphSync";
import { formatContextPack } from "../../lib/graphHelpers";
import { parseSlash, autocompleteFor, COMMANDS } from "../../lib/slashCommands";
import SlashAutocomplete from "../SlashAutocomplete";
import SuggestionCard from "../SuggestionCard";
import { pickWarmupNodes, buildWarmupSystemPrompt, KICKOFF_USER_MESSAGE as WARMUP_KICKOFF } from "../../lib/modes/warmup";
import {
  pickQuizNodes, buildQuizSystemPrompt, parseJudgement, stripQuizTags,
  SCORE_MAP, emaUpdate, summarizeQuizSession,
  KICKOFF_USER_MESSAGE as QUIZ_KICKOFF,
} from "../../lib/modes/quiz";
import {
  parseRoleArgs, buildRehearseSystemPrompt, parseRehearseState, stripRehearseTags,
  KICKOFF_USER_MESSAGE as REHEARSE_KICKOFF,
} from "../../lib/modes/rehearse";
import { buildAuditPrompt, parseAuditResponse, auditToSuggestions } from "../../lib/modes/audit";
import TraceViewerModal from "../TraceViewerModal";

const IDLE_THRESHOLD_MS = 18000; // idle after AI reply before summary nudge
const IDLE_MIN_CONCEPTS = 3;     // need this many uncommitted concepts to nudge
const IDLE_POLL_MS = 2000;
const PULSE_CLEAR_MS = 2200;  // chip pulse animation duration

/**
 * ChatPanel — persistent right-side conversational chat with dynamic concept
 *             accumulation, AI-assisted upsert/merge, and review-before-commit.
 *
 * Props:
 *   topic, nodes, accent                   — context
 *   messages, concepts                     — lifted state from App
 *   onMessagesChange, onConceptsChange     — setters (support updater fn)
 *   onAddNodes(concepts)                   — commit to canvas
 *   width                                  — panel width
 */
export default function ChatPanel({
  topic, canvasKey, nodes, contextPack, accent,
  messages, concepts,
  onMessagesChange, onConceptsChange,
  onAddNodes, onApplySuggestion, width,
}) {
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // mode === null → free chat. Otherwise: { name, args, systemPrompt, picks }
  const [mode, setMode] = useState(null);
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  const [suggestions, setSuggestions] = useState([]);
  // Pending confirm_with_user dialog from agent (M4-γ). null = no dialog.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  // AbortController for current agent / api stream (Stop button)
  const abortRef = useRef(null);
  const [traceViewerOpen, setTraceViewerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selected, setSelected] = useState({});       // id → bool (add-to-canvas)
  const [mergeSel, setMergeSel] = useState({});       // id → bool (merge mode)
  const [editingId, setEditingId] = useState(null);     // which concept is being edited

  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [idleNudge, setIdleNudge] = useState(false);
  const [dismissedAtCount, setDismissedAtCount] = useState(0);
  const [recentlyAdded, setRecentlyAdded] = useState(() => new Set());
  const [recentlyRefined, setRecentlyRefined] = useState(() => new Set());

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const lastActivity = useRef(Date.now());

  const uncommitted = useMemo(() => concepts.filter(c => !c.committed), [concepts]);
  const committed = useMemo(() => concepts.filter(c => c.committed), [concepts]);

  // ── Hydrate from persisted server history (once per canvas) ───────────────
  // Only hydrates when local is empty — preserves in-progress conversation
  // if the user is mid-session. Server is the source of truth on cold start.
  const hydratedFor = useRef(null);
  useEffect(() => {
    if (!canvasKey || hydratedFor.current === canvasKey) return;
    if (messages.length > 0) { hydratedFor.current = canvasKey; return; }
    let cancelled = false;
    loadChatHistory(canvasKey).then(history => {
      if (cancelled) return;
      hydratedFor.current = canvasKey;
      if (history.length === 0) return;
      const restored = history.map(m => ({
        role: m.role,
        content: m.content,
        ts: m.ts,
        meta: m.meta || null,
        ...(m.streaming ? { interrupted: true } : {}),
      }));
      onMessagesChange(restored);
    });
    return () => { cancelled = true; };
  }, [canvasKey, messages.length, onMessagesChange]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  // ── iOS / mobile background → foreground SSE recovery ─────────────────────
  // When the tab goes hidden long enough that the OS suspends the WebView
  // (iOS Capacitor is the worst offender), the SSE connection is silently
  // killed but our reader just hangs waiting for bytes that never arrive —
  // the UI stays in "thinking" forever. Detect a > 10s hidden gap on
  // visibility return and abort the dead stream so the user sees the error
  // path and can retry instead of staring at a frozen spinner.
  useEffect(() => {
    if (!thinking) return;
    let hiddenAt = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = null;
        if (hiddenFor > 10000 && abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [thinking]);

  // ── Activity clock: reset ONLY when user is actively engaged ──────────────
  // (1) When user types a keystroke — they're actively composing
  // Not on messages.length (that fires on user send AND on AI reply).
  useEffect(() => {
    if (input) {
      lastActivity.current = Date.now();
      setIdleNudge(false);
    }
  }, [input]);

  // (2) When the AI finishes replying, start the idle countdown fresh.
  //     That way the 18s runs from "AI done" → "user still not engaged".
  const wasThinking = useRef(false);
  useEffect(() => {
    if (wasThinking.current && !thinking) {
      lastActivity.current = Date.now();
    }
    wasThinking.current = thinking;
  }, [thinking]);

  // ── Idle-based nudge trigger ───────────────────────────────────────────────
  useEffect(() => {
    if (uncommitted.length < IDLE_MIN_CONCEPTS) return;
    if (uncommitted.length <= dismissedAtCount) return;
    const t = setInterval(() => {
      if (reviewOpen || thinking) return;
      if (Date.now() - lastActivity.current > IDLE_THRESHOLD_MS) {
        setIdleNudge(true);
      }
    }, IDLE_POLL_MS);
    return () => clearInterval(t);
  }, [uncommitted.length, dismissedAtCount, reviewOpen, thinking]);

  // ── Clear pulse-animation state ────────────────────────────────────────────
  useEffect(() => {
    if (recentlyAdded.size === 0) return;
    const t = setTimeout(() => setRecentlyAdded(new Set()), PULSE_CLEAR_MS);
    return () => clearTimeout(t);
  }, [recentlyAdded]);
  useEffect(() => {
    if (recentlyRefined.size === 0) return;
    const t = setTimeout(() => setRecentlyRefined(new Set()), PULSE_CLEAR_MS);
    return () => clearTimeout(t);
  }, [recentlyRefined]);

  // ── Prompts ────────────────────────────────────────────────────────────────
  // Structural context pack replaces the old flat "node titles" injection.
  // Includes breadcrumb, drill-parent body, in-canvas hierarchy + edges.
  const contextStr = useMemo(
    () => formatContextPack(contextPack, { bodyTruncate: 0 }) || `CURRENT VIEW: ${topic}\n(no nodes captured yet)`,
    [contextPack, topic]
  );
  // Kept for prompts that just need a flat list (e.g. uncommitted-vs-existing dedup).
  const nodeList = Object.values(nodes).map(n => `"${n.title}"`).join(", ") || "(none yet)";

  const systemPrompt =
    `You are a knowledge-mapping assistant helping the user think through their notes.\n\n` +
    `${contextStr}\n\n` +
    `Be conversational, curious, and concise — 2-4 sentences per reply. ` +
    `Ask follow-up questions to draw out deeper understanding. ` +
    `When the user explains something, reflect it back and connect it to existing nodes by title when relevant. ` +
    `When a new concept fits a specific node in the current view, mention which one. ` +
    `Do NOT enumerate node lists or act like a database. Just have a natural conversation.`;

  // ── Suggestions (Feature 2) — load pending on canvas mount ────────────────
  const suggestionsLoadedFor = useRef(null);
  useEffect(() => {
    if (!canvasKey || suggestionsLoadedFor.current === canvasKey) return;
    let cancelled = false;
    loadSuggestions(canvasKey).then(items => {
      if (cancelled) return;
      suggestionsLoadedFor.current = canvasKey;
      setSuggestions(items || []);
    });
    return () => { cancelled = true; };
  }, [canvasKey]);

  // M4-γ — Stop button: aborts current agent / chat stream
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingConfirm(null);
  }, []);

  // M4-γ — resolve confirm_with_user from inline dialog
  const handleConfirmChoice = useCallback(async (choice) => {
    if (!pendingConfirm) return;
    const id = pendingConfirm.id;
    setPendingConfirm(null);
    await resolveAgentConfirm(id, choice);
    // Agent loop will unblock + emit tool_result on its own; UI updates from that.
  }, [pendingConfirm]);

  // handleHandoffClick is defined later (after handleSlash) to avoid TDZ.

  const handleAcceptSuggestion = useCallback(async (s) => {
    // 1. Apply to graph (App.jsx callback handles pushUndo + toast)
    if (onApplySuggestion) {
      const result = onApplySuggestion(s);
      if (!result?.ok) {
        // Don't resolve — leave the suggestion pending so user can retry / inspect
        return;
      }
    }
    // 2. Mark resolved in DB
    await resolveSuggestion(s.id, "accepted").catch(() => { });
    // 3. Remove from local list
    setSuggestions(prev => prev.filter(x => x.id !== s.id));
  }, [onApplySuggestion]);

  const handleDismissSuggestion = useCallback(async (s) => {
    await resolveSuggestion(s.id, "dismissed").catch(() => { });
    setSuggestions(prev => prev.filter(x => x.id !== s.id));
  }, []);

  // ── Slash autocomplete state (derived from input) ─────────────────────────
  const autocompleteItems = useMemo(() => autocompleteFor(input), [input]);
  const slashOpen = autocompleteItems.length > 0;
  useEffect(() => { setAutocompleteIdx(0); }, [autocompleteItems.length]);

  /** Insert a completion into the input (replaces the slash fragment). */
  const insertCommand = useCallback((item) => {
    if (!item.ready) return;
    setInput(item.label + (item.argsHint ? " " : ""));
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  /** Push a local-only system note (not persisted, filtered out of LLM payload). */
  const pushSystemNote = useCallback((content) => {
    onMessagesChange(prev => [
      ...prev,
      { role: "assistant", content, ts: Date.now(), meta: { system: true, transient: true } },
    ]);
  }, [onMessagesChange]);

  /** Kick off the first AI turn when entering a mode. */
  const kickoffMode = useCallback(async (modeState) => {
    if (thinking) return;
    setThinking(true);
    const aiTs = Date.now();
    const isAi = (m) => m.role === "assistant" && m.ts === aiTs;
    onMessagesChange(prev => [...prev, {
      role: "assistant", content: "", ts: aiTs, streaming: true,
      meta: { mode: modeState.name, kickoff: true },
    }]);
    try {
      const aiText = await apiStream(
        [{ role: "user", content: modeState.kickoffMessage || WARMUP_KICKOFF }],
        modeState.systemPrompt,
        500,
        {
          persist: canvasKey
            ? { canvasKey, assistantMeta: { mode: modeState.name, kickoff: true } }
            : undefined,
          onToken: (_chunk, full) => {
            onMessagesChange(prev => {
              const next = [...prev];
              const idx = next.findIndex(isAi);
              if (idx >= 0) next[idx] = { ...next[idx], content: full };
              return next;
            });
          },
        }
      );
      onMessagesChange(prev => {
        const next = [...prev];
        const idx = next.findIndex(isAi);
        if (idx >= 0) next[idx] = { ...next[idx], content: aiText, streaming: false };
        return next;
      });
    } catch {
      onMessagesChange(prev => prev.filter(m => !(m.role === "assistant" && m.ts === aiTs)));
    } finally {
      setThinking(false);
    }
  }, [canvasKey, onMessagesChange, thinking]);

  /** Dispatch a parsed slash command. */
  const handleSlash = useCallback(async ({ command, args, known }) => {
    if (!known) {
      pushSystemNote(`⚠ Unknown command: /${command}. Type / to see options.`);
      return;
    }
    const meta = COMMANDS[command];
    if (!meta.ready) {
      pushSystemNote(`/${command} is not ready yet — coming in a later milestone.`);
      return;
    }
    switch (command) {
      case "exit":
        if (!mode) { pushSystemNote("Not in a mode."); return; }
        setMode(null);
        return;
      case "clear":
        await clearChatHistory(canvasKey).catch(() => { });
        onMessagesChange([]);
        setMode(null);
        return;
      case "warmup": {
        const memoryStats = await loadMemoryStats(canvasKey);
        const picks = pickWarmupNodes(contextPack, memoryStats, args);
        const sysPrompt = buildWarmupSystemPrompt(contextPack, memoryStats, picks, args);
        const modeState = {
          name: "warmup", args, systemPrompt: sysPrompt, picks,
          kickoffMessage: WARMUP_KICKOFF,
        };
        setMode(modeState);
        await kickoffMode(modeState);
        return;
      }
      case "quiz": {
        const memoryStats = await loadMemoryStats(canvasKey);
        const picks = pickQuizNodes(contextPack, memoryStats, args, 5);
        if (picks.length === 0) {
          pushSystemNote("No quizzable nodes in this view yet — nodes need at least ~50 characters of body.");
          return;
        }
        const sysPrompt = buildQuizSystemPrompt(contextPack, picks, args);
        // Cache old recall_scores so EMA updates have a baseline
        const oldScores = new Map((memoryStats || []).map(s => [s.id, s.recall_score]));
        const modeState = {
          name: "quiz", args, systemPrompt: sysPrompt, picks,
          kickoffMessage: QUIZ_KICKOFF,
          currentIdx: 0,
          judgements: [],
          oldScores,
        };
        setMode(modeState);
        pushSystemNote(`Closed-book quiz on ${picks.length} node${picks.length === 1 ? "" : "s"}. Try not to peek at the canvas. /exit to abort.`);
        await kickoffMode(modeState);
        return;
      }
      case "rehearse": {
        const roleArgs = parseRoleArgs(args);
        if (!roleArgs.rolePrompt) {
          pushSystemNote("Usage: /rehearse <interviewer|examiner|colleague|skeptic|custom: ...>");
          return;
        }
        const sysPrompt = buildRehearseSystemPrompt(contextPack, roleArgs);
        const modeState = {
          name: "rehearse", args, systemPrompt: sysPrompt,
          kickoffMessage: REHEARSE_KICKOFF,
          role: roleArgs,
        };
        setMode(modeState);
        pushSystemNote(`Rehearse — role: ${roleArgs.label}. AI stays in character until ~8-10 exchanges or /exit.`);
        await kickoffMode(modeState);
        return;
      }
      case "audit": {
        if (!contextPack || contextPack.nodeCount < 2) {
          pushSystemNote("Need at least 2 nodes in the view to audit.");
          return;
        }
        const prompt = buildAuditPrompt(contextPack);
        if (!prompt) return;
        setThinking(true);
        pushSystemNote("Auditing canvas for merges, conflicts, missing edges…");
        try {
          const raw = await api([{ role: "user", content: prompt }], null, 1500);
          const text = getText(raw);
          const parsed = parseAuditResponse(text);
          if (!parsed) {
            pushSystemNote("Audit failed — response wasn't valid JSON. Try again.");
            return;
          }
          const knownIds = new Set(contextPack.nodes.map(n => n.id));
          const records = auditToSuggestions(parsed, knownIds);
          if (records.length === 0) {
            pushSystemNote("✓ Audit complete — no high-confidence issues found.");
            return;
          }
          await Promise.all(records.map(r => createSuggestion(canvasKey, r.type, r.payload)));
          const updated = await loadSuggestions(canvasKey);
          setSuggestions(updated || []);
          const counts = records.reduce((m, r) => ({ ...m, [r.type]: (m[r.type] || 0) + 1 }), {});
          const parts = [
            counts.merge && `${counts.merge} merge`,
            counts.conflict && `${counts.conflict} conflict`,
            counts.edge && `${counts.edge} missing edge`,
          ].filter(Boolean).join(", ");
          pushSystemNote(`✓ Audit complete — ${parts}. Review above.`);
        } catch (e) {
          pushSystemNote(`Audit failed: ${e.message || e}`);
        } finally {
          setThinking(false);
        }
        return;
      }
      default:
        pushSystemNote(`No handler for /${command}.`);
    }
  }, [canvasKey, contextPack, mode, onMessagesChange, pushSystemNote, kickoffMode]);

  // M4-γ — Agent tool result with hand_off_to_mode → user clicks button to enter mode
  const handleHandoffClick = useCallback((handoff) => {
    if (!handoff?.mode) return;
    abortRef.current?.abort();
    abortRef.current = null;
    handleSlash({ command: handoff.mode, args: handoff.scope || '', known: true });
  }, [handleSlash]);

  // ── Send a user message ────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || thinking) return;

    // Slash command path — never reaches the LLM
    const slash = parseSlash(text);
    if (slash) {
      setInput("");
      inputRef.current && (inputRef.current.style.height = "auto");
      await handleSlash(slash);
      return;
    }

    setInput("");
    inputRef.current && (inputRef.current.style.height = "auto");

    // Filter out transient system notes + tool invocations from history sent to LLM
    const persistentMessages = messages.filter(m => !m.meta?.transient && m.role !== 'tool_invocation');
    const userMsg = { role: "user", content: text, ts: Date.now() };
    const nextMsgs = [...persistentMessages, userMsg];
    onMessagesChange([...messages, userMsg]); // keep transient notes + tool cards visible locally
    setThinking(true);

    const aiTs = Date.now() + 1;
    const isAi = (m) => m.role === "assistant" && m.ts === aiTs;
    onMessagesChange(prev => [...prev, {
      role: "assistant", content: "", ts: aiTs, streaming: true,
      ...(mode ? { meta: { mode: mode.name } } : { meta: { agent: true } }),
    }]);

    // Route: mode → apiStream with mode prompt;  no mode → agentStream (Phase 4)
    const useAgent = !mode;
    const activeSystemPrompt = mode ? mode.systemPrompt : systemPrompt;

    try {
      const payload = nextMsgs.map(m => ({ role: m.role, content: m.content }));
      let aiText;

      if (useAgent) {
        abortRef.current = new AbortController();
        aiText = await agentStream(payload, contextPack, {
          signal: abortRef.current.signal,
          persist: canvasKey
            ? {
              canvasKey,
              userMessage: { content: text, meta: { ts: userMsg.ts } },
            }
            : undefined,
          onConfirmRequest: ({ id, question, options }) => {
            setPendingConfirm({ id, question, options });
          },
          onToken: (_chunk, full) => {
            onMessagesChange(prev => {
              const next = [...prev];
              const idx = next.findIndex(isAi);
              if (idx >= 0) next[idx] = { ...next[idx], content: full };
              return next;
            });
          },
          onToolCall: ({ id, name, input }) => {
            // Insert tool card just BEFORE the streaming assistant message
            onMessagesChange(prev => {
              const next = [...prev];
              const aiIdx = next.findIndex(isAi);
              const entry = {
                role: 'tool_invocation',
                toolCall: { id, name, input },
                state: 'pending',
                ts: Date.now(),
              };
              if (aiIdx >= 0) next.splice(aiIdx, 0, entry);
              else next.push(entry);
              return next;
            });
          },
          onToolResult: ({ id, result, error, duration_ms }) => {
            onMessagesChange(prev => prev.map(m =>
              m.role === 'tool_invocation' && m.toolCall?.id === id
                ? { ...m, state: error ? 'error' : 'success', result, error, durationMs: duration_ms }
                : m
            ));
            // Propose tools return { suggestion: {...} } — surface card immediately
            if (result?.suggestion) {
              setSuggestions(prev => {
                if (prev.some(s => s.id === result.suggestion.id)) return prev;
                return [result.suggestion, ...prev];
              });
            }
          },
          onBudget: ({ reason, iterations }) => {
            pushSystemNote(
              reason === 'tokens'
                ? `Agent stopped — too much context (after ${iterations} iterations). Try a more focused question.`
                : `Agent stopped after ${iterations} iterations without converging. Try a more specific question.`
            );
          },
        });
      } else {
        aiText = await apiStream(payload, activeSystemPrompt, 800, {
          persist: canvasKey
            ? {
              canvasKey,
              userMessage: { content: text, meta: { ts: userMsg.ts, mode: mode.name } },
              assistantMeta: { mode: mode.name },
            }
            : undefined,
          onToken: (_chunk, full) => {
            onMessagesChange(prev => {
              const next = [...prev];
              const idx = next.findIndex(isAi);
              if (idx >= 0) next[idx] = { ...next[idx], content: full };
              return next;
            });
          },
        });
      }
      if (!aiText && useAgent) {
        // Agent may legitimately end a turn with only tool calls — treat empty text as OK
        aiText = '';
      } else if (!aiText || aiText.trim() === "") throw new Error("empty");
      onMessagesChange(prev => {

        const next = [...prev];
        const idx = next.findIndex(isAi);
        console.log(prev, next)
        if (idx >= 0) next[idx] = { ...next[idx], content: aiText, streaming: false };
        return next;
      });
      // Concept extraction only runs in free chat — not in mode sessions
      if (!mode) extractConcepts(text, aiText);

      // Quiz post-processing: parse judgement tag, update recall_score, advance state
      if (mode?.name === "quiz") {
        const { judgement, done } = parseJudgement(aiText);
        const currentNode = mode.picks[mode.currentIdx];
        if (judgement && judgement !== "NONE" && currentNode) {
          const latest = SCORE_MAP[judgement];
          const oldScore = mode.oldScores.get(currentNode.id);
          const newScore = emaUpdate(oldScore, latest);
          if (newScore != null) {
            setNodeRecall(currentNode.id, newScore).catch(() => { });
            mode.oldScores.set(currentNode.id, newScore);
          }
          // Advance state immutably so the next turn knows it
          setMode(prev => prev && prev.name === "quiz" ? {
            ...prev,
            currentIdx: prev.currentIdx + 1,
            judgements: [...prev.judgements, judgement],
          } : prev);
        }
        if (done) {
          // Build summary from latest mode state (use mode reference; setMode is async)
          const finalJudgements = [...mode.judgements, judgement || null].filter(Boolean);
          const summary = summarizeQuizSession(mode.picks, finalJudgements);
          const weakStr = summary.weakNodes.length
            ? ` Weakest: ${summary.weakNodes.slice(0, 3).map(t => `"${t}"`).join(", ")}.`
            : "";
          const accStr = summary.accuracy != null
            ? ` Accuracy ~${Math.round(summary.accuracy * 100)}% (${summary.counts.CORRECT}/${summary.completed} fully correct).`
            : "";
          pushSystemNote(`Quiz session ended.${accStr}${weakStr}`);
          setMode(null);
        }
      }

      // Rehearse post-processing: detect [STATE:DONE] and end session
      if (mode?.name === "rehearse") {
        const { done } = parseRehearseState(aiText);
        if (done) {
          pushSystemNote("Rehearsal ended. Read the AI's final feedback above.");
          setMode(null);
        }
      }
    } catch (err) {
      // Specific UX for known server error codes (rate limit / token budget)
      let msg = "⚠️ Something went wrong. Please try again.";
      console.log('err: ', err)
      if (err?.code === 'RATE_LIMITED') {
        const sec = err.retryAfter || 60;
        msg = `⏱ Too many requests. Try again in ${sec}s.`;
      } else if (err?.code === 'TOKEN_BUDGET_EXCEEDED') {
        const pct = err.limit ? Math.round((err.used / err.limit) * 100) : 100;
        const resetsIn = err.resetsAt
          ? `${Math.max(1, Math.ceil((err.resetsAt - Date.now()) / 3600000))}h`
          : 'tomorrow';
        msg = `🛑 Daily AI budget reached (${err.used?.toLocaleString() || '?'} / ${err.limit?.toLocaleString() || '?'} tokens, ${pct}%). Resets in ${resetsIn}.`;
      }
      onMessagesChange(prev => {
        const next = prev.filter(m => !isAi(m));
        return [...next, { role: "assistant", content: msg, ts: Date.now(), error: true }];
      });
    } finally {
      setThinking(false);
    }
  }, [input, thinking, messages, onMessagesChange, systemPrompt, mode, handleSlash, canvasKey, pushSystemNote]);

  // ── Background concept extraction with UPSERT (option I: AI auto-merge) ────
  const extractConcepts = useCallback(async (userTurn, aiTurn) => {
    const uncommittedList = concepts
      .filter(c => !c.committed)
      .map(c => `- [id:${c.id}] "${c.title}": ${(c.body || "").replace(/\n/g, " ")}`)
      .join("\n") || "(none yet)";

    const prompt =
      `A user is having a conversation captured into a knowledge graph.\n\n` +
      `${contextStr}\n\n` +
      `Currently accumulated (uncommitted) concepts not yet on the canvas:\n${uncommittedList}\n\n` +
      `Latest exchange:\n` +
      `User: ${userTurn}\n` +
      `AI: ${aiTurn}\n\n` +
      `Decide two things:\n` +
      `1. ADD — Any NEW distinct concepts introduced that aren't already covered ` +
      `by an existing committed node OR an uncommitted concept?\n` +
      `2. REFINE — Does this exchange deepen/extend an existing uncommitted concept? ` +
      `Return its id plus an updated body merging old info + the new nuance.\n\n` +
      `Be selective — only include genuinely substantive ideas. ` +
      `Prefer REFINE over ADD when a concept is clearly the same idea. ` +
      `If a new concept clearly belongs under an existing node in the current view, ` +
      `still ADD it (we'll link hierarchy later); just keep titles tight.\n\n` +
      `Return ONLY JSON (no prose):\n` +
      `{"add":[{"title":"short title","body":"1-2 markdown bullets"}],` +
      `"refine":[{"id":"existing-id","body":"updated body with new info merged"}]}\n` +
      `Return {"add":[],"refine":[]} if nothing applies.`;

    try {
      const raw = await api([{ role: "user", content: prompt }], null, 800);
      const parsed = parseJ(getText(raw));
      const addArr = Array.isArray(parsed?.add) ? parsed.add : [];
      const refineArr = Array.isArray(parsed?.refine) ? parsed.refine : [];
      if (addArr.length === 0 && refineArr.length === 0) return;

      // Compute new concepts synchronously so we can track them for pulse anim.
      const existingTitles = new Set(concepts.map(c => c.title.toLowerCase()));
      const newOnes = addArr
        .filter(c => c.title && !existingTitles.has(c.title.toLowerCase()))
        .map(c => ({
          id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: c.title,
          body: c.body || "",
          committed: false,
          refineCount: 0,
        }));

      if (newOnes.length > 0) {
        setRecentlyAdded(prev => {
          const s = new Set(prev);
          newOnes.forEach(n => s.add(n.id));
          return s;
        });
      }

      // Which existing concepts actually got refined (body changed, not committed)?
      const refinedIds = new Set();
      concepts.forEach(c => {
        const r = refineArr.find(x => x.id === c.id);
        if (r && !c.committed && r.body && r.body !== c.body) refinedIds.add(c.id);
      });
      if (refinedIds.size > 0) {
        setRecentlyRefined(prev => {
          const s = new Set(prev);
          refinedIds.forEach(id => s.add(id));
          return s;
        });
      }

      onConceptsChange(prev => {
        const existing = new Set(prev.map(c => c.title.toLowerCase()));
        const trulyNew = newOnes.filter(n => !existing.has(n.title.toLowerCase()));
        const refined = prev.map(c => {
          const r = refineArr.find(x => x.id === c.id);
          if (r && !c.committed && r.body && r.body !== c.body) {
            return { ...c, body: r.body, refineCount: (c.refineCount || 0) + 1 };
          }
          return c;
        });
        return trulyNew.length > 0 ? [...refined, ...trulyNew] : refined;
      });
    } catch {
      /* silent — concept extraction is non-critical */
    }
  }, [concepts, topic, nodeList, onConceptsChange]);

  // ── Fetch AI merge suggestions (option III: on review-open) ────────────────
  const fetchMergeSuggestions = useCallback(async (list) => {
    if (list.length < 2) { setSuggestions([]); return; }
    setSuggestionsLoading(true);
    const listStr = list
      .map((c, i) => `${i + 1}. [id:${c.id}] "${c.title}": ${(c.body || "").replace(/\n/g, " ")}`)
      .join("\n");
    const prompt =
      `You are reviewing knowledge concepts captured from a conversation about "${topic}":\n${listStr}\n\n` +
      `Identify any pairs or groups that represent the SAME underlying concept and should be merged. ` +
      `Do NOT suggest merging concepts that are merely related or thematically adjacent — only truly redundant ones. ` +
      `For each merge, propose a combined title and body that preserves the info from all sources.\n\n` +
      `Return ONLY JSON:\n` +
      `{"suggestions":[{"ids":["id1","id2"],"mergedTitle":"...","mergedBody":"...","reason":"1 sentence"}]}\n` +
      `Return {"suggestions":[]} if all are distinct.`;
    try {
      const raw = await api([{ role: "user", content: prompt }], null, 700);
      const parsed = parseJ(getText(raw));
      const valid = (parsed?.suggestions || [])
        .filter(s => Array.isArray(s.ids) && s.ids.length >= 2)
        .map((s, i) => ({ id: `sug-${Date.now()}-${i}`, ...s }));
      setSuggestions(valid);
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [topic]);

  // ── Concept CRUD ───────────────────────────────────────────────────────────
  const updateConcept = useCallback((id, patch) => {
    onConceptsChange(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, [onConceptsChange]);

  const deleteConcept = useCallback((id) => {
    onConceptsChange(prev => prev.filter(c => c.id !== id));
    setSelected(prev => { const n = { ...prev }; delete n[id]; return n; });
    setMergeSel(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (editingId === id) setEditingId(null);
  }, [onConceptsChange, editingId]);

  const mergeSelected = useCallback(() => {
    const ids = Object.keys(mergeSel).filter(id => mergeSel[id]);
    if (ids.length < 2) return;
    const toMerge = uncommitted.filter(c => ids.includes(c.id));
    if (toMerge.length < 2) return;
    const merged = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: toMerge[0].title,
      body: toMerge.map(c => c.body || "").filter(Boolean).join("\n"),
      committed: false,
    };
    onConceptsChange(prev => [...prev.filter(c => !ids.includes(c.id)), merged]);
    setMergeSel({});
    setEditingId(merged.id); // open editor so user can refine the merged title/body
  }, [mergeSel, uncommitted, onConceptsChange]);

  const acceptSuggestion = useCallback((sug) => {
    const merged = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: sug.mergedTitle || "Merged concept",
      body: sug.mergedBody || "",
      committed: false,
    };
    onConceptsChange(prev => [...prev.filter(c => !sug.ids.includes(c.id)), merged]);
    setSuggestions(prev => prev.filter(s => s.id !== sug.id));
  }, [onConceptsChange]);

  const dismissSuggestion = (id) =>
    setSuggestions(prev => prev.filter(s => s.id !== id));

  // ── Commit selected concepts to canvas ─────────────────────────────────────
  const handleAddToCanvas = useCallback(() => {
    const toAdd = uncommitted.filter(c => selected[c.id] !== false);
    if (!toAdd.length) return;
    onAddNodes(toAdd);
    onConceptsChange(prev =>
      prev.map(c => toAdd.find(t => t.id === c.id) ? { ...c, committed: true } : c)
    );
    setSelected({});
    setMergeSel({});
    setReviewOpen(false);
    setEditingId(null);
  }, [uncommitted, selected, onAddNodes, onConceptsChange]);

  // ── Open / close review ────────────────────────────────────────────────────
  const openReview = useCallback(() => {
    const init = {};
    uncommitted.forEach(c => { init[c.id] = true; });
    setSelected(init);
    setMergeSel({});
    setReviewOpen(true);
    setIdleNudge(false);
    setSuggestions([]);
    fetchMergeSuggestions(uncommitted);
  }, [uncommitted, fetchMergeSuggestions]);

  const closeReview = () => {
    setReviewOpen(false);
    setEditingId(null);
    setMergeSel({});
  };

  const toggleSelect = id =>
    setSelected(prev => ({ ...prev, [id]: prev[id] === false ? true : !(prev[id] ?? true) }));
  const toggleMerge = id =>
    setMergeSel(prev => ({ ...prev, [id]: !prev[id] }));

  const mergeCount = Object.values(mergeSel).filter(Boolean).length;
  const addCount = uncommitted.filter(c => selected[c.id] !== false).length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: width || 320, flexShrink: 0,
      borderLeft: "0.5px solid rgba(0,0,0,0.08)",
      background: "var(--color-background-primary)",
      display: "flex", flexDirection: "column",
      fontFamily: "'Inter',system-ui,sans-serif",
      position: "relative", overflow: "hidden",
    }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px",
        borderBottom: "0.5px solid rgba(0,0,0,0.08)",
        flexShrink: 0,
      }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: accent, flexShrink: 0 }} />
        <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)" }}>
          Chat · {topic}
        </div>
        <button
          onClick={() => setTraceViewerOpen(true)}
          title="View past agent runs (tool calls + token cost)"
          style={{
            fontFamily: "inherit", fontSize: 10, fontWeight: 600,
            padding: "3px 8px", borderRadius: 5,
            border: "0.5px solid rgba(0,0,0,0.12)",
            background: "transparent",
            color: "var(--color-text-tertiary)",
            cursor: "pointer",
          }}
        >Traces</button>
      </div>

      {traceViewerOpen && (
        <TraceViewerModal
          canvasKey={canvasKey}
          accent={accent}
          onClose={() => setTraceViewerOpen(false)}
        />
      )}

      {/* Idle nudge */}
      {idleNudge && !reviewOpen && uncommitted.length >= IDLE_MIN_CONCEPTS && (
        <div style={{
          margin: "8px 12px 0", padding: "8px 12px", borderRadius: 10,
          background: accent + "12", border: "0.5px solid " + accent + "33",
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        }}>
          <div style={{ flex: 1, fontSize: 11, color: accent, lineHeight: 1.5 }}>
            ✦ {uncommitted.length} concepts ready to review
          </div>
          <button onClick={openReview} style={{
            fontFamily: "inherit", fontSize: 11, fontWeight: 700,
            padding: "4px 10px", borderRadius: 7, border: "none",
            background: accent, color: "#fff", cursor: "pointer",
          }}>Review</button>
          <button
            onClick={() => { setIdleNudge(false); setDismissedAtCount(uncommitted.length); }}
            style={{
              fontFamily: "inherit", fontSize: 11, border: "none",
              background: "transparent", color: "rgba(0,0,0,0.45)",
              cursor: "pointer", padding: "0 2px",
            }}
          >✕</button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} style={{
        flex: 1, overflowY: "auto", padding: "12px",
        display: "flex", flexDirection: "column", gap: 10, minHeight: 0,
      }}>
        {/* Feature 2 — pending AI suggestions for this canvas (from /audit) */}
        {suggestions.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 6,
            paddingBottom: 8, marginBottom: 4,
            borderBottom: "0.5px dashed rgba(0,0,0,0.08)",
          }}>
            <div style={{
              fontSize: 9, fontFamily: "'Fira Code', monospace",
              color: "var(--color-text-tertiary)", letterSpacing: 0.5,
              fontWeight: 700, textTransform: "uppercase",
            }}>
              AI suggestions · {suggestions.length} pending
            </div>
            {suggestions.map(s => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                nodesById={contextPack?.nodesById}
                onAccept={() => handleAcceptSuggestion(s)}
                onDismiss={() => handleDismissSuggestion(s)}
              />
            ))}
          </div>
        )}

        {messages.length === 0 && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 8, opacity: 0.35, textAlign: "center",
          }}>
            <div style={{ fontSize: 24 }}>💬</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--color-text-tertiary)" }}>
              Ask anything about <strong>{topic}</strong>.<br />
              Concepts will accumulate below as you chat.
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          // Agent tool invocation card
          if (m.role === 'tool_invocation') {
            const handoff = m.result?.hand_off ? m.result : null;
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <AgentToolCard
                  call={m.toolCall}
                  result={m.result}
                  error={m.error}
                  state={m.state}
                  durationMs={m.durationMs}
                />
                {handoff && (
                  <button
                    onClick={() => handleHandoffClick(handoff)}
                    style={{
                      fontFamily: "'Fira Code', monospace", fontSize: 11, fontWeight: 700,
                      padding: "5px 11px", borderRadius: 6,
                      border: "0.5px solid " + accent + "55",
                      background: accent + "12", color: accent,
                      cursor: "pointer",
                      letterSpacing: 0.3,
                    }}
                    title={handoff.reason}
                  >
                    → enter /{handoff.mode}{handoff.scope ? ` ${handoff.scope}` : ''}
                  </button>
                )}
              </div>
            );
          }
          const isSystem = m.meta?.system === true;
          const isModeMsg = !!m.meta?.mode && !isSystem;
          const modeAccent = isModeMsg ? (COMMANDS[m.meta.mode]?.accent || accent) : null;
          // System notes are centered, muted, no avatar bubble styling
          if (isSystem) {
            return (
              <div key={i} style={{
                display: "flex", justifyContent: "center",
                padding: "2px 0",
              }}>
                <div style={{
                  fontSize: 10, fontStyle: "italic", letterSpacing: 0.2,
                  color: "var(--color-text-tertiary)",
                  padding: "3px 10px", borderRadius: 6,
                  background: "rgba(0,0,0,0.03)",
                }}>{m.content}</div>
              </div>
            );
          }
          return (
            <div key={i} style={{
              display: "flex",
              flexDirection: "column",
              alignItems: m.role === "user" ? "flex-end" : "flex-start",
              gap: 2,
            }}>
              <div style={{
                maxWidth: "85%", padding: "8px 12px",
                borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                background: m.role === "user"
                  ? accent
                  : m.error ? "#ef444418"
                    : isModeMsg ? modeAccent + "0c"
                      : "var(--color-background-secondary)",
                color: m.role === "user"
                  ? "#fff"
                  : m.error ? "#ef4444" : "var(--color-text-primary)",
                fontSize: 12, lineHeight: 1.6,
                border: m.role === "user"
                  ? "none"
                  : m.interrupted ? "0.5px dashed rgba(245, 158, 11, 0.5)"
                    : isModeMsg ? "0.5px solid " + modeAccent + "33"
                      : "0.5px solid rgba(0,0,0,0.08)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                opacity: m.interrupted ? 0.85 : 1,
              }}>
                {(() => {
                  let raw = m.content;
                  if (m.meta?.mode === "quiz") raw = stripQuizTags(raw);
                  else if (m.meta?.mode === "rehearse") raw = stripRehearseTags(raw);
                  return raw || (m.interrupted ? "(no content was streamed before disconnect)" : "");
                })()}
              </div>
              {m.interrupted && (
                <div style={{
                  fontSize: 10, color: "#f59e0b", fontStyle: "italic",
                  padding: "0 4px", letterSpacing: 0.2,
                }}>
                  ⚠ interrupted — connection dropped mid-stream
                </div>
              )}
              {isModeMsg && !m.interrupted && (
                <div style={{
                  fontSize: 9, color: modeAccent, fontFamily: "'Fira Code', monospace",
                  padding: "0 4px", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600,
                }}>
                  {m.meta.mode}
                </div>
              )}
            </div>
          );
        })}

        {thinking && (
          <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: 8 }}>
            <div style={{
              padding: "8px 14px", borderRadius: "14px 14px 14px 4px",
              background: "var(--color-background-secondary)",
              border: "0.5px solid rgba(0,0,0,0.08)",
              fontSize: 18, letterSpacing: 2,
              animation: "pulse 1.2s infinite",
            }}>···</div>
            {/* M4-γ Stop button — abort current stream */}
            <button
              onClick={handleStop}
              style={{
                fontFamily: "inherit", fontSize: 10, fontWeight: 600,
                padding: "4px 10px", borderRadius: 6,
                border: "0.5px solid rgba(0,0,0,0.18)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                letterSpacing: 0.4, textTransform: "uppercase",
              }}
              title="Stop the agent mid-stream"
            >■ Stop</button>
          </div>
        )}

        {/* M4-γ confirm_with_user inline dialog */}
        {pendingConfirm && (
          <div style={{
            margin: "4px 0",
            padding: "10px 12px",
            border: "1px dashed var(--color-text-secondary)",
            borderRadius: 10,
            background: "rgba(0,0,0,0.02)",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-primary)" }}>
              Agent needs to clarify:
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-primary)", lineHeight: 1.5 }}>
              {pendingConfirm.question}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              {(pendingConfirm.options || []).map(opt => (
                <button
                  key={opt}
                  onClick={() => handleConfirmChoice(opt)}
                  style={{
                    fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                    padding: "5px 11px", borderRadius: 6,
                    border: "0.5px solid " + accent + "55",
                    background: accent + "12", color: accent,
                    cursor: "pointer",
                  }}
                >{opt}</button>
              ))}
              <button
                onClick={() => handleConfirmChoice(null)}
                style={{
                  fontFamily: "inherit", fontSize: 11,
                  padding: "5px 11px", borderRadius: 6,
                  border: "0.5px solid rgba(0,0,0,0.12)",
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  cursor: "pointer",
                }}
              >skip</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Concept tray (bottom chips — option A: in-chat inline) ── */}
      {uncommitted.length > 0 && (
        <div style={{
          borderTop: "0.5px solid rgba(0,0,0,0.08)",
          padding: "7px 10px",
          display: "flex", gap: 6, alignItems: "center",
          flexShrink: 0, background: "rgba(0,0,0,0.015)",
          minHeight: 38,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 800, color: accent,
            whiteSpace: "nowrap", letterSpacing: "0.08em",
            textTransform: "uppercase", flexShrink: 0,
            padding: "0 4px 0 2px",
          }}>
            ✦ {uncommitted.length}
          </div>
          <div style={{
            position: "relative", flex: 1, minWidth: 0,
          }}>
            <div style={{
              display: "flex", gap: 6,
              overflowX: "auto", overflowY: "hidden",
              scrollbarWidth: "thin",
              paddingRight: 18, // room for gradient fade overlay
            }}>
              {uncommitted.map(c => {
                const isNew = recentlyAdded.has(c.id);
                const isRefined = recentlyRefined.has(c.id);
                const isPulsing = isNew || isRefined;
                return (
                  <button
                    key={c.id}
                    onClick={openReview}
                    title={
                      (isRefined ? "↻ updated · " : "") +
                      (c.body ? c.body.replace(/^#+ /gm, "").slice(0, 180) : c.title)
                    }
                    style={{
                      fontFamily: "inherit", fontSize: 11,
                      padding: "4px 10px", borderRadius: 100,
                      border: "0.5px solid " + accent + (isRefined ? "88" : "55"),
                      background: isPulsing ? accent + "33" : accent + "12",
                      color: accent,
                      whiteSpace: "nowrap", flexShrink: 0, cursor: "pointer",
                      animation: isPulsing ? "pulse 1.1s ease 2" : "none",
                      maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
                      transition: "background 0.2s, border-color 0.2s",
                      display: "inline-flex", alignItems: "center", gap: 4,
                    }}
                  >
                    {isRefined && (
                      <span style={{ fontSize: 9, opacity: 0.85 }}>↻</span>
                    )}
                    {c.title}
                  </button>
                );
              })}
            </div>
            {/* Right-edge gradient fade — hints at overflow the Mac scrollbar hides */}
            <div style={{
              position: "absolute", top: 0, right: 0, bottom: 0, width: 28,
              pointerEvents: "none",
              background: "linear-gradient(to right, rgba(251,251,250,0) 0%, rgba(251,251,250,0.95) 70%, rgba(251,251,250,1) 100%)",
            }} />
          </div>
          <button
            onClick={openReview}
            title="Review, edit, and commit these concepts"
            style={{
              fontFamily: "inherit", fontSize: 10, fontWeight: 700,
              padding: "4px 10px", borderRadius: 100,
              border: "none", background: accent, color: "#fff",
              whiteSpace: "nowrap", flexShrink: 0, cursor: "pointer",
            }}
          >
            Summarize →
          </button>
        </div>
      )}

      {/* Input */}
      {/* Mode chip — shown when a slash mode is active */}
      {mode && (() => {
        const modeMeta = COMMANDS[mode.name] || {};
        const color = modeMeta.accent || accent;
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 12px", flexShrink: 0,
            borderTop: "0.5px solid rgba(0,0,0,0.08)",
            background: color + "10",
          }}>
            <span style={{
              fontFamily: "'Fira Code', monospace", fontSize: 10, fontWeight: 700,
              padding: "2px 7px", borderRadius: 4,
              background: color, color: "#fff",
              letterSpacing: 0.5, textTransform: "uppercase",
            }}>{mode.name}</span>
            {mode.args && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", fontStyle: "italic" }}>
                scope: {mode.args}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={() => handleSlash({ command: "exit", args: "", known: true })}
              style={{
                fontFamily: "'Fira Code', monospace", fontSize: 10,
                padding: "2px 7px", borderRadius: 4,
                border: "0.5px solid " + color + "55", background: "transparent",
                color: color, cursor: "pointer",
              }}
            >/exit</button>
          </div>
        );
      })()}

      <div style={{
        position: "relative",
        borderTop: mode ? "none" : "0.5px solid rgba(0,0,0,0.08)",
        padding: "10px 12px",
        display: "flex", gap: 8, alignItems: "flex-end",
        flexShrink: 0,
        background: "var(--color-background-primary)",
      }}>
        {slashOpen && (
          <SlashAutocomplete
            items={autocompleteItems}
            selectedIdx={autocompleteIdx}
            onPick={(item) => insertCommand(item)}
          />
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
          }}
          onKeyDown={e => {
            // Autocomplete navigation (only when dropdown is open)
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAutocompleteIdx(i => Math.min(autocompleteItems.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setAutocompleteIdx(i => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                // Tab always completes; Enter completes only if no args yet typed
                const item = autocompleteItems[autocompleteIdx];
                if (item && item.ready) {
                  e.preventDefault();
                  insertCommand(item);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setInput("");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={mode ? `In ${mode.name} mode — Enter to send, /exit to leave` : "Ask anything… (Enter to send, / for commands)"}
          rows={1}
          style={{
            flex: 1, fontFamily: "inherit", fontSize: 12, lineHeight: 1.6,
            padding: "7px 11px", borderRadius: 10,
            border: "0.5px solid " + (
              mode ? (COMMANDS[mode.name]?.accent || accent) + "88"
                : input.trim() ? accent + "88"
                  : "rgba(0,0,0,0.12)"
            ),
            background: "var(--color-background-secondary)",
            color: "var(--color-text-primary)",
            resize: "none", outline: "none",
            minHeight: 36, maxHeight: 120, overflow: "hidden",
            transition: "border-color 0.15s",
          }}
        />
        <button
          onClick={send}
          disabled={thinking || !input.trim()}
          style={{
            fontFamily: "inherit", fontSize: 12, fontWeight: 700,
            padding: "7px 14px", borderRadius: 10,
            border: "none", background: accent, color: "#fff",
            cursor: thinking || !input.trim() ? "default" : "pointer",
            opacity: thinking || !input.trim() ? 0.4 : 1,
            transition: "opacity 0.15s", flexShrink: 0,
          }}
        >
          {thinking ? "…" : "↑"}
        </button>
      </div>

      {/* Review overlay */}
      {reviewOpen && (
        <div style={{
          position: "absolute", inset: 0,
          background: "var(--color-background-primary)",
          display: "flex", flexDirection: "column",
          animation: "slideUp 0.2s ease", zIndex: 10,
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 14px",
            borderBottom: "0.5px solid rgba(0,0,0,0.08)",
            flexShrink: 0,
          }}>
            <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)" }}>
              ✦ Review concepts
              <span style={{ fontSize: 10, fontWeight: 500, color: "rgba(0,0,0,0.45)", marginLeft: 6 }}>
                ({uncommitted.length})
              </span>
            </div>
            <button onClick={closeReview} style={{
              fontFamily: "inherit", fontSize: 12, border: "none",
              background: "transparent", color: "rgba(0,0,0,0.45)",
              cursor: "pointer", padding: "0 2px",
            }}>✕</button>
          </div>

          {/* Scroll body */}
          <div style={{
            flex: 1, overflowY: "auto", padding: "10px 12px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>

            {/* AI merge suggestions */}
            {(suggestionsLoading || suggestions.length > 0) && (
              <div style={{
                padding: "8px 10px", borderRadius: 10,
                background: "rgba(255,193,7,0.08)",
                border: "0.5px solid rgba(255,193,7,0.35)",
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                  textTransform: "uppercase", color: "rgba(0,0,0,0.55)",
                }}>
                  💡 {suggestionsLoading
                    ? "Looking for merges…"
                    : `Suggested merges (${suggestions.length})`}
                </div>
                {suggestions.map(s => {
                  const sources = s.ids
                    .map(id => uncommitted.find(c => c.id === id))
                    .filter(Boolean);
                  if (sources.length < 2) return null;
                  return (
                    <div key={s.id} style={{
                      padding: "8px 10px", borderRadius: 8,
                      background: "rgba(255,255,255,0.7)",
                      border: "0.5px solid rgba(0,0,0,0.08)",
                    }}>
                      <div style={{ fontSize: 10, color: "rgba(0,0,0,0.55)", marginBottom: 4 }}>
                        {sources.map(c => `"${c.title}"`).join(" + ")}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(0,0,0,0.85)", marginBottom: 2 }}>
                        → {s.mergedTitle}
                      </div>
                      {s.reason && (
                        <div style={{ fontSize: 10, color: "rgba(0,0,0,0.5)", marginBottom: 6, fontStyle: "italic" }}>
                          {s.reason}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => acceptSuggestion(s)} style={{
                          fontFamily: "inherit", fontSize: 10, fontWeight: 700,
                          padding: "3px 10px", borderRadius: 6, border: "none",
                          background: accent, color: "#fff", cursor: "pointer",
                        }}>Accept</button>
                        <button onClick={() => dismissSuggestion(s.id)} style={{
                          fontFamily: "inherit", fontSize: 10,
                          padding: "3px 10px", borderRadius: 6,
                          border: "0.5px solid rgba(0,0,0,0.15)",
                          background: "transparent", color: "rgba(0,0,0,0.55)", cursor: "pointer",
                        }}>Dismiss</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {uncommitted.length === 0 && (
              <div style={{
                fontSize: 12, color: "rgba(0,0,0,0.4)",
                textAlign: "center", marginTop: 24, opacity: 0.7,
              }}>
                No new concepts yet.<br />Keep chatting!
              </div>
            )}

            {uncommitted.map(c => {
              const isEditing = editingId === c.id;
              const isMerging = !!mergeSel[c.id];
              const isIncluded = selected[c.id] !== false;
              return (
                <div key={c.id} style={{
                  display: "flex", gap: 8,
                  padding: "9px 10px", borderRadius: 10,
                  background: isMerging
                    ? accent + "1e"
                    : isIncluded ? accent + "0e" : "rgba(0,0,0,0.03)",
                  border: "0.5px solid " + (isMerging
                    ? accent + "77"
                    : isIncluded ? accent + "33" : "rgba(0,0,0,0.08)"),
                  transition: "all 0.12s",
                }}>
                  <input
                    type="checkbox"
                    checked={isIncluded}
                    onChange={() => toggleSelect(c.id)}
                    title="Include when adding to canvas"
                    style={{ marginTop: 3, accentColor: accent, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <>
                        <input
                          type="text"
                          value={c.title}
                          onChange={e => updateConcept(c.id, { title: e.target.value })}
                          onBlur={() => setEditingId(null)}
                          onKeyDown={e => {
                            if (e.key === "Enter") { e.preventDefault(); setEditingId(null); }
                            if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                          }}
                          autoFocus
                          style={{
                            fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                            width: "100%", padding: "4px 7px", borderRadius: 6,
                            border: "0.5px solid " + accent + "77",
                            background: "#fff", color: "var(--color-text-primary)",
                            outline: "none", marginBottom: 4,
                            boxSizing: "border-box",
                          }}
                        />
                        <textarea
                          value={c.body}
                          onChange={e => updateConcept(c.id, { body: e.target.value })}
                          onKeyDown={e => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              e.preventDefault(); setEditingId(null);
                            }
                            if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                          }}
                          rows={3}
                          placeholder="Notes (markdown, ⌘↵ to finish)"
                          style={{
                            fontFamily: "inherit", fontSize: 10, lineHeight: 1.5,
                            width: "100%", padding: "6px 7px", borderRadius: 6,
                            border: "0.5px solid rgba(0,0,0,0.12)",
                            background: "#fff", color: "var(--color-text-primary)",
                            outline: "none", resize: "vertical",
                            boxSizing: "border-box",
                          }}
                        />
                      </>
                    ) : (
                      <div onClick={() => setEditingId(c.id)} style={{ cursor: "text" }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: 6,
                          marginBottom: 2,
                        }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600,
                            color: "var(--color-text-primary)",
                            flex: 1, minWidth: 0,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {c.title || <span style={{ opacity: 0.4 }}>(untitled)</span>}
                          </div>
                          {(c.refineCount || 0) > 0 && (
                            <span
                              title={`AI deepened this ${c.refineCount}× during the conversation`}
                              style={{
                                fontSize: 8, fontWeight: 800, letterSpacing: "0.08em",
                                padding: "2px 6px", borderRadius: 100,
                                background: accent + "22", color: accent,
                                border: "0.5px solid " + accent + "55",
                                whiteSpace: "nowrap", flexShrink: 0,
                                textTransform: "uppercase",
                              }}
                            >
                              ↻ updated{c.refineCount > 1 ? ` ${c.refineCount}×` : ""}
                            </span>
                          )}
                        </div>
                        {c.body && (
                          <div style={{
                            fontSize: 10, color: "rgba(0,0,0,0.55)",
                            lineHeight: 1.5, whiteSpace: "pre-wrap",
                          }}>
                            {c.body.replace(/^#+ /gm, "").slice(0, 140)}
                            {c.body.length > 140 ? "…" : ""}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => toggleMerge(c.id)}
                      title={isMerging ? "Unselect from merge" : "Select for merge"}
                      style={{
                        fontFamily: "inherit", fontSize: 11,
                        width: 22, height: 22, borderRadius: 6,
                        border: "0.5px solid " + (isMerging ? accent : "rgba(0,0,0,0.12)"),
                        background: isMerging ? accent + "22" : "transparent",
                        color: isMerging ? accent : "rgba(0,0,0,0.45)",
                        cursor: "pointer", padding: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >⇌</button>
                    <button
                      onClick={() => deleteConcept(c.id)}
                      title="Delete"
                      style={{
                        fontFamily: "inherit", fontSize: 11,
                        width: 22, height: 22, borderRadius: 6,
                        border: "0.5px solid rgba(0,0,0,0.1)",
                        background: "transparent", color: "rgba(0,0,0,0.4)",
                        cursor: "pointer", padding: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >✕</button>
                  </div>
                </div>
              );
            })}

            {committed.length > 0 && (
              <>
                <div style={{
                  fontSize: 9, fontWeight: 700, color: "rgba(0,0,0,0.4)",
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  marginTop: 8, marginBottom: 2, paddingLeft: 2,
                }}>
                  Already added
                </div>
                {committed.map(c => (
                  <div key={c.id} style={{
                    display: "flex", gap: 10, padding: "7px 11px",
                    borderRadius: 10, opacity: 0.5,
                    background: "rgba(0,0,0,0.03)",
                    border: "0.5px solid rgba(0,0,0,0.08)",
                  }}>
                    <div style={{ fontSize: 11, color: "#10b981", flexShrink: 0, marginTop: 1 }}>✓</div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,0.65)" }}>{c.title}</div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer — swaps between add-mode and merge-mode */}
          <div style={{
            borderTop: "0.5px solid rgba(0,0,0,0.08)",
            padding: "10px 12px",
            display: "flex", gap: 8, alignItems: "center",
            flexShrink: 0, flexWrap: "wrap",
          }}>
            {mergeCount >= 2 ? (
              <>
                <div style={{ flex: 1, fontSize: 10, color: accent, fontWeight: 600 }}>
                  {mergeCount} selected to merge
                </div>
                <button onClick={() => setMergeSel({})} style={{
                  fontFamily: "inherit", fontSize: 11,
                  padding: "5px 10px", borderRadius: 8,
                  border: "0.5px solid rgba(0,0,0,0.12)",
                  background: "transparent", color: "rgba(0,0,0,0.55)", cursor: "pointer",
                }}>Cancel</button>
                <button onClick={mergeSelected} style={{
                  fontFamily: "inherit", fontSize: 11, fontWeight: 700,
                  padding: "5px 14px", borderRadius: 8,
                  border: "none", background: accent, color: "#fff", cursor: "pointer",
                }}>
                  ⇌ Merge {mergeCount}
                </button>
              </>
            ) : mergeCount === 1 ? (
              <div style={{ flex: 1, fontSize: 10, color: "rgba(0,0,0,0.55)" }}>
                Select one more to merge, or press ⇌ again to cancel.
              </div>
            ) : (
              <>
                <div style={{ flex: 1, fontSize: 10, color: "rgba(0,0,0,0.45)" }}>
                  {addCount} of {uncommitted.length} selected
                </div>
                <button onClick={closeReview} style={{
                  fontFamily: "inherit", fontSize: 11, padding: "5px 12px",
                  borderRadius: 8, border: "0.5px solid rgba(0,0,0,0.15)",
                  background: "transparent", color: "rgba(0,0,0,0.6)", cursor: "pointer",
                }}>
                  Keep chatting
                </button>
                <button
                  onClick={handleAddToCanvas}
                  disabled={addCount === 0}
                  style={{
                    fontFamily: "inherit", fontSize: 11, fontWeight: 700,
                    padding: "5px 14px", borderRadius: 8, border: "none",
                    background: addCount > 0 ? accent : "rgba(0,0,0,0.08)",
                    color: addCount > 0 ? "#fff" : "rgba(0,0,0,0.4)",
                    cursor: addCount > 0 ? "pointer" : "default",
                    whiteSpace: "nowrap",
                  }}
                >
                  Add to canvas →
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
