/**
 * Project detection and active-project state management.
 *
 * Detects the current project from git remote URL, caches per cwd,
 * and manages active-project state files for multi-session disambiguation.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { CONFIG } from "./config.js";

export interface ProjectInfo {
  name: string;
  gitRoot?: string;
}

interface ActiveProjectEntry {
  name: string;
  gitRoot?: string;
  cwd: string;
  startedAt: string;
}

// Cache: cwd → ProjectInfo (fast, avoids repeated git calls)
const projectCache = new Map<string, ProjectInfo>();

/** Sanitize sessionId for use in filenames — only allow safe characters */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/**
 * Detect project from git remote. Returns { name: "owner/repo" } or { name: "global" }.
 * Cached per cwd for speed (< 50ms after first call).
 */
export function detectProject(cwd: string): ProjectInfo {
  if (projectCache.has(cwd)) {
    return projectCache.get(cwd)!;
  }

  let result: ProjectInfo = { name: "global" };

  try {
    // Get git root (use cwd option to avoid shell injection)
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Check cache by gitRoot too (different cwd, same repo)
    for (const [, cached] of projectCache) {
      if (cached.gitRoot === gitRoot) {
        projectCache.set(cwd, cached);
        return cached;
      }
    }

    // Get remote URL
    try {
      const remoteUrl = execSync("git remote get-url origin", {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const name = extractOwnerRepo(remoteUrl);
      result = { name: name || "global", gitRoot };
    } catch {
      // No remote — use directory name as project identifier
      const dirName = path.basename(gitRoot);
      result = { name: dirName, gitRoot };
    }
  } catch {
    // Not a git repo
    result = { name: "global" };
  }

  projectCache.set(cwd, result);
  return result;
}

/**
 * Extract "owner/repo" from various git remote URL formats.
 * Handles: https://github.com/owner/repo.git, git@github.com:owner/repo.git, etc.
 */
function extractOwnerRepo(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/[@:]([^/:]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  return null;
}

/**
 * Write active-project state for a session.
 * Creates ~/.graph-memory/.active-projects/{sessionId}.json
 */
export function writeActiveProject(
  sessionId: string,
  project: { name: string; gitRoot?: string; cwd: string }
): void {
  const dir = CONFIG.paths.activeProjects;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeId = sanitizeSessionId(sessionId);
  const entry: ActiveProjectEntry = {
    name: project.name,
    gitRoot: project.gitRoot,
    cwd: project.cwd,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(dir, `${safeId}.json`),
    JSON.stringify(entry, null, 2)
  );
}

/**
 * Read active project for a session. If no sessionId, returns the most recent.
 */
export function readActiveProject(sessionId?: string): ProjectInfo | null {
  const dir = CONFIG.paths.activeProjects;
  if (!fs.existsSync(dir)) return null;

  if (sessionId) {
    const filePath = path.join(dir, `${sanitizeSessionId(sessionId)}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data: ActiveProjectEntry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return { name: data.name, gitRoot: data.gitRoot };
    } catch {
      return null;
    }
  }

  // No sessionId — find the most recent
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    if (files.length === 0) return null;

    let latest: { entry: ActiveProjectEntry; mtime: number } | null = null;
    for (const f of files) {
      const filePath = path.join(dir, f);
      try {
        const stat = fs.statSync(filePath);
        if (!latest || stat.mtimeMs > latest.mtime) {
          const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          latest = { entry, mtime: stat.mtimeMs };
        }
      } catch { /* skip */ }
    }

    if (latest) return { name: latest.entry.name, gitRoot: latest.entry.gitRoot };
  } catch { /* skip */ }

  return null;
}

/**
 * Remove active-project file for a session.
 */
export function removeActiveProject(sessionId: string): void {
  const filePath = path.join(CONFIG.paths.activeProjects, `${sanitizeSessionId(sessionId)}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

/**
 * Clean up stale active-project files (older than 24 hours).
 */
export function cleanActiveProjects(): void {
  const dir = CONFIG.paths.activeProjects;
  if (!fs.existsSync(dir)) return;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const filePath = path.join(dir, f);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch { /* skip */ }
  }
}
