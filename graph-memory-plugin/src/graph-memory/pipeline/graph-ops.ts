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
import { ensureWorkingDirectories } from "../working-files.js";

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
    const scored = priorLines.map((line, idx) => ({ idx, score: scorePriorLine(line) }));
    scored.sort((a, b) => a.score - b.score);
    priorLines.splice(scored[0].idx, 1);
  }

  const rebuiltLines = [...headerLines];
  for (let i = 0; i < priorLines.length; i++) {
    rebuiltLines.push(`${i + 1}. ${priorLines[i]}`);
  }

  let output = rebuiltLines.join("\n");
  const MAX_PRIORS_TOKENS = CONFIG.graph.maxPriorsTokens || 1500;
  const priorTokens = estimateTokens(output);
  if (priorTokens > MAX_PRIORS_TOKENS) {
    const kept = truncatePriorsToBudget(priorLines, headerLines, MAX_PRIORS_TOKENS);
    rebuiltLines.length = 0;
    for (let i = 0; i < headerLines.length; i++) rebuiltLines.push(headerLines[i]);
    for (let i = 0; i < kept.length; i++) rebuiltLines.push(`${i + 1}. ${kept[i]}`);
    output = rebuiltLines.join("\n");
    activityBus.log("graph:priors_truncated", `PRIORS truncated from ${priorTokens} to ${estimateTokens(output)} tokens (cap: ${MAX_PRIORS_TOKENS})`);
  }

  fs.writeFileSync(CONFIG.paths.priors, output);

  activityBus.log("graph:priors_updated", `Priors updated: +${newPriors.length}, -${decayedPriors.length}, total: ${priorLines.length}/${CONFIG.graph.maxPriors} (${estimateTokens(output)} tokens)`);
}

// --- MAP regeneration (with depth filtering + dream summary) ---

interface MapEntry {
  nodePath: string;
  category: string;
  line: string;
  confidence: number;
  project?: string;
  pinned: boolean;
  lastAccessedAt: number;
}

const MAP_CATEGORY_PRIORITY = new Map<string, number>([
  ["preferences", 0],
  ["patterns", 1],
  ["decisions", 2],
  ["architecture", 3],
  ["concepts", 4],
  ["meta", 5],
  ["people", 6],
  ["facts", 7],
  ["projects", 8],
  ["tools", 9],
]);

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function mapCategoryPriority(category: string): number {
  return MAP_CATEGORY_PRIORITY.get(category) ?? 20;
}

function mapCategoryCap(category: string): number {
  const priority = mapCategoryPriority(category);
  if (priority <= 3) return CONFIG.graph.maxMapEntriesPerCategory;
  if (priority <= 6) return Math.max(3, CONFIG.graph.maxMapEntriesPerCategory - 2);
  return Math.max(2, CONFIG.graph.maxMapEntriesPerCategory - 4);
}

