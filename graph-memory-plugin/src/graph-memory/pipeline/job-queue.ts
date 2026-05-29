import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { createJob, GraphMemoryJob, GraphMemoryJobPayload, GraphMemoryJobState, GraphMemoryJobType } from "./job-schema.js";

export const PROJECT_CHAIN_TYPES = new Set<GraphMemoryJobType>(["auditor", "librarian", "dreamer"]);
export const GLOBAL_CHAIN_TYPES = new Set<GraphMemoryJobType>(["observer", "compressor"]);

export const PRIORITY: Record<GraphMemoryJobType, number> = {
  scribe: 0,
  observer: 0,
  compressor: 1,
  working_update: 1,
  auditor: 2,
  librarian: 3,
  dreamer: 4,
  skillforge: 5,
  skillforge_refresh: 5,
  memory_analysis: 6,
  bootstrap_project_doc: 3,
  notion_sync: 7,
  notion_inbound_triage: 3,
  notion_inbound_enrich: 4,
};

function stateDir(state: GraphMemoryJobState): string {
  switch (state) {
    case "queued":
      return CONFIG.paths.jobsQueued;
    case "running":
      return CONFIG.paths.jobsRunning;
    case "done":
      return CONFIG.paths.jobsDone;
    case "failed":
      return CONFIG.paths.jobsFailed;
  }
}

function jobFilePath(job: Pick<GraphMemoryJob, "id">, state: GraphMemoryJobState): string {
  return path.join(stateDir(state), `${job.id}.json`);
}

function readJob(filePath: string): GraphMemoryJob | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as GraphMemoryJob;
  } catch {
    return null;
  }
}

function writeJob(job: GraphMemoryJob, state: GraphMemoryJobState): void {
  const next: GraphMemoryJob = {
    ...job,
    state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(jobFilePath(next, state), JSON.stringify(next, null, 2));
}

function removeJob(job: GraphMemoryJob, state: GraphMemoryJobState): void {
  try {
    fs.unlinkSync(jobFilePath(job, state));
  } catch { /* ignore */ }
}

export function ensureJobDirectories(): void {
  for (const dir of [
    CONFIG.paths.jobsRoot,
    CONFIG.paths.jobsQueued,
    CONFIG.paths.jobsRunning,
    CONFIG.paths.jobsDone,
    CONFIG.paths.jobsFailed,
    CONFIG.paths.skillforgeManifests,
    CONFIG.paths.projectLocks,
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function listJobs(state: GraphMemoryJobState): GraphMemoryJob[] {
  const dir = stateDir(state);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJob(path.join(dir, file)))
    .filter((job): job is GraphMemoryJob => Boolean(job));
}

export function countJobs(state: GraphMemoryJobState, type?: GraphMemoryJobType): number {
  return listJobs(state).filter((job) => !type || job.type === type).length;
}

export function hasActiveJob(type: GraphMemoryJobType): boolean {
  return countJobs("queued", type) > 0 || countJobs("running", type) > 0;
}

export function getJobProject(job: GraphMemoryJob): string | null {
  const payload = (job.payload as unknown) as Record<string, unknown>;
  const project = payload?.project;
  if (typeof project === "string" && project.trim() && project !== "global") {
    return project.trim();
  }
  return null;
}

export function hasActiveJobForProject(type: GraphMemoryJobType, project: string): boolean {
  for (const state of ["queued", "running"] as const) {
    for (const job of listJobs(state)) {
      if (job.type !== type) continue;
      if (getJobProject(job) === project) return true;
    }
  }
  return false;
}

export function hasActiveProjectChainJob(project: string): boolean {
  for (const state of ["queued", "running"] as const) {
    for (const job of listJobs(state)) {
      if (!PROJECT_CHAIN_TYPES.has(job.type)) continue;
      if (getJobProject(job) === project) return true;
    }
  }
  return false;
}

export function hasActiveGlobalChainJob(): boolean {
  for (const state of ["queued", "running"] as const) {
    for (const job of listJobs(state)) {
      if (!GLOBAL_CHAIN_TYPES.has(job.type)) continue;
      return true;
    }
  }
  return false;
}

export function listJobsForProject(state: GraphMemoryJobState, project: string): GraphMemoryJob[] {
  return listJobs(state).filter((job) => getJobProject(job) === project);
}

export function countDeltasForProject(project: string): number {
  const deltasDir = CONFIG.paths.deltas;
  if (!fs.existsSync(deltasDir)) return 0;

  let count = 0;
  for (const file of fs.readdirSync(deltasDir).filter((f) => f.endsWith(".json"))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(deltasDir, file), "utf-8")) as {
        scribes?: Array<{ deltas?: Array<{ project?: string }> }>;
      };
      const hasProject = (raw.scribes || []).some((s) =>
        (s.deltas || []).some((d) => String(d.project || "").trim() === project)
      );
      if (hasProject) count++;
    } catch { /* skip */ }
  }
  return count;
}

export function getActiveProjectChainProjects(): Set<string> {
  const projects = new Set<string>();
  for (const state of ["queued", "running"] as const) {
    for (const job of listJobs(state)) {
      if (!PROJECT_CHAIN_TYPES.has(job.type)) continue;
      const project = getJobProject(job);
      if (project) projects.add(project);
    }
  }
  return projects;
}

