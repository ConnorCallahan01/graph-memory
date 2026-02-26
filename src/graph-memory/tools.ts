import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { activityBus } from "./events.js";
import { safePath, countFiles as countFilesUtil } from "./utils.js";
import { listCommits, revertTo } from "./git.js";
import { somaBoost } from "./soma.js";

// --- Index cache (Gap 12) ---
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
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { action } = args;

  switch (action) {
    case "read_node":
      return readNode(args.path);
    case "search":
      return searchGraph(args.query);
    case "list_edges":
      return listEdges(args.path);
    case "read_dream":
      return readDream(args.path);
    case "write_note":
      return writeNote(args.note);
    case "status":
      return getStatus();
    case "history":
      return getHistory();
    case "revert":
      return revertGraph(args.path);
    default:
      return {
        content: [{ type: "text", text: `Unknown action: ${action}. Available: read_node, search, list_edges, read_dream, write_note, status, history, revert` }],
        isError: true,
      };
  }
}

function readNode(nodePath?: string) {
  if (!nodePath) {
    return { content: [{ type: "text" as const, text: "Error: path required for read_node" }], isError: true };
  }

  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!fullPath) {
    return { content: [{ type: "text" as const, text: `Invalid path: ${nodePath}` }], isError: true };
  }

  if (!fs.existsSync(fullPath)) {
    // Check archive
    const archivePath = safePath(CONFIG.paths.archive, nodePath, ".md");
    if (archivePath && fs.existsSync(archivePath)) {
      const content = fs.readFileSync(archivePath, "utf-8");
      activityBus.log("graph:node_updated", `Read archived node: ${nodePath}`, { path: nodePath, archived: true });
      return { content: [{ type: "text" as const, text: `[ARCHIVED]\n\n${content}` }] };
    }
    return { content: [{ type: "text" as const, text: `Node not found: ${nodePath}` }], isError: true };
  }

  const content = fs.readFileSync(fullPath, "utf-8");

  // Update last_accessed in the index
  updateLastAccessed(nodePath);

  activityBus.log("graph:node_updated", `Read node: ${nodePath}`, { path: nodePath });
  return { content: [{ type: "text" as const, text: content }] };
}

