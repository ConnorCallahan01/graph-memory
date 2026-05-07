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
  breakdown: {
    accessCountComponent: number;
    recallActionComponent: number;
    sessionSpanComponent: number;
    pinnedComponent: number;
    proceduralComponent: number;
  };
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

export function scoreCandidates(inputIndex?: any[]): SkillforgeCandidate[] {
  if (!CONFIG.skillforge.enabled) return [];

  let index: any[];
  if (inputIndex) {
    index = inputIndex;
  } else {
    if (!fs.existsSync(CONFIG.paths.index)) return [];
    try {
      index = JSON.parse(fs.readFileSync(CONFIG.paths.index, "utf-8"));
    } catch {
      return [];
    }
  }

  const manifestDir = CONFIG.paths.skillforgeManifests;
  const candidates: SkillforgeCandidate[] = [];

  for (const entry of index) {
    if (!entry.path) continue;
    if (entry.path.startsWith("archive/") || entry.path.startsWith(".")) continue;
    if (!entry.project || entry.project === "global") continue;
    if (isWithinCooldown(entry.skillforged_at)) continue;
    if ((entry.access_count || 0) < CONFIG.skillforge.minAccessCount) continue;
    const manifestPath = path.join(manifestDir, `${entry.path.replace(/\//g, "-")}.json`);
    if (fs.existsSync(manifestPath)) continue;

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
      candidates.push({
        nodePath: entry.path,
        score: Math.round(score * 1000) / 1000,
        project: entry.project,
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

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export function computeNodeContentHash(nodePath: string): string {
  const fullPath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!fullPath || !fs.existsSync(fullPath)) return "";

  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const parsed = matter(raw);
    const volatileKeys = ["access_count", "recall_action_count", "distinct_sessions", "access_sessions", "last_accessed", "skillforged_at", "skillforge_manifest"];
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

export function scoreAllNodes(): { scored: number; candidates: number; topCandidates: SkillforgeCandidate[] } {
  const candidates = scoreCandidates();

  activityBus.log("skillforge:scored", `Skillforge scorer: ${candidates.length} candidates above threshold`, {
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 5).map((c) => ({
      path: c.nodePath,
      score: c.score,
      project: c.project,
    })),
  });

  return {
    scored: candidates.length,
    candidates: candidates.length,
    topCandidates: candidates,
  };
}
