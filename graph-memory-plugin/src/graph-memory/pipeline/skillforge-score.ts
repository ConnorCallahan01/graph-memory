import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { safePath } from "../utils.js";

export interface SkillforgeCandidate {
  nodePath: string;
  score: number;
  project?: string;
  candidateType: "cluster" | "single_node";
  sourceNodes?: string[];
  clusterSessionCount?: number;
  breakdown: {
    accessCountComponent: number;
    recallActionComponent: number;
    sessionSpanComponent: number;
    pinnedComponent: number;
    proceduralComponent: number;
  };
}

export interface ClusterDef {
  nodes: string[];
  project: string;
  sessionCount: number;
  coAccessScore: number;
}

export function computeSkillforgeScore(entry: {
  access_count?: number;
  recall_action_count?: number;
  distinct_sessions?: number;
  pinned?: boolean;
  path?: string;
  gist?: string;
  project?: string;
  skillforged_at?: string | null;
}): number {
  const sf = CONFIG.skillforge;

  const accessNorm = Math.min((entry.access_count || 0) / sf.minAccessCount, 1);
  const recallNorm = Math.min((entry.recall_action_count || 0) / sf.minRecallActionCount, 1);
  const sessionNorm = Math.min((entry.distinct_sessions || 0) / sf.minDistinctSessions, 1);
  const pinnedVal = entry.pinned ? 1 : 0;
  const proceduralVal = detectProceduralContent(entry.gist || "", entry.path || "");

  const score =
    sf.accessCountWeight * accessNorm +
    sf.recallActionWeight * recallNorm +
    sf.sessionSpanWeight * sessionNorm +
    sf.pinnedBonus * pinnedVal +
    sf.proceduralWeight * proceduralVal;

  return Math.round(score * 1000) / 1000;
}

function detectProceduralContent(gist: string, nodePath: string): number {
  const sf = CONFIG.skillforge;
  const text = `${gist} ${nodePath}`.toLowerCase();
  let matches = 0;
  for (const kw of sf.proceduralKeywords) {
    if (text.includes(kw)) matches++;
  }
  return Math.min(matches / 3, 1);
}

function isWithinCooldown(skillforgedAt: string | null | undefined): boolean {
  if (!skillforgedAt) return false;
  const daysSince = (Date.now() - new Date(skillforgedAt).getTime()) / (1000 * 60 * 60 * 24);
  return !Number.isNaN(daysSince) && daysSince < CONFIG.skillforge.cooldownDays;
}

function loadIndex(): any[] {
  if (!fs.existsSync(CONFIG.paths.index)) return [];
  try {
    return JSON.parse(fs.readFileSync(CONFIG.paths.index, "utf-8"));
  } catch {
    return [];
  }
}

function manifestExists(nodePaths: string[]): boolean {
  const manifestDir = CONFIG.paths.skillforgeManifests;
  const key = nodePaths.sort().join("+").replace(/\//g, "-");
  return fs.existsSync(path.join(manifestDir, `${key}.json`));
}

export function detectClusters(index: any[]): ClusterDef[] {
  const bySession: Record<string, { path: string; project: string }[]> = {};
  for (const entry of index) {
    if (!entry.path || !entry.project || entry.project === "global") continue;
    if (entry.path.startsWith("archive/") || entry.path.startsWith(".")) continue;
    for (const sid of entry.access_sessions || []) {
      if (!bySession[sid]) bySession[sid] = [];
      bySession[sid].push({ path: entry.path, project: entry.project });
    }
  }

  const pairCounts: Record<string, { count: number; projects: Set<string> }> = {};
  for (const nodes of Object.values(bySession)) {
    const unique = [...new Map(nodes.map(n => [n.path, n])).values()];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        if (unique[i].project !== unique[j].project) continue;
        const pair = [unique[i].path, unique[j].path].sort().join("||");
        if (!pairCounts[pair]) pairCounts[pair] = { count: 0, projects: new Set<string>() };
        pairCounts[pair].count++;
        pairCounts[pair].projects.add(unique[i].project);
      }
    }
  }

  const adjacency: Record<string, Map<string, number>> = {};
  for (const [pair, data] of Object.entries(pairCounts)) {
    if (data.count < 2) continue;
    const [a, b] = pair.split("||");
    if (!adjacency[a]) adjacency[a] = new Map();
    if (!adjacency[b]) adjacency[b] = new Map();
    adjacency[a].set(b, data.count);
    adjacency[b].set(a, data.count);
  }

  const visited = new Set<string>();
  const clusters: ClusterDef[] = [];

  const sortedNodes = Object.keys(adjacency).sort(
    (a, b) => adjacency[b].size - adjacency[a].size
  );

  for (const seed of sortedNodes) {
    if (visited.has(seed)) continue;
    const cluster = [seed];
    visited.add(seed);
    const queue = [seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [neighbor, weight] of adjacency[current] || []) {
        if (visited.has(neighbor)) continue;
        if (weight >= 2) {
          cluster.push(neighbor);
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (cluster.length < 2) continue;

    const clusterSessions = new Set<string>();
    let project = "";
    let pairTotal = 0;
    let pairCount = 0;
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const pair = [cluster[i], cluster[j]].sort().join("||");
        if (pairCounts[pair]) {
          pairTotal += pairCounts[pair].count;
          pairCount++;
          const proj = [...pairCounts[pair].projects][0];
          if (!project) project = proj;
        }
      }
    }

    for (const sid of Object.keys(bySession)) {
      const sessionPaths = bySession[sid].map(n => n.path);
      const overlap = cluster.filter(n => sessionPaths.includes(n));
      if (overlap.length >= 2) clusterSessions.add(sid);
    }

    if (clusterSessions.size < 2) continue;
    if (cluster.length > 7) continue;

    const coAccessScore = pairCount > 0 ? pairTotal / pairCount : 0;

    clusters.push({
      nodes: cluster.sort(),
      project,
      sessionCount: clusterSessions.size,
      coAccessScore,
    });
  }

  clusters.sort((a, b) => b.sessionCount - a.sessionCount || b.coAccessScore - a.coAccessScore);
  return clusters;
}

