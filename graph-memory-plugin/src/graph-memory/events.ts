import { EventEmitter } from "events";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG } from "./config.js";

const ACTIVITY_LOG = join(CONFIG.paths.logs, "activity.jsonl");
let logDirReady = false;

export type ActivityEventType =
  | "session:start"
  | "session:end"
  | "session:idle_warning"
  | "buffer:message_added"
  | "buffer:threshold_reached"
  | "buffer:cleared"
  | "scribe:fired"
  | "scribe:pending"
  | "scribe:complete"
  | "scribe:error"
  | "observer:fired"
  | "observer:pending"
  | "observer:complete"
  | "observer:warnings"
  | "observer:error"
  | "librarian:start"
  | "librarian:complete"
  | "librarian:error"
  | "auditor:start"
  | "auditor:complete"
  | "auditor:error"
  | "dreamer:start"
  | "dreamer:complete"
  | "dreamer:error"
  | "graph:node_created"
  | "graph:node_updated"
  | "graph:node_merged"
  | "graph:node_archived"
  | "graph:map_regenerated"
  | "graph:soma_generated"
  | "graph:working_generated"
  | "graph:dreams_generated"
  | "graph:priors_updated"
  | "graph:priors_truncated"
  | "graph:priors_capped"
  | "git:commit"
  | "git:push"
  | "git:error"
  | "mechanical:start"
  | "mechanical:complete"
  | "mechanical:error"
  | "graph:node_relocated"
  | "graph:node_restructured"
  | "graph:node_compacted"
  | "graph:dream_linked"
  | "graph:dream_capped"
  | "graph:dream_reinforced"
  | "graph:archive_index_rebuilt"
  | "graph:node_resurfaced"
  | "skillforge:scored"
  | "skillforge:job_queued"
  | "skillforge:complete"
  | "skillforge:error"
  | "skillforge:drift_detected"
  | "skillforge:refresh"
  | "skillforge:refresh_error"
  | "system:init"
  | "system:info"
  | "system:error"
  | "daemon:decay"
  | "notion-sync:start"
  | "notion-sync:complete"
  | "notion-sync:error"
  | "notion-inbound:start"
  | "notion-inbound:complete"
  | "notion-inbound:error"
  | "notion-merge:start"
  | "notion-merge:complete"
  | "notion-merge:error";

export interface ActivityEvent {
  type: ActivityEventType;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

class ActivityBus extends EventEmitter {
  emit(event: "activity", data: ActivityEvent): boolean;
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: "activity", listener: (data: ActivityEvent) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  log(type: ActivityEventType, message: string, details?: Record<string, unknown>) {
    const event: ActivityEvent = {
      type,
      message,
      details,
      timestamp: new Date().toISOString(),
    };
    this.emit("activity", event);
    // Append to JSONL log for dashboard consumption
    try {
      if (!logDirReady) {
        mkdirSync(CONFIG.paths.logs, { recursive: true });
        logDirReady = true;
      }
      appendFileSync(ACTIVITY_LOG, JSON.stringify(event) + "\n");
    } catch {}
    // Also log to server console for debugging
    const prefix = type.split(":")[0].toUpperCase().padEnd(10);
    console.error(`[${event.timestamp}] ${prefix} ${message}`);
  }
}

// Singleton event bus
export const activityBus = new ActivityBus();
