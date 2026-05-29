import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

export type ToolTracePhase = "pre" | "post";
export type ToolAccessKind = "read" | "write" | "search" | "execute" | "mcp" | "unknown";
export type AssistantTraceKind = "intermediate" | "final";

export interface ToolTraceEvent {
  type: `tool_${ToolTracePhase}`;
  timestamp: string;
  sessionId: string;
  project?: string;
  cwd?: string;
  toolName: string;
  accessKind: ToolAccessKind;
  matcher?: string;
  success?: boolean | null;
  durationMs?: number | null;
  commandPreview?: string | null;
  inputPreview?: unknown;
  argsPreview?: Record<string, unknown> | null;
  targetPaths?: string[];
  outputPreview?: unknown;
  errorPreview?: unknown;
  rawKeys: string[];
}

export interface AssistantTraceEvent {
  type: "assistant_text";
  timestamp: string;
  sessionId: string;
  project?: string;
  cwd?: string;
  kind: AssistantTraceKind;
  text: string;
  assistantUuid?: string;
  parentUuid?: string | null;
  source: "claude_session_log" | "stop_hook";
  transcriptPath?: string | null;
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

export function getSessionTraceDir(sessionId: string): string {
  return path.join(CONFIG.paths.sessionTraces, sanitizeSessionId(sessionId));
}

export function getToolTracePath(sessionId: string): string {
  return path.join(getSessionTraceDir(sessionId), "tool-trace.jsonl");
}

export function getAssistantTracePath(sessionId: string): string {
  return path.join(getSessionTraceDir(sessionId), "assistant-trace.jsonl");
}

export function getConversationLogPath(sessionId: string): string {
  return path.join(CONFIG.paths.buffer, `conversation-${sanitizeSessionId(sessionId)}.jsonl`);
}

function ensureSessionTraceDir(sessionId: string): void {
  const dir = getSessionTraceDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isSecretKey(key: string): boolean {
  return /(api.?key|token|secret|password|authorization|cookie|session)/i.test(key);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") {
    return value.length > 280 ? `${value.slice(0, 280)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(entries.map(([key, child]) => [
      key,
      isSecretKey(key) ? "[redacted]" : sanitizeValue(child, depth + 1),
    ]));
  }
  return String(value);
}

function extractToolName(input: Record<string, unknown>): string {
  const candidates = [
    input.tool_name,
    input.toolName,
    input.name,
    typeof input.tool === "object" && input.tool ? (input.tool as Record<string, unknown>).name : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "unknown";
}

function classifyToolAccess(toolName: string): ToolAccessKind {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.startsWith("mcp__")) return "mcp";
  if (["read", "view", "open", "cat"].includes(normalized)) return "read";
  if (["write", "edit", "multiedit", "apply_patch"].includes(normalized)) return "write";
  if (["grep", "glob", "find", "search"].includes(normalized)) return "search";
  if (["bash", "exec", "exec_command", "sh", "shell"].includes(normalized)) return "execute";
  return "unknown";
}

function getToolArgs(input: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? input.params;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return null;
}

function maybePushTarget(targets: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /\.[a-z0-9]{1,6}$/i.test(trimmed) ||
    trimmed.includes("/")
  ) {
    targets.add(trimmed);
  }
}

function collectTargetsFromValue(targets: Set<string>, value: unknown, depth = 0): void {
  if (depth > 3 || value == null) return;
  if (typeof value === "string") {
    maybePushTarget(targets, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      collectTargetsFromValue(targets, item, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (/(path|file|files|from|to|source|destination|dest|dir|directory|cwd)/i.test(key)) {
        collectTargetsFromValue(targets, child, depth + 1);
      }
    }
  }
}

function extractCommandPreview(input: Record<string, unknown>, args: Record<string, unknown> | null): string | null {
  const candidates = [
    args?.command,
    args?.cmd,
    input.command,
    input.cmd,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 280);
    }
  }
  return null;
}

function extractTargetPaths(input: Record<string, unknown>, args: Record<string, unknown> | null): string[] {
  const targets = new Set<string>();
  if (args) {
    collectTargetsFromValue(targets, args);
  }

  const commandPreview = extractCommandPreview(input, args);
  if (commandPreview) {
    const pathMatches = commandPreview.match(/(?:\/|\.\.?\/)[^\s"'`]+/g) || [];
    for (const match of pathMatches.slice(0, 12)) {
      targets.add(match);
    }
  }

  return [...targets].slice(0, 20);
}

export function appendToolTrace(
  sessionId: string,
  phase: ToolTracePhase,
  input: Record<string, unknown>,
  options: { project?: string; cwd?: string }
): void {
  ensureSessionTraceDir(sessionId);

  const successValue = input.success;
  const toolName = extractToolName(input);
  const success = typeof successValue === "boolean"
    ? successValue
    : typeof input.error === "undefined"
      ? null
      : false;
  const args = getToolArgs(input);
  const commandPreview = extractCommandPreview(input, args);
  const targetPaths = extractTargetPaths(input, args);

  const event: ToolTraceEvent = {
    type: `tool_${phase}`,
    timestamp: new Date().toISOString(),
    sessionId,
    project: options.project,
    cwd: options.cwd,
    toolName,
    accessKind: classifyToolAccess(toolName),
    matcher: typeof input.matcher === "string" ? input.matcher : undefined,
    success,
    durationMs: typeof input.duration_ms === "number"
      ? input.duration_ms
      : typeof input.durationMs === "number"
        ? input.durationMs
        : null,
    commandPreview,
    inputPreview: sanitizeValue(
      input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? input.params
    ),
    argsPreview: args ? sanitizeValue(args) as Record<string, unknown> : null,
    targetPaths,
    outputPreview: phase === "post"
      ? sanitizeValue(input.tool_response ?? input.toolResponse ?? input.output ?? input.result)
      : undefined,
    errorPreview: typeof input.error !== "undefined" ? sanitizeValue(input.error) : undefined,
    rawKeys: Object.keys(input).sort(),
  };

  fs.appendFileSync(getToolTracePath(sessionId), `${JSON.stringify(event)}\n`);
}

function buildAssistantTraceIdentity(event: AssistantTraceEvent): string {
  if (event.assistantUuid) {
    return `uuid:${event.assistantUuid}`;
  }
  return `fallback:${event.timestamp}:${event.kind}:${event.text}`;
}

function readExistingAssistantTraceIds(sessionId: string): Set<string> {
  const filePath = getAssistantTracePath(sessionId);
  const ids = new Set<string>();
  if (!fs.existsSync(filePath)) return ids;

  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AssistantTraceEvent;
      ids.add(buildAssistantTraceIdentity(parsed));
    } catch {
      continue;
    }
  }

  return ids;
}

export function appendAssistantTraceEvents(
  sessionId: string,
  events: AssistantTraceEvent[]
): { appended: number } {
  if (events.length === 0) {
    return { appended: 0 };
  }

  ensureSessionTraceDir(sessionId);
  const filePath = getAssistantTracePath(sessionId);
  const existingIds = readExistingAssistantTraceIds(sessionId);

  let appended = 0;
  for (const event of events) {
    const identity = buildAssistantTraceIdentity(event);
    if (existingIds.has(identity)) {
      continue;
    }
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
    existingIds.add(identity);
    appended += 1;
  }

  return { appended };
}
