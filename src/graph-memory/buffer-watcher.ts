import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { activityBus } from "./events.js";
import { fireScribe, saveScribeResult, type ScribeResult } from "./pipeline/scribe.js";

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  tokenEstimate?: number;
}

/** Farewell patterns — only match standalone messages */
const FAREWELL_RE = /^(thanks|thank you|done|that's it|that's all|bye|goodbye|see you|i'm done|we're done)\s*[.!]?\s*$/i;
const FAREWELL_GRACE_MS = 30_000;

export class BufferWatcher {
  private messageCount = 0;
  private totalSessionMessages = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private sessionActive = false;
  private consolidating = false;
  private sessionId: string = "";
  private scribeCount = 0;
  private summaryChain: string[] = [];
  private scribeQueue: Promise<ScribeResult>[] = [];
  private onSessionEnd?: (signal?: AbortSignal) => Promise<void> | void;
  private onMidSessionRefresh?: () => Promise<void> | void;
  private lastPipelineTime = 0;
  private pipelineAbort: AbortController | null = null;

  constructor() {
    this.ensureBufferDir();
  }

  private ensureBufferDir() {
    const bufferDir = CONFIG.paths.buffer;
    if (!fs.existsSync(bufferDir)) {
      fs.mkdirSync(bufferDir, { recursive: true });
    }
    if (!fs.existsSync(CONFIG.paths.conversationLog)) {
      fs.writeFileSync(CONFIG.paths.conversationLog, "");
    }
  }

  /** Register a callback for when session ends (for librarian triggering) */
  setOnSessionEnd(callback: (signal?: AbortSignal) => Promise<void> | void) {
    this.onSessionEnd = callback;
  }

  /** Register a callback for mid-session refresh (flush + librarian at 200 msgs) */
  setOnMidSessionRefresh(callback: () => Promise<void> | void) {
    this.onMidSessionRefresh = callback;
  }

