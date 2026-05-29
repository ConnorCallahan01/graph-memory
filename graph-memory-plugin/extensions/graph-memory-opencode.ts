/**
 * OpenCode plugin for graph-memory.
 *
 * Registers the `graph_memory` tool that gives OpenCode agents access to the
 * persistent knowledge graph. Injects context at session start when the graph
 * is initialized. Captures conversation (user + assistant messages) to the
 * buffer, rotating snapshots to feed the scribe pipeline.
 *
 * Usage (after cloning the repo and running ./bin/install-opencode.sh):
 *   The plugin is copied into ~/.config/opencode/plugins/ and loaded
 *   automatically by OpenCode at startup.
 *
 * NOTE: This file must not use static bare-specifier imports from
 * "@opencode-ai/plugin" because OpenCode may load it via a symlink whose
 * real path cannot resolve that package.  Instead we use type-only imports
 * for types and the inline `tool` helper below.
 */
import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

function tool<T extends Parameters<typeof z.object>[0]>(input: {
  description: string;
  args: T;
  execute: (args: z.infer<z.ZodObject<T>>, context: { directory: string; worktree: string }) => Promise<string>;
}) {
  return input;
}
(tool as any).schema = z;

let _handleGraphMemory: any;
let _initializeGraph: any;
let _CONFIG: any;
let _isGraphInitialized: any;
let _enqueueJob: any;
let _somaBoost: any;
let _updateLastAccessed: any;
let _detectProject: any;
let _writeActiveProject: any;
let _removeActiveProject: any;
let _ambientRecall: any;
let _hasMentalModelData: any;
let _buildMentalModelContext: any;
let _appendToolTrace: any;

function resolveDistDir(): string {
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
  return candidates.find((d) => fs.existsSync(path.join(d, "tools.js"))) || candidates[0];
}

async function importToolTrace() {
  if (_appendToolTrace) return { appendToolTrace: _appendToolTrace };
  try {
    const distDir = resolveDistDir();
    const mod = await import(path.join(distDir, "session-trace.js"));
    _appendToolTrace = mod.appendToolTrace;
    return { appendToolTrace: _appendToolTrace };
  } catch {
    return { appendToolTrace: null };
  }
}