export function findActiveJobByIdempotencyKey(idempotencyKey: string): GraphMemoryJob | null {
  for (const state of ["queued", "running"] as const) {
    const match = listJobs(state).find((job) => job.idempotencyKey === idempotencyKey);
    if (match) return match;
  }
  return null;
}

function findLatestJobByIdempotencyKey(
  idempotencyKey: string,
  states: GraphMemoryJobState[],
): GraphMemoryJob | null {
  const matches = states
    .flatMap((state) => listJobs(state))
    .filter((job) => job.idempotencyKey === idempotencyKey)
    .sort((a, b) => {
      const updatedDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (!Number.isNaN(updatedDelta) && updatedDelta !== 0) return updatedDelta;
      return b.createdAt.localeCompare(a.createdAt);
    });

  return matches[0] || null;
}

function retryFailedJob(job: GraphMemoryJob): GraphMemoryJob {
  const requeued: GraphMemoryJob = {
    ...job,
    state: "queued",
    updatedAt: new Date().toISOString(),
  };
  delete requeued.lastError;
  delete requeued.startedAt;
  delete requeued.completedAt;
  delete requeued.workerPid;
  delete requeued.logFile;

  removeJob(job, "failed");
  writeJob(requeued, "queued");
  return requeued;
}

export function enqueueJob<TPayload extends GraphMemoryJobPayload>(opts: {
  type: GraphMemoryJobType;
  payload: TPayload;
  triggerSource: string;
  idempotencyKey: string;
  maxAttempts?: number;
}): { job: GraphMemoryJob<TPayload>; created: boolean } {
  ensureJobDirectories();
  const existing = findActiveJobByIdempotencyKey(opts.idempotencyKey) as GraphMemoryJob<TPayload> | null;
  if (existing) {
    return { job: existing, created: false };
  }

  const latestFailed = findLatestJobByIdempotencyKey(opts.idempotencyKey, ["failed"]) as GraphMemoryJob<TPayload> | null;
  if (latestFailed) {
    if (latestFailed.attempt >= latestFailed.maxAttempts) {
      return { job: latestFailed, created: false };
    }

    const retried = retryFailedJob(latestFailed) as GraphMemoryJob<TPayload>;
    activityBus.log("system:info", `Retrying ${retried.type} job`, {
      jobId: retried.id,
      triggerSource: opts.triggerSource,
      attempt: retried.attempt + 1,
      maxAttempts: retried.maxAttempts,
      previousError: latestFailed.lastError || null,
    });
    return { job: retried, created: false };
  }

  const job = createJob(opts);
  writeJob(job, "queued");
  activityBus.log("system:info", `Queued ${job.type} job`, {
    jobId: job.id,
    triggerSource: job.triggerSource,
  });
  return { job, created: true };
}

export function claimNextJob(skipTypes?: Set<string>): GraphMemoryJob | null {
  ensureJobDirectories();
  const sorted = listJobs("queued")
    .sort((a, b) => {
      const priority = PRIORITY[a.type] - PRIORITY[b.type];
      if (priority !== 0) return priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

  const next = skipTypes ? sorted.find(j => !skipTypes.has(j.type)) : sorted[0];

  if (!next) return null;

  const queuedPath = jobFilePath(next, "queued");
  if (!fs.existsSync(queuedPath)) return null;

  const runningJob: GraphMemoryJob = {
    ...next,
    state: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempt: next.attempt + 1,
  };

  fs.renameSync(queuedPath, jobFilePath(runningJob, "running"));
  fs.writeFileSync(jobFilePath(runningJob, "running"), JSON.stringify(runningJob, null, 2));
  return runningJob;
}

export function updateRunningJob(job: GraphMemoryJob): void {
  const filePath = jobFilePath(job, "running");
  if (!fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, JSON.stringify({
    ...job,
    state: "running",
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

export function completeRunningJob(job: GraphMemoryJob): GraphMemoryJob {
  const completed: GraphMemoryJob = {
    ...job,
    state: "done",
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete completed.lastError;
  removeJob(job, "running");
  writeJob(completed, "done");
  return completed;
}

export function failRunningJob(job: GraphMemoryJob, error: string): GraphMemoryJob {
  const failed: GraphMemoryJob = {
    ...job,
    state: "failed",
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: error,
  };
  removeJob(job, "running");
  writeJob(failed, "failed");
  activityBus.log("system:error", `Job failed: ${job.type}`, {
    jobId: job.id,
    error,
  });
  return failed;
}

export function requeueRunningJob(job: GraphMemoryJob, error: string): GraphMemoryJob {
  const requeued: GraphMemoryJob = {
    ...job,
    state: "queued",
    updatedAt: new Date().toISOString(),
    lastError: error,
  };
  delete requeued.startedAt;
  delete requeued.completedAt;
  delete requeued.workerPid;
  delete requeued.logFile;

  removeJob(job, "running");
  writeJob(requeued, "queued");
  return requeued;
}

export function requeueStaleRunningJobs(maxAgeMs: number): number {
  const now = Date.now();
  let count = 0;

  for (const job of listJobs("running")) {
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.updatedAt);
    if (Number.isNaN(startedAt)) continue;
    if (now - startedAt < maxAgeMs) continue;
    if (job.workerPid && isProcessAlive(job.workerPid)) continue;

    requeueRunningJob(job, "Requeued stale running job after daemon restart");
    count += 1;
  }

  return count;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
