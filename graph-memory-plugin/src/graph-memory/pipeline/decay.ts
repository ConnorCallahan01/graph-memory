import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { walkNodes } from "../utils.js";
import { rebuildArchiveIndex } from "./graph-ops.js";

function patchFrontmatterFields(raw: string, fields: Record<string, string | number | boolean>): string {
  const closeIdx = raw.indexOf("---", 3);
  if (closeIdx === -1) return raw;
  let fm = raw.substring(3, closeIdx);
  for (const [key, value] of Object.entries(fields)) {
    const yamlVal = typeof value === "string" ? `'${value}'` : String(value);
    const re = new RegExp(`^${key}:\\s.*$`, "m");
    if (re.test(fm)) {
      fm = fm.replace(re, `${key}: ${yamlVal}`);
    } else {
      fm = fm.trimEnd() + `\n${key}: ${yamlVal}\n`;
    }
  }
  return `---${fm}---` + raw.substring(closeIdx + 3);
}

function parseAnchorDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDecayAnchor(data: Record<string, any>): Date | null {
  const candidates = [
    parseAnchorDate(data.last_decay_at),
    parseAnchorDate(data.updated),
    parseAnchorDate(data.created),
  ].filter((value): value is Date => value instanceof Date);

  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((date) => date.getTime())));
}

function getNodeCategory(nodePath: string): string {
  return nodePath.split("/")[0] || "";
}

function isProtectedCategory(nodePath: string): boolean {
  const category = getNodeCategory(nodePath);
  return CONFIG.graph.decayProtectedCategories.includes(category);
}

/**
 * Decay system: nodes that aren't reinforced lose confidence over time.
 * Uses half-life formula: effective = confidence * (0.5 ^ (daysSince / halfLife * decayRate))
 *
 * Called by librarian before applying LLM results.
 * Nodes below decayArchiveThreshold get auto-archived.
 */
