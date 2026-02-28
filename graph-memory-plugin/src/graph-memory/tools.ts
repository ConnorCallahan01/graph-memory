import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { z } from "zod";
import { CONFIG, isGraphInitialized, saveGlobalConfig, reloadConfig } from "./config.js";
import { initializeGraph } from "./index.js";
import { activityBus } from "./events.js";
import { safePath, countFiles as countFilesUtil } from "./utils.js";
import { listCommits, revertTo, autoCommit } from "./git.js";
import { somaBoost } from "./soma.js";
import { applyDeltas } from "./pipeline/mechanical-apply.js";
import { buildLibrarianInput } from "./pipeline/librarian.js";
import { buildDreamerInput } from "./pipeline/dreamer.js";
import { fullRegenerateMAP, rebuildIndex, validateEdgeType } from "./pipeline/graph-ops.js";
import { runDecay } from "./pipeline/decay.js";
import { updateManifest } from "./manifest.js";
import { clearConsolidationPending } from "./dirty-state.js";
import { readActiveProject } from "./project.js";

// --- Index cache ---
let indexCache: { data: any[]; mtime: number } | null = null;

function loadIndex(): any[] {
  const indexPath = CONFIG.paths.index;
  if (!fs.existsSync(indexPath)) return [];

  const stat = fs.statSync(indexPath);
  const mtime = stat.mtimeMs;

  if (indexCache && indexCache.mtime === mtime) {
    return indexCache.data;
  }

  const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  indexCache = { data, mtime };
  return data;
}

// Tool handler for graph_memory
export async function handleGraphMemory(args: {
  action: string;
  path?: string;
  query?: string;
  note?: string;
  graphRoot?: string;
  gist?: string;
  content?: string;
  title?: string;
  tags?: string[];
  confidence?: number;
  edges?: Array<{ target: string; type: string; weight?: number }>;
  soma?: { valence: string; intensity: number; marker: string };
  depth?: number;
  project?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { action } = args;

  switch (action) {
    case "read_node":
      return readNode(args.path);
    case "search":
      return searchGraph(args.query);
    case "recall":
      return recallGraph(args.query, args.depth);
    case "list_edges":
      return listEdges(args.path);
    case "read_dream":
      return readDream(args.path);
    case "write_note":
      return writeNote(args.note);
    case "remember":
      return rememberNode(args);
    case "status":
      return getStatus();
    case "history":
      return getHistory();
    case "revert":
      return revertGraph(args.path);
    case "consolidate":
      return runConsolidation();
    case "initialize":
      return initializeGraphAction(args.graphRoot);
    default:
      return {
        content: [{ type: "text", text: `Unknown action: ${action}. Available: read_node, search, recall, list_edges, read_dream, write_note, remember, status, history, revert, consolidate, initialize` }],
        isError: true,
      };
  }
}

// --- remember action ---

function rememberNode(args: {
  path?: string;
  gist?: string;
  content?: string;
  title?: string;
  tags?: string[];
  confidence?: number;
  edges?: Array<{ target: string; type: string; weight?: number }>;
  soma?: { valence: string; intensity: number; marker: string };
  project?: string;
}): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (!args.path) {
    return { content: [{ type: "text", text: "Error: path required for remember" }], isError: true };
  }
  if (!args.gist) {
    return { content: [{ type: "text", text: "Error: gist required for remember" }], isError: true };
  }

  const filePath = safePath(CONFIG.paths.nodes, args.path, ".md");
  if (!filePath) {
    return { content: [{ type: "text", text: `Invalid path: ${args.path}` }], isError: true };
  }

  const now = new Date().toISOString().slice(0, 10);

  if (fs.existsSync(filePath)) {
    // Merge into existing node
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      // Max confidence
      if (args.confidence !== undefined && args.confidence > (parsed.data.confidence || 0)) {
        parsed.data.confidence = args.confidence;
      }

      // Merge tags
      if (args.tags) {
        parsed.data.tags = [...new Set([...(parsed.data.tags || []), ...args.tags])];
      }

      // Merge edges (dedupe by target)
      if (args.edges) {
        const existingEdges = parsed.data.edges || [];
        const existingTargets = new Set(existingEdges.map((e: any) => e.target));
        for (const edge of args.edges) {
          if (!existingTargets.has(edge.target)) {
            existingEdges.push({
              target: edge.target,
              type: validateEdgeType(edge.type),
              weight: edge.weight ?? 0.5,
            });
            existingTargets.add(edge.target);
          }
        }
        parsed.data.edges = existingEdges;
      }

      // Update soma if provided
      if (args.soma) {
        parsed.data.soma = args.soma;
      }

      // Append content if different
      if (args.content && !parsed.content.includes(args.content.slice(0, 100))) {
        parsed.content = parsed.content.trimEnd() + `\n\n---\n\n${args.content}`;
      }

      // Update gist if provided (overwrite)
      if (args.gist) {
        parsed.data.gist = args.gist;
      }

      parsed.data.updated = now;
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));

      // Update index and MAP incrementally
      updateIndexEntry(args.path, parsed.data);
      fullRegenerateMAP();

      return { content: [{ type: "text", text: `Updated existing node: ${args.path}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error merging node: ${err.message}` }], isError: true };
    }
  }

  // Create new node
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fm: Record<string, any> = {
    id: args.path,
    title: args.title || args.path.split("/").pop(),
    gist: args.gist,
    confidence: args.confidence ?? 0.5,
    created: now,
    updated: now,
    decay_rate: 0.05,
    tags: args.tags || [],
    keywords: [],
  };

  // Only tag with project if explicitly provided (caller decides project-specificity)
  if (args.project) {
    fm.project = args.project;
  }

  if (args.edges && args.edges.length > 0) {
    fm.edges = args.edges.map(e => ({
      target: e.target,
      type: validateEdgeType(e.type),
      weight: e.weight ?? 0.5,
    }));
  }
  if (args.soma) {
    fm.soma = args.soma;
  }

  const title = fm.title;
  const body = `# ${title}\n\n${args.content || ""}`;
  fs.writeFileSync(filePath, matter.stringify(body, fm));

  // Update index and MAP
  updateIndexEntry(args.path, fm);
  fullRegenerateMAP();

  activityBus.log("graph:node_created", `Remember: ${args.path}`);
  return { content: [{ type: "text", text: `Created node: ${args.path}` }] };
}

