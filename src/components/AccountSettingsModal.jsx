import { useState, useEffect } from "react";

/**
 * AccountSettings modal — small overlay opened from the top bar.
 *
 * Sections:
 *   1. Account info (email, display name, member since)
 *   2. Token budget usage today (calls /api/auth/budget)
 *   3. Data export — GET /api/auth/me/export, download as JSON
 *   4. Delete account — DELETE /api/auth/me with password + typed confirmation
 *   5. Logout
 *
 * Props:
 *   onClose()        close the modal
 *   onLoggedOut()    called after logout / delete completes
 */
export default function AccountSettingsModal({ onClose, onLoggedOut }) {
  const [me, setMe] = useState(null);
  const [budget, setBudget] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const [resendingVerify, setResendingVerify] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const token = localStorage.getItem("knowl_auth_token") || "";
  const workspaceId = localStorage.getItem("knowl_workspace_id") || "";
  const headers = () => ({
    "Content-Type": "application/json",
    "x-auth-token": token,
    ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
  });

  // Load /me + /budget in parallel
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/auth/me", { headers: headers() }).then(r => r.ok ? r.json() : null),
      fetch("/api/auth/budget", { headers: headers() }).then(r => r.ok ? r.json() : null),
    ]).then(([meData, budgetData]) => {
      if (cancelled) return;
      setMe(meData);
      setBudget(budgetData);
    }).catch(e => {
      if (!cancelled) setLoadError(String(e.message || e));
    });
    return () => { cancelled = true; };
  }, []);

  const doExport = async () => {
    setExporting(true);
    try {
      const r = await fetch("/api/auth/me/export", { headers: headers() });
      if (!r.ok) throw new Error(`Export failed: HTTP ${r.status}`);
      const blob = await r.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `knowl-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert("Export failed: " + (e.message || e));
    } finally {
      setExporting(false);
    }
  };

  const doResendVerification = async () => {
    setResendingVerify(true);
    try {
      const r = await fetch("/api/auth/resend-verification", {
        method: "POST", headers: headers(),
      });
      if (r.ok) setVerifySent(true);
      else alert("Couldn't send verification email — try again later.");
    } catch (e) {
      alert("Network error: " + (e.message || e));
    } finally {
      setResendingVerify(false);
    }
  };

  const switchWorkspace = (id) => {
    if (id === me?.current_workspace_id) return;
    localStorage.setItem("knowl_workspace_id", id);
    window.location.reload();
  };

  const createWorkspaceAction = async () => {
    const name = newWorkspaceName.trim();
    if (!name) return;
    setCreatingWorkspace(true);
    try {
      const r = await fetch("/api/auth/workspaces", {
        method: "POST", headers: headers(),
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) { alert(data.error || "Create failed"); return; }
      // Switch into the new workspace immediately
      localStorage.setItem("knowl_workspace_id", data.id);
      window.location.reload();
    } catch (e) {
      alert("Network error: " + (e.message || e));
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const doLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: headers() });
    } catch { /* ignore — log out client-side regardless */ }
    localStorage.removeItem("knowl_auth_token");
    localStorage.removeItem("knowl_workspace_id");
    onLoggedOut?.();
    onClose();
    window.location.reload();
  };

  const doDelete = async () => {
    setDeleteError(null);
    if (deleteConfirm !== "DELETE MY ACCOUNT") {
      setDeleteError('Type "DELETE MY ACCOUNT" exactly to confirm.');
      return;
    }
    setDeleting(true);
    try {
      const r = await fetch("/api/auth/me", {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ password: deletePassword, confirm: deleteConfirm }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDeleteError(data.error || `HTTP ${r.status}`);
        return;
      }
      localStorage.removeItem("knowl_auth_token");
      localStorage.removeItem("knowl_workspace_id");
      onLoggedOut?.();
      onClose();
      window.location.reload();
    } catch (e) {
      setDeleteError(String(e.message || e));
    } finally {
      setDeleting(false);
    }
  };

  const section = {
    padding: "14px 0",
    borderBottom: "0.5px solid rgba(255,255,255,0.06)",
  };
  const label = {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--color-text-tertiary, #6e7681)",
    marginBottom: 8,
  };
  const btn = (variant = "default") => ({
    fontFamily: "inherit", fontSize: 12, fontWeight: 600,
    padding: "7px 14px", borderRadius: 7,
    cursor: "pointer",
    background: variant === "danger" ? "#dc262618" : variant === "primary" ? "#58a6ff" : "rgba(255,255,255,0.06)",
    color: variant === "danger" ? "#f85149" : variant === "primary" ? "#fff" : "var(--color-text-primary, #e6edf3)",
    border: variant === "danger" ? "0.5px solid #dc262644" : "none",
  });
  const input = {
    width: "100%", padding: "8px 11px", fontSize: 13,
    borderRadius: 7, border: "0.5px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    color: "var(--color-text-primary, #e6edf3)",
    outline: "none", boxSizing: "border-box",
    fontFamily: "inherit", marginBottom: 8,
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9998, fontFamily: "'Inter', system-ui, sans-serif",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--color-background-secondary, #161b22)",
        borderRadius: 14, width: 440, maxHeight: "90vh", overflow: "auto",
        padding: "24px 28px", boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-primary, #e6edf3)" }}>
            Account
          </div>
          <button onClick={onClose} style={{
            border: "none", background: "transparent",
            color: "var(--color-text-tertiary, #6e7681)",
            cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        {loadError && (
          <div style={{ color: "#f85149", fontSize: 12, marginBottom: 12 }}>
            Failed to load: {loadError}
          </div>
        )}

        {/* Email-unverified banner — only show if user has an email AND it's
            not yet verified. Default/legacy users without email are skipped. */}
        {me?.user?.email && !me.user.email_verified_at && (
          <div style={{
            padding: "10px 12px", borderRadius: 8,
            background: "rgba(245,158,11,0.10)",
            border: "0.5px solid rgba(245,158,11,0.35)",
            marginBottom: 12,
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <div style={{ flex: 1, minWidth: 180, fontSize: 11, color: "#f59e0b", lineHeight: 1.5 }}>
              {verifySent
                ? "✓ Verification email sent — check your inbox."
                : "Your email isn't verified yet."}
            </div>
            {!verifySent && (
              <button onClick={doResendVerification} disabled={resendingVerify}
                style={{
                  fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                  padding: "5px 11px", borderRadius: 6, border: "none",
                  background: "#f59e0b", color: "#fff", cursor: "pointer",
                  opacity: resendingVerify ? 0.6 : 1,
                }}>
                {resendingVerify ? "Sending…" : "Resend"}
              </button>
            )}
          </div>
        )}

        {/* Account info */}
        {me?.user && (
          <div style={section}>
            <div style={label}>Profile</div>
            <div style={{ fontSize: 13, color: "var(--color-text-primary, #e6edf3)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              {me.user.email || <em style={{ opacity: 0.5 }}>no email</em>}
              {me.user.email_verified_at && (
                <span title="Email verified" style={{
                  fontSize: 9, padding: "1px 6px", borderRadius: 100,
                  background: "rgba(63,185,80,0.14)", color: "#3fb950",
                  border: "0.5px solid rgba(63,185,80,0.35)",
                  letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 700,
                }}>verified</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary, #8b949e)" }}>
              {me.user.display_name || "—"} · joined {me.user.created_at ? new Date(me.user.created_at).toLocaleDateString() : "—"}
            </div>
          </div>
        )}

        {/* Workspaces — switch + create */}
        {me?.workspaces && (
          <div style={section}>
            <div style={label}>Workspaces</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              {me.workspaces.map(ws => {
                const isCurrent = ws.id === me.current_workspace_id;
                return (
                  <div key={ws.id}
                    onClick={() => switchWorkspace(ws.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "7px 10px", borderRadius: 7,
                      background: isCurrent ? "rgba(88,166,255,0.10)" : "rgba(255,255,255,0.03)",
                      border: "0.5px solid " + (isCurrent ? "rgba(88,166,255,0.35)" : "rgba(255,255,255,0.06)"),
                      cursor: isCurrent ? "default" : "pointer",
                    }}>
                    <div style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary, #e6edf3)" }}>
                      {ws.name}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--color-text-tertiary, #6e7681)", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600 }}>
                      {ws.role}
                    </div>
                    {isCurrent && (
                      <div style={{ fontSize: 9, color: "#58a6ff", fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" }}>
                        current
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="New workspace name"
                value={newWorkspaceName}
                onChange={e => setNewWorkspaceName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createWorkspaceAction(); }}
                style={{ ...input, marginBottom: 0, flex: 1 }}
              />
              <button onClick={createWorkspaceAction}
                disabled={creatingWorkspace || !newWorkspaceName.trim()}
                style={{ ...btn("primary"), opacity: creatingWorkspace || !newWorkspaceName.trim() ? 0.5 : 1 }}>
                {creatingWorkspace ? "…" : "Create"}
              </button>
            </div>
          </div>
        )}

        {/* Token budget */}
        {budget && (
          <div style={section}>
            <div style={label}>Daily AI budget</div>
            <div style={{
              height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)",
              overflow: "hidden", marginBottom: 6,
            }}>
              <div style={{
                width: `${Math.min(100, budget.pct || 0)}%`, height: "100%",
                background: budget.pct > 80 ? "#f59e0b" : "#58a6ff",
                transition: "width 0.3s",
              }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary, #8b949e)" }}>
              {budget.used?.toLocaleString()} / {budget.limit?.toLocaleString()} tokens · {budget.pct}% used
            </div>
          </div>
        )}

        {/* Data export */}
        <div style={section}>
          <div style={label}>Your data</div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary, #8b949e)", marginBottom: 8, lineHeight: 1.6 }}>
            Download every node, edge, chat message, and agent trace tied to your account, as a JSON file.
          </div>
          <button onClick={doExport} disabled={exporting} style={btn()}>
            {exporting ? "Preparing…" : "↓ Export data"}
          </button>
        </div>

        {/* Logout */}
        <div style={section}>
          <button onClick={doLogout} style={btn()}>Sign out</button>
        </div>

        {/* Delete account */}
        <div style={{ ...section, borderBottom: "none" }}>
          <div style={{ ...label, color: "#f85149" }}>Danger zone</div>
          {!deleteOpen ? (
            <>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary, #8b949e)", marginBottom: 8, lineHeight: 1.6 }}>
                Permanently delete your account, all solo workspaces, and all data they contain. Shared workspaces transfer to other members.
              </div>
              <button onClick={() => setDeleteOpen(true)} style={btn("danger")}>
                Delete my account…
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, color: "#f85149", marginBottom: 10, lineHeight: 1.6 }}>
                This is irreversible. Confirm with your password and type
                {" "}<code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: 3, fontSize: 10 }}>DELETE MY ACCOUNT</code>.
              </div>
              <input
                type="password"
                placeholder="Password"
                value={deletePassword}
                onChange={e => setDeletePassword(e.target.value)}
                style={input}
              />
              <input
                type="text"
                placeholder='Type "DELETE MY ACCOUNT"'
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                style={input}
              />
              {deleteError && (
                <div style={{ color: "#f85149", fontSize: 11, marginBottom: 8 }}>
                  {deleteError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { setDeleteOpen(false); setDeletePassword(""); setDeleteConfirm(""); setDeleteError(null); }}
                  style={btn()}>Cancel</button>
                <button onClick={doDelete} disabled={deleting} style={btn("danger")}>
                  {deleting ? "Deleting…" : "Permanently delete"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