async function loadCore() {
  if (_handleGraphMemory) return;
  const distDir = resolveDistDir();
  const tools = await import(path.join(distDir, "tools.js"));
  const index = await import(path.join(distDir, "index.js"));
  const config = await import(path.join(distDir, "config.js"));
  const jobQueue = await import(path.join(distDir, "pipeline", "job-queue.js"));
  const scoring = await import(path.join(distDir, "scoring.js"));
  const soma = await import(path.join(distDir, "soma.js"));
  const project = await import(path.join(distDir, "project.js"));
  const sessionStartV3 = await import(path.join(distDir, "session-start-context.js"));
  _handleGraphMemory = tools.handleGraphMemory;
  _initializeGraph = index.initializeGraph;
  _CONFIG = config.CONFIG;
  _isGraphInitialized = config.isGraphInitialized;
  _enqueueJob = jobQueue.enqueueJob;
  _somaBoost = soma.somaBoost;
  _ambientRecall = scoring.ambientRecall;
  _updateLastAccessed = tools.updateLastAccessed;
  _detectProject = project.detectProject;
  _writeActiveProject = project.writeActiveProject;
  _removeActiveProject = project.removeActiveProject;
  _hasMentalModelData = sessionStartV3.hasV3Data;
  _buildMentalModelContext = sessionStartV3.buildV3Context;
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

  function getBufferDir(): string {
    return _CONFIG?.paths?.buffer || path.join(process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME || "/tmp", ".graph-memory"), ".buffer");
  }

  function sessionLogPath(): string {
    const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(getBufferDir(), `conversation-${safeId}.jsonl`);
  }

  function appendToBuffer(entry: Record<string, unknown>) {
    if (!captureEnabled) return;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (content && isMemoryInjectionText(content)) return;
    const dir = getBufferDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    const currentProject = detectCurrentProject();
    const result = _ambientRecall(userMessage, _CONFIG.paths.index, currentProject, _somaBoost);
    if (!result.context) return null;

    if (_updateLastAccessed && captureSessionId && result.suggestedPaths) {
      for (const p of result.suggestedPaths) {
        try { _updateLastAccessed(p, { actionType: "recall", sessionId: captureSessionId }); } catch {}
      }
    }

    return result.context;
  }

  function cleanupStaleBufferFiles(): void {
    if (!_CONFIG) return;
    const bufferDir = _CONFIG.paths.buffer;
    if (!bufferDir || !fs.existsSync(bufferDir)) return;

    const now = Date.now();
    const snapshotMaxAge = 4 * 60 * 60 * 1000;
    const conversationMaxAge = 2 * 60 * 60 * 1000;
    let cleanedSnapshots = 0;
    let cleanedConversations = 0;

    for (const file of fs.readdirSync(bufferDir)) {
      const filePath = path.join(bufferDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (file.startsWith("snapshot_") && file.endsWith(".jsonl")) {
          if (now - stat.mtimeMs > snapshotMaxAge) {
            fs.unlinkSync(filePath);
            cleanedSnapshots++;
          }
        } else if (file.startsWith("conversation-") && file.endsWith(".jsonl")) {
          if (stat.size === 0 && now - stat.mtimeMs > conversationMaxAge) {
            fs.unlinkSync(filePath);
            cleanedConversations++;
          }
        }
      } catch {}
    }

    if (cleanedSnapshots + cleanedConversations > 0) {
      try {
        const logPath = path.join(process.env.HOME || "/tmp", ".graph-memory", ".pipeline-logs", "buffer-cleanup.log");
        const logDir = path.dirname(logPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify({
          ts: new Date().toISOString(),
          cleanedSnapshots,
          cleanedConversations,
        }) + "\n");
      } catch {}
    }
  }

  // ── Build context injection block ─────────────────────────────────
  function hasMentalModelData(): boolean {
    if (!_CONFIG || !_hasMentalModelData) return false;
    return _hasMentalModelData();
  }

  function buildMentalModelContext(): { context: string; tokensUsed: number; sources: { globalWhisper: boolean; projectWhisper: boolean; sessionLog: boolean; fallback: boolean } } {
    try {
      const currentProject = detectCurrentProject();
      const result = _buildMentalModelContext(currentProject || "global");
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

  function buildProjectMAPInline(projectName?: string): string | null {
    try {
      const indexPath = _CONFIG.paths.index;
      if (!fs.existsSync(indexPath)) return null;
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      if (!Array.isArray(index)) return null;

      const categories = new Map<string, Array<{ path: string; line: string; confidence: number; projectRelevant: boolean }>>();

      for (const entry of index) {
        if (!entry.gist) continue;
        const cat = (entry.path || "").split("/")[0] || "uncategorized";
        const isProjectNode = !entry.project || entry.project === projectName;
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push({
          path: entry.path,
          line: `- **${entry.path}**${entry.pinned ? " [pinned]" : ""} — ${entry.gist}`,
          confidence: entry.confidence || 0.5,
          projectRelevant: isProjectNode,
        });
      }

      const output: string[] = [
        "# MAP — Knowledge Graph Index",
        "",
        `> Project: ${projectName || "global"}. Shows project-relevant + global nodes. Use recall for details.`,
        "",
      ];

      const sortedCats = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b));
      const maxBudget = 5000;
      let tokensUsed = Math.ceil(output.join("\n").length / 4);

      for (const [cat, entries] of sortedCats) {
        const projectEntries = entries.filter(e => e.projectRelevant);
        const otherEntries = entries.filter(e => !e.projectRelevant);

        const selected = [
          ...projectEntries.sort((a, b) => b.confidence - a.confidence).slice(0, 8),
          ...otherEntries.sort((a, b) => b.confidence - a.confidence).slice(0, 2),
        ];

        if (selected.length === 0) continue;

        const catBlock: string[] = [`## ${cat}`, ""];
        for (const e of selected) catBlock.push(e.line);
        const skipped = entries.length - selected.length;
        if (skipped > 0) catBlock.push(`  ... and ${skipped} more (use recall to explore)`);
        catBlock.push("");

        const catTokens = Math.ceil(catBlock.join("\n").length / 4);
        if (tokensUsed + catTokens > maxBudget) break;

        output.push(...catBlock);
        tokensUsed += catTokens;
      }

      return output.join("\n");
    } catch {
      return null;
    }
  }

  function renderModelFallback(model: Record<string, unknown>): string | null {
    const lines: string[] = [];
    if (model.cognitiveStyle && typeof model.cognitiveStyle === "string") {
      lines.push("STYLE:", model.cognitiveStyle as string, "");
    }
    const guardrails = model.guardrails;
    if (Array.isArray(guardrails) && guardrails.length > 0) {
      lines.push("GUARDRAILS:");
      for (const g of guardrails) lines.push("- " + g);
      lines.push("");
    }
    const preferences = model.preferences;
    if (Array.isArray(preferences) && preferences.length > 0) {
      lines.push("PREFERENCES:");
      for (const p of preferences) lines.push("- " + p);
      lines.push("");
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  function loadPinnedNodes(projectName?: string): Array<{ title: string; content: string }> {
    const results: Array<{ title: string; content: string }> = [];
    try {
      const indexPath = _CONFIG.paths.index;
      if (!fs.existsSync(indexPath)) return results;
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      for (const entry of index) {
        if (!entry?.pinned) continue;
        if (entry.project && projectName && entry.project !== projectName) continue;
        const nodePath = path.join(_CONFIG.paths.nodes, `${entry.path}.md`);
        if (!fs.existsSync(nodePath)) continue;
        const raw = fs.readFileSync(nodePath, "utf-8");
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch) continue;
        const frontmatter = fmMatch[1];
        const content = fmMatch[2].trim();
        const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        const title = titleMatch ? titleMatch[1] : entry.path;
        results.push({ title, content });
      }
    } catch { /* non-critical */ }
    return results;
  }

  function loadProjectWorking(projectName?: string): string | null {
    try {
      const workingDir = _CONFIG.paths.workingProjects;
      const slug = (projectName || "global").replace(/[^a-zA-Z0-9._-]+/g, "__");
      const workingPath = projectName && projectName !== "global"
        ? path.join(workingDir, `${slug}.md`)
        : _CONFIG.paths.workingGlobal;
      if (!fs.existsSync(workingPath)) return null;
      const content = fs.readFileSync(workingPath, "utf-8").trim();
      if (!content || content.includes("No recent activity") || content.includes("No session handoff captured yet")) return null;
      return content;
    } catch { return null; }
  }

  async function buildContextBlock(userMessage?: string): Promise<string | null> {
    await ensureGraph();
    if (!_CONFIG) return null;

    const parts: string[] = [];

    if (userMessage) {
      const recallBlock = ambientRecall(userMessage);
      if (recallBlock) parts.push(recallBlock);
    }

    const currentProject = detectCurrentProject();

    // ── Layer 1: Global user knowledge (always inject) ──
    let whisperInjected = false;

    if (hasMentalModelData()) {
      const mentalModel = buildMentalModelContext();
      if (!mentalModel.sources.fallback && mentalModel.context) {
        parts.push(mentalModel.context);
        whisperInjected = true;
      }
    }

    if (!whisperInjected) {
      try {
        const whisperPath = path.join(_CONFIG.paths.graphRoot, "mind", "whisper.txt");
        if (fs.existsSync(whisperPath)) {
          const wc = fs.readFileSync(whisperPath, "utf-8").trim();
          if (wc) { parts.push(wc); whisperInjected = true; }
        }
      } catch { /* skip */ }
    }

    if (!whisperInjected) {
      try {
        const modelPath = path.join(_CONFIG.paths.graphRoot, "mind", "model.json");
        if (fs.existsSync(modelPath)) {
          const modelData = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
          const model = modelData.model || modelData;
          const modelBlock = renderModelFallback(model);
          if (modelBlock) parts.push(modelBlock);
        }
      } catch { /* skip */ }
    }

    // ── Layer 2: Project lens whisper (if not already in mental model context) ──
    if (currentProject && currentProject !== "global" && !whisperInjected) {
      try {
        const slug = currentProject.replace(/[^a-zA-Z0-9._-]+/g, "__");
        const lensesDir = _CONFIG.paths.lenses || path.join(_CONFIG.paths.graphRoot, "lenses");
        const projectWhisperPath = path.join(lensesDir, slug, "whisper.txt");
        if (fs.existsSync(projectWhisperPath)) {
          const pw = fs.readFileSync(projectWhisperPath, "utf-8").trim();
          if (pw) parts.push(pw);
        }
      } catch { /* skip */ }
    }

    // ── Layer 3: Per-project MAP ──
    const projectMAP = buildProjectMAPInline(currentProject);
    if (projectMAP) parts.push(projectMAP);

    // ── Layer 4: DREAMS (speculative fragments) ──
    try {
      if (fs.existsSync(_CONFIG.paths.dreamsContext)) {
        const dreams = fs.readFileSync(_CONFIG.paths.dreamsContext, "utf-8").trim();
        if (dreams && !dreams.includes("No pending dreams")) parts.push(dreams);
      }
    } catch { /* skip */ }

    // ── Layer 5: Session handoff ──
    const workingContent = loadProjectWorking(currentProject);
    if (workingContent) parts.push(workingContent);

    // ── Layer 6: Pinned procedures (project-scoped) ──
    const pinned = loadPinnedNodes(currentProject);
    if (pinned.length > 0) {
      const sections = pinned.map(p => `### ${p.title}\n\n${p.content}`);
      parts.push(`# PINNED — Durable Procedural Memory\n\n> Auto-loaded pinned nodes for this project. Follow these procedures exactly.\n\n${sections.join("\n\n---\n\n")}`);
    }

    if (parts.length === 0) return null;

    try {
      const diagPath = path.join(process.env.HOME || "/tmp", ".graph-memory", ".injection-diagnostic.jsonl");
      const diagDir = path.dirname(diagPath);
      if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true });
      const layerSizes = parts.map(p => Math.ceil(p.length / 4));
      fs.appendFileSync(diagPath, JSON.stringify({
        ts: new Date().toISOString(),
        project: currentProject,
        layers: parts.length,
        layerTokens: layerSizes,
        totalTokens: layerSizes.reduce((a, b) => a + b, 0),
        hasMentalModel: hasMentalModelData(),
        whisperInjected,
      }) + "\n");
    } catch { /* non-critical */ }

    return parts.join("\n\n---\n\n");
  }

  let activeSessionId: string | null = null;
  let lastProcessedMessageCount: Record<string, number> = {};
  const processedMessageUpdateIds = new Set<string>();
  let cachedSessionContext: string | null = null;
  let pendingAmbientRecall: string | null = null;
  const ambientRecallInjectedForMessageIds = new Set<string>();

  function isMemoryInjectionText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith("<graph-memory-context>")
      || trimmed.startsWith("<graph-memory-session-context>")
      || trimmed.includes("Relevant memory nodes for this message:")
      || trimmed.includes("<!-- Graph Memory ");
  }

  function bootstrapCapture(sessionId?: string) {
    if (captureEnabled) return;
    if (sessionId) activeSessionId = sessionId;
    captureEnabled = true;
    messageCount = 0;
    captureSessionId = `opencode_session_${Date.now()}`;
    try {
      const dir = getBufferDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeId = captureSessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const logPath = path.join(dir, `conversation-${safeId}.jsonl`);
      fs.writeFileSync(logPath, "");
    } catch {}
    ensureGraph().then(() => loadCore()).catch(() => {});
  }

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
          action: z.string().describe(
            "The action to perform: read_node, search, recall, list_edges, read_dream, write_note, remember, resurface, status, history, revert, consolidate, initialize, configure_runtime"
          ),
          path: z.string().optional().describe(
            "Node path for read_node/list_edges/remember, dream path for read_dream, commit hash for revert"
          ),
          query: z.string().optional().describe("Search query for search/recall actions"),
          note: z.string().optional().describe("Note content for write_note action"),
          gist: z.string().optional().describe("One-sentence summary for remember action"),
          content: z.string().optional().describe("Full content for remember action"),
          title: z.string().optional().describe("Human-readable title for remember action"),
          tags: z.array(z.string()).optional().describe("Tags for remember action"),
          confidence: z.number().min(0).max(1).optional().describe("Confidence (0-1) for remember action"),
          edges: z.array(
            z.object({
              target: z.string(),
              type: z.string(),
              weight: z.number().optional(),
            })
          ).optional().describe("Edge connections for remember action"),
          soma: z.object({
            valence: z.string(),
            intensity: z.number(),
            marker: z.string(),
          }).optional().describe("Somatic marker for remember action"),
          depth: z.number().min(0).max(3).optional().describe("Edge traversal depth for recall action (default 1, max 3)"),
          graphRoot: z.string().optional().describe("Storage path for initialize action (defaults to ~/.graph-memory/)"),
          project: z.string().optional().describe("Project scope for remember action"),
          pinned: z.boolean().optional().describe("Pin node to prevent decay"),
          runtimeMode: z.string().optional().describe("Runtime mode for configure_runtime: manual | docker"),
          containerName: z.string().optional().describe("Docker container name override for configure_runtime"),
          imageName: z.string().optional().describe("Docker image override for configure_runtime"),
          authVolume: z.string().optional().describe("Docker auth volume name for configure_runtime"),
          graphRootInContainer: z.string().optional().describe("Container graph root mount path for configure_runtime"),
          authPathInContainer: z.string().optional().describe("Container auth mount path for configure_runtime"),
          memoryLimit: z.string().optional().describe("Container memory limit for configure_runtime"),
          cpuLimit: z.string().optional().describe("Container CPU limit for configure_runtime"),
          workerProvider: z.enum(["codex", "claude", "pi", "opencode"]).optional().describe("Worker harness for configure_runtime"),
          workerModel: z.string().optional().describe("Model override for pipeline workers (e.g. 'sonnet', 'o3', 'gpt-4.1')"),
        },

        async execute(args, context) {
          await ensureGraph();
          if (!graphReady) {
            return "Graph memory is not initialized. Run graph_memory with action='initialize' first, or set GRAPH_MEMORY_ROOT env var.";
          }
          if (activeSessionId) {
            args.sessionId = activeSessionId;
          }
          const result = await _handleGraphMemory(args);
          if (typeof result === "string") return result;
          if (result?.content?.[0]?.text) return result.content[0].text;
          return JSON.stringify(result);
        },
      }),
    },

    // ── Session lifecycle ──────────────────────────────────────────
    event: async ({ event }) => {
      const type = event.type;

      const isPipelineChild = !!(process.env.GRAPH_MEMORY_PIPELINE_CHILD || process.env.GRAPH_MEMORY_WORKER || process.env.GRAPH_MEMORY_DAEMON);

      try {

      if (isPipelineChild && type !== "message.updated") return;

      if (type === "session.created" && !isPipelineChild) {
        const sessionId = (event.properties as any)?.info?.id;
        if (sessionId) {
          activeSessionId = sessionId;
        }

        captureEnabled = true;
        messageCount = 0;
        captureSessionId = `opencode_session_${Date.now()}`;

        cleanupStaleBufferFiles();

        const bufferDir = path.join(process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME || "/tmp", ".graph-memory"), ".buffer");
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

        await ensureGraph();
        await loadCore();

        if (_writeActiveProject && worktree && _detectProject) {
          const proj = _detectProject(worktree);
          if (proj) {
            _writeActiveProject(captureSessionId, {
              name: proj.name,
              gitRoot: proj.gitRoot,
              cwd: worktree,
            });
          }
        }

        if (_CONFIG && messageCount > 0) {
          rotateAndQueue();
        }

        const contextBlock = await buildContextBlock();
        if (contextBlock) {
          cachedSessionContext = contextBlock;
        }
      }

      // ── session.idle: capture messages from completed turn, rotate if threshold ──
      if (type === "session.idle" && !isPipelineChild) {
        try {
          const debugPath = path.join(process.env.HOME || "/tmp", ".graph-memory", ".idle-debug.jsonl");
          fs.appendFileSync(debugPath, JSON.stringify({
            ts: new Date().toISOString(),
            type,
            props: Object.keys(event.properties || {}),
            sessionID: (event.properties as any)?.sessionID,
            infoId: (event.properties as any)?.info?.id,
            captureEnabled,
            captureSessionId,
          }) + "\n");
        } catch {}

        if (!captureEnabled) {
          const idleSid = (event.properties as any)?.sessionID || (event.properties as any)?.info?.id || activeSessionId;
          if (idleSid) bootstrapCapture(idleSid);
        }
        if (!captureEnabled) return;

        const sessionId = (event.properties as any)?.sessionID || (event.properties as any)?.info?.id || activeSessionId;
        if (sessionId) {
          try {
            const messages = await client.session.messages({
              path: { id: sessionId },
            });

            const processedKey = sessionId;
            const prevCount = lastProcessedMessageCount[processedKey] || 0;
            const currentMessages = messages || [];

            try {
              const debugPath = path.join(process.env.HOME || "/tmp", ".graph-memory", ".idle-debug.jsonl");
              fs.appendFileSync(debugPath, JSON.stringify({
                ts: new Date().toISOString(),
                sessionId,
                prevCount,
                msgCount: currentMessages.length,
                sample: currentMessages.slice(0,2).map((m: any) => ({ info: m.info ? { role: (m.info as any).role } : null, partsCount: (m.parts||[]).length })),
              }) + "\n");
          } catch (e) {
            fs.appendFileSync(path.join(process.env.HOME || "/tmp", ".graph-memory", ".capture-debug.jsonl"),
              JSON.stringify({ ts: new Date().toISOString(), step: "capture_error", err: String(e) }) + "\n");
          }

            if (currentMessages.length <= prevCount) return;
            lastProcessedMessageCount[processedKey] = currentMessages.length;

            const newMessages = currentMessages.slice(prevCount);
            for (const msg of newMessages) {
              const info = msg.info;
              if (!info) continue;

              const role = (info as any).role;
              const parts = msg.parts || [];
              const textParts = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

              if (!textParts) continue;
              const maxLen = 2000;
              const truncated = textParts.length > maxLen
                ? textParts.slice(0, maxLen) + "..."
                : textParts;

              const currentProject = detectCurrentProject();
              appendToBuffer({
                role,
                content: truncated,
                timestamp: new Date().toISOString(),
                source: "opencode_session_idle",
                ...(role === "assistant" ? { final: true } : {}),
                ...(currentProject ? { project: currentProject } : {}),
              });
            }

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
      }

      // ── message.updated: ambient recall injection for user messages ──
      if (type === "message.updated" && !isPipelineChild) {
        const info = (event.properties as any)?.info;
        const eventSessionId = (event.properties as any)?.sessionID;
        if (!info) return;
        const msgId = typeof info.id === "string" ? info.id : "";

        if (!captureEnabled) {
          bootstrapCapture(eventSessionId);
          activeSessionId = eventSessionId;
        }

        if (info.role === "user" || info.role === "assistant") {
          try {
            const sid = eventSessionId || activeSessionId;
            const res = await client.session.messages({ path: { id: sid } });
            const messages = res?.data || res;
            const target = messages?.find((m: any) => m.info?.id === msgId);
            if (target) {
              const textParts = (target.parts || [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

              const processedKey = `${sid || "unknown"}:${msgId || `${info.role}:${textParts}`}`;
              const maxLen = 2000;
              const truncated = textParts.length > maxLen
                ? textParts.slice(0, maxLen) + "..."
                : textParts;

              if (textParts && !isMemoryInjectionText(textParts) && !processedMessageUpdateIds.has(processedKey)) {
                processedMessageUpdateIds.add(processedKey);
                const currentProject = detectCurrentProject();
                appendToBuffer({
                  role: info.role,
                  content: truncated,
                  timestamp: new Date().toISOString(),
                  source: "opencode_message_updated",
                  ...(info.role === "assistant" ? { final: true } : {}),
                  ...(currentProject ? { project: currentProject } : {}),
                });

                if (_CONFIG && messageCount >= (_CONFIG.session?.scribeInterval ?? 10)) {
                  rotateAndQueue();
                }
              }
            }
          } catch {}
        }

        if (info.role === "user") {
          await ensureGraph();
          if (!_CONFIG) return;
          if (activeSessionId) {
            try {
              const recallKey = `${activeSessionId}:${msgId || "unknown"}`;
              if (ambientRecallInjectedForMessageIds.has(recallKey)) return;
              const res = await client.session.messages({
                path: { id: activeSessionId },
              });
              const messages = res?.data || res;
              const last = messages?.[messages.length - 1];
              if (last?.info?.role === "user") {
                const textParts = (last.parts || [])
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n");

                if (textParts && !isMemoryInjectionText(textParts)) {
                  const recallBlock = ambientRecall(textParts);
                  if (recallBlock) {
                    ambientRecallInjectedForMessageIds.add(recallKey);
                    pendingAmbientRecall = recallBlock;
                  }
                }
              }
            } catch {}
          }
        }
      }

      // ── session.deleted: final flush + cleanup ──
      if (type === "session.deleted" && !isPipelineChild) {
        const sessionId = (event.properties as any)?.sessionID;
        if (sessionId) {
          delete lastProcessedMessageCount[sessionId];
        }
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
          } catch {}
        }
        captureEnabled = false;
        messageCount = 0;
        if (_removeActiveProject && captureSessionId) {
          try { _removeActiveProject(captureSessionId); } catch {}
        }
        captureSessionId = "";
        activeSessionId = null;
      }

      } catch (e) {
        try {
          fs.appendFileSync(path.join(process.env.HOME || "/tmp", ".graph-memory", ".events-debug.jsonl"),
            JSON.stringify({ ts: new Date().toISOString(), type, error: String(e) }) + "\n");
        } catch {}
      }
    },

    // ── Tool execution tracing ─────────────────────────────────────
    "tool.execute.before": async (input, output) => {
      const isPipelineChild = !!(process.env.GRAPH_MEMORY_PIPELINE_CHILD || process.env.GRAPH_MEMORY_WORKER || process.env.GRAPH_MEMORY_DAEMON);
      if (!captureSessionId && !isPipelineChild) bootstrapCapture(input.sessionID);
      if (!captureSessionId) return;
      try {
        await loadCore();
        if (!_CONFIG) return;
        const { appendToolTrace } = await importToolTrace();
        if (appendToolTrace) {
          appendToolTrace(captureSessionId, "pre", {
            tool_name: input.tool,
            tool_input: output.args,
            session_id: input.sessionID || captureSessionId,
          }, { project: detectCurrentProject(), cwd: worktree });
        }
      } catch {}
    },

    "tool.execute.after": async (input, output) => {
      if (!captureSessionId) return;
      try {
        await loadCore();
        if (!_CONFIG) return;
        const { appendToolTrace } = await importToolTrace();
        if (appendToolTrace) {
          appendToolTrace(captureSessionId, "post", {
            tool_name: input.tool,
            tool_response: output,
            session_id: input.sessionID || captureSessionId,
          }, { project: detectCurrentProject(), cwd: worktree });
        }
      } catch {}
    },

    "experimental.chat.system.transform": async (input, output) => {
      const parts: string[] = [];

      if (cachedSessionContext) {
        parts.push(cachedSessionContext);
      }

      if (pendingAmbientRecall) {
        parts.push(pendingAmbientRecall);
        pendingAmbientRecall = null;
      }

      if (parts.length > 0) {
        output.system.push(parts.join("\n\n---\n\n"));
      }
    },
  };
};

export default GraphMemoryPlugin;
