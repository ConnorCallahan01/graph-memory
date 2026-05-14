/**
 * Core types for the Global Mental Model (Layer 1).
 *
 * Observations are raw signal captured by the observer.
 * Models are compressed representations of the user.
 * Whispers are pre-generated injection-ready text (~300 tokens).
 */

export type ObservationType =
  | "pattern"
  | "anti_pattern"
  | "preference"
  | "correction"
  | "decision"
  | "procedure"
  | "emotional"
  | "relational";

export type ObservationLayer = "global" | "project";

export interface Observation {
  id: string;
  layer: ObservationLayer;
  project?: string;
  type: ObservationType;
  observation: string;
  evidence: string[];
  confidence: number;
  sessionId: string;
  timestamp: string;
  absorbed: boolean;
}

export interface GlobalModel {
  version: 3;
  generatedAt: string;
  cognitiveStyle: string;
  decisionPatterns: string[];
  preferences: string[];
  guardrails: string[];
  emotionalProfile: string;
  relationalNotes: string[];
  tokenEstimate: number;
}

export interface GlobalModelFile {
  model: GlobalModel;
  lastCompressorRun: string;
  observationCount: number;
}
