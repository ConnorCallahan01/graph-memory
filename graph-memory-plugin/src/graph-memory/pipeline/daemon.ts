import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG, isGraphInitialized } from "../config.js";
import { initializeGraph } from "../index.js";
import { activityBus } from "../events.js";
import { generatePreflightReport } from "./preflight.js";
import { claimNextJob, completeRunningJob, countJobs, enqueueJob, ensureJobDirectories, failRunningJob, hasActiveJob, listJobs, requeueStaleRunningJobs, updateRunningJob } from "./job-queue.js";
import { GraphMemoryJob } from "./job-schema.js";
import { runPipelineWorker } from "./worker-runner.js";
import { loadRuntimeConfig } from "../runtime.js";
import { regenerateCoreContextFiles, regenerateDreamContext } from "./graph-ops.js";
import { runDecay } from "./decay.js";
import { updateProjectWorkingFromSession } from "../project-working.js";
import { scoreCandidates, computeNodeContentHash } from "./skillforge-score.js";
import { listManifests, findDriftedManifests } from "./skillforge-manifest.js";import { getAssistantTracePath, getToolTracePath } from "../session-trace.js";
import { getDailyBriefPaths } from "../briefs.js";
import { loadExternalInputsConfig, readRecentClassifiedInputs } from "../external-inputs.js";
import { getProjectWorkingPath, getProjectWorkingStatePath, getProjectWorkingUpdatePath } from "../working-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, "../../../agents");
const LEGACY_MARKERS = [
  CONFIG.paths.scribePending,
  CONFIG.paths.consolidationPending,
  CONFIG.paths.librarianPending,
  CONFIG.paths.dreamerPending,
];
const CONSOLIDATION_LOCK_PATH = path.join(CONFIG.paths.graphRoot, ".consolidation.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function clearLegacyMarkers(): void {
  for (const marker of LEGACY_MARKERS) {
    try {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch { /* ignore */ }
  }
}

function clearConsolidationLock(): void {
  try {
    if (fs.existsSync(CONSOLIDATION_LOCK_PATH)) {
      fs.unlinkSync(CONSOLIDATION_LOCK_PATH);
    }
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
    payload: { reason: `${count} ${reasonPrefix}` },
    triggerSource: "daemon:scribe-threshold",
    idempotencyKey: `auditor:scribe-runs:${latestCompletedAt}`,
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
    if (!project || project === "global" || !sessionId) {
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

function collectRecentActivityForDate(targetDate: string, timeZone: string, maxLines = 120): Array<Record<string, unknown>> {
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
    .slice(-80)
    .map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      triggerSource: job.triggerSource,
      lastError: job.lastError || null,
      payload: job.payload,
    }));
}

function collectSessionTracePathsForDate(targetDate: string, timeZone: string, maxPaths = 30): string[] {
  if (!fs.existsSync(CONFIG.paths.sessions)) return [];

  const paths: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const sessionDir of fs.readdirSync(CONFIG.paths.sessions)) {
    const filePath = path.join(CONFIG.paths.sessions, sessionDir, "tool-trace.jsonl");
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
  if (!fs.existsSync(CONFIG.paths.sessions)) return [];

  const paths: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const sessionDir of fs.readdirSync(CONFIG.paths.sessions)) {
    const filePath = path.join(CONFIG.paths.sessions, sessionDir, "assistant-trace.jsonl");
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

  if (fs.existsSync(CONFIG.paths.sessions)) {
    for (const sessionDir of fs.readdirSync(CONFIG.paths.sessions)) {
      const filePath = path.join(CONFIG.paths.sessions, sessionDir, "tool-trace.jsonl");
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
        source_node: m.source_node,
        skill_name: m.skill_name,
        generated_at: m.generated_at,
        score: m.score,
        project: m.project,
        refresh_count: m.refresh_count,
        last_refreshed_at: m.last_refreshed_at,
      })),
    },
  };

  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2));
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

