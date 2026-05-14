/**
 * Compressor structured tools — processes JSON output files from the compressor agent.
 *
 * The compressor agent writes JSON files to .pipeline/observations/.
 * This module reads those files and applies them:
 *   - update_model() → writes to mind/model.json or lenses/{project}/model.json
 *   - generate_whisper() → writes to mind/whisper.txt or lenses/{project}/whisper.txt
 *   - archive_observations() → marks observations as absorbed
 *   - archive_graph_nodes() → moves nodes to graph/.archive/
 *   - prune_session_logs() → removes old session log entries
 *   - flag_for_deep_audit() → creates a flag file
 */
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { GlobalModel, GlobalModelFile } from "../mind/types.js";
import { readModel, writeModel } from "../mind/model.js";
import { readModel as readProjectModel, writeModel as writeProjectModel } from "../lenses/manager.js";
import { ProjectModelFile } from "../lenses/types.js";
import { readWhisper, writeWhisper, enforceWhisperCap, estimateTokens } from "../mind/whisper.js";
import { readWhisper as readProjectWhisper, writeWhisper as writeProjectWhisper } from "../lenses/manager.js";
import { markObservationsAbsorbed, pruneObservations, observationFileSize } from "../mind/observations.js";
import { markObservationsAbsorbed as markProjectObservationsAbsorbed, pruneObservations as pruneProjectObservations } from "../lenses/manager.js";
import { pruneSessionLogs } from "../sessions/manager.js";
import { removeFromIndex as removeFromV3Index } from "./graph-index-v3.js";

export interface CompressorToolResult {
  modelsUpdated: string[];
  whispersGenerated: string[];
  observationsAbsorbed: number;
  observationsPruned: number;
  sessionLogsPruned: number;
  graphNodesArchived: number;
  deepAuditFlagged: boolean;
  errors: string[];
}

interface UpdateModelCall {
  tool: "update_model";
  layer: "global" | "project";
  project?: string;
  model_json: string;
}

interface GenerateWhisperCall {
  tool: "generate_whisper";
  layer: "global" | "project";
  project?: string;
  whisper_text: string;
}

interface ArchiveObservationsCall {
  tool: "archive_observations";
  layer: "global" | "project";
  project?: string;
  ids: string[];
}

interface ArchiveGraphNodesCall {
  tool: "archive_graph_nodes";
  paths: string[];
  reason: string;
}

interface PruneSessionLogsCall {
  tool: "prune_session_logs";
  project?: string;
  older_than_days: number;
}

interface FlagDeepAuditCall {
  tool: "flag_for_deep_audit";
  reason: string;
}

type CompressorToolCall =
  | UpdateModelCall
  | GenerateWhisperCall
  | ArchiveObservationsCall
  | ArchiveGraphNodesCall
  | PruneSessionLogsCall
  | FlagDeepAuditCall;

const VALID_TOOLS = new Set([
  "update_model", "generate_whisper", "archive_observations",
  "archive_graph_nodes", "prune_session_logs", "flag_for_deep_audit",
]);

export function processCompressorOutputs(): CompressorToolResult {
  const result: CompressorToolResult = {
    modelsUpdated: [],
    whispersGenerated: [],
    observationsAbsorbed: 0,
    observationsPruned: 0,
    sessionLogsPruned: 0,
    graphNodesArchived: 0,
    deepAuditFlagged: false,
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
      if (!raw || !raw.tool || !VALID_TOOLS.has(raw.tool)) {
        continue;
      }

      const call = raw as CompressorToolCall;

      switch (call.tool) {
        case "update_model":
          processUpdateModel(call);
          result.modelsUpdated.push(call.layer === "project" ? (call.project || "unknown") : "global");
          break;
        case "generate_whisper":
          processGenerateWhisper(call);
          result.whispersGenerated.push(call.layer === "project" ? (call.project || "unknown") : "global");
          break;
        case "archive_observations":
          result.observationsAbsorbed += processArchiveObservations(call);
          break;
        case "archive_graph_nodes":
          result.graphNodesArchived += processArchiveGraphNodes(call);
          break;
        case "prune_session_logs":
          result.sessionLogsPruned += processPruneSessionLogs(call);
          break;
        case "flag_for_deep_audit":
          processFlagDeepAudit(call);
          result.deepAuditFlagged = true;
          break;
      }

      fs.unlinkSync(filePath);
    } catch (err: any) {
      result.errors.push("Error processing " + file + ": " + err.message);
    }
  }

  if (result.modelsUpdated.length > 0 || result.whispersGenerated.length > 0) {
    activityBus.log("system:info", "Compressor outputs processed", {
      modelsUpdated: result.modelsUpdated,
      whispersGenerated: result.whispersGenerated,
      observationsAbsorbed: result.observationsAbsorbed,
      graphNodesArchived: result.graphNodesArchived,
    });
  }

  return result;
}