function scoreClusterCandidate(cluster: ClusterDef, index: any[]): SkillforgeCandidate {
  const entries = cluster.nodes.map(n => index.find((e: any) => e.path === n)).filter(Boolean);
  const totalAccess = entries.reduce((s: number, e: any) => s + (e.access_count || 0), 0);
  const totalRecall = entries.reduce((s: number, e: any) => s + (e.recall_action_count || 0), 0);
  const maxSessions = Math.max(...entries.map((e: any) => e.distinct_sessions || 0));
  const anyPinned = entries.some((e: any) => e.pinned);
  const proceduralGists = entries.map((e: any) => e.gist || "").join(" ");
  const proceduralPaths = cluster.nodes.join(" ");

  const sf = CONFIG.skillforge;
  const accessNorm = Math.min(totalAccess / (sf.minAccessCount * cluster.nodes.length), 1);
  const recallNorm = Math.min(totalRecall / (sf.minRecallActionCount * cluster.nodes.length), 1);
  const sessionNorm = Math.min(cluster.sessionCount / sf.minDistinctSessions, 1);
  const pinnedVal = anyPinned ? 1 : 0;
  const proceduralVal = detectProceduralContent(proceduralGists, proceduralPaths);

  const score =
    sf.accessCountWeight * accessNorm +
    sf.recallActionWeight * recallNorm +
    sf.sessionSpanWeight * sessionNorm +
    sf.pinnedBonus * pinnedVal +
    sf.proceduralWeight * proceduralVal;

  return {
    nodePath: cluster.nodes[0],
    score: Math.round(score * 1000) / 1000,
    project: cluster.project,
    candidateType: "cluster",
    sourceNodes: cluster.nodes,
    clusterSessionCount: cluster.sessionCount,
    breakdown: {
      accessCountComponent: Math.round(accessNorm * sf.accessCountWeight * 1000) / 1000,
      recallActionComponent: Math.round(recallNorm * sf.recallActionWeight * 1000) / 1000,
      sessionSpanComponent: Math.round(sessionNorm * sf.sessionSpanWeight * 1000) / 1000,
      pinnedComponent: Math.round(pinnedVal * sf.pinnedBonus * 1000) / 1000,
      proceduralComponent: Math.round(proceduralVal * sf.proceduralWeight * 1000) / 1000,
    },
  };
}

