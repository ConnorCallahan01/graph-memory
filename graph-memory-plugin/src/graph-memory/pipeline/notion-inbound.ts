import fs from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { computeContentHash, NotionSyncState, readNotionSyncState, writeNotionSyncState } from "./notion-sync.js";
import { getPage, getComments, searchDatabaseRows } from "./notion-cli.js";

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
      switch (delta.action) {
        case "create_observation": {
          const obsDir = getObservationDir(delta.notionKey);
          if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });

          const obsLine = JSON.stringify({
            type: "observation",
            source: "notion-inbound",
            notionKey: delta.notionKey,
            content: delta.observation,
            tags: ["source:notion-inbound"],
            timestamp: new Date().toISOString(),
            ...delta.payload,
          });
          atomicAppendFile(path.join(obsDir, "observations.jsonl"), obsLine + "\n");
          applied++;
          break;
        }
        case "update_node": {
          if (!fs.existsSync(delta.targetFile)) {
            errors.push(`Target file not found: ${delta.targetFile}`);
            break;
          }
          const raw = fs.readFileSync(delta.targetFile, "utf-8");
          if (isArchivedNode(raw)) {
            break;
          }
          const parsed = matter(raw);
          parsed.content = parsed.content.trimEnd() + "\n\n<!-- notion-inbound update -->\n" + delta.observation;
          atomicWriteFile(delta.targetFile, matter.stringify(parsed.content, parsed.data));
          applied++;
          break;
        }
        case "lower_confidence": {
          if (!fs.existsSync(delta.targetFile)) {
            errors.push(`Target file not found: ${delta.targetFile}`);
            break;
          }
          const raw = fs.readFileSync(delta.targetFile, "utf-8");
          if (isArchivedNode(raw)) break;
          const parsed = matter(raw);
          if (typeof parsed.data.confidence === "number") {
            parsed.data.confidence = typeof delta.payload.newConfidence === "number"
              ? delta.payload.newConfidence
              : 0.3;
          }
          atomicWriteFile(delta.targetFile, matter.stringify(parsed.content, parsed.data));
          applied++;
          break;
        }
        case "update_model": {
          if (!fs.existsSync(delta.targetFile)) {
            errors.push(`Model file not found: ${delta.targetFile}`);
            break;
          }
          const model = JSON.parse(fs.readFileSync(delta.targetFile, "utf-8"));
          if (delta.payload.field && delta.payload.value !== undefined) {
            const parts = String(delta.payload.field).split(".");
            let target: any = model;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!target[parts[i]]) target[parts[i]] = {};
              target = target[parts[i]];
            }
            target[parts[parts.length - 1]] = delta.payload.value;
          }
          atomicWriteFile(delta.targetFile, JSON.stringify(model, null, 2));
          applied++;
          break;
        }
        case "log_conflict": {
          const obsDir = getObservationDir(delta.notionKey);
          if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });

          const obsLine = JSON.stringify({
            type: "merge_conflict",
            source: "notion-inbound",
            notionKey: delta.notionKey,
            content: delta.observation,
            tags: ["source:notion-inbound", "merge-conflict"],
            timestamp: new Date().toISOString(),
            ...delta.payload,
          });
          atomicAppendFile(path.join(obsDir, "observations.jsonl"), obsLine + "\n");
          applied++;
          break;
        }
      }
    } catch (err: any) {
      errors.push(`Failed to apply delta for ${delta.notionKey}: ${err.message}`);
    }
  }

  return { applied, errors };
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
    return path.join(CONFIG.paths.v3Mind, "model.json");
  }
  if (sourcePath.startsWith("lenses/")) {
    const parts = sourcePath.split("/");
    if (parts.length >= 2) {
      return path.join(CONFIG.paths.v3Lenses, parts[1], "model.json");
    }
  }
  if (sourcePath.startsWith("sessions/")) {
    const project = sourcePath.split("/")[1];
    return path.join(CONFIG.paths.v3Sessions, `${project}.jsonl`);
  }
  if (sourcePath.startsWith("dreams/")) {
    return CONFIG.paths.dreams;
  }
  const graphDir = CONFIG.paths.v3Graph;
  const candidate = path.join(graphDir, sourcePath + ".md");
  if (fs.existsSync(candidate)) return candidate;
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
    return path.join(CONFIG.paths.v3Lenses, project);
  }
  return CONFIG.paths.v3Mind;
}