function processUpdateModel(call: UpdateModelCall): void {
  try {
    const modelData = JSON.parse(call.model_json);

    if (call.layer === "global") {
      const current = readModel();
      const updated: GlobalModelFile = {
        ...current,
        model: {
          ...modelData,
          version: 3,
          generatedAt: new Date().toISOString(),
          tokenEstimate: estimateTokens(JSON.stringify(modelData)),
        } as GlobalModel,
        lastCompressorRun: new Date().toISOString(),
        observationCount: current.observationCount,
      };
      writeModel(updated);
    } else if (call.project) {
      const current = readProjectModel(call.project);
      const updated: ProjectModelFile = {
        ...current,
        model: {
          ...modelData,
          version: 3,
          project: call.project,
          generatedAt: new Date().toISOString(),
          tokenEstimate: estimateTokens(JSON.stringify(modelData)),
        },
        lastCompressorRun: new Date().toISOString(),
        observationCount: current.observationCount,
        lastSessionAt: new Date().toISOString(),
      };
      writeProjectModel(call.project, updated);
    }
  } catch (err: any) {
    activityBus.log("system:error", "Failed to update model: " + err.message);
  }
}

function processGenerateWhisper(call: GenerateWhisperCall): void {
  const text = call.whisper_text || "";

  if (call.layer === "global") {
    const capped = enforceWhisperCap(text);
    writeWhisper(capped);
  } else if (call.project) {
    const projectCap = 500 * 4;
    const capped = text.length > projectCap ? text.slice(0, projectCap) : text;
    writeProjectWhisper(call.project, capped);
  }
}

function processArchiveObservations(call: ArchiveObservationsCall): number {
  if (!call.ids || call.ids.length === 0) return 0;

  if (call.layer === "global") {
    markObservationsAbsorbed(call.ids);
  } else if (call.project) {
    markProjectObservationsAbsorbed(call.project, call.ids);
  }

  return call.ids.length;
}

function processArchiveGraphNodes(call: ArchiveGraphNodesCall): number {
  if (!call.paths || call.paths.length === 0) return 0;

  const archiveDir = CONFIG.paths.v3GraphArchive;
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  let archived = 0;
  for (const nodePath of call.paths) {
    const srcDir = path.join(CONFIG.paths.v3Graph);
    const srcFile = findNodeFile(srcDir, nodePath);
    if (!srcFile) continue;

    const destDir = path.join(archiveDir, path.dirname(nodePath));
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const destFile = path.join(archiveDir, nodePath + ".md");
    try {
      const content = fs.readFileSync(srcFile, "utf-8");
      const updated = content.replace(/^---\n([\s\S]*?)---\n/m, (match, fm) => {
        const lines = fm.split("\n");
        if (!lines.some((l: string) => l.startsWith("archived_reason:"))) {
          lines.push("archived_reason: \"" + (call.reason || "low confidence") + "\"");
        }
        if (!lines.some((l: string) => l.startsWith("archived_date:"))) {
          lines.push("archived_date: \"" + new Date().toISOString().slice(0, 10) + "\"");
        }
        return "---\n" + lines.join("\n") + "\n---\n";
      });

      fs.writeFileSync(destFile, updated);
      fs.unlinkSync(srcFile);
      try { removeFromV3Index(nodePath); } catch { /* non-critical */ }
      archived++;
    } catch (err: any) {
      activityBus.log("system:error", "Failed to archive node " + nodePath + ": " + err.message);
    }
  }

  return archived;
}

function findNodeFile(baseDir: string, nodePath: string): string | null {
  const directPath = path.join(baseDir, nodePath + ".md");
  if (fs.existsSync(directPath)) return directPath;

  const categories = fs.readdirSync(baseDir).filter((f) => {
    const p = path.join(baseDir, f);
    return fs.statSync(p).isDirectory() && !f.startsWith(".");
  });

  for (const cat of categories) {
    const candidate = path.join(baseDir, cat, nodePath + ".md");
    if (fs.existsSync(candidate)) return candidate;

    const catFiles = fs.readdirSync(path.join(baseDir, cat));
    for (const f of catFiles) {
      if (f.endsWith(".md")) {
        const name = f.replace(/\.md$/, "");
        if (name === nodePath || nodePath.endsWith("/" + name)) {
          return path.join(baseDir, cat, f);
        }
      }
    }
  }

  return null;
}

function processPruneSessionLogs(call: PruneSessionLogsCall): number {
  const days = call.older_than_days || 30;
  if (call.project) {
    return pruneSessionLogs(call.project, days);
  }

  const sessionsDir = CONFIG.paths.v3Sessions;
  if (!fs.existsSync(sessionsDir)) return 0;

  let total = 0;
  for (const file of fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))) {
    const project = file.replace(".jsonl", "");
    total += pruneSessionLogs(project, days);
  }
  return total;
}

function processFlagDeepAudit(call: FlagDeepAuditCall): void {
  const flagPath = path.join(CONFIG.paths.v3Graph, ".deep-audit-flag");
  fs.writeFileSync(flagPath, JSON.stringify({
    reason: call.reason,
    flaggedAt: new Date().toISOString(),
  }, null, 2));

  activityBus.log("system:info", "Deep audit flagged: " + call.reason);
}

export function runAutoPrune(): { observationsPruned: number; fileSizeChecked: boolean } {
  let observationsPruned = 0;

  observationsPruned += pruneObservations(30);

  const maxFileSize = 500 * 1024;
  if (observationFileSize() > maxFileSize) {
    observationsPruned += pruneObservations(7);
  }

  return { observationsPruned, fileSizeChecked: true };
}
