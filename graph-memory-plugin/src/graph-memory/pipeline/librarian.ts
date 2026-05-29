/**
 * Phase 2: Librarian — graph reasoning agent.
 *
 * The librarian no longer handles CRUD from scribe deltas (that's mechanical-apply.ts).
 * Instead, it receives the post-Phase-1 MAP and focuses on:
 * - Topology optimization (break_off, promote, relocate)
 * - Merging overlapping nodes
 * - Archiving stale/superseded nodes
 * - Contradiction detection
 * - Behavioral priors
 * - Content compaction
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { safePath, walkNodes, getNodeDepth } from "../utils.js";
import {
  validateEdgeType,
  updatePriors,
  regenerateCoreContextFiles,
} from "./graph-ops.js";

// --- LibrarianResult interface (graph reasoning only) ---

export interface LibrarianResult {
  restructure: Array<
    | {
        action: "break_off";
        parent: string;
        children: Array<{ path: string; gist: string; content: string }>;
        new_parent_content: string;
      }
    | { action: "promote"; path: string; new_path: string; reason: string }
    | { action: "relocate"; path: string; new_path: string; reason: string }
  >;
  merge: Array<{ absorb: string; into: string; reason: string }>;
  archive: Array<{ path: string; reason: string }>;
  contradictions: Array<{ a: string; b: string; resolution: string }>;
  new_priors: string[];
  remove_priors: string[];
  compact: Array<{ path: string; new_content: string }>;
  pin: Array<{ path: string; reason: string }>;
  unpin: Array<{ path: string; reason: string }>;
}

/**
 * Build librarian input from audit context + five context files.
 * Post-auditor: the librarian receives pre-digested recommendations, not raw deltas.
 */
export function buildLibrarianInput(sessionId?: string): string | null {
  let map = "_Empty graph._";
  if (fs.existsSync(CONFIG.paths.map)) {
    map = fs.readFileSync(CONFIG.paths.map, "utf-8");
  }

  if (map === "_Empty graph._") return null;

  // Still check if there are enough nodes to warrant reasoning
  const nodesDir = CONFIG.paths.nodes;
  let nodeCount = 0;
  if (fs.existsSync(nodesDir)) {
    for (const _ of walkNodes(nodesDir)) nodeCount++;
  }
  if (nodeCount < 3) return null;

  let input = "";

  // Audit brief (primary input — pre-digested by auditor)
  if (fs.existsSync(CONFIG.paths.auditBrief)) {
    input += `## Audit Brief\n\n${fs.readFileSync(CONFIG.paths.auditBrief, "utf-8")}\n\n`;
  }

  // Audit report (structured data)
  if (fs.existsSync(CONFIG.paths.auditReport)) {
    input += `## Audit Report (JSON)\n\n\`\`\`json\n${fs.readFileSync(CONFIG.paths.auditReport, "utf-8")}\n\`\`\`\n\n`;
  }

  // Five context files
  input += `## Current MAP\n\n${map}\n\n`;

  if (fs.existsSync(CONFIG.paths.priors)) {
    input += `## Current PRIORS\n\n${fs.readFileSync(CONFIG.paths.priors, "utf-8")}\n\n`;
  }

  if (fs.existsSync(CONFIG.paths.soma)) {
    input += `## Current SOMA\n\n${fs.readFileSync(CONFIG.paths.soma, "utf-8")}\n\n`;
  }

  if (fs.existsSync(CONFIG.paths.working)) {
    input += `## Current WORKING\n\n${fs.readFileSync(CONFIG.paths.working, "utf-8")}\n\n`;
  }

  if (fs.existsSync(CONFIG.paths.dreamsContext)) {
    input += `## Current DREAMS\n\n${fs.readFileSync(CONFIG.paths.dreamsContext, "utf-8")}\n\n`;
  }

  // Deep nodes for structural context
  const deepNodes: string[] = [];
  if (fs.existsSync(nodesDir)) {
    for (const { nodePath, filePath } of walkNodes(nodesDir)) {
      if (getNodeDepth(nodePath) > CONFIG.graph.maxMapDepth) {
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = matter(raw);
          const gist = parsed.data.gist || "";
          deepNodes.push(`- ${nodePath} — ${gist}`);
        } catch { /* skip */ }
      }
    }
  }

  if (deepNodes.length > 0) {
    input += `## Deep Nodes (not in MAP)\n\n${deepNodes.join("\n")}`;
  }

  return input;
}

