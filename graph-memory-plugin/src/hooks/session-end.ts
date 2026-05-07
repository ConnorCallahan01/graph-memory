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
import { clearSessionContextState } from "../graph-memory/context-refresh.js";
import { initializeGraph } from "../graph-memory/index.js";
import { clearDirty } from "../graph-memory/dirty-state.js";
import { detectProject, readActiveProject, removeActiveProject } from "../graph-memory/project.js";
import { enqueueJob, hasActiveJob } from "../graph-memory/pipeline/job-queue.js";
import { getAssistantTracePath, getConversationLogPath, getToolTracePath } from "../graph-memory/session-trace.js";

async function main() {
  if (process.env.GRAPH_MEMORY_PIPELINE_CHILD === "1" || process.env.GRAPH_MEMORY_WORKER === "1") return;
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

  initializeGraph();
  let activeProject = readActiveProject(sessionId);
  if (!activeProject) {
    activeProject = detectProject(process.cwd());
  }

  // Flush any remaining buffer to snapshot and mark for scribe
  const resolvedSessionId = sessionId || `end_${Date.now()}`;

  const logPath = getConversationLogPath(resolvedSessionId);
  if (fs.existsSync(logPath)) {
    const bufferContent = fs.readFileSync(logPath, "utf-8").trim();
    if (bufferContent) {
      const snapshotName = `snapshot_${Date.now()}.jsonl`;
      const snapshotPath = path.join(CONFIG.paths.buffer, snapshotName);
      fs.writeFileSync(snapshotPath, bufferContent + "\n");
      fs.unlinkSync(logPath);
      const assistantTracePath = getAssistantTracePath(resolvedSessionId);
      const toolTracePath = getToolTracePath(resolvedSessionId);
      const queued = enqueueJob({
        type: "scribe",
        payload: {
          snapshotPath,
          sessionId: resolvedSessionId,
          ...(fs.existsSync(assistantTracePath) ? { assistantTracePath } : {}),
          ...(fs.existsSync(toolTracePath) ? { toolTracePath } : {}),
          ...(activeProject?.name && activeProject.name !== "global" ? { project: activeProject.name } : {}),
        },
        triggerSource: "hook:session-end",
        idempotencyKey: `scribe:${snapshotPath}`,
      });
      console.error(`[graph-memory] Final buffer flushed to snapshot. ${queued.created ? "Scribe job queued." : "Scribe job already queued."}`);
    }
  }

  // Clean up active-project file for this session (after MAP rebuild so ordering is correct)
  if (sessionId) {
    removeActiveProject(sessionId);
    clearSessionContextState(sessionId);
  }

  // Clear dirty state
  clearDirty();

  // If enough delta files already exist and no audit job is active, let the daemon pick it up.
  if (fs.existsSync(CONFIG.paths.deltas)) {
    const deltaFileCount = fs.readdirSync(CONFIG.paths.deltas).filter((file) => file.endsWith(".json")).length;
    if (deltaFileCount >= CONFIG.session.auditScribeFileThreshold && !hasActiveJob("auditor")) {
      enqueueJob({
        type: "auditor",
        payload: { reason: `session end saw ${deltaFileCount} active delta files` },
        triggerSource: "hook:session-end-threshold",
        idempotencyKey: `auditor:session-end:${deltaFileCount}`,
      });
    }
  }
}

main().catch((err) => {
  console.error(`[graph-memory] Session end hook error: ${err.message}`);
  process.exit(0);
});
