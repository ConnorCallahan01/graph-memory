/**
 * Core types for Project Mental Models (Layer 2).
 *
 * Each project gets its own "lens" — a compressed mental model
 * representing how the user thinks about this specific project.
 */
import { ObservationType } from "../mind/types.js";

export type ProjectObservationLayer = "project";

export interface ProjectObservation {
  id: string;
  layer: "project";
  project: string;
  type: ObservationType;
  observation: string;
  evidence: string[];
  confidence: number;
  sessionId: string;
  timestamp: string;
  absorbed: boolean;
}

export interface ProjectModel {
  version: 3;
  project: string;
  generatedAt: string;
  techStack: string[];
  conventions: string[];
  procedures: string[];
  guardrails: string[];
  activeWork: string[];
  openThreads: string[];
  tokenEstimate: number;
}

export interface ProjectModelFile {
  project: string;
  model: ProjectModel;
  lastCompressorRun: string;
  observationCount: number;
  firstSessionAt: string;
  lastSessionAt: string;
}
