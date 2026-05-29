/**
 * Observation read/write for the global mental model.
 * Storage: mind/observations.jsonl (append-only)
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { CONFIG } from "../config.js";
import { Observation, ObservationType, ObservationLayer } from "./types.js";

export function observationsPath(): string {
  return path.join(CONFIG.paths.mind, "observations.jsonl");
}

export function appendObservation(obs: {
  layer: ObservationLayer;
  project?: string;
  type: ObservationType;
  observation: string;
  evidence: string[];
  confidence: number;
  sessionId: string;
}): Observation {
  const dir = CONFIG.paths.mind;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry: Observation = {
    id: `obs_${randomUUID().slice(0, 8)}`,
    layer: obs.layer,
    project: obs.project,
    type: obs.type,
    observation: obs.observation,
    evidence: obs.evidence,
    confidence: obs.confidence,
    sessionId: obs.sessionId,
    timestamp: new Date().toISOString(),
    absorbed: false,
  };

  const filePath = observationsPath();
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
  return entry;
}

export function countPendingObservations(): number {
  const filePath = observationsPath();
  if (!fs.existsSync(filePath)) return 0;

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    try {
      if (!JSON.parse(line).absorbed) count++;
    } catch { /* skip malformed */ }
  }
  return count;
}

export function readObservations(since?: string): Observation[] {
  const filePath = observationsPath();
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const all: Observation[] = [];
  for (const line of lines) {
    try { all.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  if (!since) return all;
  return all.filter((o) => o.timestamp > since);
}

export function markObservationsAbsorbed(ids: string[]): void {
  const filePath = observationsPath();
  if (!fs.existsSync(filePath)) return;

  const idSet = new Set(ids);
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    let obs: Observation;
    try { obs = JSON.parse(line); } catch { return line; }
    if (idSet.has(obs.id)) {
      obs.absorbed = true;
    }
    return JSON.stringify(obs);
  });

  fs.writeFileSync(filePath, updated.join("\n") + "\n");
}

export function pruneObservations(olderThanDays: number): number {
  const filePath = observationsPath();
  if (!fs.existsSync(filePath)) return 0;

  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const kept: string[] = [];
  let pruned = 0;

  for (const line of lines) {
    let obs: Observation;
    try { obs = JSON.parse(line); } catch { kept.push(line); continue; }
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

export function observationFileSize(): number {
  const filePath = observationsPath();
  if (!fs.existsSync(filePath)) return 0;
  return fs.statSync(filePath).size;
}
