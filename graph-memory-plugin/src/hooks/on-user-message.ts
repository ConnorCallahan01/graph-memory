#!/usr/bin/env node
/**
 * UserPromptSubmit hook — captures each user message to the buffer.
 * Also dispatches pending scribes and librarian mid-session (Stop hook stdout
 * is invisible to the agent, so we dispatch here where stdout reaches the agent).
 *
 * Receives JSON on stdin with:
 *   - prompt: the user's message text
 *   - session_id: Claude Code session ID
 *
 * Appends to the per-session conversation buffer.
 */
import fs from "fs";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { diffSessionContextState, readArtifactContent, RefreshArtifact, writeSessionContextState } from "../graph-memory/context-refresh.js";
import { markDirty } from "../graph-memory/dirty-state.js";
import { detectProject } from "../graph-memory/project.js";
import { buildUserPromptAdditionalContext, clearMemoryGateState, writeMemoryGateState } from "../graph-memory/memory-gate.js";
import { getConversationLogPath } from "../graph-memory/session-trace.js";
import { overlap, recencyBoost, projectBoost, ambientRecall, STOPWORDS, EXPLICIT_MEMORY_PATTERNS, CONTINUITY_PATTERNS, PREFERENCE_PATTERNS, REPO_OPERATING_CONTEXT_PATTERNS, pathCategory, categoryGateWeight, countMatches, AmbientRecallResult } from "../graph-memory/scoring.js";
import { somaBoost } from "../graph-memory/soma.js";



function buildContextRefreshBlock(changedArtifacts: RefreshArtifact[], projectName?: string): string | null {
  if (changedArtifacts.length === 0) return null;

  const sections: string[] = [];
  if (changedArtifacts.includes("priors")) {
    const priors = readArtifactContent("priors");
    if (priors) sections.push(priors);
  }
  if (changedArtifacts.includes("soma")) {
    const soma = readArtifactContent("soma");
    if (soma) sections.push(soma);
  }
  if (changedArtifacts.includes("working")) {
    const working = readArtifactContent("working", projectName);
    if (working && !working.includes("No session handoff captured yet")) sections.push(working);
  }
  if (changedArtifacts.includes("map")) {
    sections.push("## MAP Refresh\n\nBackground memory consolidation updated the graph map. Use `graph_memory(action=\"search\")`, `recall`, or `read_node` for the newest graph state in this session.");
  }

  if (sections.length === 0) return null;
  return `<graph-memory-refresh>\nBackground memory updated since your last turn. Refresh your internal view with the sections below.\n\n${sections.join("\n\n---\n\n")}\n</graph-memory-refresh>`;
}

async function main() {
  if (process.env.GRAPH_MEMORY_PIPELINE_CHILD === "1" || process.env.GRAPH_MEMORY_WORKER === "1") return;
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

  // --- Ambient auto-recall ---
  // Output relevant memory context FIRST, before any pipeline dispatch actions.
  const sessionId = input.session_id || `session_${Date.now()}`;
  const recallResult = ambientRecall(input.prompt, CONFIG.paths.index, project.name !== "global" ? project.name : undefined, somaBoost);
  if (recallResult.shouldRequireLookup) {
    writeMemoryGateState({
      sessionId,
      project: project.name,
      prompt: input.prompt,
      required: true,
      blockedCount: 0,
      requiredAt: new Date().toISOString(),
      suggestedPaths: recallResult.suggestedPaths,
    });
  } else {
    clearMemoryGateState(sessionId);
  }

  const additionalContextBlocks: string[] = [];
  if (recallResult.context) {
    additionalContextBlocks.push(recallResult.context);
  }

  // --- Mid-session reinjection when librarian-owned artifacts changed ---
  try {
    const changedArtifacts = diffSessionContextState(sessionId, project.name, ["priors", "soma", "map", "working"]);
    if (changedArtifacts.length > 0) {
      writeSessionContextState(sessionId, project.name);
      const refreshBlock = buildContextRefreshBlock(changedArtifacts, project.name);
      if (refreshBlock) {
        additionalContextBlocks.push(refreshBlock);
      }
    }
  } catch { /* non-critical */ }

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
    source: "user_submit",
  };
  if (project.name !== "global") {
    entry.project = project.name;
  }

  fs.appendFileSync(getConversationLogPath(sessionId), JSON.stringify(entry) + "\n");

  // Keep dirty state fresh
  markDirty(sessionId);

  if (additionalContextBlocks.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildUserPromptAdditionalContext(additionalContextBlocks),
      },
    }));
  }

}

main().catch((err) => {
  console.error(`[graph-memory] on-user-message hook error: ${err.message}`);
  process.exit(0);
});
