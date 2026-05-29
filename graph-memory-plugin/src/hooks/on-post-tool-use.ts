#!/usr/bin/env node
import fs from "fs";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { detectProject } from "../graph-memory/project.js";
import { appendToolTrace, getConversationLogPath } from "../graph-memory/session-trace.js";

async function main() {
  if (process.env.GRAPH_MEMORY_PIPELINE_CHILD === "1" || process.env.GRAPH_MEMORY_WORKER === "1") return;
  if (!isGraphInitialized()) return;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : `session_${Date.now()}`;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const project = detectProject(cwd);
  appendToolTrace(sessionId, "post", input, { project: project.name, cwd });

  if (input.tool_name === "AskUserQuestion" && input.tool_response) {
    const resp = input.tool_response as Record<string, unknown>;
    const answers = resp.answers as Record<string, string> | undefined;
    if (answers && Object.keys(answers).length > 0) {
      const parts = Object.entries(answers).map(([q, a]) => `${q}: ${a}`);
      const content = parts.join("; ");
      const bufferDir = CONFIG.paths.buffer;
      if (!fs.existsSync(bufferDir)) {
        fs.mkdirSync(bufferDir, { recursive: true });
      }

      const entry: Record<string, any> = {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        source: "ask_user_question",
      };
      if (project.name !== "global") {
        entry.project = project.name;
      }

      fs.appendFileSync(getConversationLogPath(sessionId), JSON.stringify(entry) + "\n");
    }
  }
}

main().catch((err) => {
  console.error(`[graph-memory] on-post-tool-use hook error: ${err.message}`);
  process.exit(0);
});