export function runDecay(reinforcedPaths: Set<string> = new Set()): {
  decayed: number;
  archived: number;
} {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return { decayed: 0, archived: 0 };

  const halfLifeDays = CONFIG.graph.decayHalfLifeDays;
  const archiveThreshold = CONFIG.graph.decayArchiveThreshold;
  const confidenceFloor = CONFIG.graph.decayConfidenceFloor;
  const recentAccessGraceDays = CONFIG.graph.decayRecentAccessGraceDays;
  const archiveAccessProtectionDays = CONFIG.graph.decayRecentAccessArchiveProtectionDays;
  const archiveAccessCountProtection = CONFIG.graph.decayAccessCountArchiveProtection;
  const now = new Date();
  let decayedCount = 0;
  let archivedCount = 0;

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      const closeIdx = raw.indexOf("---", 3);
      const fmText = closeIdx > 0 ? raw.substring(0, closeIdx) : "";

      const getConfidence = (): number => {
        if (typeof parsed.data.confidence === "number") return parsed.data.confidence;
        const m = fmText.match(/^confidence:\s*(\d+\.?\d*)\s*$/m);
        return m ? parseFloat(m[1]) : 0.5;
      };

      const getLastDecayAt = (): string | undefined => {
        if (typeof parsed.data.last_decay_at === "string") return parsed.data.last_decay_at;
        const m = fmText.match(/^last_decay_at:\s*['"]?([^'"\n]+)['"]?\s*$/m);
        return m ? m[1].trim() : undefined;
      };

      const getPinned = (): boolean => {
        if (typeof parsed.data.pinned === "boolean") return parsed.data.pinned;
        return /^pinned:\s*true\s*$/m.test(fmText);
      };

      const getExempt = (): boolean => {
        if (typeof parsed.data.decay_exempt === "boolean") return parsed.data.decay_exempt;
        return /^decay_exempt:\s*true\s*$/m.test(fmText);
      };

      const getDecayRate = (): number => {
        if (typeof parsed.data.decay_rate === "number") return parsed.data.decay_rate;
        const m = fmText.match(/^decay_rate:\s*(\d+\.?\d*)\s*$/m);
        return m ? parseFloat(m[1]) : 0.05;
      };

      const getAnchorDate = (): Date | null => {
        const lda = getLastDecayAt();
        const candidates = [
          parseAnchorDate(lda),
          parseAnchorDate(parsed.data.updated),
          parseAnchorDate(parsed.data.created),
        ].filter((v): v is Date => v instanceof Date);
        if (candidates.length === 0) return null;
        return new Date(Math.max(...candidates.map(d => d.getTime())));
      };

      if (getPinned()) continue;
      if (getExempt()) continue;

      // Skip nodes that were reinforced this session
      if (reinforcedPaths.has(nodePath)) {
        fs.writeFileSync(filePath, patchFrontmatterFields(raw, { updated: now.toISOString().slice(0, 10), last_decay_at: now.toISOString() }));
        continue;
      }

      const baseConfidence = getConfidence();
      const decayRate = getDecayRate();
      const anchorDate = getAnchorDate();
      const lastAccessedAt = parseAnchorDate(parsed.data.last_accessed);

      if (!anchorDate) continue;

      const daysSince = (now.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceAccess = lastAccessedAt
        ? (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
        : Number.POSITIVE_INFINITY;

      if (daysSince < 1) continue;
      if (daysSinceAccess < recentAccessGraceDays) continue;

      const effectiveConfidence = baseConfidence * Math.pow(0.5, (daysSince / halfLifeDays) * (decayRate / 0.05));
      const recentlyAccessed = daysSinceAccess < archiveAccessProtectionDays;
      const frequentlyAccessed = (parsed.data.access_count || 0) >= archiveAccessCountProtection;
      const hotNode = baseConfidence >= CONFIG.graph.decayHotNodeThreshold;
      const protectedNode = isProtectedCategory(nodePath);
      const canArchive = !protectedNode && !recentlyAccessed && !frequentlyAccessed && !hotNode;

      if (effectiveConfidence < archiveThreshold && canArchive) {
        // Auto-archive
        const destDir = path.join(CONFIG.paths.archive, path.dirname(nodePath) || ".");
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const destPath = path.join(CONFIG.paths.archive, `${nodePath}.md`);
        // Update confidence before archiving
        parsed.data.confidence = effectiveConfidence;
        parsed.data.archived_reason = "decay";
        parsed.data.archived_date = now.toISOString().slice(0, 10);
        parsed.data.last_decay_at = now.toISOString();
        fs.writeFileSync(filePath, patchFrontmatterFields(raw, { confidence: parsed.data.confidence, archived_reason: "decay", archived_date: now.toISOString().slice(0, 10), last_decay_at: now.toISOString() }));
        fs.renameSync(filePath, destPath);

        archivedCount++;
        activityBus.log("graph:node_archived", `Decay archived: ${nodePath} (confidence: ${effectiveConfidence.toFixed(3)})`, {
          path: nodePath,
          effectiveConfidence,
          daysSince,
        });
      } else if (Math.abs(effectiveConfidence - baseConfidence) > 0.001) {
        // Update confidence in place. Non-archivable nodes still decay, but
        // their confidence is floored so they read as low-signal rather than
        // dropping to zero — archival is what removes them, not the floor.
        const decayedConfidence = canArchive
          ? effectiveConfidence
          : Math.max(effectiveConfidence, confidenceFloor);
        const rounded = Math.round(decayedConfidence * 1000) / 1000;
        fs.writeFileSync(filePath, patchFrontmatterFields(raw, { confidence: rounded, last_decay_at: now.toISOString() }));
        decayedCount++;
      }
    } catch {
      // Skip unparseable files
    }
  }

  if (decayedCount > 0 || archivedCount > 0) {
    activityBus.log("librarian:complete", `Decay pass: ${decayedCount} decayed, ${archivedCount} archived`, {
      decayed: decayedCount,
      archived: archivedCount,
    });
  }

  // Rebuild archive index if any nodes were archived
  if (archivedCount > 0) {
    rebuildArchiveIndex();
  }

  return { decayed: decayedCount, archived: archivedCount };
}
