/**
 * Project lens read/write operations.
 *
 * Storage layout:
 *   lenses/{project}/
 *     observations.jsonl   ← raw project observations
 *     model.json           ← compressed project model
 *     whisper.txt          ← pre-generated whisper (~400 tokens)
 *   lenses/_archived/      ← dormant project lenses
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { CONFIG } from "../config.js";
import { ObservationType } from "../mind/types.js";
import { ProjectObservation, ProjectModel, ProjectModelFile } from "./types.js";

export function lensDir(project: string): string {
  return path.join(CONFIG.paths.v3Lenses, project);
}

export function archivedLensDir(): string {
  return path.join(CONFIG.paths.v3Lenses, "_archived");
}

export function observationsPath(project: string): string {
  return path.join(lensDir(project), "observations.jsonl");
}

export function modelPath(project: string): string {
  return path.join(lensDir(project), "model.json");
}

export function whisperPath(project: string): string {
  return path.join(lensDir(project), "whisper.txt");
}

export function ensureLens(project: string): void {
  const dir = lensDir(project);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function lensExists(project: string): boolean {
  return fs.existsSync(lensDir(project));
}

export function listActiveLenses(): string[] {
  const root = CONFIG.paths.v3Lenses;
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => {
    if (name.startsWith("_") || name.startsWith(".")) return false;
    return fs.statSync(path.join(root, name)).isDirectory();
  });
}

export function appendObservation(project: string, obs: {
  type: ObservationType;
  observation: string;
  evidence: string[];
  confidence: number;
  sessionId: string;
}): ProjectObservation {
  ensureLens(project);
  const entry: ProjectObservation = {
    id: `obs_${randomUUID().slice(0, 8)}`,
    layer: "project",
    project,
    type: obs.type,
    observation: obs.observation,
    evidence: obs.evidence,
    confidence: obs.confidence,
    sessionId: obs.sessionId,
    timestamp: new Date().toISOString(),
    absorbed: false,
  };

  const filePath = observationsPath(project);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
  return entry;
}

export function readObservations(project: string, since?: string): ProjectObservation[] {
  const filePath = observationsPath(project);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const all: ProjectObservation[] = lines.map((line) => JSON.parse(line));

  if (!since) return all;
  return all.filter((o) => o.timestamp > since);
}

export function markObservationsAbsorbed(project: string, ids: string[]): void {
  const filePath = observationsPath(project);
  if (!fs.existsSync(filePath)) return;

  const idSet = new Set(ids);
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    const obs: ProjectObservation = JSON.parse(line);
    if (idSet.has(obs.id)) {
      obs.absorbed = true;
    }
    return JSON.stringify(obs);
  });

  fs.writeFileSync(filePath, updated.join("\n") + "\n");
}

export function pruneObservations(project: string, olderThanDays: number): number {
  const filePath = observationsPath(project);
  if (!fs.existsSync(filePath)) return 0;

  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const kept: string[] = [];
  let pruned = 0;

  for (const line of lines) {
    const obs: ProjectObservation = JSON.parse(line);
    if (obs.absorbed && obs.timestamp < cutoff) {
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

const EMPTY_PROJECT_MODEL: ProjectModel = {
  version: 3,
  project: "",
  generatedAt: new Date().toISOString(),
  techStack: [],
  conventions: [],
  procedures: [],
  guardrails: [],
  activeWork: [],
  openThreads: [],
  tokenEstimate: 0,
};

export function readModel(project: string): ProjectModelFile {
  const filePath = modelPath(project);
  if (!fs.existsSync(filePath)) {
    return {
      project,
      model: { ...EMPTY_PROJECT_MODEL, project },
      lastCompressorRun: "",
      observationCount: 0,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function writeModel(project: string, file: ProjectModelFile): void {
  ensureLens(project);
  fs.writeFileSync(modelPath(project), JSON.stringify(file, null, 2));
}

export function readWhisper(project: string): string | null {
  const filePath = whisperPath(project);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content || null;
}

export function writeWhisper(project: string, text: string): void {
  ensureLens(project);
  fs.writeFileSync(whisperPath(project), text);
}

export function archiveLens(project: string): void {
  const src = lensDir(project);
  const destDir = archivedLensDir();
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const dest = path.join(destDir, project);
  if (fs.existsSync(src)) {
    fs.renameSync(src, dest);
  }
}

export function isArchived(project: string): boolean {
  return fs.existsSync(path.join(archivedLensDir(), project));
}

export function restoreLens(project: string): void {
  const src = path.join(archivedLensDir(), project);
  const dest = lensDir(project);
  if (fs.existsSync(src)) {
    fs.renameSync(src, dest);
  }
}