/**
 * Apply librarian reasoning results to the graph.
 * Called by the consolidate action after subagent provides results,
 * or directly by the librarian subagent via compiled JS.
 */
export async function applyLibrarianResult(result: LibrarianResult) {
  // 1. Restructure operations
  for (const op of result.restructure) {
    try {
      switch (op.action) {
        case "break_off":
          applyBreakOff(op);
          break;
        case "promote":
          applyRelocate(op.path, op.new_path, `promote: ${op.reason}`);
          break;
        case "relocate":
          applyRelocate(op.path, op.new_path, `relocate: ${op.reason}`);
          break;
      }
    } catch (err: any) {
      activityBus.log("system:error", `Restructure ${op.action} failed: ${err.message}`);
    }
  }

  // 2. Merge operations
  for (const op of result.merge) {
    try {
      applyMerge(op.absorb, op.into, op.reason);
    } catch (err: any) {
      activityBus.log("system:error", `Merge ${op.absorb} → ${op.into} failed: ${err.message}`);
    }
  }

  // 3. Archive operations
  for (const op of result.archive) {
    try {
      const srcPath = safePath(CONFIG.paths.nodes, op.path, ".md");
      const destPath = safePath(CONFIG.paths.archive, op.path, ".md");
      if (!srcPath || !destPath || !fs.existsSync(srcPath)) continue;

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(srcPath, destPath);

      activityBus.log("graph:node_archived", `Librarian archived: ${op.path} — ${op.reason}`);
    } catch (err: any) {
      activityBus.log("system:error", `Archive ${op.path} failed: ${err.message}`);
    }
  }

  // 4. Contradictions — add contradicts edges between nodes
  for (const op of result.contradictions) {
    try {
      addContradictionEdge(op.a, op.b, op.resolution);
    } catch (err: any) {
      activityBus.log("system:error", `Contradiction edge ${op.a} ↔ ${op.b} failed: ${err.message}`);
    }
  }

  // 5. Compact operations
  for (const op of result.compact) {
    try {
      const filePath = safePath(CONFIG.paths.nodes, op.path, ".md");
      if (!filePath || !fs.existsSync(filePath)) continue;

      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      // Preserve frontmatter, replace markdown content
      parsed.data.updated = new Date().toISOString().slice(0, 10);
      const title = parsed.data.title || op.path.split("/").pop();
      const newBody = `# ${title}\n\n${op.new_content}`;
      fs.writeFileSync(filePath, matter.stringify(newBody, parsed.data));

      activityBus.log("graph:node_compacted", `Compacted: ${op.path}`);
    } catch (err: any) {
      activityBus.log("system:error", `Compact ${op.path} failed: ${err.message}`);
    }
  }

  // 6. Update priors
  if (result.new_priors.length > 0 || result.remove_priors.length > 0) {
    try {
      updatePriors(result.new_priors, result.remove_priors);
    } catch (err: any) {
      activityBus.log("system:error", `Priors update failed: ${err.message}`);
    }
  }

  // 7. Pin / unpin durable procedure nodes
  for (const op of result.pin) {
    try {
      setPinnedState(op.path, true, op.reason);
    } catch (err: any) {
      activityBus.log("system:error", `Pin ${op.path} failed: ${err.message}`);
    }
  }

  for (const op of result.unpin) {
    try {
      setPinnedState(op.path, false, op.reason);
    } catch (err: any) {
      activityBus.log("system:error", `Unpin ${op.path} failed: ${err.message}`);
    }
  }

  // 8. Recalculate parent confidence as weighted average of children
  try {
    recalcParentConfidence();
  } catch (err: any) {
    activityBus.log("system:error", `Parent confidence recalc failed: ${err.message}`);
  }

  // 9. Rebuild core context files. DREAMS.md is owned by the dreamer pass.
  try {
    regenerateCoreContextFiles();
  } catch (err: any) {
    activityBus.log("system:error", `Context file rebuild failed: ${err.message}`);
  }
}

