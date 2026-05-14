/**
 * v3 Graph Index — efficient on-demand querying for Layer 4.
 *
 * Replaces the v2 flat JSON array index with a Map-keyed structure:
 *   { "patterns/ssh-first": { path, gist, tags, ... }, ... }
 *
 * Supports:
 * - O(1) path lookups
 * - Category-based filtering
 * - Project-based filtering
 * - Incremental add/remove (no full rebuild)
 * - Lazy load with mtime-based invalidation
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { walkNodes, extractFirstParagraph } from "../utils.js";
import { activityBus } from "../events.js";

export interface GraphIndexEntry {
  path: string;
  gist: string;
  tags: string[];
  keywords: string[];
  edges: Array<{ target: string; type: string; weight: number }>;
  anti_edges: Array<{ target: string; reason: string }>;
  confidence: number;
  category: string;
  project?: string;
  pinned?: boolean;
  anti_pattern?: boolean;
  decay_exempt?: boolean;
  updated: string | null;
  last_accessed: string | null;
  access_count: number;
  recall_action_count: number;
  soma_intensity: number;
}

interface GraphIndex {
  version: 3;
  entries: Record<string, GraphIndexEntry>;
  categories: Record<string, string[]>;
  projects: Record<string, string[]>;
  builtAt: string;
}

let indexCache: { data: GraphIndex; mtime: number } | null = null;

function indexPath(): string {
  return CONFIG.paths.v3GraphIndex;
}

function loadIndex(): GraphIndex {
  const filePath = indexPath();
  if (!fs.existsSync(filePath)) {
    return { version: 3, entries: {}, categories: {}, projects: {}, builtAt: "" };
  }

  const stat = fs.statSync(filePath);
  if (indexCache && indexCache.mtime === stat.mtimeMs) {
    return indexCache.data;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (raw.version === 3 && raw.entries) {
    indexCache = { data: raw, mtime: stat.mtimeMs };
    return raw;
  }

  return { version: 3, entries: {}, categories: {}, projects: {}, builtAt: "" };
}

function writeIndex(index: GraphIndex): void {
  index.builtAt = new Date().toISOString();
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2));
  indexCache = { data: index, mtime: fs.statSync(indexPath()).mtimeMs };
}

function categorize(nodePath: string): string {
  return nodePath.split("/")[0] || "uncategorized";
}

function addToCategoryIndex(index: GraphIndex, entry: GraphIndexEntry): void {
  const cat = entry.category;
  if (!index.categories[cat]) index.categories[cat] = [];
  if (!index.categories[cat].includes(entry.path)) {
    index.categories[cat].push(entry.path);
  }
}

function removeFromCategoryIndex(index: GraphIndex, nodePath: string): void {
  const cat = categorize(nodePath);
  const list = index.categories[cat];
  if (list) {
    const idx = list.indexOf(nodePath);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) delete index.categories[cat];
  }
}

function addToProjectIndex(index: GraphIndex, entry: GraphIndexEntry): void {
  if (!entry.project) return;
  if (!index.projects[entry.project]) index.projects[entry.project] = [];
  if (!index.projects[entry.project].includes(entry.path)) {
    index.projects[entry.project].push(entry.path);
  }
}

function removeFromProjectIndex(index: GraphIndex, nodePath: string): void {
  for (const [proj, paths] of Object.entries(index.projects)) {
    const idx = paths.indexOf(nodePath);
    if (idx !== -1) {
      paths.splice(idx, 1);
      if (paths.length === 0) delete index.projects[proj];
    }
  }
}

export function entryFromFile(nodePath: string, filePath: string): GraphIndexEntry | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data;

    return {
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
      confidence: typeof fm.confidence === "number" ? fm.confidence : 0.6,
      category: categorize(nodePath),
      ...(fm.project ? { project: fm.project } : {}),
      ...(fm.pinned ? { pinned: true } : {}),
      ...(fm.anti_pattern ? { anti_pattern: true } : {}),
      ...(fm.decay_exempt ? { decay_exempt: true } : {}),
      updated: fm.updated || fm.created || null,
      last_accessed: fm.last_accessed || fm.updated || fm.created || null,
      access_count: fm.access_count || 0,
      recall_action_count: fm.recall_action_count || 0,
      soma_intensity: fm.soma?.intensity || 0,
    };
  } catch {
    return null;
  }
}

export function addToIndex(nodePath: string, filePath: string): void {
  const entry = entryFromFile(nodePath, filePath);
  if (!entry) return;

  const index = loadIndex();

  if (index.entries[nodePath]) {
    removeFromCategoryIndex(index, nodePath);
    removeFromProjectIndex(index, nodePath);
  }

  index.entries[nodePath] = entry;
  addToCategoryIndex(index, entry);
  addToProjectIndex(index, entry);
  writeIndex(index);
}

export function addEntryToIndex(entry: GraphIndexEntry): void {
  const index = loadIndex();

  if (index.entries[entry.path]) {
    removeFromCategoryIndex(index, entry.path);
    removeFromProjectIndex(index, entry.path);
  }

  index.entries[entry.path] = entry;
  addToCategoryIndex(index, entry);
  addToProjectIndex(index, entry);
  writeIndex(index);
}

export function removeFromIndex(nodePath: string): void {
  const index = loadIndex();
  if (!index.entries[nodePath]) return;

  removeFromCategoryIndex(index, nodePath);
  removeFromProjectIndex(index, nodePath);
  delete index.entries[nodePath];
  writeIndex(index);
}

export function rebuildV3Index(): number {
  const graphDir = CONFIG.paths.v3Graph;
  if (!fs.existsSync(graphDir)) return 0;

  const index: GraphIndex = {
    version: 3,
    entries: {},
    categories: {},
    projects: {},
    builtAt: new Date().toISOString(),
  };

  let count = 0;
  for (const { nodePath, filePath } of walkNodes(graphDir)) {
    if (nodePath.startsWith(".") || nodePath.includes("/.")) continue;
    const entry = entryFromFile(nodePath, filePath);
    if (!entry) continue;

    index.entries[nodePath] = entry;
    addToCategoryIndex(index, entry);
    addToProjectIndex(index, entry);
    count++;
  }

  writeIndex(index);
  activityBus.log("system:info", "v3 graph index rebuilt: " + count + " nodes");
  return count;
}

export function lookup(path: string): GraphIndexEntry | null {
  const index = loadIndex();
  return index.entries[path] || null;
}

export function search(query: string, options?: { category?: string; project?: string; limit?: number }): GraphIndexEntry[] {
  const index = loadIndex();
  const tokens = query.toLowerCase().split(/\s+/);
  const limit = options?.limit || 5;

  let candidates: GraphIndexEntry[];

  if (options?.category) {
    candidates = (index.categories[options.category] || [])
      .map((p) => index.entries[p])
      .filter(Boolean);
  } else if (options?.project) {
    const projectPaths = new Set(index.projects[options.project] || []);
    candidates = Object.values(index.entries).filter((e) => !e.project || projectPaths.has(e.path));
  } else {
    candidates = Object.values(index.entries);
  }

  return candidates
    .map((entry) => {
      const gistTokens = entry.gist.toLowerCase().split(/\s+/);
      const tagTokens = entry.tags.map((t) => t.toLowerCase());

      const gistMatch = tokens.filter((t) => gistTokens.some((g) => g.includes(t))).length;
      const tagMatch = tokens.filter((t) => tagTokens.some((tg) => tg.includes(t))).length;
      const score = (gistMatch * 3 + tagMatch * 2) * entry.confidence;

      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry);
}

export function getByCategory(category: string): GraphIndexEntry[] {
  const index = loadIndex();
  return (index.categories[category] || [])
    .map((p) => index.entries[p])
    .filter(Boolean);
}

export function getByProject(project: string): GraphIndexEntry[] {
  const index = loadIndex();
  return (index.projects[project] || [])
    .map((p) => index.entries[p])
    .filter(Boolean);
}

export function getAntiPatterns(project?: string): GraphIndexEntry[] {
  const index = loadIndex();
  let entries = Object.values(index.entries).filter((e) => e.anti_pattern || e.category === "anti-patterns");
  if (project) {
    entries = entries.filter((e) => !e.project || e.project === project);
  }
  return entries;
}

export function getStats(): { totalNodes: number; categories: Record<string, number>; antiPatterns: number; projects: Record<string, number> } {
  const index = loadIndex();
  const categories: Record<string, number> = {};
  for (const [cat, paths] of Object.entries(index.categories)) {
    categories[cat] = paths.length;
  }
  return {
    totalNodes: Object.keys(index.entries).length,
    categories,
    antiPatterns: Object.values(index.entries).filter((e) => e.anti_pattern || e.category === "anti-patterns").length,
    projects: Object.fromEntries(Object.entries(index.projects).map(([p, paths]) => [p, paths.length])),
  };
}

export function invalidateCache(): void {
  indexCache = null;
}