function scoreSingleNodeCandidates(index: any[]): SkillforgeCandidate[] {
  const manifestDir = CONFIG.paths.skillforgeManifests;
  const candidates: SkillforgeCandidate[] = [];
  const clusterNodes = new Set<string>();

  for (const entry of index) {
    if (!entry.path) continue;
    if (entry.path.startsWith("archive/") || entry.path.startsWith(".")) continue;
    if (!entry.project || entry.project === "global") continue;
    if (isWithinCooldown(entry.skillforged_at)) continue;
    if ((entry.access_count || 0) < CONFIG.skillforge.minAccessCount) continue;

    const sf = CONFIG.skillforge;
    const accessNorm = Math.min((entry.access_count || 0) / sf.minAccessCount, 1);
    const recallNorm = Math.min((entry.recall_action_count || 0) / sf.minRecallActionCount, 1);
    const sessionNorm = Math.min((entry.distinct_sessions || 0) / sf.minDistinctSessions, 1);
    const pinnedVal = entry.pinned ? 1 : 0;
    const proceduralVal = detectProceduralContent(entry.gist || "", entry.path || "");

    const score =
      sf.accessCountWeight * accessNorm +
      sf.recallActionWeight * recallNorm +
      sf.sessionSpanWeight * sessionNorm +
      sf.pinnedBonus * pinnedVal +
      sf.proceduralWeight * proceduralVal;

    if (score >= CONFIG.skillforge.scoreThreshold) {
      clusterNodes.add(entry.path);
      candidates.push({
        nodePath: entry.path,
        score: Math.round(score * 1000) / 1000,
        project: entry.project,
        candidateType: "single_node",
        breakdown: {
          accessCountComponent: Math.round(accessNorm * sf.accessCountWeight * 1000) / 1000,
          recallActionComponent: Math.round(recallNorm * sf.recallActionWeight * 1000) / 1000,
          sessionSpanComponent: Math.round(sessionNorm * sf.sessionSpanWeight * 1000) / 1000,
          pinnedComponent: Math.round(pinnedVal * sf.pinnedBonus * 1000) / 1000,
          proceduralComponent: Math.round(proceduralVal * sf.proceduralWeight * 1000) / 1000,
        },
      });
    }
  }

  return candidates.filter(c => !clusterNodes.has(c.nodePath));
}

export function scoreCandidates(inputIndex?: any[]): SkillforgeCandidate[] {
  if (!CONFIG.skillforge.enabled) return [];

  const index = inputIndex || loadIndex();
  if (index.length === 0) return [];

  const clusters = detectClusters(index);
  const clusterCandidates: SkillforgeCandidate[] = [];

  for (const cluster of clusters) {
    if (manifestExists(cluster.nodes)) continue;
    const anyCooldown = cluster.nodes.some(n => {
      const entry = index.find((e: any) => e.path === n);
      return isWithinCooldown(entry?.skillforged_at);
    });
    if (anyCooldown) continue;

    const candidate = scoreClusterCandidate(cluster, index);
    if (candidate.score >= CONFIG.skillforge.scoreThreshold) {
      clusterCandidates.push(candidate);
    }
  }

  const singleCandidates = scoreSingleNodeCandidates(index);

  const all = [...clusterCandidates, ...singleCandidates];
  all.sort((a, b) => b.score - a.score);
  return all;
}

export function computeNodeContentHash(nodePath: string): string {
  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!fullPath || !fs.existsSync(fullPath)) return "";

  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const parsed = matter(raw);
    const volatileKeys = ["access_count", "recall_action_count", "distinct_sessions", "access_sessions", "last_accessed", "skillforged_at", "skillforge_refreshed_at", "skillforge_manifest", "confidence", "last_decay_at", "updated", "decay_rate"];
    for (const key of volatileKeys) {
      delete parsed.data[key];
    }
    const stable = matter.stringify(parsed.content, parsed.data);
    const normalized = stable.trim().replace(/\s+/g, " ");
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const chr = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  } catch {
    return "";
  }
}

export function computeMultiNodeContentHash(nodePaths: string[]): string {
  const hashes = nodePaths.map(p => computeNodeContentHash(p)).filter(Boolean);
  if (hashes.length === 0) return "";
  const combined = hashes.sort().join("+");
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash) + combined.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function scoreAllNodes(): { scored: number; candidates: number; topCandidates: SkillforgeCandidate[] } {
  const candidates = scoreCandidates();
  const clusterCount = candidates.filter(c => c.candidateType === "cluster").length;
  const singleCount = candidates.filter(c => c.candidateType === "single_node").length;

  activityBus.log("skillforge:scored", "Skillforge scorer: " + candidates.length + " candidates (" + clusterCount + " clusters, " + singleCount + " single)", {
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 5).map((c) => ({
      path: c.nodePath,
      score: c.score,
      project: c.project,
      type: c.candidateType,
      sourceNodes: c.sourceNodes,
    })),
  });

  return {
    scored: candidates.length,
    candidates: candidates.length,
    topCandidates: candidates,
  };
}
