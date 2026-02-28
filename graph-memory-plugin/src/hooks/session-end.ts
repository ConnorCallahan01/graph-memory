#!/usr/bin/env node
/**
 * Session end hook — runs mechanical consolidation (no LLM needed).
 *
 * Phase 1 only: apply deltas, rebuild MAP, run decay, git commit.
 * Librarian and dreamer run as subagents at next session start.
 *
 * Called by Claude Code at conversation end via hooks.json.
 */
import fs from "fs";
import path from "path";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { initializeGraph } from "../graph-memory/index.js";
import { applyDeltas } from "../graph-memory/pipeline/mechanical-apply.js";
import { fullRegenerateMAP, rebuildIndex } from "../graph-memory/pipeline/graph-ops.js";
import { runDecay } from "../graph-memory/pipeline/decay.js";
import { updateManifest } from "../graph-memory/manifest.js";
import { autoCommit } from "../graph-memory/git.js";
import { setConsolidationPending, clearDirty } from "../graph-memory/dirty-state.js";
import { removeActiveProject } from "../graph-memory/project.js";

async function main() {
  if (!isGraphInitialized()) return;

  // Read stdin for session_id to clean up active-project
  let sessionId: string | undefined;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) {
      const input = JSON.parse(raw);
      sessionId = input.session_id;
    }
  } catch { /* ignore */ }

  // Lockfile prevents duplicate runs (SessionEnd can fire twice)
  const lockPath = path.join(CONFIG.paths.graphRoot, ".consolidation.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const lockAge = Date.now() - lockData.pid_time;
      if (lockAge < 300_000) {
        console.error("[graph-memory] Consolidation already running (lockfile exists). Skipping.");
        return;
      }
      console.error("[graph-memory] Removing stale lockfile.");
    } catch {
      // Malformed lock — remove and proceed
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, pid_time: Date.now() }));

  const removeLock = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on("exit", removeLock);
  process.on("SIGTERM", () => { removeLock(); process.exit(0); });
  process.on("SIGINT", () => { removeLock(); process.exit(0); });

  initializeGraph();

  // Flush any remaining buffer to snapshot
  const logPath = CONFIG.paths.conversationLog;
  if (fs.existsSync(logPath)) {
    const bufferContent = fs.readFileSync(logPath, "utf-8").trim();
    if (bufferContent) {
      const snapshotName = `snapshot_${Date.now()}.jsonl`;
      fs.writeFileSync(path.join(CONFIG.paths.buffer, snapshotName), bufferContent + "\n");
      fs.writeFileSync(logPath, "");
      console.error("[graph-memory] Final buffer flushed to snapshot.");
    }
  }

  // Find ALL unprocessed delta files
  const deltasDir = CONFIG.paths.deltas;
  if (!fs.existsSync(deltasDir)) {
    console.error("[graph-memory] No deltas directory. Nothing to consolidate.");
    clearDirty();
    return;
  }

  const deltaFiles = fs.readdirSync(deltasDir)
    .filter(f => f.endsWith(".json"))
    .sort();

  // --- Phase 1: Mechanical apply (no LLM) ---
  const processed: string[] = [];

  for (const deltaFile of deltaFiles) {
    const sessionId = deltaFile.replace(".json", "");

    // Sanity check: does it have scribes?
    const deltaPath = path.join(deltasDir, deltaFile);
    try {
      const raw = fs.readFileSync(deltaPath, "utf-8").trim();
      if (!raw) {
        console.error(`[graph-memory] Removing ${deltaFile}: empty file.`);
        try { fs.unlinkSync(deltaPath); } catch {}
        continue;
      }
      const data = JSON.parse(raw);
      const scribes = data.scribes || [];
      if (scribes.length === 0) {
        console.error(`[graph-memory] Removing ${deltaFile}: no scribes.`);
        try { fs.unlinkSync(deltaPath); } catch {}
        continue;
      }
    } catch {
      try {
        const stat = fs.statSync(deltaPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          console.error(`[graph-memory] Removing ${deltaFile}: unreadable and older than 24h.`);
          fs.unlinkSync(deltaPath);
        } else {
          console.error(`[graph-memory] Skipping ${deltaFile}: unreadable (keeping, < 24h old).`);
        }
      } catch {
        console.error(`[graph-memory] Skipping ${deltaFile}: unreadable.`);
      }
      continue;
    }

    console.error(`[graph-memory] Phase 1: Mechanical apply for ${sessionId}...`);

    try {
      const result = await applyDeltas(sessionId);
      // Mark as processed even if appliedCount is 0 (all deltas attempted)
      processed.push(deltaFile);
      if (result.errors.length > 0) {
        console.error(`[graph-memory] Phase 1 errors for ${sessionId}: ${result.errors.join("; ")}`);
      }
      console.error(`[graph-memory] Phase 1 complete for ${sessionId}: ${result.appliedCount} applied.`);
    } catch (err: any) {
      console.error(`[graph-memory] Phase 1 failed for ${sessionId}: ${err.message}`);
      // Age-based cleanup: remove delta files older than 7 days that keep failing
      try {
        const stat = fs.statSync(deltaPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 7 * 24 * 60 * 60 * 1000) {
          console.error(`[graph-memory] Removing ${deltaFile}: failed processing and older than 7 days.`);
          processed.push(deltaFile);
        }
      } catch { /* skip */ }
    }
  }

  // Run decay
  try {
    runDecay();
  } catch (err: any) {
    console.error(`[graph-memory] Decay failed: ${err.message}`);
  }

  // Rebuild MAP and index
  try {
    fullRegenerateMAP();
    rebuildIndex();
  } catch (err: any) {
    console.error(`[graph-memory] Rebuild failed: ${err.message}`);
  }

  // Clean up active-project file for this session (after MAP rebuild so ordering is correct)
  if (sessionId) {
    removeActiveProject(sessionId);
  }

  // Clean up processed deltas
  for (const f of processed) {
    try { fs.unlinkSync(path.join(deltasDir, f)); } catch {}
  }
  if (processed.length > 0) {
    console.error(`[graph-memory] Cleaned up ${processed.length} processed delta(s).`);
  }

  // Clean up buffer snapshots older than 24 hours (safety net — scribes should delete their own)
  const bufferDir = CONFIG.paths.buffer;
  if (fs.existsSync(bufferDir)) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(bufferDir)) {
      if (!f.startsWith("snapshot_")) continue;
      const filePath = path.join(bufferDir, f);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.error(`[graph-memory] Removed stale snapshot: ${f}`);
        }
      } catch {}
    }
  }

  // Update manifest and commit
  try {
    updateManifest();
    await autoCommit("session end");
    console.error("[graph-memory] Manifest updated, changes committed.");
  } catch (err: any) {
    console.error(`[graph-memory] Post-consolidation failed: ${err.message}`);
  }

  // Signal that librarian/dreamer should run at next session start
  if (processed.length > 0) {
    setConsolidationPending("session end");
  }

  // Clear dirty state
  clearDirty();
}

main().catch((err) => {
  console.error(`[graph-memory] Session end hook error: ${err.message}`);
  process.exit(0);
});
