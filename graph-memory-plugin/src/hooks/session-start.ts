#!/usr/bin/env node
/**
 * Session start hook — loads MAP and PRIORS into agent context.
 * Also handles crash recovery, scribe-pending, and consolidation-pending signals.
 *
 * Called by Claude Code at conversation start via hooks.json.
 * Outputs to stdout which gets injected into the agent's context.
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG, isGraphInitialized } from "../graph-memory/config.js";
import { writeSessionContextState } from "../graph-memory/context-refresh.js";
import { isDirty, markDirty } from "../graph-memory/dirty-state.js";
import { detectProject, writeActiveProject, cleanActiveProjects } from "../graph-memory/project.js";
import { ensureProjectWorkingFile } from "../graph-memory/project-working.js";
import { walkNodes } from "../graph-memory/utils.js";
import { getWorkingInjectionPaths } from "../graph-memory/working-files.js";
import { buildV3Context, hasV3Data } from "../graph-memory/session-start-v3.js";

interface PinnedNodePayload {
  path: string;
  title: string;
  content: string;
  raw: string;
}

function loadPinnedNodesForProject(projectName: string): PinnedNodePayload[] {
  const pinnedFromIndex: PinnedNodePayload[] = [];

  try {
    const indexPath = CONFIG.paths.index;
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      for (const entry of index) {
        if (!entry?.pinned) continue;
        if (entry.project && entry.project !== projectName) continue;

        const nodePath = path.join(CONFIG.paths.nodes, `${entry.path}.md`);
        if (!fs.existsSync(nodePath)) continue;

        const raw = fs.readFileSync(nodePath, "utf-8");
        const parsed = matter(raw);
        pinnedFromIndex.push({
          path: entry.path,
          title: parsed.data.title || entry.path,
          content: parsed.content.trim(),
          raw,
        });
      }
    }
  } catch {
    // Fall back to direct node scan below.
  }

  if (pinnedFromIndex.length > 0) {
    return pinnedFromIndex;
  }

  const pinnedFromNodes: PinnedNodePayload[] = [];
  for (const { nodePath, filePath } of walkNodes(CONFIG.paths.nodes)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      if (parsed.data.pinned !== true) continue;
      if (parsed.data.project && parsed.data.project !== projectName) continue;
      pinnedFromNodes.push({
        path: nodePath,
        title: parsed.data.title || nodePath,
        content: parsed.content.trim(),
        raw,
      });
    } catch {
      // Skip malformed node files.
    }
  }

  return pinnedFromNodes;
}

function renderModelBlock(model: Record<string, unknown>): string {
  const lines: string[] = ["# Mental Model", ""];

  if (model.cognitiveStyle && typeof model.cognitiveStyle === "string") {
    lines.push("## Thinking Style", "");
    lines.push(model.cognitiveStyle);
    lines.push("");
  }

  const guardrails = model.guardrails;
  if (Array.isArray(guardrails) && guardrails.length > 0) {
    lines.push("## Guardrails", "");
    for (const g of guardrails) {
      lines.push(`- ${g}`);
    }
    lines.push("");
  }

  const preferences = model.preferences;
  if (Array.isArray(preferences) && preferences.length > 0) {
    lines.push("## Preferences", "");
    for (const p of preferences) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  const decisionPatterns = model.decisionPatterns;
  if (Array.isArray(decisionPatterns) && decisionPatterns.length > 0) {
    lines.push("## Decision Patterns", "");
    for (const d of decisionPatterns) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (model.emotionalProfile && typeof model.emotionalProfile === "string") {
    lines.push("## Engagement Profile", "");
    lines.push(model.emotionalProfile);
    lines.push("");
  }

  const relationalNotes = model.relationalNotes;
  if (Array.isArray(relationalNotes) && relationalNotes.length > 0) {
    for (const n of relationalNotes) {
      lines.push(`- ${n}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildProjectMAP(projectName: string, budget: number): string | null {
  const indexPath = CONFIG.paths.index;
  if (!fs.existsSync(indexPath)) return null;

  let index: any[];
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch { return null; }

  const categories = new Map<string, Array<{ path: string; line: string; confidence: number; projectRelevant: boolean }>>();

  for (const entry of index) {
    if (!entry.gist) continue;
    const cat = (entry.path || "").split("/")[0] || "uncategorized";
    const isProjectNode = !entry.project || entry.project === projectName;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push({
      path: entry.path,
      line: `- **${entry.path}**${entry.pinned ? " [pinned]" : ""} — ${entry.gist}`,
      confidence: entry.confidence || 0.5,
      projectRelevant: isProjectNode,
    });
  }

  const output: string[] = [
    "# MAP — Knowledge Graph Index",
    "",
    `> Project: ${projectName}. Shows project-relevant + global nodes. Use recall for details.`,
    "",
  ];

  const sortedCats = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b));
  let tokensUsed = Math.ceil(output.join("\n").length / 4);

  for (const [cat, entries] of sortedCats) {
    const projectEntries = entries.filter(e => e.projectRelevant);
    const otherEntries = entries.filter(e => !e.projectRelevant);
    const maxProject = 8;
    const maxOther = 2;

    const selected = [
      ...projectEntries.sort((a, b) => b.confidence - a.confidence).slice(0, maxProject),
      ...otherEntries.sort((a, b) => b.confidence - a.confidence).slice(0, maxOther),
    ];

    if (selected.length === 0) continue;

    const catBlock: string[] = [`## ${cat}`, ""];
    for (const e of selected) catBlock.push(e.line);
    const skipped = entries.length - selected.length;
    if (skipped > 0) catBlock.push(`  ... and ${skipped} more (use recall to explore)`);
    catBlock.push("");

    const catTokens = Math.ceil(catBlock.join("\n").length / 4);
    if (tokensUsed + catTokens > budget) break;

    output.push(...catBlock);
    tokensUsed += catTokens;
  }

  return output.join("\n");
}

async function main() {
  if (process.env.GRAPH_MEMORY_PIPELINE_CHILD === "1" || process.env.GRAPH_MEMORY_WORKER === "1") {
    return;
  }

  if (!isGraphInitialized()) {
    console.log(
      "[graph-memory] Memory not initialized. Run /memory-onboard to set up."
    );
    return;
  }

  // Read stdin for cwd and session_id
  let cwd = process.cwd();
  let sessionId = `session_${Date.now()}`;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) {
      const input = JSON.parse(raw);
      if (input.cwd) cwd = input.cwd;
      if (input.session_id) sessionId = input.session_id;
    }
  } catch { /* use defaults */ }

  // Detect and register active project
  const project = detectProject(cwd);
  writeActiveProject(sessionId, { name: project.name, gitRoot: project.gitRoot, cwd });
  cleanActiveProjects();

  const parts: string[] = [];
  const graphRoot = CONFIG.paths.graphRoot;

  // Inject project context
  if (project.name !== "global") {
    parts.push(`[graph-memory] Active project: ${project.name} (auto-detected)`);
  }

  // v3 path: try whisper-based injection first
  if (hasV3Data()) {
    const v3 = buildV3Context(project.name);

    if (!v3.sources.fallback) {
      if (v3.context) {
        console.log(v3.context);
      }
      console.error("[graph-memory] v3 injection: " + v3.tokensUsed + " tokens" +
        " (global=" + v3.sources.globalWhisper + ", project=" + v3.sources.projectWhisper +
        ", sessions=" + v3.sources.sessionLog + ")");

      markDirty(sessionId);
      writeSessionContextState(sessionId, project.name);
      return;
    }
  }

  // v2 injection: model.json + MAP + WORKING + PINNED + DREAMS

  const dirtyCheck = isDirty();
  if (dirtyCheck.dirty) {
    console.error("[graph-memory] Dirty state detected from a previous session. Background daemon should reconcile queued memory work.");
  }

  try {
    ensureProjectWorkingFile(project.name);
  } catch { /* best effort */ }

  const maxSessionTokens = CONFIG.graph.maxSessionStartTokens || 8000;
  let totalTokens = 0;

  // 1. Global mental model (replaces PRIORS + SOMA)
  const modelPath = path.join(graphRoot, "mind", "model.json");
  if (fs.existsSync(modelPath)) {
    try {
      const modelData = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
      const model = modelData.model || modelData;
      if (model.cognitiveStyle || model.guardrails?.length) {
        const modelBlock = renderModelBlock(model);
        const tokens = Math.ceil(modelBlock.length / 4);
        if (totalTokens + tokens <= maxSessionTokens) {
          parts.push(modelBlock);
          totalTokens += tokens;
        }
      }
    } catch { /* fall through */ }
  }

  // 2. DREAMS (small, always include if present)
  if (fs.existsSync(CONFIG.paths.dreamsContext)) {
    const dreams = fs.readFileSync(CONFIG.paths.dreamsContext, "utf-8").trim();
    if (dreams && !dreams.includes("No pending dreams")) {
      const tokens = Math.ceil(dreams.length / 4);
      if (totalTokens + tokens <= maxSessionTokens) {
        parts.push(dreams);
        totalTokens += tokens;
      }
    }
  }

  // 3. Project MAP (budget-aware)
  const mapBudget = Math.min(CONFIG.graph.maxMapInjectionTokens || 5000, maxSessionTokens - totalTokens);
  const projectMAP = buildProjectMAP(project.name, mapBudget);
  if (projectMAP) {
    const tokens = Math.ceil(projectMAP.length / 4);
    if (totalTokens + tokens <= maxSessionTokens) {
      parts.push(projectMAP);
      totalTokens += tokens;
    }
  }

  // 4. Project WORKING (lean handoff)
  for (const filePath of getWorkingInjectionPaths(project.name)) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content && !content.includes("No recent activity") && !content.includes("No session handoff captured yet")) {
        const tokens = Math.ceil(content.length / 4);
        if (totalTokens + tokens <= maxSessionTokens) {
          parts.push(content);
          totalTokens += tokens;
        }
      }
    }
  }

  // 5. Pinned nodes (project-scoped only)
  try {
    const pinnedEntries = loadPinnedNodesForProject(project.name);
    if (pinnedEntries.length > 0) {
      const sections: string[] = [];
      let pinnedTokens = 0;
      const maxPinned = CONFIG.graph.maxPinnedTokens;

      for (const entry of pinnedEntries) {
        const nodeTokens = Math.ceil(entry.raw.length / 4);
        if (pinnedTokens + nodeTokens > maxPinned) continue;
        if (totalTokens + pinnedTokens + nodeTokens > maxSessionTokens) continue;
        pinnedTokens += nodeTokens;
        sections.push(`### ${entry.title}\n\n${entry.content}`);
      }

      if (sections.length > 0) {
        totalTokens += pinnedTokens;
        parts.push(`# PINNED — Durable Procedural Memory\n\n> Auto-loaded pinned nodes for this project. Follow these procedures exactly.\n\n${sections.join("\n\n---\n\n")}`);
      }
    }
  } catch { /* non-critical */ }

  if (parts.length === 0) {
    console.log("[graph-memory] Memory initialized but empty. It will grow from your conversations.");
  } else {
    console.log(parts.join("\n\n---\n\n"));
  }

  console.error(`[graph-memory] Injection: ${totalTokens}/${maxSessionTokens} tokens`);

  // 4. Mark dirty for this session
  markDirty(sessionId);
  writeSessionContextState(sessionId, project.name);
}

main().catch((err) => {
  console.error(`[graph-memory] Session start hook error: ${err.message}`);
});