function updateIndexEntry(nodePath: string, fm: any) {
  try {
    const index = loadIndex();
    const existing = index.findIndex((e: any) => e.path === nodePath);
    const entry: Record<string, any> = {
      path: nodePath,
      gist: (fm.gist || "").slice(0, 200),
      tags: fm.tags || [],
      keywords: fm.keywords || [],
      edges: (fm.edges || []).map((e: any) => e.target).filter(Boolean),
      anti_edges: (fm.anti_edges || []).map((e: any) => e.target).filter(Boolean),
      confidence: typeof fm.confidence === "number" ? fm.confidence : 0.5,
      soma_intensity: fm.soma?.intensity || 0,
      updated: fm.updated || fm.created || null,
      last_accessed: fm.last_accessed || new Date().toISOString(),
      access_count: fm.access_count || 0,
      dream_refs: fm.dream_refs || [],
    };
    if (fm.project) {
      entry.project = fm.project;
    }
    if (existing !== -1) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
    indexCache = null;
  } catch { /* non-critical */ }
}

// --- Project boost for search scoring ---

function projectBoost(entryProject: string | undefined, currentProject: string | undefined): number {
  if (!entryProject) return 1.0; // Global node — always relevant
  if (!currentProject || currentProject === "global") return 1.0; // No project context
  if (entryProject === currentProject) return 1.3; // Project match bonus
  return 0.7; // Other project — slightly demoted
}

// --- recall action ---

