import { CONFIG } from "../config.js";
import { detectProject, ProjectInfo, writeActiveProject, cleanActiveProjects, removeActiveProject, readActiveProject } from "../project.js";
import { hasMentalModelData, buildSessionStartContext as buildModelContext } from "../session-start-context.js";
import { isDirty, markDirty, clearDirty } from "../dirty-state.js";
import { writeSessionContextState, clearSessionContextState } from "../context-refresh.js";
import { ensureProjectWorkingFile } from "../project-working.js";
import { getWorkingInjectionPaths } from "../working-files.js";
import { enqueueJob } from "../pipeline/job-queue.js";
import { activityBus } from "../events.js";
import matter from "gray-matter";
import fs from "fs";
import path from "path";

function buildProjectMAPShared(projectName: string, budget: number): string | null {
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

  const output: string[] = [];
  const sortedCats = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b));
  let tokensUsed = 0;

  for (const [cat, entries] of sortedCats) {
    const projectEntries = entries.filter(e => e.projectRelevant);
    const otherEntries = entries.filter(e => !e.projectRelevant);

    const selected = [
      ...projectEntries.sort((a, b) => b.confidence - a.confidence).slice(0, 8),
      ...otherEntries.sort((a, b) => b.confidence - a.confidence).slice(0, 2),
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

export interface SessionStartContext {
  project: ProjectInfo;
  sessionId: string;
  mentalModelUsed: boolean;
  tokensUsed: number;
}

export function buildSessionStartContext(cwd: string, sessionId: string): SessionStartContext {
  const project = detectProject(cwd);
  writeActiveProject(sessionId, { name: project.name, gitRoot: project.gitRoot, cwd });
  cleanActiveProjects();

  let mentalModelUsed = false;
  let tokensUsed = 0;

  if (hasMentalModelData()) {
    const ctx = buildModelContext(project.name);
    if (!ctx.sources.fallback && ctx.context) {
      mentalModelUsed = true;
      tokensUsed = ctx.tokensUsed;
      markDirty(sessionId);
      writeSessionContextState(sessionId, project.name);
      return { project, sessionId, mentalModelUsed, tokensUsed };
    }
  }

  return { project, sessionId, mentalModelUsed: false, tokensUsed };
}

export function buildV2Injection(project: ProjectInfo): string {
  const maxSessionTokens = CONFIG.graph.maxSessionStartTokens || 15000;
  const globalBudget = 4000;
  const projectBudget = maxSessionTokens - globalBudget;
  const parts: string[] = [];

  const dirtyCheck = isDirty();
  if (dirtyCheck.dirty) {
    parts.push("[graph-memory] Dirty state from a previous session. Background daemon should reconcile.");
  }

  try { ensureProjectWorkingFile(project.name); } catch { /* ok */ }

  const modelPath = path.join(CONFIG.paths.graphRoot, "mind", "model.json");
  try {
    if (fs.existsSync(modelPath)) {
      const modelFile = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
      if (modelFile?.model) {
        const m = modelFile.model;
        const block: string[] = [];
        if (m.guardrails?.length > 0) {
          block.push("## Guardrails\n");
          for (const g of m.guardrails) block.push("- " + g);
        }
        if (m.cognitiveStyle) block.push("\n## Style\n\n" + m.cognitiveStyle);
        if (m.decisionPatterns?.length > 0) {
          block.push("\n## Decision Patterns\n");
          for (const d of m.decisionPatterns) block.push("- " + d);
        }
        if (m.preferences?.length > 0) {
          block.push("\n## Preferences\n");
          for (const p of m.preferences) block.push("- " + p);
        }
        if (m.emotionalProfile) block.push("\n## Engagement\n\n" + m.emotionalProfile);
        if (m.relationalNotes?.length > 0) {
          block.push("\n## Relational Notes\n");
          for (const n of m.relationalNotes) block.push("- " + n);
        }
        if (block.length > 0) {
          parts.push("# Operational Context\n\n" + block.join("\n"));
        }
      }
    }
  } catch { /* ok */ }

  const globalFiles = [
    { filePath: CONFIG.paths.priors, label: "PRIORS" },
    { filePath: CONFIG.paths.soma, label: "SOMA" },
    { filePath: CONFIG.paths.dreamsContext, label: "DREAMS" },
  ];

  for (const { filePath, label } of globalFiles) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) parts.push("## " + label + "\n\n" + content);
    }
  }

  if (project.name !== "global") {
    const workingPath = path.join(CONFIG.paths.workingProjects, project.name.replace(/[^a-zA-Z0-9._-]+/g, "__") + ".md");
    if (fs.existsSync(workingPath)) {
      const content = fs.readFileSync(workingPath, "utf-8").trim();
      if (content) parts.push("## PROJECT WORKING\n\n" + content);
    }
  }

  if (fs.existsSync(CONFIG.paths.index)) {
    try {
      const projectMAP = buildProjectMAPShared(project.name, 5000);
      if (projectMAP) parts.push("## MAP\n\n" + projectMAP);
    } catch { /* skip */ }
  }

  return parts.join("\n\n");
}

