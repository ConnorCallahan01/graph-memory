/**
 * Shared graph operations used by both mechanical-apply and the librarian.
 * Extracted from librarian.ts to avoid duplication.
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { walkNodes, extractFirstParagraph, getNodeDepth } from "../utils.js";
import { readActiveProject } from "../project.js";

// --- Edge validation ---

export const VALID_EDGE_TYPES = new Set([
  "relates_to",
  "contradicts",
  "supports",
  "derives_from",
  "pattern_transfer",
  "evidenced_by",
  "instantiates",
  "supersedes",
  "depends_on",
  "extends",
  "refines",
  "implements",
  "influences",
  "precedes",
  "follows",
  "part_of",
  "contains",
  "inspired_by",
  "analogous_to",
  "contrasts_with",
  "enables",
  "blocks",
]);

export function validateEdgeType(type: string): string {
  const normalized = type.toLowerCase().replace(/[\s-]+/g, "_");
  if (VALID_EDGE_TYPES.has(normalized)) return normalized;
  if (/^[a-z][a-z0-9_]*$/.test(normalized)) {
    activityBus.log("system:info", `New edge type "${normalized}" from LLM — accepting.`);
    return normalized;
  }
  activityBus.log("system:info", `Malformed edge type "${type}" — defaulting to relates_to`);
  return "relates_to";
}

// --- Token estimation ---

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- PRIORS management ---

export function updatePriors(newPriors: string[], decayedPriors: string[]) {
  if (!fs.existsSync(CONFIG.paths.priors)) {
    fs.writeFileSync(
      CONFIG.paths.priors,
      `# PRIORS — Behavioral Guidelines\n\n> Derived from cross-session patterns.\n\n`
    );
  }

  let content = fs.readFileSync(CONFIG.paths.priors, "utf-8");
  const lines = content.split("\n");

  const headerLines: string[] = [];
  const priorLines: string[] = [];
  for (const line of lines) {
    if (/^\d+\./.test(line)) {
      priorLines.push(line.replace(/^\d+\.\s*/, ""));
    } else {
      headerLines.push(line);
    }
  }

  for (const decayed of decayedPriors) {
    const normalized = decayed.toLowerCase().replace(/\*\*/g, "").trim();
    const idx = priorLines.findIndex(p => p.toLowerCase().replace(/\*\*/g, "").includes(normalized));
    if (idx !== -1) {
      priorLines.splice(idx, 1);
    }
  }

  for (const prior of newPriors) {
    const normalizedNew = prior.toLowerCase().replace(/\*\*/g, "").trim();
    const isDuplicate = priorLines.some(existing => {
      const normalizedExisting = existing.toLowerCase().replace(/\*\*/g, "").trim();
      const newWords = new Set(normalizedNew.split(/\s+/));
      const existingWords = normalizedExisting.split(/\s+/);
      const overlap = existingWords.filter(w => newWords.has(w)).length;
      return overlap / Math.max(newWords.size, existingWords.length) > 0.6;
    });

    if (!isDuplicate) {
      const parts = prior.split(" — ");
      if (parts.length > 1) {
        priorLines.push(`**${parts[0]}** — ${parts.slice(1).join(" — ")}`);
      } else {
        priorLines.push(prior);
      }
    }
  }

  while (priorLines.length > CONFIG.graph.maxPriors) {
    priorLines.shift();
  }

  const rebuiltLines = [...headerLines];
  for (let i = 0; i < priorLines.length; i++) {
    rebuiltLines.push(`${i + 1}. ${priorLines[i]}`);
  }

  fs.writeFileSync(CONFIG.paths.priors, rebuiltLines.join("\n"));

  activityBus.log("graph:priors_updated", `Priors updated: +${newPriors.length}, -${decayedPriors.length}, total: ${priorLines.length}/${CONFIG.graph.maxPriors}`);
}

// --- MAP regeneration (with depth filtering + dream summary) ---

interface MapEntry {
  nodePath: string;
  line: string;
  confidence: number;
  somaMarker?: string;
  project?: string;
}

