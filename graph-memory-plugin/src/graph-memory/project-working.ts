import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import {
  ensureWorkingDirectories,
  getProjectWorkingPath,
  getProjectWorkingStatePath,
  getProjectWorkingUpdatePath,
} from "./working-files.js";

type DeltaKind =
  | "create_node"
  | "update_stance"
  | "soma_signal"
  | "create_edge"
  | "create_anti_edge"
  | "update_confidence";

interface RawScribeDelta {
  type?: string;
  action?: string;
  path?: string;
  from?: string;
  to?: string;
  target?: string;
  change?: string;
  content?: string;
  reason?: string;
  project?: string;
}

interface ScribeEntry {
  summary?: string;
  deltas?: RawScribeDelta[];
}

interface DeltaFilePayload {
  session_id?: string;
  scribes?: ScribeEntry[];
}

interface ToolTraceEvent {
  type?: string;
  timestamp?: string;
  toolName?: string;
  accessKind?: string;
  success?: boolean | null;
  commandPreview?: string | null;
  argsPreview?: Record<string, unknown> | null;
  inputPreview?: unknown;
  outputPreview?: unknown;
  errorPreview?: unknown;
  targetPaths?: string[];
}

interface WorkingSessionEntry {
  sessionId: string;
  project: string;
  activityAt: string;
  firstCapturedAt: string;
  lastUpdatedAt: string;
  summaries: string[];
  tasksWorkedOn: string[];
  commits: string[];
  worked: string[];
  didntWork: string[];
  nextPickup: string[];
  recalledNodes: string[];
  createdNodes: string[];
  updatedNodes: string[];
  keyFiles: KeyFileEntry[];
}

interface ProjectWorkingState {
  project: string;
  createdAt: string;
  updatedAt: string;
  sessions: WorkingSessionEntry[];
}

interface UpdateProjectWorkingOptions {
  project: string;
  sessionId: string;
  toolTracePath?: string;
  updatePath?: string;
  fileInteractionPath?: string;
}

interface WorkingSessionUpdateArtifact {
  sessionId?: string;
  project?: string;
  generatedAt?: string;
  summaries?: string[];
  tasksWorkedOn?: string[];
  commits?: string[];
  worked?: string[];
  didntWork?: string[];
  nextPickup?: string[];
  recalledNodes?: string[];
  createdNodes?: string[];
  updatedNodes?: string[];
  keyFiles?: KeyFileEntry[];
}

interface KeyFileEntry {
  path: string;
  role: string;
  note?: string;
}

interface FileInteraction {
  path: string;
  count: number;
  roles: string[];
}

const FILE_INTERACTION_EXCLUDE = /node_modules|\.graph-memory[/\\]|\.deltas[/\\]|\.pipeline[/\\]|\.jobs[/\\]|\.buffer[/\\]/;
const FILE_INTERACTION_JUNK = /^\/(tmp|dev|proc|sys|etc|var|usr|bin|sbin|opt|lib|home)\b|^\/dev\/null|\/tmp\/|\)$|^\.$|^\.\.$/;

const EMPTY_MARKER = "_No session handoff captured yet for this repository._";

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBullet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pushUnique(items: string[], value: string, limit = 12): void {
  const normalized = normalizeBullet(value);
  if (!normalized) return;
  if (!items.includes(normalized)) {
    items.push(normalized);
  }
  if (items.length > limit) {
    items.splice(limit);
  }
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((value): value is T => Boolean(value));
}

function parseDeltaFile(sessionId: string): DeltaFilePayload {
  const deltaPath = fs.existsSync(path.join(CONFIG.paths.deltas, `${sessionId}.json`))
    ? path.join(CONFIG.paths.deltas, `${sessionId}.json`)
    : path.join(CONFIG.paths.deltasAudited, `${sessionId}.json`);
  if (!fs.existsSync(deltaPath)) {
    return { session_id: sessionId, scribes: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(deltaPath, "utf-8")) as DeltaFilePayload;
  } catch {
    return { session_id: sessionId, scribes: [] };
  }
}

