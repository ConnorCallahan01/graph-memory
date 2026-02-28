/**
 * Phase 1: Mechanical delta application — no LLM required.
 *
 * Reads scribe deltas and applies them directly to the filesystem.
 * Replaces what the librarian previously did for CRUD operations.
 *
 * IMPORTANT: Scribe deltas use field names from scribe.md prompt:
 *   - `type` (not `action`) for the delta kind
 *   - `from`/`to` for edge endpoints (not `path`/`target`)
 *   - `change` for update_stance description
 *   - `new_confidence` for confidence updates
 * A normalization step translates these to internal field names.
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { safePath } from "../utils.js";
import { validateEdgeType, fullRegenerateMAP, rebuildIndex } from "./graph-ops.js";

/** Internal normalized delta — after translating scribe field names */
interface NormalizedDelta {
  action: string;
  path?: string;
  title?: string;
  gist?: string;
  tags?: string[];
  keywords?: string[];
  confidence?: number;
  edges?: Array<{ target: string; type: string; weight: number }>;
  anti_edges?: Array<{ target: string; reason: string }>;
  soma?: { valence: string; intensity: number; marker: string };
  content?: string;
  target?: string;
  edge_type?: string;
  weight?: number;
  reason?: string;
  valence?: string;
  intensity?: number;
  marker?: string;
  project?: string;
}

/**
 * Normalize a raw scribe delta into internal field names.
 * Scribe prompt uses: type, from, to, change, new_confidence
 * Internal uses: action, path, target, content, confidence
 */
function normalizeDelta(raw: any): NormalizedDelta {
  return {
    ...raw,
    action: raw.type || raw.action,
    // For create_edge / create_anti_edge: from → path, to → target
    path: raw.path || raw.from,
    target: raw.target || raw.to,
    // For update_stance: change → content
    content: raw.content || raw.change,
    // For update_stance / update_confidence: new_confidence → confidence
    confidence: raw.confidence ?? raw.new_confidence,
  };
}

function loadSessionDeltas(sessionId: string): NormalizedDelta[] {
  const deltaFile = path.join(CONFIG.paths.deltas, `${sessionId}.json`);
  if (!fs.existsSync(deltaFile)) return [];
  const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
  const rawDeltas = (data.scribes || []).flatMap((s: any) => s.deltas || []);
  return rawDeltas.map(normalizeDelta);
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function handleCreateNode(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path) {
    errors.push("create_node: missing path");
    return false;
  }

  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath) {
    errors.push(`create_node: invalid path ${delta.path}`);
    return false;
  }

  // If node exists, merge instead of overwrite
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      if (delta.confidence !== undefined && delta.confidence > (parsed.data.confidence || 0)) {
        parsed.data.confidence = delta.confidence;
      }

      const existingEdges = parsed.data.edges || [];
      const existingTargets = new Set(existingEdges.map((e: any) => e.target));
      for (const edge of delta.edges || []) {
        if (!existingTargets.has(edge.target)) {
          existingEdges.push({ ...edge, type: validateEdgeType(edge.type) });
        }
      }
      parsed.data.edges = existingEdges;

      parsed.data.tags = [...new Set([...(parsed.data.tags || []), ...(delta.tags || [])])];
      parsed.data.keywords = [...new Set([...(parsed.data.keywords || []), ...(delta.keywords || [])])];

      if (delta.content && !parsed.content.includes(delta.content.slice(0, 100))) {
        parsed.content = parsed.content.trimEnd() + `\n\n---\n\n${delta.content}`;
      }

      parsed.data.updated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));

      activityBus.log("graph:node_merged", `Mechanical merge: ${delta.path}`);
      return true;
    } catch (err: any) {
      errors.push(`create_node merge failed for ${delta.path}: ${err.message}`);
      return false;
    }
  }

  // Create new node
  ensureDir(filePath);

  const now = new Date().toISOString().slice(0, 10);
  const frontmatterData: Record<string, any> = {
    id: delta.path,
    title: delta.title || delta.path.split("/").pop(),
    gist: delta.gist || "",
    confidence: delta.confidence ?? 0.5,
    created: now,
    updated: now,
    decay_rate: 0.05,
    tags: delta.tags || [],
    keywords: delta.keywords || [],
  };

  if (delta.edges && delta.edges.length > 0) {
    frontmatterData.edges = delta.edges.map(e => ({
      ...e,
      type: validateEdgeType(e.type),
    }));
  }
  if (delta.anti_edges && delta.anti_edges.length > 0) {
    frontmatterData.anti_edges = delta.anti_edges;
  }
  if (delta.soma) {
    frontmatterData.soma = delta.soma;
  }
  if (delta.project) {
    frontmatterData.project = delta.project;
  }

  const title = delta.title || delta.path.split("/").pop() || delta.path;
  const body = `# ${title}\n\n${delta.content || ""}`;
  fs.writeFileSync(filePath, matter.stringify(body, frontmatterData));

  activityBus.log("graph:node_created", `Mechanical create: ${delta.path}`);
  return true;
}