function recallGraph(query?: string, depth?: number): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (!query) {
    return { content: [{ type: "text", text: "Error: query required for recall" }], isError: true };
  }

  const index = loadIndex();
  if (index.length === 0) {
    return { content: [{ type: "text", text: "Graph index not yet built. No nodes to search." }] };
  }

  const hopDepth = depth ?? 1;
  const queryTokens = query.toLowerCase().split(/\s+/);
  const currentProject = readActiveProject()?.name;

  // Score and rank
  const results = index
    .map((entry: any) => {
      const gistTokens = (entry.gist || "").toLowerCase().split(/\s+/);
      const tagTokens = (entry.tags || []).map((t: string) => t.toLowerCase());
      const keywordTokens = (entry.keywords || []).map((k: string) => k.toLowerCase());

      const gistScore = overlap(queryTokens, gistTokens) * 3;
      const tagScore = overlap(queryTokens, tagTokens) * 2;
      const keywordScore = overlap(queryTokens, keywordTokens) * 1;

      const baseRelevance = (gistScore + tagScore + keywordScore) * (entry.confidence || 0.5);
      const recency = recencyBoost(entry.last_accessed);
      const soma = somaBoost(entry.soma_intensity || 0);
      const projBoost = projectBoost(entry.project, currentProject);
      const relevance = baseRelevance * recency * soma * projBoost;

      return { ...entry, relevance };
    })
    .filter((e: any) => e.relevance > 0.1)
    .sort((a: any, b: any) => b.relevance - a.relevance)
    .slice(0, 5);

  if (results.length === 0) {
    return { content: [{ type: "text", text: `No results for: "${query}"` }] };
  }

  // Auto-load edge targets (1 hop)
  const edgeTargets = new Set<string>();
  const resultPaths = new Set(results.map((r: any) => r.path));

  if (hopDepth >= 1) {
    for (const result of results) {
      for (const edgeTarget of result.edges || []) {
        if (!resultPaths.has(edgeTarget)) {
          edgeTargets.add(edgeTarget);
        }
      }
    }
  }

  const connectedNodes = [...edgeTargets]
    .map(target => index.find((e: any) => e.path === target))
    .filter(Boolean)
    .slice(0, 5);

  // Format output
  const sections: string[] = [];

  sections.push("## Direct Matches\n");
  for (const r of results) {
    const dreamCount = (r.dream_refs || []).length;
    const dreamStr = dreamCount > 0 ? ` [${dreamCount} dreams]` : "";
    sections.push(`- **${r.path}** (relevance: ${r.relevance.toFixed(2)}, confidence: ${r.confidence})${dreamStr}\n  ${r.gist}`);
  }

  if (connectedNodes.length > 0) {
    sections.push("\n## Connected Nodes (1 hop)\n");
    for (const n of connectedNodes) {
      sections.push(`- **${n.path}** (confidence: ${n.confidence})\n  ${n.gist}`);
    }
  }

  return { content: [{ type: "text", text: sections.join("\n") }] };
}

// --- consolidate action ---

async function runConsolidation(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Mechanical-only consolidation: process deltas, rebuild MAP, run decay
  const deltasDir = CONFIG.paths.deltas;
  if (!fs.existsSync(deltasDir)) {
    return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "No deltas to process." }, null, 2) }] };
  }

  const deltaFiles = fs.readdirSync(deltasDir).filter(f => f.endsWith(".json")).sort();
  if (deltaFiles.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "No deltas to process." }, null, 2) }] };
  }

  let totalApplied = 0;
  const allErrors: string[] = [];
  const processed: string[] = [];

  for (const deltaFile of deltaFiles) {
    const sessionId = deltaFile.replace(".json", "");
    try {
      const result = await applyDeltas(sessionId);
      totalApplied += result.appliedCount;
      allErrors.push(...result.errors);
      processed.push(deltaFile);
    } catch (err: any) {
      allErrors.push(`Failed processing ${sessionId}: ${err.message}`);
    }
  }

  // Run decay
  try {
    runDecay();
  } catch (err: any) {
    allErrors.push(`Decay failed: ${err.message}`);
  }

  // Rebuild MAP and index
  try {
    fullRegenerateMAP();
    rebuildIndex();
  } catch (err: any) {
    allErrors.push(`Rebuild failed: ${err.message}`);
  }

  // Update manifest and commit
  try {
    updateManifest();
    await autoCommit("consolidation");
  } catch (err: any) {
    allErrors.push(`Post-consolidation failed: ${err.message}`);
  }

  // Clean up only successfully processed deltas
  for (const f of processed) {
    try { fs.unlinkSync(path.join(deltasDir, f)); } catch { /* skip */ }
  }

  clearConsolidationPending();

  // Count current state
  const nodeCount = fs.existsSync(CONFIG.paths.nodes) ? countFilesUtil(CONFIG.paths.nodes, ".md") : 0;
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  const dreamCount = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(f => f.endsWith(".json")).length : 0;

  return {
    content: [{ type: "text", text: JSON.stringify({
      success: true,
      message: `Consolidation complete. ${totalApplied} deltas applied mechanically.`,
      deltasApplied: totalApplied,
      errors: allErrors,
      nodeCount,
      dreamCount,
    }, null, 2) }],
  };
}

// --- Existing actions ---

