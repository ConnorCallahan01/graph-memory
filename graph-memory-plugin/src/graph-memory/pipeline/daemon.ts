import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG, isGraphInitialized } from "../config.js";
import { initializeGraph } from "../index.js";
import { activityBus } from "../events.js";
import { generatePreflightReport } from "./preflight.js";
import { claimNextJob, completeRunningJob, countJobs, enqueueJob, ensureJobDirectories, failRunningJob, hasActiveJob, hasActiveJobForProject, hasActiveProjectChainJob, getActiveProjectChainProjects, countDeltasForProject, listJobs, requeueRunningJob, requeueStaleRunningJobs, updateRunningJob, PROJECT_CHAIN_TYPES, GLOBAL_CHAIN_TYPES, PRIORITY } from "./job-queue.js";
import { GraphMemoryJob, GraphMemoryJobState, NotionInboundTriagePayload, NotionInboundEnrichPayload } from "./job-schema.js";
import { runPipelineWorker, WorkerRunOptions } from "./worker-runner.js";
import { loadRuntimeConfig } from "../runtime.js";
import { regenerateCoreContextFiles, regenerateDreamContext } from "./graph-ops.js";
import { runDecay } from "./decay.js";
import { updateProjectWorkingFromSession, collectFileInteractions } from "../project-working.js";
import { scoreCandidates, computeNodeContentHash, computeMultiNodeContentHash } from "./skillforge-score.js";
import { listManifests, findDriftedManifests, manifestKeyForNodes } from "./skillforge-manifest.js";import { getAssistantTracePath, getToolTracePath } from "../session-trace.js";
import { getDailyBriefPaths } from "../briefs.js";
import { loadExternalInputsConfig, readRecentClassifiedInputs } from "../external-inputs.js";
import { getProjectWorkingPath, getProjectWorkingStatePath, getProjectWorkingUpdatePath, getFileInteractionPath, getProjectAuditDir, getProjectPreflightPath, getProjectAuditReportPath, getProjectAuditBriefPath, getProjectDreamsDir, getProjectDreamSummaryPath, getProjectLockPath, getGlobalLockPath, ensureAuditDirectories, ensureDreamDirectories, ensureLockDirectories, sanitizeProjectSlug } from "../working-files.js";
import { processObserverOutputs } from "./observer-tools.js";
import { processCompressorOutputs, runAutoPrune } from "./compressor-tools.js";
import { rebuildV3Index as rebuildGraphIndex } from "./graph-index.js";
import { bootstrapProjectDoc, detectDocDrift } from "./bootstrap.js";
import { readNotionSyncState, writeNotionSyncState, buildNotionDiff, writeDiffReport, readSyncPlan, executeNotionSync, buildWorkspaceManifest, writeWorkspaceManifest, mergeStewardPlans, readStewardPlan, StewardPlan } from "./notion-sync.js";
import { checkNtnReady, getPage } from "./notion-cli.js";
import { detectInboundEdits, writeInboundInput, readInboundPlan, applyInboundDeltas, writeInboundDeltas, writeMergeInput, readMergeResult, detectNewComments, buildCommentDetections, detectNewNotionTasks, InboundEdit } from "./notion-inbound.js";
import { startWebhookServer } from "./notion-webhook.js";
import { addNotionPickupItem } from "../project-working.js";
import { appendObservation } from "../mind/observations.js";
import { appendObservation as appendProjectObservation, ensureLens } from "../lenses/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, "../../../agents");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWorkerModel(): string | undefined {
  try {
    const runtime = loadRuntimeConfig();
    return runtime.docker.workerModel || undefined;
  } catch {
    return undefined;
  }
}

async function runWorker(opts: WorkerRunOptions): Promise<{ exitCode: number; logFile: string; pid: number | undefined }> {
  return runPipelineWorker({ ...opts, model: opts.model || resolveWorkerModel() });
}

function acquireDaemonLock(): void {
  ensureJobDirectories();
  const lockPath = CONFIG.paths.daemonLock;

  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const ageMs = Date.now() - (lock.startedAtMs || 0);
      if (ageMs < 10 * 60 * 1000) {
        throw new Error("graph-memory daemon already running");
      }
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      if (err instanceof Error && err.message === "graph-memory daemon already running") {
        throw err;
      }
    }
  }

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
  }, null, 2));
}

function releaseDaemonLock(): void {
  try {
    if (fs.existsSync(CONFIG.paths.daemonLock)) {
      fs.unlinkSync(CONFIG.paths.daemonLock);
    }
  } catch { /* ignore */ }
}

function acquireProjectChainLock(project: string): void {
  ensureLockDirectories();
  const lockPath = getProjectLockPath(project);
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const ageMs = Date.now() - (lock.startedAtMs || 0);
      if (ageMs < 30 * 60 * 1000) {
        throw new Error(`Project chain lock held for ${project}`);
      }
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      if (err instanceof Error && err.message.startsWith("Project chain lock held")) {
        throw err;
      }
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({
    project,
    pid: process.pid,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
  }, null, 2));
}

function releaseProjectChainLock(project: string): void {
  try {
    const lockPath = getProjectLockPath(project);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
}

function acquireGlobalChainLock(): void {
  ensureLockDirectories();
  const lockPath = getGlobalLockPath();
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const ageMs = Date.now() - (lock.startedAtMs || 0);
      if (ageMs < 30 * 60 * 1000) {
        throw new Error("Global chain lock held");
      }
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      if (err instanceof Error && err.message === "Global chain lock held") {
        throw err;
      }
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
  }, null, 2));
}

