/**
 * Shared scoring utilities for graph-memory search/recall.
 * Used by both MCP tools (tools.ts) and hooks (on-user-message.ts ambient recall).
 */

import fs from "fs";

/** Token overlap ratio: fraction of tokens in `a` that appear in `b`. */
export function overlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let count = 0;
  for (const token of a) {
    if (setB.has(token)) count++;
  }
  return a.length > 0 ? count / a.length : 0;
}

/** Recency boost: 1.2x if accessed within 7 days, 1.0x within 30, 0.8x otherwise. */
export function recencyBoost(lastAccessed?: string): number {
  if (!lastAccessed) return 0.8;
  const daysSince = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 7) return 1.2;
  if (daysSince <= 30) return 1.0;
  return 0.8;
}

/** Project boost: 1.3x for matching project, 0.7x for different, 1.0x for global. */
export function projectBoost(entryProject: string | undefined, currentProject: string | undefined): number {
  if (!entryProject) return 1.0;
  if (!currentProject || currentProject === "global") return 1.0;
  if (entryProject === currentProject) return 1.3;
  return 0.7;
}

export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "but", "or",
  "and", "not", "no", "so", "if", "then", "than", "that", "this", "it",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "what", "how", "when", "where", "why", "which", "who", "whom",
]);

export const EXPLICIT_MEMORY_PATTERNS: RegExp[] = [
  /\bremember\b/i,
  /\brecall\b/i,
  /\bfrom memory\b/i,
  /\bcheck (?:your|the) memory\b/i,
  /\bdive deep into (?:your|the) memory\b/i,
  /\buse (?:your|the) memory\b/i,
];

export const CONTINUITY_PATTERNS: RegExp[] = [
  /\bwhat was\b/i,
  /\bwhat were\b/i,
  /\bagain\b/i,
  /\bcurrently\b/i,
  /\bpreviously\b/i,
  /\bwe just\b/i,
  /\bresume\b/i,
  /\bcontinue\b/i,
  /\btest checklist\b/i,
  /\bnext step\b/i,
];

export const PREFERENCE_PATTERNS: RegExp[] = [
  /\bhow i like\b/i,
  /\bi prefer\b/i,
  /\bmy preference\b/i,
  /\bstyle of (?:this )?repo(?:sitory)?\b/i,
  /\bworkflow\b/i,
  /\bprocess(?:es)?\b/i,
  /\bskills?\b/i,
];

export const REPO_OPERATING_CONTEXT_PATTERNS: RegExp[] = [
  /\bclaude\.md\b/i,
  /\bthis repo(?:sitory)?\b/i,
  /\bbranch\b/i,
  /\bworking(?:\.md)?\b/i,
  /\bpriors\b/i,
  /\bmorning brief\b/i,
];

export function pathCategory(pathValue: string): string {
  return pathValue.split("/")[0] || "";
}

export function categoryGateWeight(pathValue: string): number {
  const category = pathCategory(pathValue);
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

export function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

export interface AmbientRecallResult {
  context: string | null;
  shouldRequireLookup: boolean;
  suggestedPaths: string[];
}

export function ambientRecall(userMessage: string, indexPath: string, currentProject?: string, somaBoostFn?: (intensity: number) => number): AmbientRecallResult {
  if (!fs.existsSync(indexPath)) {
    return { context: null, shouldRequireLookup: false, suggestedPaths: [] };
  }

  const normalizedMessage = userMessage.toLowerCase();

  const tokens = userMessage.toLowerCase().split(/\s+/)
    .map(t => t.replace(/[^a-z0-9-]/g, ""))
    .filter(t => t.length > 1 && !STOPWORDS.has(t));

  if (tokens.length < 2) {
    return { context: null, shouldRequireLookup: false, suggestedPaths: [] };
  }

  let index: any[];
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return { context: null, shouldRequireLookup: false, suggestedPaths: [] };
  }
  if (!Array.isArray(index) || index.length === 0) {
    return { context: null, shouldRequireLookup: false, suggestedPaths: [] };
  }

  const boost = somaBoostFn || ((_i: number) => 1);

  const scored = index
    .map((entry: any) => {
      const gistTokens = (entry.gist || "").toLowerCase().split(/\s+/);
      const tagTokens = (entry.tags || []).map((t: any) => String(t).toLowerCase());
      const keywordTokens = (entry.keywords || []).map((k: any) => String(k).toLowerCase());
      const pathTokens = (entry.path || "").toLowerCase().split(/[\/\-_]/);

      const gistScore = overlap(tokens, gistTokens) * 3;
      const tagScore = overlap(tokens, tagTokens) * 2;
      const keywordScore = overlap(tokens, keywordTokens) * 1;
      const pathScore = overlap(tokens, pathTokens) * 1.5;

      const baseRelevance = (gistScore + tagScore + keywordScore + pathScore) * (entry.confidence || 0.5);
      const relevance = baseRelevance
        * recencyBoost(entry.last_accessed)
        * boost(entry.soma_intensity || 0)
        * projectBoost(entry.project, currentProject)
        * categoryGateWeight(entry.path || "");

      return { path: entry.path, gist: entry.gist, relevance };
    })
    .filter((e: any) => e.relevance > 0.15)
    .sort((a: any, b: any) => b.relevance - a.relevance)
    .slice(0, 3);

  if (scored.length === 0) {
    return { context: null, shouldRequireLookup: false, suggestedPaths: [] };
  }

  const lines = scored.map((r: any) =>
    `- **${r.path}** (${r.relevance.toFixed(2)}): ${(r.gist || "").slice(0, 150)}`
  );

  const topRelevance = scored[0]?.relevance || 0;
  const strongMatches = scored.filter((entry: any) => entry.relevance >= 0.25).length;
  const explicitMemoryHits = countMatches(normalizedMessage, EXPLICIT_MEMORY_PATTERNS);
  const continuityHits = countMatches(normalizedMessage, CONTINUITY_PATTERNS);
  const preferenceHits = countMatches(normalizedMessage, PREFERENCE_PATTERNS);
  const repoContextHits = countMatches(normalizedMessage, REPO_OPERATING_CONTEXT_PATTERNS);
  const intentScore = (explicitMemoryHits * 3) + (continuityHits * 2) + (preferenceHits * 2) + repoContextHits;
  const topCategory = pathCategory(scored[0]?.path || "");
  const favoredCategory = ["preferences", "patterns", "decisions", "projects", "procedures", "architecture", "concepts"].includes(topCategory);
  const shouldRequireLookup =
    explicitMemoryHits > 0 ||
    (intentScore >= 3 && topRelevance >= 0.22) ||
    (intentScore >= 2 && strongMatches >= 2) ||
    (favoredCategory && topRelevance >= 0.38) ||
    topRelevance >= 0.58 ||
    strongMatches >= 3;

  return {
    context: `<graph-memory-context>\nRelevant memory nodes for this message:\n${lines.join("\n")}\n\nUse graph_memory(action="read_node", path="...") for full content.\n</graph-memory-context>`,
    shouldRequireLookup,
    suggestedPaths: scored.map((entry: any) => entry.path),
  };
}
