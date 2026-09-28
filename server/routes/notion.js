import { Router } from 'express';

const router = Router();

// Generate a short random ID (same style as the frontend uid())
const uid = () => Math.random().toString(36).slice(2, 8);

// ─── Notion JSON export parser ─────────────────────────────────────────────
// Notion's official export/API returns an object like:
// { object: "list", results: [ { object: "page", properties: {...}, ... } ] }
function parseNotionJSON(data) {
  const results = data.results || (Array.isArray(data) ? data : []);
  const nodes = [];
  const edges = [];

  for (const page of results) {
    if (page.object !== 'page' && page.object !== 'database') continue;

    // Extract title from properties
    const props = page.properties || {};
    let title = 'Untitled';
    for (const key of ['Name', 'Title', 'title', 'name']) {
      const prop = props[key];
      if (!prop) continue;
      const richText = prop.title || prop.rich_text || [];
      const text = richText.map(t => t.plain_text || '').join('').trim();
      if (text) { title = text; break; }
    }

    // Build body from content blocks (if present as children array)
    let body = `# ${title}\n`;
    const children = page.children || page.content || [];
    for (const block of children) {
      const type = block.type;
      const rt = block[type]?.rich_text || [];
      const text = rt.map(t => t.plain_text || '').join('').trim();
      if (!text) continue;
      if (type === 'heading_1') body += `# ${text}\n`;
      else if (type === 'heading_2') body += `## ${text}\n`;
      else if (type === 'heading_3') body += `### ${text}\n`;
      else if (type === 'bulleted_list_item') body += `- ${text}\n`;
      else if (type === 'numbered_list_item') body += `- ${text}\n`;
      else body += `${text}\n`;
    }

    nodes.push({
      id: page.id?.slice(0, 8) || uid(),
      title,
      body: body.trim(),
      x: 100 + nodes.length * 320,
      y: 100,
      h: 140,
      tag: 'core',
      confidence: null,
      conflict: null,
      summary: null,
      relatedTo: null,
      entryContext: null,
    });
  }

  // Look for [[wikilink]] style relations in bodies, create edges
  for (const node of nodes) {
    const links = [...node.body.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1].trim().toLowerCase());
    for (const link of links) {
      const target = nodes.find(n => n.title.toLowerCase() === link);
      if (target && target.id !== node.id) {
        edges.push({ id: uid(), from: node.id, to: target.id, label: 'relates to', dash: true });
      }
    }
  }

  return { nodes, edges };
}

// ─── Notion Markdown export parser ────────────────────────────────────────
// Notion MD export: one page per .md file, or a zip. We accept raw markdown text.
// Heuristic: split on "---" horizontal rules or top-level "# " headings.
function parseNotionMarkdown(text) {
  const nodes = [];
  const edges = [];

  // Split into sections by --- dividers first
  let sections = text.split(/\n---+\n/);

  // If there's only one big section, try splitting on "# " headings
  if (sections.length === 1) {
    sections = text.split(/(?=\n# )/);
  }

  for (const raw of sections) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    let title = 'Untitled';

    // Find the first heading line for the title
    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.+)/);
      if (m) { title = m[1].trim(); break; }
    }

    // If no heading found, use first non-empty line
    if (title === 'Untitled') {
      const first = lines.find(l => l.trim());
      if (first) title = first.replace(/^#+\s*/, '').trim().slice(0, 60);
    }

    const id = uid();
    nodes.push({
      id,
      title,
      body: trimmed,
      x: 100 + nodes.length * 320,
      y: 100,
      h: 140,
      tag: 'core',
      confidence: null,
      conflict: null,
      summary: null,
      relatedTo: null,
      entryContext: null,
    });
  }

  // Detect [[wikilinks]] inside markdown bodies and create edges
  for (const node of nodes) {
    const links = [...node.body.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1].trim().toLowerCase());
    for (const link of links) {
      const target = nodes.find(n => n.title.toLowerCase() === link);
      if (target && target.id !== node.id) {
        edges.push({ id: uid(), from: node.id, to: target.id, label: 'relates to', dash: true });
      }
    }
  }

  return { nodes, edges };
}

// POST /api/db/notion/import
// Body: { text: string, topic: string }
// text can be:
//   - Raw markdown string
//   - Stringified Notion JSON export/API response
router.post('/import', (req, res) => {
  try {
    const { text, topic } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    let parsed;

    // Try JSON first
    try {
      const json = JSON.parse(text);
      parsed = parseNotionJSON(json);
    } catch {
      // Not JSON → treat as markdown
      parsed = parseNotionMarkdown(text);
    }

    const { nodes, edges } = parsed;
    if (nodes.length === 0) {
      return res.status(422).json({ error: 'No nodes could be parsed from the provided content.' });
    }

    // Return in the FusionModal "mappings" format the frontend already understands
    const mappings = nodes.map(n => ({
      type: 'new',
      newTitle: n.title,
      excerpt: n.body.replace(/^#+\s*/gm, '').slice(0, 100),
      nodeData: n,
    }));

    res.json({ mappings, edges, nodeCount: nodes.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
