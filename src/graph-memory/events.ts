import { EventEmitter } from "events";

export type ActivityEventType =
  | "session:start"
  | "session:end"
  | "session:idle_warning"
  | "buffer:message_added"
  | "buffer:threshold_reached"
  | "buffer:cleared"
  | "scribe:fired"
  | "scribe:complete"
  | "scribe:error"
  | "librarian:start"
  | "librarian:complete"
  | "librarian:error"
  | "dreamer:start"
  | "dreamer:complete"
  | "dreamer:error"
  | "graph:node_created"
  | "graph:node_updated"
  | "graph:node_archived"
  | "graph:map_regenerated"
  | "graph:priors_updated"
  | "git:commit"
  | "git:push"
  | "git:error"
  | "system:init"
  | "system:error";

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
    // Also log to server console for debugging
    const prefix = type.split(":")[0].toUpperCase().padEnd(10);
    console.log(`[${event.timestamp}] ${prefix} ${message}`);
  }
}

// Singleton event bus
export const activityBus = new ActivityBus();
