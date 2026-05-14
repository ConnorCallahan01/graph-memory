#!/usr/bin/env node
/**
 * Stop hook — captures each final assistant response into the canonical buffer.
 * Also syncs visible intermediary assistant text from Claude's local session log
 * into a separate assistant trace for scribe/morning-analysis context.
 *
 * Receives JSON on stdin with:
 *   - last_assistant_message: the assistant's response text
 *   - session_id: Claude Code session ID
 *
 * Appends to the per-session conversation buffer. When buffer reaches threshold,
 * rotates to a snapshot and queues a scribe job.
 */
import fs from "fs";
import path from "path";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { collectVisibleAssistantTrace } from "../graph-memory/claude-transcript.js";
import { clearMemoryGateState } from "../graph-memory/memory-gate.js";
import { detectProject } from "../graph-memory/project.js";
import { enqueueJob } from "../graph-memory/pipeline/job-queue.js";
import { appendAssistantTraceEvents, getAssistantTracePath, getConversationLogPath, getToolTracePath } from "../graph-memory/session-trace.js";

interface StopHookInput {
  session_id: string;
  last_assistant_message: string;
  hook_event_name: string;
  cwd?: string;
}

interface BufferEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  source?: "user_submit" | "stop_hook";
  final?: boolean;
  project?: string;
}

async function main() {
  if (process.env.GRAPH_MEMORY_PIPELINE_CHILD === "1" || process.env.GRAPH_MEMORY_WORKER === "1") return;
  if (!isGraphInitialized()) return;

  // Read hook input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return;

  let input: StopHookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (!input.last_assistant_message) return;

  const maxLen = 2000;
  const truncate = (s: string) =>
    s.length > maxLen ? s.slice(0, maxLen) + "..." : s;

  const sessionId = input.session_id || `hook_${Date.now()}`;
  const cwd = input.cwd || process.cwd();
  const project = detectProject(cwd);

  const transcript = collectVisibleAssistantTrace(sessionId, cwd, {
    project: project.name,
    cwd,
  });
  const assistantTraceEvents = transcript.events.length > 0
    ? transcript.events
    : [{
        type: "assistant_text" as const,
        timestamp: new Date().toISOString(),
        sessionId,
        project: project.name,
        cwd,
        kind: "final" as const,
        text: input.last_assistant_message,
        source: "stop_hook" as const,
        transcriptPath: null,
      }];
  const transcriptResult = appendAssistantTraceEvents(sessionId, assistantTraceEvents);
  const latestTranscriptFinal = [...transcript.events]
    .reverse()
    .find((event) => event.kind === "final");

  // Ensure buffer directory exists
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) {
    fs.mkdirSync(bufferDir, { recursive: true });
  }

  const logPath = getConversationLogPath(sessionId);
  const now = latestTranscriptFinal?.timestamp || new Date().toISOString();

  // Append assistant message
  const assistantEntry: BufferEntry = {
    role: "assistant",
    content: truncate(input.last_assistant_message),
    timestamp: now,
    source: "stop_hook",
    final: true,
    ...(project.name !== "global" ? { project: project.name } : {}),
  };
  fs.appendFileSync(logPath, JSON.stringify(assistantEntry) + "\n");

  // Check if we've hit the scribe threshold
  const bufferContent = fs.readFileSync(logPath, "utf-8").trim();
  const bufferLines = bufferContent.split("\n").filter(Boolean);
  const messageCount = bufferLines.length;

  // Rotate and queue a scribe job every N messages.
  if (messageCount >= CONFIG.session.scribeInterval) {
    // Rotate: save snapshot, clear buffer
    const snapshotName = `snapshot_${Date.now()}.jsonl`;
    const snapshotPath = path.join(bufferDir, snapshotName);
    fs.writeFileSync(snapshotPath, bufferContent + "\n");
    fs.writeFileSync(logPath, "");

    const assistantTracePath = getAssistantTracePath(sessionId);
    const toolTracePath = getToolTracePath(sessionId);

    const { created: scribeCreated } = enqueueJob({
      type: "scribe",
      payload: {
        snapshotPath,
        sessionId,
        ...(fs.existsSync(assistantTracePath) ? { assistantTracePath } : {}),
        ...(fs.existsSync(toolTracePath) ? { toolTracePath } : {}),
        ...(project.name !== "global" ? { project: project.name } : {}),
      },
      triggerSource: "hook:stop-threshold",
      idempotencyKey: `scribe:${snapshotPath}`,
    });

    console.error(`[graph-memory] Buffer rotated (${messageCount} messages). ${scribeCreated ? "Scribe job queued." : "Scribe job already queued."}${transcriptResult.appended > 0 ? ` Synced ${transcriptResult.appended} assistant trace events.` : ""}`);
  }

  clearMemoryGateState(sessionId);
}

main().catch((err) => {
  console.error(`[graph-memory] on-assistant-response hook error: ${err.message}`);
  process.exit(0);
});
