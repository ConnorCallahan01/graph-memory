/**
 * Pi extension for graph-memory.
 *
 * Registers the `graph_memory` tool that gives pi agents access to the
 * persistent knowledge graph. Injectes all five context files (MAP,
 * PRIORS, SOMA, WORKING, DREAMS) at session start when the graph is
 * initialized. Captures conversation (user + assistant messages) to the
 * buffer, rotating snapshots to feed the scribe pipeline.
 *
 * Usage (after installing as a pi package):
 *   pi install ./graph-memory-plugin   # local dev
 *   pi install npm:graph-memory        # from npm
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

// We import from the compiled dist (the package publishes dist/ to npm).
// During local dev with `pi install ./graph-memory-plugin`, make sure
// `npm run build` has been executed first.
let _handleGraphMemory: any;
let _initializeGraph: any;
let _CONFIG: any;
let _isGraphInitialized: any;
let _enqueueJob: any;
let _overlap: any;
let _recencyBoost: any;
let _somaBoost: any;
let _projectBoost: any;
let _listManifests: any;

async function loadCore() {
  if (_handleGraphMemory) return;
  // Resolve relative to this extension file's directory
  const extDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  const distDir = path.resolve(extDir, "..", "dist", "graph-memory");
  const tools = await import(path.join(distDir, "tools.js"));
  const index = await import(path.join(distDir, "index.js"));
  const config = await import(path.join(distDir, "config.js"));
  const jobQueue = await import(path.join(distDir, "pipeline", "job-queue.js"));
  const scoring = await import(path.join(distDir, "scoring.js"));
  const soma = await import(path.join(distDir, "soma.js"));
  const manifest = await import(path.join(distDir, "pipeline", "skillforge-manifest.js"));
  _handleGraphMemory = tools.handleGraphMemory;
  _initializeGraph = index.initializeGraph;
  _CONFIG = config.CONFIG;
  _isGraphInitialized = config.isGraphInitialized;
  _enqueueJob = jobQueue.enqueueJob;
  _overlap = scoring.overlap;
  _recencyBoost = scoring.recencyBoost;
  _somaBoost = soma.somaBoost;
  _projectBoost = scoring.projectBoost;
  _listManifests = manifest.listManifests;
}

export default function (pi: ExtensionAPI) {
  // Lazy-init the graph on tool use — avoids errors when the graph
  // hasn't been set up yet (first install, fresh machine, etc.)
  let graphReady = false;

  async function ensureGraph() {
    if (graphReady) return;
    await loadCore();
    // Only initialize if the user has previously set up graph memory
    // (global config exists) or if GRAPH_MEMORY_ROOT env var is set
    if (_isGraphInitialized() || process.env.GRAPH_MEMORY_ROOT) {
      _initializeGraph();
      graphReady = true;
    }
  }

  // ── Register the tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "graph_memory",
    label: "Graph Memory",
    description: `Access the persistent knowledge graph. Actions: initialize, configure_runtime, status, remember, write_note, search, recall, read_node, list_edges, read_dream, consolidate, history, revert, resurface.

MEMORY ACTIONS:
- remember: Create or update a graph node directly. Provide path, gist, and optionally content, tags, edges, soma markers.
- recall: Combined search + edge traversal. Returns matching nodes plus connected nodes (1 hop).
- search: Keyword search on the index (gist, tags, keywords).
- read_node: Read full node content including frontmatter.
- list_edges: Show all connections from a node.

RETRIEVAL GUIDANCE — follow these steps proactively:
1. When the user mentions personal details, preferences, past events, or recurring topics, use "recall" with relevant keywords.
2. When a relevant node is found, use "list_edges" to discover related nodes.
3. When you learn something worth remembering, use "remember" to record it as a proper graph node with edges and tags.

PIPELINE:
- consolidate: Run mechanical delta processing (apply scribe deltas, rebuild MAP, decay, git commit).

SETUP:
- initialize: First-time setup. Pass graphRoot to choose storage location (defaults to ~/.graph-memory/).
- configure_runtime: Set manual or Docker runtime configuration.`,

    promptSnippet: "search, recall, and write persistent graph memory",
    promptGuidelines: [
      "Use graph_memory(action=\"recall\", query=\"...\") proactively before answering questions about topics that may have been discussed in prior sessions.",
      "Use graph_memory(action=\"remember\", path=\"...\", gist=\"...\", content=\"...\", tags=[...], edges=[...]) to record durable knowledge without announcing it.",
    ],

    parameters: Type.Object({
      action: Type.String({
        description:
          "The action to perform: read_node, search, recall, list_edges, read_dream, write_note, remember, resurface, status, history, revert, consolidate, initialize, configure_runtime",
      }),
      path: Type.Optional(
        Type.String({
          description:
            "Node path for read_node/list_edges/remember, dream path for read_dream, commit hash for revert",
        })
      ),
      query: Type.Optional(
        Type.String({ description: "Search query for search/recall actions" })
      ),
      note: Type.Optional(
        Type.String({ description: "Note content for write_note action" })
      ),
      gist: Type.Optional(
        Type.String({ description: "One-sentence summary for remember action" })
      ),
      content: Type.Optional(
        Type.String({ description: "Full content for remember action" })
      ),
      title: Type.Optional(
        Type.String({ description: "Human-readable title for remember action" })
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags for remember action" })
      ),
      confidence: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Confidence (0-1) for remember action" })
      ),
      edges: Type.Optional(
        Type.Array(
          Type.Object({
            target: Type.String(),
            type: Type.String(),
            weight: Type.Optional(Type.Number()),
          }),
          { description: "Edge connections for remember action" }
        )
      ),
      soma: Type.Optional(
        Type.Object(
          {
            valence: Type.String(),
            intensity: Type.Number(),
            marker: Type.String(),
          },
          { description: "Somatic marker for remember action" }
        )
      ),
      depth: Type.Optional(
        Type.Number({ minimum: 0, maximum: 3, description: "Edge traversal depth for recall action (default 1, max 3)" })
      ),
      graphRoot: Type.Optional(
        Type.String({ description: "Storage path for initialize action (defaults to ~/.graph-memory/)" })
      ),
      project: Type.Optional(
        Type.String({ description: "Project scope for remember action (e.g. 'owner/repo'). Only set for project-specific knowledge, omit for global." })
      ),
      pinned: Type.Optional(
        Type.Boolean({ description: "Pin node to prevent decay" })
      ),
      runtimeMode: Type.Optional(
        Type.String({ description: "Runtime mode for configure_runtime: manual | docker" })
      ),
      containerName: Type.Optional(
        Type.String({ description: "Docker container name override for configure_runtime" })
      ),
      imageName: Type.Optional(
        Type.String({ description: "Docker image override for configure_runtime" })
      ),
      authVolume: Type.Optional(
        Type.String({ description: "Docker auth volume name for configure_runtime" })
      ),
      graphRootInContainer: Type.Optional(
        Type.String({ description: "Container graph root mount path for configure_runtime" })
      ),
      authPathInContainer: Type.Optional(
        Type.String({ description: "Container auth mount path for configure_runtime" })
      ),
      memoryLimit: Type.Optional(
        Type.String({ description: "Container memory limit for configure_runtime" })
      ),
      cpuLimit: Type.Optional(
        Type.String({ description: "Container CPU limit for configure_runtime" })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureGraph();
      await loadCore();

      // Forward to the same core handler used by the MCP server
      return _handleGraphMemory(params);
    },
  });

  // ── Conversation capture state ────────────────────────────────────
  // Mirrors the Claude Code hook pipeline: user + assistant messages
  // are buffered to per-session conversation files. At the scribe threshold
  // (default 10 messages), the buffer is rotated to a snapshot and a
  // scribe job is queued for the background daemon.
  let messageCount = 0;
  let captureSessionId = "";
  let captureEnabled = false;

  function ensureBufferDir() {
    const dir = _CONFIG?.paths?.buffer;
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function sessionLogPath(): string {
    const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(_CONFIG!.paths.buffer, `conversation-${safeId}.jsonl`);
  }

  function appendToBuffer(entry: Record<string, unknown>) {
    if (!captureEnabled || !_CONFIG) return;
    ensureBufferDir();
    fs.appendFileSync(
      sessionLogPath(),
      JSON.stringify(entry) + "\n"
    );
    messageCount++;
  }

  function rotateAndQueue() {
    if (!_CONFIG || !captureEnabled) return;
    const logPath = sessionLogPath();
    if (!fs.existsSync(logPath)) return;
    const content = fs.readFileSync(logPath, "utf-8").trim();
    if (!content) return;

    const snapshotName = `snapshot_${Date.now()}.jsonl`;
    const snapshotPath = path.join(_CONFIG.paths.buffer, snapshotName);
    fs.writeFileSync(snapshotPath, content + "\n");
    fs.unlinkSync(logPath);
    messageCount = 0;

    if (_enqueueJob) {
      const jobPayload = {
        snapshotPath,
        sessionId: captureSessionId,
      };
      _enqueueJob({
        type: "scribe",
        payload: jobPayload,
        triggerSource: "pi-extension:threshold",
        idempotencyKey: `scribe:${snapshotPath}`,
      });
      _enqueueJob({
        type: "observer",
        payload: jobPayload,
        triggerSource: "pi-extension:threshold",
        idempotencyKey: `observer:${snapshotPath}`,
      });
    }
  }

  // ── Session lifecycle: start tracking and clear stale buffer ─────
  pi.on("session_start", async () => {
    await ensureGraph();
    await loadCore();
    if (!_CONFIG) return;
    captureEnabled = true;
    messageCount = 0;
    captureSessionId = `pi_session_${Date.now()}`;
    ensureBufferDir();
    try {
      const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const perSessionLog = path.join(_CONFIG.paths.buffer, `conversation-${safeId}.jsonl`);
      if (fs.existsSync(perSessionLog)) {
        fs.unlinkSync(perSessionLog);
      }
    } catch { /* ignore */ }
  });

  // ── Session shutdown: flush remaining buffer ────────────────────
  pi.on("session_shutdown", async () => {
    if (captureEnabled && messageCount > 0) {
      rotateAndQueue();
    }
    if (captureSessionId && _CONFIG) {
      try {
        const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const perSessionLog = path.join(_CONFIG.paths.buffer, `conversation-${safeId}.jsonl`);
        if (fs.existsSync(perSessionLog)) {
          fs.unlinkSync(perSessionLog);
        }
      } catch { /* ignore */ }
    }
    captureEnabled = false;
    messageCount = 0;
    captureSessionId = "";
  });

  // ── Ambient auto-recall helpers ──────────────────────────────────
  // Mirrors the Claude Code on-user-message hook: on each user prompt,
  // scans the graph index for relevant nodes and injects them as
  // <graph-memory-context> hints so the LLM knows what already exists.

  // ~40 common English stopwords — filtered from user message before scoring
  const STOPWORDS = new Set([
    "a","an","the","is","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could",
    "should","may","might","can","shall","to","of","in","for",
    "on","with","at","by","from","as","into","about","but","or",
    "and","not","no","so","if","then","than","that","this","it",
    "i","me","my","we","our","you","your","he","she","they",
    "what","how","when","where","why","which","who","whom",
  ]);

  function categoryGateWeight(nodePath: string): number {
    const category = nodePath.split("/")[0] || "";
    switch (category) {
      case "preferences":
      case "patterns":
      case "decisions":
      case "projects":
      case "procedures":
      case "people":
      case "architecture":
      case "concepts":
      case "tools":
        return 1.25;
      case "dreams":
        return 0.55;
      default:
        return 1.0;
    }
  }

  function ambientRecall(
    userMessage: string,
    currentProject?: string
  ): string | null {
    if (!_CONFIG) return null;
    const indexPath = _CONFIG.paths.index;
    if (!fs.existsSync(indexPath)) return null;

    // Tokenize and filter stopwords
    const tokens = userMessage
      .toLowerCase()
      .split(/\s+/)
      .map((t: string) => t.replace(/[^a-z0-9-]/g, ""))
      .filter((t: string) => t.length > 1 && !STOPWORDS.has(t));

    if (tokens.length < 2) return null;

    let index: any[];
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch {
      return null;
    }
    if (!Array.isArray(index) || index.length === 0) return null;

    // Score all entries
    const scored = index
      .map((entry: any) => {
        const gistTokens = (entry.gist || "").toLowerCase().split(/\s+/);
        const tagTokens = (entry.tags || []).map((t: any) => String(t).toLowerCase());
        const keywordTokens = (entry.keywords || []).map((k: any) =>
          String(k).toLowerCase()
        );
        const pathTokens = (entry.path || "")
          .toLowerCase()
          .split(/[\/\-_]/);

        const gistScore = _overlap(tokens, gistTokens) * 3;
        const tagScore = _overlap(tokens, tagTokens) * 2;
        const keywordScore = _overlap(tokens, keywordTokens) * 1;
        const pathScore = _overlap(tokens, pathTokens) * 1.5;
        const baseRelevance =
          (gistScore + tagScore + keywordScore + pathScore) *
          (entry.confidence || 0.5);

        const relevance =
          baseRelevance *
          _recencyBoost(entry.last_accessed) *
          _somaBoost(entry.soma_intensity || 0) *
          _projectBoost(entry.project, currentProject) *
          categoryGateWeight(entry.path || "");

        return {
          path: entry.path,
          gist: entry.gist,
          relevance,
        };
      })
      .filter((e: any) => e.relevance > 0.15)
      .sort((a: any, b: any) => b.relevance - a.relevance)
      .slice(0, 3);

    if (scored.length === 0) return null;

    const lines = scored.map(
      (r: any) =>
        `- **${r.path}** (${r.relevance.toFixed(2)}): ${(r.gist || "").slice(0, 150)}`
    );

    return [
      "<graph-memory-context>",
      "Relevant memory nodes for this message:",
      ...lines,
      "",
      'Use graph_memory(action="read_node", path="...") for full content.',
      "</graph-memory-context>",
    ].join("\n");
  }

  // ── Inject context files + capture user message + ambient recall ─
  // Loads all five artifacts, appends the user prompt to the
  // conversation buffer, and runs ambient auto-recall to surface
  // relevant graph nodes. This mirrors the full Claude Code hook.
  pi.on("before_agent_start", async (event, _ctx) => {
    await ensureGraph();
    await loadCore();

    const extraMessages: any[] = [];

    // --- Capture user message to buffer ---
    if (captureEnabled && _CONFIG && event.prompt) {
      const maxLen = 2000;
      const content =
        event.prompt.length > maxLen
          ? event.prompt.slice(0, maxLen) + "..."
          : event.prompt;
      appendToBuffer({
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        source: "pi_before_agent_start",
      });
    }

    // --- Inject context files ---
    if (!_CONFIG) {
      if (extraMessages.length > 0) {
        return { message: extraMessages[0] };
      }
      return;
    }

    // v3 path: try whisper-based injection first
    try {
      const { hasV3Data, buildV3Context } = require("../dist/graph-memory/session-start-v3.js");
      if (hasV3Data()) {
        const v3 = buildV3Context("global");
        if (!v3.sources.fallback && v3.context) {
          const v3Parts: string[] = [];
          const recallBlock = ambientRecall(event.prompt);
          if (recallBlock) v3Parts.push(recallBlock);
          v3Parts.push(v3.context);
          if (v3Parts.length > 0) {
            return {
              message: {
                customType: "graph-memory-context",
                content: v3Parts.join("\n\n"),
                display: false,
              },
            };
          }
        }
      }
    } catch { /* v3 not available, fall through to v2 */ }

    const artifacts: Array<{ filePath: string; label: string }> = [
      { filePath: _CONFIG.paths.priors, label: "PRIORS (behavioral guidelines)" },
      { filePath: _CONFIG.paths.soma, label: "SOMA (emotional calibration)" },
      { filePath: _CONFIG.paths.map, label: "MAP (compressed index)" },
      { filePath: _CONFIG.paths.working, label: "WORKING (volatile memory)" },
      { filePath: _CONFIG.paths.dreamsContext, label: "DREAMS (pending fragments)" },
    ];

    const parts: string[] = [];
    for (const { filePath, label } of artifacts) {
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8").trim();
          if (content) {
            parts.push(`<!-- Graph Memory ${label} -->\n${content}`);
          }
        }
      } catch { /* skip unavailable files */ }
    }

    // --- Ambient auto-recall ---
    const recallBlock = ambientRecall(event.prompt);
    if (recallBlock) {
      parts.unshift(recallBlock);
    }

    // --- Inject skillforge skill files ---
    if (_listManifests && _CONFIG) {
      try {
        const manifests = _listManifests();
        for (const m of manifests) {
          if (!m.project_root || !m.files) continue;
          for (const filePath of Object.values(m.files) as string[]) {
            const full = path.join(m.project_root, filePath);
            if (fs.existsSync(full)) {
              const skillContent = fs.readFileSync(full, "utf-8").trim();
              if (skillContent) {
                parts.push(`<!-- Skill: ${m.skill_name} -->\n${skillContent}`);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (parts.length === 0) return;

    return {
      message: {
        customType: "graph-memory-context",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });

  // ── Register pi commands ────────────────────────────────────────
  // Mirrors the Claude Code slash commands. Pi registers these as
  // extension commands visible in the slash-command menu.

  pi.registerCommand("recall", {
    description: "Deep search memory graph with edge traversal and full node reading",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /recall <search query>", "info");
        return;
      }
      await ensureGraph();
      await loadCore();
      const result = await _handleGraphMemory({
        action: "recall",
        query: args,
        depth: 2,
      });
      if (result.isError) {
        ctx.ui.notify(result.content[0]?.text || "Recall failed", "error");
        return;
      }
      // Just show the result via notification — the LLM can also call it as a tool
      ctx.ui.notify(
        `Recall for "${args}" complete. Results in graph memory.`,
        "success"
      );
    },
  });

  pi.registerCommand("memory-status", {
    description: "Check memory system health — node count, warnings, pending operations",
    handler: async (_args, ctx) => {
      await ensureGraph();
      await loadCore();
      const result = await _handleGraphMemory({ action: "status" });
      if (result.isError) {
        ctx.ui.notify(result.content[0]?.text || "Status check failed", "error");
        return;
      }
      ctx.ui.notify(
        result.content[0]?.text?.slice(0, 300) || "Status retrieved",
        "info"
      );
    },
  });

  pi.registerCommand("refresh-skill", {
    description: "Refresh a skillforged skill from its source node",
    handler: async (args, ctx) => {
      await ensureGraph();
      await loadCore();
      if (!_listManifests || !_enqueueJob) {
        ctx.ui.notify("Graph memory not fully loaded", "error");
        return;
      }

      const manifests = _listManifests();
      if (manifests.length === 0) {
        ctx.ui.notify("No skillforged skills found. Skills are auto-generated when nodes cross the scoring threshold.", "info");
        return;
      }

      const target = (args || "").trim();
      if (!target) {
        const lines = manifests.map((m: any) =>
          `- ${m.skill_name} (${m.source_node}, project: ${m.project}, refreshed: ${m.last_refreshed_at || "never"})`
        );
        ctx.ui.notify(`Available skills:\n${lines.join("\n")}\n\nUsage: /refresh-skill <skill-name>`, "info");
        return;
      }

      const match = manifests.find((m: any) => m.skill_name === target || m.source_node === target);
      if (!match) {
        ctx.ui.notify(`No skill found for "${target}". Use /refresh-skill without args to list available skills.`, "error");
        return;
      }

      const sanitizedPath = match.source_node.replace(/\//g, "-");
      const { job, created } = _enqueueJob({
        type: "skillforge_refresh",
        payload: {
          manifestPath: path.join(_CONFIG.paths.skillforgeManifests, `${sanitizedPath}.json`),
          nodePath: match.source_node,
          skillName: match.skill_name,
          project: match.project,
          reason: "manual refresh via /refresh-skill",
        },
        triggerSource: "pi:refresh-skill",
        idempotencyKey: `skillforge-refresh:${match.source_node}:manual:${Date.now()}`,
      });

      ctx.ui.notify(
        created
          ? `Refresh job queued: ${job.id}`
          : `Job already exists: ${job.id}`,
        created ? "success" : "info"
      );
    },
  });

  // ── Capture assistant response + rotate at threshold ────────────
  pi.on("agent_end", async (event) => {
    if (!captureEnabled || !_CONFIG) return;
    await loadCore();

    // Pull the final assistant message from the turn's messages
    const assistantMsg = [...(event.messages ?? [])]
      .reverse()
      .find((m: any) => m.role === "assistant");

    if (assistantMsg) {
      const text =
        typeof assistantMsg.content === "string"
          ? assistantMsg.content
          : Array.isArray(assistantMsg.content)
            ? assistantMsg.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n")
            : JSON.stringify(assistantMsg.content);

      const maxLen = 2000;
      const truncated = text.length > maxLen ? text.slice(0, maxLen) + "..." : text;

      appendToBuffer({
        role: "assistant",
        content: truncated,
        timestamp: new Date().toISOString(),
        source: "pi_agent_end",
        final: true,
      });

      // Rotate buffer at scribe threshold
      const interval = _CONFIG.session?.scribeInterval ?? 10;
      if (messageCount >= interval) {
        rotateAndQueue();
      }
    }
  });
}