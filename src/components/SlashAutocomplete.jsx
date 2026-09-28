import { memo } from "react";

/**
 * Floating autocomplete dropdown shown above the chat input when the user
 * starts typing a slash command. Keyboard nav is handled by the parent
 * (ChatPanel) so this component stays presentation-only.
 */
export default memo(function SlashAutocomplete({ items, selectedIdx, onPick }) {
  if (!items || items.length === 0) return null;

  return (
    <div style={{
      position: "absolute",
      bottom: "calc(100% + 6px)",
      left: 12,
      right: 60,
      maxWidth: 420,
      background: "var(--color-background-primary)",
      border: "0.5px solid rgba(0,0,0,0.12)",
      borderRadius: 10,
      boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
      overflow: "hidden",
      zIndex: 20,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {items.map((item, i) => {
        const selected = i === selectedIdx;
        const disabled = !item.ready;
        return (
          <div
            key={item.name}
            onMouseDown={(e) => {
              e.preventDefault();
              if (!disabled) onPick(item);
            }}
            style={{
              padding: "8px 12px",
              cursor: disabled ? "not-allowed" : "pointer",
              background: selected ? "rgba(0,0,0,0.05)" : "transparent",
              display: "flex", alignItems: "center", gap: 10,
              borderBottom: i < items.length - 1 ? "0.5px solid rgba(0,0,0,0.05)" : "none",
              opacity: disabled ? 0.5 : 1,
              transition: "background 0.1s",
            }}
          >
            <span style={{
              fontFamily: "'Fira Code', monospace",
              fontSize: 11, fontWeight: 600,
              color: item.accent || "var(--color-text-primary)",
              minWidth: 84,
            }}>
              {item.label}
            </span>
            <span style={{
              fontSize: 11, color: "var(--color-text-secondary)",
              flex: 1, lineHeight: 1.4,
            }}>
              {item.description}
            </span>
            {item.argsHint && item.ready && (
              <span style={{
                fontSize: 9, fontStyle: "italic",
                color: "var(--color-text-tertiary)",
                fontFamily: "'Fira Code', monospace",
              }}>
                {item.argsHint}
              </span>
            )}
            {!item.ready && (
              <span style={{
                fontSize: 9, padding: "1px 5px", borderRadius: 3,
                background: "rgba(0,0,0,0.06)",
                color: "var(--color-text-tertiary)",
                letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600,
              }}>
                soon
              </span>
            )}
          </div>
        );
      })}
      <div style={{
        padding: "5px 12px",
        background: "rgba(0,0,0,0.02)",
        fontSize: 9,
        color: "var(--color-text-tertiary)",
        fontFamily: "'Fira Code', monospace",
        letterSpacing: 0.3,
      }}>
        ↑↓ navigate · enter to insert · esc to dismiss
      </div>
    </div>
  );
});