function applyBreakOff(op: {
  parent: string;
  children: Array<{ path: string; gist: string; content: string }>;
  new_parent_content: string;
}) {
  const parentFile = safePath(CONFIG.paths.nodes, op.parent, ".md");
  if (!parentFile || !fs.existsSync(parentFile)) {
    activityBus.log("system:error", `Break-off parent not found: ${op.parent}`);
    return;
  }

  const parentRaw = fs.readFileSync(parentFile, "utf-8");
  const parentParsed = matter(parentRaw);

  // Create child nodes
  for (const child of op.children) {
    const childFile = safePath(CONFIG.paths.nodes, child.path, ".md");
    if (!childFile) continue;

    const childDir = path.dirname(childFile);
    if (!fs.existsSync(childDir)) fs.mkdirSync(childDir, { recursive: true });

    const now = new Date().toISOString().slice(0, 10);
    const childTitle = child.path.split("/").pop() || child.path;
    const fm: Record<string, any> = {
      id: child.path,
      title: childTitle,
      gist: child.gist,
      confidence: parentParsed.data.confidence || 0.5,
      created: now,
      updated: now,
      decay_rate: 0.05,
      tags: parentParsed.data.tags || [],
      keywords: parentParsed.data.keywords || [],
      edges: [{ target: op.parent, type: "derives_from", weight: 0.8 }],
    };

    const body = `# ${childTitle}\n\n${child.content}`;
    fs.writeFileSync(childFile, matter.stringify(body, fm));
    activityBus.log("graph:node_created", `Break-off child: ${child.path}`);
  }

  // Update parent: new content + contains edges to children
  const containsEdges = op.children.map(c => ({
    target: c.path,
    type: "contains",
    weight: 0.8,
  }));
  const existingEdges: any[] = Array.isArray(parentParsed.data.edges) ? parentParsed.data.edges : [];
  const existingTargets = new Set(existingEdges.map((e: any) => e.target));
  for (const edge of containsEdges) {
    if (!existingTargets.has(edge.target)) {
      existingEdges.push(edge);
    }
  }
  parentParsed.data.edges = existingEdges;
  parentParsed.data.updated = new Date().toISOString().slice(0, 10);

  const parentTitle = parentParsed.data.title || op.parent.split("/").pop();
  const newParentBody = `# ${parentTitle}\n\n${op.new_parent_content}`;
  fs.writeFileSync(parentFile, matter.stringify(newParentBody, parentParsed.data));

  activityBus.log("graph:node_restructured", `Break-off complete: ${op.parent} → ${op.children.length} children`);
}