function readNode(nodePath?: string) {
  if (!nodePath) {
    return { content: [{ type: "text" as const, text: "Error: path required for read_node" }], isError: true };
  }

  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!fullPath) {
    return { content: [{ type: "text" as const, text: `Invalid path: ${nodePath}` }], isError: true };
  }

  if (!fs.existsSync(fullPath)) {
    const archivePath = safePath(CONFIG.paths.archive, nodePath, ".md");
    if (archivePath && fs.existsSync(archivePath)) {
      const content = fs.readFileSync(archivePath, "utf-8");
      return { content: [{ type: "text" as const, text: `[ARCHIVED]\n\n${content}` }] };
    }
    return { content: [{ type: "text" as const, text: `Node not found: ${nodePath}` }], isError: true };
  }

  let content = fs.readFileSync(fullPath, "utf-8");
  updateLastAccessed(nodePath);

  // Surface dream connections if present
  try {
    const parsed = matter(content);
    const dreamRefs: string[] = parsed.data.dream_refs || [];
    if (dreamRefs.length > 0) {
      const dreamSections: string[] = [];
      const pendingDir = path.join(CONFIG.paths.dreams, "pending");
      for (const dreamFile of dreamRefs) {
        const dreamPath = path.join(pendingDir, dreamFile);
        if (fs.existsSync(dreamPath)) {
          try {
            const dreamData = JSON.parse(fs.readFileSync(dreamPath, "utf-8"));
            dreamSections.push(`- ${dreamData.fragment?.slice(0, 150) || "unknown"} (confidence: ${dreamData.confidence || "?"})`);
          } catch { /* skip */ }
        }
      }
      if (dreamSections.length > 0) {
        content += `\n\n---\n\n## Related Dreams\n\n${dreamSections.join("\n")}`;
      }
    }
  } catch { /* skip — return raw content */ }

  return { content: [{ type: "text" as const, text: content }] };
}

function updateLastAccessed(nodePath: string) {
  const now = new Date().toISOString();

  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (fullPath && fs.existsSync(fullPath)) {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const parsed = matter(raw);
      parsed.data.last_accessed = now;
      parsed.data.access_count = (parsed.data.access_count || 0) + 1;
      fs.writeFileSync(fullPath, matter.stringify(parsed.content, parsed.data));
    } catch { /* Non-critical */ }
  }

  try {
    const index = loadIndex();
    const entry = index.find((e: any) => e.path === nodePath);
    if (entry) {
      entry.last_accessed = now;
      entry.access_count = (entry.access_count || 0) + 1;
      fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
      indexCache = null;
    }
  } catch { /* Non-critical */ }
}