function releaseGlobalChainLock(): void {
  try {
    const lockPath = getGlobalLockPath();
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
}

function countActiveDeltaFiles(): number {
  if (!fs.existsSync(CONFIG.paths.deltas)) return 0;
  return fs.readdirSync(CONFIG.paths.deltas)
    .filter((file) => file.endsWith(".json"))
    .length;
}

function countCompletedScribesSinceLastAuditor(): { count: number; latestCompletedAt: string | null } {
  const completedAuditors = listJobs("done")
    .filter((job) => job.type === "auditor")
    .map((job) => job.completedAt || job.updatedAt || job.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a));

  const lastAuditorAtMs = completedAuditors[0] ? Date.parse(completedAuditors[0]) : 0;
  let count = 0;
  let latestCompletedAt: string | null = null;

  for (const job of listJobs("done")) {
    if (job.type !== "scribe") continue;
    const completedAt = job.completedAt || job.updatedAt || job.createdAt;
    const completedAtMs = Date.parse(completedAt);
    if (Number.isNaN(completedAtMs) || completedAtMs <= lastAuditorAtMs) continue;
    count += 1;
    if (!latestCompletedAt || completedAtMs > Date.parse(latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }
  }

  return { count, latestCompletedAt };
}

function maybeEnqueueAuditorFromScribeBacklog(reasonPrefix = "successful scribe runs accumulated"): void {
  if (countActiveDeltaFiles() === 0 || hasActiveJob("auditor")) {
    return;
  }

  const { count, latestCompletedAt } = countCompletedScribesSinceLastAuditor();
  if (count < CONFIG.session.auditScribeFileThreshold || !latestCompletedAt) {
    return;
  }

  enqueueJob({
    type: "auditor",
    payload: { reason: count + " " + reasonPrefix },
    triggerSource: "daemon:scribe-threshold",
    idempotencyKey: "auditor:scribe-runs:" + latestCompletedAt,
  });
}

function countCompletedScribesSinceLastAuditorForProject(project: string): { count: number; latestCompletedAt: string | null } {
  const completedAuditors = listJobs("done")
    .filter((job) => job.type === "auditor")
    .filter((job) => {
      const payload = (job.payload as unknown) as Record<string, unknown>;
      return payload?.project === project;
    })
    .map((job) => job.completedAt || job.updatedAt || job.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a));

  const lastAuditorAtMs = completedAuditors[0] ? Date.parse(completedAuditors[0]) : 0;
  let count = 0;
  let latestCompletedAt: string | null = null;

  for (const job of listJobs("done")) {
    if (job.type !== "scribe") continue;
    const payload = (job.payload as unknown) as Record<string, unknown>;
    if (payload?.project !== project) continue;
    const completedAt = job.completedAt || job.updatedAt || job.createdAt;
    const completedAtMs = Date.parse(completedAt);
    if (Number.isNaN(completedAtMs) || completedAtMs <= lastAuditorAtMs) continue;
    count += 1;
    if (!latestCompletedAt || completedAtMs > Date.parse(latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }
  }

  return { count, latestCompletedAt };
}

function maybeEnqueueAuditorForProject(project: string, reasonPrefix = "successful scribe runs accumulated"): void {
  if (!project || project === "global") return;
  if (hasActiveJobForProject("auditor", project)) return;

  const deltaCount = countDeltasForProject(project);
  if (deltaCount === 0) return;

  const { count, latestCompletedAt } = countCompletedScribesSinceLastAuditorForProject(project);
  if (count < CONFIG.session.auditScribeFileThreshold || !latestCompletedAt) return;

  enqueueJob({
    type: "auditor",
    payload: { reason: count + " " + reasonPrefix, project },
    triggerSource: "daemon:project-scribe-threshold",
    idempotencyKey: "auditor:" + project + ":scribe-runs:" + latestCompletedAt,
  });
}

function countCompletedObserversSinceLastCompressor(): { count: number; latestCompletedAt: string | null } {
  const completedCompressors = listJobs("done")
    .filter((job) => job.type === "compressor")
    .map((job) => job.completedAt || job.updatedAt || job.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a));

  const lastCompressorAtMs = completedCompressors[0] ? Date.parse(completedCompressors[0]) : 0;
  let count = 0;
  let latestCompletedAt: string | null = null;

  for (const job of listJobs("done")) {
    if (job.type !== "observer") continue;
    const completedAt = job.completedAt || job.updatedAt || job.createdAt;
    const completedAtMs = Date.parse(completedAt);
    if (Number.isNaN(completedAtMs) || completedAtMs <= lastCompressorAtMs) continue;
    count += 1;
    if (!latestCompletedAt || completedAtMs > Date.parse(latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }
  }

  return { count, latestCompletedAt };
}

function maybeEnqueueCompressorFromObserverBacklog(): void {
  if (hasActiveJob("compressor")) return;

  const { count, latestCompletedAt } = countCompletedObserversSinceLastCompressor();
  const threshold = CONFIG.session.compressorObserverThreshold;
  if (count < threshold || !latestCompletedAt) return;

  enqueueJob({
    type: "compressor",
    payload: {
      layers: ["global", "project"],
      reason: count + " observer runs since last compressor",
    },
    triggerSource: "daemon:observer-threshold",
    idempotencyKey: "compressor:observer-runs:" + latestCompletedAt,
  });
}

function countCompletedScribesSinceLastObserver(): { count: number; latestCompletedAt: string | null } {
  const completedObservers = listJobs("done")
    .filter((job) => job.type === "observer")
    .map((job) => job.completedAt || job.updatedAt || job.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a));

  const lastObserverAtMs = completedObservers[0] ? Date.parse(completedObservers[0]) : 0;
  let count = 0;
  let latestCompletedAt: string | null = null;

  for (const job of listJobs("done")) {
    if (job.type !== "scribe") continue;
    const completedAt = job.completedAt || job.updatedAt || job.createdAt;
    const completedAtMs = Date.parse(completedAt);
    if (Number.isNaN(completedAtMs) || completedAtMs <= lastObserverAtMs) continue;
    count += 1;
    if (!latestCompletedAt || completedAtMs > Date.parse(latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }
  }

  return { count, latestCompletedAt };
}

function maybeEnqueueObserverFromScribeBacklog(): void {
  if (hasActiveJob("observer")) return;

  const { count, latestCompletedAt } = countCompletedScribesSinceLastObserver();
  if (count < CONFIG.session.observerScribeThreshold || !latestCompletedAt) return;

  const deltaFiles: string[] = [];
  const lastObserverCompleted = listJobs("done")
    .filter((j) => j.type === "observer")
    .map((j) => j.completedAt || j.updatedAt || j.createdAt)
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  const lastObserverMs = lastObserverCompleted ? Date.parse(lastObserverCompleted) : 0;
  for (const job of listJobs("done")) {
    if (job.type !== "scribe") continue;
    const completedAt = job.completedAt || job.updatedAt || job.createdAt;
    const completedAtMs = Date.parse(completedAt);
    if (Number.isNaN(completedAtMs) || completedAtMs <= lastObserverMs) continue;
    const sid = (job.payload as any)?.sessionId;
    if (sid) {
      const deltaPath = path.join(CONFIG.paths.deltas, `${sid}.json`);
      if (fs.existsSync(deltaPath)) deltaFiles.push(deltaPath);
      const auditedPath = path.join(CONFIG.paths.deltas, "audited", `${sid}.json`);
      if (fs.existsSync(auditedPath)) deltaFiles.push(auditedPath);
    }
  }

  enqueueJob({
    type: "observer",
    payload: {
      deltaFiles: [...new Set(deltaFiles)],
      reason: count + " scribe runs since last observer",
    },
    triggerSource: "daemon:scribe-threshold",
    idempotencyKey: "observer:scribe-runs:" + latestCompletedAt,
  });
}

function maybeEnqueueBootstrapFromObserver(project: string | undefined, sessionId: string): void {
  if (!project || project === "global") return;
  if (hasActiveJob("bootstrap_project_doc")) return;

  let totalObs = 0;

  const projectObsPath = path.join(CONFIG.paths.lenses, sanitizeProjectSlug(project), "observations.jsonl");
  if (fs.existsSync(projectObsPath)) {
    const lines = fs.readFileSync(projectObsPath, "utf-8").trim().split("\n").filter(Boolean);
    totalObs += lines.filter((l) => {
      try { return !JSON.parse(l).absorbed; } catch { return false; }
    }).length;
  }

  const globalObsPath = path.join(CONFIG.paths.mind, "observations.jsonl");
  if (fs.existsSync(globalObsPath)) {
    const lines = fs.readFileSync(globalObsPath, "utf-8").trim().split("\n").filter(Boolean);
    totalObs += lines.filter((l) => {
      try { return !JSON.parse(l).absorbed; } catch { return false; }
    }).length;
  }

  if (totalObs < 5) return;

  enqueueJob({
    type: "bootstrap_project_doc",
    payload: {
      project,
      harness: "opencode",
      cwd: process.cwd(),
      reason: totalObs + " unabsorbed observations for " + project,
    },
    triggerSource: "daemon:observer-threshold",
    idempotencyKey: "bootstrap:" + project + ":" + sessionId,
  });
}

function getSessionDeltaState(sessionId: string): { exists: boolean; mtimeMs: number; size: number } {
  const filePath = path.join(CONFIG.paths.deltas, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    return { exists: false, mtimeMs: 0, size: 0 };
  }

  const stat = fs.statSync(filePath);
  return {
    exists: true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function hasProjectWorkingSession(project: string, sessionId: string): boolean {
  const statePath = getProjectWorkingStatePath(project);
  if (!fs.existsSync(statePath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      sessions?: Array<{ sessionId?: string }>;
    };
    return Boolean(parsed.sessions?.some((entry) => entry.sessionId === sessionId));
  } catch {
    return false;
  }
}

function reconcileProjectWorkingBacklog(): void {
  const completedProjectScribes = listJobs("done")
    .filter((job) => job.type === "scribe")
    .sort((a, b) => {
      const aTime = Date.parse(a.completedAt || a.updatedAt || a.createdAt);
      const bTime = Date.parse(b.completedAt || b.updatedAt || b.createdAt);
      return bTime - aTime;
    });

  for (const job of completedProjectScribes) {
    const payload = job.payload as {
      sessionId?: string;
      project?: string;
      toolTracePath?: string;
    };
    const project = payload.project;
    const sessionId = payload.sessionId;
    if (!project || project === "global" || !sessionId || project.includes("/") === false && !project.includes("_")) {
      continue;
    }
    if (project.startsWith("private/") || project.startsWith("tmp/") || project.startsWith("/")) {
      continue;
    }

    const deltaState = getSessionDeltaState(sessionId);
    if (!deltaState.exists) {
      continue;
    }

    if (hasProjectWorkingSession(project, sessionId)) {
      continue;
    }

    activityBus.log("system:info", "Backfilling project WORKING from completed scribe", {
      jobId: job.id,
      sessionId,
      project,
    });

    updateProjectWorkingFromSession({
      project,
      sessionId,
      toolTracePath: payload.toolTracePath,
    });
  }
}

function writeDaemonState(status: Record<string, unknown>): void {
  ensureJobDirectories();
  fs.writeFileSync(CONFIG.paths.daemonState, JSON.stringify({
    ...status,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function toWorkerPath(filePath: string): string {
  if (!filePath) return filePath;
  const runtime = loadRuntimeConfig();
  if (runtime.mode !== "docker" || process.env.GRAPH_MEMORY_ROOT !== runtime.docker.graphRootInContainer) {
    return filePath;
  }

  if (filePath === runtime.graphRoot || filePath.startsWith(`${runtime.graphRoot}/`)) {
    return filePath.replace(runtime.graphRoot, runtime.docker.graphRootInContainer);
  }

  return filePath;
}

function getDatePartsInTimeZone(timeZone: string, date = new Date()): { date: string; hour: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${lookup("year")}-${lookup("month")}-${lookup("day")}`,
    hour: Number.parseInt(lookup("hour") || "0", 10),
  };
}

function shiftIsoDate(date: string, deltaDays: number): string {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

function matchesIsoDateInTimeZone(dateValue: string | number | Date, targetDate: string, timeZone: string): boolean {
  const value = typeof dateValue === "string" || typeof dateValue === "number" ? new Date(dateValue) : dateValue;
  if (Number.isNaN(value.getTime())) return false;
  return getDatePartsInTimeZone(timeZone, value).date === targetDate;
}

function collectRecentActivityForDate(targetDate: string, timeZone: string, maxLines = 40): Array<Record<string, unknown>> {
  const activityPath = CONFIG.paths.logs ? path.join(CONFIG.paths.logs, "activity.jsonl") : "";
  if (!activityPath || !fs.existsSync(activityPath)) return [];

  const lines = fs.readFileSync(activityPath, "utf-8")
    .split("\n")
    .filter(Boolean);

  const matches: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.timestamp === "string" && matchesIsoDateInTimeZone(parsed.timestamp, targetDate, timeZone)) {
        matches.push(parsed);
      }
    } catch { /* ignore */ }
  }

  return matches.slice(-maxLines);
}

function collectJobSummaryForDate(targetDate: string, timeZone: string): Array<Record<string, unknown>> {
  const jobs = [...listJobs("done"), ...listJobs("failed"), ...listJobs("running")];
  return jobs
    .filter((job) => matchesIsoDateInTimeZone(job.updatedAt || job.createdAt, targetDate, timeZone))
    .slice(-40)
    .map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      triggerSource: job.triggerSource,
      lastError: job.lastError ? String(job.lastError).slice(0, 200) : null,
    }));
}

function collectSessionTracePathsForDate(targetDate: string, timeZone: string, maxPaths = 30): string[] {
  if (!fs.existsSync(CONFIG.paths.sessionTraces)) return [];

  const paths: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const sessionDir of fs.readdirSync(CONFIG.paths.sessionTraces)) {
    const filePath = path.join(CONFIG.paths.sessionTraces, sessionDir, "tool-trace.jsonl");
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (matchesIsoDateInTimeZone(stat.mtimeMs, targetDate, timeZone)) {
      paths.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  return paths
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxPaths)
    .map((entry) => entry.filePath);
}

function collectAssistantTracePathsForDate(targetDate: string, timeZone: string, maxPaths = 30): string[] {
  if (!fs.existsSync(CONFIG.paths.sessionTraces)) return [];

  const paths: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const sessionDir of fs.readdirSync(CONFIG.paths.sessionTraces)) {
    const filePath = path.join(CONFIG.paths.sessionTraces, sessionDir, "assistant-trace.jsonl");
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (matchesIsoDateInTimeZone(stat.mtimeMs, targetDate, timeZone)) {
      paths.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  return paths
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxPaths)
    .map((entry) => entry.filePath);
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

function resolveClaudeFilePath(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, "CLAUDE.md"),
    path.join(projectRoot, ".claude", "CLAUDE.md"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readTextFileLimited(filePath: string, maxChars = 20000): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n...[truncated]` : content;
}

function collectActiveProjectsForDate(targetDate: string, timeZone: string): Array<Record<string, unknown>> {
  const byProject = new Map<string, { project: string; cwd?: string; sessionIds: Set<string> }>();
  const knownProjectRoots = new Map<string, string>();

  if (fs.existsSync(CONFIG.paths.sessionTraces)) {
    for (const sessionDir of fs.readdirSync(CONFIG.paths.sessionTraces)) {
      const filePath = path.join(CONFIG.paths.sessionTraces, sessionDir, "tool-trace.jsonl");
      if (!fs.existsSync(filePath)) continue;
      const events = readJsonLines(filePath);
      for (const event of events) {
        if (typeof event.project === "string" && event.project.trim() && typeof event.cwd === "string" && event.cwd.trim()) {
          knownProjectRoots.set(event.project.trim(), event.cwd.trim());
        }
      }
    }
  }

  const tracePaths = collectSessionTracePathsForDate(targetDate, timeZone, 50);
  for (const filePath of tracePaths) {
    const sessionId = path.basename(path.dirname(filePath));
    const events = readJsonLines(filePath);
    const lastEvent = [...events].reverse().find((event) => typeof event.project === "string" || typeof event.cwd === "string");
    const project = typeof lastEvent?.project === "string" && lastEvent.project.trim() ? lastEvent.project.trim() : "global";
    const cwd = typeof lastEvent?.cwd === "string" && lastEvent.cwd.trim() ? lastEvent.cwd.trim() : undefined;
    const existing = byProject.get(project) || { project, cwd, sessionIds: new Set<string>() };
    if (!existing.cwd && cwd) existing.cwd = cwd;
    existing.sessionIds.add(sessionId);
    byProject.set(project, existing);
  }

  for (const job of collectJobSummaryForDate(targetDate, timeZone)) {
    const payload = (job.payload || {}) as Record<string, unknown>;
    const project = typeof payload.project === "string" && payload.project.trim() ? payload.project.trim() : null;
    if (!project) continue;
    const existing = byProject.get(project) || { project, sessionIds: new Set<string>() };
    byProject.set(project, existing);
  }

  return [...byProject.values()].map((entry) => {
    const resolvedCwd = entry.cwd || knownProjectRoots.get(entry.project) || null;
    const workingPath = entry.project !== "global"
      ? path.join(CONFIG.paths.workingProjects, `${entry.project.replace(/[^a-zA-Z0-9._-]+/g, "__") || "global"}.md`)
      : CONFIG.paths.workingGlobal;
    const claudePath = resolvedCwd ? resolveClaudeFilePath(resolvedCwd) : null;

    return {
      project: entry.project,
      cwd: resolvedCwd,
      session_ids: [...entry.sessionIds],
      working_path: fs.existsSync(workingPath) ? workingPath : null,
      claude_file_path: claudePath,
      claude_file_content: claudePath ? readTextFileLimited(claudePath) : null,
    };
  });
}

function createMemoryAnalysisInput(briefDate: string, timeZone: string): string {
  const yesterdayDate = shiftIsoDate(briefDate, -1);
  const briefPaths = getDailyBriefPaths(briefDate);
  const inputPath = briefPaths.jsonPath.replace(/\.json$/, ".input.json");
  const previousBriefDir = CONFIG.paths.dailyBriefs;
  const previousBriefJsonPaths = fs.existsSync(previousBriefDir)
    ? fs.readdirSync(previousBriefDir)
        .filter((file) => file.endsWith(".json") && !file.endsWith(".input.json") && file !== path.basename(briefPaths.jsonPath))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 7)
        .map((file) => path.join(previousBriefDir, file))
    : [];

  const workingProjectPaths = fs.existsSync(CONFIG.paths.workingProjects)
    ? fs.readdirSync(CONFIG.paths.workingProjects)
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.join(CONFIG.paths.workingProjects, file))
    : [];

  const payload = {
    brief_date: briefDate,
    yesterday_date: yesterdayDate,
    timezone: timeZone,
    graph_root: CONFIG.paths.graphRoot,
    files: {
      priors: CONFIG.paths.priors,
      soma: CONFIG.paths.soma,
      map: CONFIG.paths.map,
      working_aggregate: CONFIG.paths.working,
      working_global: CONFIG.paths.workingGlobal,
      working_projects: workingProjectPaths,
    },
    previous_brief_json_paths: previousBriefJsonPaths,
    session_trace_paths: collectSessionTracePathsForDate(yesterdayDate, timeZone),
    assistant_trace_paths: collectAssistantTracePathsForDate(yesterdayDate, timeZone),
    active_projects: collectActiveProjectsForDate(yesterdayDate, timeZone),
    activity_events: collectRecentActivityForDate(yesterdayDate, timeZone),
    jobs: collectJobSummaryForDate(yesterdayDate, timeZone),
    external_inputs: {
      config: loadExternalInputsConfig(),
      classified_inputs: readRecentClassifiedInputs(6),
    },
    skillforge: {
      manifests: listManifests().map((m) => ({
        source_nodes: m.source_nodes,
        skill_name: m.skill_name,
        generated_at: m.generated_at,
        score: m.score,
        project: m.project,
        candidate_type: m.candidate_type,
        refresh_count: m.refresh_count,
        last_refreshed_at: m.last_refreshed_at,
      })),
    },
  };

  let json = JSON.stringify(payload, null, 2);
  const MAX_INPUT_BYTES = 60_000;
  if (json.length > MAX_INPUT_BYTES) {
    if (payload.activity_events && Array.isArray(payload.activity_events)) {
      payload.activity_events = payload.activity_events.slice(-20);
    }
    if (payload.jobs && Array.isArray(payload.jobs)) {
      payload.jobs = payload.jobs.slice(-20);
    }
    json = JSON.stringify(payload, null, 2);
  }
  fs.writeFileSync(inputPath, json);
  return inputPath;
}

function maybeEnqueueDailyAnalysisJob(): void {
  const timeZone = CONFIG.session.dailyAnalysisTimeZone;
  const { date, hour } = getDatePartsInTimeZone(timeZone);
  if (hour < CONFIG.session.dailyAnalysisHourLocal) {
    return;
  }

  const briefPaths = getDailyBriefPaths(date);
  if (fs.existsSync(briefPaths.markdownPath) || fs.existsSync(briefPaths.jsonPath)) {
    return;
  }

  if (hasActiveJob("memory_analysis")) {
    return;
  }

  enqueueJob({
    type: "memory_analysis",
    payload: {
      briefDate: date,
      timeZone,
      reason: `daily morning brief for ${date}`,
    },
    triggerSource: "daemon:daily-analysis-schedule",
    idempotencyKey: `memory-analysis:${date}`,
  });
}

function maybeEnqueueNotionSync(): void {
  if (!CONFIG.notionSync.enabled) return;

  const notionState = readNotionSyncState();
  if (!notionState.parentPageId) return;

  const timeZone = CONFIG.session.dailyAnalysisTimeZone;
  const { date, hour } = getDatePartsInTimeZone(timeZone);
  if (hour < CONFIG.notionSync.syncHourLocal) return;

  if (hasActiveJob("notion_sync") || hasActiveJob("memory_analysis")) return;

  if (notionState.lastSyncAt) {
    const elapsed = Date.now() - new Date(notionState.lastSyncAt).getTime();
    if (elapsed < 8 * 60 * 60 * 1000) return;
  }

  const briefPaths = getDailyBriefPaths(date);
  const briefAvailable = fs.existsSync(briefPaths.jsonPath) || fs.existsSync(briefPaths.markdownPath);

  enqueueJob({
    type: "notion_sync",
    payload: {
      reason: `daily notion sync for ${date}`,
      date,
      briefAvailable,
    },
    triggerSource: "daemon:daily-notion-sync-schedule",
    idempotencyKey: `notion-sync:${date}`,
  });
}

async function runScribe(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    snapshotPath: string;
    sessionId: string;
    project?: string;
    assistantTracePath?: string;
    toolTracePath?: string;
  };
  if (!payload.snapshotPath || !payload.sessionId) {
    throw new Error(`Scribe job missing required payload fields (snapshotPath, sessionId)`);
  }
  const scribePromptPath = path.join(AGENTS_DIR, "memory-scribe.md");
  const deltaCountBefore = countActiveDeltaFiles();
  const deltaStateBefore = getSessionDeltaState(payload.sessionId);
  const snapshotPathForWorker = toWorkerPath(payload.snapshotPath);
  const assistantTracePath = payload.assistantTracePath || getAssistantTracePath(payload.sessionId);
  const toolTracePath = payload.toolTracePath || getToolTracePath(payload.sessionId);
  const assistantTracePathForWorker = fs.existsSync(assistantTracePath) ? toWorkerPath(assistantTracePath) : null;
  const toolTracePathForWorker = fs.existsSync(toolTracePath) ? toWorkerPath(toolTracePath) : null;
  const projectCtx = payload.project
    ? ` Current project: ${payload.project} (use this for classifying deltas as global vs project-scoped).`
    : "";
  const assistantTraceCtx = assistantTracePathForWorker
    ? ` Assistant trace file: ${assistantTracePathForWorker}. Read it to understand the visible intermediate assistant text between the user prompt and final assistant reply. Use its timestamps and \`kind\` field (\`intermediate\` or \`final\`) to understand what the agent said it was doing over time.`
    : "";
  const toolTraceCtx = toolTracePathForWorker
    ? ` Tool trace file: ${toolTracePathForWorker}. Read it if you need to understand the agent actions that happened between the user prompt and final assistant reply, especially to capture corrections about tool usage, constraint violations, or workflow friction.`
    : "";
  const prompt = `Read the scribe instructions at ${scribePromptPath}, then follow them. Snapshot file: ${snapshotPathForWorker}, session ID: ${payload.sessionId}, graph root: ${CONFIG.paths.graphRoot}.${projectCtx}${assistantTraceCtx}${toolTraceCtx} Read the snapshot, read MAP.md, then read only the 2-5 existing nodes most relevant to the conversation for context. Extract deltas, write to .deltas/ directory, then delete the snapshot file when complete.`;

  const result = await runWorker({
    name: `scribe-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 10 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Scribe worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  if (fs.existsSync(payload.snapshotPath)) {
    throw new Error(`Scribe completed without deleting snapshot ${payload.snapshotPath}`);
  }

  const deltaStateAfter = getSessionDeltaState(payload.sessionId);
  const deltaUpdated = deltaStateAfter.exists && (
    !deltaStateBefore.exists ||
    deltaStateAfter.mtimeMs > deltaStateBefore.mtimeMs ||
    deltaStateAfter.size !== deltaStateBefore.size
  );

  if (!deltaUpdated) {
    activityBus.log("scribe:complete", "Scribe completed with no new deltas", {
      jobId: job.id,
      sessionId: payload.sessionId,
      project: payload.project || null,
    });
    return;
  }

  try {
    regenerateCoreContextFiles(payload.project);
  } catch (err: any) {
    activityBus.log("system:error", `WORKING regeneration after scribe failed: ${err.message}`);
  }

  if (payload.project && payload.project !== "global") {
    enqueueJob({
      type: "working_update",
      payload: {
        sessionId: payload.sessionId,
        project: payload.project,
        deltaMtimeMs: deltaStateAfter.mtimeMs,
        ...(assistantTracePath ? { assistantTracePath } : {}),
        ...(toolTracePath ? { toolTracePath } : {}),
      },
      triggerSource: "daemon:scribe-complete",
      idempotencyKey: `working-update:${payload.sessionId}:${deltaStateAfter.mtimeMs}`,
    });
  }

  if (payload.project && payload.project !== "global") {
    maybeEnqueueAuditorForProject(payload.project, "successful scribe run");
  } else {
    maybeEnqueueAuditorFromScribeBacklog("successful scribe runs accumulated");
  }
}

async function runObserver(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    deltaFiles?: string[];
    reason?: string;
    snapshotPath?: string;
    sessionId?: string;
    project?: string;
    assistantTracePath?: string;
    toolTracePath?: string;
  };

  const observerPromptPath = path.join(AGENTS_DIR, "memory-observer.md");
  const obsDir = CONFIG.paths.pipelineObservations;
  if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });
  const obsDirForWorker = toWorkerPath(obsDir);

  let prompt: string;

  if (payload.deltaFiles && payload.deltaFiles.length > 0) {
    const deltaFilesForWorker = payload.deltaFiles.map(toWorkerPath);
    prompt = `Read the observer instructions at ${observerPromptPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Write observation JSON files to ${obsDirForWorker}. This run was triggered because ${payload.reason || 'enough scribes completed'}. Read these scribe delta files and extract cross-project patterns, cognitive signals, and soma markers: ${deltaFilesForWorker.join(', ')}. Read the global mental model at mind/model.json if it exists. Read MAP.md for current graph context. Do NOT delete any delta files — they are shared with the project pipeline.`;
  } else if (payload.snapshotPath) {
    const snapshotPathForWorker = toWorkerPath(payload.snapshotPath);
    prompt = `Read the observer instructions at ${observerPromptPath}, then follow them. Snapshot file: ${snapshotPathForWorker}, session ID: ${payload.sessionId || 'unknown'}, graph root: ${CONFIG.paths.graphRoot}. Write observation JSON files to ${obsDirForWorker}. Read the global mental model at mind/model.json if it exists. Read MAP.md for current graph context. Delete the snapshot file when complete.`;
  } else {
    activityBus.log("system:info", "Observer job has no delta files or snapshot, skipping", { jobId: job.id });
    return;
  }

  const result = await runWorker({
    name: "observer-" + job.id,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 5 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error("Observer worker exited with code " + result.exitCode + ". See " + result.logFile);
  }

  if (payload.snapshotPath && fs.existsSync(payload.snapshotPath)) {
    fs.unlinkSync(payload.snapshotPath);
  }

  const sessionId = payload.sessionId || `observer-${job.id}`;
  const toolResult = processObserverOutputs(sessionId, payload.project);

  activityBus.log("observer:complete", "Observer run complete", {
    jobId: job.id,
    sessionId,
    project: payload.project || "global",
    observationsCreated: toolResult.observationsCreated,
    sessionLogged: toolResult.sessionLogged,
    nodesUpserted: toolResult.nodesUpserted,
    errors: toolResult.errors,
  });

  if (toolResult.errors.length > 0) {
    activityBus.log("observer:warnings", "Observer had processing errors", {
      jobId: job.id,
      errors: toolResult.errors,
    });
  }

  maybeEnqueueCompressorFromObserverBacklog();
}

async function runCompressor(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    layers?: Array<"global" | "project">;
    projects?: string[];
    force?: boolean;
    reason: string;
  };

  const compressorPromptPath = path.join(AGENTS_DIR, "memory-compressor.md");
  const layers = payload.layers || ["global", "project"];
  const projectList = payload.projects || [];

  let prompt = "Read the compressor instructions at " + compressorPromptPath + ", then follow them. Graph root: " + CONFIG.paths.graphRoot + ". Layers to process: " + layers.join(", ") + ".";
  if (projectList.length > 0) {
    prompt += " Projects: " + projectList.join(", ") + ".";
  }
  if (payload.force) {
    prompt += " This is a forced run — process all unabsorbed observations regardless of count.";
  }
  prompt += " Reason: " + payload.reason;

  const obsDir = CONFIG.paths.pipelineObservations;
  if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });

  const result = await runWorker({
    name: "compressor-" + job.id,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 10 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error("Compressor worker exited with code " + result.exitCode + ". See " + result.logFile);
  }

  const toolResult = processCompressorOutputs();

  try { runAutoPrune(); } catch { /* non-critical */ }
  try { rebuildGraphIndex(); } catch { /* non-critical */ }

  activityBus.log("system:info", "Compressor run complete", {
    jobId: job.id,
    reason: payload.reason,
    modelsUpdated: toolResult.modelsUpdated,
    observationsAbsorbed: toolResult.observationsAbsorbed,
    graphNodesArchived: toolResult.graphNodesArchived,
    errors: toolResult.errors.length,
  });
}

async function runWorkingUpdate(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    sessionId: string;
    project: string;
    deltaMtimeMs: number;
    assistantTracePath?: string;
    toolTracePath?: string;
  };

  if (!payload.project || payload.project === "global") {
    return;
  }

  const updaterPath = path.join(AGENTS_DIR, "memory-working-updater.md");
  const deltaPath = path.join(CONFIG.paths.deltas, `${payload.sessionId}.json`);
  const workingPath = getProjectWorkingPath(payload.project);
  const workingStatePath = getProjectWorkingStatePath(payload.project);
  const updateOutputPath = getProjectWorkingUpdatePath(payload.project, payload.sessionId);
  fs.mkdirSync(path.dirname(updateOutputPath), { recursive: true });

  const updaterPathForWorker = toWorkerPath(updaterPath);
  const deltaPathForWorker = toWorkerPath(deltaPath);
  const workingPathForWorker = toWorkerPath(workingPath);
  const workingStatePathForWorker = toWorkerPath(workingStatePath);
  const updateOutputPathForWorker = toWorkerPath(updateOutputPath);
  const fileInteractionData = collectFileInteractions(payload.toolTracePath);
  const fileInteractionPath = getFileInteractionPath(payload.project, payload.sessionId);
  fs.mkdirSync(path.dirname(fileInteractionPath), { recursive: true });
  fs.writeFileSync(fileInteractionPath, JSON.stringify(fileInteractionData, null, 2));
  const fileInteractionPathForWorker = fileInteractionData.length > 0 ? toWorkerPath(fileInteractionPath) : null;
  const outputMtimeBeforeWorker = fs.existsSync(updateOutputPath)
    ? fs.statSync(updateOutputPath).mtimeMs
    : 0;

  const prompt = `Read the working updater instructions at ${updaterPathForWorker}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Project: ${payload.project}. Session ID: ${payload.sessionId}. Delta file: ${deltaPathForWorker}. Project WORKING markdown: ${workingPathForWorker}. Project WORKING state JSON: ${workingStatePathForWorker}.${fileInteractionPathForWorker ? ` File interaction summary: ${fileInteractionPathForWorker}.` : ""} Raw assistant and tool traces are intentionally not provided; do not search for or read trace files. Write the session working update artifact JSON to ${updateOutputPathForWorker}.`;

  try {
    const result = await runWorker({
      name: `working-update-${job.id}`,
      prompt,
      graphRoot: CONFIG.paths.graphRoot,
      logDir: CONFIG.paths.pipelineLogs,
      addDirs: [AGENTS_DIR],
      timeoutMs: 5 * 60_000,
    });

    job.logFile = result.logFile;
    job.workerPid = result.pid;
    updateRunningJob(job);

    if (result.exitCode !== 0) {
      throw new Error(`Working updater exited with code ${result.exitCode}. See ${result.logFile}`);
    }
  } catch (err: any) {
    const outputMtimeAfterWorker = fs.existsSync(updateOutputPath)
      ? fs.statSync(updateOutputPath).mtimeMs
      : 0;
    if (outputMtimeAfterWorker <= outputMtimeBeforeWorker) {
      throw err;
    }
    activityBus.log("system:info", "Working updater failed after writing artifact; applying fresh artifact", {
      jobId: job.id,
      project: payload.project,
      sessionId: payload.sessionId,
      error: err.message,
    });
  }

  if (!fs.existsSync(updateOutputPath)) {
    throw new Error("Working updater completed without writing a session update artifact");
  }

  updateProjectWorkingFromSession({
    project: payload.project,
    sessionId: payload.sessionId,
    toolTracePath: payload.toolTracePath,
    updatePath: updateOutputPath,
    fileInteractionPath,
  });
}

async function runAuditor(job: GraphMemoryJob): Promise<void> {
  const payload = (job.payload as unknown) as { reason: string; project?: string };
  const project = payload.project;

  if (project && project !== "global") {
    const deltaCount = countDeltasForProject(project);
    if (deltaCount === 0) {
      activityBus.log("system:info", "Skipping auditor job with no project deltas", {
        jobId: job.id,
        project,
      });
      return;
    }
  } else {
    if (countActiveDeltaFiles() === 0) {
      activityBus.log("system:info", "Skipping auditor job with no active deltas", { jobId: job.id });
      return;
    }
  }

  if (project && project !== "global") {
    try {
      acquireProjectChainLock(project);
    } catch (err: any) {
      if (err.message?.startsWith("Project chain lock held")) {
        activityBus.log("system:info", "Skipping auditor job because project chain lock is held", {
          jobId: job.id,
          project,
        });
        return;
      }
      throw err;
    }
  }
  generatePreflightReport(project);

  const auditorPath = path.join(AGENTS_DIR, "memory-auditor.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");

  let preflightReportPath: string;
  let auditReportPath: string;
  let auditBriefPath: string;
  let projectCtx: string;

  if (project && project !== "global") {
    ensureAuditDirectories(project);
    preflightReportPath = toWorkerPath(getProjectPreflightPath(project));
    auditReportPath = getProjectAuditReportPath(project);
    auditBriefPath = getProjectAuditBriefPath(project);
    projectCtx = ` Project: ${project}. Only process deltas and nodes relevant to this project.`;
  } else {
    preflightReportPath = toWorkerPath(CONFIG.paths.preflightReport);
    auditReportPath = CONFIG.paths.auditReport;
    auditBriefPath = CONFIG.paths.auditBrief;
    projectCtx = "";
  }

  const auditReportPathForWorker = toWorkerPath(auditReportPath);
  const auditBriefPathForWorker = toWorkerPath(auditBriefPath);

  const prompt = `Read the auditor instructions at ${auditorPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}.${projectCtx} Read the preflight report at ${preflightReportPath} first — it contains the full node manifest and flagged issues with their file contents included. Write the audit report to ${auditReportPathForWorker} and the audit brief to ${auditBriefPathForWorker}. IMPORTANT: when rebuilding context files, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runWorker({
    name: `auditor-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 20 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    if (project && project !== "global") releaseProjectChainLock(project);
    throw new Error(`Auditor worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  if (!fs.existsSync(auditReportPath) || !fs.existsSync(auditBriefPath)) {
    if (project && project !== "global") releaseProjectChainLock(project);
    throw new Error("Auditor completed without writing audit artifacts");
  }

  if (!hasActiveJobForProject("librarian", project || "global")) {
    enqueueJob({
      type: "librarian",
      payload: { reason: "auditor completed", project },
      triggerSource: "daemon:auditor-complete",
      idempotencyKey: `librarian:${project || "global"}:${fs.statSync(auditReportPath).mtimeMs}`,
    });
  }
}

async function runLibrarian(job: GraphMemoryJob): Promise<void> {
  const payload = (job.payload as unknown) as { reason: string; project?: string };
  const project = payload.project;

  let auditBriefPath: string;
  let auditReportPath: string;
  let projectCtx: string;

  if (project && project !== "global") {
    auditBriefPath = getProjectAuditBriefPath(project);
    auditReportPath = getProjectAuditReportPath(project);
    projectCtx = ` Project: ${project}. Only apply changes relevant to this project.`;
  } else {
    auditBriefPath = CONFIG.paths.auditBrief;
    auditReportPath = CONFIG.paths.auditReport;
    projectCtx = "";
  }

  const auditBriefPathForWorker = toWorkerPath(auditBriefPath);
  const auditReportPathForWorker = toWorkerPath(auditReportPath);

  const librarianPath = path.join(AGENTS_DIR, "memory-librarian.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");
  const prompt = `Read the librarian instructions at ${librarianPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}.${projectCtx} Read the audit brief at ${auditBriefPathForWorker} and audit report at ${auditReportPathForWorker} first — the auditor has already triaged mechanical fixes and prepared recommendations for you. IMPORTANT: when rebuilding context files, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runWorker({
    name: `librarian-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 25 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    if (project && project !== "global") releaseProjectChainLock(project);
    throw new Error(`Librarian worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  regenerateCoreContextFiles(project);

  if (!hasActiveJobForProject("dreamer", project || "global")) {
    enqueueJob({
      type: "dreamer",
      payload: { reason: "librarian completed", project },
      triggerSource: "daemon:librarian-complete",
      idempotencyKey: `dreamer:${project || "global"}:${Date.now()}`,
    });
  }
}

async function runDreamer(job: GraphMemoryJob): Promise<void> {
  const payload = (job.payload as unknown) as { reason: string; project?: string };
  const project = payload.project;

  let projectCtx: string;
  if (project && project !== "global") {
    ensureDreamDirectories(project);
    projectCtx = ` Project: ${project}. Focus on project-specific associative memory. Write dream artifacts to ${toWorkerPath(getProjectDreamsDir(project))}.`;
  } else {
    projectCtx = "";
  }

  const dreamerPath = path.join(AGENTS_DIR, "memory-dreamer.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");
  const prompt = `Read the dreamer instructions at ${dreamerPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}.${projectCtx} IMPORTANT: when rebuilding DREAMS.md, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runWorker({
    name: `dreamer-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 15 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    if (project && project !== "global") releaseProjectChainLock(project);
    throw new Error(`Dreamer worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  regenerateDreamContext();

  if (project && project !== "global") {
    releaseProjectChainLock(project);
  }
}

async function runMemoryAnalysis(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { briefDate: string; timeZone: string; reason: string };
  const analysisPath = path.join(AGENTS_DIR, "memory-analysis.md");
  const briefPaths = getDailyBriefPaths(payload.briefDate);
  const analysisInputPath = createMemoryAnalysisInput(payload.briefDate, payload.timeZone);
  const markdownPathForWorker = toWorkerPath(briefPaths.markdownPath);
  const jsonPathForWorker = toWorkerPath(briefPaths.jsonPath);
  const analysisInputPathForWorker = toWorkerPath(analysisInputPath);

  const prompt = `Read the analysis instructions at ${analysisPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Brief date: ${payload.briefDate}. Timezone: ${payload.timeZone}. Analysis input JSON: ${analysisInputPathForWorker}. Write the markdown brief to ${markdownPathForWorker} and the JSON brief to ${jsonPathForWorker}. Prefer the curated analysis input over broad filesystem scans.`;

  const result = await runWorker({
    name: `memory-analysis-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 20 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Memory analysis worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  if (!fs.existsSync(briefPaths.markdownPath) || !fs.existsSync(briefPaths.jsonPath)) {
    throw new Error("Memory analysis completed without writing both brief artifacts");
  }
}

async function runNotionInbound(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { reason: string; date: string };

  activityBus.log("notion-inbound:start", `Notion inbound starting: ${payload.reason}`, {
    jobId: job.id,
    date: payload.date,
  });

  const notionState = readNotionSyncState();
  if (!notionState.parentPageId) {
    activityBus.log("notion-inbound:error", "Notion inbound skipped — no parent page ID configured");
    return;
  }

  if (CONFIG.notionSync.skipInbound) {
    activityBus.log("notion-inbound:complete", "Notion inbound skipped — skipInbound is set");
    return;
  }

  const inboundResult = detectInboundEdits(notionState);

  if (inboundResult.edits.length === 0) {
    writeNotionSyncState(notionState);
    activityBus.log("notion-inbound:complete", "Notion inbound complete — no human edits detected", {
      jobId: job.id,
      date: payload.date,
    });
    return;
  }

  writeNotionSyncState(notionState);

  if (inboundResult.errors.length > 0) {
    activityBus.log("notion-inbound:error", `Notion inbound had ${inboundResult.errors.length} fetch errors`, {
      jobId: job.id,
      errors: inboundResult.errors,
    });
  }

  const mergeNeeded = inboundResult.edits.filter((e) => e.classification === "merge_needed");
  const inboundOnly = inboundResult.edits.filter((e) => e.classification === "inbound_only");

  if (inboundOnly.length > 0) {
    const inputPath = writeInboundInput(inboundOnly, payload.date);
    const inputPathForWorker = toWorkerPath(inputPath);
    const planPathForWorker = toWorkerPath(
      path.join(CONFIG.paths.graphRoot, `.notion-inbound-plan-${payload.date}.json`)
    );
    const inboundAgentPath = path.join(AGENTS_DIR, "memory-notion-inbound.md");

    const prompt = `Read the Notion inbound instructions at ${inboundAgentPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Inbound input: ${inputPathForWorker}. Write the inbound plan to ${planPathForWorker}. Date: ${payload.date}.`;

    const result = await runWorker({
      name: `notion-inbound-${job.id}`,
      prompt,
      graphRoot: CONFIG.paths.graphRoot,
      logDir: CONFIG.paths.pipelineLogs,
      addDirs: [AGENTS_DIR],
      timeoutMs: 10 * 60_000,
    });

    job.logFile = result.logFile;
    job.workerPid = result.pid;
    updateRunningJob(job);

    if (result.exitCode !== 0) {
      activityBus.log("notion-inbound:error", `Notion inbound worker exited with code ${result.exitCode}. See ${result.logFile}`);
      return;
    }

    const deltas = readInboundPlan(payload.date);
    if (!deltas || deltas.length === 0) {
      activityBus.log("notion-inbound:complete", "Notion inbound worker produced no deltas");
      return;
    }

    const applyResult = applyInboundDeltas(deltas);
    writeInboundDeltas(deltas, payload.date);

    activityBus.log("notion-inbound:complete", `Notion inbound complete: ${applyResult.applied} deltas applied`, {
      jobId: job.id,
      date: payload.date,
      applied: applyResult.applied,
      errors: applyResult.errors,
    });
  }

  for (const edit of mergeNeeded) {
    try {
      await runNotionMerge(edit, job.id, payload.date);
    } catch (err: any) {
      activityBus.log("notion-merge:error", `Merge failed for ${edit.notionKey}: ${err.message}`, {
        jobId: job.id,
        notionKey: edit.notionKey,
      });
    }
  }

  notionState.lastInboundAt = new Date().toISOString();
  writeNotionSyncState(notionState);
}

async function runNotionMerge(edit: InboundEdit, jobId: string, date: string): Promise<void> {
  activityBus.log("notion-merge:start", `Merging ${edit.notionKey}`, { jobId, notionKey: edit.notionKey });

  const inputPath = writeMergeInput(
    edit.notionKey,
    edit.lastSyncedContent,
    edit.currentNotionContent,
    edit.diskContent,
    edit.sourceNodes,
  );
  const inputPathForWorker = toWorkerPath(inputPath);
  const sanitizedKey = edit.notionKey.replace(/[/\\]/g, "_");
  const resultPathForWorker = toWorkerPath(
    path.join(CONFIG.paths.graphRoot, `.notion-merge-result-${sanitizedKey}.json`)
  );
  const mergeAgentPath = path.join(AGENTS_DIR, "memory-notion-merge.md");

  const prompt = `Read the Notion merge instructions at ${mergeAgentPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Merge input: ${inputPathForWorker}. Write the merge result to ${resultPathForWorker}.`;

  const result = await runWorker({
    name: `notion-merge-${sanitizedKey}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 5 * 60_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Merge worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  const mergeResult = readMergeResult(edit.notionKey);
  if (!mergeResult) {
    throw new Error(`Merge worker did not produce result for ${edit.notionKey}`);
  }

  activityBus.log("notion-merge:complete", `Merge complete for ${edit.notionKey}: ${mergeResult.conflicts.length} conflicts`, {
    jobId,
    notionKey: edit.notionKey,
    conflicts: mergeResult.conflicts.length,
  });

  for (const conflict of mergeResult.conflicts) {
    const delta: import("./notion-inbound.js").InboundDelta = {
      notionKey: edit.notionKey,
      editType: "unknown",
      sourceNodes: edit.sourceNodes,
      observation: `Merge conflict in "${conflict.section}": ${conflict.resolution}. Human: ${conflict.humanVersion?.slice(0, 100)}. Agent: ${conflict.agentVersion?.slice(0, 100)}.`,
      targetFile: "",
      action: "log_conflict",
      payload: {
        section: conflict.section,
        resolution: conflict.resolution,
      },
    };
    applyInboundDeltas([delta]);
  }
}

async function runNotionTriage(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as NotionInboundTriagePayload;

  activityBus.log("notion-triage:start", `Notion triage starting: ${payload.events.length} event(s)`, {
    jobId: job.id,
    date: payload.date,
    eventCount: payload.events.length,
  });

  type TriageRoute = "ignore" | "record" | "enrich" | "both";
  interface TriageDecision {
    pageId: string;
    notionKey: string | null;
    eventType: string;
    route: TriageRoute;
    target: string;
    reason: string;
  }

  const IGNORE_EVENTS = new Set([
    "page.deleted", "page.undeleted", "page.locked", "page.unlocked",
    "page.moved",
    "database.created", "database.deleted", "database.undeleted",
    "database.moved", "database.content_updated", "database.schema_updated",
    "data_source.created", "data_source.deleted", "data_source.undeleted",
    "data_source.moved", "data_source.content_updated", "data_source.schema_updated",
    "comment.updated", "comment.deleted",
  ]);

  const decisions: TriageDecision[] = [];
  const skipped: Array<{ pageId: string; reason: string }> = [];

  for (const event of payload.events) {
    const isBot = (event.authors || []).some(a => a.type === "bot" || a.type === "scheduled_bot");
    if (isBot) {
      skipped.push({ pageId: event.pageId, reason: "bot-authored" });
      continue;
    }

    if (IGNORE_EVENTS.has(event.eventType)) {
      skipped.push({ pageId: event.pageId, reason: `structural: ${event.eventType}` });
      continue;
    }

    const route = classifyEvent(event);
    const target = resolveStewardTarget(event.notionKey, event.eventType);

    decisions.push({
      pageId: event.pageId,
      notionKey: event.notionKey,
      eventType: event.eventType,
      route,
      target,
      reason: triageReason(event.eventType, route),
    });
  }

  const recordDecisions = decisions.filter(d => d.route === "record" || d.route === "both");
  const enrichDecisions = decisions.filter(d => d.route === "enrich" || d.route === "both");

  activityBus.log("notion-triage:complete", `Triage complete: ${recordDecisions.length} record, ${enrichDecisions.length} enrich, ${skipped.length} skipped`, {
    jobId: job.id,
    recordCount: recordDecisions.length,
    enrichCount: enrichDecisions.length,
    skippedCount: skipped.length,
  });

  if (recordDecisions.length > 0) {
    const deltas = recordDecisions.map(d => ({
      notionKey: d.notionKey || d.pageId,
      editType: d.eventType.includes("comment") ? "preference_edit" as const : "new_section" as const,
      sourceNodes: [],
      observation: `[Notion triage] ${d.reason}`,
      targetFile: "",
      action: "create_observation" as const,
      payload: { eventType: d.eventType, target: d.target },
    }));
    const applyResult = applyInboundDeltas(deltas);
    writeInboundDeltas(deltas, payload.date);
    activityBus.log("notion-triage:record", `Recorded ${applyResult.applied} observation(s) from triage`, {
      jobId: job.id,
      applied: applyResult.applied,
      errors: applyResult.errors,
    });
  }

  if (enrichDecisions.length > 0) {
    const enrichPayload: NotionInboundEnrichPayload = {
      reason: "triage",
      triageId: job.id,
      routes: enrichDecisions.map(d => ({
        action: d.route === "both" ? "both" as const : "enrich" as const,
        target: d.target,
        notionKey: d.notionKey || d.pageId,
        pageId: d.pageId,
        reason: d.reason,
      })),
      date: payload.date,
    };

    const { job: enrichJob, created } = enqueueJob({
      type: "notion_inbound_enrich",
      payload: enrichPayload,
      triggerSource: `triage:${job.id}`,
      idempotencyKey: `enrich:${payload.date}:${job.id}`,
    });

    if (created) {
      activityBus.log("notion-triage:enrich", `Queued enrichment job`, {
        jobId: enrichJob.id,
        itemCount: enrichDecisions.length,
      });
    }
  }
}

type TriageRoute = "ignore" | "record" | "enrich" | "both";

interface TriageEvent {
  eventType: string;
  pageId: string;
  notionKey: string | null;
  authors: Array<{ id: string; type: string }>;
  parentType?: string;
}

function classifyEvent(event: TriageEvent): TriageRoute {
  if (event.eventType === "comment.created") return "record";
  if (event.eventType === "page.content_updated") return "record";
  if (event.eventType === "page.properties_updated") return "record";

  if (event.eventType === "page.created") {
    const isDatabase = event.parentType === "database" || event.parentType === "data_source";
    if (isDatabase) {
      try {
        const content = getPage(event.pageId);
        const bodyText = content.replace(/[\s\n\r]/g, "");
        if (bodyText.length < 100) return "enrich";
        return "both";
      } catch {
        return "enrich";
      }
    }
    return "enrich";
  }

  return "record";
}

function resolveStewardTarget(notionKey: string | null, eventType: string): string {
  if (!notionKey) return "tasks_steward";
  if (notionKey.startsWith("task:")) return "tasks_steward";
  if (notionKey.startsWith("decisions/")) return "knowledge_steward";
  if (notionKey.startsWith("dream:")) return "knowledge_steward";
  if (notionKey.startsWith("pattern:")) return "knowledge_steward";
  if (notionKey.startsWith("projects/")) return "workspace_steward";
  if (notionKey === "how-i-think" || notionKey === "patterns-insights" || notionKey === "dreams") return "workspace_steward";
  return "tasks_steward";
}

function triageReason(eventType: string, route: TriageRoute): string {
  if (route === "ignore") return `Ignored: ${eventType}`;
  if (route === "enrich") return `New sparse content from ${eventType} — needs enrichment`;
  if (route === "both") return `Substantive new content from ${eventType} — record and enrich`;
  return `Human edit via ${eventType} — recording to memory`;
}

async function runNotionEnrich(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as NotionInboundEnrichPayload;

  activityBus.log("notion-enrich:start", `Notion enrichment starting: ${payload.routes.length} item(s)`, {
    jobId: job.id,
    date: payload.date,
    itemCount: payload.routes.length,
  });

  const notionState = readNotionSyncState();

  const enrichItems = payload.routes.map(route => {
    let properties: Record<string, unknown> = {};
    let bodyContent = "";
    try {
      const pageContent = getPage(route.pageId);
      bodyContent = pageContent;
    } catch {}

    return {
      notionKey: route.notionKey,
      pageId: route.pageId,
      properties,
      bodyContent,
      triageReason: route.reason,
    };
  });

  const enrichInputPath = path.join(CONFIG.paths.graphRoot, `.notion-enrich-input-${payload.date}-${job.id}.json`);
  fs.writeFileSync(enrichInputPath, JSON.stringify({
    date: payload.date,
    enrichmentId: job.id,
    target: payload.routes[0]?.target || "tasks_steward",
    items: enrichItems,
  }, null, 2));

  const enrichInputPathForWorker = toWorkerPath(enrichInputPath);
  const enrichPlanPathForWorker = toWorkerPath(
    path.join(CONFIG.paths.graphRoot, `.notion-enrich-plan-${payload.date}-${job.id}.json`)
  );
  const enrichAgentPath = path.join(AGENTS_DIR, "notion-enrichment-steward.md");
  const syncStatePathForWorker = toWorkerPath(CONFIG.paths.notionSyncState);

  let manifestPathForWorker = "";
  try {
    const manifest = buildWorkspaceManifest(notionState);
    const manifestPath = writeWorkspaceManifest(manifest);
    manifestPathForWorker = toWorkerPath(manifestPath);
  } catch {}

  const prompt = `Read the enrichment steward instructions at ${enrichAgentPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Enrichment input: ${enrichInputPathForWorker}. Sync state: ${syncStatePathForWorker}. Workspace manifest: ${manifestPathForWorker}. Write the enrichment plan to ${enrichPlanPathForWorker}. Date: ${payload.date}.`;

  const result = await runWorker({
    name: `notion-enrich-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 10 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Enrichment worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  const enrichPlanPath = path.join(CONFIG.paths.graphRoot, `.notion-enrich-plan-${payload.date}-${job.id}.json`);
  if (!fs.existsSync(enrichPlanPath)) {
    activityBus.log("notion-enrich:complete", "Enrichment worker produced no plan");
    return;
  }

  const enrichPlan = JSON.parse(fs.readFileSync(enrichPlanPath, "utf-8")) as {
    enrichmentId: string;
    updates: Array<{
      notionPageId: string;
      notionKey: string;
      type: string;
      changedProperties: Record<string, unknown>;
      markdown: string;
      sourceNodes: string[];
    }>;
    observations: Array<{
      project: string;
      type: string;
      observation: string;
      evidence: string[];
      confidence: number;
    }>;
  };

  if (enrichPlan.updates.length > 0) {
    const stewardPlan: StewardPlan = {
      steward: "enrichment",
      generatedAt: new Date().toISOString(),
      creates: [],
      updates: enrichPlan.updates.map(u => ({
        ...u,
        type: (u.type === "wiki_page" ? "wiki_page" : "database_row") as "database_row" | "wiki_page",
        mergeStrategy: "replace" as const,
      })),
      archives: [],
    };

    const syncPlan = mergeStewardPlans([stewardPlan], job.id);
    const syncResult = executeNotionSync(syncPlan, notionState);
    writeNotionSyncState(notionState);

    activityBus.log("notion-enrich:sync", `Enrichment sync: ${syncResult.created} created, ${syncResult.updated} updated`, {
      jobId: job.id,
      ...syncResult,
    });
  }

  if (enrichPlan.observations && enrichPlan.observations.length > 0) {
    for (const obs of enrichPlan.observations) {
      try {
        if (obs.project && obs.project !== "global") {
          ensureLens(obs.project);
          appendProjectObservation(obs.project, {
            type: "notion_inbound",
            observation: obs.observation,
            evidence: obs.evidence,
            confidence: obs.confidence,
            sessionId: "notion-enrich",
          });
        } else {
          appendObservation({
            layer: "global",
            type: "notion_inbound",
            observation: obs.observation,
            evidence: obs.evidence,
            confidence: obs.confidence,
            sessionId: "notion-enrich",
          });
        }
      } catch (err: any) {
        activityBus.log("notion-enrich:error", `Failed to write observation: ${err.message}`);
      }
    }
  }

  activityBus.log("notion-enrich:complete", `Enrichment complete: ${enrichPlan.updates.length} updates, ${(enrichPlan.observations || []).length} observations`, {
    jobId: job.id,
    updates: enrichPlan.updates.length,
    observations: (enrichPlan.observations || []).length,
  });

  try { fs.unlinkSync(enrichInputPath); } catch {}
}

async function runNotionSync(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { reason: string; date: string; forceFullSync?: boolean; skipInbound?: boolean };

  activityBus.log("notion-sync:start", `Notion sync starting: ${payload.reason}`, {
    jobId: job.id,
    date: payload.date,
    forceFullSync: payload.forceFullSync || false,
  });

  const notionState = readNotionSyncState();
  if (!notionState.parentPageId) {
    activityBus.log("notion-sync:error", "Notion sync skipped — no parent page ID configured");
    return;
  }

  const ntnReady = process.env.NOTION_API_TOKEN
    ? { installed: true, authenticated: true, workspaceSelected: true }
    : checkNtnReady();
  if (!ntnReady.installed || !ntnReady.authenticated || !ntnReady.workspaceSelected) {
    const reason = ntnReady.error || "Notion CLI is not ready";
    activityBus.log("notion-sync:error", `Notion sync blocked — ${reason}`, {
      jobId: job.id,
      installed: ntnReady.installed,
      authenticated: ntnReady.authenticated,
      workspaceSelected: ntnReady.workspaceSelected,
    });
    throw new Error(`Notion sync blocked: ${reason}`);
  }

  if (!payload.skipInbound && !CONFIG.notionSync.skipInbound) {
    const inboundResult = detectInboundEdits(notionState);

    const commentDetections = detectNewComments(notionState);
    if (commentDetections.length > 0) {
      const commentDeltas = buildCommentDetections(commentDetections);
      const { applied, errors: commentErrors } = applyInboundDeltas(commentDeltas);
      activityBus.log("notion-sync:comments", `Processed ${applied} new comment(s) from Notion`, {
        jobId: job.id,
        commentCount: commentDetections.reduce((sum, d) => sum + d.comments.length, 0),
      });
      if (commentErrors.length > 0) {
        activityBus.log("notion-inbound:error", `Comment processing had ${commentErrors.length} errors`, {
          jobId: job.id,
          errors: commentErrors,
        });
      }
    }

    const newNotionTasks = detectNewNotionTasks(notionState);
    if (newNotionTasks.length > 0) {
      activityBus.log("notion-sync:new-tasks", `Detected ${newNotionTasks.length} new task(s) created in Notion`, {
        jobId: job.id,
        tasks: newNotionTasks.map(t => t.name),
      });
      for (const task of newNotionTasks) {
        if (task.project) {
          addNotionPickupItem(task.project, `[Notion] New task "${task.name}" (${task.status})`);
        }
      }
    }

    writeNotionSyncState(notionState);

    if (inboundResult.edits.length > 0) {
      activityBus.log("notion-sync:start", `Inbound detected ${inboundResult.edits.length} human edit(s) before outbound`, {
        jobId: job.id,
        inboundEdits: inboundResult.edits.length,
      });
    }

    if (inboundResult.errors.length > 0) {
      activityBus.log("notion-inbound:error", `Inbound fetch had ${inboundResult.errors.length} errors`, {
        jobId: job.id,
        errors: inboundResult.errors,
      });
    }
  }

  const diff = buildNotionDiff(notionState);

  const changedItems = diff.items.filter(
    (i) => i.classification === "new" || i.classification === "updated"
  );

  changedItems.sort((a, b) => {
    const confA = (a.metadata?.confidence as number) ?? 1;
    const confB = (b.metadata?.confidence as number) ?? 1;
    return confB - confA;
  });

  if (changedItems.length === 0 && !payload.forceFullSync) {
    activityBus.log("notion-sync:complete", "Notion sync skipped — no changes", {
      jobId: job.id,
      date: payload.date,
    });
    return;
  }

  activityBus.log("notion-sync:start", `Notion sync: ${changedItems.length} changed items`, {
    jobId: job.id,
    date: payload.date,
    totalChanged: changedItems.length,
  });

  const partialDiff: import("./notion-sync.js").NotionSyncDiff = {
    generatedAt: diff.generatedAt,
    items: changedItems,
    stats: {
      new: changedItems.filter((i) => i.classification === "new").length,
      updated: changedItems.filter((i) => i.classification === "updated").length,
      archived: changedItems.filter((i) => i.classification === "archived").length,
      unchanged: 0,
      total: changedItems.length,
    },
    batches: [...new Set(changedItems.map((i) => i.batch))],
  };

  const diffReportPath = writeDiffReport(partialDiff);
  const diffReportPathForWorker = toWorkerPath(diffReportPath);
  const statePathForWorker = toWorkerPath(CONFIG.paths.notionSyncState);

  let manifestPathForWorker = "";
  try {
    const manifest = buildWorkspaceManifest(notionState);
    const manifestPath = writeWorkspaceManifest(manifest);
    manifestPathForWorker = toWorkerPath(manifestPath);
    activityBus.log("notion-sync:manifest", `Workspace manifest built: ${Object.keys(manifest.pages).length} pages, ${Object.values(manifest.databases).reduce((s, d) => s + d.rowCount, 0)} database rows`, {
      jobId: job.id,
      pageCount: Object.keys(manifest.pages).length,
      totalRows: Object.values(manifest.databases).reduce((s, d) => s + d.rowCount, 0),
    });
  } catch (err: any) {
    activityBus.log("notion-sync:warn", `Manifest build failed (agent will work without it): ${err.message}`, {
      jobId: job.id,
    });
  }

  const stewardDefs = [
    { name: "projects", agentFile: "notion-project-steward.md", planFile: ".notion-plan-projects.json" },
    { name: "knowledge", agentFile: "notion-knowledge-steward.md", planFile: ".notion-plan-knowledge.json" },
    { name: "workspace", agentFile: "notion-workspace-steward.md", planFile: ".notion-plan-workspace.json" },
    { name: "tasks", agentFile: "notion-tasks-steward.md", planFile: ".notion-plan-tasks.json" },
  ];

  const stewardPlans: StewardPlan[] = [];

  for (const steward of stewardDefs) {
    const agentPath = path.join(AGENTS_DIR, steward.agentFile);
    const planOutputPath = path.join(CONFIG.paths.graphRoot, steward.planFile);
    const planOutputPathForWorker = toWorkerPath(planOutputPath);

    const prompt = `Read the steward instructions at ${agentPath}. Graph root: ${CONFIG.paths.graphRoot}. Diff report: ${diffReportPathForWorker}. Sync state: ${statePathForWorker}. Workspace manifest: ${manifestPathForWorker}. Write your plan to ${planOutputPathForWorker}. Date: ${payload.date}.`;

    activityBus.log("notion-sync:steward", `Running ${steward.name} steward`, { jobId: job.id, steward: steward.name });

    let result;
    try {
      result = await runWorker({
        name: `notion-${steward.name}-${job.id}`,
        prompt,
        graphRoot: CONFIG.paths.graphRoot,
        logDir: CONFIG.paths.pipelineLogs,
        addDirs: [AGENTS_DIR],
        timeoutMs: 10 * 60_000,
      });
    } catch (err: any) {
      activityBus.log("notion-sync:warn", `${steward.name} steward failed: ${err.message}`, {
        jobId: job.id,
        steward: steward.name,
      });
      continue;
    }

    job.logFile = result.logFile;
    job.workerPid = result.pid;
    updateRunningJob(job);

    if (result.exitCode !== 0) {
      activityBus.log("notion-sync:warn", `${steward.name} steward exited with code ${result.exitCode}`, {
        jobId: job.id,
        steward: steward.name,
        logFile: result.logFile,
      });
      continue;
    }

    const stewardPlan = readStewardPlan(planOutputPath);
    if (stewardPlan) {
      stewardPlans.push(stewardPlan);
      activityBus.log("notion-sync:steward", `${steward.name} steward produced ${stewardPlan.creates.length} creates, ${stewardPlan.updates.length} updates, ${stewardPlan.archives.length} archives`, {
        jobId: job.id,
        steward: steward.name,
        creates: stewardPlan.creates.length,
        updates: stewardPlan.updates.length,
        archives: stewardPlan.archives.length,
      });
    } else {
      activityBus.log("notion-sync:warn", `${steward.name} steward completed without producing a plan`, {
        jobId: job.id,
        steward: steward.name,
      });
    }
  }

  if (stewardPlans.length === 0) {
    activityBus.log("notion-sync:complete", "Notion sync skipped — no steward plans produced", {
      jobId: job.id,
      date: payload.date,
    });
    return;
  }

  const mergedPlan = mergeStewardPlans(stewardPlans, job.id);
  const mergedPlanPath = path.join(CONFIG.paths.graphRoot, ".notion-sync-plan.json");
  fs.writeFileSync(mergedPlanPath, JSON.stringify(mergedPlan, null, 2));

  activityBus.log("notion-sync:merge", `Merged ${stewardPlans.length} steward plans: ${mergedPlan.creates.length} creates, ${mergedPlan.updates.length} updates, ${mergedPlan.archives.length} archives`, {
    jobId: job.id,
    stewards: stewardPlans.map(p => p.steward),
  });

  const syncResult = executeNotionSync(mergedPlan, notionState);

  if (syncResult.errors.length > 0) {
    activityBus.log("notion-sync:error", `Notion sync had ${syncResult.errors.length} errors`, {
      jobId: job.id,
      errors: syncResult.errors,
    });
    throw new Error(`Notion sync failed with ${syncResult.errors.length} error(s)`);
  }

  for (const item of changedItems) {
    if (item.classification === "new" || item.classification === "updated") {
      if (notionState.rows[item.key]) {
        notionState.rows[item.key].lastSourceHash = item.contentHash;
      }
      for (const pageState of Object.values(notionState.pages)) {
        if (pageState.sourceNodes.some((src) => {
          const normalized = src.replace(/^nodes\//, "").replace(/\.md$/, "");
          return normalized === item.key || src === item.key;
        })) {
          pageState.lastSourceHash = item.contentHash;
        }
      }
    }
  }

  notionState.lastSyncAt = new Date().toISOString();
  writeNotionSyncState(notionState);

  activityBus.log("notion-sync:complete", `Notion sync complete: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.archived} archived`, {
    jobId: job.id,
    date: payload.date,
    ...syncResult,
  });
}

async function runSkillforge(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { nodePath: string; project: string; reason: string; score: number; sourceNodes?: string[]; candidateType?: string };
  const skillforgePath = path.join(AGENTS_DIR, "memory-skillforge.md");

  const sourceNodes = payload.sourceNodes || [payload.nodePath];
  const candidateType = payload.candidateType || "single_node";
  const contentHash = sourceNodes.length > 1
    ? computeMultiNodeContentHash(sourceNodes)
    : computeNodeContentHash(sourceNodes[0]);

  const prompt = `Read the skillforge instructions at ${skillforgePath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Source node paths: ${sourceNodes.join(", ")}. Candidate type: ${candidateType}. Project: ${payload.project}. Score: ${payload.score}. Content hash: ${contentHash}. Reason: ${payload.reason}.`;

  const result = await runWorker({
    name: `skillforge-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 10 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Skillforge worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  const expectedKey = manifestKeyForNodes(sourceNodes);
  const manifestPath = path.join(CONFIG.paths.skillforgeManifests, expectedKey);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Skillforge completed without writing manifest: ${manifestPath}`);
  }

  activityBus.log("skillforge:complete", `Skillforge complete: ${sourceNodes.join(", ")}`, {
    jobId: job.id,
    sourceNodes,
    candidateType,
    project: payload.project,
  });

  try {
    const indexPath = CONFIG.paths.index;
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const now = new Date().toISOString();
    let updated = false;
    for (const nodePath of sourceNodes) {
      const entry = index.find((e: any) => e.path === nodePath);
      if (entry) {
        entry.skillforged_at = now;
        updated = true;
      }
    }
    if (updated) fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  } catch { /* non-critical */ }
}

async function runSkillforgeRefresh(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { manifestPath: string; nodePath: string; skillName: string; project: string; reason: string; sourceNodes?: string[] };
  const skillforgePath = path.join(AGENTS_DIR, "memory-skillforge.md");

  const sourceNodes = payload.sourceNodes || [payload.nodePath];
  const candidateType = sourceNodes.length > 1 ? "cluster" : "single_node";

  const prompt = `Read the skillforge instructions at ${skillforgePath}, then follow them. This is a REFRESH of an existing skill. Graph root: ${CONFIG.paths.graphRoot}. Source node paths: ${sourceNodes.join(", ")}. Candidate type: ${candidateType}. Project: ${payload.project}. Skill name: ${payload.skillName}. Reason: ${payload.reason}. The skill files already exist — overwrite them with updated content. Increment refresh_count in the manifest and update content_hash and last_refreshed_at.`;

  const result = await runWorker({
    name: `skillforge-refresh-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 10 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Skillforge refresh worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  activityBus.log("skillforge:refresh", `Skillforge refresh complete: ${sourceNodes.join(", ")}`, {
    jobId: job.id,
    sourceNodes,
    skillName: payload.skillName,
  });

  const authoritativeHash = sourceNodes.length > 1
    ? computeMultiNodeContentHash(sourceNodes)
    : computeNodeContentHash(sourceNodes[0]);

  if (authoritativeHash && fs.existsSync(payload.manifestPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(payload.manifestPath, "utf-8"));
      mf.content_hash = authoritativeHash;
      mf.last_refreshed_at = new Date().toISOString();
      mf.refresh_count = (mf.refresh_count || 0) + 1;
      fs.writeFileSync(payload.manifestPath, JSON.stringify(mf, null, 2));
    } catch { /* non-critical */ }
  }
}

function maybeEnqueueSkillforgeJobs(): void {
  if (!CONFIG.skillforge.enabled) return;

  const candidates = scoreCandidates();
  if (candidates.length === 0) return;

  const maxPerTick = CONFIG.skillforge.maxJobsPerTick;
  let enqueued = 0;

  for (const candidate of candidates) {
    if (enqueued >= maxPerTick) break;
    if (hasActiveJob("skillforge")) break;

    const sourceNodes = candidate.sourceNodes || [candidate.nodePath];
    const idemKey = `skillforge:${sourceNodes.sort().join("+")}`;

    const { job, created } = enqueueJob({
      type: "skillforge",
      payload: {
        nodePath: candidate.nodePath,
        sourceNodes,
        candidateType: candidate.candidateType,
        project: candidate.project || "global",
        reason: `${candidate.candidateType} score: ${candidate.score}`,
        score: candidate.score,
      },
      triggerSource: "daemon:skillforge-scorer",
      idempotencyKey: idemKey,
    });

    if (created) {
      enqueued++;
      activityBus.log("skillforge:job_queued", `Queued skillforge job for ${sourceNodes.join(", ")}`, {
        jobId: job.id,
        sourceNodes,
        candidateType: candidate.candidateType,
        score: candidate.score,
        project: candidate.project,
      });
    }
  }
}

function maybeEnqueueSkillforgeRefresh(): void {
  if (!CONFIG.skillforge.enabled) return;

  const drifted = findDriftedManifests();
  if (drifted.length === 0) return;

  const maxPerTick = CONFIG.skillforge.maxJobsPerTick;
  let enqueued = 0;

  for (const entry of drifted) {
    if (enqueued >= maxPerTick) break;
    if (hasActiveJob("skillforge_refresh")) break;

    const sourceNodes = entry.manifest.source_nodes || [entry.manifest.source_nodes?.[0] || ""];
    const { job, created } = enqueueJob({
      type: "skillforge_refresh",
      payload: {
        manifestPath: path.join(CONFIG.paths.skillforgeManifests, entry.fileName),
        nodePath: sourceNodes[0],
        sourceNodes,
        skillName: entry.manifest.skill_name,
        project: entry.manifest.project,
        reason: `content hash drift: ${entry.manifestHash} → ${entry.currentHash}`,
      },
      triggerSource: "daemon:skillforge-drift",
      idempotencyKey: `skillforge-refresh:${sourceNodes.sort().join("+")}:${entry.currentHash}`,
    });

    if (created) {
      enqueued++;
      activityBus.log("skillforge:drift_detected", `Skill drift detected for ${sourceNodes.join(", ")}`, {
        jobId: job.id,
        sourceNodes,
        oldHash: entry.manifestHash,
        newHash: entry.currentHash,
      });
    }
  }
}

async function runBootstrap(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    project: string;
    harness: string;
    cwd: string;
    reason: string;
  };

  const result = bootstrapProjectDoc(payload.project, payload.harness, payload.cwd);

  activityBus.log("system:info", "Bootstrap project doc complete", {
    jobId: job.id,
    project: payload.project,
    filePath: result.filePath,
    created: result.created,
    sections: result.sections,
  });
}

async function processJob(job: GraphMemoryJob): Promise<void> {
  switch (job.type) {
    case "scribe":
      return runScribe(job);
    case "observer":
      return runObserver(job);
    case "compressor":
      return runCompressor(job);
    case "working_update":
      return runWorkingUpdate(job);
    case "auditor":
      return runAuditor(job);
    case "librarian":
      return runLibrarian(job);
    case "dreamer":
      return runDreamer(job);
    case "memory_analysis":
      return runMemoryAnalysis(job);
    case "skillforge":
      return runSkillforge(job);
    case "skillforge_refresh":
      return runSkillforgeRefresh(job);
    case "bootstrap_project_doc":
      return runBootstrap(job);
    case "notion_sync":
      return runNotionSync(job);
    case "notion_inbound_triage":
      return runNotionTriage(job);
    case "notion_inbound_enrich":
      return runNotionEnrich(job);
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

function cleanupOrphanSnapshots(): void {
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) return;

  const MAX_AGE_MS = 4 * 60 * 60 * 1000;
  const now = Date.now();
  const runningJobs = listJobs("running");
  const queuedJobs = listJobs("queued");
  const activeSnapshotPaths = new Set<string>();
  for (const j of [...runningJobs, ...queuedJobs]) {
    const sp = (j.payload as any)?.snapshotPath;
    if (sp) activeSnapshotPaths.add(sp);
  }

  let cleaned = 0;
  for (const file of fs.readdirSync(bufferDir)) {
    if (!file.startsWith("snapshot_") || !file.endsWith(".jsonl")) continue;

    const filePath = path.join(bufferDir, file);
    if (activeSnapshotPaths.has(filePath)) continue;

    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < MAX_AGE_MS) continue;

      fs.unlinkSync(filePath);
      cleaned++;
    } catch {}
  }

  if (cleaned > 0) {
    activityBus.log("system:info", `Cleaned ${cleaned} orphan snapshot(s) older than 4 hours`);
  }
}

function scavengeStaleBuffers(): void {
  const bufferDir = CONFIG.paths.buffer;
  if (!fs.existsSync(bufferDir)) return;

  const maxAgeMs = 2 * 60 * 60 * 1000;
  const now = Date.now();
  let scavenged = 0;

  for (const file of fs.readdirSync(bufferDir)) {
    if (!file.startsWith("conversation-") || !file.endsWith(".jsonl")) continue;

    const filePath = path.join(bufferDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < maxAgeMs) continue;

      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (!content) {
        fs.unlinkSync(filePath);
        continue;
      }

      const snapshotName = `snapshot_${Date.now()}.jsonl`;
      const snapshotPath = path.join(bufferDir, snapshotName);
      fs.writeFileSync(snapshotPath, content + "\n");
      fs.unlinkSync(filePath);

      enqueueJob({
        type: "scribe",
        payload: {
          snapshotPath,
          sessionId: `stale_scavenge_${Date.now()}`,
        },
        triggerSource: "daemon:stale-buffer-scavenge",
        idempotencyKey: `scribe:${snapshotPath}`,
      });

      scavenged++;
    } catch {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  if (scavenged > 0) {
    activityBus.log("system:info", `Scavenged ${scavenged} stale session buffer(s)`, { scavenged });
  }
}

let lastLogRotation = 0;
function rotatePipelineLogs(maxAgeDays: number = 30): void {
  const now = Date.now();
  if (now - lastLogRotation < 60 * 60 * 1000) return;
  lastLogRotation = now;

  const logDir = CONFIG.paths.pipelineLogs;
  if (!fs.existsSync(logDir)) return;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const file of fs.readdirSync(logDir)) {
    if (!file.endsWith(".log") && !file.endsWith(".meta.json")) continue;

    const filePath = path.join(logDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      fs.unlinkSync(filePath);
      removed++;
    }
  }

  if (removed > 0) {
    activityBus.log("system:info", `Rotated ${removed} pipeline log(s) older than ${maxAgeDays} days`);
  }
}

function pruneSessionDirectories(maxAgeDays: number = 14): void {
  const sessionsDir = CONFIG.paths.sessionTraces;
  if (!fs.existsSync(sessionsDir)) return;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  for (const entry of fs.readdirSync(sessionsDir)) {
    const entryPath = path.join(sessionsDir, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed++;
      }
    } catch { /* skip */ }
  }

  if (removed > 0) {
    activityBus.log("system:info", `Pruned ${removed} session director(ies) older than ${maxAgeDays} days`);
  }
}

function getInFlightProjectChains(inFlight: Map<string, Promise<void>>): Set<string> {
  const projects = new Set<string>();
  for (const job of listJobs("running")) {
    if (!PROJECT_CHAIN_TYPES.has(job.type)) continue;
    const project = (job.payload as unknown as Record<string, unknown>)?.project;
    if (typeof project === "string" && project !== "global") {
      projects.add(project);
    }
  }
  return projects;
}

function maybeEnqueueProjectAuditorsFromBacklog(): void {
  const activeProjects = new Set<string>();

  for (const file of fs.readdirSync(CONFIG.paths.deltas).filter((f) => f.endsWith(".json"))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIG.paths.deltas, file), "utf-8")) as {
        scribes?: Array<{ deltas?: Array<{ project?: string }> }>;
      };
      for (const scribe of raw.scribes || []) {
        for (const delta of scribe.deltas || []) {
          const p = String(delta.project || "").trim();
          if (p && p !== "global") activeProjects.add(p);
        }
      }
    } catch { /* skip */ }
  }

  for (const project of activeProjects) {
    maybeEnqueueAuditorForProject(project);
  }
}

export async function runDaemon({ once = false }: { once?: boolean } = {}): Promise<void> {
  if (!isGraphInitialized()) {
    initializeGraph();
  }
  ensureJobDirectories();
  acquireDaemonLock();
  requeueStaleRunningJobs(60_000);

  process.on("exit", releaseDaemonLock);
  process.on("SIGINT", () => { releaseDaemonLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseDaemonLock(); process.exit(0); });

  if (CONFIG.notionSync.enabled) {
    startWebhookServer(3100).catch((err: any) => {
      activityBus.log("notion-webhook:error", `Webhook server failed to start: ${err.message}`);
    });
  }

  const concurrency = CONFIG.session.daemonConcurrency || 3;
  const inFlight = new Map<string, Promise<void>>();

  activityBus.log("system:info", "Graph-memory daemon started", { once, concurrency });

  try {
    do {
      try {
        maybeEnqueueDailyAnalysisJob();
        maybeEnqueueNotionSync();
        maybeEnqueueProjectAuditorsFromBacklog();
        maybeEnqueueObserverFromScribeBacklog();
        maybeEnqueueCompressorFromObserverBacklog();
        reconcileProjectWorkingBacklog();
        maybeEnqueueSkillforgeJobs();
        maybeEnqueueSkillforgeRefresh();
        scavengeStaleBuffers();
        cleanupOrphanSnapshots();
        rotatePipelineLogs();
        pruneSessionDirectories();
        requeueOrphanedRunningJobs(inFlight, 60_000);
        requeueStaleRunningJobs(30 * 60_000);
      } catch (err: any) {
        activityBus.log("system:error", `Tick housekeeping error: ${err.message}`);
      }

      try {
        const { decayed, archived } = runDecay();
        if (decayed > 0 || archived > 0) {
          regenerateCoreContextFiles();
          activityBus.log("daemon:decay", `Tick decay: ${decayed} decayed, ${archived} archived`, {
            decayed,
            archived,
          });
        }
      } catch (err: any) {
        activityBus.log("system:error", `Decay pass failed: ${err.message}`);
      }

      writeDaemonState({
        running: true,
        pid: process.pid,
        queued: countJobs("queued"),
        runningJobs: countJobs("running"),
        concurrency,
        inFlight: inFlight.size,
      });

      const activeProjectChains = getInFlightProjectChains(inFlight);
      const globalChainRunning = hasRunningGlobalChain(inFlight);

      while (inFlight.size < concurrency) {
        const job = claimNextProjectAwareJob(activeProjectChains, globalChainRunning);
        if (!job) break;

        const jobPromise = processJob(job)
          .then(() => { completeRunningJob(job); })
          .catch((err: any) => { failRunningJob(job, err?.message || String(err)); })
          .finally(() => { inFlight.delete(job.id); });

        inFlight.set(job.id, jobPromise);

        const jobProject = (job.payload as unknown as Record<string, unknown>)?.project;
        if (typeof jobProject === "string" && jobProject !== "global" && PROJECT_CHAIN_TYPES.has(job.type)) {
          activeProjectChains.add(jobProject);
        }
      }

      if (inFlight.size === 0) {
        if (once) break;
        await sleep(CONFIG.session.daemonPollMs);
      } else {
        await Promise.race([
          ...Array.from(inFlight.values()),
          new Promise((resolve) => setTimeout(resolve, CONFIG.session.daemonPollMs)),
        ]);
      }
    } while (!once);
  } catch (err: any) {
    activityBus.log("system:error", `Daemon fatal error: ${err.message}`, {
      stack: err.stack?.slice(0, 500),
    });
  } finally {
    if (inFlight.size > 0) {
      activityBus.log("system:info", `Daemon shutting down, waiting for ${inFlight.size} in-flight job(s)`);
      await Promise.allSettled(Array.from(inFlight.values()));
    }
    writeDaemonState({ running: false, pid: process.pid });
    releaseDaemonLock();
  }
}

function claimNextProjectAwareJob(
  activeProjectChains: Set<string>,
  globalChainRunning: boolean,
): GraphMemoryJob | null {
  ensureJobDirectories();
  const sorted = listJobs("queued")
    .sort((a, b) => {
      const priority = PRIORITY[a.type] - PRIORITY[b.type];
      if (priority !== 0) return priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

  for (const job of sorted) {
    if (!canClaimJob(job, activeProjectChains, globalChainRunning)) continue;

    const queuedPath = jobFilePath(job, "queued");
    if (!fs.existsSync(queuedPath)) continue;

    const runningJob: GraphMemoryJob = {
      ...job,
      state: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: job.attempt + 1,
    };

    fs.renameSync(queuedPath, jobFilePath(runningJob, "running"));
    fs.writeFileSync(jobFilePath(runningJob, "running"), JSON.stringify(runningJob, null, 2));
    return runningJob;
  }

  return null;
}

function canClaimJob(
  job: GraphMemoryJob,
  activeProjectChains: Set<string>,
  globalChainRunning: boolean,
): boolean {
  if (PROJECT_CHAIN_TYPES.has(job.type)) {
    const project = (job.payload as unknown as Record<string, unknown>)?.project;
    if (typeof project === "string" && project !== "global") {
      return !activeProjectChains.has(project);
    }
    return true;
  }

  if (GLOBAL_CHAIN_TYPES.has(job.type)) {
    return !globalChainRunning;
  }

  return true;
}

function hasRunningGlobalChain(inFlight: Map<string, Promise<void>>): boolean {
  if (Array.from(inFlight.keys()).some((jobId) => {
    const runningJob = listJobs("running").find((job) => job.id === jobId);
    return runningJob ? GLOBAL_CHAIN_TYPES.has(runningJob.type) : false;
  })) {
    return true;
  }

  return listJobs("running").some((job) => GLOBAL_CHAIN_TYPES.has(job.type));
}

function requeueOrphanedRunningJobs(inFlight: Map<string, Promise<void>>, maxAgeMs: number): number {
  const now = Date.now();
  let count = 0;

  for (const job of listJobs("running")) {
    if (inFlight.has(job.id)) continue;
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.updatedAt);
    if (Number.isNaN(startedAt) || now - startedAt < maxAgeMs) continue;
    requeueRunningJob(job, "Requeued orphaned running job not owned by current daemon");
    count += 1;
  }

  if (count > 0) {
    activityBus.log("system:info", `Requeued ${count} orphaned running job(s)`);
  }

  return count;
}

function jobFilePath(job: Pick<GraphMemoryJob, "id">, state: GraphMemoryJobState): string {
  return path.join(stateDir(state), `${job.id}.json`);
}

function stateDir(state: GraphMemoryJobState): string {
  switch (state) {
    case "queued": return CONFIG.paths.jobsQueued;
    case "running": return CONFIG.paths.jobsRunning;
    case "done": return CONFIG.paths.jobsDone;
    case "failed": return CONFIG.paths.jobsFailed;
  }
}

runDaemon({ once: process.argv.includes("--once") }).catch((err) => {
  console.error(`[graph-memory] daemon error: ${err.message}`);
  releaseDaemonLock();
  process.exit(1);
});