function handleUpdateConfidence(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path) { errors.push("update_confidence: missing path"); return false; }
  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`update_confidence: node not found ${delta.path}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    if (delta.confidence !== undefined) {
      parsed.data.confidence = delta.confidence;
    }
    parsed.data.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    activityBus.log("graph:node_updated", `Mechanical confidence update: ${delta.path}`);
    return true;
  } catch (err: any) {
    errors.push(`update_confidence failed for ${delta.path}: ${err.message}`);
    return false;
  }
}

function handleUpdateStance(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path) { errors.push("update_stance: missing path"); return false; }
  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`update_stance: node not found ${delta.path}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    if (delta.confidence !== undefined) {
      parsed.data.confidence = delta.confidence;
    }
    if (delta.content) {
      parsed.content = parsed.content.trimEnd() + `\n\n_Stance update:_ ${delta.content}`;
    }
    parsed.data.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    activityBus.log("graph:node_updated", `Mechanical stance update: ${delta.path}`);
    return true;
  } catch (err: any) {
    errors.push(`update_stance failed for ${delta.path}: ${err.message}`);
    return false;
  }
}

function handleSomaSignal(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path) { errors.push("soma_signal: missing path"); return false; }
  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`soma_signal: node not found ${delta.path}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    parsed.data.soma = delta.soma || {
      valence: delta.valence || "neutral",
      intensity: delta.intensity ?? 0.5,
      marker: delta.marker || "",
    };
    parsed.data.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    activityBus.log("graph:node_updated", `Mechanical soma signal: ${delta.path}`);
    return true;
  } catch (err: any) {
    errors.push(`soma_signal failed for ${delta.path}: ${err.message}`);
    return false;
  }
}

function handleCreateEdge(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path || !delta.target) {
    errors.push("create_edge: missing path or target");
    return false;
  }
  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`create_edge: source not found ${delta.path}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    const edges = parsed.data.edges || [];
    const existingTargets = new Set(edges.map((e: any) => e.target));
    if (!existingTargets.has(delta.target)) {
      edges.push({
        target: delta.target,
        type: validateEdgeType(delta.edge_type || "relates_to"),
        weight: delta.weight ?? 0.5,
      });
      parsed.data.edges = edges;
      parsed.data.updated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
      activityBus.log("graph:node_updated", `Mechanical edge: ${delta.path} → ${delta.target}`);
    }
    return true;
  } catch (err: any) {
    errors.push(`create_edge failed for ${delta.path}: ${err.message}`);
    return false;
  }
}

function handleCreateAntiEdge(delta: NormalizedDelta, errors: string[]): boolean {
  if (!delta.path || !delta.target) {
    errors.push("create_anti_edge: missing path or target");
    return false;
  }
  const filePath = safePath(CONFIG.paths.nodes, delta.path, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`create_anti_edge: source not found ${delta.path}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    const antiEdges = parsed.data.anti_edges || [];
    const existingTargets = new Set(antiEdges.map((e: any) => e.target));
    if (!existingTargets.has(delta.target)) {
      antiEdges.push({
        target: delta.target,
        reason: delta.reason || "",
      });
      parsed.data.anti_edges = antiEdges;
      parsed.data.updated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
      activityBus.log("graph:node_updated", `Mechanical anti-edge: ${delta.path} →✕ ${delta.target}`);
    }
    return true;
  } catch (err: any) {
    errors.push(`create_anti_edge failed for ${delta.path}: ${err.message}`);
    return false;
  }
}

/**
 * Apply all scribe deltas mechanically (no LLM).
 * Phase 1 of the three-phase consolidation pipeline.
 */
export async function applyDeltas(sessionId: string): Promise<{ appliedCount: number; errors: string[] }> {
  activityBus.log("mechanical:start", `Mechanical apply starting for ${sessionId}`);

  const deltas = loadSessionDeltas(sessionId);
  if (deltas.length === 0) {
    activityBus.log("mechanical:complete", `No deltas to apply for ${sessionId}`);
    return { appliedCount: 0, errors: [] };
  }

  const errors: string[] = [];
  let appliedCount = 0;

  for (const delta of deltas) {
    try {
      let success = false;
      switch (delta.action) {
        case "create_node":
          success = handleCreateNode(delta, errors);
          break;
        case "update_confidence":
          success = handleUpdateConfidence(delta, errors);
          break;
        case "update_stance":
          success = handleUpdateStance(delta, errors);
          break;
        case "soma_signal":
          success = handleSomaSignal(delta, errors);
          break;
        case "create_edge":
          success = handleCreateEdge(delta, errors);
          break;
        case "create_anti_edge":
          success = handleCreateAntiEdge(delta, errors);
          break;
        default:
          errors.push(`Unknown delta action: ${delta.action}`);
          break;
      }
      if (success) appliedCount++;
    } catch (err: any) {
      errors.push(`Delta failed (${delta.action} on ${delta.path}): ${err.message}`);
    }
  }

  // After all deltas applied, rebuild MAP and index
  try {
    fullRegenerateMAP();
  } catch (err: any) {
    errors.push(`MAP regeneration failed: ${err.message}`);
  }

  try {
    rebuildIndex();
  } catch (err: any) {
    errors.push(`Index rebuild failed: ${err.message}`);
  }

  activityBus.log("mechanical:complete", `Mechanical apply done: ${appliedCount} applied, ${errors.length} errors`, {
    appliedCount,
    errorCount: errors.length,
  });

  return { appliedCount, errors };
}
