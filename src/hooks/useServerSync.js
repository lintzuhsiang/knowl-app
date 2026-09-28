import { useState, useEffect } from "react";
import {
  checkServer,
  loadGraphFromServer,
  debouncedSave,
  startSyncPolling,
  setupOnlineSync,
  setAuthToken,
  setWorkspaceId,
} from "../api/graphSync";
import { mergeServerGraph } from "../lib/graphHelpers";

/**
 * Server sync lifecycle hook. Owns the auth gate, startup load, debounced
 * save-on-change, 30-second polling, and online/offline reconnect listener.
 *
 * Returns { syncStatus, authNeeded, handleAuth } so the host component can:
 *   - Render an AuthGate when `authNeeded === true`
 *   - Render nothing while `authNeeded === null` (still checking)
 *   - Show a colored dot in the toolbar based on `syncStatus`
 *   - Pass `handleAuth` to AuthGate as its submit callback
 *
 * The hook merges incoming server data through `mergeServerGraph` so local
 * `inlineNotes` are preserved across pulls. It reads `graph` from a ref so
 * setupOnlineSync always sees the current value without re-subscribing.
 *
 * @param graph         current graph state (read on every render so save effect fires)
 * @param setGraph      React state setter for graph
 * @param graphRef      ref tracking latest graph (for the online-listener closure)
 */
export default function useServerSync(graph, setGraph, graphRef) {
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle" | "saving" | "saved" | "offline"
  const [authNeeded, setAuthNeeded] = useState(null);   // null = checking, true = show gate, false = good

  // Startup: check auth, then load from server
  useEffect(() => {
    checkServer().then(async (health) => {
      if (!health.ok) { setSyncStatus("offline"); setAuthNeeded(false); return; }
      if (health.needsAuth && !health.authed) { setAuthNeeded(true); return; }
      setAuthNeeded(false);
      const serverGraph = await loadGraphFromServer();
      if (serverGraph) setGraph(prev => mergeServerGraph(prev, serverGraph));
      setSyncStatus("saved");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auth callback — re-run startup with new token (+ optional workspace_id
  // from login/register response so the user lands in the right workspace).
  const handleAuth = async (token, workspaceId) => {
    setAuthToken(token);
    if (workspaceId) setWorkspaceId(workspaceId);
    const health = await checkServer();
    if (health.ok && health.authed) {
      setAuthNeeded(false);
      const serverGraph = await loadGraphFromServer();
      if (serverGraph) setGraph(prev => mergeServerGraph(prev, serverGraph));
      setSyncStatus("saved");
    } else {
      setAuthNeeded("invalid");
    }
  };

  // Multi-device sync polling (every 30s) + online/offline handler
  useEffect(() => {
    if (authNeeded) return;
    const stopPolling = startSyncPolling(serverData => {
      setGraph(prev => mergeServerGraph(prev, serverData));
    }, 30000);
    const stopOnline = setupOnlineSync(
      () => graphRef.current,
      serverData => setGraph(prev => mergeServerGraph(prev, serverData)),
      setSyncStatus,
    );
    return () => { stopPolling(); stopOnline(); };
  }, [authNeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ongoing: debounced save on every graph change
  useEffect(() => {
    setSyncStatus("saving");
    debouncedSave(graph, 1500);
    const t = setTimeout(() => setSyncStatus(s => s === "saving" ? "saved" : s), 1800);
    return () => clearTimeout(t);
  }, [graph]);

  return { syncStatus, authNeeded, handleAuth };
}
