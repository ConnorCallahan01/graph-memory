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
  searchDatabaseRows,
  getPage,
} from "./notion-cli.js";

export interface NotionSyncPageState {
  pageId: string;
  sourceNodes: string[];
  lastSyncedHash: string;
  lastNotionHash: string;
  lastSourceHash?: string;
  lastCommentAt?: string;
  deleted?: boolean;
}

export interface NotionSyncRowState {
  pageId: string;
  sourceField: string;
  sourceSession?: string;
  status: string;
  lastSyncedHash: string;
  lastSourceHash?: string;
  lastCommentAt?: string;
  deleted?: boolean;
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
  const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0;

  scanGraphNodes(state, items, lastSyncMs);
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
  const normalizedKey = normalizeSourceNodeToNodePath(key);
  for (const pageState of Object.values(state.pages)) {
    for (const src of pageState.sourceNodes) {
      if (normalizeSourceNodeToNodePath(src) === normalizedKey) return pageState.lastSyncedHash;
    }
    if (pageState.sourceNodes.includes(key)) return pageState.lastSyncedHash;
  }
  return "";
}

function normalizeSourceNodeToNodePath(src: string): string {
  return src
    .replace(/^graph\//, "")
    .replace(/^nodes\//, "")
    .replace(/\.md$/, "");
}

function scanGraphNodes(state: NotionSyncState, items: DiffItem[], lastSyncMs: number): void {
  const graphDir = CONFIG.paths.nodes;
  if (!fs.existsSync(graphDir)) return;

  const knownRows = new Set(Object.keys(state.rows));
  const knownPageSources = new Set<string>();
  for (const pageState of Object.values(state.pages)) {
    for (const src of pageState.sourceNodes) {
      knownPageSources.add(normalizeSourceNodeToNodePath(src));
    }
  }

  for (const { nodePath, filePath } of walkNodes(graphDir)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = computeContentHash(content);
    const batch = inferNodeBatch(nodePath);
    let parsedData: Record<string, any> = {};
    try { parsedData = matter(content).data || {}; } catch {}

    const archived = parsedData.archived === true;
    let classification: DiffClassification;

    if (archived) {
      classification = "archived";
    } else {
      const isKnown = knownRows.has(nodePath) || knownPageSources.has(nodePath);
      const storedSourceHash = state.rows[nodePath]?.lastSourceHash;
      if (storedSourceHash) {
        classification = storedSourceHash === hash ? "unchanged" : "updated";
      } else if (isKnown) {
        if (lastSyncMs > 0) {
          const stat = fs.statSync(filePath);
          classification = stat.mtimeMs > lastSyncMs ? "updated" : "unchanged";
        } else {
          classification = "unchanged";
        }
      } else {
        classification = "new";
      }
    }

    items.push({
      key: nodePath,
      classification,
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
  const modelPath = path.join(CONFIG.paths.mind, "model.json");
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
  const lensesDir = CONFIG.paths.lenses;
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
  const sessionsDir = CONFIG.paths.sessions;
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

    const rowKey = `working/${project}`;
    const syncedHash = lookupSyncedHash(state, rowKey);
    const classification: DiffClassification = syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new";

    items.push({
      key: rowKey,
      classification,
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

    const dreamFiles = fs.readdirSync(subPath).filter((f) => f.endsWith(".json"));
    if (dreamFiles.length === 0) continue;

    const contents = dreamFiles.map((f) => fs.readFileSync(path.join(subPath, f), "utf-8"));
    const content = contents.join("\n");
    const hash = computeContentHash(content);
    const pageKey = `dreams/${subDir}`;
    const syncedHash = lookupSyncedHash(state, pageKey);

    const sourcePaths = dreamFiles.map((f) => path.join(subPath, f));

    items.push({
      key: pageKey,
      classification: syncedHash === hash ? "unchanged" : syncedHash ? "updated" : "new",
      batch: "dreams",
      filePath: sourcePaths[0],
      contentHash: hash,
      sourcePaths,
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
  target?: string;
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

export interface StewardPlan {
  steward: string;
  generatedAt: string;
  creates: SyncPlanCreate[];
  updates: SyncPlanUpdate[];
  archives: SyncPlanArchive[];
}

export interface SyncPlan {
  generatedAt: string;
  syncId: string;
  creates: SyncPlanCreate[];
  updates: SyncPlanUpdate[];
  archives: SyncPlanArchive[];
}

export function mergeStewardPlans(plans: StewardPlan[], syncId: string): SyncPlan {
  const allCreates: SyncPlanCreate[] = [];
  const allUpdates: SyncPlanUpdate[] = [];
  const allArchives: SyncPlanArchive[] = [];

  const seenCreateKeys = new Set<string>();
  const seenUpdateKeys = new Set<string>();
  const seenArchiveKeys = new Set<string>();

  for (const plan of plans) {
    for (const c of plan.creates) {
      if (seenCreateKeys.has(c.notionKey)) continue;
      seenCreateKeys.add(c.notionKey);
      allCreates.push(c);
    }

    for (const u of plan.updates) {
      if (seenUpdateKeys.has(u.notionKey)) continue;
      seenUpdateKeys.add(u.notionKey);
      allUpdates.push(u);
    }

    for (const a of plan.archives) {
      if (seenArchiveKeys.has(a.notionKey)) continue;
      seenArchiveKeys.add(a.notionKey);
      allArchives.push(a);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    syncId,
    creates: allCreates,
    updates: allUpdates,
    archives: allArchives,
  };
}

export function readStewardPlan(path: string): StewardPlan | null {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8")) as StewardPlan;
  } catch {
    return null;
  }
}

export interface WorkspaceManifestPage {
  pageId: string;
  title: string;
  url: string;
  sections: string[];
  lastSyncedHash: string;
  sourceNodes: string[];
}

export interface WorkspaceManifestRow {
  pageId: string;
  key: string;
  properties: Record<string, string>;
}

export interface WorkspaceManifestDatabase {
  id: string;
  name: string;
  rowCount: number;
  rows: WorkspaceManifestRow[];
}

export interface WorkspaceManifest {
  generatedAt: string;
  parentPageId: string;
  pages: Record<string, WorkspaceManifestPage>;
  databases: Record<string, WorkspaceManifestDatabase>;
}

const MANIFEST_DIR = ".notion-manifests";
const MAX_MANIFEST_FILES = 10;

function extractBlockHeadings(blocks: any[]): string[] {
  const headings: string[] = [];
  for (const block of blocks) {
    const type = block.type;
    if (type?.startsWith("heading_")) {
      const richText = block[type]?.rich_text;
      if (richText) {
        const text = richText.map((rt: any) => rt.plain_text || rt.text?.content || "").join("");
        if (text) headings.push(text);
      }
    }
  }
  return headings;
}

function extractRowProperties(row: any): Record<string, string> {
  const props = row.properties || {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    const v = value as any;
    if (v?.title?.length) {
      result[key] = v.title.map((t: any) => t.plain_text || t.text?.content || "").join("");
    } else if (v?.rich_text?.length) {
      result[key] = v.rich_text.map((t: any) => t.plain_text || t.text?.content || "").join("");
    } else if (v?.select?.name) {
      result[key] = v.select.name;
    } else if (v?.status?.name) {
      result[key] = v.status.name;
    } else if (v?.date?.start) {
      result[key] = v.date.start;
    } else if (v?.number !== undefined && v?.number !== null) {
      result[key] = String(v.number);
    }
  }
  return result;
}

export function buildWorkspaceManifest(state: NotionSyncState): WorkspaceManifest {
  const manifest: WorkspaceManifest = {
    generatedAt: new Date().toISOString(),
    parentPageId: state.parentPageId,
    pages: {},
    databases: {},
  };

  for (const [notionKey, pageState] of Object.entries(state.pages)) {
    if (!pageState.pageId || pageState.deleted) continue;

    let sections: string[] = [];
    let title = "";
    let url = "";

    try {
      const blocks = listChildBlocks(pageState.pageId);
      sections = extractBlockHeadings(blocks);
    } catch {
      sections = [];
    }

    try {
      const pageContent = getPage(pageState.pageId);
      const titleMatch = pageContent.match(/^#\s+(.+)$/m);
      title = titleMatch ? titleMatch[1].trim() : notionKey;
    } catch {
      title = notionKey;
    }

    manifest.pages[notionKey] = {
      pageId: pageState.pageId,
      title,
      url,
      sections,
      lastSyncedHash: pageState.lastSyncedHash,
      sourceNodes: pageState.sourceNodes,
    };
  }

  const dbRowKeyMap: Record<string, string> = {
    tasks: "Name",
    decisions: "Decision",
    briefs: "Title",
    projects: "Name",
    patterns: "Name",
    dreams: "Name",
  };

  for (const [dbKey, dbState] of Object.entries(state.databases)) {
    if (!dbState.id) continue;

    const rows: WorkspaceManifestRow[] = [];
    try {
      const dbRows = searchDatabaseRows(dbState.id);
      for (const row of dbRows) {
        const rowId = row.id || "";
        const props = extractRowProperties(row);
        const displayKey = dbRowKeyMap[dbKey] || "Name";
        const keyValue = props[displayKey] || rowId;

        let syncKey = "";
        for (const [rowKey, rowState] of Object.entries(state.rows)) {
          if (rowState.pageId === rowId) {
            syncKey = rowKey;
            break;
          }
        }

        rows.push({
          pageId: rowId,
          key: syncKey || keyValue,
          properties: props,
        });
      }
    } catch {
      // database query failed
    }

    manifest.databases[dbKey] = {
      id: dbState.id,
      name: dbKey,
      rowCount: rows.length,
      rows,
    };
  }

  return manifest;
}

export function writeWorkspaceManifest(manifest: WorkspaceManifest): string {
  const manifestsDir = path.join(CONFIG.paths.graphRoot, MANIFEST_DIR);
  if (!fs.existsSync(manifestsDir)) {
    fs.mkdirSync(manifestsDir, { recursive: true });
  }

  rotateManifestFiles(manifestsDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = path.join(manifestsDir, `manifest-${timestamp}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const latestPath = path.join(CONFIG.paths.graphRoot, ".notion-workspace-manifest.json");
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));

  return latestPath;
}

function rotateManifestFiles(manifestsDir: string): void {
  if (!fs.existsSync(manifestsDir)) return;

  const files = fs
    .readdirSync(manifestsDir)
    .filter((f) => f.startsWith("manifest-") && f.endsWith(".json"))
    .sort()
    .reverse();

  for (let i = MAX_MANIFEST_FILES; i < files.length; i++) {
    try {
      fs.unlinkSync(path.join(manifestsDir, files[i]));
    } catch {
      // rotation best-effort
    }
  }
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

function buildProjectLookup(state: NotionSyncState): Map<string, string> {
  const lookup = new Map<string, string>();
  const aliases: Record<string, string[]> = {
    "ConnorCallahan01__cogni-code": ["cogni-code", "cogni code", "graph memory", "graph-memory"],
    "Keel3__keel3_oliver_demo": ["oliver", "keel3 oliver demo", "keel3"],
    "acellushealth__openpatient": ["openpatient", "open patient", "ace engine"],
    "brandywine-buzz": ["brandywine buzz", "brandywine", "buzz"],
    "acellushealth__ace-engine-api": ["ace engine api"],
    "acellushealth__dvc": ["dvc"],
  };
  for (const [key, row] of Object.entries(state.rows)) {
    if (row.sourceField !== "projects" || !row.pageId) continue;
    const name = key.replace(/^project:/, "");
    lookup.set(name.toLowerCase(), row.pageId);
    const parts = name.split("__");
    if (parts.length === 2) {
      lookup.set(parts[1].toLowerCase(), row.pageId);
      lookup.set(parts[0].toLowerCase() + "/" + parts[1].toLowerCase(), row.pageId);
    }
    const projectAliases = aliases[name];
    if (projectAliases) {
      for (const alias of projectAliases) {
        lookup.set(alias.toLowerCase(), row.pageId);
      }
    }
  }
  return lookup;
}

function resolveRelations(
  props: Record<string, any>,
  projectLookup: Map<string, string>,
): Record<string, any> {
  const relationKeys = ["Project"];
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (relationKeys.includes(key) && typeof value === "string") {
      const pageId = projectLookup.get(value.toLowerCase());
      if (pageId) {
        resolved[key] = { relation: [{ id: pageId }] };
      } else {
        for (const [lookupKey, lookupId] of projectLookup.entries()) {
          if (lookupKey.includes(value.toLowerCase()) || value.toLowerCase().includes(lookupKey)) {
            resolved[key] = { relation: [{ id: lookupId }] };
            break;
          }
        }
        if (!resolved[key]) {
          resolved[key] = { rich_text: [{ type: "text", text: { content: value } }] };
        }
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export function executeNotionSync(
  plan: SyncPlan,
  state: NotionSyncState,
): { created: number; updated: number; archived: number; errors: string[] } {
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let archived = 0;

  const projectLookup = buildProjectLookup(state);

  for (const item of plan.creates) {
    try {
      if (item.properties) {
        item.properties = resolveRelations(item.properties, projectLookup);
      }
      if (item.notionKey.startsWith("brief:") && state.rows[item.notionKey]) {
        continue;
      }

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
        const result = createDatabaseRow(dbId, item.properties || {}, item.markdown, titleKey, item.target);
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
      if (item.changedProperties) {
        item.changedProperties = resolveRelations(item.changedProperties, projectLookup);
      }
      if (item.type === "wiki_page") {
        const newHash = computeContentHash(item.markdown || "");
        const pageState = state.pages[item.notionKey];
        if (pageState && pageState.lastSyncedHash === newHash) {
          continue;
        }

        try {
          updatePage(item.notionPageId, item.markdown || "");
        } catch (replaceErr: any) {
          if (replaceErr.message?.includes("child page") || replaceErr.message?.includes("child") || replaceErr.message?.includes("archived")) {
            appendBlocks(item.notionPageId, [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "## Updated\n\n" + (item.markdown || "").slice(0, 1900) } }] } }]);
          } else {
            throw replaceErr;
          }
        }
        if (pageState) {
          pageState.lastSyncedHash = newHash;
          pageState.lastNotionHash = newHash;
          pageState.sourceNodes = item.sourceNodes;
        }
        updated++;
      } else if (item.type === "database_row") {
        const rowStateForTitle = state.rows[item.notionKey];
        let targetDb = rowStateForTitle?.sourceField || item.target || "";
        if (!targetDb) {
          const keyToDb: Record<string, string> = {
            brief: "briefs", task: "tasks", decision: "decisions",
            pattern: "patterns", dream: "dreams", project: "projects",
          };
          const prefix = item.notionKey.split(":")[0];
          targetDb = keyToDb[prefix] || "";
        }
        const updateTitleKey = resolveTitleKey(targetDb);
        if (Object.keys(item.changedProperties || {}).length > 0) {
          updateDatabaseRow(item.notionPageId, item.changedProperties || {}, updateTitleKey, targetDb);
        }
        if (item.markdown) {
          try {
            updatePage(item.notionPageId, item.markdown);
          } catch (e: any) {
            // best-effort body update
          }
        }
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
    projects: "projects",
    patterns: "patterns",
    dreams: "dreams",
  };
  const key = mapping[target];
  return (key && state.databases[key]?.id) || "";
}

function resolveTitleKey(target: string): string {
  const titleMap: Record<string, string> = {
    tasks: "Name",
    decisions: "Decision",
    briefs: "Title",
    projects: "Name",
    patterns: "Name",
    dreams: "Name",
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