function defaultLastAccessedAt(frontmatter: Record<string, any>): number {
  const raw = frontmatter.last_accessed || frontmatter.updated || frontmatter.created;
  const parsed = raw ? Date.parse(String(raw)) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function fullRegenerateMAP(currentProject?: string) {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  const allEntries: MapEntry[] = [];
  const maxDepth = CONFIG.graph.maxMapDepth;

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    // Depth filter: only include nodes at depth ≤ maxMapDepth
    if (getNodeDepth(nodePath) > maxDepth) continue;
    const category = nodePath.split("/")[0];
    if (category.startsWith(".")) continue;
    if (category === "archive") continue;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const gist = truncate(parsed.data.gist || extractFirstParagraph(parsed.content), 150);
      const edges: string[] = (parsed.data.edges || []).map((e: any) => e.target).filter(Boolean).slice(0, 3);
      const edgeStr = edges.length > 0 ? ` → [${edges.join(", ")}]` : "";
      const antiEdges: string[] = (parsed.data.anti_edges || [])
        .map((e: any) => e.reason ? `${e.target} (${e.reason})` : e.target)
        .filter(Boolean);
      const limitedAntiEdges = antiEdges.slice(0, 2);
      const antiEdgeStr = limitedAntiEdges.length > 0 ? ` ⊘ [${limitedAntiEdges.join(", ")}]` : "";
      const confidence = typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5;

      const nodeProject = parsed.data.project as string | undefined;
      const pinStr = parsed.data.pinned ? " [pinned]" : "";

      allEntries.push({
        nodePath,
        category,
        line: `- **${nodePath}**${pinStr} — ${gist}${edgeStr}${antiEdgeStr}`,
        confidence,
        project: nodeProject,
        pinned: parsed.data.pinned === true,
        lastAccessedAt: defaultLastAccessedAt(parsed.data),
      });
    } catch {
      // Skip
    }
  }

  if (allEntries.length > CONFIG.graph.maxNodesBeforePrune) {
    activityBus.log(
      "system:info",
      `Active node count ${allEntries.length} exceeds soft MAP prune threshold ${CONFIG.graph.maxNodesBeforePrune}; skipping automatic archival during MAP generation.`,
    );
  }

  const header = `# MAP — Knowledge Graph Index\n\n> Auto-generated. Purely declarative. Soma in SOMA.md, dreams in DREAMS.md.\n> Each entry: path | gist | edges. ~50-80 tokens per entry.\n`;
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
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const orderDiff = projectOrder(a) - projectOrder(b);
    if (orderDiff !== 0) return orderDiff;
    const categoryDiff = mapCategoryPriority(a.category) - mapCategoryPriority(b.category);
    if (categoryDiff !== 0) return categoryDiff;
    return b.confidence - a.confidence;
  });

  // Group by category first, then allocate per-category budgets
  const categoryEntries = new Map<string, MapEntry[]>();
  for (const entry of allEntries) {
    const cat = entry.nodePath.split("/")[0];
    if (!categoryEntries.has(cat)) categoryEntries.set(cat, []);
    categoryEntries.get(cat)!.push(entry);
  }

  const totalBudget = CONFIG.graph.maxMapTokens - headerTokens;
  const reserveTokens = 240;

  const includedEntries: MapEntry[] = [];
  const overflow: MapEntry[] = [];
  let usedTokens = 0;

  const orderedCategories = [...categoryEntries.entries()].sort((a, b) => {
    const catDiff = mapCategoryPriority(a[0]) - mapCategoryPriority(b[0]);
    if (catDiff !== 0) return catDiff;
    return b[1].length - a[1].length;
  });

  for (const [category, entries] of orderedCategories) {
    const categoryCap = mapCategoryCap(category);
    const guaranteed = entries.slice(0, categoryCap);
    const rest = entries.slice(categoryCap);
    for (const entry of guaranteed) {
      const entryTokens = estimateTokens(entry.line + "\n");
      if (usedTokens + entryTokens > totalBudget - reserveTokens) {
        overflow.push(entry);
        continue;
      }
      usedTokens += entryTokens;
      includedEntries.push(entry);
    }
    overflow.push(...rest);
  }

  overflow.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const orderDiff = projectOrder(a) - projectOrder(b);
    if (orderDiff !== 0) return orderDiff;
    const categoryDiff = mapCategoryPriority(a.category) - mapCategoryPriority(b.category);
    if (categoryDiff !== 0) return categoryDiff;
    if (b.lastAccessedAt !== a.lastAccessedAt) return b.lastAccessedAt - a.lastAccessedAt;
    return b.confidence - a.confidence;
  });

  for (const entry of overflow) {
    const entryTokens = estimateTokens(entry.line + "\n");
    if (usedTokens + entryTokens > totalBudget - reserveTokens) continue;
    usedTokens += entryTokens;
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

  if (categories.size === 0) {
    newMAP += `\n_No nodes yet. The graph will grow as conversations happen._\n`;
  }

  fs.writeFileSync(CONFIG.paths.map, newMAP);

  activityBus.log("graph:map_regenerated", `MAP rebuilt: ${includedEntries.length} entries, ~${estimateTokens(newMAP)} tokens`);
}

