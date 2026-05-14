import { HarnessType } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { CodexAdapter } from "./codex.js";
import { HarnessAdapter } from "./types.js";

const ADAPTERS: Record<HarnessType, () => HarnessAdapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
  "opencode": () => new OpenCodeAdapter(),
  "pi": () => new PiAdapter(),
  "codex": () => new CodexAdapter(),
};

export function createAdapter(harness: HarnessType): HarnessAdapter {
  return ADAPTERS[harness]();
}