export function fullRegenerateMAP(currentProject?: string) {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  const allEntries: MapEntry[] = [];
  const maxDepth = CONFIG.graph.maxMapDepth;

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    // Depth filter: only include nodes at depth ≤ maxMapDepth
    if (getNodeDepth(nodePath) > maxDepth) continue;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const gist = parsed.data.gist || extractFirstParagraph(parsed.content);
      const edges: string[] = (parsed.data.edges || []).map((e: any) => e.target).filter(Boolean);
      const edgeStr = edges.length > 0 ? ` → [${edges.join(", ")}]` : "";
      const confidence = typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5;
      const somaMarker = parsed.data.soma?.marker;
      const somaStr = somaMarker ? ` ⚡${somaMarker}` : "";

      const nodeProject = parsed.data.project as string | undefined;

      allEntries.push({
        nodePath,
        line: `- **${nodePath}** — ${gist}${edgeStr}${somaStr}`,
        confidence,
        somaMarker,
        project: nodeProject,
      });
    } catch {
      // Skip
    }
  }

  // Enforce maxNodesBeforePrune
  if (allEntries.length > CONFIG.graph.maxNodesBeforePrune) {
    const sorted = [...allEntries].sort((a, b) => a.confidence - b.confidence);
    const toArchive = sorted.slice(0, allEntries.length - CONFIG.graph.maxNodesBeforePrune);

    for (const entry of toArchive) {
      try {
        const srcPath = path.join(CONFIG.paths.nodes, `${entry.nodePath}.md`);
        const destPath = path.join(CONFIG.paths.archive, `${entry.nodePath}.md`);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(srcPath, destPath);
      } catch { /* skip */ }
    }

    const prunedPaths = new Set(toArchive.map(e => e.nodePath));
    const remaining = allEntries.filter(e => !prunedPaths.has(e.nodePath));
    allEntries.length = 0;
    allEntries.push(...remaining);
  }

  const header = `# MAP — Knowledge Graph Index\n\n> Auto-generated. Each entry: path | gist | edges\n> ~50-80 tokens per entry. This is the agent's "hippocampus."\n`;
  const headerTokens = estimateTokens(header);

  // Resolve current project for ordering: explicit param > active project
  const activeProj = currentProject || readActiveProject()?.name;

  // Project-aware ordering: global first, then current project, then other projects
  // Within each group, sort by confidence descending
  function projectOrder(entry: MapEntry): number {
    if (!entry.project) return 0; // Global — highest priority
    if (activeProj && entry.project === activeProj) return 1; // Current project
    return 2; // Other project
  }

  allEntries.sort((a, b) => {
    const orderDiff = projectOrder(a) - projectOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return b.confidence - a.confidence;
  });

  let tokenBudget = CONFIG.graph.maxMapTokens - headerTokens;
  const includedEntries: MapEntry[] = [];

  for (const entry of allEntries) {
    const entryTokens = estimateTokens(entry.line + "\n");
    if (tokenBudget - entryTokens < 200 && includedEntries.length > 0) continue;
    tokenBudget -= entryTokens;
    includedEntries.push(entry);
  }

  const categories = new Map<string, string[]>();
  for (const entry of includedEntries) {
    const cat = entry.nodePath.split("/")[0];
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(entry.line);
  }

  let newMAP = header;

  for (const [cat, entryLines] of categories) {
    newMAP += `\n## ${cat}\n\n`;
    newMAP += entryLines.join("\n") + "\n";
  }

  // Dream summary: single line instead of inlining all dreams
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (fs.existsSync(pendingDir)) {
    const dreamFiles = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    if (dreamFiles.length > 0) {
      // Count unique referenced nodes across all dreams
      const referencedNodes = new Set<string>();
      for (const f of dreamFiles) {
        try {
          const dream = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf-8"));
          for (const ref of dream.nodes_referenced || []) {
            referencedNodes.add(ref);
          }
        } catch { /* skip */ }
      }
      newMAP += `\n## Pending Dreams\n\n${dreamFiles.length} fragments across ${referencedNodes.size} nodes. Query via \`recall\` with related topics to surface.\n`;
    }
  }

  if (categories.size === 0) {
    newMAP += `\n_No nodes yet. The graph will grow as conversations happen._\n`;
  }

  fs.writeFileSync(CONFIG.paths.map, newMAP);

  activityBus.log("graph:map_regenerated", `MAP rebuilt: ${includedEntries.length} entries, ~${estimateTokens(newMAP)} tokens`);
}

// --- Index rebuild (with dream_refs) ---

export function rebuildIndex() {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  const index: any[] = [];

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data;

      const indexEntry: Record<string, any> = {
        path: nodePath,
        gist: ((fm.gist || extractFirstParagraph(parsed.content)) as string).slice(0, 200),
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
        indexEntry.project = fm.project;
      }
      index.push(indexEntry);
    } catch {
      // Skip
    }
  }

  fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
}
