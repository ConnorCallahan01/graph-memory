/**
 * Observer structured tools — processes JSON output files from the observer agent.
 *
 * The observer agent writes JSON files to .pipeline/observations/.
 * This module reads those files and applies them to the graph:
 *   - observe() → writes to mind/observations.jsonl or lenses/{project}/observations.jsonl
 *   - log_session() → writes to sessions/{project}.jsonl
 *   - upsert_node() → writes/updates graph/{category}/{path}.md
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { appendObservation } from "../mind/observations.js";
import { appendObservation as appendProjectObservation } from "../lenses/manager.js";
import { appendSessionLog } from "../sessions/manager.js";
import { ensureLens } from "../lenses/manager.js";
import { safePath } from "../utils.js";
import { rebuildIndex, validateEdgeType } from "./graph-ops.js";
import { addToIndex } from "./graph-index.js";
import { ObservationType } from "../mind/types.js";

export interface ObserverToolResult {
  observationsCreated: number;
  sessionLogged: boolean;
  nodesUpserted: number;
  errors: string[];
}

interface ObserveCall {
  tool: "observe";
  layer: "global" | "project";
  project?: string;
  type: ObservationType;
  observation: string;
  evidence: string[];
  confidence: number;
}

interface LogSessionCall {
  tool: "log_session";
  project: string;
  active_work: string[];
  shipped: string[];
  decisions: string[];
  blocked: string[];
  open_threads: string[];
  corrections_given: string[];
  next_session_should: string;
}

interface UpsertNodeCall {
  tool: "upsert_node";
  path: string;
  category: string;
  gist: string;
  content: string;
  confidence: number;
  anti_pattern?: boolean;
  tags?: string[];
  edges?: Array<{ target: string; type: string }>;
}

type ObserverToolCall = ObserveCall | LogSessionCall | UpsertNodeCall;

export function processObserverOutputs(
  sessionId: string,
  project?: string
): ObserverToolResult {
  const result: ObserverToolResult = {
    observationsCreated: 0,
    sessionLogged: false,
    nodesUpserted: 0,
    errors: [],
  };

  const obsDir = CONFIG.paths.pipelineObservations;
  if (!fs.existsSync(obsDir)) return result;

  const files = fs.readdirSync(obsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  for (const file of files) {
    const filePath = path.join(obsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const call = parseToolCall(raw);
      if (!call) {
        fs.unlinkSync(filePath);
        continue;
      }

      switch (call.tool) {
        case "observe":
          processObserve(call, sessionId);
          result.observationsCreated++;
          break;
        case "log_session":
          processLogSession(call, sessionId);
          result.sessionLogged = true;
          break;
        case "upsert_node":
          processUpsertNode(call);
          result.nodesUpserted++;
          break;
      }

      fs.unlinkSync(filePath);
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
  }

  if (result.nodesUpserted > 0) {
    try { rebuildIndex(); } catch (err: any) {
      result.errors.push(`Index rebuild failed after observer upserts: ${err.message}`);
    }
  }

  if (result.observationsCreated > 0 || result.sessionLogged) {
    activityBus.log("observer:complete", "Observer outputs processed", {
      sessionId,
      project: project || "global",
      observations: result.observationsCreated,
      sessionLogged: result.sessionLogged,
      nodesUpserted: result.nodesUpserted,
      errors: result.errors.length,
    });
  }

  return result;
}

function parseToolCall(raw: any): ObserverToolCall | null {
  if (!raw || typeof raw !== "object" || !raw.tool) return null;
  if (raw.tool === "observe" || raw.tool === "log_session" || raw.tool === "upsert_node") {
    return raw as ObserverToolCall;
  }
  return null;
}

function processObserve(call: ObserveCall, sessionId: string): void {
  const confidence = Math.max(call.confidence || 0.5, 0);

  if (call.layer === "project" && call.project) {
    ensureLens(call.project);
    appendProjectObservation(call.project, {
      type: call.type,
      observation: call.observation,
      evidence: call.evidence,
      confidence,
      sessionId,
    });
  } else {
    appendObservation({
      layer: "global",
      type: call.type,
      observation: call.observation,
      evidence: call.evidence,
      confidence,
      sessionId,
    });
  }
}

function processLogSession(call: LogSessionCall, sessionId: string): void {
  appendSessionLog({
    project: call.project || "global",
    sessionId,
    activeWork: call.active_work || [],
    shipped: call.shipped || [],
    decisions: call.decisions || [],
    blocked: call.blocked || [],
    openThreads: call.open_threads || [],
    correctionsGiven: call.corrections_given || [],
    nextSessionShould: call.next_session_should || "",
  });
}

function processUpsertNode(call: UpsertNodeCall): void {
  const nodePath = safePath(CONFIG.paths.nodes, call.path, ".md");
  if (!nodePath) return;

  const now = new Date().toISOString().slice(0, 10);

  if (fs.existsSync(nodePath)) {
    try {
      const raw = fs.readFileSync(nodePath, "utf-8");
      const parsed = matter(raw);

      if (call.confidence > (parsed.data.confidence || 0)) {
        parsed.data.confidence = call.confidence;
      }
      if (call.tags) {
        parsed.data.tags = [...new Set([...(parsed.data.tags || []), ...call.tags])];
      }
      if (call.edges) {
        const existingEdges: any[] = Array.isArray(parsed.data.edges) ? parsed.data.edges : [];
        const existingTargets = new Set(existingEdges.map((e: any) => e.target));
        for (const edge of call.edges) {
          if (!existingTargets.has(edge.target)) {
            existingEdges.push({
              target: edge.target,
              type: validateEdgeType(edge.type),
              weight: 0.5,
            });
          }
        }
        parsed.data.edges = existingEdges;
      }
      if (call.anti_pattern) {
        parsed.data.anti_pattern = true;
        parsed.data.decay_exempt = true;
      }
      if (call.gist) parsed.data.gist = call.gist;
      if (call.content && !parsed.content.includes(call.content.slice(0, 100))) {
        parsed.content = parsed.content.trimEnd() + "\n\n---\n\n" + call.content;
      }
      parsed.data.updated = now;

      fs.writeFileSync(nodePath, matter.stringify(parsed.content, parsed.data));
      addToIndex(call.path, nodePath);
    } catch (err: any) {
      activityBus.log("observer:error", `Failed to update node ${call.path}: ${err.message}`);
    }
    return;
  }

  const dir = path.dirname(nodePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fm: Record<string, any> = {
    id: call.path,
    gist: call.gist,
    confidence: call.confidence ?? 0.6,
    created: now,
    updated: now,
    decay_rate: 0.05,
    tags: call.tags || [],
    category: call.category,
  };

  if (call.anti_pattern) {
    fm.anti_pattern = true;
    fm.decay_exempt = true;
    fm.confidence = Math.max(fm.confidence, 0.85);
  }

  if (call.edges && call.edges.length > 0) {
    fm.edges = call.edges.map((e) => ({
      target: e.target,
      type: validateEdgeType(e.type),
      weight: 0.5,
    }));
  }

  const body = "# " + (call.path.split("/").pop() || call.path) + "\n\n" + (call.content || "");
  fs.writeFileSync(nodePath, matter.stringify(body, fm));
  addToIndex(call.path, nodePath);
}
