import { HarnessAdapter, HarnessType } from "./types.js";
import { buildSessionStartContext, buildFullInjection, buildV2Injection, flushAndQueueJobs, cleanupSession } from "./shared.js";

export class PiAdapter implements HarnessAdapter {
  name: HarnessType = "pi";
  private pendingContext: string | null = null;

  async onSessionStart(cwd: string, sessionId: string): Promise<string> {
    const ctx = buildSessionStartContext(cwd, sessionId);

    let context: string;
    if (ctx.mentalModelUsed) {
      context = buildFullInjection(ctx.project);
    } else {
      context = buildV2Injection(ctx.project);
    }

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