function getSessionActivityAt(sessionId: string, generated?: WorkingSessionUpdateArtifact | null): string {
  const deltaPath = fs.existsSync(path.join(CONFIG.paths.deltas, `${sessionId}.json`))
    ? path.join(CONFIG.paths.deltas, `${sessionId}.json`)
    : path.join(CONFIG.paths.deltasAudited, `${sessionId}.json`);
  if (generated?.generatedAt) {
    return generated.generatedAt;
  }

  if (fs.existsSync(deltaPath)) {
    return fs.statSync(deltaPath).mtime.toISOString();
  }

  return nowIso();
}

function readWorkingSessionUpdate(updatePath?: string): WorkingSessionUpdateArtifact | null {
  if (!updatePath || !fs.existsSync(updatePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(updatePath, "utf-8")) as WorkingSessionUpdateArtifact;
  } catch {
    return null;
  }
}

function normalizeList(items: string[] | undefined, limit: number): string[] {
  const output: string[] = [];
  for (const item of items || []) {
    pushUnique(output, item, limit);
  }
  return output;
}

function isNoopWorkingBullet(text: string): boolean {
  const normalized = normalizeBullet(text).toLowerCase();
  if (!normalized) return true;
  return [
    /mostly about another repo/,
    /nothing (here )?appl(?:ied|ies) to this project/,
    /no [a-z0-9/_-]+-specific work happened/,
    /this session did not affect this repo/,
    /no durable(,)? project-specific handoff/,
    /no relevant update/,
    /not relevant to this project/,
    /unrelated to this project/,
    /only had to do with/,
  ].some((pattern) => pattern.test(normalized));
}

function normalizeProjectArtifactList(items: string[] | undefined, limit: number): string[] {
  return normalizeList(items, limit).filter((item) => !isNoopWorkingBullet(item));
}

function hasProjectScopedDelta(deltaPayload: DeltaFilePayload, project: string): boolean {
  for (const scribe of deltaPayload.scribes || []) {
    for (const rawDelta of scribe.deltas || []) {
      if (String(rawDelta.project || "").trim() === project) {
        return true;
      }
    }
  }
  return false;
}

function filterScribesForProject(deltaPayload: DeltaFilePayload, project: string): ScribeEntry[] {
  return (deltaPayload.scribes || []).filter((scribe) =>
    (scribe.deltas || []).some((rawDelta) => String(rawDelta.project || "").trim() === project)
  );
}

