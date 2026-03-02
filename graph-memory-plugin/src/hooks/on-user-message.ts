#!/usr/bin/env node
/**
 * UserPromptSubmit hook — captures each user message to the buffer.
 * Also dispatches pending scribes mid-session (Stop hook stdout is invisible
 * to the agent, so we dispatch here where stdout reaches the agent context).
 *
 * Receives JSON on stdin with:
 *   - prompt: the user's message text
 *   - session_id: Claude Code session ID
 *
 * Appends directly to conversation.jsonl.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { markDirty } from "../graph-memory/dirty-state.js";
import { detectProject } from "../graph-memory/project.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, "../../agents");

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

  // Dispatch pending scribe mid-session.
  // The Stop hook writes .scribe-pending but its stdout is invisible to the agent.
  // UserPromptSubmit stdout IS visible, so we dispatch here.
  if (fs.existsSync(CONFIG.paths.scribePending)) {
    try {
      const stat = fs.statSync(CONFIG.paths.scribePending);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 3600_000) {
        // Stale marker (>1 hour) — clean up
        console.error("[graph-memory] Removing stale scribe-pending marker (>1 hour old).");
        fs.unlinkSync(CONFIG.paths.scribePending);
      } else {
        const marker = JSON.parse(fs.readFileSync(CONFIG.paths.scribePending, "utf-8"));
        const scribePromptPath = path.join(AGENTS_DIR, "memory-scribe.md");
        const graphRoot = CONFIG.paths.graphRoot;
        const projectCtx = marker.project ? ` Current project: ${marker.project} (use this for classifying deltas as global vs project-scoped).` : "";
        console.log(`<graph-memory-action>SCRIBE PENDING: Use the Task tool with subagent_type="general-purpose", model="sonnet", and run_in_background=true. Prompt: "Read the scribe instructions at ${scribePromptPath}, then follow them. Snapshot file: ${marker.snapshotPath}, session ID: ${marker.sessionId}, graph root: ${graphRoot}.${projectCtx} Read the snapshot, read MAP.md, then read only the 2-5 existing nodes most relevant to the conversation for context. Extract deltas, write to .deltas/ directory, then remove .scribe-pending marker."</graph-memory-action>`);
      }
    } catch {
      // Unreadable marker — remove it
      try { fs.unlinkSync(CONFIG.paths.scribePending); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error(`[graph-memory] on-user-message hook error: ${err.message}`);
  process.exit(0);
});
