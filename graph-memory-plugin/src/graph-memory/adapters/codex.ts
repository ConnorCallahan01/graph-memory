import { HarnessAdapter, HarnessType } from "./types.js";

export class CodexAdapter implements HarnessAdapter {
  name: HarnessType = "codex";

  async onSessionStart(_cwd: string, _sessionId: string): Promise<string> {
    return "";
  }

  async onSessionEnd(_sessionId: string): Promise<void> {
    // No-op: codex has no hooks. Daemon scavenges orphaned buffers.
  }

  injectContext(_text: string): void {
    // No-op: no injection mechanism for codex.
  }
}