export function buildFullInjection(project: ProjectInfo): string {
  const maxSessionTokens = CONFIG.graph.maxSessionStartTokens || 15000;
  const parts: string[] = [];
  let totalTokens = 0;

  if (isDirty().dirty) {
    parts.push("[graph-memory] Dirty state from a previous session. Background daemon should reconcile.");
  }

  try { ensureProjectWorkingFile(project.name); } catch { /* ok */ }

  let whisperPrefix = "";
  if (hasMentalModelData()) {
    try {
      const ctx = buildModelContext(project.name);
      if (!ctx.sources.fallback && ctx.context) {
        whisperPrefix = ctx.context;
        totalTokens += ctx.tokensUsed;
      }
    } catch { /* fall through */ }
  }

  if (!whisperPrefix) {
    const modelPath = path.join(CONFIG.paths.graphRoot, "mind", "model.json");
    if (fs.existsSync(modelPath)) {
      try {
        const modelData = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
        const model = modelData.model || modelData;
        if (model.cognitiveStyle || model.guardrails?.length) {
          const block = renderModelBlock(model);
          const tokens = Math.ceil(block.length / 4);
          if (totalTokens + tokens <= maxSessionTokens) {
            whisperPrefix = block;
            totalTokens += tokens;
          }
        }
      } catch { /* fall through */ }
    }
  }

  const mapBudget = Math.min(CONFIG.graph.maxMapInjectionTokens || 5000, maxSessionTokens - totalTokens);
  const projectMAP = buildProjectMAPShared(project.name, mapBudget);
  if (projectMAP) {
    const tokens = Math.ceil(projectMAP.length / 4);
    if (totalTokens + tokens <= maxSessionTokens) {
      parts.push("# MAP — Knowledge Graph Index\n\n> Project: " + project.name + ". Shows project-relevant + global nodes. Use recall for details.\n\n" + projectMAP);
      totalTokens += tokens;
    }
  }

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

  try {
    const pinned = loadPinnedNodes(project.name, CONFIG.graph.maxPinnedTokens, maxSessionTokens - totalTokens);
    if (pinned.nodes.length > 0) {
      totalTokens += pinned.tokensUsed;
      parts.push("# PINNED — Durable Procedural Memory\n\n> Auto-loaded pinned nodes for this project. Follow these procedures exactly.\n\n" + pinned.nodes.join("\n\n---\n\n"));
    }
  } catch { /* non-critical */ }

  const allParts = whisperPrefix ? [whisperPrefix, ...parts] : parts;
  return allParts.join("\n\n---\n\n");
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
    for (const g of guardrails) lines.push("- " + g);
    lines.push("");
  }

  const preferences = model.preferences;
  if (Array.isArray(preferences) && preferences.length > 0) {
    lines.push("## Preferences", "");
    for (const p of preferences) lines.push("- " + p);
    lines.push("");
  }

  const decisionPatterns = model.decisionPatterns;
  if (Array.isArray(decisionPatterns) && decisionPatterns.length > 0) {
    lines.push("## Decision Patterns", "");
    for (const d of decisionPatterns) lines.push("- " + d);
    lines.push("");
  }

  if (model.emotionalProfile && typeof model.emotionalProfile === "string") {
    lines.push("## Engagement Profile", "");
    lines.push(model.emotionalProfile);
    lines.push("");
  }

  const relationalNotes = model.relationalNotes;
  if (Array.isArray(relationalNotes) && relationalNotes.length > 0) {
    for (const n of relationalNotes) lines.push("- " + n);
    lines.push("");
  }

  return lines.join("\n");
}

function loadPinnedNodes(projectName: string, maxPinned: number, remainingBudget: number): { nodes: string[]; tokensUsed: number } {
  const sections: string[] = [];
  let pinnedTokens = 0;
  const indexPath = CONFIG.paths.index;

  if (!fs.existsSync(indexPath)) return { nodes: [], tokensUsed: 0 };

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    for (const entry of index) {
      if (!entry?.pinned) continue;
      if (entry.project && entry.project !== projectName) continue;

      const nodePath = path.join(CONFIG.paths.nodes, entry.path + ".md");
      if (!fs.existsSync(nodePath)) continue;

      const raw = fs.readFileSync(nodePath, "utf-8");
      const parsed = matter(raw);
      const content = parsed.content.trim();
      const nodeTokens = Math.ceil(raw.length / 4);
      if (pinnedTokens + nodeTokens > maxPinned) continue;
      if (pinnedTokens + nodeTokens > remainingBudget) continue;

      pinnedTokens += nodeTokens;
      sections.push("### " + (parsed.data.title || entry.path) + "\n\n" + content);
    }
  } catch { /* skip */ }

  return { nodes: sections, tokensUsed: pinnedTokens };
}

export function flushAndQueueJobs(sessionId: string, project: string): void {
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) return;

  const sessionLog = path.join(bufferDir, "conversation-" + sessionId + ".jsonl");
  if (!fs.existsSync(sessionLog)) return;

  const snapshotName = "snapshot_" + Date.now() + ".jsonl";
  const snapshotPath = path.join(bufferDir, snapshotName);
  fs.renameSync(sessionLog, snapshotPath);

  enqueueJob({
    type: "scribe",
    payload: { snapshotPath, sessionId, project },
    triggerSource: "session-end",
    idempotencyKey: "scribe:" + snapshotPath,
  });

  enqueueJob({
    type: "observer",
    payload: { snapshotPath, sessionId, project },
    triggerSource: "session-end",
    idempotencyKey: "observer:" + snapshotPath,
  });

  activityBus.log("system:info", "Session end: queued scribe + observer", {
    sessionId,
    project: project || "global",
  });
}

export function cleanupSession(sessionId: string, project: string): void {
  removeActiveProject(sessionId);
  clearSessionContextState(sessionId);
  clearDirty();
}
