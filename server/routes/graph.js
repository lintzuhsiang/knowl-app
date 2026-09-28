import { Router } from 'express';
import {
  listGraphs, getGraph, putGraph,
  putNode, deleteNode,
  putEdge, deleteEdge,
  bumpNodeView, setNodeRecall, getMemoryStats,
  appendChatMessage, listChatMessages, clearChatMessages,
  createSuggestion, listSuggestions, resolveSuggestion,
} from '../db.js';

const router = Router();

// GET /api/db/graphs — list topic metadata in current workspace
router.get('/graphs', (req, res) => {
  try {
    res.json(listGraphs(req.workspaceId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/db/graphs/:topic
router.get('/graphs/:topic', (req, res) => {
  try {
    const graph = getGraph(req.workspaceId, req.params.topic);
    if (!graph) return res.status(404).json({ error: 'Not found' });
    res.json(graph);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/db/graphs/:topic — upsert full graph (last-write-wins)
router.put('/graphs/:topic', (req, res) => {
  try {
    const { label, nodeMap = {}, edges = [], updated_at } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });
    const result = putGraph(req.workspaceId, req.params.topic, label, nodeMap, edges, updated_at);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/db/nodes/:nodeId
router.put('/nodes/:nodeId', (req, res) => {
  try {
    const { topic, data, updated_at } = req.body;
    if (!topic || !data) return res.status(400).json({ error: 'topic and data are required' });
    putNode(req.workspaceId, req.params.nodeId, topic, data, updated_at);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/db/nodes/:nodeId
router.delete('/nodes/:nodeId', (req, res) => {
  try {
    deleteNode(req.workspaceId, req.params.nodeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/db/edges/:edgeId
router.put('/edges/:edgeId', (req, res) => {
  try {
    const { topic, data, updated_at } = req.body;
    if (!topic || !data) return res.status(400).json({ error: 'topic and data are required' });
    putEdge(req.workspaceId, req.params.edgeId, topic, data, updated_at);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/db/edges/:edgeId
router.delete('/edges/:edgeId', (req, res) => {
  try {
    deleteEdge(req.workspaceId, req.params.edgeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Memory metadata ───────────────────────────────────────────────────────
// POST /api/db/nodes/:nodeId/view — bump viewed_at + viewed_count
router.post('/nodes/:nodeId/view', (req, res) => {
  try {
    bumpNodeView(req.workspaceId, req.params.nodeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/db/nodes/:nodeId/recall — body: { score: 0..1 }
router.post('/nodes/:nodeId/recall', (req, res) => {
  try {
    const { score } = req.body || {};
    if (typeof score !== 'number') return res.status(400).json({ error: 'score (number) required' });
    setNodeRecall(req.workspaceId, req.params.nodeId, score);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/db/memory/:topic — aggregate memory stats for a topic's nodes
router.get('/memory/:topic', (req, res) => {
  try {
    res.json(getMemoryStats(req.workspaceId, req.params.topic));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Chat persistence (per canvas) ────────────────────────────────────────
// canvas_key is the same identifier the frontend uses for chat state
// (e.g. "system-design" or "system-design::drill::cache").
// We URI-encode it because it contains :: which Express handles fine, but
// keeping it consistent.
router.get('/chat/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    res.json(listChatMessages(req.workspaceId, key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/chat/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    const { id, role, content, meta, streaming } = req.body || {};
    if (!role || !['user', 'assistant', 'system'].includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    const r = appendChatMessage(req.workspaceId, key, { id, role, content, meta, streaming });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/chat/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    clearChatMessages(req.workspaceId, key);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Suggestions (merge / conflict / edge proposals) ──────────────────────
router.get('/suggestions/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    const status = req.query.status || 'pending';
    res.json(listSuggestions(req.workspaceId, key, { status }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/suggestions/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    const { type, payload } = req.body || {};
    if (!type || !payload) return res.status(400).json({ error: 'type and payload required' });
    res.json(createSuggestion(req.workspaceId, key, type, payload));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/suggestions/:id', (req, res) => {
  try {
    const { status } = req.body || {};
    resolveSuggestion(req.workspaceId, req.params.id, status);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
