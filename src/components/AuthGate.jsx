import { useState, useEffect } from "react";

/**
 * AuthGate — the modal that appears when the server requires authentication.
 *
 * Three modes:
 *   - "login":  email + password → POST /api/auth/login
 *   - "register": email + password + display_name → POST /api/auth/register
 *   - "token": legacy shared-secret token (used when server sets AUTH_SECRET
 *              and there's no user-based system on the deployment yet)
 *
 * Server health endpoint tells us whether user-based auth is available. If
 * yes → default to "login". If only legacy token is supported → "token".
 *
 * On successful login/register, calls `onAuth(token, workspaceId?)`. The
 * legacy token path calls `onAuth(token)`.
 */
export default function AuthGate({ onAuth, error: externalError }) {
  // Detect reset/verify token in URL once on mount — those flows override
  // the normal sign-in tabs because the URL itself is the credential.
  const urlMode = (() => {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search);
    if (p.get('reset')) return { kind: 'reset',  token: p.get('reset') };
    if (p.get('verify')) return { kind: 'verify', token: p.get('verify') };
    return null;
  })();

  const [mode, setMode] = useState(urlMode?.kind || "login");
  const [supportsLogin, setSupportsLogin] = useState(true); // optimistic; rechecked on mount
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [info, setInfo] = useState(null); // success message banner
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Probe whether the server has /api/auth/login wired up. If not, fall back
  // to legacy token mode. (Older builds + tiny self-host setups.)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/login", { method: "OPTIONS" })
      .then(r => { if (!cancelled) setSupportsLogin(r.status !== 404); })
      .catch(() => { if (!cancelled) setSupportsLogin(false); });
    return () => { cancelled = true; };
  }, []);

  // If we arrived here with ?verify=<token>, exchange it immediately.
  // The user might already be logged in via session token elsewhere — this
  // marks the account verified regardless and shows a success banner.
  useEffect(() => {
    if (urlMode?.kind !== 'verify') return;
    let cancelled = false;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: urlMode.token }),
    }).then(async r => {
      if (cancelled) return;
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setInfo(`Email verified: ${data.email}. Sign in below to continue.`);
      } else {
        setError(data.error || `Verification failed (${r.status})`);
      }
      setMode('login');
      // Scrub the token from the URL so a reload doesn't re-attempt
      const url = new URL(window.location.href);
      url.searchParams.delete('verify');
      window.history.replaceState({}, '', url);
    }).catch(e => {
      if (!cancelled) setError(String(e.message || e));
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showError = error || externalError;

  const doLogin = async () => {
    if (!email || !password) { setError("Email and password required"); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Login failed"); return; }
      onAuth(data.token, data.default_workspace_id);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const doRegister = async () => {
    if (!email || !password) { setError("Email and password required"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          display_name: displayName.trim() || null,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Registration failed"); return; }
      onAuth(data.token, data.default_workspace_id);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const doLegacyToken = () => {
    if (!token.trim()) { setError("Token required"); return; }
    setError(null);
    onAuth(token.trim());
  };

  const doForgot = async () => {
    if (!email) { setError("Email required"); return; }
    setSubmitting(true); setError(null); setInfo(null);
    try {
      // Endpoint always returns 200 to prevent enumeration; we show the same
      // message to the user regardless of whether the email is registered.
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setInfo("If that email matches an account, a reset link is on the way. Check your inbox.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const doReset = async () => {
    if (!urlMode?.token) { setError("Reset token missing"); return; }
    if (resetPassword.length < 6) { setError("Password must be at least 6 characters"); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: urlMode.token, password: resetPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error || `Reset failed (${r.status})`); return; }
      setInfo("Password updated. Sign in with your new password.");
      setMode("login");
      const url = new URL(window.location.href);
      url.searchParams.delete('reset');
      window.history.replaceState({}, '', url);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (submitting) return;
    if (mode === "login")    return doLogin();
    if (mode === "register") return doRegister();
    if (mode === "token")    return doLegacyToken();
    if (mode === "forgot")   return doForgot();
    if (mode === "reset")    return doReset();
  };

  // Theme: dark surface, accent buttons, soft borders
  const inputStyle = {
    width: "100%", padding: "10px 14px", fontSize: 14,
    borderRadius: 8, border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.05)",
    color: "var(--color-text-primary, #e6edf3)",
    outline: "none", boxSizing: "border-box", marginBottom: 8,
    fontFamily: "inherit",
  };
  const tabStyle = (active) => ({
    flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 600,
    background: "transparent",
    border: "none",
    borderBottom: active ? "2px solid var(--color-accent, #58a6ff)" : "2px solid transparent",
    color: active ? "var(--color-text-primary, #e6edf3)" : "var(--color-text-tertiary, #6e7681)",
    cursor: "pointer", fontFamily: "inherit",
    letterSpacing: 0.3, textTransform: "uppercase",
  });

  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center",
      justifyContent: "center", background: "var(--color-background-primary, #0d1117)",
      zIndex: 9999, fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{
        background: "var(--color-background-secondary, #161b22)",
        borderRadius: 16, padding: "36px 32px", width: 360,
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-text-primary, #e6edf3)", marginBottom: 4 }}>
          knowl
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary, #8b949e)", marginBottom: 22 }}>
          {mode === "login" && "Sign in to your workspace"}
          {mode === "register" && "Create a new account"}
          {mode === "token" && "Enter your access token"}
          {mode === "forgot" && "Reset your password by email"}
          {mode === "reset" && "Choose a new password"}
        </div>

        {/* Mode tabs (skip if backend doesn't support user auth, or in
            forgot/reset flow where tabs would be confusing) */}
        {supportsLogin && mode !== "forgot" && mode !== "reset" && (
          <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <button onClick={() => { setMode("login"); setError(null); setInfo(null); }} style={tabStyle(mode === "login")}>Sign in</button>
            <button onClick={() => { setMode("register"); setError(null); setInfo(null); }} style={tabStyle(mode === "register")}>Register</button>
            <button onClick={() => { setMode("token"); setError(null); setInfo(null); }} style={tabStyle(mode === "token")}>Token</button>
          </div>
        )}

        {info && (
          <div style={{
            fontSize: 12, color: "#3fb950",
            padding: "8px 12px", borderRadius: 8,
            background: "rgba(63,185,80,0.08)",
            border: "0.5px solid rgba(63,185,80,0.25)",
            marginBottom: 12, lineHeight: 1.5,
          }}>{info}</div>
        )}

        {/* Forms */}
        {mode === "login" && (
          <>
            <input autoFocus type="email" placeholder="Email"
              value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <input type="password" placeholder="Password"
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <div style={{ textAlign: "right", marginTop: -2, marginBottom: 4 }}>
              <button
                type="button"
                onClick={() => { setMode("forgot"); setError(null); setInfo(null); }}
                style={{
                  fontFamily: "inherit", fontSize: 11,
                  background: "transparent", border: "none",
                  color: "var(--color-text-tertiary, #6e7681)",
                  cursor: "pointer", padding: 0,
                }}
              >Forgot password?</button>
            </div>
          </>
        )}

        {mode === "forgot" && (
          <>
            <input autoFocus type="email" placeholder="Email"
              value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary, #6e7681)", marginBottom: 4, lineHeight: 1.5 }}>
              We'll email a reset link if this address matches an account.
            </div>
          </>
        )}

        {mode === "reset" && (
          <>
            <input autoFocus type="password" placeholder="New password (≥6 characters)"
              value={resetPassword} onChange={e => setResetPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary, #6e7681)", marginBottom: 4, lineHeight: 1.5 }}>
              Resetting will sign you out everywhere else.
            </div>
          </>
        )}

        {mode === "register" && (
          <>
            <input autoFocus type="email" placeholder="Email"
              value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <input type="password" placeholder="Password (≥6 characters)"
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
            <input type="text" placeholder="Display name (optional)"
              value={displayName} onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={inputStyle} />
          </>
        )}

        {mode === "token" && (
          <input autoFocus type="password" placeholder="Access token"
            value={token} onChange={e => setToken(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            style={inputStyle} />
        )}

        {showError && (
          <div style={{ fontSize: 12, color: "#f85149", marginBottom: 8, marginTop: 4 }}>
            {typeof showError === "string" ? showError : "Authentication failed. Please try again."}
          </div>
        )}

        <button onClick={submit} disabled={submitting}
          style={{
            width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 600,
            borderRadius: 8, border: "none",
            cursor: submitting ? "default" : "pointer", marginTop: 12,
            background: "var(--color-accent, #58a6ff)", color: "#fff",
            opacity: submitting ? 0.6 : 1,
            transition: "opacity 0.15s",
            fontFamily: "inherit",
          }}>
          {submitting ? "…"
            : mode === "login"    ? "Sign in"
            : mode === "register" ? "Create account"
            : mode === "forgot"   ? "Send reset link"
            : mode === "reset"    ? "Set new password"
            : "Continue"}
        </button>

        {(mode === "forgot" || mode === "reset") && (
          <button
            type="button"
            onClick={() => { setMode("login"); setError(null); setInfo(null); }}
            style={{
              width: "100%", marginTop: 8, padding: "6px 0",
              fontFamily: "inherit", fontSize: 11,
              background: "transparent", border: "none",
              color: "var(--color-text-tertiary, #6e7681)",
              cursor: "pointer",
            }}
          >← Back to sign in</button>
        )}

        {!supportsLogin && (
          <div style={{
            fontSize: 10, color: "var(--color-text-tertiary, #6e7681)", marginTop: 12,
            textAlign: "center", fontStyle: "italic",
          }}>
            Server is using legacy shared-token auth.
          </div>
        )}
      </div>
    </div>
  );
}
