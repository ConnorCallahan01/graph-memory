import fs from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { sanitizeProjectSlug } from "../working-files.js";
import { activityBus } from "../events.js";
import { computeContentHash, NotionSyncState, readNotionSyncState, writeNotionSyncState } from "./notion-sync.js";
import { getPage, getComments, searchDatabaseRows } from "./notion-cli.js";
import { appendObservation } from "../mind/observations.js";
import { appendObservation as appendProjectObservation, ensureLens } from "../lenses/manager.js";

export type InboundEditType =
  | "preference_edit"
  | "new_section"
  | "deletion"
  | "task_status_change"
  | "guardrail_change"
  | "project_convention_change"
  | "unknown";

export type InboundClassification = "inbound_only" | "merge_needed" | "no_change";

export interface InboundEdit {
  notionKey: string;
  pageId: string;
  classification: InboundClassification;
  currentNotionContent: string;
  lastSyncedContent: string;
  diskContent: string;
  sourceNodes: string[];
  editType: InboundEditType;
}

export interface InboundResult {
  edits: InboundEdit[];
  skipped: number;
  errors: string[];
}

export interface InboundDelta {
  notionKey: string;
  editType: InboundEditType;
  sourceNodes: string[];
  observation: string;
  targetFile: string;
  action: "update_node" | "create_observation" | "lower_confidence" | "update_model" | "log_conflict";
  payload: Record<string, unknown>;
}

export interface MergeResult {
  notionKey: string;
  mergedMarkdown: string;
  conflicts: Array<{
    section: string;
    humanVersion: string;
    agentVersion: string;
    resolution: "human_wins" | "keep_both" | "agent_note";
  }>;
}

export function detectInboundEdits(state: NotionSyncState): InboundResult {
  const edits: InboundEdit[] = [];
  let skipped = 0;
  const errors: string[] = [];

  for (const [notionKey, pageState] of Object.entries(state.pages)) {
    if (!pageState.pageId || !pageState.lastSyncedHash) continue;

    let currentNotionContent: string;
    try {
      currentNotionContent = getPage(pageState.pageId);
    } catch (err: any) {
      errors.push(`Failed to fetch Notion page ${pageState.pageId} (${notionKey}): ${err.message}`);
      skipped++;
      continue;
    }

    const currentNotionHash = computeContentHash(currentNotionContent);
    if (currentNotionHash === pageState.lastNotionHash) continue;
    if (currentNotionHash === pageState.lastSyncedHash && currentNotionHash === pageState.lastNotionHash) continue;

    const notionChanged = currentNotionHash !== pageState.lastSyncedHash;
    const diskChanged = hasDiskChanged(state, notionKey, pageState.sourceNodes);

    let classification: InboundClassification;
    if (notionChanged && diskChanged) {
      classification = "merge_needed";
    } else if (notionChanged) {
      classification = "inbound_only";
    } else {
      continue;
    }

    const lastSyncedContent = currentNotionContent;
    const diskContent = readDiskContent(state, notionKey, pageState.sourceNodes);

    pageState.lastNotionHash = currentNotionHash;

    edits.push({
      notionKey,
      pageId: pageState.pageId,
      classification,
      currentNotionContent,
      lastSyncedContent,
      diskContent,
      sourceNodes: pageState.sourceNodes,
      editType: inferEditType(notionKey, currentNotionContent, pageState.lastSyncedHash),
    });
  }

  for (const [notionKey, rowState] of Object.entries(state.rows)) {
    if (!rowState.pageId || !rowState.lastSyncedHash) continue;

    let currentNotionContent: string;
    try {
      currentNotionContent = getPage(rowState.pageId);
    } catch (err: any) {
      errors.push(`Failed to fetch Notion row ${rowState.pageId} (${notionKey}): ${err.message}`);
      skipped++;
      continue;
    }

    const currentNotionHash = computeContentHash(currentNotionContent);
    if (currentNotionHash === rowState.lastSyncedHash) continue;

    const newStatus = extractTaskStatusFromContent(currentNotionContent);
    const statusChanged = newStatus && newStatus !== rowState.status;

    if (statusChanged) {
      edits.push({
        notionKey,
        pageId: rowState.pageId,
        classification: "inbound_only",
        currentNotionContent,
        lastSyncedContent: "",
        diskContent: "",
        sourceNodes: [],
        editType: "task_status_change",
      });

      rowState.status = newStatus;
    }
  }

  return { edits, skipped, errors };
}