function updateLastAccessed(nodePath: string) {
  const now = new Date().toISOString();

  // 1. Update the node's frontmatter (source of truth, survives index rebuilds)
  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (fullPath && fs.existsSync(fullPath)) {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const parsed = matter(raw);
      parsed.data.last_accessed = now;
      parsed.data.access_count = (parsed.data.access_count || 0) + 1;
      fs.writeFileSync(fullPath, matter.stringify(parsed.content, parsed.data));
    } catch {
      // Non-critical
    }
  }

  // 2. Also update the index for immediate effect (without waiting for rebuild)
  try {
    const index = loadIndex();
    const entry = index.find((e: any) => e.path === nodePath);
    if (entry) {
      entry.last_accessed = now;
      entry.access_count = (entry.access_count || 0) + 1;
      fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
      indexCache = null; // Invalidate cache after write
    }
  } catch {
    // Non-critical, silently skip
  }
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

    const results = index
      .map((entry: any) => {
        const gistTokens = (entry.gist || "").toLowerCase().split(/\s+/);
        const tagTokens = (entry.tags || []).map((t: string) => t.toLowerCase());
        const keywordTokens = (entry.keywords || []).map((k: string) => k.toLowerCase());

        const gistScore = overlap(queryTokens, gistTokens) * 3;
        const tagScore = overlap(queryTokens, tagTokens) * 2;
        const keywordScore = overlap(queryTokens, keywordTokens) * 1;

        const baseRelevance = (gistScore + tagScore + keywordScore) * (entry.confidence || 0.5);

        // Recency boost
        const recency = recencyBoost(entry.last_accessed);

        // Soma boost (Gap 7)
        const soma = somaBoost(entry.soma_intensity || 0);

        const relevance = baseRelevance * recency * soma;

        // Build match_reason (Gap 11)
        const reasons: string[] = [];
        if (gistScore > 0) reasons.push(`gist match (${Math.round(gistScore / 3 * 100)}%)`);
        const matchedTags = (entry.tags || []).filter((t: string) => queryTokens.includes(t.toLowerCase()));
        if (matchedTags.length > 0) reasons.push(`tag: ${matchedTags.join(", ")}`);
        const matchedKw = (entry.keywords || []).filter((k: string) => queryTokens.includes(k.toLowerCase()));
        if (matchedKw.length > 0) reasons.push(`keyword: ${matchedKw.join(", ")}`);
        if (soma > 1.0) reasons.push(`soma ${soma.toFixed(1)}x`);
        if (recency !== 1.0) reasons.push(`recency ${recency.toFixed(1)}x`);
        const match_reason = reasons.join("; ");

        return { ...entry, relevance, recency, soma, match_reason };
      })
      .filter((e: any) => e.relevance > 0.1)
      .sort((a: any, b: any) => b.relevance - a.relevance)
      .slice(0, 5);

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
    }

    const formatted = results
      .map((r: any) => `- ${r.path} (relevance: ${r.relevance.toFixed(2)})\n  ${r.gist}\n  [${r.match_reason}]`)
      .join("\n\n");

    activityBus.log("graph:node_updated", `Search: "${query}" → ${results.length} results`, { query, resultCount: results.length });
    return { content: [{ type: "text" as const, text: formatted }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Search error: ${err}` }], isError: true };
  }
}

/**
 * Recency boost multiplier based on last_accessed date.
 * 7 days: 1.2x, 30 days: 1.0x, older: 0.8x
 */
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
    // List pending dreams
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

  activityBus.log("graph:node_created", `Agent wrote note: ${note.slice(0, 60)}...`);
  return { content: [{ type: "text" as const, text: "Note saved." }] };
}

async function getHistory() {
  const commits = await listCommits(10);
  if (commits.length === 0) {
    return { content: [{ type: "text" as const, text: "No memory commits found. Graph may not have a git repo yet." }] };
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

function getStatus() {
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

  // Graph health warnings (Gap 8)
  const warnings: string[] = [];

  // MAP token usage vs budget
  if (mapExists) {
    const mapContent = fs.readFileSync(CONFIG.paths.map, "utf-8");
    const mapTokens = Math.ceil(mapContent.length / 4);
    const mapUsage = mapTokens / CONFIG.graph.maxMapTokens;
    if (mapUsage > 0.9) {
      warnings.push(`MAP at ${Math.round(mapUsage * 100)}% of token budget (${mapTokens}/${CONFIG.graph.maxMapTokens})`);
    }
  }

  // Node count vs prune limit
  const nodeUsage = nodeCount / CONFIG.graph.maxNodesBeforePrune;
  if (nodeUsage > 0.8) {
    warnings.push(`Node count at ${Math.round(nodeUsage * 100)}% of limit (${nodeCount}/${CONFIG.graph.maxNodesBeforePrune})`);
  }

  // Priors count vs max
  if (priorsExists) {
    const priorsContent = fs.readFileSync(CONFIG.paths.priors, "utf-8");
    const priorsCount = priorsContent.split("\n").filter(l => /^\d+\./.test(l)).length;
    const priorsUsage = priorsCount / CONFIG.graph.maxPriors;
    if (priorsUsage > 0.8) {
      warnings.push(`Priors at ${Math.round(priorsUsage * 100)}% of limit (${priorsCount}/${CONFIG.graph.maxPriors})`);
    }
  }

  // Low-confidence nodes at decay risk
  const index = loadIndex();
  const lowConfNodes = index.filter((e: any) => (e.confidence || 0.5) < 0.3);
  if (lowConfNodes.length > 0) {
    warnings.push(`${lowConfNodes.length} node(s) below 0.3 confidence — at decay/archive risk`);
  }

  const status = {
    mapLoaded: mapExists,
    priorsLoaded: priorsExists,
    indexBuilt: indexExists,
    nodeCount,
    pendingDreams: dreamCount,
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
  action: z.enum(["read_node", "search", "list_edges", "read_dream", "write_note", "status", "history", "revert"])
    .describe("The action to perform on the knowledge graph"),
  path: z.string().optional()
    .describe("Node path for read_node/list_edges, dream path for read_dream, commit hash for revert"),
  query: z.string().optional()
    .describe("Search query for the search action"),
  note: z.string().optional()
    .describe("Note content for write_note action"),
};
