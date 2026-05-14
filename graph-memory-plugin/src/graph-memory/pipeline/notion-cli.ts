import { execFileSync, execSync } from "child_process";
import { activityBus } from "../events.js";

export interface NotionPageResult {
  id: string;
  url: string;
  content: string;
}

export interface NotionCreatePageResult {
  id: string;
  url: string;
}

export interface NtnCheckResult {
  installed: boolean;
  authenticated: boolean;
}

const NTN_TIMEOUT = 30_000;
const NTN_LONG_TIMEOUT = 120_000;

function execNtn(args: string[], options?: { input?: string; timeout?: number }): string {
  const timeout = options?.timeout ?? NTN_TIMEOUT;
  try {
    return execFileSync("ntn", args, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const msg = stderr.trim() || err.message;
    throw new Error(`ntn ${args.join(" ")} failed: ${msg}`);
  }
}

export function checkNtnInstalled(): boolean {
  try {
    execSync("which ntn", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function checkNtnAuth(): boolean {
  try {
    const result = execNtn(["doctor"]);
    return !result.toLowerCase().includes("not authenticated");
  } catch {
    return false;
  }
}

export function checkNtn(): NtnCheckResult {
  const installed = checkNtnInstalled();
  if (!installed) return { installed: false, authenticated: false };
  const authenticated = checkNtnAuth();
  return { installed, authenticated };
}

export function createPage(
  parentId: string | undefined,
  markdown: string,
): NotionCreatePageResult {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const titleText = titleMatch ? titleMatch[1].trim() : "Untitled";

  const body: Record<string, any> = {};

  if (parentId) {
    body.parent = { type: "page_id", page_id: parentId };
  } else {
    body.parent = { type: "workspace", workspace: true };
  }

  body.properties = {
    title: { title: [{ type: "text", text: { content: titleText } }] },
  };

  if (markdown) {
    const bodyContent = markdown.replace(/^#\s+.*\n?/, "").trim();
    if (bodyContent) {
      body.children = markdownToBlocks(bodyContent);
    }
  }

  const raw = execNtn(["api", "v1/pages", "--data", JSON.stringify(body)], {
    timeout: NTN_LONG_TIMEOUT,
  });
  const parsed = parseJsonSafe(raw);
  return {
    id: parsed?.id || "",
    url: parsed?.url || "",
  };
}

export function updatePage(
  pageId: string,
  markdown: string,
): void {
  execNtn(
    ["pages", "update", pageId],
    { input: markdown, timeout: NTN_LONG_TIMEOUT },
  );
}

export function getPage(pageId: string): string {
  return execNtn(["pages", "get", pageId], { timeout: NTN_TIMEOUT });
}

export function archivePage(pageId: string): void {
  execNtn(["api", `v1/pages/${pageId}`, "-X", "PATCH", "in_trash:=true"]);
}

export function listChildBlocks(pageId: string): any[] {
  const raw = execNtn(["api", `v1/blocks/${pageId}/children`, "-X", "GET"], {
    timeout: NTN_LONG_TIMEOUT,
  });
  const parsed = parseJsonSafe(raw);
  return parsed?.results || [];
}

export function appendBlocks(pageId: string, blocks: any[]): void {
  if (blocks.length === 0) return;
  const sanitized = blocks.map(stripReadOnlyFields);
  const body = JSON.stringify({ children: sanitized });
  execNtn(
    ["api", `v1/blocks/${pageId}/children`, "-X", "PATCH", "--data", body],
    { timeout: NTN_LONG_TIMEOUT },
  );
}

function stripReadOnlyFields(block: any): any {
  const clean: any = {
    object: "block",
    type: block.type,
  };
  const content = block[block.type];
  if (content) {
    clean[block.type] = removeNulls(content);
  }
  return clean;
}

function removeNulls(obj: any): any {
  if (Array.isArray(obj)) return obj.map(removeNulls);
  if (obj && typeof obj === "object") {
    const clean: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null) clean[k] = removeNulls(v);
    }
    return clean;
  }
  return obj;
}

export function createDatabase(
  parentId: string,
  title: string,
  _properties?: Record<string, any>,
): { id: string; dataSourceId: string } {
  const body = {
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: title } }],
  };
  const raw = execNtn(["api", "v1/databases", "--data", JSON.stringify(body)], {
    timeout: NTN_LONG_TIMEOUT,
  });
  const parsed = parseJsonSafe(raw);
  const dbId = parsed?.id || "";
  const dataSourceId = parsed?.data_sources?.[0]?.id || "";
  return { id: dbId, dataSourceId };
}

export function configureDataSource(
  dataSourceId: string,
  properties: Record<string, any>,
): void {
  const body: Record<string, any> = { properties: {} };
  for (const [name, config] of Object.entries(properties)) {
    if (config.type === "title") {
      body.properties[name] = config;
    } else {
      body.properties[name] = config;
    }
  }
  execNtn(
    ["api", `v1/data_sources/${dataSourceId}`, "-X", "PATCH", "--data", JSON.stringify(body)],
    { timeout: NTN_TIMEOUT },
  );
}

export function getDataSourceId(databaseId: string): string {
  const raw = execNtn(["api", `v1/databases/${databaseId}`]);
  const parsed = parseJsonSafe(raw);
  return parsed?.data_sources?.[0]?.id || "";
}