// --- SOMA.md generation ---

export function generateSOMA() {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) {
    fs.writeFileSync(CONFIG.paths.soma, "# SOMA — Emotional Engagement Map\n\n_No soma markers yet._\n");
    return;
  }

  const high: string[] = [];
  const moderate: string[] = [];
  const caution: string[] = [];

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const soma = parsed.data.soma;
      if (!soma || !soma.marker) continue;

      const intensity = soma.intensity ?? 0.5;
      const valence = soma.valence || "neutral";
      const line = `- **${nodePath}** — ${soma.marker} (${valence}, ${intensity})`;

      if (intensity > 0.7) {
        high.push(line);
      } else if (intensity >= 0.4) {
        moderate.push(line);
      } else if (valence === "negative" || valence === "cautious") {
        caution.push(line);
      }
    } catch { /* skip */ }
  }

  let content = `# SOMA — Emotional Engagement Map\n\n> Soma markers extracted from nodes. Calibrates engagement intensity.\n`;

  if (high.length > 0) {
    content += `\n## High Intensity (>0.7)\n\n${high.join("\n")}\n`;
  }
  if (moderate.length > 0) {
    content += `\n## Moderate (0.4-0.7)\n\n${moderate.join("\n")}\n`;
  }
  if (caution.length > 0) {
    content += `\n## Caution (<0.4, negative)\n\n${caution.join("\n")}\n`;
  }

  if (high.length === 0 && moderate.length === 0 && caution.length === 0) {
    content += `\n_No soma markers yet._\n`;
  }

  // Enforce token budget
  if (estimateTokens(content) > CONFIG.graph.maxSomaTokens) {
    // Trim moderate section first, then caution
    const lines = content.split("\n");
    while (estimateTokens(lines.join("\n")) > CONFIG.graph.maxSomaTokens && lines.length > 5) {
      lines.pop();
    }
    content = lines.join("\n") + "\n";
  }

  fs.writeFileSync(CONFIG.paths.soma, content);
  activityBus.log("graph:soma_generated", `SOMA.md rebuilt: ${high.length} high, ${moderate.length} moderate, ${caution.length} caution`);
}

// --- WORKING.md generation ---

interface WorkingBucket {
  topics: string[];
  decisions: string[];
  lastTouched: number;
}

interface WorkingRenderResult {
  content: string;
  topicCount: number;
  projectCount: number;
}

interface WorkingCollection {
  globalBucket: WorkingBucket;
  projectBuckets: Array<[string, WorkingBucket]>;
}

function trimToTokenBudget(rendered: WorkingRenderResult, maxTokens: number): string {
  let content = rendered.content;
  if (estimateTokens(content) <= maxTokens) return content;

  const lines = content.split("\n");
  while (estimateTokens(lines.join("\n")) > maxTokens && lines.length > 6) {
    lines.pop();
  }
  content = lines.join("\n").trimEnd() + "\n";
  return content;
}

function pushUnique(items: string[], value: string, limit: number): void {
  const normalized = value.trim();
  if (!normalized) return;
  if (!items.includes(normalized)) {
    items.push(normalized);
  }
  if (items.length > limit) {
    items.splice(limit);
  }
}

