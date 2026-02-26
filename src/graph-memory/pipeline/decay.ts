import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { walkNodes } from "../utils.js";

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
  const now = new Date();
  let decayedCount = 0;
  let archivedCount = 0;

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      // Skip nodes that were reinforced this session
      if (reinforcedPaths.has(nodePath)) {
        // Reset updated timestamp for reinforced nodes
        parsed.data.updated = now.toISOString().slice(0, 10);
        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
        continue;
      }

      const baseConfidence = typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5;
      const decayRate = typeof parsed.data.decay_rate === "number" ? parsed.data.decay_rate : 0.05;
      const updatedStr = parsed.data.updated || parsed.data.created;

      if (!updatedStr) continue; // Can't decay without a date

      const updatedDate = new Date(updatedStr);
      const daysSince = (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince < 1) continue; // No decay within 24h

      // Half-life formula
      const effectiveConfidence = baseConfidence * Math.pow(0.5, (daysSince / halfLifeDays) * (decayRate / 0.05));

      if (effectiveConfidence < archiveThreshold) {
        // Auto-archive
        const destDir = path.join(CONFIG.paths.archive, path.dirname(nodePath) || ".");
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const destPath = path.join(CONFIG.paths.archive, `${nodePath}.md`);
        // Update confidence before archiving
        parsed.data.confidence = effectiveConfidence;
        parsed.data.archived_reason = "decay";
        parsed.data.archived_date = now.toISOString().slice(0, 10);
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
        parsed.data.confidence = Math.round(effectiveConfidence * 1000) / 1000;
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

  return { decayed: decayedCount, archived: archivedCount };
}
