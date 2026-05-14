/**
 * v3 Session Start — builds context from whispers and session logs.
 *
 * Replaces the v2 5-file injection (PRIORS, SOMA, MAP, WORKING, DREAMS)
 * with a 3-file read (global whisper, project whisper, session logs).
 *
 * Falls back to v2 injection when v3 files don't exist yet (cold start).
 */
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { readWhisper as readGlobalWhisper, estimateTokens } from "./mind/whisper.js";
import { ensureLens, readWhisper as readProjectWhisper, lensExists } from "./lenses/manager.js";
import { readRecentSessions } from "./sessions/manager.js";
import { SessionLog } from "./sessions/types.js";
import { getAntiPatterns } from "./pipeline/graph-index-v3.js";

const MAX_GLOBAL_WHISPER_TOKENS = 400;
const MAX_PROJECT_WHISPER_TOKENS = 500;
const MAX_SESSION_LOG_TOKENS = 200;
const MAX_TOTAL_TOKENS = 1100;

export interface V3SessionStartResult {
  context: string;
  tokensUsed: number;
  sources: {
    globalWhisper: boolean;
    projectWhisper: boolean;
    sessionLog: boolean;
    fallback: boolean;
  };
}

export function buildV3Context(projectName: string): V3SessionStartResult {
  const parts: string[] = [];
  let tokensUsed = 0;
  const sources = {
    globalWhisper: false,
    projectWhisper: false,
    sessionLog: false,
    fallback: false,
  };

  const globalWhisper = readGlobalWhisper();
  if (globalWhisper) {
    const tokens = estimateTokens(globalWhisper);
    if (tokens <= MAX_GLOBAL_WHISPER_TOKENS) {
      parts.push(globalWhisper);
      tokensUsed += tokens;
      sources.globalWhisper = true;
    }
  }

  const guardrails = buildGuardrails(projectName);
  if (guardrails) {
    const tokens = estimateTokens(guardrails);
    if (tokens <= 150 && tokensUsed + tokens <= MAX_TOTAL_TOKENS) {
      parts.push(guardrails);
      tokensUsed += tokens;
    }
  }

  if (projectName && projectName !== "global") {
    if (!lensExists(projectName)) {
      ensureLens(projectName);
    }

    const projectWhisper = readProjectWhisper(projectName);
    if (projectWhisper) {
      const tokens = estimateTokens(projectWhisper);
      const cap = Math.min(MAX_PROJECT_WHISPER_TOKENS, MAX_TOTAL_TOKENS - tokensUsed);
      if (tokens <= cap) {
        parts.push(projectWhisper);
        tokensUsed += tokens;
        sources.projectWhisper = true;
      }
    }

    const recentSessions = readRecentSessions(projectName, 3);
    if (recentSessions.length > 0) {
      const logBlock = formatSessionLogs(recentSessions);
      const tokens = estimateTokens(logBlock);
      const cap = Math.min(MAX_SESSION_LOG_TOKENS, MAX_TOTAL_TOKENS - tokensUsed);
      if (tokens <= cap) {
        parts.push(logBlock);
        tokensUsed += tokens;
        sources.sessionLog = true;
      }
    }
  }

  if (parts.length === 0) {
    sources.fallback = true;
  }

  return {
    context: parts.join("\n\n---\n\n"),
    tokensUsed,
    sources,
  };
}

function formatSessionLogs(logs: SessionLog[]): string {
  const lines: string[] = ["## Recent Sessions", ""];

  for (const log of logs) {
    const date = log.timestamp.slice(0, 10);
    lines.push("**" + date + "**");

    if (log.shipped.length > 0) {
      lines.push("Shipped: " + log.shipped.join(", "));
    }
    if (log.decisions.length > 0) {
      lines.push("Decisions: " + log.decisions.join("; "));
    }
    if (log.openThreads.length > 0) {
      lines.push("Open: " + log.openThreads.join("; "));
    }
    if (log.nextSessionShould) {
      lines.push("Next: " + log.nextSessionShould);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildGuardrails(projectName: string): string | null {
  try {
    const antiPatterns = getAntiPatterns(projectName !== "global" ? projectName : undefined);
    if (antiPatterns.length === 0) return null;

    const lines: string[] = ["## Guardrails", ""];
    for (const ap of antiPatterns) {
      lines.push("- " + ap.gist);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

export function hasV3Data(): boolean {
  if (!CONFIG.v3.enabled) return false;
  const mindDir = CONFIG.paths.v3Mind;
  if (!fs.existsSync(mindDir)) return false;
  const whisperPath = path.join(mindDir, "whisper.txt");
  return fs.existsSync(whisperPath);
}