async function runScribe(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as {
    snapshotPath: string;
    sessionId: string;
    project?: string;
    assistantTracePath?: string;
    toolTracePath?: string;
  };
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

  const result = await runPipelineWorker({
    name: `scribe-${job.id}`,
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

  maybeEnqueueAuditorFromScribeBacklog("successful scribe runs accumulated");
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
  const assistantTracePathForWorker = payload.assistantTracePath ? toWorkerPath(payload.assistantTracePath) : null;
  const toolTracePathForWorker = payload.toolTracePath ? toWorkerPath(payload.toolTracePath) : null;

  const prompt = `Read the working updater instructions at ${updaterPathForWorker}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Project: ${payload.project}. Session ID: ${payload.sessionId}. Delta file: ${deltaPathForWorker}. Project WORKING markdown: ${workingPathForWorker}. Project WORKING state JSON: ${workingStatePathForWorker}.${assistantTracePathForWorker ? ` Assistant trace: ${assistantTracePathForWorker}.` : ""}${toolTracePathForWorker ? ` Tool trace: ${toolTracePathForWorker}.` : ""} Write the session working update artifact JSON to ${updateOutputPathForWorker}.`;

  const result = await runPipelineWorker({
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

  if (!fs.existsSync(updateOutputPath)) {
    throw new Error("Working updater completed without writing a session update artifact");
  }

  updateProjectWorkingFromSession({
    project: payload.project,
    sessionId: payload.sessionId,
    toolTracePath: payload.toolTracePath,
    updatePath: updateOutputPath,
  });
}

async function runAuditor(job: GraphMemoryJob): Promise<void> {
  if (countActiveDeltaFiles() === 0) {
    activityBus.log("system:info", "Skipping auditor job with no active deltas", { jobId: job.id });
    return;
  }

  clearConsolidationLock();
  generatePreflightReport();

  const auditorPath = path.join(AGENTS_DIR, "memory-auditor.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");
  const prompt = `Read the auditor instructions at ${auditorPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Read the preflight report at ${CONFIG.paths.preflightReport} first — it contains the full node manifest and flagged issues with their file contents included. IMPORTANT: when rebuilding context files, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runPipelineWorker({
    name: `auditor-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 12 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Auditor worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  if (!fs.existsSync(CONFIG.paths.auditReport) || !fs.existsSync(CONFIG.paths.auditBrief)) {
    throw new Error("Auditor completed without writing audit artifacts");
  }

  clearLegacyMarkers();
  if (!hasActiveJob("librarian")) {
    enqueueJob({
      type: "librarian",
      payload: { reason: "auditor completed" },
      triggerSource: "daemon:auditor-complete",
      idempotencyKey: `librarian:${fs.statSync(CONFIG.paths.auditReport).mtimeMs}`,
    });
  }
}

async function runLibrarian(job: GraphMemoryJob): Promise<void> {
  clearConsolidationLock();
  const librarianPath = path.join(AGENTS_DIR, "memory-librarian.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");
  const prompt = `Read the librarian instructions at ${librarianPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Read the audit brief at ${CONFIG.paths.auditBrief} and audit report at ${CONFIG.paths.auditReport} first — the auditor has already triaged mechanical fixes and prepared recommendations for you. IMPORTANT: when rebuilding context files, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runPipelineWorker({
    name: `librarian-${job.id}`,
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
    throw new Error(`Librarian worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  regenerateCoreContextFiles();

  clearLegacyMarkers();
  if (!hasActiveJob("dreamer")) {
    enqueueJob({
      type: "dreamer",
      payload: { reason: "librarian completed" },
      triggerSource: "daemon:librarian-complete",
      idempotencyKey: `dreamer:${Date.now()}`,
    });
  }
}

async function runDreamer(job: GraphMemoryJob): Promise<void> {
  clearConsolidationLock();
  const dreamerPath = path.join(AGENTS_DIR, "memory-dreamer.md");
  const graphOpsPath = path.resolve(__dirname, "graph-ops.js");
  const prompt = `Read the dreamer instructions at ${dreamerPath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. IMPORTANT: when rebuilding DREAMS.md, use this absolute path for graph-ops: ${graphOpsPath}`;
  const result = await runPipelineWorker({
    name: `dreamer-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 8 * 60_000,
  });

  job.logFile = result.logFile;
  job.workerPid = result.pid;
  updateRunningJob(job);

  if (result.exitCode !== 0) {
    throw new Error(`Dreamer worker exited with code ${result.exitCode}. See ${result.logFile}`);
  }

  regenerateDreamContext();

  clearLegacyMarkers();
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

  const result = await runPipelineWorker({
    name: `memory-analysis-${job.id}`,
    prompt,
    graphRoot: CONFIG.paths.graphRoot,
    logDir: CONFIG.paths.pipelineLogs,
    addDirs: [AGENTS_DIR],
    timeoutMs: 12 * 60_000,
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

async function runSkillforge(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { nodePath: string; project: string; reason: string; score: number };
  const skillforgePath = path.join(AGENTS_DIR, "memory-skillforge.md");

  const prompt = `Read the skillforge instructions at ${skillforgePath}, then follow them. Graph root: ${CONFIG.paths.graphRoot}. Source node path: ${payload.nodePath}. Project: ${payload.project}. Score: ${payload.score}. Reason: ${payload.reason}.`;

  const result = await runPipelineWorker({
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

  const manifestDir = CONFIG.paths.skillforgeManifests;
  const sanitizedPath = payload.nodePath.replace(/\//g, "-");
  const manifestPath = path.join(manifestDir, `${sanitizedPath}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Skillforge completed without writing manifest: ${manifestPath}`);
  }

  activityBus.log("skillforge:complete", `Skillforge complete: ${payload.nodePath}`, {
    jobId: job.id,
    nodePath: payload.nodePath,
    project: payload.project,
  });

  try {
    const indexPath = CONFIG.paths.index;
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const entry = index.find((e: any) => e.path === payload.nodePath);
    if (entry) {
      entry.skillforged_at = new Date().toISOString();
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }
  } catch { /* non-critical */ }
}

async function runSkillforgeRefresh(job: GraphMemoryJob): Promise<void> {
  const payload = job.payload as { manifestPath: string; nodePath: string; skillName: string; project: string; reason: string };
  const skillforgePath = path.join(AGENTS_DIR, "memory-skillforge.md");

  const manifestRaw = fs.readFileSync(payload.manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw);

  const prompt = `Read the skillforge instructions at ${skillforgePath}, then follow them. This is a REFRESH of an existing skill. Graph root: ${CONFIG.paths.graphRoot}. Source node path: ${payload.nodePath}. Project: ${payload.project}. Skill name: ${payload.skillName}. Reason: ${payload.reason}. The skill files already exist — overwrite them with updated content. Increment refresh_count in the manifest and update content_hash and last_refreshed_at.`;

  const result = await runPipelineWorker({
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

  activityBus.log("skillforge:refresh", `Skillforge refresh complete: ${payload.nodePath}`, {
    jobId: job.id,
    nodePath: payload.nodePath,
    skillName: payload.skillName,
  });

  const authoritativeHash = computeNodeContentHash(payload.nodePath);
  if (authoritativeHash && fs.existsSync(payload.manifestPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(payload.manifestPath, "utf-8"));
      mf.content_hash = authoritativeHash;
      mf.last_refreshed_at = new Date().toISOString();
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

    const { job, created } = enqueueJob({
      type: "skillforge",
      payload: {
        nodePath: candidate.nodePath,
        project: candidate.project || "global",
        reason: `skillforge score: ${candidate.score}`,
        score: candidate.score,
      },
      triggerSource: "daemon:skillforge-scorer",
      idempotencyKey: `skillforge:${candidate.nodePath}`,
    });

    if (created) {
      enqueued++;
      activityBus.log("skillforge:job_queued", `Queued skillforge job for ${candidate.nodePath}`, {
        jobId: job.id,
        nodePath: candidate.nodePath,
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

    const { job, created } = enqueueJob({
      type: "skillforge_refresh",
      payload: {
        manifestPath: path.join(CONFIG.paths.skillforgeManifests, entry.fileName),
        nodePath: entry.manifest.source_node,
        skillName: entry.manifest.skill_name,
        project: entry.manifest.project,
        reason: `content hash drift: ${entry.manifestHash} → ${entry.currentHash}`,
      },
      triggerSource: "daemon:skillforge-drift",
      idempotencyKey: `skillforge-refresh:${entry.manifest.source_node}:${entry.currentHash}`,
    });

    if (created) {
      enqueued++;
      activityBus.log("skillforge:drift_detected", `Skill drift detected for ${entry.manifest.source_node}`, {
        jobId: job.id,
        nodePath: entry.manifest.source_node,
        oldHash: entry.manifestHash,
        newHash: entry.currentHash,
      });
    }
  }
}

async function processJob(job: GraphMemoryJob): Promise<void> {
  switch (job.type) {
    case "scribe":
      return runScribe(job);
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

    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs < MAX_AGE_MS) continue;

    fs.unlinkSync(filePath);
    cleaned++;
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
  }

  if (scavenged > 0) {
    activityBus.log("system:info", `Scavenged ${scavenged} stale session buffer(s)`, { scavenged });
  }
}

const GRAPH_LEVEL_TYPES = new Set(["auditor", "librarian", "dreamer"]);

function hasRunningGraphLevelJob(): boolean {
  return listJobs("running").some((j) => GRAPH_LEVEL_TYPES.has(j.type));
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

  const concurrency = CONFIG.session.daemonConcurrency || 3;
  const inFlight = new Map<string, Promise<void>>();

  activityBus.log("system:info", "Graph-memory daemon started", { once, concurrency });

  try {
    do {
      maybeEnqueueDailyAnalysisJob();
      maybeEnqueueAuditorFromScribeBacklog();
      reconcileProjectWorkingBacklog();
      maybeEnqueueSkillforgeJobs();
      maybeEnqueueSkillforgeRefresh();
      scavengeStaleBuffers();
      cleanupOrphanSnapshots();
      requeueStaleRunningJobs(30 * 60_000);

      if (!hasRunningGraphLevelJob()) {
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
      }

      writeDaemonState({
        running: true,
        pid: process.pid,
        queued: countJobs("queued"),
        runningJobs: countJobs("running"),
        concurrency,
        inFlight: inFlight.size,
      });

      const graphLevelBlocked = hasRunningGraphLevelJob();

      while (inFlight.size < concurrency) {
        const job = claimNextJob();
        if (!job) break;

        if (GRAPH_LEVEL_TYPES.has(job.type) && graphLevelBlocked) {
          const queuedPath = path.join(CONFIG.paths.jobsQueued, `${job.id}.json`);
          const runningPath = path.join(CONFIG.paths.jobsRunning, `${job.id}.json`);
          if (fs.existsSync(runningPath)) {
            const j = JSON.parse(fs.readFileSync(runningPath, "utf-8"));
            fs.writeFileSync(queuedPath, JSON.stringify({ ...j, state: "queued", updatedAt: new Date().toISOString() }, null, 2));
            fs.unlinkSync(runningPath);
          }
          break;
        }

        const jobPromise = processJob(job)
          .then(() => { completeRunningJob(job); })
          .catch((err: any) => { failRunningJob(job, err?.message || String(err)); })
          .finally(() => { inFlight.delete(job.id); });

        inFlight.set(job.id, jobPromise);
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
  } finally {
    if (inFlight.size > 0) {
      activityBus.log("system:info", `Daemon shutting down, waiting for ${inFlight.size} in-flight job(s)`);
      await Promise.allSettled(Array.from(inFlight.values()));
    }
    writeDaemonState({ running: false, pid: process.pid });
    releaseDaemonLock();
  }
}

runDaemon({ once: process.argv.includes("--once") }).catch((err) => {
  console.error(`[graph-memory] daemon error: ${err.message}`);
  releaseDaemonLock();
  process.exit(1);
});
