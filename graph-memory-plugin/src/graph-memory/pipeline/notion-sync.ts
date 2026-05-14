import fs from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { walkNodes } from "../utils.js";
import { activityBus } from "../events.js";
import {
  createPage,
  updatePage,
  createDatabaseRow,
  updateDatabaseRow,
  archivePage,
  checkNtn,
  buildDatabaseProperties,
  listChildBlocks,
  appendBlocks,
} from "./notion-cli.js";

export interface NotionSyncPageState {
  pageId: string;
  sourceNodes: string[];
  lastSyncedHash: string;
  lastNotionHash: string;
}

export interface NotionSyncRowState {
  pageId: string;
  sourceField: string;
  sourceSession?: string;
  status: string;
  lastSyncedHash: string;
}

export interface NotionSyncDatabaseState {
  id: string;
  views?: Record<string, string>;
}

export interface NotionSyncState {
  version: 1;
  enabled: boolean;
  parentPageId: string;
  lastSyncAt: string;
  lastInboundAt: string;
  syncHourLocal: number;
  workspaceName: string;
  databases: Record<string, NotionSyncDatabaseState>;
  pages: Record<string, NotionSyncPageState>;
  rows: Record<string, NotionSyncRowState>;
}

export type DiffClassification = "new" | "updated" | "archived" | "unchanged";

