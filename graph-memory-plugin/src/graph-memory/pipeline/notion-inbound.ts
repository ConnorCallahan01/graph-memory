import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { computeContentHash, NotionSyncState, readNotionSyncState, writeNotionSyncState } from "./notion-sync.js";
import { getPage } from "./notion-cli.js";

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

          const obsPath = path.join(obsDir, `notion-inbound-${Date.now()}.json`);
          fs.writeFileSync(obsPath, JSON.stringify({
            type: "observation",
            source: "notion-inbound",
            notionKey: delta.notionKey,
            content: delta.observation,
            tags: ["source:notion-inbound"],
            timestamp: new Date().toISOString(),
            ...delta.payload,
          }, null, 2));
          applied++;
          break;
        }
        case "update_node": {
          if (fs.existsSync(delta.targetFile)) {
            const existing = fs.readFileSync(delta.targetFile, "utf-8");
            const updated = existing + "\n\n<!-- notion-inbound update -->\n" + delta.observation;
            fs.writeFileSync(delta.targetFile, updated);
            applied++;
          } else {
            errors.push(`Target file not found: ${delta.targetFile}`);
          }
          break;
        }
        case "lower_confidence": {
          if (fs.existsSync(delta.targetFile)) {
            const raw = fs.readFileSync(delta.targetFile, "utf-8");
            const updated = raw.replace(
              /confidence:\s*[\d.]+/,
              `confidence: ${delta.payload.newConfidence || 0.3}`
            );
            fs.writeFileSync(delta.targetFile, updated);
            applied++;
          } else {
            errors.push(`Target file not found: ${delta.targetFile}`);
          }
          break;
        }
        case "update_model": {
          if (fs.existsSync(delta.targetFile)) {
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
            fs.writeFileSync(delta.targetFile, JSON.stringify(model, null, 2));
            applied++;
          } else {
            errors.push(`Model file not found: ${delta.targetFile}`);
          }
          break;
        }
        case "log_conflict": {
          const obsDir = getObservationDir(delta.notionKey);
          if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });

          const conflictPath = path.join(obsDir, `notion-merge-conflict-${Date.now()}.json`);
          fs.writeFileSync(conflictPath, JSON.stringify({
            type: "merge_conflict",
            source: "notion-inbound",
            notionKey: delta.notionKey,
            content: delta.observation,
            tags: ["source:notion-inbound", "merge-conflict"],
            timestamp: new Date().toISOString(),
            ...delta.payload,
          }, null, 2));
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
