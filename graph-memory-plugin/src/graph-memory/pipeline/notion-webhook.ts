import crypto from "crypto";
import http from "http";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { readNotionSyncState, writeNotionSyncState } from "./notion-sync.js";
import { getPage } from "./notion-cli.js";
import {
  getProjectWorkingStatePath,
} from "../working-files.js";
import { addNotionPickupItem } from "../project-working.js";
import { detectNewNotionTasks } from "./notion-inbound.js";
import { searchDatabaseRows } from "./notion-cli.js";
import { enqueueJob } from "./job-queue.js";
import { NotionInboundTriagePayload } from "./job-schema.js";

const TRIAGE_WORTHY_EVENTS = new Set([
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.moved",
  "comment.created",
]);

export interface WebhookEvent {
  id: string;
  type: string;
  timestamp: string;
  entity: { type: string; id: string };
  data?: Record<string, unknown>;
  authors?: Array<{ id: string; type: string }>;
}

interface WebhookDebounceState {
  lastProcessedAt: Record<string, number>;
}

const DEBOUNCE_SHORT_MS = 30_000;
const DEBOUNCE_LONG_MS = 5 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_EVENTS = 60;

let debounceState: WebhookDebounceState = { lastProcessedAt: {} };
let rateLimitWindow: { count: number; windowStart: number } = { count: 0, windowStart: Date.now() };
let server: http.Server | null = null;

