import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

export const CONFIG = {
  models: {
    scribe: "claude-haiku-4-5-20251001",
    librarian: "claude-sonnet-4-5-20250929",
    dreamer: "claude-sonnet-4-5-20250929",
  },

  temperature: {
    scribe: 0.3,
    librarian: 0.2,
    dreamer: 1.0,
  },

  maxTokens: {
    scribe: 4096,
    librarian: 4000,
    dreamer: 2000,
  },

  session: {
    scribeInterval: 5, // messages between scribe runs
    idleTimeoutMs: 300_000, // 5 minutes
    maxSessionMessages: 200,
    minSessionMessages: 3, // sessions shorter than this skip consolidation
    pipelineCooldownMs: 600_000, // 10 min debounce between pipeline runs
  },

  graph: {
    maxMapTokens: 5000,
    maxPriors: 30,
    maxNodesBeforePrune: 80,
    decayHalfLifeDays: 30,
    decayArchiveThreshold: 0.15,
    decayHotNodeThreshold: 0.6,
    dreamPendingMaxSessions: 5,
    dreamMinConfidence: 0.2,
    dreamPromoteConfidence: 0.5,
  },

  paths: {
    projectRoot: PROJECT_ROOT,
    graphRoot: path.join(PROJECT_ROOT, "graph"),
    manifest: path.join(PROJECT_ROOT, "graph/manifest.yml"),
    map: path.join(PROJECT_ROOT, "graph/MAP.md"),
    priors: path.join(PROJECT_ROOT, "graph/PRIORS.md"),
    index: path.join(PROJECT_ROOT, "graph/.index.json"),
    deltas: path.join(PROJECT_ROOT, "graph/.deltas"),
    dreams: path.join(PROJECT_ROOT, "graph/dreams"),
    nodes: path.join(PROJECT_ROOT, "graph/nodes"),
    archive: path.join(PROJECT_ROOT, "graph/archive"),
    buffer: path.join(PROJECT_ROOT, "graph/.buffer"),
    conversationLog: path.join(
      PROJECT_ROOT,
      "graph/.buffer/conversation.jsonl"
    ),
  },

  git: {
    enabled: true,
    remote: "origin",
    branch: "main",
    autoPush: true,
    commitPrefix: "memory:",
  },
} as const;
