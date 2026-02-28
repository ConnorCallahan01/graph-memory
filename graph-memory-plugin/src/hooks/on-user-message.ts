#!/usr/bin/env node
/**
 * UserPromptSubmit hook — captures each user message to the buffer.
 *
 * Receives JSON on stdin with:
 *   - prompt: the user's message text
 *   - session_id: Claude Code session ID
 *
 * Appends directly to conversation.jsonl.
 */
import fs from "fs";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { markDirty } from "../graph-memory/dirty-state.js";
import { detectProject } from "../graph-memory/project.js";

async function main() {
  if (!isGraphInitialized()) return;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return;

  let input: { prompt?: string; session_id?: string; cwd?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (!input.prompt) return;

  // Detect project from cwd
  const cwd = input.cwd || process.cwd();
  const project = detectProject(cwd);

  // Ensure buffer directory exists
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) {
    fs.mkdirSync(bufferDir, { recursive: true });
  }

  const maxLen = 2000;
  const content = input.prompt.length > maxLen
    ? input.prompt.slice(0, maxLen) + "..."
    : input.prompt;

  const entry: Record<string, any> = {
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  };
  if (project.name !== "global") {
    entry.project = project.name;
  }

  fs.appendFileSync(CONFIG.paths.conversationLog, JSON.stringify(entry) + "\n");

  // Keep dirty state fresh
  const sessionId = input.session_id || `session_${Date.now()}`;
  markDirty(sessionId);
}

main().catch((err) => {
  console.error(`[graph-memory] on-user-message hook error: ${err.message}`);
  process.exit(0);
});
