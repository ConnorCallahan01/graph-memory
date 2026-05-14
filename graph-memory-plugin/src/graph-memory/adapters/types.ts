/**
 * Harness adapter interface and types.
 *
 * The core is harness-agnostic. Each harness (Claude Code, Codex, Pi, OpenCode)
 * provides an adapter that implements this interface.
 *
 * Codex runs in degraded mode (MCP tools only, no hooks).
 * Claude Code, Pi, and OpenCode get full automatic operation.
 */
import { ProjectInfo } from "../project.js";

export type HarnessType = "claude-code" | "codex" | "pi" | "opencode";

export interface HarnessAdapter {
  name: HarnessType;
  onSessionStart(cwd: string, sessionId: string): Promise<string>;
  onSessionEnd(sessionId: string): Promise<void>;
  injectContext(text: string): void;
}

export interface SessionStartResult {
  globalWhisper: string | null;
  projectWhisper: string | null;
  sessionLog: string | null;
  project: ProjectInfo;
  fullInjection: string;
}

export interface AdapterConfig {
  projectDocFilename: string;
  supportsHooks: boolean;
  supportsPluginEvents: boolean;
  supportsMCP: boolean;
}

export const ADAPTER_CONFIGS: Record<HarnessType, AdapterConfig> = {
  "claude-code": {
    projectDocFilename: "CLAUDE.md",
    supportsHooks: true,
    supportsPluginEvents: false,
    supportsMCP: true,
  },
  codex: {
    projectDocFilename: "AGENT.md",
    supportsHooks: false,
    supportsPluginEvents: false,
    supportsMCP: true,
  },
  pi: {
    projectDocFilename: "AGENT.md",
    supportsHooks: false,
    supportsPluginEvents: true,
    supportsMCP: true,
  },
  opencode: {
    projectDocFilename: "AGENT.md",
    supportsHooks: false,
    supportsPluginEvents: true,
    supportsMCP: true,
  },
};

export function isDegradedMode(harness: HarnessType): boolean {
  return harness === "codex";
}
