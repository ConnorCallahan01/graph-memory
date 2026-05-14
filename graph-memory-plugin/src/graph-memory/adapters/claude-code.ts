import { HarnessAdapter, HarnessType } from "./types.js";
import { buildSessionStartContext, buildV2Injection, flushAndQueueJobs, cleanupSession } from "./shared.js";
import { hasV3Data, buildV3Context } from "../session-start-v3.js";
import { markDirty } from "../dirty-state.js";
import { writeSessionContextState } from "../context-refresh.js";

export class ClaudeCodeAdapter implements HarnessAdapter {
  name: HarnessType = "claude-code";

  async onSessionStart(cwd: string, sessionId: string): Promise<string> {
    const ctx = buildSessionStartContext(cwd, sessionId);

    if (ctx.v3Used) {
      const v3 = buildV3Context(ctx.project.name);
      return v3.context || "";
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
