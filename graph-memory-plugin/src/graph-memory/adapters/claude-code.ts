import { HarnessAdapter, HarnessType } from "./types.js";
import { buildSessionStartContext, buildFullInjection, buildV2Injection, flushAndQueueJobs, cleanupSession } from "./shared.js";

export class ClaudeCodeAdapter implements HarnessAdapter {
  name: HarnessType = "claude-code";

  async onSessionStart(cwd: string, sessionId: string): Promise<string> {
    const ctx = buildSessionStartContext(cwd, sessionId);

    if (ctx.mentalModelUsed) {
      return buildFullInjection(ctx.project);
    }

    return buildV2Injection(ctx.project);
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    const { readActiveProject } = await import("../project.js");
    const active = readActiveProject();
    const project = active?.name || "global";
    flushAndQueueJobs(sessionId, project);
    cleanupSession(sessionId, project);
  }

  injectContext(text: string): void {
    console.log(text);
  }
}