  /** Append a message to the conversation log */
  appendMessage(entry: ConversationEntry) {
    // Cancel any in-progress consolidation if new message arrives
    if (this.consolidating && this.pipelineAbort) {
      activityBus.log("session:start", "New message during consolidation — aborting pipeline");
      this.pipelineAbort.abort();
    }

    // Auto-start a new session if none is active
    // This handles messages arriving during or after consolidation
    if (!this.sessionActive) {
      activityBus.log("session:start", "Auto-starting new session (message received while inactive)");
      this.startSession();
    }

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(CONFIG.paths.conversationLog, line);

    this.messageCount++;
    this.totalSessionMessages++;

    activityBus.log("buffer:message_added", `Buffer: ${this.messageCount}/${CONFIG.session.scribeInterval} messages (${entry.role})`, {
      role: entry.role,
      bufferCount: this.messageCount,
      totalSession: this.totalSessionMessages,
      contentPreview: entry.content.slice(0, 80) + (entry.content.length > 80 ? "..." : ""),
    });

    // Check scribe threshold
    if (this.messageCount >= CONFIG.session.scribeInterval) {
      this.onThresholdReached();
    }

    // Mid-session refresh at maxSessionMessages
    if (this.totalSessionMessages === CONFIG.session.maxSessionMessages && this.onMidSessionRefresh) {
      activityBus.log("session:idle_warning", `Mid-session refresh at ${this.totalSessionMessages} messages — flushing scribes and running librarian`);
      this.flush()
        .then(() => this.onMidSessionRefresh?.())
        .catch((err) => activityBus.log("system:error", `Mid-session refresh failed: ${err}`));
    }

    // Detect farewell messages — use shortened grace period
    if (entry.role === "user" && FAREWELL_RE.test(entry.content.trim())) {
      activityBus.log("session:end", `Farewell detected: "${entry.content.trim()}" — grace period ${FAREWELL_GRACE_MS / 1000}s`, {
        reason: "farewell",
      });
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.sessionActive && !this.consolidating) {
          activityBus.log("session:end", "Session ended (farewell + grace period)", {
            totalMessages: this.totalSessionMessages,
            reason: "farewell",
          });
          this.endSession();
        }
      }, FAREWELL_GRACE_MS);
      return;
    }

    // Reset idle timer
    this.resetIdleTimer();
  }

  private onThresholdReached() {
    const fragmentStart = this.totalSessionMessages - this.messageCount + 1;
    const fragmentEnd = this.totalSessionMessages;

    activityBus.log("buffer:threshold_reached", `Scribe threshold reached (${this.messageCount} messages). Firing scribe.`, {
      messageCount: this.messageCount,
      fragmentRange: [fragmentStart, fragmentEnd],
    });

    // Read current buffer content before rotation
    const logPath = CONFIG.paths.conversationLog;
    const content = fs.readFileSync(logPath, "utf-8").trim();

    if (!content) return;

    // Format the fragment as readable conversation
    const fragment = content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const entry: ConversationEntry = JSON.parse(line);
          return `[${entry.role.toUpperCase()}]: ${entry.content}`;
        } catch {
          return line;
        }
      })
      .join("\n\n");

    // Rotate buffer
    this.rotateBuffer(content);

    // Fire scribe asynchronously (fire-and-forget)
    this.scribeCount++;
    const scribeId = `S${String(this.scribeCount).padStart(2, "0")}`;

    // Load current MAP
    let map = "_No MAP loaded._";
    if (fs.existsSync(CONFIG.paths.map)) {
      map = fs.readFileSync(CONFIG.paths.map, "utf-8");
    }

    const scribePromise = fireScribe({
      fragment,
      map,
      summaryChain: [...this.summaryChain],
      sessionId: this.sessionId,
      scribeId,
      fragmentRange: [fragmentStart, fragmentEnd],
    }).then((result) => {
      // Update summary chain for narrative continuity
      if (result.summary) {
        this.summaryChain.push(result.summary);
      }
      // Save deltas
      saveScribeResult({
        sessionId: this.sessionId,
        scribeId,
        fragmentRange: [fragmentStart, fragmentEnd],
        result,
      });
      return result;
    });

    this.scribeQueue.push(scribePromise);
  }

  private rotateBuffer(content?: string) {
    try {
      const logPath = CONFIG.paths.conversationLog;

      if (!content) {
        content = fs.readFileSync(logPath, "utf-8").trim();
      }
      if (!content) return;

      // Write snapshot for archival
      const snapshotName = `snapshot_${Date.now()}.jsonl`;
      const snapshotPath = path.join(CONFIG.paths.buffer, snapshotName);
      fs.writeFileSync(snapshotPath, content + "\n");

      // Clear the main buffer
      fs.writeFileSync(logPath, "");
      this.messageCount = 0;

      activityBus.log("buffer:cleared", `Buffer rotated → ${snapshotName}`, {
        snapshot: snapshotName,
      });
    } catch (err) {
      activityBus.log("system:error", `Buffer rotation failed: ${err}`);
    }
  }

  private resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      if (this.sessionActive && !this.consolidating) {
        activityBus.log("session:end", "Session ended (idle timeout)", {
          totalMessages: this.totalSessionMessages,
          reason: "idle_timeout",
        });
        this.endSession();
      }
    }, CONFIG.session.idleTimeoutMs);
  }

  startSession() {
    this.sessionActive = true;
    this.messageCount = 0;
    this.totalSessionMessages = 0;
    this.scribeCount = 0;
    this.summaryChain = [];
    this.scribeQueue = [];
    this.sessionId = `session_${Date.now()}`;

    // Clear any stale buffer
    fs.writeFileSync(CONFIG.paths.conversationLog, "");

    activityBus.log("session:start", `New session started: ${this.sessionId}`, {
      sessionId: this.sessionId,
      scribeInterval: CONFIG.session.scribeInterval,
      idleTimeoutMs: CONFIG.session.idleTimeoutMs,
    });

    this.resetIdleTimer();
  }

  /** Flush all pending scribes — called at session end before librarian */
  async flush(): Promise<void> {
    // Fire scribe for any remaining buffer content
    if (this.messageCount > 0) {
      const fragmentStart = this.totalSessionMessages - this.messageCount + 1;
      const fragmentEnd = this.totalSessionMessages;

      const logPath = CONFIG.paths.conversationLog;
      const content = fs.readFileSync(logPath, "utf-8").trim();

      if (content) {
        const fragment = content
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              const entry: ConversationEntry = JSON.parse(line);
              return `[${entry.role.toUpperCase()}]: ${entry.content}`;
            } catch {
              return line;
            }
          })
          .join("\n\n");

        this.rotateBuffer(content);

        this.scribeCount++;
        const scribeId = `S${String(this.scribeCount).padStart(2, "0")}_final`;

        let map = "_No MAP loaded._";
        if (fs.existsSync(CONFIG.paths.map)) {
          map = fs.readFileSync(CONFIG.paths.map, "utf-8");
        }

        const finalScribe = fireScribe({
          fragment,
          map,
          summaryChain: [...this.summaryChain],
          sessionId: this.sessionId,
          scribeId,
          fragmentRange: [fragmentStart, fragmentEnd],
        }).then((result) => {
          if (result.summary) this.summaryChain.push(result.summary);
          saveScribeResult({
            sessionId: this.sessionId,
            scribeId,
            fragmentRange: [fragmentStart, fragmentEnd],
            result,
          });
          return result;
        });

        this.scribeQueue.push(finalScribe);
      }
    }

    // Await ALL pending scribes
    if (this.scribeQueue.length > 0) {
      activityBus.log("buffer:cleared", `Flushing ${this.scribeQueue.length} pending scribes...`, {
        pendingCount: this.scribeQueue.length,
      });
      await Promise.allSettled(this.scribeQueue);
      activityBus.log("buffer:cleared", "All scribes flushed.");
    }
  }

  async endSession() {
    // Prevent re-entrancy (e.g., idle timer fires while consolidation is running)
    if (this.consolidating) return;

    this.sessionActive = false;
    this.consolidating = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      // Flush pending scribes
      await this.flush();

      // Patch delta file with session end metadata
      this.patchDeltaMetadata();

      // Gap 1: Skip consolidation for short sessions
      if (this.totalSessionMessages < CONFIG.session.minSessionMessages) {
        activityBus.log("session:end", `Session too short (${this.totalSessionMessages} messages < ${CONFIG.session.minSessionMessages}) — skipping consolidation`);
        return;
      }

      // Gap 2: Debounce rapid pipeline runs
      const timeSinceLastPipeline = Date.now() - this.lastPipelineTime;
      if (this.lastPipelineTime > 0 && timeSinceLastPipeline < CONFIG.session.pipelineCooldownMs) {
        activityBus.log("session:end", `Pipeline debounced (${Math.round(timeSinceLastPipeline / 1000)}s since last run, cooldown: ${CONFIG.session.pipelineCooldownMs / 1000}s)`);
        return;
      }

      // Gap 3: Create abort controller for pipeline cancellation
      this.pipelineAbort = new AbortController();

      // Trigger librarian/consolidation if callback registered
      if (this.onSessionEnd) {
        await this.onSessionEnd(this.pipelineAbort.signal);
      }

      // Only stamp pipeline time if it completed (not aborted)
      if (!this.pipelineAbort?.signal.aborted) {
        this.lastPipelineTime = Date.now();
      }
    } finally {
      this.pipelineAbort = null;
      this.consolidating = false;
    }
  }

  /** Add ended_at and message_count to the session delta file */
  private patchDeltaMetadata() {
    const deltaFile = path.join(CONFIG.paths.deltas, `${this.sessionId}.json`);
    if (!fs.existsSync(deltaFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
      data.ended_at = new Date().toISOString();
      data.message_count = this.totalSessionMessages;
      fs.writeFileSync(deltaFile, JSON.stringify(data, null, 2));
    } catch {
      // Non-critical
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getStatus() {
    return {
      sessionActive: this.sessionActive,
      consolidating: this.consolidating,
      bufferCount: this.messageCount,
      totalSessionMessages: this.totalSessionMessages,
      scribeInterval: CONFIG.session.scribeInterval,
      sessionId: this.sessionId,
      pendingScribes: this.scribeQueue.length,
      summaryChainLength: this.summaryChain.length,
    };
  }

  destroy() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
  }
}
