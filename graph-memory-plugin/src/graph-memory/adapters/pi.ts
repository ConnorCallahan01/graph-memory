import { HarnessAdapter, HarnessType } from "./types.js";
import { buildSessionStartContext, flushAndQueueJobs, cleanupSession } from "./shared.js";
import { hasV3Data, buildV3Context } from "../session-start-v3.js";
import { buildV2Injection } from "./shared.js";

export class PiAdapter implements HarnessAdapter {
  name: HarnessType = "pi";
  private pendingContext: string | null = null;

  async onSessionStart(cwd: string, sessionId: string): Promise<string> {
    const ctx = buildSessionStartContext(cwd, sessionId);

    if (ctx.v3Used) {
      const v3 = buildV3Context(ctx.project.name);
      const context = v3.context || "";
      this.pendingContext = context;
      return context;
    }

    const context = buildV2Injection(ctx.project);
    this.pendingContext = context;
    return context;
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    const { readActiveProject } = await import("../project.js");
    const active = readActiveProject();
    const project = active?.name || "global";
    flushAndQueueJobs(sessionId, project);
    cleanupSession(sessionId, project);
  }

  injectContext(text: string): void {
    this.pendingContext = text;
  }

  getPendingContext(): string | null {
    const ctx = this.pendingContext;
    this.pendingContext = null;
    return ctx;
  }
}
