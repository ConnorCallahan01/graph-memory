import { execFileSync, execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
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
  workspaceSelected?: boolean;
  error?: string;
}

const NTN_TIMEOUT = 30_000;
const NTN_LONG_TIMEOUT = 120_000;

let _cachedNtnToken: string | undefined;

function getNtnToken(): string | undefined {
  if (_cachedNtnToken) return _cachedNtnToken;
  if (process.env.NOTION_API_TOKEN) {
    _cachedNtnToken = process.env.NOTION_API_TOKEN;
    return _cachedNtnToken;
  }
  try {
    const configDir = process.env.HOME
      ? join(process.env.HOME, ".config", "notion")
      : undefined;
    if (!configDir) return undefined;
    const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf-8"));
    if (auth?.token) {
      _cachedNtnToken = auth.token;
      return _cachedNtnToken;
    }
  } catch {}
  return undefined;
}

function ntnEnv(): NodeJS.ProcessEnv {
  const token = getNtnToken();
  return token ? { ...process.env, NOTION_API_TOKEN: token } : process.env as NodeJS.ProcessEnv;
}

function execNtn(args: string[], options?: { input?: string; timeout?: number }): string {
  const timeout = options?.timeout ?? NTN_TIMEOUT;
  try {
    return execFileSync("ntn", args, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
      env: ntnEnv(),
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const msg = stderr.trim() || err.message;
    throw new Error(`ntn ${args.join(" ")} failed: ${msg}`);
  }
}

class NtnApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status === 503;
  }
}

export { NtnApiError };

export function execNtnWithRetry(
  args: string[],
  options?: { input?: string; timeout?: number },
  maxRetries: number = 3,
): string {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return execNtn(args, options);
    } catch (err: any) {
      lastError = err;
      const status = extractStatusFromError(err);
      if (status !== 429 && status !== 503) throw err;

      if (attempt < maxRetries) {
        const baseDelay = 1000 * Math.pow(2, attempt);
        const jitter = (Math.random() - 0.5) * 400;
        const delay = Math.max(200, baseDelay + jitter);
        execSync(`sleep ${delay / 1000}`, { timeout: delay + 1000 });
      }
    }
  }
  throw lastError;
}