function generatedArtifactHasProjectContent(generated: WorkingSessionUpdateArtifact | null): boolean {
  if (!generated) return false;
  return [
    generated.summaries,
    generated.tasksWorkedOn,
    generated.commits,
    generated.worked,
    generated.didntWork,
    generated.nextPickup,
    generated.recalledNodes,
    generated.createdNodes,
    generated.updatedNodes,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function getDeltaKind(delta: RawScribeDelta): DeltaKind | "" {
  const kind = String(delta.type || delta.action || "").trim();
  switch (kind) {
    case "create_node":
    case "update_stance":
    case "soma_signal":
    case "create_edge":
    case "create_anti_edge":
    case "update_confidence":
      return kind;
    default:
      return "";
  }
}

function getDeltaPath(delta: RawScribeDelta): string {
  return String(delta.path || delta.from || "").trim();
}

function getDeltaTarget(delta: RawScribeDelta): string {
  return String(delta.target || delta.to || "").trim();
}

function humanizeCommand(commandPreview: string): string {
  const compact = normalizeBullet(commandPreview);
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function extractCommitHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\[.+?\s+([0-9a-f]{7,40})\]/i) || value.match(/\b([0-9a-f]{7,40})\b/);
  return match ? match[1] : null;
}

function extractActionFromGraphTool(event: ToolTraceEvent): { action?: string; path?: string; query?: string } {
  const args = event.argsPreview || {};
  const action = typeof args.action === "string" ? args.action : undefined;
  const pathValue = typeof args.path === "string" ? args.path : undefined;
  const queryValue = typeof args.query === "string" ? args.query : undefined;
  return { action, path: pathValue, query: queryValue };
}

function collectToolSignals(toolTracePath: string | undefined): {
  commits: string[];
  worked: string[];
  didntWork: string[];
  recalledNodes: string[];
} {
  const commits: string[] = [];
  const worked: string[] = [];
  const didntWork: string[] = [];
  const recalledNodes: string[] = [];

  if (!toolTracePath || !fs.existsSync(toolTracePath)) {
    return { commits, worked, didntWork, recalledNodes };
  }

  const events = readJsonLines<ToolTraceEvent>(toolTracePath);
  for (const event of events) {
    const toolName = String(event.toolName || "").trim();
    const commandPreview = typeof event.commandPreview === "string" ? event.commandPreview : "";
    const success = event.success;

    if (toolName === "mcp__graph-memory__graph_memory") {
      const action = extractActionFromGraphTool(event);
      if (action.action === "read_node" && action.path) {
        pushUnique(recalledNodes, action.path, 16);
      } else if (action.action === "list_edges" && action.path) {
        pushUnique(recalledNodes, `${action.path} (edges)`, 16);
      } else if ((action.action === "recall" || action.action === "search") && action.query) {
        pushUnique(recalledNodes, `query:${action.query}`, 16);
      }
    }

    if (!commandPreview) {
      if (success === false && toolName) {
        pushUnique(didntWork, `Tool failed: ${toolName}`, 10);
      }
      continue;
    }

    const humanized = humanizeCommand(commandPreview);
    if (/git\s+commit\b/i.test(commandPreview)) {
      const hash = extractCommitHash(typeof event.outputPreview === "string" ? event.outputPreview : null);
      pushUnique(commits, hash ? `${humanized} [${hash}]` : humanized, 10);
    }

    if (success === false) {
      const errorPreview = typeof event.errorPreview === "string"
        ? normalizeBullet(event.errorPreview)
        : "";
      const suffix = errorPreview ? ` — ${errorPreview}` : "";
      pushUnique(didntWork, `${humanized}${suffix}`, 10);
      continue;
    }

    if (
      success === true &&
      /(git\s+commit\b|git\s+push\b|tsc\b|npm\s+test\b|pnpm\s+test\b|yarn\s+test\b|vitest\b|jest\b|pytest\b|cargo\s+test\b|go\s+test\b|eslint\b|lint\b|build\b)/i.test(commandPreview)
    ) {
      pushUnique(worked, humanized, 10);
    }
  }

  return { commits, worked, didntWork, recalledNodes };
}

function accessKindToRole(accessKind?: string): string {
  switch ((accessKind || "").trim().toLowerCase()) {
    case "write":
      return "edited";
    case "execute":
      return "ran";
    case "read":
      return "read";
    case "search":
      return "search";
    default:
      return "";
  }
}

function cleanFilePath(filePath: string, cwd?: string): string | null {
  let cleaned = filePath;

  if (cwd && cleaned.startsWith(cwd + "/")) {
    cleaned = cleaned.slice(cwd.length + 1);
  }

  cleaned = cleaned.replace(/^\.\/+/, "");

  if (!cleaned || cleaned.length < 3) return null;
  if (FILE_INTERACTION_JUNK.test(cleaned)) return null;
  if (!/[a-zA-Z]/.test(cleaned)) return null;
  if (cleaned.includes(" ")) return null;

  return cleaned;
}

export function collectFileInteractions(toolTracePath: string | undefined): FileInteraction[] {
  if (!toolTracePath || !fs.existsSync(toolTracePath)) return [];

  const events = readJsonLines<ToolTraceEvent>(toolTracePath);
  const byPath = new Map<string, { count: number; roles: Set<string> }>();

  for (const event of events) {
    const targets = event.targetPaths || [];
    const role = accessKindToRole(event.accessKind);
    const cwd = typeof (event as any).cwd === "string" ? (event as any).cwd : undefined;

    for (const rawPath of targets) {
      const filePath = cleanFilePath(rawPath, cwd);
      if (!filePath) continue;
      if (FILE_INTERACTION_EXCLUDE.test(filePath)) continue;

      const existing = byPath.get(filePath) || { count: 0, roles: new Set<string>() };
      existing.count += 1;
      if (role) existing.roles.add(role);
      byPath.set(filePath, existing);
    }

    if (!targets.length && event.commandPreview && event.accessKind === "execute") {
      const pathMatches = event.commandPreview.match(/(?:\/|\.\.?\/)[^\s"'`]+/g) || [];
      for (const rawMatch of pathMatches.slice(0, 8)) {
        const filePath = cleanFilePath(rawMatch, cwd);
        if (!filePath) continue;
        if (FILE_INTERACTION_EXCLUDE.test(filePath)) continue;

        const existing = byPath.get(filePath) || { count: 0, roles: new Set<string>() };
        existing.count += 1;
        existing.roles.add("ran");
        byPath.set(filePath, existing);
      }
    }
  }

  return [...byPath.entries()]
    .map(([filePath, data]) => ({
      path: filePath,
      count: data.count,
      roles: [...data.roles],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function readFileInteractionJson(filePath: string | undefined): FileInteraction[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FileInteraction[];
  } catch {
    return [];
  }
}

function mergeKeyFiles(
  agentKeyFiles: KeyFileEntry[] | undefined,
  fileInteractions: FileInteraction[]
): KeyFileEntry[] {
  if (agentKeyFiles && agentKeyFiles.length > 0) {
    return agentKeyFiles.slice(0, 8);
  }

  return fileInteractions
    .filter((fi) => {
      if (!fi.path.includes(".")) return false;
      return fi.roles.some((r) => r === "edited" || r === "created");
    })
    .slice(0, 8)
    .map((fi) => ({
      path: fi.path,
      role: fi.roles.includes("edited") ? "edited" : "created",
    }));
}

function deriveNextPickup(entry: WorkingSessionEntry): string[] {
  if (entry.didntWork.length > 0) {
    return [
      `Revisit the latest blocker or dead end: ${entry.didntWork[0]}`,
      ...(entry.tasksWorkedOn[0] ? [`Resume the most recent task thread: ${entry.tasksWorkedOn[0]}`] : []),
    ].slice(0, 4);
  }

  if (entry.tasksWorkedOn.length > 0) {
    return [`Resume from the latest working thread: ${entry.tasksWorkedOn[0]}`];
  }

  if (entry.summaries.length > 0) {
    return [`Pick up from the latest session summary: ${entry.summaries[0]}`];
  }

  return [];
}

function loadProjectWorkingState(project: string): ProjectWorkingState {
  ensureWorkingDirectories();
  const statePath = getProjectWorkingStatePath(project);
  if (!fs.existsSync(statePath)) {
    const timestamp = nowIso();
    return {
      project,
      createdAt: timestamp,
      updatedAt: timestamp,
      sessions: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ProjectWorkingState;
    return {
      project,
      createdAt: parsed.createdAt || nowIso(),
      updatedAt: parsed.updatedAt || nowIso(),
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => ({
          ...session,
          activityAt: typeof session.activityAt === "string"
            ? session.activityAt
            : (session.lastUpdatedAt || parsed.updatedAt || nowIso()),
        }))
        : [],
    };
  } catch {
    const timestamp = nowIso();
    return {
      project,
      createdAt: timestamp,
      updatedAt: timestamp,
      sessions: [],
    };
  }
}

function saveProjectWorkingState(project: string, state: ProjectWorkingState): void {
  ensureWorkingDirectories();
  fs.writeFileSync(getProjectWorkingStatePath(project), JSON.stringify(state, null, 2));
}

function renderBulletSection(title: string, items: string[], fallback: string): string {
  let output = `### ${title}\n\n`;
  if (items.length === 0) {
    output += `- ${fallback}\n`;
    return output;
  }
  for (const item of items) {
    output += `- ${item}\n`;
  }
  return output;
}

function compactItems(items: string[], limit: number): string[] {
  return items
    .map(normalizeBullet)
    .filter(Boolean)
    .slice(0, limit);
}

function buildResumeNowItems(latest: WorkingSessionEntry): string[] {
  const resumeItems: string[] = [];

  for (const item of compactItems(latest.nextPickup, 5)) {
    pushUnique(resumeItems, item, 5);
  }

  if (resumeItems.length === 0 && latest.didntWork.length > 0) {
    pushUnique(resumeItems, `Resolve the latest blocker: ${latest.didntWork[0]}`, 5);
  }

  if (resumeItems.length === 0 && latest.tasksWorkedOn.length > 0) {
    pushUnique(resumeItems, `Continue the latest task: ${latest.tasksWorkedOn[0]}`, 5);
  }

  if (resumeItems.length === 0 && latest.summaries.length > 0) {
    pushUnique(resumeItems, `Continue from the last session summary: ${latest.summaries[0]}`, 5);
  }

  return resumeItems;
}

function buildCurrentStateItems(latest: WorkingSessionEntry): string[] {
  const stateItems: string[] = [];

  for (const item of compactItems(latest.tasksWorkedOn, 3)) {
    pushUnique(stateItems, item, 5);
  }
  for (const item of compactItems(latest.summaries, 2)) {
    pushUnique(stateItems, item, 5);
  }

  return stateItems;
}

function buildOpenLoopItems(latest: WorkingSessionEntry): string[] {
  const openLoops: string[] = [];

  for (const item of compactItems(latest.didntWork, 4)) {
    pushUnique(openLoops, item, 4);
  }

  return openLoops;
}

function buildEvidenceItems(latest: WorkingSessionEntry): string[] {
  const evidence: string[] = [];

  for (const item of compactItems(latest.commits, 3)) {
    pushUnique(evidence, `Commit: ${item}`, 6);
  }
  for (const item of compactItems(latest.worked, 3)) {
    pushUnique(evidence, `Worked: ${item}`, 6);
  }

  return evidence;
}

function buildMemoryItems(latest: WorkingSessionEntry): string[] {
  const relevantNodes: string[] = [];

  for (const pathValue of compactItems(latest.recalledNodes, 6)) pushUnique(relevantNodes, `Recalled: ${pathValue}`, 12);
  for (const pathValue of compactItems(latest.createdNodes, 4)) pushUnique(relevantNodes, `Created: ${pathValue}`, 12);
  for (const pathValue of compactItems(latest.updatedNodes, 4)) pushUnique(relevantNodes, `Updated: ${pathValue}`, 12);

  return relevantNodes;
}

function renderProjectWorkingMarkdown(state: ProjectWorkingState): string {
  const latest = state.sessions[0];
  let content = `# WORKING — ${state.project}\n\n`;
  content += `> Lean handoff. Updated after each scribe. Say "pick up where we left off."\n\n`;
  content += `**Updated:** ${state.updatedAt}\n`;

  if (!latest) {
    content += `\n## Now\n\n${EMPTY_MARKER}\n`;
    return content;
  }

  const resumeItems = buildResumeNowItems(latest);
  const evidenceItems = buildEvidenceItems(latest);

  content += `\n## Now\n\n`;
  for (const item of compactItems(resumeItems, 3)) {
    content += `- ${item}\n`;
  }
  if (resumeItems.length === 0 && latest.tasksWorkedOn.length > 0) {
    content += `- Continue: ${latest.tasksWorkedOn[0]}\n`;
  }

  if (latest.didntWork.length > 0) {
    content += `\n## Blocked\n\n`;
    for (const item of compactItems(latest.didntWork, 2)) {
      content += `- ${item}\n`;
    }
  }

  if (evidenceItems.length > 0) {
    content += `\n## Done\n\n`;
    for (const item of compactItems(evidenceItems, 3)) {
      content += `- ${item}\n`;
    }
  }

  const filesToRender = compactItems(
    (latest.keyFiles || [])
      .filter((kf) => kf.role !== "read")
      .map((kf) => {
        const label = kf.note ? ` — ${kf.note}` : "";
        return `\`${kf.path}\` (${kf.role})${label}`;
      }),
    8,
  );
  if (filesToRender.length > 0) {
    content += `\n## Files\n\n`;
    for (const f of filesToRender) content += `- ${f}\n`;
  }

  const relevantNodes: string[] = [];
  for (const p of compactItems(latest.createdNodes, 3)) pushUnique(relevantNodes, `+${p}`, 8);
  for (const p of compactItems(latest.updatedNodes, 3)) pushUnique(relevantNodes, `~${p}`, 8);
  for (const p of compactItems(latest.recalledNodes, 3)) pushUnique(relevantNodes, `@${p}`, 8);
  if (relevantNodes.length > 0) {
    content += `\n## Memory\n\n`;
    for (const n of relevantNodes) content += `- ${n}\n`;
  }

  return `${content.trimEnd()}\n`;
}

export function ensureProjectWorkingFile(projectName: string): void {
  if (!projectName || projectName === "global") return;
  const state = loadProjectWorkingState(projectName);
  saveProjectWorkingState(projectName, state);
  fs.writeFileSync(getProjectWorkingPath(projectName), renderProjectWorkingMarkdown(state));
}

export function updateProjectWorkingFromSession(opts: UpdateProjectWorkingOptions): void {
  if (!opts.project || opts.project === "global") return;

  ensureWorkingDirectories();
  const deltaPayload = parseDeltaFile(opts.sessionId);
  const generated = readWorkingSessionUpdate(
    opts.updatePath || getProjectWorkingUpdatePath(opts.project, opts.sessionId)
  );
  const toolSignals = collectToolSignals(opts.toolTracePath);
  const state = loadProjectWorkingState(opts.project);
  const relevantScribes = filterScribesForProject(deltaPayload, opts.project);
  const hasProjectDelta = hasProjectScopedDelta(deltaPayload, opts.project);
  const hasGeneratedProjectContent = generatedArtifactHasProjectContent(generated);
  const now = nowIso();
  const activityAt = getSessionActivityAt(opts.sessionId, generated);

  if (!hasProjectDelta && !hasGeneratedProjectContent) {
    const existingSessions = state.sessions.filter((session) => session.sessionId !== opts.sessionId);
    if (existingSessions.length !== state.sessions.length) {
      state.sessions = existingSessions;
      state.updatedAt = now;
      saveProjectWorkingState(opts.project, state);
      fs.writeFileSync(getProjectWorkingPath(opts.project), renderProjectWorkingMarkdown(state));
    }
    return;
  }

  const existing = state.sessions.find((session) => session.sessionId === opts.sessionId);
  const session: WorkingSessionEntry = existing || {
    sessionId: opts.sessionId,
    project: opts.project,
    activityAt,
    firstCapturedAt: now,
    lastUpdatedAt: now,
    summaries: [],
    tasksWorkedOn: [],
    commits: [],
    worked: [],
    didntWork: [],
    nextPickup: [],
    recalledNodes: [],
    createdNodes: [],
    updatedNodes: [],
    keyFiles: [],
  };

  session.activityAt = activityAt;
  session.lastUpdatedAt = now;

  const generatedSummaries = normalizeProjectArtifactList(generated?.summaries, 3);
  const generatedTasksWorkedOn = normalizeProjectArtifactList(generated?.tasksWorkedOn, 3);
  const generatedCommits = normalizeProjectArtifactList(generated?.commits, 3);
  const generatedWorked = normalizeProjectArtifactList(generated?.worked, 3);
  const generatedDidntWork = normalizeProjectArtifactList(generated?.didntWork, 3);
  const generatedNextPickup = normalizeProjectArtifactList(generated?.nextPickup, 3);
  const generatedRecalledNodes = normalizeProjectArtifactList(generated?.recalledNodes, 8);

  if (generatedSummaries.length > 0) session.summaries = generatedSummaries;
  if (generatedTasksWorkedOn.length > 0) session.tasksWorkedOn = generatedTasksWorkedOn;
  if (generatedCommits.length > 0) session.commits = generatedCommits;
  if (generatedWorked.length > 0) session.worked = generatedWorked;
  if (generatedDidntWork.length > 0) session.didntWork = generatedDidntWork;
  if (generatedNextPickup.length > 0) session.nextPickup = generatedNextPickup;
  if (generatedRecalledNodes.length > 0) session.recalledNodes = generatedRecalledNodes;
  if (generated?.createdNodes && generated.createdNodes.length > 0) session.createdNodes = normalizeProjectArtifactList(generated.createdNodes, 8);
  if (generated?.updatedNodes && generated.updatedNodes.length > 0) session.updatedNodes = normalizeProjectArtifactList(generated.updatedNodes, 8);

  const fileInteractions = readFileInteractionJson(opts.fileInteractionPath);
  if (generated?.keyFiles && generated.keyFiles.length > 0) {
    session.keyFiles = generated.keyFiles.slice(0, 8);
  } else if (fileInteractions.length > 0) {
    session.keyFiles = mergeKeyFiles(undefined, fileInteractions);
  }

  for (const scribe of relevantScribes) {
    if (scribe.summary) {
      pushUnique(session.summaries, scribe.summary, 12);
      pushUnique(session.tasksWorkedOn, scribe.summary, 12);
    }

    for (const rawDelta of (scribe.deltas || []).filter((delta) => String(delta.project || "").trim() === opts.project)) {
      const kind = getDeltaKind(rawDelta);
      const deltaPath = getDeltaPath(rawDelta);
      const deltaTarget = getDeltaTarget(rawDelta);

      if (kind === "create_node" && deltaPath) {
        pushUnique(session.createdNodes, deltaPath, 18);
      }

      if (["update_stance", "update_confidence", "soma_signal"].includes(kind) && deltaPath) {
        pushUnique(session.updatedNodes, deltaPath, 18);
      }

      if ((kind === "create_edge" || kind === "create_anti_edge") && deltaPath) {
        pushUnique(session.updatedNodes, deltaPath, 18);
        if (deltaTarget) {
          pushUnique(session.updatedNodes, deltaTarget, 18);
        }
      }

      if (kind === "create_anti_edge") {
        const reason = normalizeBullet(String(rawDelta.reason || rawDelta.content || ""));
        const label = deltaPath && deltaTarget
          ? `${deltaPath} -> ${deltaTarget}${reason ? ` — ${reason}` : ""}`
          : reason;
        if (label) pushUnique(session.didntWork, label, 12);
      }
    }
  }

  if (generatedCommits.length === 0) {
    for (const item of toolSignals.commits) pushUnique(session.commits, item, 10);
  }
  if (generatedWorked.length === 0) {
    for (const item of toolSignals.worked) pushUnique(session.worked, item, 12);
  }
  if (generatedDidntWork.length === 0) {
    for (const item of toolSignals.didntWork) pushUnique(session.didntWork, item, 12);
  }
  if (generatedRecalledNodes.length === 0) {
    for (const item of toolSignals.recalledNodes) pushUnique(session.recalledNodes, item, 18);
  }

  if (session.createdNodes.length > 0) {
    pushUnique(session.worked, `Scribe captured ${session.createdNodes.length} new graph node(s) for this session.`, 12);
  }

  if (session.nextPickup.length === 0) {
    session.nextPickup = deriveNextPickup(session);
  }

  const sessionsWithoutCurrent = state.sessions.filter((entry) => entry.sessionId !== session.sessionId);
  state.sessions = [session, ...sessionsWithoutCurrent]
    .slice(0, 5)
    .sort((a, b) => {
      const activityDelta = Date.parse(b.activityAt) - Date.parse(a.activityAt);
      if (!Number.isNaN(activityDelta) && activityDelta !== 0) {
        return activityDelta;
      }
      return Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt);
    });
  state.updatedAt = now;

  saveProjectWorkingState(opts.project, state);
  fs.writeFileSync(getProjectWorkingPath(opts.project), renderProjectWorkingMarkdown(state));
}
