import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { walkNodes } from "../utils.js";
import { rebuildArchiveIndex } from "./graph-ops.js";

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

      // Skip pinned nodes — they never decay
      if (parsed.data.pinned === true) {
        continue;
      }

      if (parsed.data.decay_exempt === true) {
        continue;
      }

      // Skip nodes that were reinforced this session
      if (reinforcedPaths.has(nodePath)) {
        // Reset updated timestamp for reinforced nodes
        parsed.data.updated = now.toISOString().slice(0, 10);
        parsed.data.last_decay_at = now.toISOString();
        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
        continue;
      }

      const baseConfidence = typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5;
      const decayRate = typeof parsed.data.decay_rate === "number" ? parsed.data.decay_rate : 0.05;
      const anchorDate = getDecayAnchor(parsed.data);
      const lastAccessedAt = parseAnchorDate(parsed.data.last_accessed);

      if (!anchorDate) continue; // Can't decay without a usable date anchor

      const daysSince = (now.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceAccess = lastAccessedAt
        ? (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
        : Number.POSITIVE_INFINITY;

      if (daysSince < 1) continue; // No decay within 24h
      if (daysSinceAccess < recentAccessGraceDays) continue; // Recently used nodes should not decay at all

      // Incremental half-life formula from the last decay/access/update anchor.
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
        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
        fs.renameSync(filePath, destPath);

        archivedCount++;
        activityBus.log("graph:node_archived", `Decay archived: ${nodePath} (confidence: ${effectiveConfidence.toFixed(3)})`, {
          path: nodePath,
          effectiveConfidence,
          daysSince,
        });
      } else if (Math.abs(effectiveConfidence - baseConfidence) > 0.001) {
        // Update confidence in place
        const decayedConfidence = canArchive
          ? effectiveConfidence
          : Math.max(effectiveConfidence, archiveThreshold + 0.02);
        parsed.data.confidence = Math.round(decayedConfidence * 1000) / 1000;
        parsed.data.last_decay_at = now.toISOString();
        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
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