function applyRelocate(oldPath: string, newPath: string, reason: string) {
  const srcFile = safePath(CONFIG.paths.nodes, oldPath, ".md");
  const destFile = safePath(CONFIG.paths.nodes, newPath, ".md");
  if (!srcFile || !destFile || !fs.existsSync(srcFile)) {
    activityBus.log("system:error", `Relocate source not found: ${oldPath}`);
    return;
  }

  // Don't overwrite an existing node at the destination
  if (fs.existsSync(destFile)) {
    activityBus.log("system:error", `Relocate destination already exists: ${newPath} — skipping`);
    return;
  }

  // Move file
  const destDir = path.dirname(destFile);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const raw = fs.readFileSync(srcFile, "utf-8");
  const parsed = matter(raw);
  parsed.data.id = newPath;
  parsed.data.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(destFile, matter.stringify(parsed.content, parsed.data));
  fs.unlinkSync(srcFile);

  // Clean up empty parent directories
  try {
    let dir = path.dirname(srcFile);
    while (dir !== CONFIG.paths.nodes) {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  } catch { /* skip */ }

  // Update edge references across the graph
  updateEdgeReferences(oldPath, newPath);

  activityBus.log("graph:node_relocated", `${oldPath} → ${newPath} (${reason})`);
}

function applyMerge(absorbPath: string, intoPath: string, reason: string) {
  if (absorbPath === intoPath) {
    activityBus.log("system:error", `Merge: cannot merge node into itself: ${absorbPath}`);
    return;
  }
  const absorbFile = safePath(CONFIG.paths.nodes, absorbPath, ".md");
  const intoFile = safePath(CONFIG.paths.nodes, intoPath, ".md");
  if (!absorbFile || !intoFile) return;
  if (!fs.existsSync(absorbFile) || !fs.existsSync(intoFile)) {
    activityBus.log("system:error", `Merge: one or both nodes not found: ${absorbPath}, ${intoPath}`);
    return;
  }

  const absorbRaw = fs.readFileSync(absorbFile, "utf-8");
  const absorbParsed = matter(absorbRaw);
  const intoRaw = fs.readFileSync(intoFile, "utf-8");
  const intoParsed = matter(intoRaw);

  // Merge confidence (take max)
  intoParsed.data.confidence = Math.max(
    intoParsed.data.confidence || 0.5,
    absorbParsed.data.confidence || 0.5
  );

  // Merge edges (dedupe)
  const intoEdges: any[] = Array.isArray(intoParsed.data.edges) ? intoParsed.data.edges : [];
  const existingTargets = new Set(intoEdges.map((e: any) => e.target));
  existingTargets.add(intoPath);
  const absorbEdges: any[] = Array.isArray(absorbParsed.data.edges) ? absorbParsed.data.edges : [];
  for (const edge of absorbEdges) {
    if (!existingTargets.has(edge.target) && edge.target !== absorbPath) {
      intoEdges.push(edge);
      existingTargets.add(edge.target);
    }
  }
  intoParsed.data.edges = intoEdges;

  // Merge tags and keywords
  intoParsed.data.tags = [...new Set([...(intoParsed.data.tags || []), ...(absorbParsed.data.tags || [])])];
  intoParsed.data.keywords = [...new Set([...(intoParsed.data.keywords || []), ...(absorbParsed.data.keywords || [])])];

  // Append absorbed content if different
  const absorbContent = absorbParsed.content.trim();
  if (absorbContent && !intoParsed.content.includes(absorbContent.slice(0, 100))) {
    intoParsed.content = intoParsed.content.trimEnd() + `\n\n---\n_Merged from ${absorbPath}:_\n\n${absorbContent}`;
  }

  intoParsed.data.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(intoFile, matter.stringify(intoParsed.content, intoParsed.data));

  // Archive the absorbed node
  const archivePath = safePath(CONFIG.paths.archive, absorbPath, ".md");
  if (archivePath) {
    const archiveDir = path.dirname(archivePath);
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    absorbParsed.data.archived_reason = `merged into ${intoPath}: ${reason}`;
    absorbParsed.data.archived_date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(archivePath, matter.stringify(absorbParsed.content, absorbParsed.data));
  }
  fs.unlinkSync(absorbFile);

  // Update edge references from absorbed → into
  updateEdgeReferences(absorbPath, intoPath);

  activityBus.log("graph:node_merged", `Merged ${absorbPath} → ${intoPath}: ${reason}`);
}

function addContradictionEdge(pathA: string, pathB: string, resolution: string) {
  for (const [src, tgt] of [[pathA, pathB], [pathB, pathA]]) {
    const filePath = safePath(CONFIG.paths.nodes, src, ".md");
    if (!filePath || !fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    const edges: any[] = Array.isArray(parsed.data.edges) ? parsed.data.edges : [];
    const existingTargets = new Set(edges.map((e: any) => e.target));

    if (!existingTargets.has(tgt)) {
      edges.push({
        target: tgt,
        type: "contradicts",
        weight: 0.5,
      });
      parsed.data.edges = edges;
      parsed.data.updated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    }
  }

  activityBus.log("graph:node_updated", `Contradiction edge: ${pathA} ↔ ${pathB}: ${resolution}`);
}

function setPinnedState(nodePath: string, pinned: boolean, reason: string) {
  const filePath = safePath(CONFIG.paths.nodes, nodePath, ".md");
  if (!filePath || !fs.existsSync(filePath)) {
    activityBus.log("system:error", `${pinned ? "Pin" : "Unpin"} target not found: ${nodePath}`);
    return;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = matter(raw);

  if (pinned) {
    parsed.data.pinned = true;
  } else {
    delete parsed.data.pinned;
  }
  parsed.data.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));

  activityBus.log("graph:node_updated", `${pinned ? "Pinned" : "Unpinned"} ${nodePath}: ${reason}`);
}

/**
 * Update all edge references across the graph when a node is moved/merged.
 */
function updateEdgeReferences(oldPath: string, newPath: string) {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  for (const { filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      let changed = false;

      // Determine this node's own path to avoid self-edges
      const thisNodeId = parsed.data.id;

      if (parsed.data.edges) {
        for (const edge of parsed.data.edges) {
          if (edge.target === oldPath) {
            // Don't create self-edge
            if (thisNodeId === newPath || edge.target === thisNodeId) continue;
            edge.target = newPath;
            changed = true;
          }
        }
      }

      if (parsed.data.anti_edges) {
        for (const ae of parsed.data.anti_edges) {
          if (ae.target === oldPath) {
            if (thisNodeId === newPath) continue;
            ae.target = newPath;
            changed = true;
          }
        }
      }

      if (changed) {
        parsed.data.updated = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
      }
    } catch { /* skip */ }
  }
}

/**
 * Recalculate parent confidence as weighted average of children.
 */
function recalcParentConfidence() {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  // Build parent→children map from "contains" edges
  const parentChildren = new Map<string, string[]>();

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      for (const edge of Array.isArray(parsed.data.edges) ? parsed.data.edges : []) {
        if (edge.type === "contains") {
          if (!parentChildren.has(nodePath)) parentChildren.set(nodePath, []);
          parentChildren.get(nodePath)!.push(edge.target);
        }
      }
    } catch { /* skip */ }
  }

  // Update each parent's confidence
  for (const [parentPath, children] of parentChildren) {
    const parentFile = safePath(CONFIG.paths.nodes, parentPath, ".md");
    if (!parentFile || !fs.existsSync(parentFile)) continue;

    const childConfidences: number[] = [];
    for (const childPath of children) {
      const childFile = safePath(CONFIG.paths.nodes, childPath, ".md");
      if (!childFile || !fs.existsSync(childFile)) continue;
      try {
        const raw = fs.readFileSync(childFile, "utf-8");
        const parsed = matter(raw);
        childConfidences.push(typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5);
      } catch { /* skip */ }
    }

    if (childConfidences.length > 0) {
      const avg = childConfidences.reduce((a, b) => a + b, 0) / childConfidences.length;
      try {
        const raw = fs.readFileSync(parentFile, "utf-8");
        const parsed = matter(raw);
        parsed.data.confidence = Math.round(avg * 1000) / 1000;
        parsed.data.updated = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(parentFile, matter.stringify(parsed.content, parsed.data));
      } catch { /* skip */ }
    }
  }
}
