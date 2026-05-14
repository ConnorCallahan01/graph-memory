import { CONFIG } from "../config.js";
import { detectProject, ProjectInfo, writeActiveProject, cleanActiveProjects, removeActiveProject, readActiveProject } from "../project.js";
import { hasV3Data, buildV3Context } from "../session-start-v3.js";
import { isDirty, markDirty, clearDirty } from "../dirty-state.js";
import { writeSessionContextState, clearSessionContextState } from "../context-refresh.js";
import { ensureProjectWorkingFile } from "../project-working.js";
import { enqueueJob } from "../pipeline/job-queue.js";
import { activityBus } from "../events.js";
import fs from "fs";
import path from "path";

export interface SessionStartContext {
  project: ProjectInfo;
  sessionId: string;
  v3Used: boolean;
  tokensUsed: number;
}

export function buildSessionStartContext(cwd: string, sessionId: string): SessionStartContext {
  const project = detectProject(cwd);
  writeActiveProject(sessionId, { name: project.name, gitRoot: project.gitRoot, cwd });
  cleanActiveProjects();

  let v3Used = false;
  let tokensUsed = 0;

  if (hasV3Data()) {
    const v3 = buildV3Context(project.name);
    if (!v3.sources.fallback && v3.context) {
      v3Used = true;
      tokensUsed = v3.tokensUsed;
      markDirty(sessionId);
      writeSessionContextState(sessionId, project.name);
      return { project, sessionId, v3Used, tokensUsed };
    }
  }

  return { project, sessionId, v3Used: false, tokensUsed };
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

  if (fs.existsSync(CONFIG.paths.map)) {
    const content = fs.readFileSync(CONFIG.paths.map, "utf-8").trim();
    if (content) parts.push("## MAP\n\n" + content);
  }

  return parts.join("\n\n");
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
