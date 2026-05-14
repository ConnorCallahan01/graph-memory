/**
 * OpenCode plugin for graph-memory.
 *
 * Registers the `graph_memory` tool that gives OpenCode agents access to the
 * persistent knowledge graph. Injects all five context files (MAP, PRIORS,
 * SOMA, WORKING, DREAMS) at session start when the graph is initialized.
 * Captures conversation (user + assistant messages) to the buffer, rotating
 * snapshots to feed the scribe pipeline.
 *
 * Usage (after cloning the repo and running ./bin/install-opencode.sh):
 *   The plugin is symlinked into ~/.config/opencode/plugins/ and loaded
 *   automatically by OpenCode at startup.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

let _handleGraphMemory: any;
let _initializeGraph: any;
let _CONFIG: any;
let _isGraphInitialized: any;
let _enqueueJob: any;
let _overlap: any;
let _recencyBoost: any;
let _somaBoost: any;
let _projectBoost: any;
let _updateLastAccessed: any;
let _detectProject: any;
let _writeActiveProject: any;
let _removeActiveProject: any;

async function loadCore() {
  if (_handleGraphMemory) return;
  const rawDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  let realDir = rawDir;
  try {
    const rawFile = new URL(import.meta.url).pathname;
    realDir = path.dirname(fs.realpathSync(rawFile));
  } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const candidates = [
    path.resolve(realDir, "..", "dist", "graph-memory"),
    path.resolve(rawDir, "..", "dist", "graph-memory"),
    path.join(home, "Desktop", "agent_memory", "graph-memory-plugin", "dist", "graph-memory"),
  ];
  const distDir = candidates.find((d) => fs.existsSync(path.join(d, "tools.js"))) || candidates[0];
  const tools = await import(path.join(distDir, "tools.js"));
  const index = await import(path.join(distDir, "index.js"));
  const config = await import(path.join(distDir, "config.js"));
  const jobQueue = await import(path.join(distDir, "pipeline", "job-queue.js"));
  const scoring = await import(path.join(distDir, "scoring.js"));
  const soma = await import(path.join(distDir, "soma.js"));
  const project = await import(path.join(distDir, "project.js"));
  _handleGraphMemory = tools.handleGraphMemory;
  _initializeGraph = index.initializeGraph;
  _CONFIG = config.CONFIG;
  _isGraphInitialized = config.isGraphInitialized;
  _enqueueJob = jobQueue.enqueueJob;
  _overlap = scoring.overlap;
  _recencyBoost = scoring.recencyBoost;
  _somaBoost = soma.somaBoost;
  _projectBoost = scoring.projectBoost;
  _updateLastAccessed = tools.updateLastAccessed;
  _detectProject = project.detectProject;
  _writeActiveProject = project.writeActiveProject;
  _removeActiveProject = project.removeActiveProject;
}

export const GraphMemoryPlugin: Plugin = async ({ project, client, directory, worktree }) => {
  let graphReady = false;

  async function ensureGraph() {
    if (graphReady) return;
    await loadCore();
    if (_isGraphInitialized() || process.env.GRAPH_MEMORY_ROOT) {
      _initializeGraph();
      graphReady = true;
    }
  }

  // ── Conversation capture state ────────────────────────────────────
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
      const currentProject = detectCurrentProject();
      const jobPayload = {
        snapshotPath,
        sessionId: captureSessionId,
        ...(currentProject ? { project: currentProject } : {}),
      };
      _enqueueJob({
        type: "scribe",
        payload: jobPayload,
        triggerSource: "opencode-plugin:threshold",
        idempotencyKey: `scribe:${snapshotPath}`,
      });
      _enqueueJob({
        type: "observer",
        payload: jobPayload,
        triggerSource: "opencode-plugin:threshold",
        idempotencyKey: `observer:${snapshotPath}`,
      });
    }
  }

  // ── Ambient auto-recall helpers ──────────────────────────────────
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

  function detectCurrentProject(): string | undefined {
    if (!worktree) return undefined;
    if (_detectProject) {
      const info = _detectProject(worktree);
      if (info && info.name && info.name !== "global") return info.name;
    }
    return path.basename(worktree);
  }

  function ambientRecall(userMessage: string): string | null {
    if (!_CONFIG) return null;
    const indexPath = _CONFIG.paths.index;
    if (!fs.existsSync(indexPath)) return null;

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

    const currentProject = detectCurrentProject();
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

    if (_updateLastAccessed && captureSessionId) {
      for (const r of scored) {
        try { _updateLastAccessed(r.path, { actionType: "recall", sessionId: captureSessionId }); } catch {}
      }
    }

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

  // ── Build context injection block ─────────────────────────────────
  function hasV3DataOpencode(): boolean {
    if (!_CONFIG) return false;
    const fs = require("fs");
    const path = require("path");
    const mindDir = _CONFIG.paths.v3Mind;
    if (!fs.existsSync(mindDir)) return false;
    return fs.existsSync(path.join(mindDir, "whisper.txt"));
  }

  function buildV3ContextOpencode(): { context: string; tokensUsed: number; sources: { globalWhisper: boolean; projectWhisper: boolean; sessionLog: boolean; fallback: boolean } } {
    try {
      const { buildV3Context: buildV3 } = require("../dist/graph-memory/session-start-v3.js");
      const currentProject = detectCurrentProject();
      const result = buildV3(currentProject || "global");
      return {
        context: result.context,
        tokensUsed: result.tokensUsed,
        sources: result.sources,
      };
    } catch {
      const parts: string[] = [];
      let tokensUsed = 0;
      const sources = { globalWhisper: false, projectWhisper: false, sessionLog: false, fallback: false };
      return { context: parts.join("\n\n---\n\n"), tokensUsed, sources };
    }
  }

  async function buildContextBlock(userMessage?: string): Promise<string | null> {
    await ensureGraph();
    if (!_CONFIG) return null;

    // v3 path: try whisper-based injection
    if (hasV3DataOpencode()) {
      const v3 = buildV3ContextOpencode();
      if (!v3.sources.fallback && v3.context) {
        const parts: string[] = [];
        if (userMessage) {
          const recallBlock = ambientRecall(userMessage);
          if (recallBlock) parts.push(recallBlock);
        }
        parts.push(v3.context);
        return parts.join("\n\n");
      }
    }

    // v2 fallback
    const artifacts: Array<{ filePath: string; label: string }> = [
      { filePath: _CONFIG.paths.priors, label: "PRIORS (behavioral guidelines)" },
      { filePath: _CONFIG.paths.soma, label: "SOMA (emotional calibration)" },
      { filePath: _CONFIG.paths.map, label: "MAP (compressed index)" },
      { filePath: _CONFIG.paths.working, label: "WORKING (volatile memory)" },
      { filePath: _CONFIG.paths.dreamsContext, label: "DREAMS (pending fragments)" },
    ];

    const parts: string[] = [];

    if (userMessage) {
      const recallBlock = ambientRecall(userMessage);
      if (recallBlock) {
        parts.push(recallBlock);
      }
    }

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

    if (parts.length === 0) return null;
    return parts.join("\n\n");
  }

  // ── Track active session ID for context injection ─────────────────
  let activeSessionId: string | null = null;
  let lastProcessedMessageCount: Record<string, number> = {};

  try {
    const markerDir = path.join(process.env.HOME || "/tmp", ".graph-memory");
    if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, ".plugin-loaded"), `${new Date().toISOString()} project=${project?.id || "unknown"} worktree=${worktree || "none"}\n`);
  } catch { /* ignore */ }

  return {
    // ── Register the graph_memory tool ─────────────────────────────
    tool: {
      graph_memory: tool({
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

        args: {
          action: tool.schema.string().describe(
            "The action to perform: read_node, search, recall, list_edges, read_dream, write_note, remember, resurface, status, history, revert, consolidate, initialize, configure_runtime"
          ),
          path: tool.schema.string().optional().describe(
            "Node path for read_node/list_edges/remember, dream path for read_dream, commit hash for revert"
          ),
          query: tool.schema.string().optional().describe("Search query for search/recall actions"),
          note: tool.schema.string().optional().describe("Note content for write_note action"),
          gist: tool.schema.string().optional().describe("One-sentence summary for remember action"),
          content: tool.schema.string().optional().describe("Full content for remember action"),
          title: tool.schema.string().optional().describe("Human-readable title for remember action"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Tags for remember action"),
          confidence: tool.schema.number().min(0).max(1).optional().describe("Confidence (0-1) for remember action"),
          edges: tool.schema.array(
            tool.schema.object({
              target: tool.schema.string(),
              type: tool.schema.string(),
              weight: tool.schema.number().optional(),
            })
          ).optional().describe("Edge connections for remember action"),
          soma: tool.schema.object({
            valence: tool.schema.string(),
            intensity: tool.schema.number(),
            marker: tool.schema.string(),
          }).optional().describe("Somatic marker for remember action"),
          depth: tool.schema.number().min(0).max(3).optional().describe("Edge traversal depth for recall action (default 1, max 3)"),
          graphRoot: tool.schema.string().optional().describe("Storage path for initialize action (defaults to ~/.graph-memory/)"),
          project: tool.schema.string().optional().describe("Project scope for remember action"),
          pinned: tool.schema.boolean().optional().describe("Pin node to prevent decay"),
          runtimeMode: tool.schema.string().optional().describe("Runtime mode for configure_runtime: manual | docker"),
          containerName: tool.schema.string().optional().describe("Docker container name override for configure_runtime"),
          imageName: tool.schema.string().optional().describe("Docker image override for configure_runtime"),
          authVolume: tool.schema.string().optional().describe("Docker auth volume name for configure_runtime"),
          graphRootInContainer: tool.schema.string().optional().describe("Container graph root mount path for configure_runtime"),
          authPathInContainer: tool.schema.string().optional().describe("Container auth mount path for configure_runtime"),
          memoryLimit: tool.schema.string().optional().describe("Container memory limit for configure_runtime"),
          cpuLimit: tool.schema.string().optional().describe("Container CPU limit for configure_runtime"),
        },

        async execute(args, context) {
          await ensureGraph();
          if (!graphReady) {
            return "Graph memory is not initialized. Run graph_memory with action='initialize' first, or set GRAPH_MEMORY_ROOT env var.";
          }
          if (activeSessionId) {
            args.sessionId = activeSessionId;
          }
          return _handleGraphMemory(args);
        },
      }),
    },

    // ── Session lifecycle ──────────────────────────────────────────
    event: async ({ event }) => {
      const type = event.type;

      if (type === "session.created") {
        const sessionId = (event.properties as any)?.info?.id;
        if (sessionId) {
          activeSessionId = sessionId;
        }

        await ensureGraph();
        await loadCore();

        if (_writeActiveProject && worktree && _detectProject) {
          const proj = _detectProject(worktree);
          if (proj) {
            _writeActiveProject(captureSessionId || `opencode_session_${Date.now()}`, {
              name: proj.name,
              gitRoot: proj.gitRoot,
              cwd: worktree,
            });
          }
        }

        if (_CONFIG && messageCount > 0) {
          rotateAndQueue();
        }

        captureEnabled = true;
        messageCount = 0;
        captureSessionId = `opencode_session_${Date.now()}`;

        const bufferDir = _CONFIG?.paths?.buffer || path.join(process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME || "/tmp", ".graph-memory"), ".buffer");
        try {
          if (!fs.existsSync(bufferDir)) fs.mkdirSync(bufferDir, { recursive: true });
          const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
          const perSessionLog = path.join(bufferDir, `conversation-${safeId}.jsonl`);
          fs.writeFileSync(perSessionLog, "");
        } catch (e) {
          try {
            await client.app.log({
              body: { service: "graph-memory", level: "error", message: `session.created buffer init failed: ${e}` },
            });
          } catch { /* ignore */ }
        }

        // Inject context files into the new session
        const contextBlock = await buildContextBlock();
        if (contextBlock && activeSessionId) {
          try {
            await client.session.prompt({
              path: { id: activeSessionId },
              body: {
                noReply: true,
                parts: [{ type: "text", text: contextBlock }],
              },
            });
          } catch (e) {
            await client.app.log({
              body: {
                service: "graph-memory",
                level: "warn",
                message: `Failed to inject context: ${e}`,
              },
            });
          }
        }
      }

      // ── session.idle: capture assistant response, rotate buffer ──
      if (type === "session.idle") {
        if (!captureEnabled || !_CONFIG) return;

        const sessionId = (event.properties as any)?.sessionID;
        if (sessionId) {
          try {
            const messages = await client.session.messages({
              path: { id: sessionId },
            });

            const processedKey = sessionId;
            const prevCount = lastProcessedMessageCount[processedKey] || 0;
            const currentMessages = messages || [];

            if (currentMessages.length <= prevCount) return;
            lastProcessedMessageCount[processedKey] = currentMessages.length;

            // Find the last assistant message we haven't seen
            const newMessages = currentMessages.slice(prevCount);
            for (const msg of newMessages) {
              const info = msg.info;
              if (!info) continue;

              const role = (info as any).role;
              if (role === "assistant") {
                const parts = msg.parts || [];
                const textParts = parts
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n");

                if (textParts) {
                  const maxLen = 2000;
                  const truncated = textParts.length > maxLen
                    ? textParts.slice(0, maxLen) + "..."
                    : textParts;

                  const currentProject = detectCurrentProject();
                  appendToBuffer({
                    role: "assistant",
                    content: truncated,
                    timestamp: new Date().toISOString(),
                    source: "opencode_session_idle",
                    final: true,
                    ...(currentProject ? { project: currentProject } : {}),
                  });
                }
              } else if (role === "user") {
                const parts = msg.parts || [];
                const textParts = parts
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n");

                if (textParts) {
                  const maxLen = 2000;
                  const truncated = textParts.length > maxLen
                    ? textParts.slice(0, maxLen) + "..."
                    : textParts;

                  const currentProject = detectCurrentProject();
                  appendToBuffer({
                    role: "user",
                    content: truncated,
                    timestamp: new Date().toISOString(),
                    source: "opencode_session_idle",
                    ...(currentProject ? { project: currentProject } : {}),
                  });

                  // Ambient recall for user messages discovered at idle
                  const recallBlock = ambientRecall(truncated);
                  if (recallBlock && sessionId) {
                    try {
                      await client.session.prompt({
                        path: { id: sessionId },
                        body: {
                          noReply: true,
                          parts: [{ type: "text", text: recallBlock }],
                        },
                      });
                    } catch { /* ignore injection failures */ }
                  }
                }
              }
            }

            // Rotate buffer at scribe threshold
            const interval = _CONFIG.session?.scribeInterval ?? 10;
            if (messageCount >= interval) {
              rotateAndQueue();
            }
          } catch (e) {
            await client.app.log({
              body: {
                service: "graph-memory",
                level: "warn",
                message: `Failed to process session idle: ${e}`,
              },
            });
          }
        }

        // Final flush on idle
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
        if (_removeActiveProject && captureSessionId) {
          try { _removeActiveProject(captureSessionId); } catch {}
        }
        captureSessionId = "";
        activeSessionId = null;
        lastProcessedMessageCount = {};
      }

      // ── message.updated: detect user messages for capture + recall ──
      if (type === "message.updated") {
        if (!captureEnabled) return;
        await ensureGraph();
        if (!_CONFIG) return;

        const info = (event.properties as any)?.info;
        if (!info) return;

        if (info.role === "user" && activeSessionId) {
          try {
            const messages = await client.session.messages({
              path: { id: activeSessionId },
            });
            const last = messages?.[messages.length - 1];
            if (last?.info?.role === "user") {
              const textParts = (last.parts || [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

              if (textParts) {
                const maxLen = 2000;
                const truncated = textParts.length > maxLen
                  ? textParts.slice(0, maxLen) + "..."
                  : textParts;

                const currentProject = detectCurrentProject();
                appendToBuffer({
                  role: "user",
                  content: truncated,
                  timestamp: new Date().toISOString(),
                  source: "opencode_message_updated",
                  ...(currentProject ? { project: currentProject } : {}),
                });

                const recallBlock = ambientRecall(truncated);
                if (recallBlock) {
                  try {
                    await client.session.prompt({
                      path: { id: activeSessionId },
                      body: {
                        noReply: true,
                        parts: [{ type: "text", text: recallBlock }],
                      },
                    });
                  } catch { /* ignore */ }
                }
              }
            }
          } catch { /* ignore fetch failures */ }
        }
      }

      // ── session.deleted: cleanup ──
      if (type === "session.deleted") {
        const sessionId = (event.properties as any)?.sessionID;
        if (sessionId) {
          delete lastProcessedMessageCount[sessionId];
        }
        if (activeSessionId === sessionId) {
          if (captureEnabled && messageCount > 0) {
            rotateAndQueue();
          }
          captureEnabled = false;
          activeSessionId = null;
        }
      }
    },

    // ── Tool execution tracing ─────────────────────────────────────
    "tool.execute.before": async (input, output) => {
      // No-op for now — tool tracing can be added here later
    },

    "tool.execute.after": async (input, output) => {
      // No-op for now — tool tracing can be added here later
    },
  };
};

export default GraphMemoryPlugin;
