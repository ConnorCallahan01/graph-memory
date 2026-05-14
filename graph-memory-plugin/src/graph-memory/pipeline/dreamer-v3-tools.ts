import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { readModel as readGlobalModel } from "../mind/model.js";
import { readModel as readProjectModel, listActiveLenses } from "../lenses/manager.js";
import { getAntiPatterns, search, getStats } from "./graph-index-v3.js";
import { regenerateDreamContext } from "./graph-ops.js";

export interface DreamerV3ToolResult {
  dreamsProposed: number;
  dreamsPromoted: number;
  errors: string[];
}

interface GetModelsCall {
  tool: "get_models";
}

interface GetGraphNodesCall {
  tool: "get_graph_nodes";
  category?: string;
  limit?: number;
}

interface GetAntiPatternsCall {
  tool: "get_anti_patterns";
}

interface ProposeDreamCall {
  tool: "propose_dream";
  fragment: string;
  references: string[];
  reasoning: string;
  type?: "connection" | "inversion" | "analogy" | "emergence" | "integration";
}

interface PromoteDreamCall {
  tool: "promote_dream";
  dream_file: string;
  reason: string;
  new_confidence: number;
}

type DreamerV3ToolCall =
  | GetModelsCall
  | GetGraphNodesCall
  | GetAntiPatternsCall
  | ProposeDreamCall
  | PromoteDreamCall;

const VALID_TOOLS = new Set([
  "get_models", "get_graph_nodes", "get_anti_patterns", "propose_dream", "promote_dream",
]);

export function buildDreamerV3Input(): string {
  const globalModel = readGlobalModel();
  const lenses = listActiveLenses();
  const stats = getStats();
  const antiPatterns = getAntiPatterns();

  const sections: string[] = [];

  sections.push("## Global Model\n");
  sections.push(JSON.stringify(globalModel.model, null, 2));
  sections.push("");

  for (const project of lenses) {
    try {
      const projectModel = readProjectModel(project);
      sections.push("## Project Model: " + project + "\n");
      sections.push(JSON.stringify(projectModel.model, null, 2));
      sections.push("");
    } catch { /* skip */ }
  }

  if (antiPatterns.length > 0) {
    sections.push("## Anti-Patterns\n");
    for (const ap of antiPatterns) {
      sections.push("- **" + ap.path + "**: " + ap.gist);
    }
    sections.push("");
  }

  sections.push("## Graph Stats\n");
  sections.push(JSON.stringify(stats, null, 2));
  sections.push("");

  const pending = loadPendingDreams();
  if (pending.length > 0) {
    sections.push("## Pending Dreams (" + pending.length + ")\n");
    for (const p of pending) {
      sections.push("### " + p.file);
      sections.push(JSON.stringify(p.content, null, 2));
      sections.push("");
    }
  }

  return sections.join("\n");
}

function loadPendingDreams(): Array<{ file: string; content: any }> {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (!fs.existsSync(pendingDir)) return [];

  const results: Array<{ file: string; content: any }> = [];
  for (const f of fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"))) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf-8"));
      results.push({ file: f, content });
    } catch { /* skip */ }
  }
  return results;
}

export function processDreamerV3Outputs(): DreamerV3ToolResult {
  const result: DreamerV3ToolResult = {
    dreamsProposed: 0,
    dreamsPromoted: 0,
    errors: [],
  };

  const obsDir = CONFIG.paths.v3PipelineObservations;
  if (!fs.existsSync(obsDir)) return result;

  const files = fs.readdirSync(obsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  for (const file of files) {
    const filePath = path.join(obsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!raw || !raw.tool || !VALID_TOOLS.has(raw.tool)) continue;

      const call = raw as DreamerV3ToolCall;

      switch (call.tool) {
        case "propose_dream":
          processProposeDream(call);
          result.dreamsProposed++;
          break;
        case "promote_dream":
          processPromoteDream(call);
          result.dreamsPromoted++;
          break;
        default:
          break;
      }

      fs.unlinkSync(filePath);
    } catch (err: any) {
      result.errors.push("Error processing " + file + ": " + err.message);
    }
  }

  enforceDreamCap();
  regenerateDreamContext();

  sweepOrphanedFiles(obsDir);

  if (result.dreamsProposed > 0 || result.dreamsPromoted > 0) {
    activityBus.log("system:info", "Dreamer v3 outputs processed", {
      dreamsProposed: result.dreamsProposed,
      dreamsPromoted: result.dreamsPromoted,
      errors: result.errors.length,
    });
  }

  return result;
}

function processProposeDream(call: ProposeDreamCall): void {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });

  const dreamFile = "dream_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) + ".json";
  const dream = {
    fragment: call.fragment,
    type: call.type || "connection",
    confidence: 0.3,
    nodes_referenced: call.references || [],
    reasoning: call.reasoning,
    source: "dreamer-v3",
    created: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(pendingDir, dreamFile), JSON.stringify(dream, null, 2));
}

function processPromoteDream(call: PromoteDreamCall): void {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  const srcPath = path.join(pendingDir, call.dream_file);
  if (!fs.existsSync(srcPath)) return;

  try {
    const dreamData = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
    dreamData.confidence = call.new_confidence;
    dreamData.promotion_reason = call.reason;
    dreamData.promoted_at = new Date().toISOString();

    if (call.new_confidence >= CONFIG.graph.dreamPromoteConfidence) {
      const integratedDir = path.join(CONFIG.paths.dreams, "integrated");
      if (!fs.existsSync(integratedDir)) fs.mkdirSync(integratedDir, { recursive: true });
      fs.writeFileSync(path.join(integratedDir, call.dream_file), JSON.stringify(dreamData, null, 2));
      fs.unlinkSync(srcPath);
    } else {
      fs.writeFileSync(srcPath, JSON.stringify(dreamData, null, 2));
    }
  } catch { /* skip */ }
}

function enforceDreamCap(): void {
  const pending = loadPendingDreams();
  const maxPending = CONFIG.graph.maxPendingDreams;
  if (pending.length <= maxPending) return;

  const sorted = [...pending].sort(
    (a, b) => (a.content.confidence || 0) - (b.content.confidence || 0)
  );
  const toArchive = sorted.slice(0, pending.length - maxPending);

  const archivedDir = path.join(CONFIG.paths.dreams, "archived");
  if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });

  for (const dream of toArchive) {
    try {
      const srcPath = path.join(CONFIG.paths.dreams, "pending", dream.file);
      dream.content.archived_reason = "hard_cap";
      dream.content.archived_date = new Date().toISOString();
      fs.writeFileSync(path.join(archivedDir, dream.file), JSON.stringify(dream.content, null, 2));
      fs.unlinkSync(srcPath);
    } catch { /* skip */ }
  }
}

const ALL_TOOL_NAMES = new Set([
  "observe", "log_session", "upsert_node",
  "update_model", "generate_whisper", "archive_observations", "archive_graph_nodes", "prune_session_logs", "flag_for_deep_audit",
  "propose_dream", "promote_dream",
]);

function sweepOrphanedFiles(obsDir: string): void {
  if (!fs.existsSync(obsDir)) return;
  const maxAgeMs = 4 * 60 * 60 * 1000;
  const now = Date.now();

  for (const file of fs.readdirSync(obsDir).filter((f) => f.endsWith(".json"))) {
    const filePath = path.join(obsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < maxAgeMs) continue;

      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (raw && raw.tool && ALL_TOOL_NAMES.has(raw.tool)) continue;

      fs.unlinkSync(filePath);
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* skip */ }
    }
  }
}
