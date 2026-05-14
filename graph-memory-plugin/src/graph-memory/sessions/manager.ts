/**
 * Session log read/write operations.
 *
 * Storage: sessions/{project}.jsonl
 * Lifecycle:
 *   < 3 days: full detail injected
 *   3-7 days: summary only
 *   > 7 days: only "decisions" and "shipped" kept
 *   > 30 days: fully deleted
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { CONFIG } from "../config.js";
import { SessionLog } from "./types.js";

export function sessionLogPath(project: string): string {
  return path.join(CONFIG.paths.v3Sessions, project + ".jsonl");
}

export function appendSessionLog(entry: {
  project: string;
  sessionId: string;
  activeWork: string[];
  shipped: string[];
  decisions: string[];
  blocked: string[];
  openThreads: string[];
  correctionsGiven: string[];
  nextSessionShould: string;
}): SessionLog {
  const dir = CONFIG.paths.v3Sessions;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const log: SessionLog = {
    id: "sess_" + randomUUID().slice(0, 8),
    project: entry.project,
    sessionId: entry.sessionId,
    timestamp: new Date().toISOString(),
    activeWork: entry.activeWork,
    shipped: entry.shipped,
    decisions: entry.decisions,
    blocked: entry.blocked,
    openThreads: entry.openThreads,
    correctionsGiven: entry.correctionsGiven,
    nextSessionShould: entry.nextSessionShould,
  };

  const filePath = sessionLogPath(entry.project);
  fs.appendFileSync(filePath, JSON.stringify(log) + "\n");
  return log;
}

export function readRecentSessions(project: string, count: number = 3): SessionLog[] {
  const filePath = sessionLogPath(project);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const all: SessionLog[] = lines.map((line) => JSON.parse(line));
  return all.slice(-count);
}

export function pruneSessionLogs(project: string, olderThanDays: number): number {
  const filePath = sessionLogPath(project);
  if (!fs.existsSync(filePath)) return 0;

  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const kept: string[] = [];
  let pruned = 0;

  for (const line of lines) {
    const log: SessionLog = JSON.parse(line);
    if (log.timestamp < cutoff) {
      pruned++;
    } else {
      kept.push(line);
    }
  }

  if (pruned > 0) {
    fs.writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  }
  return pruned;
}

export function compactSessionLogs(project: string): number {
  const filePath = sessionLogPath(project);
  if (!fs.existsSync(filePath)) return 0;

  const now = Date.now();
  const sevenDays = 7 * 86_400_000;
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const kept: string[] = [];

  for (const line of lines) {
    const log: SessionLog = JSON.parse(line);
    const age = now - new Date(log.timestamp).getTime();

    if (age > sevenDays) {
      const compacted: SessionLog = {
        ...log,
        activeWork: [],
        blocked: [],
        openThreads: [],
        correctionsGiven: [],
        nextSessionShould: "",
      };
      kept.push(JSON.stringify(compacted));
    } else {
      kept.push(line);
    }
  }

  fs.writeFileSync(filePath, kept.join("\n") + "\n");
  return lines.length - kept.length;
}

export function sessionLogCount(project: string): number {
  const filePath = sessionLogPath(project);
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean).length;
}