export function detectNewComments(state: NotionSyncState): Array<{ notionKey: string; pageId: string; comments: Array<{ id: string; text: string; createdTime: string }> }> {
  const results: Array<{ notionKey: string; pageId: string; comments: Array<{ id: string; text: string; createdTime: string }> }> = [];
  const allEntries: Array<{ key: string; pageId: string; lastCommentAt?: string }> = [
    ...Object.entries(state.pages).map(([key, ps]) => ({ key, pageId: ps.pageId, lastCommentAt: ps.lastCommentAt })),
    ...Object.entries(state.rows).map(([key, rs]) => ({ key, pageId: rs.pageId, lastCommentAt: rs.lastCommentAt })),
  ].filter(e => !!e.pageId);

  for (const entry of allEntries) {
    try {
      const comments = getComments(entry.pageId);
      const humanComments = comments.filter(c => c.createdBy.type === "person");
      const newComments = entry.lastCommentAt
        ? humanComments.filter(c => c.createdTime > entry.lastCommentAt!)
        : humanComments;

      if (newComments.length > 0) {
        results.push({
          notionKey: entry.key,
          pageId: entry.pageId,
          comments: newComments.map(c => ({ id: c.id, text: c.text, createdTime: c.createdTime })),
        });

        const latestTime = newComments.reduce((max, c) => c.createdTime > max ? c.createdTime : max, entry.lastCommentAt || "");
        if (state.pages[entry.key]) {
          state.pages[entry.key].lastCommentAt = latestTime;
        } else if (state.rows[entry.key]) {
          state.rows[entry.key].lastCommentAt = latestTime;
        }
      }
    } catch {
      // Skip pages where comments API fails (permissions, deleted page)
    }
  }

  return results;
}

export function buildCommentDetections(commentDetections: Array<{ notionKey: string; pageId: string; comments: Array<{ id: string; text: string; createdTime: string }> }>): InboundDelta[] {
  const deltas: InboundDelta[] = [];
  for (const detection of commentDetections) {
    for (const comment of detection.comments) {
      deltas.push({
        notionKey: detection.notionKey,
        editType: "preference_edit",
        sourceNodes: [],
        observation: `Human comment on "${detection.notionKey}": ${comment.text}`,
        targetFile: "",
        action: "create_observation",
        payload: { commentId: comment.id, commentTime: comment.createdTime },
      });
    }
  }
  return deltas;
}

export function detectNewNotionTasks(state: NotionSyncState): Array<{ name: string; pageId: string; status: string; project: string; priority: string }> {
  const tasksDb = state.databases.tasks;
  if (!tasksDb?.id) return [];

  const newTasks: Array<{ name: string; pageId: string; status: string; project: string; priority: string }> = [];

  try {
    const rows = searchDatabaseRows(tasksDb.id);
    for (const row of rows) {
      const pageId = row.id;
      if (!pageId) continue;

      let alreadyTracked = false;
      for (const rs of Object.values(state.rows)) {
        if (rs.pageId === pageId) { alreadyTracked = true; break; }
      }
      if (alreadyTracked) continue;

      const props = row.properties || {};
      const name = extractPropertyText(props, "Name") || "Untitled";
      const status = extractPropertySelect(props, "Status") || "Backlog";
      const project = extractPropertySelect(props, "Project") || "";
      const priority = extractPropertySelect(props, "Priority") || "Medium";

      const rowKey = `task:${name}`;
      state.rows[rowKey] = {
        pageId,
        sourceField: "tasks",
        status,
        lastSyncedHash: "",
      };

      newTasks.push({ name, pageId, status, project, priority });
    }
  } catch {
    // Database query failed — skip
  }

  return newTasks;
}

function extractPropertyText(props: Record<string, any>, key: string): string {
  const prop = props[key];
  if (!prop) return "";
  if (prop.title) return prop.title.map((t: any) => t.plain_text || "").join("");
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text || "").join("");
  return "";
}

function extractPropertySelect(props: Record<string, any>, key: string): string {
  const prop = props[key];
  if (!prop) return "";
  if (prop.select?.name) return prop.select.name;
  if (prop.status?.name) return prop.status.name;
  return "";
}

export function writeInboundDeltas(deltas: InboundDelta[], date: string): string {
  const deltasDir = CONFIG.paths.deltas;
  if (!fs.existsSync(deltasDir)) fs.mkdirSync(deltasDir, { recursive: true });

  const deltaPath = path.join(deltasDir, `notion-inbound-${date}.json`);
  fs.writeFileSync(deltaPath, JSON.stringify({
    source: "notion-inbound",
    date,
    generatedAt: new Date().toISOString(),
    deltas,
  }, null, 2));

  return deltaPath;
}

export function writeInboundInput(edits: InboundEdit[], date: string): string {
  const inputPath = path.join(CONFIG.paths.graphRoot, `.notion-inbound-input-${date}.json`);
  fs.writeFileSync(inputPath, JSON.stringify({
    date,
    generatedAt: new Date().toISOString(),
    edits,
  }, null, 2));

  return inputPath;
}

