// Rich markdown renderer — supports headers, bold, italic, inline code,
// code blocks, links, blockquotes, nested lists, and horizontal rules.

function inlineParse(text) {
  // Parse inline markdown: **bold**, *italic*, `code`, [link](url)
  const parts = [];
  let i = 0;
  while (i < text.length) {
    // inline code
    if (text[i] === "`" && text.indexOf("`", i + 1) > i) {
      const end = text.indexOf("`", i + 1);
      if (i > 0 && parts.length === 0) parts.push(text.slice(0, i));
      else if (parts.length > 0 && typeof parts[parts.length - 1] === "string") {
        // already handled
      }
      parts.push({ type: "code", text: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    // bold **text**
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        parts.push({ type: "bold", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // italic *text* (not at **)
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i && text[end + 1] !== "*") {
        parts.push({ type: "italic", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // link [text](url)
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket) {
          parts.push({ type: "link", text: text.slice(i + 1, closeBracket), url: text.slice(closeBracket + 2, closeParen) });
          i = closeParen + 1;
          continue;
        }
      }
    }
    // plain char — accumulate into last string part
    if (parts.length > 0 && typeof parts[parts.length - 1] === "string") {
      parts[parts.length - 1] += text[i];
    } else {
      parts.push(text[i]);
    }
    i++;
  }
  if (parts.length === 0) return text;
  return parts.map((p, idx) => {
    if (typeof p === "string") return <span key={idx}>{p}</span>;
    if (p.type === "code") return <code key={idx} style={{ fontFamily: "'Fira Code',monospace", fontSize: "0.88em", padding: "1px 4px", borderRadius: 3, background: "var(--color-background-tertiary)", color: "var(--color-text-primary)" }}>{p.text}</code>;
    if (p.type === "bold") return <strong key={idx} style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{p.text}</strong>;
    if (p.type === "italic") return <em key={idx} style={{ fontStyle: "italic" }}>{p.text}</em>;
    if (p.type === "link") {
      const safeUrl = /^https?:\/\//i.test(p.url) ? p.url : "#";
      return <a key={idx} href={safeUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1", textDecoration: "underline", textDecorationColor: "#6366f133" }}>{p.text}</a>;
    }
    return p.text;
  });
}

export default function MD({ text }) {
  const lines = (text || "").split("\n");
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const l = lines[i];

    // code block ```
    if (l.trim().startsWith("```")) {
      const lang = l.trim().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <div key={elements.length} style={{ margin: "6px 0", padding: "8px 10px", borderRadius: 7, background: "var(--color-background-tertiary)", border: "0.5px solid var(--color-border-tertiary)", fontFamily: "'Fira Code',monospace", fontSize: 10.5, lineHeight: 1.7, color: "var(--color-text-primary)", overflowX: "auto", whiteSpace: "pre" }}>
          {lang && <div style={{ fontSize: 9, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{lang}</div>}
          {codeLines.join("\n")}
        </div>
      );
      i++; // skip closing ```
      continue;
    }

    // empty line
    if (!l.trim()) { elements.push(<div key={elements.length} style={{ height: 3 }} />); i++; continue; }

    // horizontal rule
    if (/^-{3,}$/.test(l.trim()) || /^\*{3,}$/.test(l.trim())) {
      elements.push(<hr key={elements.length} style={{ border: "none", borderTop: "0.5px solid var(--color-border-tertiary)", margin: "6px 0" }} />);
      i++; continue;
    }

    // headers
    if (l.startsWith("# ")) { elements.push(<div key={elements.length} style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", marginTop: 4, marginBottom: 5, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 4 }}>{inlineParse(l.slice(2))}</div>); i++; continue; }
    if (l.startsWith("## ")) { elements.push(<div key={elements.length} style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-primary)", marginTop: 7, marginBottom: 2 }}>{inlineParse(l.slice(3))}</div>); i++; continue; }
    if (l.startsWith("### ")) { elements.push(<div key={elements.length} style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-primary)", marginTop: 5, marginBottom: 1 }}>{inlineParse(l.slice(4))}</div>); i++; continue; }
    if (l.startsWith("#### ")) { elements.push(<div key={elements.length} style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", marginTop: 4, marginBottom: 1 }}>{inlineParse(l.slice(5))}</div>); i++; continue; }

    // blockquote
    if (l.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <div key={elements.length} style={{ borderLeft: "2.5px solid var(--color-border-secondary)", paddingLeft: 10, margin: "4px 0", fontSize: 11.5, lineHeight: 1.65, color: "var(--color-text-tertiary)", fontStyle: "italic" }}>
          {quoteLines.map((ql, qi) => <div key={qi}>{inlineParse(ql)}</div>)}
        </div>
      );
      continue;
    }

    // third-level nested list (6+ spaces or 3 tabs)
    if (/^\s{6,}- /.test(l) || /^\t{3,}- /.test(l)) {
      elements.push(<div key={elements.length} style={{ display: "flex", gap: 5, paddingLeft: 32, marginTop: 1 }}><span style={{ color: "var(--color-text-tertiary)", fontSize: 8, marginTop: 4, flexShrink: 0 }}>-</span><span style={{ fontSize: 10.5, lineHeight: 1.6, color: "var(--color-text-tertiary)" }}>{inlineParse(l.replace(/^\s+-\s/, ""))}</span></div>);
      i++; continue;
    }

    // second-level nested list
    if (/^\s{2,}- /.test(l) || /^\t+- /.test(l)) {
      elements.push(<div key={elements.length} style={{ display: "flex", gap: 5, paddingLeft: 16, marginTop: 1 }}><span style={{ color: "var(--color-text-tertiary)", fontSize: 10, marginTop: 3, flexShrink: 0 }}>◦</span><span style={{ fontSize: 11, lineHeight: 1.65, color: "var(--color-text-secondary)" }}>{inlineParse(l.replace(/^\s+-\s/, ""))}</span></div>);
      i++; continue;
    }

    // numbered list
    if (/^\d+\.\s/.test(l)) {
      const match = l.match(/^(\d+)\.\s(.*)/);
      elements.push(<div key={elements.length} style={{ display: "flex", gap: 6, marginTop: 2 }}><span style={{ color: "var(--color-text-tertiary)", fontSize: 11, fontWeight: 600, minWidth: 14, textAlign: "right", flexShrink: 0, marginTop: 1 }}>{match[1]}.</span><span style={{ fontSize: 12, lineHeight: 1.65, color: "var(--color-text-secondary)" }}>{inlineParse(match[2])}</span></div>);
      i++; continue;
    }

    // top-level bullet list
    if (l.startsWith("- ")) {
      elements.push(<div key={elements.length} style={{ display: "flex", gap: 6, marginTop: 2 }}><span style={{ color: "var(--color-text-secondary)", fontSize: 10, marginTop: 3, flexShrink: 0 }}>•</span><span style={{ fontSize: 12, lineHeight: 1.65, color: "var(--color-text-secondary)" }}>{inlineParse(l.slice(2))}</span></div>);
      i++; continue;
    }

    // plain paragraph with inline parsing
    elements.push(<div key={elements.length} style={{ fontSize: 12, lineHeight: 1.7, color: "var(--color-text-secondary)", marginTop: 2 }}>{inlineParse(l)}</div>);
    i++;
  }

  return <div>{elements}</div>;
}
