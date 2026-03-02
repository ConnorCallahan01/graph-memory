#!/usr/bin/env node
/**
 * Stop hook — captures each assistant response and appends to the buffer.
 *
 * Receives JSON on stdin with:
 *   - last_assistant_message: the assistant's response text
 *   - session_id: Claude Code session ID
 *
 * Appends directly to conversation.jsonl. When buffer reaches threshold,
 * rotates to snapshot and writes .scribe-pending marker for subagent dispatch.
 */
import fs from "fs";
import path from "path";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { detectProject } from "../graph-memory/project.js";

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
}

async function main() {
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

  // Ensure buffer directory exists
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) {
    fs.mkdirSync(bufferDir, { recursive: true });
  }

  const logPath = CONFIG.paths.conversationLog;
  const now = new Date().toISOString();

  // Append assistant message
  const assistantEntry: BufferEntry = { role: "assistant", content: truncate(input.last_assistant_message), timestamp: now };
  fs.appendFileSync(logPath, JSON.stringify(assistantEntry) + "\n");

  // Check if we've hit the scribe threshold
  const bufferContent = fs.readFileSync(logPath, "utf-8").trim();
  const bufferLines = bufferContent.split("\n").filter(Boolean);
  const messageCount = bufferLines.length;

  // Rotate and create scribe-pending marker every N messages.
  // Skip rotation if a scribe is already pending — let the buffer keep accumulating
  // until the current scribe finishes and clears the marker.
  if (messageCount >= CONFIG.session.scribeInterval && !fs.existsSync(CONFIG.paths.scribePending)) {
    // Rotate: save snapshot, clear buffer
    const snapshotName = `snapshot_${Date.now()}.jsonl`;
    const snapshotPath = path.join(bufferDir, snapshotName);
    fs.writeFileSync(snapshotPath, bufferContent + "\n");
    fs.writeFileSync(logPath, "");

    const sessionId = input.session_id || `hook_${Date.now()}`;

    // Detect project for scribe context
    const cwd = input.cwd || process.cwd();
    const project = detectProject(cwd);

    // Write .scribe-pending marker — dispatched by UserPromptSubmit hook (not here;
    // Stop hook stdout is not visible to the agent).
    const marker: Record<string, any> = {
      snapshotPath,
      sessionId,
      graphRoot: CONFIG.paths.graphRoot,
      createdAt: new Date().toISOString(),
    };
    if (project.name !== "global") {
      marker.project = project.name;
    }
    fs.writeFileSync(CONFIG.paths.scribePending, JSON.stringify(marker));
    console.error(`[graph-memory] Buffer rotated (${messageCount} messages). Scribe marker written — dispatch on next user message.`);
  }
}

main().catch((err) => {
  console.error(`[graph-memory] on-assistant-response hook error: ${err.message}`);
  process.exit(0);
});
