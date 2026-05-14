import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

export function sanitizeProjectSlug(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9._-]+/g, "__") || "global";
}

export function getProjectWorkingPath(projectName: string): string {
  return path.join(CONFIG.paths.workingProjects, `${sanitizeProjectSlug(projectName)}.md`);
}

export function getProjectWorkingStatePath(projectName: string): string {
  return path.join(CONFIG.paths.workingProjects, `${sanitizeProjectSlug(projectName)}.state.json`);
}

export function getProjectWorkingUpdatesDir(projectName: string): string {
  return path.join(CONFIG.paths.workingProjects, "_updates", sanitizeProjectSlug(projectName));
}

export function getProjectWorkingUpdatePath(projectName: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(getProjectWorkingUpdatesDir(projectName), `${safeSessionId}.json`);
}

export function getWorkingInjectionPaths(projectName?: string): string[] {
  if (projectName && projectName !== "global") {
    return [getProjectWorkingPath(projectName)];
  }
  return [CONFIG.paths.workingGlobal];
}

export function getFileInteractionPath(projectName: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(getProjectWorkingUpdatesDir(projectName), `${safeSessionId}.files.json`);
}

export function ensureWorkingDirectories(): void {
  for (const dir of [CONFIG.paths.workingRoot, CONFIG.paths.workingProjects, path.join(CONFIG.paths.workingProjects, "_updates")]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
