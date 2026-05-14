import { randomUUID } from "crypto";

export type GraphMemoryJobType = "scribe" | "observer" | "compressor" | "working_update" | "auditor" | "librarian" | "dreamer" | "dreamer_v3" | "memory_analysis" | "skillforge" | "skillforge_refresh" | "bootstrap_project_doc" | "notion_sync";
export type GraphMemoryJobState = "queued" | "running" | "done" | "failed";

export interface ScribeJobPayload {
  snapshotPath: string;
  sessionId: string;
  project?: string;
  assistantTracePath?: string;
  toolTracePath?: string;
}

export interface ObserverJobPayload {
  snapshotPath: string;
  sessionId: string;
  project?: string;
  assistantTracePath?: string;
  toolTracePath?: string;
}

export interface CompressorJobPayload {
  layers?: Array<"global" | "project">;
  projects?: string[];
  force?: boolean;
  reason: string;
}

export interface AuditorJobPayload {
  reason: string;
}

export interface WorkingUpdateJobPayload {
  sessionId: string;
  project: string;
  deltaMtimeMs: number;
  assistantTracePath?: string;
  toolTracePath?: string;
}

export interface LibrarianJobPayload {
  reason: string;
}

export interface DreamerJobPayload {
  reason: string;
}

export interface MemoryAnalysisJobPayload {
  briefDate: string;
  timeZone: string;
  reason: string;
}

export interface SkillforgeJobPayload {
  nodePath: string;
  project: string;
  reason: string;
  score: number;
}

export interface SkillforgeRefreshJobPayload {
  manifestPath: string;
  nodePath: string;
  skillName: string;
  project: string;
  reason: string;
}

export interface BootstrapProjectDocPayload {
  project: string;
  harness: string;
  cwd: string;
  reason: string;
}

export interface DreamerV3JobPayload {
  reason: string;
}

export interface NotionSyncJobPayload {
  reason: string;
  date: string;
  forceFullSync?: boolean;
  batches?: string[];
  skipInbound?: boolean;
  batchIndex?: number;
}

export type GraphMemoryJobPayload =
  | ScribeJobPayload
  | ObserverJobPayload
  | CompressorJobPayload
  | WorkingUpdateJobPayload
  | AuditorJobPayload
  | LibrarianJobPayload
  | DreamerJobPayload
  | DreamerV3JobPayload
  | MemoryAnalysisJobPayload
  | SkillforgeJobPayload
  | SkillforgeRefreshJobPayload
  | BootstrapProjectDocPayload
  | NotionSyncJobPayload;

export interface GraphMemoryJob<TPayload = GraphMemoryJobPayload> {
  id: string;
  type: GraphMemoryJobType;
  state: GraphMemoryJobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  triggerSource: string;
  payload: TPayload;
  logFile?: string;
  lastError?: string;
  workerPid?: number;
}

export interface CreateJobOptions<TPayload = GraphMemoryJobPayload> {
  type: GraphMemoryJobType;
  payload: TPayload;
  triggerSource: string;
  idempotencyKey: string;
  maxAttempts?: number;
}

export function defaultMaxAttempts(type: GraphMemoryJobType): number {
  switch (type) {
    case "scribe":
    case "observer":
    case "compressor":
      return 3;
    case "working_update":
      return 2;
    case "auditor":
    case "librarian":
    case "dreamer":
    case "dreamer_v3":
    case "memory_analysis":
    case "skillforge":
    case "skillforge_refresh":
    case "bootstrap_project_doc":
      return 2;
    case "notion_sync":
      return 2;
  }
}

export function createJob<TPayload = GraphMemoryJobPayload>(
  opts: CreateJobOptions<TPayload>
): GraphMemoryJob<TPayload> {
  const timestamp = new Date().toISOString();
  return {
    id: `${opts.type}_${randomUUID()}`,
    type: opts.type,
    state: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 0,
    maxAttempts: opts.maxAttempts ?? defaultMaxAttempts(opts.type),
    idempotencyKey: opts.idempotencyKey,
    triggerSource: opts.triggerSource,
    payload: opts.payload,
  };
}