function searchGraph(query?: string) {
  if (!query) {
    return { content: [{ type: "text" as const, text: "Error: query required for search" }], isError: true };
  }

  const index = loadIndex();
  if (index.length === 0) {
    return { content: [{ type: "text" as const, text: "Graph index not yet built. No nodes to search." }] };
  }

  try {
    const queryTokens = query.toLowerCase().split(/\s+/);
    const currentProject = readActiveProject()?.name;

    const results = index
      .map((entry: any) => {
        const gistTokens = (entry.gist || "").toLowerCase().split(/\s+/);
        const tagTokens = (entry.tags || []).map((t: string) => t.toLowerCase());
        const keywordTokens = (entry.keywords || []).map((k: string) => k.toLowerCase());

        const gistScore = overlap(queryTokens, gistTokens) * 3;
        const tagScore = overlap(queryTokens, tagTokens) * 2;
        const keywordScore = overlap(queryTokens, keywordTokens) * 1;

        const baseRelevance = (gistScore + tagScore + keywordScore) * (entry.confidence || 0.5);
        const recency = recencyBoost(entry.last_accessed);
        const soma = somaBoost(entry.soma_intensity || 0);
        const projBoost = projectBoost(entry.project, currentProject);
        const relevance = baseRelevance * recency * soma * projBoost;

        const reasons: string[] = [];
        if (gistScore > 0) reasons.push(`gist match (${Math.round(gistScore / 3 * 100)}%)`);
        const matchedTags = (entry.tags || []).filter((t: string) => queryTokens.includes(t.toLowerCase()));
        if (matchedTags.length > 0) reasons.push(`tag: ${matchedTags.join(", ")}`);
        if (soma > 1.0) reasons.push(`soma ${soma.toFixed(1)}x`);
        if (recency !== 1.0) reasons.push(`recency ${recency.toFixed(1)}x`);

        return { ...entry, relevance, match_reason: reasons.join("; ") };
      })
      .filter((e: any) => e.relevance > 0.1)
      .sort((a: any, b: any) => b.relevance - a.relevance)
      .slice(0, 5);

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
    }

    const formatted = results
      .map((r: any) => {
        const dreamCount = (r.dream_refs || []).length;
        const dreamStr = dreamCount > 0 ? ` [${dreamCount} dreams]` : "";
        return `- ${r.path} (relevance: ${r.relevance.toFixed(2)}${dreamStr})\n  ${r.gist}\n  [${r.match_reason}]`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text: formatted }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Search error: ${err}` }], isError: true };
  }
}

function recencyBoost(lastAccessed?: string): number {
  if (!lastAccessed) return 0.8;
  const daysSince = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 7) return 1.2;
  if (daysSince <= 30) return 1.0;
  return 0.8;
}

function listEdges(nodePath?: string) {
  if (!nodePath) {
    return { content: [{ type: "text" as const, text: "Error: path required for list_edges" }], isError: true };
  }

  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!fullPath) {
    return { content: [{ type: "text" as const, text: `Invalid path: ${nodePath}` }], isError: true };
  }
  if (!fs.existsSync(fullPath)) {
    return { content: [{ type: "text" as const, text: `Node not found: ${nodePath}` }], isError: true };
  }

  const raw = fs.readFileSync(fullPath, "utf-8");

  try {
    const parsed = matter(raw);
    const edges = parsed.data.edges || [];
    const antiEdges = parsed.data.anti_edges || [];

    const result = {
      path: nodePath,
      title: parsed.data.title || nodePath,
      confidence: parsed.data.confidence,
      edges: edges.map((e: any) => ({
        target: e.target,
        type: e.type || "relates_to",
        weight: e.weight || 0.5,
      })),
      anti_edges: antiEdges.map((ae: any) => ({
        target: ae.target,
        reason: ae.reason || "",
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch {
    return { content: [{ type: "text" as const, text: `Failed to parse frontmatter for: ${nodePath}` }], isError: true };
  }
}

function readDream(dreamPath?: string) {
  if (!dreamPath) {
    const pendingDir = path.join(CONFIG.paths.dreams, "pending");
    if (!fs.existsSync(pendingDir)) {
      return { content: [{ type: "text" as const, text: "No pending dreams." }] };
    }
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    if (files.length === 0) {
      return { content: [{ type: "text" as const, text: "No pending dreams." }] };
    }
    return { content: [{ type: "text" as const, text: `Pending dreams:\n${files.map(f => `- ${f}`).join("\n")}` }] };
  }

  const fullPath = safePath(CONFIG.paths.dreams, dreamPath, ".json");
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { content: [{ type: "text" as const, text: `Dream not found: ${dreamPath}` }], isError: true };
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  return { content: [{ type: "text" as const, text: content }] };
}

function writeNote(note?: string) {
  if (!note) {
    return { content: [{ type: "text" as const, text: "Error: note required for write_note" }], isError: true };
  }

  const notesDir = path.join(CONFIG.paths.buffer, "notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  const noteFile = path.join(notesDir, `note_${Date.now()}.md`);
  fs.writeFileSync(noteFile, note);

  return { content: [{ type: "text" as const, text: "Note saved." }] };
}

async function getHistory() {
  const commits = await listCommits(10);
  if (commits.length === 0) {
    return { content: [{ type: "text" as const, text: "No memory commits found." }] };
  }

  const formatted = commits.map(c => {
    const shortHash = c.hash.slice(0, 7);
    return `${shortHash}  ${c.date}  ${c.message}`;
  }).join("\n");

  return { content: [{ type: "text" as const, text: `Recent memory commits:\n\n${formatted}\n\nUse action="revert" path="<hash>" to roll back.` }] };
}

async function revertGraph(commitHash?: string) {
  if (!commitHash) {
    return { content: [{ type: "text" as const, text: "Error: path (commit hash) required for revert" }], isError: true };
  }

  const result = await revertTo(commitHash);
  if (result.success) {
    return { content: [{ type: "text" as const, text: result.message }] };
  }
  return { content: [{ type: "text" as const, text: result.message }], isError: true };
}

function initializeGraphAction(graphRoot?: string) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    return { content: [{ type: "text" as const, text: "Error: cannot determine home directory" }], isError: true };
  }

  const resolvedRoot = graphRoot
    ? path.resolve(graphRoot.replace(/^~/, home))
    : path.join(home, ".graph-memory");

  // Reject dangerous paths (prefix-based check)
  const normalized = resolvedRoot.replace(/\/+$/, "");
  const dangerous = ["/etc", "/usr", "/var", "/bin", "/sbin", "/lib", "/sys", "/proc"];
  if (normalized === "/" || dangerous.some(d => normalized === d || normalized.startsWith(d + "/"))) {
    return { content: [{ type: "text" as const, text: `Error: refusing to initialize graph at system path: ${resolvedRoot}` }], isError: true };
  }

  saveGlobalConfig(resolvedRoot);
  reloadConfig();
  initializeGraph();

  return getStatus();
}

function getStatus() {
  const initialized = isGraphInitialized();
  const mapExists = fs.existsSync(CONFIG.paths.map);
  const priorsExists = fs.existsSync(CONFIG.paths.priors);
  const indexExists = fs.existsSync(CONFIG.paths.index);

  let nodeCount = 0;
  if (fs.existsSync(CONFIG.paths.nodes)) {
    nodeCount = countFilesUtil(CONFIG.paths.nodes, ".md");
  }

  let dreamCount = 0;
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (fs.existsSync(pendingDir)) {
    dreamCount = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json")).length;
  }

  const warnings: string[] = [];

  if (mapExists) {
    const mapContent = fs.readFileSync(CONFIG.paths.map, "utf-8");
    const mapTokens = Math.ceil(mapContent.length / 4);
    const mapUsage = mapTokens / CONFIG.graph.maxMapTokens;
    if (mapUsage > 0.9) {
      warnings.push(`MAP at ${Math.round(mapUsage * 100)}% of token budget`);
    }
  }

  const nodeUsage = nodeCount / CONFIG.graph.maxNodesBeforePrune;
  if (nodeUsage > 0.8) {
    warnings.push(`Node count at ${Math.round(nodeUsage * 100)}% of limit (${nodeCount}/${CONFIG.graph.maxNodesBeforePrune})`);
  }

  const index = loadIndex();
  const lowConfNodes = index.filter((e: any) => (e.confidence || 0.5) < 0.3);
  if (lowConfNodes.length > 0) {
    warnings.push(`${lowConfNodes.length} node(s) below 0.3 confidence`);
  }

  // Check for pending operations
  const scribePending = fs.existsSync(CONFIG.paths.scribePending);
  const consolidationPending = fs.existsSync(CONFIG.paths.consolidationPending);

  // Active project
  const activeProject = readActiveProject();

  const status: Record<string, any> = {
    initialized,
    firstRun: !initialized,
    graphRoot: CONFIG.paths.graphRoot,
    activeProject: activeProject?.name || "global",
    mapLoaded: mapExists,
    priorsLoaded: priorsExists,
    indexBuilt: indexExists,
    nodeCount,
    pendingDreams: dreamCount,
    scribePending,
    consolidationPending,
    warnings,
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
}

// Helpers
function overlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let count = 0;
  for (const token of a) {
    if (setB.has(token)) count++;
  }
  return a.length > 0 ? count / a.length : 0;
}

// Zod schema for the tool (exported for MCP server registration)
export const graphMemorySchema = {
  action: z.enum([
    "read_node", "search", "recall", "list_edges", "read_dream", "write_note",
    "remember", "status", "history", "revert", "consolidate", "initialize"
  ]).describe("The action to perform on the knowledge graph"),
  path: z.string().optional()
    .describe("Node path for read_node/list_edges/remember, dream path for read_dream, commit hash for revert"),
  query: z.string().optional()
    .describe("Search query for search/recall actions"),
  note: z.string().optional()
    .describe("Note content for write_note action"),
  gist: z.string().optional()
    .describe("One-sentence summary for remember action"),
  content: z.string().optional()
    .describe("Full content for remember action"),
  title: z.string().optional()
    .describe("Human-readable title for remember action"),
  tags: z.array(z.string()).optional()
    .describe("Tags for remember action"),
  confidence: z.number().min(0).max(1).optional()
    .describe("Confidence (0-1) for remember action"),
  edges: z.array(z.object({
    target: z.string(),
    type: z.string(),
    weight: z.number().optional(),
  })).optional()
    .describe("Edge connections for remember action"),
  soma: z.object({
    valence: z.string(),
    intensity: z.number(),
    marker: z.string(),
  }).optional()
    .describe("Somatic marker for remember action"),
  depth: z.number().optional()
    .describe("Edge traversal depth for recall action (default 1)"),
  graphRoot: z.string().optional()
    .describe("Storage path for initialize action (defaults to ~/.graph-memory/)"),
  project: z.string().optional()
    .describe("Project scope for remember action (e.g. 'owner/repo'). Only set for project-specific knowledge, omit for global."),
};