function getRecentDeltaFiles(limit = 12): Array<{ filepath: string; mtime: number }> {
  const files: Array<{ filepath: string; mtime: number }> = [];
  for (const dir of [CONFIG.paths.deltas, CONFIG.paths.deltasAudited]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const filepath = path.join(dir, file);
      try {
        files.push({ filepath, mtime: fs.statSync(filepath).mtimeMs });
      } catch { /* skip */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

function getBucket(store: Map<string, WorkingBucket>, key: string): WorkingBucket {
  let bucket = store.get(key);
  if (!bucket) {
    bucket = { topics: [], decisions: [], lastTouched: 0 };
    store.set(key, bucket);
  }
  return bucket;
}

function renderWorkingSection(title: string, bucket: WorkingBucket): string {
  let section = `\n## ${title}\n`;
  if (bucket.topics.length > 0) {
    section += `\n### Active Topics\n\n`;
    for (const topic of bucket.topics) {
      section += `- ${topic}\n`;
    }
  }
  if (bucket.decisions.length > 0) {
    section += `\n### Recent Decisions\n\n`;
    for (const decision of bucket.decisions) {
      section += `- ${decision}\n`;
    }
  }
  return section;
}

function collectWorkingBuckets(): WorkingCollection {
  const buckets = new Map<string, WorkingBucket>();
  const deltaFiles = getRecentDeltaFiles();

  for (const { filepath, mtime } of deltaFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      for (const scribe of data.scribes || []) {
        const explicitProjects = new Set<string>();
        for (const delta of scribe.deltas || []) {
          if (delta.project && delta.project !== "global") {
            explicitProjects.add(delta.project);
          }
        }

        const summaryTargets = explicitProjects.size > 0 ? [...explicitProjects] : ["global"];
        for (const target of summaryTargets) {
          const bucket = getBucket(buckets, target);
          if (scribe.summary) {
            pushUnique(bucket.topics, scribe.summary, 4);
            bucket.lastTouched = Math.max(bucket.lastTouched, mtime);
          }
        }

        for (const delta of scribe.deltas || []) {
          const action = delta.type || delta.action;
          if (action !== "update_stance" || !delta.change) continue;

          const target = delta.project || "global";
          const bucket = getBucket(buckets, target);
          pushUnique(bucket.decisions, `${delta.path}: ${delta.change}`, 4);
          bucket.lastTouched = Math.max(bucket.lastTouched, mtime);
        }
      }
    } catch { /* skip */ }
  }

  return {
    globalBucket: buckets.get("global") || { topics: [], decisions: [], lastTouched: 0 },
    projectBuckets: [...buckets.entries()]
      .filter(([project]) => project !== "global")
      .sort((a, b) => b[1].lastTouched - a[1].lastTouched),
  };
}

function buildAggregateWorkingContent(currentProject?: string): WorkingRenderResult {
  const { globalBucket, projectBuckets } = collectWorkingBuckets();
  const projectFilter = currentProject && currentProject !== "global" ? currentProject : null;

  if (globalBucket.topics.length === 0 && globalBucket.decisions.length === 0 && projectBuckets.length === 0) {
    return {
      content: `# WORKING — Volatile Working Memory\n\n> Recent session context across active projects. Auto-generated from latest deltas.\n\n_No recent activity._\n`,
      topicCount: 0,
      projectCount: 0,
    };
  }

  let content = `# WORKING — Volatile Working Memory\n\n> Recent session context across active projects. Auto-generated from latest deltas.\n`;
  let topicCount = globalBucket.topics.length;

  if (projectFilter) {
    const currentBucket = projectBuckets.find(([project]) => project === projectFilter)?.[1] || {
      topics: [],
      decisions: [],
      lastTouched: 0,
    };
    const mergedCurrent: WorkingBucket = {
      topics: [...currentBucket.topics],
      decisions: [...currentBucket.decisions],
      lastTouched: Math.max(currentBucket.lastTouched, globalBucket.lastTouched),
    };
    for (const topic of globalBucket.topics) pushUnique(mergedCurrent.topics, topic, 6);
    for (const decision of globalBucket.decisions) pushUnique(mergedCurrent.decisions, decision, 6);

    if (mergedCurrent.topics.length > 0 || mergedCurrent.decisions.length > 0) {
      content += renderWorkingSection(`Current Project — ${projectFilter}`, mergedCurrent);
    }

    const others = projectBuckets.filter(([project]) => project !== projectFilter).slice(0, 3);
    if (others.length > 0) {
      content += `\n## Other Active Projects\n`;
      for (const [project, bucket] of others) {
        content += `\n### ${project}\n`;
        for (const topic of bucket.topics.slice(0, 2)) {
          content += `- ${topic}\n`;
        }
        for (const decision of bucket.decisions.slice(0, 1)) {
          content += `- ${decision}\n`;
        }
      }
    }

    topicCount += currentBucket.topics.length + others.reduce((count, [, bucket]) => count + bucket.topics.length, 0);
  } else {
    if (globalBucket.topics.length > 0 || globalBucket.decisions.length > 0) {
      content += renderWorkingSection("Global", globalBucket);
    }

    const activeProjects = projectBuckets.slice(0, 4);
    if (activeProjects.length > 0) {
      content += `\n## Project Tracks\n`;
      for (const [project, bucket] of activeProjects) {
        content += renderWorkingSection(project, bucket);
        topicCount += bucket.topics.length;
      }
    }
  }

  if (content.endsWith("Auto-generated from latest deltas.\n")) {
    content += `\n_No recent activity._\n`;
  }

  return {
    content,
    topicCount,
    projectCount: projectBuckets.length + (globalBucket.topics.length > 0 || globalBucket.decisions.length > 0 ? 1 : 0),
  };
}

function buildGlobalWorkingContent(globalBucket: WorkingBucket): string {
  const rendered: WorkingRenderResult = {
    content: `# WORKING — Global Track\n\n> Cross-project carryover and global working memory.\n`,
    topicCount: globalBucket.topics.length,
    projectCount: globalBucket.topics.length > 0 || globalBucket.decisions.length > 0 ? 1 : 0,
  };

  if (globalBucket.topics.length > 0 || globalBucket.decisions.length > 0) {
    rendered.content += renderWorkingSection("Global Carryover", globalBucket);
  } else {
    rendered.content += `\n_No recent activity._\n`;
  }

  return trimToTokenBudget(rendered, Math.max(800, Math.floor(CONFIG.graph.maxWorkingTokens * 0.35)));
}

function buildProjectWorkingContent(projectName: string, bucket?: WorkingBucket): string {
  const rendered: WorkingRenderResult = {
    content: `# WORKING — ${projectName}\n\n> Project-specific working memory for this Claude session.\n`,
    topicCount: bucket?.topics.length || 0,
    projectCount: bucket ? 1 : 0,
  };

  if (bucket && (bucket.topics.length > 0 || bucket.decisions.length > 0)) {
    rendered.content += renderWorkingSection("Current Project", bucket);
  } else {
    rendered.content += `\n_No recent activity for this project._\n`;
  }

  return trimToTokenBudget(rendered, Math.max(1600, Math.floor(CONFIG.graph.maxWorkingTokens * 0.75)));
}

function writeWorkingArtifacts(currentProject?: string): WorkingRenderResult {
  ensureWorkingDirectories();
  const { globalBucket, projectBuckets } = collectWorkingBuckets();
  const aggregate = buildAggregateWorkingContent(currentProject);
  fs.writeFileSync(CONFIG.paths.working, trimToTokenBudget(aggregate, CONFIG.graph.maxWorkingTokens));
  fs.writeFileSync(CONFIG.paths.workingGlobal, buildGlobalWorkingContent(globalBucket));

  return aggregate;
}

export function generateWORKING() {
  const working = writeWorkingArtifacts();
  activityBus.log(
    "graph:working_generated",
    `WORKING.md rebuilt: ${working.topicCount} topics across ${working.projectCount} project buckets`
  );
}

// --- Project-aware WORKING.md generation (session-start) ---

export function generateProjectAwareWORKING(currentProject: string) {
  writeWorkingArtifacts(currentProject);
}

// --- DREAMS.md generation ---

export function generateDREAMS() {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");

  let content = `# DREAMS — Speculative Fragments\n\n> Pending dream fragments from creative recombination. Sorted by confidence.\n`;

  if (!fs.existsSync(pendingDir)) {
    content += `\n_No pending dreams._\n`;
    fs.writeFileSync(CONFIG.paths.dreamsContext, content);
    return;
  }

  const dreamFiles = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json"));
  if (dreamFiles.length === 0) {
    content += `\n_No pending dreams._\n`;
    fs.writeFileSync(CONFIG.paths.dreamsContext, content);
    return;
  }

  const dreams: Array<{ type: string; confidence: number; fragment: string; refs: string[] }> = [];

  for (const f of dreamFiles) {
    try {
      const dream = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf-8"));
      dreams.push({
        type: dream.type || "connection",
        confidence: dream.confidence ?? 0.3,
        fragment: dream.fragment || "",
        refs: dream.nodes_referenced || [],
      });
    } catch { /* skip */ }
  }

  // Sort by confidence descending
  dreams.sort((a, b) => b.confidence - a.confidence);

  content += `\n`;
  for (const dream of dreams) {
    content += `- **${dream.type}** (${dream.confidence}): ${dream.fragment} → [${dream.refs.join(", ")}]\n`;
  }

  // Enforce token budget
  if (estimateTokens(content) > CONFIG.graph.maxDreamsContextTokens) {
    const lines = content.split("\n");
    while (estimateTokens(lines.join("\n")) > CONFIG.graph.maxDreamsContextTokens && lines.length > 5) {
      lines.pop();
    }
    content = lines.join("\n") + "\n";
  }

  fs.writeFileSync(CONFIG.paths.dreamsContext, content);
  activityBus.log("graph:dreams_generated", `DREAMS.md rebuilt: ${dreams.length} fragments`);
}

function scorePriorLine(line: string): number {
  let score = 50;
  const stripped = line.replace(/\*\*/g, "").trim();

  if (stripped.length < 80) score += 30;
  else if (stripped.length < 150) score += 15;
  else if (stripped.length > 300) score -= 20;
  if (stripped.length > 500) score -= 15;

  const genericPatterns = [
    /^(always|never|prefer|avoid|before|when|if|treat|follow|use)\s/i,
    /\b(simple|clear|concise|explicit|consistent|reliable|first|before)\b/i,
  ];
  for (const p of genericPatterns) {
    if (p.test(stripped)) score += 10;
  }

  const specificPatterns = [
    /\b(ssh|droplet|ip address|env var|\.env|localhost|port \d+)\b/i,
    /\b(next\.js|react|express|docker|vercel|railway)\b/i,
    /\b(firecrawl|clerk|prisma)\b/i,
    /[a-z_]+-[a-z0-9]+-[a-z0-9]+-[a-f0-9]+/,
    /\b(debugging|troubleshooting|runbook|operational)\b/i,
    /\b(keel3|agent_memory|graph-memory)\b/i,
  ];
  for (const p of specificPatterns) {
    if (p.test(stripped)) score -= 8;
  }

  return score;
}

function truncatePriorsToBudget(priorLines: string[], headerLines: string[], budget: number): string[] {
  if (priorLines.length === 0) return [];

  const scored = priorLines.map((line, idx) => ({ line, idx, score: scorePriorLine(line) }));
  scored.sort((a, b) => b.score - a.score);

  const kept = new Map<number, string>();
  let totalTokens = estimateTokens(headerLines.join("\n"));
  for (const item of scored) {
    const entry = `${kept.size + 1}. ${item.line}`;
    const tokens = estimateTokens(entry);
    if (totalTokens + tokens > budget) continue;
    kept.set(item.idx, item.line);
    totalTokens += tokens;
  }

  const result: string[] = [];
  for (let i = 0; i < priorLines.length; i++) {
    if (kept.has(i)) result.push(kept.get(i)!);
  }
  return result;
}

export function enforcePriorsCap(): void {
  if (!fs.existsSync(CONFIG.paths.priors)) return;
  const content = fs.readFileSync(CONFIG.paths.priors, "utf-8");
  const MAX_PRIORS_TOKENS = CONFIG.graph.maxPriorsTokens || 1500;
  const tokens = estimateTokens(content);
  if (tokens <= MAX_PRIORS_TOKENS) return;

  const lines = content.split("\n");
  const headerEnd = lines.findIndex(l => /^\d+\./.test(l));
  if (headerEnd === -1) return;

  const header = lines.slice(0, headerEnd);
  const priorLines: string[] = [];
  for (const line of lines.slice(headerEnd)) {
    const m = line.match(/^\d+\.\s*(.*)/);
    if (m) priorLines.push(m[1]);
    else if (line.trim()) priorLines.push(line);
  }

  const kept = truncatePriorsToBudget(priorLines, header, MAX_PRIORS_TOKENS);
  const output = [...header, ...kept.map((p, i) => `${i + 1}. ${p}`)].join("\n");
  fs.writeFileSync(CONFIG.paths.priors, output);
  activityBus.log("graph:priors_capped", `PRIORS hard-capped from ${tokens} to ${estimateTokens(output)} tokens (kept ${kept.length}/${priorLines.length} entries by score)`);
}

export function regenerateCoreContextFiles(currentProject?: string) {
  fullRegenerateMAP(currentProject);
  rebuildIndex();
  rebuildArchiveIndex();
  generateSOMA();
  if (currentProject) {
    generateProjectAwareWORKING(currentProject);
  } else {
    generateWORKING();
  }
  enforcePriorsCap();
}

export function regenerateDreamContext() {
  generateDREAMS();
}

// --- Regenerate all five context files ---

export function regenerateAllContextFiles(currentProject?: string) {
  regenerateCoreContextFiles(currentProject);
  regenerateDreamContext();
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
        tags: (fm.tags || []).map((t: any) => String(t)),
        keywords: (fm.keywords || []).map((k: any) => String(k)),
        edges: (fm.edges || [])
          .map((e: any) => ({ target: e.target, type: e.type || "relates_to", weight: e.weight ?? 0.5 }))
          .filter((e: any) => e.target),
        anti_edges: (fm.anti_edges || [])
          .map((e: any) => ({ target: e.target, reason: e.reason || "" }))
          .filter((e: any) => e.target),
        confidence: typeof fm.confidence === "number" ? fm.confidence : 0.5,
        soma_intensity: fm.soma?.intensity || 0,
        updated: fm.updated || fm.created || null,
        last_accessed: fm.last_accessed || fm.updated || fm.created || new Date().toISOString(),
        access_count: fm.access_count || 0,
        recall_action_count: fm.recall_action_count || 0,
        distinct_sessions: fm.distinct_sessions || (fm.access_sessions || []).length,
        access_sessions: (fm.access_sessions || []).slice(-50),
        skillforged_at: fm.skillforged_at || null,
        dream_refs: fm.dream_refs || [],
      };
      if (fm.project) {
        indexEntry.project = fm.project;
      }
      if (fm.pinned) {
        indexEntry.pinned = true;
      }
      index.push(indexEntry);
    } catch {
      // Skip
    }
  }

  fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
}

// --- Archive index rebuild ---

export function rebuildArchiveIndex() {
  const archiveDir = CONFIG.paths.archive;
  if (!fs.existsSync(archiveDir)) return;

  const index: any[] = [];

  for (const { nodePath, filePath } of walkNodes(archiveDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data;

      index.push({
        path: nodePath,
        gist: ((fm.gist || extractFirstParagraph(parsed.content)) as string).slice(0, 200),
        tags: (fm.tags || []).map((t: any) => String(t)),
        keywords: (fm.keywords || []).map((k: any) => String(k)),
        confidence: typeof fm.confidence === "number" ? fm.confidence : 0.5,
        archived_reason: fm.archived_reason || "unknown",
        archived_date: fm.archived_date || null,
      });
    } catch {
      // Skip
    }
  }

  fs.writeFileSync(CONFIG.paths.archiveIndex, JSON.stringify(index, null, 2));
  activityBus.log("graph:archive_index_rebuilt", `Archive index rebuilt: ${index.length} entries`);
}
