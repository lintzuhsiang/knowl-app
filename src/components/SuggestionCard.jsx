import { memo } from "react";

const TYPE_META = {
  merge:    { icon: "⊕", label: "MERGE",        color: "#0891b2" },
  conflict: { icon: "⚠", label: "CONFLICT",     color: "#dc2626" },
  edge:     { icon: "→", label: "ADD EDGE",     color: "#7c3aed" },
  create:   { icon: "+", label: "NEW NODE",     color: "#059669" },
  update:   { icon: "✎", label: "UPDATE",       color: "#a16207" },
  delete:   { icon: "✕", label: "DELETE",       color: "#dc2626" },
  unlink:   { icon: "⊘", label: "UNLINK",       color: "#6b7280" },
};

/**
 * One AI-generated suggestion (merge / conflict / missing-edge).
 * Resolution is binary: accept = "noted, I'll handle it", dismiss = "no thanks".
 * V1 does not auto-apply graph changes; the user makes the edit manually.
 */
export default memo(function SuggestionCard({ suggestion, onAccept, onDismiss, nodesById }) {
  const meta = TYPE_META[suggestion.type] || { icon: "?", label: suggestion.type.toUpperCase(), color: "#6b7280" };
  const p = suggestion.payload || {};
  const titleOf = (id) => nodesById?.[id]?.title || id;

  const renderBody = () => {
    if (suggestion.type === "merge") {
      const titles = (p.ids || []).map(titleOf).join("  +  ");
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>{titles}</div>
          {p.merged_title && (
            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>
              → "{p.merged_title}"
            </div>
          )}
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "conflict") {
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            {titleOf(p.id_a)}  ⇄  {titleOf(p.id_b)}
          </div>
          {p.tension && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.tension}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "edge") {
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            {titleOf(p.from)} —[{p.label || "relates to"}]→ {titleOf(p.to)}
          </div>
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "create") {
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            "{p.title}"
          </div>
          {p.body && (
            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.5, maxHeight: 60, overflow: "hidden" }}>
              {p.body.slice(0, 180)}{p.body.length > 180 ? "…" : ""}
            </div>
          )}
          {p.parent_id && nodesById?.[p.parent_id] && (
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
              under: {titleOf(p.parent_id)}
            </div>
          )}
          {Array.isArray(p.links_to) && p.links_to.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
              links to: {p.links_to.map(titleOf).join(", ")}
            </div>
          )}
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "update") {
      const patch = p.patch || {};
      const fields = Object.entries(patch).filter(([_, v]) => v !== undefined);
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            {titleOf(p.node_id)}
          </div>
          {fields.map(([k, v]) => (
            <div key={k} style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>
              <span style={{ color: "var(--color-text-tertiary)" }}>{k}:</span>{" "}
              {typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "…" : String(v)}
            </div>
          ))}
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "delete") {
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            Delete: {titleOf(p.node_id)}
          </div>
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    if (suggestion.type === "unlink") {
      return (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>
            Remove edge {p.edge_id}
          </div>
          {p.reason && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--color-text-tertiary)", marginTop: 4 }}>
              {p.reason}
            </div>
          )}
        </>
      );
    }
    return <pre style={{ fontSize: 10, margin: 0 }}>{JSON.stringify(p, null, 2)}</pre>;
  };

  return (
    <div style={{
      padding: "8px 10px", borderRadius: 8,
      background: meta.color + "0e",
      border: "0.5px solid " + meta.color + "33",
      display: "flex", gap: 10, alignItems: "flex-start",
    }}>
      <div style={{
        fontSize: 15, color: meta.color, fontWeight: 700,
        minWidth: 18, textAlign: "center", lineHeight: "18px",
      }}>
        {meta.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 9, fontFamily: "'Fira Code', monospace",
          color: meta.color, letterSpacing: 0.5, fontWeight: 700,
          marginBottom: 4,
        }}>
          {meta.label}
        </div>
        {renderBody()}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
        <button
          onClick={onAccept}
          title="Mark as handled (does not auto-apply changes)"
          style={{
            fontSize: 10, padding: "3px 8px", borderRadius: 4,
            border: "0.5px solid " + meta.color, background: meta.color, color: "#fff",
            cursor: "pointer", fontWeight: 600, fontFamily: "inherit",
          }}
        >accept</button>
        <button
          onClick={onDismiss}
          title="Dismiss this suggestion"
          style={{
            fontSize: 10, padding: "3px 8px", borderRadius: 4,
            border: "0.5px solid rgba(0,0,0,0.12)", background: "transparent",
            color: "var(--color-text-tertiary)", cursor: "pointer",
            fontFamily: "inherit",
          }}
        >dismiss</button>
      </div>
    </div>
  );
});
