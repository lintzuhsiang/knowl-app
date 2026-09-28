# Knowl — Knowledge Map

A local React app for building AI-powered knowledge maps.

## Setup

### 1. Prerequisites
- Node.js 18+
- An Anthropic API key (get one at https://console.anthropic.com)

### 2. Install
```bash
cd knowl-app
npm install
```

### 3. Set your API key
```bash
cp .env.example .env
# Edit .env and replace with your actual key:
# VITE_ANTHROPIC_API_KEY=sk-ant-api03-...
```

### 4. Run
```bash
npm run dev
# Opens at http://localhost:3000
```

---

## Features

**Canvas**
- Scroll to pan, Ctrl+scroll to zoom
- Double-click canvas → new node
- Double-click node → edit (markdown)
- Drag node onto another → AI merge (with undo)
- Shift+click nodes → multi-select (2 selected = AI Merge banner)
- Shift+drag canvas → lasso select → Group summary
- Anchor dots (hover node) → drag to connect edges

**AI Input Bar** (bottom)
- `✎ note` mode: drop a thought → AI routes to right node (new / update / conflict)
- `🔄 fuse` mode: paste large block of new notes → AI maps each chunk to existing nodes → Fusion Preview → apply
- `◎ chat` mode: ask questions about your knowledge map
- Node selected: quick commands (split / rewrite / append)
- Text selected inside node: Extract / Elaborate / Question toolbar

**Right Panel** (top bar buttons)
- `✦ Tutor`: Socratic Q&A — nodes highlight as AI references them, missing concepts become ghost nodes
- `🔥 Warm Up`: re-enter any concept — AI tours your nodes in reading order, surfaces open questions
- `⬡ Gaps`: scan for knowledge gaps, latent conflicts, explore-next suggestions

**Node badges**
- `○ / solid / fuzzy / ?`: click to cycle confidence level
- `conflict`: click to open Conflict modal (Compare → Synthesize → Edit)
- `⟷ related`: navigate to related node

**Other**
- Semantic zoom: zoom out below 0.55x → compact mode with AI-generated summaries
- Tension panel: ⚡ button shows all unresolved conflicts
- Digest card: switching topics shows a welcome-back summary (if gap scan was run before)
- Undo stack: up to 20 levels

---

## Notes
- All API calls go through `/api/anthropic` proxy (configured in vite.config.js) to avoid CORS
- No data is stored — everything lives in React state (refreshing resets the map)
- Streaming is used for the Conflict modal synthesis only