export function createDatabaseRow(
  databaseId: string,
  properties: Record<string, any>,
  childMarkdown?: string,
  titleKey?: string,
): NotionCreatePageResult {
  const normalized = normalizeProperties(properties, titleKey);
  const body: any = {
    parent: { type: "database_id", database_id: databaseId },
    properties: normalized,
  };
  if (childMarkdown) {
    body.children = markdownToBlocks(childMarkdown);
  }
  const raw = execNtn(["api", "v1/pages", "--data", JSON.stringify(body)], {
    timeout: NTN_LONG_TIMEOUT,
  });
  const parsed = parseJsonSafe(raw);
  return {
    id: parsed?.id || "",
    url: parsed?.url || "",
  };
}

export function updateDatabaseRow(
  pageId: string,
  properties: Record<string, any>,
  titleKey?: string,
): void {
  const normalized = normalizeProperties(properties, titleKey);
  execNtn(
    ["api", `v1/pages/${pageId}`, "-X", "PATCH", "--data", JSON.stringify({ properties: normalized })],
    { timeout: NTN_TIMEOUT },
  );
}

function normalizeProperties(
  props: Record<string, any>,
  titleKey?: string,
): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (key === titleKey) {
        normalized[key] = { title: [{ type: "text", text: { content: value } }] };
      } else if (["Status", "Project", "Priority"].includes(key)) {
        if (value === "") continue;
        normalized[key] = { select: { name: value } };
      } else if (key === "Date" || key === "Due" || key === "First Seen") {
        normalized[key] = { date: { start: value } };
      } else {
        normalized[key] = { rich_text: [{ type: "text", text: { content: value } }] };
      }
    } else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "string") {
        normalized[key] = { rich_text: [{ type: "text", text: { content: value.join(", ") } }] };
      } else {
        normalized[key] = value;
      }
    } else if (typeof value === "number") {
      normalized[key] = { number: value };
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function searchPages(query: string): Array<{ id: string; title: string; url: string }> {
  const raw = execNtn(["api", "v1/search", `query==${query}`, "page_size:=10"]);
  const parsed = parseJsonSafe(raw);
  if (!parsed?.results) return [];
  return parsed.results.map((r: any) => ({
    id: r.id,
    title: extractTitle(r),
    url: r.url || "",
  }));
}

export function searchDatabaseRows(
  databaseId: string,
  filter?: Record<string, any>,
): Array<Record<string, any>> {
  const dataSourceId = getDataSourceId(databaseId);
  const endpoint = dataSourceId
    ? `v1/data_sources/${dataSourceId}/query`
    : `v1/databases/${databaseId}/query`;
  const body: any = {};
  if (filter) body.filter = filter;
  const raw = execNtn(
    ["api", endpoint, "--data", JSON.stringify(body)],
    { timeout: NTN_LONG_TIMEOUT },
  );
  const parsed = parseJsonSafe(raw);
  return parsed?.results || [];
}

function parseJsonSafe(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractTitle(page: any): string {
  const props = page.properties || {};
  for (const value of Object.values(props)) {
    const v = value as any;
    if (v?.type === "title" && v?.title?.length) {
      return v.title.map((t: any) => t.plain_text || t.text?.content || "").join("");
    }
  }
  return "";
}

export function markdownToBlocks(md: string): any[] {
  const lines = md.split("\n");
  const blocks: any[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: line.slice(4) } }] },
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ text: { content: line.slice(2) } }] },
      });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: [{ text: { content: line.slice(2) } }] },
      });
    } else if (line.startsWith("---")) {
      blocks.push({
        object: "block",
        type: "divider",
        divider: {},
      });
    } else if (line.trim()) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: line } }] },
      });
    }
    i++;
  }
  return blocks;
}

export function buildDatabaseProperties(
  schema: Array<{ name: string; type: string; config?: Record<string, any> }>,
): Record<string, any> {
  const props: Record<string, any> = {};
  for (const col of schema) {
    switch (col.type) {
      case "title":
        props[col.name] = { title: {} };
        break;
      case "rich_text":
        props[col.name] = { rich_text: {} };
        break;
      case "select":
        props[col.name] = { select: col.config || { options: [] } };
        break;
      case "date":
        props[col.name] = { date: {} };
        break;
      case "number":
        props[col.name] = { number: col.config || { format: "number" } };
        break;
      case "url":
        props[col.name] = { url: {} };
        break;
      case "checkbox":
        props[col.name] = { checkbox: {} };
        break;
      default:
        props[col.name] = { rich_text: {} };
    }
  }
  return props;
}

export const TASKS_DB_SCHEMA = [
  { name: "Name", type: "title" },
  { name: "Status", type: "select", config: { options: [
    { name: "Backlog", color: "gray" },
    { name: "Next", color: "blue" },
    { name: "In Progress", color: "yellow" },
    { name: "Blocked", color: "red" },
    { name: "Done", color: "green" },
  ] } },
  { name: "Project", type: "select", config: { options: [] } },
  { name: "Source", type: "url" },
  { name: "Due", type: "date" },
  { name: "Priority", type: "select", config: { options: [
    { name: "High", color: "red" },
    { name: "Medium", color: "yellow" },
    { name: "Low", color: "gray" },
  ] } },
  { name: "First Seen", type: "date" },
];

export const DECISIONS_DB_SCHEMA = [
  { name: "Decision", type: "title" },
  { name: "Context", type: "rich_text" },
  { name: "Rationale", type: "rich_text" },
  { name: "Project", type: "select", config: { options: [] } },
  { name: "Date", type: "date" },
  { name: "Source Nodes", type: "rich_text" },
];

export const BRIEFS_DB_SCHEMA = [
  { name: "Date", type: "title" },
  { name: "One Thing Today", type: "rich_text" },
  { name: "Friction Count", type: "number", config: { format: "number" } },
];
