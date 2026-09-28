export const TOPIC_COLORS = ["#5b5bd6", "#a16207", "#0891b2", "#7c3aed", "#059669", "#dc2626"];
export const CC = "#d97706";
export const NC = "#059669";
export const NW = 260;
export const SR = 56;
export const MERGE_R = 90;
export const ZOOM_COMPACT = 0.55;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const uid = () => Math.random().toString(36).slice(2, 8);
export const CONF_CYCLE = [null, "solid", "fuzzy", "question"];
export const CONF_COLOR = { solid: NC, fuzzy: "#f59e0b", question: CC };
export const CONF_LABEL = { solid: "solid", fuzzy: "fuzzy", question: "?" };
export const IS_TOUCH = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

export const SEED = {
  "system-design": {
    label: "System Design", nodes: [
      { id: "mq", x: 60, y: 60, h: 190, title: "Message Queues", summary: null, confidence: null, body: "# Message Queues\nDecouple producers from consumers.\n- Kafka — high throughput, batch-optimised\n  - Partition keys determine ordering\n  - Consumer groups for parallel reads\n- RabbitMQ — lower latency, complex routing\n  - Exchanges: direct / topic / fanout", conflict: { inp: "Latency is structural, not tunable. Tail latency in checkout cascades. Throughput scales horizontally; p99 does not.", label: "Latency vs. throughput", status: "unresolved" }, tag: "core", relatedTo: null, entryContext: null },
      { id: "cache", x: 400, y: 50, h: 175, title: "Caching", summary: null, confidence: null, body: "# Caching Layers\n- L1 — in-process (node-local)\n- L2 — Redis / Memcached\n  - Cache-aside is safest default\n  - Write-through for consistency\n- TTL discipline > cache size\n- Eviction policy is the real design call", conflict: null, tag: "core", relatedTo: null, entryContext: null },
      { id: "lb", x: 60, y: 320, h: 150, title: "Load Balancing", summary: null, confidence: null, body: "## Load Balancing\n- Round-robin for stateless\n- Sticky sessions for stateful\n- L4 vs L7 matters for WebSocket\n  - L7 can inspect headers/cookies", conflict: null, tag: "core", relatedTo: null, entryContext: null },
      { id: "db", x: 400, y: 300, h: 150, title: "DB Sharding", summary: null, confidence: null, body: "## Database Sharding\n- Shard by user ID\n- Consistent hashing for routing\n  - Virtual nodes reduce rebalance\n- Cross-shard queries are expensive", conflict: null, tag: "core", relatedTo: null, entryContext: null },
    ], edges: [{ id: "e1", from: "lb", to: "mq", label: "routes to", dash: false }, { id: "e2", from: "db", to: "cache", label: "backs", dash: true }]
  },
  "european-history": {
    label: "European History", nodes: [
      { id: "church", x: 60, y: 60, h: 175, title: "Medieval Church", summary: null, confidence: null, body: "# Medieval Church\nDominant force 500–1400 AD.\n- Bishops outranked kings\n- Cathedral schools → universities\n  - Bologna (1088), Paris (~1150)\n- Tithe system funded construction", conflict: null, tag: "core", relatedTo: null, entryContext: null },
      { id: "crusades", x: 400, y: 50, h: 165, title: "The Crusades", summary: null, confidence: null, body: "# The Crusades\n1095–1291. Reclaim Jerusalem.\n- Pope Urban II launched First Crusade\n- Opened Eastern trade routes\n- Islamic knowledge transferred to Europe", conflict: null, tag: "core", relatedTo: null, entryContext: null },
      { id: "gothic", x: 60, y: 310, h: 165, title: "Gothic Architecture", summary: null, confidence: null, body: "## Gothic Architecture\n12th-16th century.\n- Flying buttresses, taller walls\n- Stained glass as theology\n  - Light = divine presence\n- Notre-Dame, Chartres, Cologne", conflict: { inp: "Gothic was structural innovation first. Engineering preceded theology.", label: "Engineering vs. theology", status: "unresolved" }, tag: "new-domain", relatedTo: null, entryContext: null },
      { id: "renaissance", x: 400, y: 290, h: 155, title: "Renaissance", summary: null, confidence: null, body: "## Renaissance\n14th-17th c. Florence.\n- Humanism: God to man\n- Gutenberg press 1440\n  - Mass literacy, Reformation\n- Medici patronage model", conflict: null, tag: "core", relatedTo: null, entryContext: null },
    ], edges: [{ id: "e1", from: "church", to: "gothic", label: "commissioned", dash: false }, { id: "e2", from: "crusades", to: "renaissance", label: "catalyzed", dash: true }]
  },
};

export const TASK_MODES = {
  bq: {
    label: "BQ", color: "#7c3aed", desc: "Behavioral stories & trade-offs",
    prompts: ["Tech challenge story in ", "Trade-off decision in ", "Push-back or conflict moment in ", "Impact and metrics from "],
    sys: "Focus on STAR stories, tech challenges, trade-off decisions, push-back moments, quantifiable impact. Help prepare behavioral interview answers."
  },
  sysdesign: {
    label: "System Design", color: "#0891b2", desc: "Architecture & data flows",
    prompts: ["Walk me through data flow of ", "Key architectural decisions in ", "Fault tolerance strategy in ", "Scalability trade-offs in "],
    sys: "Focus on architecture decisions, data flows, trade-offs, fault tolerance, scalability, and design rationale. Reconstruct reasoning behind design choices."
  },
  general: {
    label: "General", color: NC, desc: "Open warm-up",
    prompts: ["Give me an overview of ", "Where did I leave off with ", "What am I fuzzy on about ", "Key conclusions from "],
    sys: "Give a conversational warm-up based on the user notes. Surface open questions and help them re-enter the topic."
  },
};