function extractStatusFromError(err: any): number {
  const msg = err?.message || "";
  const match = msg.match(/\b(429|503|400|401|403|404)\b/);
  return match ? parseInt(match[1], 10) : 0;
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

export function checkNtnReady(): NtnCheckResult {
  const installed = checkNtnInstalled();
  if (!installed) {
    return { installed: false, authenticated: false, workspaceSelected: false, error: "ntn is not installed" };
  }

  try {
    execNtn(["api", "v1/users/me", "-X", "GET"]);
    return { installed: true, authenticated: true, workspaceSelected: true };
  } catch (err: any) {
    const error = err?.message || String(err);
    return {
      installed: true,
      authenticated: !/not authenticated|login/i.test(error),
      workspaceSelected: !/no workspace selected|workspace/i.test(error),
      error,
    };
  }
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
      body.markdown = bodyContent;
    }
  }

  const raw = execNtnWithRetry(["api", "v1/pages", "--data", JSON.stringify(body)], {
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
  execNtnWithRetry(
    ["pages", "update", pageId],
    { input: markdown, timeout: NTN_LONG_TIMEOUT },
  );
}

export function getPage(pageId: string): string {
  return execNtn(["pages", "get", pageId], { timeout: NTN_TIMEOUT });
}

export function archivePage(pageId: string): void {
  execNtnWithRetry(["api", `v1/pages/${pageId}`, "-X", "PATCH", "in_trash:=true"]);
}

export function listChildBlocks(pageId: string): any[] {
  const raw = execNtnWithRetry(["api", `v1/blocks/${pageId}/children`, "-X", "GET"], {
    timeout: NTN_LONG_TIMEOUT,
  });
  const parsed = parseJsonSafe(raw);
  return parsed?.results || [];
}

export function appendBlocks(pageId: string, blocks: any[]): void {
  if (blocks.length === 0) return;
  const sanitized = blocks.map(stripReadOnlyFields);
  const body = JSON.stringify({ children: sanitized });
  execNtnWithRetry(
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
  const raw = execNtnWithRetry(["api", "v1/databases", "--data", JSON.stringify(body)], {
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
  execNtnWithRetry(
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
  target?: string,
): NotionCreatePageResult {
  const normalized = normalizeProperties(properties, titleKey, target);
  const body: any = {
    parent: { type: "database_id", database_id: databaseId },
    properties: normalized,
  };
  if (childMarkdown) {
    body.markdown = childMarkdown;
  }
  const raw = execNtnWithRetry(["api", "v1/pages", "--data", JSON.stringify(body)], {
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
  target?: string,
): void {
  const normalized = normalizeProperties(properties, titleKey, target);
  execNtnWithRetry(
    ["api", `v1/pages/${pageId}`, "-X", "PATCH", "--data", JSON.stringify({ properties: normalized })],
    { timeout: NTN_TIMEOUT },
  );
}

function normalizeProperties(
  props: Record<string, any>,
  titleKey?: string,
  target?: string,
): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (key === titleKey) {
        normalized[key] = { title: [{ type: "text", text: { content: value } }] };
      } else if (key === "Status" && target === "briefs") {
        if (value === "") continue;
        normalized[key] = { status: { name: value } };
      } else if (["Status", "Priority", "Category"].includes(key)) {
        if (value === "") continue;
        normalized[key] = { select: { name: value } };
      } else if (["Date", "Due", "First Seen", "Last Active", "Last Updated", "Brief Date", "Created"].includes(key)) {
        normalized[key] = { date: { start: value } };
      } else {
        normalized[key] = { rich_text: [{ type: "text", text: { content: value } }] };
      }
    } else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "string") {
        const multiSelectKeys = ["Today's Projects"];
        if (multiSelectKeys.includes(key)) {
          normalized[key] = { multi_select: value.map((v: string) => ({ name: v })) };
        } else {
          normalized[key] = { rich_text: [{ type: "text", text: { content: value.join(", ") } }] };
        }
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
  const raw = execNtnWithRetry(["api", "v1/search", `query==${query}`, "page_size:=10"]);
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
  const raw = execNtnWithRetry(
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

export function markdownToRichText(line: string): any[] {
  const richText: any[] = [];
  let remaining = line;
  let currentAnnotations: any = {};

  const patterns: Array<{ regex: RegExp; type: "bold" | "italic" | "code" | "strikethrough" | "link" }> = [
    { regex: /\*\*(.+?)\*\*/g, type: "bold" },
    { regex: /(?<!\*)\*([^*]+?)\*(?!\*)/g, type: "italic" },
    { regex: /`([^`]+?)`/g, type: "code" },
    { regex: /~~(.+?)~~/g, type: "strikethrough" },
  ];

  let pos = 0;
  const segments: Array<{ start: number; end: number; text: string; annotations: any; href?: string }> = [];
  let safety = 0;

  while (pos < remaining.length && safety < 100) {
    safety++;
    let earliest: { index: number; length: number; text: string; annotations: any; href?: string } | null = null;

    for (const { regex, type } of patterns) {
      regex.lastIndex = pos;
      const match = regex.exec(remaining);
      if (match && match.index === pos) {
        const ann = { ...currentAnnotations };
        if (type === "bold") ann.bold = true;
        else if (type === "italic") ann.italic = true;
        else if (type === "code") ann.code = true;
        else if (type === "strikethrough") ann.strikethrough = true;

        if (!earliest || match.index < earliest.index) {
          earliest = { index: match.index, length: match[0].length, text: match[1], annotations: ann };
        }
      }
    }

    const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/g;
    linkMatch.lastIndex = pos;
    const lm = linkMatch.exec(remaining);
    if (lm && lm.index === pos && (!earliest || lm.index <= earliest.index)) {
      earliest = { index: lm.index, length: lm[0].length, text: lm[1], annotations: { ...currentAnnotations }, href: lm[2] };
    }

    if (earliest && earliest.index === pos) {
      segments.push({ start: earliest.index, end: earliest.index + earliest.length, text: earliest.text, annotations: earliest.annotations, href: earliest.href });
      pos += earliest.length;
    } else {
      let nextSpecial = remaining.length;
      for (const { regex } of patterns) {
        regex.lastIndex = pos + 1;
        const m = regex.exec(remaining);
        if (m && m.index < nextSpecial) nextSpecial = m.index;
      }
      linkMatch.lastIndex = pos + 1;
      const nl = linkMatch.exec(remaining);
      if (nl && nl.index < nextSpecial) nextSpecial = nl.index;

      const plainText = remaining.slice(pos, nextSpecial);
      if (plainText) {
        segments.push({ start: pos, end: nextSpecial, text: plainText, annotations: { ...currentAnnotations } });
      }
      pos = nextSpecial;
    }
  }

  for (const seg of segments) {
    if (!seg.text) continue;
    const rt: any = {
      type: "text",
      text: { content: seg.text },
      annotations: { ...seg.annotations, color: "default" },
    };
    if (seg.href) {
      rt.text = { content: seg.text, link: { url: seg.href } };
      rt.href = seg.href;
    }
    richText.push(rt);
  }

  if (richText.length === 0 && line.length > 0) {
    richText.push({ type: "text", text: { content: line }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } });
  }

  return richText.slice(0, 100);
}

export function markdownToBlocks(md: string): any[] {
  const lines = md.split("\n");
  const blocks: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.match(/^```(\w*)/)) {
      const lang = line.match(/^```(\w*)/)?.[1] || "plain text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }],
          language: mapLanguage(lang),
        },
      });
      i++;
      continue;
    }

    if (line.match(/^######\s+/)) {
      blocks.push({
        object: "block", type: "heading_6",
        heading_6: { rich_text: markdownToRichText(line.slice(7)) },
      });
    } else if (line.match(/^#####\s+/)) {
      blocks.push({
        object: "block", type: "heading_5",
        heading_5: { rich_text: markdownToRichText(line.slice(6)) },
      });
    } else if (line.match(/^####\s+/)) {
      blocks.push({
        object: "block", type: "heading_4",
        heading_4: { rich_text: markdownToRichText(line.slice(5)) },
      });
    } else if (line.match(/^###\s+/)) {
      blocks.push({
        object: "block", type: "heading_3",
        heading_3: { rich_text: markdownToRichText(line.slice(4)) },
      });
    } else if (line.match(/^##\s+/)) {
      blocks.push({
        object: "block", type: "heading_2",
        heading_2: { rich_text: markdownToRichText(line.slice(3)) },
      });
    } else if (line.match(/^#\s+/)) {
      blocks.push({
        object: "block", type: "heading_1",
        heading_1: { rich_text: markdownToRichText(line.slice(2)) },
      });
    } else if (line.match(/^\d+\.\s+/)) {
      const numberedItems: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        numberedItems.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      for (const item of numberedItems) {
        blocks.push({
          object: "block", type: "numbered_list_item",
          numbered_list_item: { rich_text: markdownToRichText(item) },
        });
      }
      continue;
    } else if (line.match(/^[-*]\s+\[[ x]\]\s+/)) {
      const checked = line.match(/\[x\]/i) !== null;
      const text = line.replace(/^[-*]\s+\[[ x]\]\s+/i, "");
      blocks.push({
        object: "block", type: "to_do",
        to_do: { rich_text: markdownToRichText(text), checked },
      });
    } else if (line.match(/^[-*]\s+/)) {
      const bulletItems: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/) && !lines[i].match(/^[-*]\s+\[[ x]\]/)) {
        bulletItems.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      for (const item of bulletItems) {
        blocks.push({
          object: "block", type: "bulleted_list_item",
          bulleted_list_item: { rich_text: markdownToRichText(item) },
        });
      }
      continue;
    } else if (line.match(/^>\s?/)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({
        object: "block", type: "quote",
        quote: { rich_text: markdownToRichText(quoteLines.join("\n")) },
      });
      continue;
    } else if (line.match(/^---+/)) {
      blocks.push({
        object: "block", type: "divider", divider: {},
      });
    } else if (line.match(/^\|/)) {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].match(/^\|/)) {
        if (!lines[i].match(/^\|[\s-:|]+\|$/)) {
          const cells = lines[i].split("|").filter((c, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());
          tableRows.push(cells);
        }
        i++;
      }
      if (tableRows.length > 0) {
        const colCount = tableRows[0].length;
        const hasRowWidth = colCount > 0;
        const tableBlock: any = {
          object: "block", type: "table",
          table: {
            table_width: colCount,
            has_row_header: true,
            has_column_header: false,
            children: tableRows.map(row => ({
              object: "block", type: "table_row",
              table_row: {
                cells: Array.from({ length: colCount }, (_, ci) =>
                  [{ type: "text", text: { content: row[ci] || "" } }]
                ),
              },
            })),
          },
        };
        blocks.push(tableBlock);
      }
      continue;
    } else if (line.trim()) {
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: markdownToRichText(line) },
      });
    }
    i++;
  }

  return blocks;
}

function mapLanguage(lang: string): string {
  const map: Record<string, string> = {
    js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript",
    py: "python", rb: "ruby", sh: "bash", bash: "bash", zsh: "bash",
    yml: "yaml", yaml: "yaml", json: "json", md: "markdown",
    sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin",
    css: "css", html: "html", xml: "xml", dockerfile: "docker",
    toml: "toml", ini: "ini", diff: "diff", plain: "plain text",
  };
  return map[lang.toLowerCase()] || "plain text";
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
      case "relation":
        props[col.name] = { relation: col.config || {} };
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

export const PROJECTS_DB_SCHEMA = [
  { name: "Name", type: "title" },
  { name: "Status", type: "select", config: { options: [
    { name: "Active", color: "green" },
    { name: "Paused", color: "yellow" },
    { name: "Completed", color: "gray" },
  ] } },
  { name: "Description", type: "rich_text" },
  { name: "Tech Stack", type: "rich_text" },
  { name: "Last Active", type: "date" },
];

export const PATTERNS_DB_SCHEMA = [
  { name: "Name", type: "title" },
  { name: "Category", type: "select", config: { options: [
    { name: "Pattern", color: "blue" },
    { name: "Anti-Pattern", color: "red" },
    { name: "Concept", color: "purple" },
    { name: "Correction", color: "orange" },
    { name: "Decision", color: "green" },
    { name: "Preference", color: "yellow" },
  ] } },
  { name: "Insight", type: "rich_text" },
  { name: "Confidence", type: "number", config: { format: "percent" } },
  { name: "First Seen", type: "date" },
];

export const DREAMS_DB_SCHEMA = [
  { name: "Name", type: "title" },
  { name: "Status", type: "select", config: { options: [
    { name: "Pending", color: "yellow" },
    { name: "Integrated", color: "green" },
    { name: "Archived", color: "gray" },
  ] } },
  { name: "Confidence", type: "number", config: { format: "percent" } },
  { name: "Prediction", type: "rich_text" },
  { name: "Source Nodes", type: "rich_text" },
  { name: "Created", type: "date" },
];

export interface NotionComment {
  id: string;
  createdTime: string;
  lastEditedTime: string;
  text: string;
  createdBy: { id: string; type: string };
}

export function getComments(blockId: string): NotionComment[] {
  const raw = execNtnWithRetry(
    ["api", `v1/comments?block_id=${blockId}`, "-X", "GET"],
    { timeout: NTN_TIMEOUT },
  );
  const parsed = parseJsonSafe(raw);
  if (!parsed?.results) return [];
  return parsed.results.map((c: any) => ({
    id: c.id,
    createdTime: c.created_time,
    lastEditedTime: c.last_edited_time,
    text: (c.rich_text || []).map((rt: any) => rt.plain_text || "").join(""),
    createdBy: c.created_by || { id: "", type: "" },
  }));
}

export function createComment(blockId: string, markdown: string): NotionComment | null {
  const body = {
    parent: { page_id: blockId },
    rich_text: [{ type: "text", text: { content: markdown } }],
  };
  const raw = execNtnWithRetry(
    ["api", "v1/comments", "--data", JSON.stringify(body)],
    { timeout: NTN_TIMEOUT },
  );
  const parsed = parseJsonSafe(raw);
  if (!parsed) return null;
  return {
    id: parsed.id,
    createdTime: parsed.created_time,
    lastEditedTime: parsed.last_edited_time,
    text: (parsed.rich_text || []).map((rt: any) => rt.plain_text || "").join(""),
    createdBy: parsed.created_by || { id: "", type: "" },
  };
}