export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const sigHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  try {
    const sigBuffer = Buffer.from(sigHex, "utf-8");
    const expectedBuffer = Buffer.from(expected, "utf-8");
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function getVerificationToken(): string {
  const tokenPath = path.join(CONFIG.paths.graphRoot, ".notion-webhook-token");
  try {
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {}
  return CONFIG.notionSync.webhookSecret || "";
}

export function isRateLimited(): boolean {
  const now = Date.now();
  if (now - rateLimitWindow.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindow = { count: 0, windowStart: now };
  }
  rateLimitWindow.count++;
  return rateLimitWindow.count > RATE_LIMIT_MAX_EVENTS;
}

export function isDebounced(pageId: string, eventType: string): boolean {
  const key = `${pageId}:${eventType}`;
  const lastAt = debounceState.lastProcessedAt[key];
  if (!lastAt) return false;
  const elapsed = Date.now() - lastAt;
  const threshold = eventType === "comment.created" ? DEBOUNCE_SHORT_MS : DEBOUNCE_LONG_MS;
  return elapsed < threshold;
}

export function markProcessed(pageId: string, eventType: string): void {
  const key = `${pageId}:${eventType}`;
  debounceState.lastProcessedAt[key] = Date.now();

  const cutoff = Date.now() - DEBOUNCE_LONG_MS * 2;
  for (const [k, v] of Object.entries(debounceState.lastProcessedAt)) {
    if (v < cutoff) delete debounceState.lastProcessedAt[k];
  }
}

export function resolveNotionKeyForPageId(state: ReturnType<typeof readNotionSyncState>, pageId: string): string | null {
  for (const [key, ps] of Object.entries(state.pages)) {
    if (ps.pageId === pageId) return key;
  }
  for (const [key, rs] of Object.entries(state.rows)) {
    if (rs.pageId === pageId) return key;
  }
  return null;
}

function queueTriageEvent(
  event: WebhookEvent,
  pageId: string,
  notionKey: string | null,
): void {
  const authors = (event.authors || []).map(a => a.type).join(",");
  const isBot = (event.authors || []).some(a => a.type === "bot" || a.type === "scheduled_bot");
  if (isBot) return;

  const parentInfo = event.data?.parent as { id?: string; type?: string } | undefined;
  const timeWindow = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();

  const triagePayload: NotionInboundTriagePayload = {
    reason: "webhook",
    events: [{
      eventType: event.type,
      pageId,
      notionKey,
      authors: event.authors || [],
      parentType: parentInfo?.type,
    }],
    date: new Date().toISOString().slice(0, 10),
  };

  const idempotencyKey = `triage:${pageId}:${event.type}:${timeWindow}`;

  const { job, created } = enqueueJob({
    type: "notion_inbound_triage",
    payload: triagePayload,
    triggerSource: "notion-webhook",
    idempotencyKey,
  });

  if (created) {
    activityBus.log("notion-webhook:triage", `Queued triage for ${event.type} on ${notionKey || pageId}`, {
      jobId: job.id,
      eventType: event.type,
      pageId,
      notionKey: notionKey || "untracked",
    });
  }
}

export function handleWebhookEvent(event: WebhookEvent): { status: number; message: string } {
  const secret = CONFIG.notionSync.webhookSecret || getVerificationToken();
  if (!secret) {
    return { status: 503, message: "Webhook not configured" };
  }

  if (!CONFIG.notionSync.enabled) {
    return { status: 503, message: "Notion sync disabled" };
  }

  if (isRateLimited()) {
    return { status: 429, message: "Rate limited" };
  }

  const pageId = event.entity?.id;
  if (!pageId) {
    return { status: 400, message: "Missing entity ID" };
  }

  const eventType = event.type;
  if (isDebounced(pageId, eventType)) {
    return { status: 200, message: "Debounced" };
  }

  markProcessed(pageId, eventType);

  const state = readNotionSyncState();
  const notionKey = resolveNotionKeyForPageId(state, pageId);

  const authors = (event.authors || []).map(a => a.type).join(",");
  const parentInfo = event.data?.parent as { id?: string; type?: string } | undefined;

  try {
    switch (eventType) {
      case "page.content_updated":
      case "page.properties_updated":
        if (notionKey) handleContentUpdate(state, notionKey, pageId);
        break;

      case "page.created":
        handlePageCreated(state, pageId);
        break;

      case "page.deleted":
        handlePageDeleted(state, pageId, notionKey);
        break;

      case "page.undeleted":
        handlePageUndeleted(state, pageId, notionKey);
        break;

      case "page.moved":
        activityBus.log("notion-webhook:content-update", `Page moved: ${notionKey || pageId}`, {
          notionKey: notionKey || "untracked", pageId, newParent: parentInfo?.id || "unknown",
        });
        if (notionKey) handleContentUpdate(state, notionKey, pageId);
        break;

      case "page.locked":
      case "page.unlocked":
        activityBus.log("notion-webhook:content-update", `${eventType}: ${notionKey || pageId}`, {
          notionKey: notionKey || "untracked", pageId,
        });
        break;

      case "database.created":
      case "data_source.created":
        handleDataSourceEvent(state, pageId);
        break;

      case "database.deleted":
      case "data_source.deleted":
        handleDatabaseDeleted(state, pageId);
        break;

      case "database.undeleted":
      case "data_source.undeleted":
        handleDataSourceEvent(state, pageId);
        break;

      case "database.moved":
      case "data_source.moved":
      case "database.content_updated":
      case "data_source.content_updated":
      case "database.schema_updated":
      case "data_source.schema_updated":
        activityBus.log("notion-webhook:content-update", `${eventType}: ${pageId}`, { pageId });
        handleDataSourceEvent(state, pageId);
        break;

      case "comment.created":
        if (notionKey) handleCommentCreated(state, notionKey, pageId);
        break;

      case "comment.updated":
      case "comment.deleted":
        activityBus.log("notion-webhook:comment", `${eventType}: ${notionKey || pageId}`, {
          notionKey: notionKey || "untracked", pageId,
        });
        break;
    }
  } catch (err: any) {
    activityBus.log("notion-webhook:error", `Webhook handler failed: ${err.message}`, {
      eventType,
      pageId,
      notionKey: notionKey || "unknown",
    });
    return { status: 500, message: "Internal error" };
  }

  if (TRIAGE_WORTHY_EVENTS.has(eventType)) {
    try {
      queueTriageEvent(event, pageId, notionKey);
    } catch (err: any) {
      activityBus.log("notion-webhook:error", `Triage queue failed: ${err.message}`, {
        eventType,
        pageId,
      });
    }
  }

  return { status: 200, message: "Processed" };
}

function handleContentUpdate(
  state: ReturnType<typeof readNotionSyncState>,
  notionKey: string,
  pageId: string,
): void {
  if (notionKey.startsWith("task:")) {
    const content = getPage(pageId);
    const statusMatch = content.match(/Status["\s:]+(Backlog|Next|In Progress|Blocked|Done)/i);
    if (statusMatch) {
      const newStatus = statusMatch[1];
      const rowState = state.rows[notionKey];
      if (rowState && rowState.status !== newStatus) {
        rowState.status = newStatus;
        writeNotionSyncState(state);

        if (newStatus === "Done" || newStatus === "Next" || newStatus === "In Progress") {
          activityBus.log("notion-webhook:task-update", `Task ${notionKey} status changed to ${newStatus}`, {
            notionKey, newStatus, pageId,
          });
        }
      }
    }
  } else {
    activityBus.log("notion-webhook:content-update", `Content updated for ${notionKey}`, {
      notionKey, pageId,
    });
  }
}

function handlePageDeleted(
  state: ReturnType<typeof readNotionSyncState>,
  pageId: string,
  notionKey: string | null,
): void {
  if (!notionKey) return;

  if (notionKey.startsWith("task:")) {
    const rowState = state.rows[notionKey];
    if (rowState) {
      rowState.status = "Deleted";
      writeNotionSyncState(state);
    }
  } else if (state.pages[notionKey]) {
    state.pages[notionKey].deleted = true;
    writeNotionSyncState(state);
  }

  activityBus.log("notion-webhook:content-update", `Page deleted: ${notionKey}`, {
    notionKey, pageId,
  });
}

function handlePageUndeleted(
  state: ReturnType<typeof readNotionSyncState>,
  pageId: string,
  notionKey: string | null,
): void {
  if (!notionKey) return;

  if (notionKey.startsWith("task:") && state.rows[notionKey]) {
    delete state.rows[notionKey].deleted;
    writeNotionSyncState(state);
  } else if (state.pages[notionKey]) {
    delete state.pages[notionKey].deleted;
    writeNotionSyncState(state);
  }

  activityBus.log("notion-webhook:content-update", `Page undeleted: ${notionKey}`, {
    notionKey, pageId,
  });
}

function handleDatabaseDeleted(
  state: ReturnType<typeof readNotionSyncState>,
  entityId: string,
): void {
  for (const [dbKey, db] of Object.entries(state.databases)) {
    if (db.id === entityId) {
      activityBus.log("notion-webhook:content-update", `Database deleted: ${dbKey}`, {
        databaseId: entityId,
      });
      break;
    }
  }
}

function handleCommentCreated(
  state: ReturnType<typeof readNotionSyncState>,
  notionKey: string,
  pageId: string,
): void {
  activityBus.log("notion-webhook:comment", `New comment on ${notionKey}`, {
    notionKey, pageId,
  });
}

function handlePageCreated(
  state: ReturnType<typeof readNotionSyncState>,
  pageId: string,
): void {
  const tasksDb = state.databases.tasks;
  if (!tasksDb?.id) return;

  const newTasks = detectNewNotionTasks(state);
  if (newTasks.length > 0) {
    writeNotionSyncState(state);
    for (const task of newTasks) {
      const proj = task.project || "";
      if (proj) {
        addNotionPickupItem(proj, `[Notion] New task: ${task.name} (${task.status})`);
      }
      activityBus.log("notion-webhook:task-update", `New task created: ${task.name}`, {
        pageId: task.pageId, status: task.status, project: proj,
      });
    }
  }
}

function handleDataSourceEvent(
  state: ReturnType<typeof readNotionSyncState>,
  entityId: string,
): void {
  const tasksDb = state.databases.tasks;
  if (!tasksDb?.id) return;

  const newTasks = detectNewNotionTasks(state);
  if (newTasks.length > 0) {
    writeNotionSyncState(state);
    for (const task of newTasks) {
      const proj = task.project || "";
      if (proj) {
        addNotionPickupItem(proj, `[Notion] New task: ${task.name} (${task.status})`);
      }
      activityBus.log("notion-webhook:task-update", `New task via data source: ${task.name}`, {
        pageId: task.pageId, status: task.status, project: proj,
      });
    }
  }
}

export function startWebhookServer(port: number = 3100): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve();
      return;
    }

    server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/notion-webhook") {
        res.writeHead(404).end();
        return;
      }

      const secret = CONFIG.notionSync.webhookSecret;
      const signature = req.headers["x-notion-signature"] as string || "";

      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);

          if (parsed.verification_token) {
            const token = String(parsed.verification_token);
            const tokenPath = path.join(CONFIG.paths.graphRoot, ".notion-webhook-token");
            fs.writeFileSync(tokenPath, token, "utf-8");
            activityBus.log("notion-webhook:started", `Webhook verification received, token saved to ${tokenPath}`, {
              token_prefix: token.slice(0, 12),
            });
            res.writeHead(200, { "Content-Type": "application/json" }).end(body);
            return;
          }

          if (secret && !verifyWebhookSignature(body, signature, getVerificationToken())) {
            activityBus.log("notion-webhook:error", `Signature validation failed`, {
              hasSignature: !!signature,
              signaturePrefix: signature ? signature.slice(0, 20) : "",
              hasVerificationToken: !!getVerificationToken(),
              bodyPrefix: body.slice(0, 200),
            });
            res.writeHead(401).end("Invalid signature");
            return;
          }

          const event = parsed as WebhookEvent;
          const result = handleWebhookEvent(event);
          activityBus.log("notion-webhook:event", `Webhook ${event.type} → ${result.status} ${result.message}`, {
            eventType: event.type,
            entityId: event.entity?.id,
            status: result.status,
          });
          res.writeHead(result.status, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        } catch (err: any) {
          activityBus.log("notion-webhook:error", `Webhook parse error: ${err?.message || String(err)}`, {
            body_preview: body.slice(0, 200),
            signature_present: !!signature,
          });
          res.writeHead(400).end("Invalid JSON");
        }
      });
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        activityBus.log("notion-webhook:warn", `Port ${port} in use, webhook server not started`);
        resolve();
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      activityBus.log("notion-webhook:started", `Webhook server listening on port ${port}`);
      resolve();
    });
  });
}

export function stopWebhookServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