export function readInboundPlan(date: string): InboundDelta[] | null {
  const planPath = path.join(CONFIG.paths.graphRoot, `.notion-inbound-plan-${date}.json`);
  if (!fs.existsSync(planPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    return raw.deltas || null;
  } catch {
    return null;
  }
}

export function writeMergeInput(
  notionKey: string,
  baseline: string,
  humanVersion: string,
  agentVersion: string,
  sourceNodes: string[],
): string {
  const inputPath = path.join(CONFIG.paths.graphRoot, `.notion-merge-input-${notionKey.replace(/[/\\]/g, "_")}.json`);
  fs.writeFileSync(inputPath, JSON.stringify({
    notionKey,
    generatedAt: new Date().toISOString(),
    baseline,
    humanVersion,
    agentVersion,
    sourceNodes,
  }, null, 2));

  return inputPath;
}

export function readMergeResult(notionKey: string): MergeResult | null {
  const resultPath = path.join(CONFIG.paths.graphRoot, `.notion-merge-result-${notionKey.replace(/[/\\]/g, "_")}.json`);
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as MergeResult;
  } catch {
    return null;
  }
}

export function applyInboundDeltas(deltas: InboundDelta[]): { applied: number; errors: string[] } {
  const errors: string[] = [];
  let applied = 0;

  for (const delta of deltas) {
    try {
      applyInboundDelta(delta);
      applied++;
    } catch (err: any) {
      errors.push(`Failed to apply inbound delta for ${delta.notionKey}: ${err.message}`);
    }
  }

  return { applied, errors };
}

function applyInboundDelta(delta: InboundDelta): void {
  switch (delta.action) {
    case "create_observation":
    case "log_conflict":
      writeInboundObservation(delta);
      return;
    case "lower_confidence":
      lowerNodeConfidence(delta);
      return;
    case "update_model":
      updateModelField(delta);
      return;
    case "update_node":
      updateNodeFromInbound(delta);
      return;
    default:
      writeInboundObservation(delta);
  }
}

function writeInboundObservation(delta: InboundDelta): void {
  const project = resolveProjectFromSourceNodes(delta.sourceNodes);
  const observationText = buildInboundObservationText(delta);

  if (project && project !== "global") {
    ensureLens(project);
    appendProjectObservation(project, {
      type: "notion_inbound",
      observation: observationText,
      evidence: [delta.notionKey],
      confidence: 0.7,
      sessionId: "notion-inbound",
    });
  } else {
    const entry = appendObservation({
      layer: "global",
      type: "notion_inbound",
      observation: observationText,
      evidence: [delta.notionKey],
      confidence: 0.7,
      sessionId: "notion-inbound",
    }) as any;

    // Preserve the legacy inbound marker expected by existing consumers.
    entry.source = "notion-inbound";
    entry.tags = [...new Set([...(entry.tags || []), "source:notion-inbound"])];
    const obsPath = path.join(CONFIG.paths.mind, "observations.jsonl");
    const lines = fs.readFileSync(obsPath, "utf-8").trimEnd().split("\n");
    lines[lines.length - 1] = JSON.stringify(entry);
    fs.writeFileSync(obsPath, lines.join("\n") + "\n");
  }
}

function lowerNodeConfidence(delta: InboundDelta): void {
  const target = resolveTargetFile(delta);
  const raw = fs.readFileSync(target, "utf-8");
  const parsed = matter(raw);
  const nextConfidence = Number(delta.payload?.newConfidence);
  if (!Number.isFinite(nextConfidence)) {
    throw new Error("newConfidence is required");
  }
  parsed.data.confidence = nextConfidence;
  atomicWriteFile(target, matter.stringify(parsed.content, parsed.data));
}

function updateModelField(delta: InboundDelta): void {
  const target = resolveTargetFile(delta);
  const data = JSON.parse(fs.readFileSync(target, "utf-8"));
  const field = String(delta.payload?.field || "");
  if (!field) throw new Error("payload.field is required");
  setNestedField(data, field, delta.payload?.value);
  atomicWriteFile(target, JSON.stringify(data, null, 2) + "\n");
}

function updateNodeFromInbound(delta: InboundDelta): void {
  const target = resolveTargetFile(delta);
  const appendText = String(delta.payload?.markdown || delta.observation || "").trim();
  if (!appendText) return;
  atomicAppendFile(target, `\n\n${appendText}\n`);
}

function resolveTargetFile(delta: InboundDelta): string {
  const target = delta.targetFile || "";
  if (!target) throw new Error("target file not found");
  if (!fs.existsSync(target)) throw new Error(`target file not found: ${target}`);
  if (isArchivedNode(fs.readFileSync(target, "utf-8"))) {
    throw new Error(`target file is archived: ${target}`);
  }
  return target;
}