export interface DiffItem {
  key: string;
  classification: DiffClassification;
  batch: string;
  filePath: string;
  contentHash: string;
  sourcePaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface NotionSyncDiff {
  generatedAt: string;
  items: DiffItem[];
  stats: {
    new: number;
    updated: number;
    archived: number;
    unchanged: number;
    total: number;
  };
  batches: string[];
}

export function createEmptyNotionSyncState(): NotionSyncState {
  return {
    version: 1,
    enabled: false,
    parentPageId: "",
    lastSyncAt: "",
    lastInboundAt: "",
    syncHourLocal: 8,
    workspaceName: "My Mind",
    databases: {},
    pages: {},
    rows: {},
  };
}

export function readNotionSyncState(): NotionSyncState {
  const statePath = CONFIG.paths.notionSyncState;
  if (!fs.existsSync(statePath)) {
    return createEmptyNotionSyncState();
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as NotionSyncState;
  } catch {
    return createEmptyNotionSyncState();
  }
}

export function writeNotionSyncState(state: NotionSyncState): void {
  const statePath = CONFIG.paths.notionSyncState;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function computeContentHash(content: string): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function buildNotionDiff(state: NotionSyncState): NotionSyncDiff {
  const items: DiffItem[] = [];
  const lastSync = state.lastSyncAt;

  scanGraphNodes(state, items);
  scanGlobalModel(state, items);
  scanProjectModels(state, items);
  scanSessionLogs(state, items, lastSync);
  scanWorkingState(state, items, lastSync);
  scanBriefs(state, items);
  scanDreams(state, items);

  const stats = {
    new: items.filter((i) => i.classification === "new").length,
    updated: items.filter((i) => i.classification === "updated").length,
    archived: items.filter((i) => i.classification === "archived").length,
    unchanged: items.filter((i) => i.classification === "unchanged").length,
    total: items.length,
  };

  const batchSet = new Set(items.map((i) => i.batch));

  return {
    generatedAt: new Date().toISOString(),
    items,
    stats,
    batches: Array.from(batchSet),
  };
}

export function groupIntoBatches(diff: NotionSyncDiff, maxBatchSize: number): DiffItem[][] {
  const changed = diff.items.filter(
    (i) => i.classification === "new" || i.classification === "updated"
  );
  if (changed.length === 0) return [];

  const byBatch = new Map<string, DiffItem[]>();
  for (const item of changed) {
    const existing = byBatch.get(item.batch) || [];
    existing.push(item);
    byBatch.set(item.batch, existing);
  }

  const result: DiffItem[][] = [];
  for (const [, batchItems] of byBatch) {
    for (let i = 0; i < batchItems.length; i += maxBatchSize) {
      result.push(batchItems.slice(i, i + maxBatchSize));
    }
  }

  return result;
}

function classifyByHash(
  key: string,
  currentHash: string,
  syncedHashes: Record<string, string>
): DiffClassification {
  if (!syncedHashes[key]) return "new";
  if (syncedHashes[key] === currentHash) return "unchanged";
  return "updated";
}

function lookupSyncedHash(state: NotionSyncState, key: string): string {
  if (state.pages[key]) return state.pages[key].lastSyncedHash;
  if (state.rows[key]) return state.rows[key].lastSyncedHash;
  for (const pageState of Object.values(state.pages)) {
    if (pageState.sourceNodes.includes(key)) return pageState.lastSyncedHash;
  }
  return "";
}

function scanGraphNodes(state: NotionSyncState, items: DiffItem[]): void {
  const graphDir = CONFIG.paths.v3Graph;
  if (!fs.existsSync(graphDir)) return;

  const syncedHashes: Record<string, string> = {};
  for (const [, pageState] of Object.entries(state.pages)) {
    for (const src of pageState.sourceNodes) {
      if (!src.includes("*")) syncedHashes[src] = pageState.lastSyncedHash;
    }
  }

  for (const { nodePath, filePath } of walkNodes(graphDir)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = computeContentHash(content);

    const batch = inferNodeBatch(nodePath);
    const classification = classifyByHash(nodePath, hash, syncedHashes);

    let parsedData: Record<string, any> = {};
    try {
      parsedData = matter(content).data || {};
    } catch {}

    const archived = parsedData.archived === true;

    items.push({
      key: nodePath,
      classification: archived ? "archived" : classification,
      batch,
      filePath,
      contentHash: hash,
      metadata: {
        gist: parsedData.gist || "",
        tags: parsedData.tags || [],
        confidence: parsedData.confidence || 0,
        category: parsedData.category || "",
        project: parsedData.project || "",
      },
    });
  }
}

function inferNodeBatch(nodePath: string): string {
  const category = nodePath.split("/")[0];
  switch (category) {
    case "patterns":
    case "anti-patterns":
    case "concepts":
      return "global-wiki";
    case "decisions":
      return "decisions";
    case "projects":
      return `project:${nodePath.split("/")[1] || "unknown"}`;
    case "preferences":
    case "procedures":
    case "corrections":
    case "tools":
    case "people":
    case "architecture":
      return "global-wiki";
    default:
      return "global-wiki";
  }
}

function scanGlobalModel(state: NotionSyncState, items: DiffItem[]): void {
  const modelPath = path.join(CONFIG.paths.v3Mind, "model.json");
  if (!fs.existsSync(modelPath)) return;

  const content = fs.readFileSync(modelPath, "utf-8");
  const hash = computeContentHash(content);
  const syncedHash = lookupSyncedHash(state, "mind/model");

  items.push({
    key: "mind/model",
    classification: syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new",
    batch: "global-wiki",
    filePath: modelPath,
    contentHash: hash,
  });
}

function scanProjectModels(state: NotionSyncState, items: DiffItem[]): void {
  const lensesDir = CONFIG.paths.v3Lenses;
  if (!fs.existsSync(lensesDir)) return;

  for (const entry of fs.readdirSync(lensesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_archived") continue;

    const modelPath = path.join(lensesDir, entry.name, "model.json");
    if (!fs.existsSync(modelPath)) continue;

    const content = fs.readFileSync(modelPath, "utf-8");
    const hash = computeContentHash(content);
    const pageKey = `projects/${entry.name}`;
    const syncedHash = lookupSyncedHash(state, pageKey);

    items.push({
      key: pageKey,
      classification: syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new",
      batch: `project:${entry.name}`,
      filePath: modelPath,
      contentHash: hash,
    });
  }
}

function scanSessionLogs(
  state: NotionSyncState,
  items: DiffItem[],
  lastSync: string
): void {
  const sessionsDir = CONFIG.paths.v3Sessions;
  if (!fs.existsSync(sessionsDir)) return;

  for (const entry of fs.readdirSync(sessionsDir)) {
    if (!entry.endsWith(".jsonl")) continue;

    const project = entry.replace(".jsonl", "");
    const filePath = path.join(sessionsDir, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = computeContentHash(content);
    const pageKey = `sessions/${project}`;
    const syncedHash = lookupSyncedHash(state, pageKey);

    let classification: DiffClassification = syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new";
    if (lastSync) {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < new Date(lastSync).getTime()) {
        classification = "unchanged";
      }
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const taskSignals: string[] = [];
    const decisionSignals: string[] = [];

    for (const line of lines) {
      try {
        const log = JSON.parse(line);
        if (log.openThreads?.length) taskSignals.push(...log.openThreads);
        if (log.blocked?.length) taskSignals.push(...log.blocked);
        if (log.activeWork?.length) taskSignals.push(...log.activeWork);
        if (log.nextSessionShould) taskSignals.push(log.nextSessionShould);
        if (log.decisions?.length) decisionSignals.push(...log.decisions);
        if (log.shipped?.length) taskSignals.push(...log.shipped);
      } catch {}
    }

    items.push({
      key: pageKey,
      classification,
      batch: `project:${project}`,
      filePath,
      contentHash: hash,
      metadata: {
        project,
        taskSignals: [...new Set(taskSignals)],
        decisionSignals: [...new Set(decisionSignals)],
        sessionCount: lines.length,
      },
    });
  }
}

function scanWorkingState(
  state: NotionSyncState,
  items: DiffItem[],
  lastSync: string
): void {
  const workingProjects = CONFIG.paths.workingProjects;
  if (!fs.existsSync(workingProjects)) return;

  for (const entry of fs.readdirSync(workingProjects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const statePath = path.join(workingProjects, entry.name, `${entry.name}.state.json`);
    if (!fs.existsSync(statePath)) continue;

    const stat = fs.statSync(statePath);
    if (lastSync && stat.mtimeMs < new Date(lastSync).getTime()) continue;

    const content = fs.readFileSync(statePath, "utf-8");
    const hash = computeContentHash(content);
    const project = entry.name;

    const taskSignals: string[] = [];
    try {
      const data = JSON.parse(content);
      for (const session of data.sessions || []) {
        if (session.nextPickup?.length) taskSignals.push(...session.nextPickup);
        if (session.didntWork?.length) taskSignals.push(...session.didntWork);
        if (session.tasksWorkedOn?.length) taskSignals.push(...session.tasksWorkedOn);
      }
    } catch {}

    items.push({
      key: `working/${project}`,
      classification: "updated",
      batch: `project:${project}`,
      filePath: statePath,
      contentHash: hash,
      metadata: { project, taskSignals: [...new Set(taskSignals)] },
    });
  }
}

function scanBriefs(state: NotionSyncState, items: DiffItem[]): void {
  const briefsDir = CONFIG.paths.dailyBriefs;
  if (!fs.existsSync(briefsDir)) return;

  for (const entry of fs.readdirSync(briefsDir)) {
    if (!entry.endsWith(".json")) continue;

    const date = entry.replace(".json", "");
    const filePath = path.join(briefsDir, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = computeContentHash(content);
    const rowKey = `brief:${date}`;
    const syncedHash = lookupSyncedHash(state, rowKey);

    items.push({
      key: rowKey,
      classification: syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new",
      batch: "briefs",
      filePath,
      contentHash: hash,
      metadata: { date },
    });
  }
}

function scanDreams(state: NotionSyncState, items: DiffItem[]): void {
  const dreamsDir = CONFIG.paths.dreams;
  if (!fs.existsSync(dreamsDir)) return;

  for (const subDir of ["pending", "integrated"]) {
    const subPath = path.join(dreamsDir, subDir);
    if (!fs.existsSync(subPath)) continue;

    const content = fs.readdirSync(subPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => fs.readFileSync(path.join(subPath, f), "utf-8"))
      .join("\n");

    if (!content) continue;

    const hash = computeContentHash(content);
    const pageKey = `dreams/${subDir}`;
    const syncedHash = lookupSyncedHash(state, pageKey);

    items.push({
      key: pageKey,
      classification: syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new",
      batch: "dreams",
      filePath: subPath,
      contentHash: hash,
    });
  }
}

export interface SyncPlanCreate {
  type: "database_row" | "wiki_page";
  target: string;
  notionKey: string;
  properties?: Record<string, any>;
  markdown?: string;
  sourceNodes: string[];
}

export interface SyncPlanUpdate {
  notionPageId: string;
  notionKey: string;
  type: "database_row" | "wiki_page";
  changedProperties?: Record<string, any>;
  markdown?: string;
  sourceNodes: string[];
  mergeStrategy: "replace" | "append";
}

export interface SyncPlanArchive {
  notionPageId: string;
  notionKey: string;
  reason: string;
}

export interface SyncPlan {
  generatedAt: string;
  syncId: string;
  creates: SyncPlanCreate[];
  updates: SyncPlanUpdate[];
  archives: SyncPlanArchive[];
}

export function writeDiffReport(diff: NotionSyncDiff): string {
  const reportPath = path.join(CONFIG.paths.graphRoot, ".notion-sync-input.json");
  fs.writeFileSync(reportPath, JSON.stringify(diff, null, 2));
  return reportPath;
}

export function readSyncPlan(): SyncPlan | null {
  const planPath = path.join(CONFIG.paths.graphRoot, ".notion-sync-plan.json");
  if (!fs.existsSync(planPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(planPath, "utf-8")) as SyncPlan;
  } catch {
    return null;
  }
}

export function executeNotionSync(
  plan: SyncPlan,
  state: NotionSyncState,
): { created: number; updated: number; archived: number; errors: string[] } {
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let archived = 0;

  for (const item of plan.creates) {
    try {
      if (item.type === "wiki_page") {
        const result = createPage(state.parentPageId, item.markdown || "");
        state.pages[item.notionKey] = {
          pageId: result.id,
          sourceNodes: item.sourceNodes,
          lastSyncedHash: computeContentHash(item.markdown || ""),
          lastNotionHash: computeContentHash(item.markdown || ""),
        };
        created++;
      } else if (item.type === "database_row") {
        const dbId = resolveDatabaseId(state, item.target);
        if (!dbId) {
          errors.push(`No database ID for target: ${item.target}`);
          continue;
        }
        const titleKey = resolveTitleKey(item.target);
        const result = createDatabaseRow(dbId, item.properties || {}, item.markdown, titleKey);
        state.rows[item.notionKey] = {
          pageId: result.id,
          sourceField: item.target,
          status: extractStatus(item.properties),
          lastSyncedHash: computeContentHash(JSON.stringify(item.properties)),
        };
        created++;
      }
    } catch (err: any) {
      errors.push(`Create ${item.notionKey}: ${err.message}`);
    }
  }

  for (const item of plan.updates) {
    try {
      if (item.type === "wiki_page") {
        updatePage(item.notionPageId, item.markdown || "");
        const pageState = state.pages[item.notionKey];
        if (pageState) {
          pageState.lastSyncedHash = computeContentHash(item.markdown || "");
          pageState.lastNotionHash = pageState.lastSyncedHash;
          pageState.sourceNodes = item.sourceNodes;
        }
        updated++;
      } else if (item.type === "database_row") {
        const rowStateForTitle = state.rows[item.notionKey];
        const updateTitleKey = resolveTitleKey(rowStateForTitle?.sourceField || "");
        updateDatabaseRow(item.notionPageId, item.changedProperties || {}, updateTitleKey);
        const rowState = state.rows[item.notionKey];
        if (rowState) {
          rowState.lastSyncedHash = computeContentHash(JSON.stringify(item.changedProperties));
          rowState.status = extractStatus(item.changedProperties) || rowState.status;
        }
        updated++;
      }
    } catch (err: any) {
      errors.push(`Update ${item.notionKey}: ${err.message}`);
    }
  }

  for (const item of plan.archives) {
    try {
      archivePage(item.notionPageId);
      delete state.pages[item.notionKey];
      delete state.rows[item.notionKey];
      archived++;
    } catch (err: any) {
      errors.push(`Archive ${item.notionKey}: ${err.message}`);
    }
  }

  return { created, updated, archived, errors };
}

function resolveDatabaseId(state: NotionSyncState, target: string): string {
  if (state.databases[target]?.id) return state.databases[target].id;
  const mapping: Record<string, string> = {
    tasks: "tasks",
    decisions: "decisions",
    briefs: "briefs",
  };
  const key = mapping[target];
  return (key && state.databases[key]?.id) || "";
}

function resolveTitleKey(target: string): string {
  const titleMap: Record<string, string> = {
    tasks: "Name",
    decisions: "Decision",
    briefs: "Date",
  };
  return titleMap[target] || "Name";
}

function extractStatus(props?: Record<string, any>): string {
  if (!props) return "";
  const status = props.Status;
  if (status?.select?.name) return status.select.name;
  if (typeof status === "string") return status;
  return "";
}

export interface ConsolidationResult {
  mergedPages: number;
  archivedPages: number;
  renamedPages: number;
  errors: string[];
}

export function consolidateNotionWorkspace(
  dryRun: boolean = false,
): ConsolidationResult {
  const state = readNotionSyncState();
  const result: ConsolidationResult = {
    mergedPages: 0,
    archivedPages: 0,
    renamedPages: 0,
    errors: [],
  };

  const wikiGroups: Record<string, { key: string; pageId: string; sourceNodes: string[] }[]> = {};
  for (const [key, ps] of Object.entries(state.pages)) {
    if (!key.startsWith("wiki-group:")) continue;
    const groupPrefix = key.replace(/:\d+$/, "");
    if (!wikiGroups[groupPrefix]) wikiGroups[groupPrefix] = [];
    wikiGroups[groupPrefix].push({ key, pageId: ps.pageId, sourceNodes: ps.sourceNodes });
  }

  for (const [groupPrefix, pages] of Object.entries(wikiGroups)) {
    if (pages.length <= 1) continue;

    const [wikiPage, category] = groupPrefix.replace("wiki-group:", "").split("/");
    const displayName = category.replace(/^\./, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    const targetPage = pages[0];
    const sourcePages = pages.slice(1);

    if (!dryRun) {
      for (const src of sourcePages) {
        try {
          const blocks = listChildBlocks(src.pageId);
          if (blocks.length > 0) {
            appendBlocks(targetPage.pageId, blocks);
          }
          archivePage(src.pageId);
          delete state.pages[src.key];
        } catch (err: any) {
          result.errors.push(`Merge ${src.key}: ${err.message}`);
        }
      }

      const oldKey = targetPage.key;
      const newKey = groupPrefix;
      if (oldKey !== newKey) {
        state.pages[newKey] = state.pages[oldKey];
        delete state.pages[oldKey];
      }

      const allSourceNodes = pages.flatMap(p => p.sourceNodes);
      state.pages[newKey].sourceNodes = allSourceNodes;
    }

    result.mergedPages += sourcePages.length;
    activityBus.log("notion-sync:complete", `Consolidated ${pages.length} "${displayName}" pages into 1`, {
      groupPrefix,
      mergedCount: sourcePages.length,
    });
  }

  const pagesToArchive: string[] = [];
  for (const [key, ps] of Object.entries(state.pages)) {
    if (ps.sourceNodes.length === 0 && !key.startsWith("wiki-group:") && !["how-i-think", "projects", "patterns-insights", "dreams-experiments", "archive"].includes(key)) {
      pagesToArchive.push(key);
    }
  }

  if (!dryRun) {
    for (const key of pagesToArchive) {
      try {
        archivePage(state.pages[key].pageId);
        delete state.pages[key];
      } catch (err: any) {
        result.errors.push(`Archive ${key}: ${err.message}`);
      }
    }
  }
  result.archivedPages = pagesToArchive.length;

  if (!dryRun) {
    state.lastSyncAt = new Date().toISOString();
    writeNotionSyncState(state);
  }

  return result;
}
