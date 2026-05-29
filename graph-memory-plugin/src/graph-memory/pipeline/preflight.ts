/**
 * Preflight Report — deterministic graph analysis for librarian optimization.
 *
 * Runs pure filesystem reads (no LLM). Produces a JSON report that the
 * librarian reads instead of scanning the graph itself, saving dozens of
 * tool calls and tens of thousands of tokens.
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { walkNodes, getNodeDepth } from "../utils.js";
import { getProjectPreflightPath, ensureAuditDirectories } from "../working-files.js";

export interface PreflightManifestEntry {
  path: string;
  confidence: number;
  depth: number;
  edgeCount: number;
  updated: string;
}

export interface PreflightFlag {
  orphanedEdges: Array<{ node: string; edge: string; reason: string }>;
  duplicateStances: Array<{ node: string; count: number }>;
  archiveCandidates: Array<{ node: string; confidence: number }>;
  depthCandidates: Array<{ prefix: string; count: number; nodes: string[] }>;
}

export interface PreflightReport {
  generated: string;
  summary: {
    totalNodes: number;
    totalEdges: number;
    avgConfidence: number;
    categoryCounts: Record<string, number>;
    depthDistribution: Record<string, number>;
  };
  manifest: PreflightManifestEntry[];
  flags: PreflightFlag;
  flaggedNodeContents: Record<string, string>;
}

/**
 * Generate a preflight report by scanning all nodes in the graph.
 * Pure filesystem — no LLM, no network. Typically completes in <1s.
 */
export function generatePreflightReport(project?: string): PreflightReport {
  const validPaths = new Set<string>();
  const manifest: PreflightManifestEntry[] = [];
  const categoryCounts: Record<string, number> = {};
  const depthDistribution: Record<string, number> = {};
  const flaggedNodeContents: Record<string, string> = {};

  const orphanedEdges: PreflightFlag["orphanedEdges"] = [];
  const duplicateStances: PreflightFlag["duplicateStances"] = [];
  const archiveCandidates: PreflightFlag["archiveCandidates"] = [];

  // Per-node parsed data for edge checking (second pass)
  const nodeData: Array<{
    nodePath: string;
    filePath: string;
    confidence: number;
    edges: Array<{ target: string }>;
    content: string;
    rawFile: string;
  }> = [];

  let totalEdges = 0;
  let totalConfidence = 0;

  // First pass: read all nodes, build manifest and collect data
  for (const { nodePath, filePath } of walkNodes(CONFIG.paths.nodes)) {
    const topLevelCategory = nodePath.split("/")[0];
    // Ignore hidden/stale categories inside nodes/. Archived material belongs in CONFIG.paths.archive.
    if (topLevelCategory.startsWith(".") || topLevelCategory === "archive") {
      continue;
    }

    validPaths.add(nodePath);

    let rawFile: string;
    try {
      rawFile = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(rawFile);
    } catch {
      continue;
    }

    const confidence = parsed.data.confidence ?? 0.5;
    const rawEdges = parsed.data.edges;
    const edges: Array<{ target: string }> = Array.isArray(rawEdges) ? rawEdges : [];
    const depth = getNodeDepth(nodePath);
    const updated = parsed.data.updated || parsed.data.created || "";

    if (project) {
      const nodeProject = String(parsed.data.project || "").trim();
      if (nodeProject && nodeProject !== project) continue;
    }

    manifest.push({
      path: nodePath,
      confidence,
      depth,
      edgeCount: edges.length,
      updated: String(updated),
    });

    totalEdges += edges.length;
    totalConfidence += confidence;

    // Category count (top-level prefix)
    const category = topLevelCategory;
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    // Depth distribution
    const depthKey = String(depth);
    depthDistribution[depthKey] = (depthDistribution[depthKey] || 0) + 1;

    nodeData.push({
      nodePath,
      filePath,
      confidence,
      edges,
      content: parsed.content,
      rawFile,
    });
  }

  // Second pass: flag issues
  for (const node of nodeData) {
    let flagged = false;

    // Orphaned edges
    for (const edge of node.edges) {
      if (edge.target && !validPaths.has(edge.target)) {
        orphanedEdges.push({
          node: node.nodePath,
          edge: edge.target,
          reason: "target not found",
        });
        flagged = true;
      }
    }

    // Duplicate stance blocks
    const stanceMatches = node.content.match(/_Stance update:_/g);
    if (stanceMatches && stanceMatches.length > 1) {
      duplicateStances.push({
        node: node.nodePath,
        count: stanceMatches.length,
      });
      flagged = true;
    }

    // Archive candidates
    if (node.confidence < CONFIG.graph.decayArchiveThreshold) {
      archiveCandidates.push({
        node: node.nodePath,
        confidence: node.confidence,
      });
      flagged = true;
    }

    // Include full content for flagged nodes
    if (flagged) {
      flaggedNodeContents[node.nodePath] = node.rawFile;
    }
  }

  // Depth restructuring candidates: prefixes with 6+ nodes sharing a sub-prefix
  const depthCandidates: PreflightFlag["depthCandidates"] = [];
  // Group depth-1 nodes by "category/subprefix" (first two segments of a hyphenated name)
  const subprefixGroups: Record<string, string[]> = {};
  for (const node of nodeData) {
    const depth = getNodeDepth(node.nodePath);
    if (depth !== 1) continue; // Only look at depth-1 nodes for grouping
    const parts = node.nodePath.split("/");
    if (parts.length !== 2) continue;
    const category = parts[0];
    const name = parts[1];
    const hyphenParts = name.split("-");
    if (hyphenParts.length < 2) continue;
    // Use "category/first-segment" as the grouping prefix
    const subprefix = `${category}/${hyphenParts[0]}-${hyphenParts[1]}`;
    if (!subprefixGroups[subprefix]) subprefixGroups[subprefix] = [];
    subprefixGroups[subprefix].push(node.nodePath);
  }
  for (const [prefix, nodes] of Object.entries(subprefixGroups)) {
    if (nodes.length >= 6) {
      depthCandidates.push({ prefix, count: nodes.length, nodes });
      // Include these node contents too
      for (const np of nodes) {
        if (!flaggedNodeContents[np]) {
          const nd = nodeData.find(n => n.nodePath === np);
          if (nd) flaggedNodeContents[np] = nd.rawFile;
        }
      }
    }
  }

  const report: PreflightReport = {
    generated: new Date().toISOString(),
    summary: {
      totalNodes: manifest.length,
      totalEdges,
      avgConfidence: manifest.length > 0 ? Math.round((totalConfidence / manifest.length) * 100) / 100 : 0,
      categoryCounts,
      depthDistribution,
    },
    manifest,
    flags: {
      orphanedEdges,
      duplicateStances,
      archiveCandidates,
      depthCandidates,
    },
    flaggedNodeContents,
  };

  // Write to disk
  const reportPath = project ? getProjectPreflightPath(project) : CONFIG.paths.preflightReport;
  if (project) ensureAuditDirectories(project);
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return report;
}