function setNestedField(target: any, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("payload.field is required");

  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function resolveProjectFromSourceNodes(sourceNodes: string[]): string | null {
  if (!sourceNodes || sourceNodes.length === 0) return null;
  for (const nodePath of sourceNodes) {
    const nodeFilePath = findNodeFile(nodePath);
    if (!nodeFilePath) continue;
    try {
      const raw = fs.readFileSync(nodeFilePath, "utf-8");
      const parsed = matter(raw);
      if (parsed.data.project && typeof parsed.data.project === "string") {
        return parsed.data.project;
      }
    } catch { /* skip */ }
  }
  return null;
}

function findNodeFile(nodePath: string): string | null {
  const directPath = path.join(CONFIG.paths.nodes, nodePath + ".md");
  if (fs.existsSync(directPath)) return directPath;

  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return null;

  for (const category of fs.readdirSync(nodesDir)) {
    const candidate = path.join(nodesDir, category, nodePath + ".md");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildInboundObservationText(delta: InboundDelta): string {
  const parts: string[] = [`[Notion inbound] ${delta.editType} on ${delta.notionKey}`];
  if (delta.observation) parts.push(delta.observation);
  if (delta.action !== "create_observation" && delta.action !== "log_conflict") {
    parts.push(`Action: ${delta.action}`);
  }
  return parts.join(". ");
}

function isArchivedNode(content: string): boolean {
  try {
    const parsed = matter(content);
    return parsed.data.archived === true;
  } catch {
    return false;
  }
}

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function atomicAppendFile(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }
  fs.writeFileSync(tmpPath, existing + content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function hasDiskChanged(state: NotionSyncState, notionKey: string, sourceNodes: string[]): boolean {
  for (const src of sourceNodes) {
    if (src.includes("*")) continue;
    const filePath = resolveSourceFilePath(src);
    if (!filePath || !fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    const currentHash = computeContentHash(content);

    if (state.pages[notionKey]?.lastSyncedHash !== currentHash) {
      return true;
    }
  }
  return false;
}

function readDiskContent(state: NotionSyncState, notionKey: string, sourceNodes: string[]): string {
  const parts: string[] = [];
  for (const src of sourceNodes) {
    if (src.includes("*")) continue;
    const filePath = resolveSourceFilePath(src);
    if (filePath && fs.existsSync(filePath)) {
      parts.push(`--- ${src} ---\n${fs.readFileSync(filePath, "utf-8")}`);
    }
  }
  return parts.join("\n\n");
}

function resolveSourceFilePath(sourcePath: string): string | null {
  if (sourcePath === "mind/model") {
    return path.join(CONFIG.paths.mind, "model.json");
  }
  if (sourcePath.startsWith("lenses/")) {
    const parts = sourcePath.split("/");
    if (parts.length >= 2) {
      return path.join(CONFIG.paths.lenses, sanitizeProjectSlug(parts[1]), "model.json");
    }
  }
  if (sourcePath.startsWith("sessions/")) {
    const project = sourcePath.split("/")[1];
    return path.join(CONFIG.paths.sessions, `${sanitizeProjectSlug(project)}.jsonl`);
  }
  if (sourcePath.startsWith("dreams/")) {
    return null;
  }
  const nodesCandidate = path.join(CONFIG.paths.nodes, sourcePath + ".md");
  if (fs.existsSync(nodesCandidate)) return nodesCandidate;
  const archiveCandidate = path.join(CONFIG.paths.archive, sourcePath + ".md");
  if (fs.existsSync(archiveCandidate)) return archiveCandidate;
  return null;
}

function inferEditType(notionKey: string, content: string, lastSyncedHash: string): InboundEditType {
  if (notionKey.startsWith("task:") || notionKey.startsWith("brief:")) {
    return "task_status_change";
  }
  if (notionKey.includes("guardrail") || notionKey === "how-i-think") {
    return "guardrail_change";
  }
  if (notionKey.startsWith("projects/")) {
    return "project_convention_change";
  }
  if (notionKey.includes("preferences") || notionKey.includes("corrections")) {
    return "preference_edit";
  }
  return "unknown";
}

function extractTaskStatusFromContent(content: string): string | null {
  const statusMatch = content.match(/Status["\s:]+(Backlog|Next|In Progress|Blocked|Done)/i);
  return statusMatch ? statusMatch[1] : null;
}

function getObservationDir(notionKey: string): string {
  if (notionKey.startsWith("projects/")) {
    const project = notionKey.split("/")[1];
    return path.join(CONFIG.paths.lenses, sanitizeProjectSlug(project));
  }
  return CONFIG.paths.mind;
}
