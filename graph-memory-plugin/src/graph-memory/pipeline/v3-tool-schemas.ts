/**
 * Structured tool schemas for the v3 pipeline workers.
 *
 * These define the input/output contracts for observer, compressor, and dreamer.
 * Each worker receives these schemas in its prompt and calls them as structured tools.
 */
import { z } from "zod";
import { ObservationType, ObservationLayer } from "../mind/types.js";

// --- Observer Tools ---

export const observeSchema = z.object({
  layer: z.enum(["global", "project"]).describe("Which mental model layer this observation belongs to"),
  project: z.string().optional().describe("Project name (required if layer=project)"),
  observation: z.string().describe("The observation text — what was learned about the user"),
  evidence: z.array(z.string()).describe("Supporting evidence from the conversation"),
  confidence: z.number().min(0).max(1).describe("Confidence in this observation (0-1)"),
  type: z.enum([
    "pattern", "anti_pattern", "preference", "correction",
    "decision", "procedure", "emotional", "relational",
  ]).describe("Classification of the observation"),
});

export const logSessionSchema = z.object({
  project: z.string().describe("Project name"),
  active_work: z.array(z.string()).describe("What the user was actively working on"),
  shipped: z.array(z.string()).describe("Things that were completed/shipped"),
  decisions: z.array(z.string()).describe("Decisions made during the session"),
  blocked: z.array(z.string()).describe("Blockers or issues encountered"),
  open_threads: z.array(z.string()).describe("Unresolved topics for next session"),
  corrections_given: z.array(z.string()).describe("Corrections the user gave to the agent"),
  next_session_should: z.string().describe("What the next session should focus on"),
});

export const upsertNodeSchema = z.object({
  path: z.string().describe("Node path (e.g. 'patterns/ssh-first-then-deploy')"),
  category: z.enum([
    "patterns", "anti-patterns", "decisions", "preferences",
    "procedures", "corrections", "projects", "concepts",
    "architecture", "people", "tools",
  ]).describe("Graph category for the node"),
  gist: z.string().describe("One-sentence summary (15-25 words)"),
  content: z.string().describe("Full content of the node"),
  confidence: z.number().min(0).max(1).describe("Confidence score"),
  edges: z.array(z.object({
    target: z.string(),
    type: z.enum(["relates_to", "supports", "contradicts", "derived_from", "supersedes", "depends_on"]),
  })).optional().describe("Connections to other nodes"),
  anti_pattern: z.boolean().optional().describe("Mark as anti-pattern (never decays)"),
  tags: z.array(z.string()).optional().describe("Tags for categorization"),
});

// --- Compressor Tools ---

export const getObservationsSchema = z.object({
  layer: z.enum(["global", "project"]).optional().describe("Filter by layer"),
  project: z.string().optional().describe("Filter by project"),
  since: z.string().optional().describe("ISO timestamp — only return observations after this"),
});

export const getModelSchema = z.object({
  layer: z.enum(["global", "project"]).describe("Which model to read"),
  project: z.string().optional().describe("Project name (required if layer=project)"),
});

export const updateModelSchema = z.object({
  layer: z.enum(["global", "project"]).describe("Which model to update"),
  project: z.string().optional().describe("Project name (required if layer=project)"),
  content: z.string().describe("JSON string of the updated model"),
});

export const queryGraphSchema = z.object({
  query: z.string().describe("Search query"),
  category: z.string().optional().describe("Filter by graph category"),
  limit: z.number().optional().describe("Max results (default 5)"),
});

export const getAntiPatternsSchema = z.object({
  project: z.string().optional().describe("Filter by project scope"),
});

export const archiveObservationsSchema = z.object({
  ids: z.array(z.string()).describe("Observation IDs to mark as absorbed"),
  layer: z.enum(["global", "project"]).optional().describe("Which layer"),
  project: z.string().optional().describe("Project name (required if layer=project)"),
});

export const pruneSessionLogsSchema = z.object({
  project: z.string().optional().describe("Project to prune (omit for all)"),
  older_than_days: z.number().describe("Prune entries older than this many days"),
});

export const archiveGraphNodesSchema = z.object({
  paths: z.array(z.string()).describe("Node paths to archive"),
  reason: z.string().describe("Reason for archival"),
});

export const getGraphStatsSchema = z.object({});

export const flagForDeepAuditSchema = z.object({
  reason: z.string().describe("Why a deep audit is needed"),
});

// --- Dreamer Tools ---

export const getModelsSchema = z.object({
  layers: z.array(z.enum(["global", "project"])).describe("Which models to retrieve"),
});

export const getGraphNodesSchema = z.object({
  category: z.string().optional().describe("Filter by category"),
  limit: z.number().optional().describe("Max nodes to return (default 10)"),
});

export const getDreamerAntiPatternsSchema = z.object({});

export const proposeDreamSchema = z.object({
  fragment: z.string().describe("The dream fragment — a speculative insight or connection"),
  references: z.array(z.string()).describe("Node/model paths that inspired this dream"),
  reasoning: z.string().describe("Why this connection is interesting"),
});

// --- Bootstrap Tool ---

export const bootstrapProjectDocSchema = z.object({
  project: z.string().describe("Project name"),
  harness: z.enum(["claude-code", "codex", "pi", "opencode"]).describe("Target harness"),
  cwd: z.string().describe("Project working directory"),
});
