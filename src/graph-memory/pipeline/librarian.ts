import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import yaml from "js-yaml";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { extractJSON } from "./parse-utils.js";
import { runDecay } from "./decay.js";
import { safePath, walkNodes, extractFirstParagraph } from "../utils.js";

const LIBRARIAN_PROMPT = fs.readFileSync(
  path.join(CONFIG.paths.projectRoot, "src/graph-memory/prompts/librarian.md"),
  "utf-8"
);

interface LibrarianResult {
  nodes_to_create: Array<{
    path: string;
    title: string;
    gist: string;
    tags: string[];
    keywords: string[];
    confidence: number;
    edges: Array<{ target: string; type: string; weight: number }>;
    anti_edges: Array<{ target: string; reason: string }>;
    soma?: { valence: string; intensity: number; marker: string };
    content: string;
  }>;
  nodes_to_update: Array<{
    path: string;
    changes: {
      confidence?: number;
      new_edges?: Array<{ target: string; type: string; weight: number }>;
      new_anti_edges?: Array<{ target: string; reason: string }>;
      soma?: { valence: string; intensity: number; marker: string };
      append_content?: string;
    };
  }>;
  nodes_to_archive: Array<{ path: string; reason: string }>;
  new_priors: string[];
  decayed_priors: string[];
  map_entries: Array<{ path: string; gist: string; edges: string[] }>;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

function loadSessionDeltas(sessionId: string): any | null {
  const deltaFile = path.join(CONFIG.paths.deltas, `${sessionId}.json`);
  if (!fs.existsSync(deltaFile)) return null;
  return JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
}

function buildLibrarianInput(sessionId: string): string | null {
  const deltas = loadSessionDeltas(sessionId);
  if (!deltas || deltas.scribes.length === 0) return null;

  let map = "_Empty graph._";
  if (fs.existsSync(CONFIG.paths.map)) {
    map = fs.readFileSync(CONFIG.paths.map, "utf-8");
  }

  let priors = "_No priors._";
  if (fs.existsSync(CONFIG.paths.priors)) {
    priors = fs.readFileSync(CONFIG.paths.priors, "utf-8");
  }

  const summaryChain = deltas.scribes.map((s: any) => s.summary).filter(Boolean);
  const allDeltas = deltas.scribes.flatMap((s: any) => s.deltas || []);

  // Load promoted dreams for librarian context
  let dreamsSection = "";
  const integratedDir = path.join(CONFIG.paths.dreams, "integrated");
  if (fs.existsSync(integratedDir)) {
    const dreamFiles = fs.readdirSync(integratedDir).filter(f => f.endsWith(".json"));
    if (dreamFiles.length > 0) {
      const dreams = dreamFiles.map(f => {
        const content = JSON.parse(fs.readFileSync(path.join(integratedDir, f), "utf-8"));
        return `- [${f}] ${content.fragment} (confidence: ${content.confidence})`;
      });
      dreamsSection = `\n\n## Promoted Dreams (consider creating nodes)\n\n${dreams.join("\n")}`;
    }
  }

  return `## Current MAP\n\n${map}\n\n## Current PRIORS\n\n${priors}\n\n## Session Summary Chain\n\n${summaryChain.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\n## Session Deltas (${allDeltas.length} total)\n\n${JSON.stringify(allDeltas, null, 2)}${dreamsSection}`;
}

export async function runLibrarian(sessionId: string): Promise<void> {
  activityBus.log("librarian:start", `Librarian starting for ${sessionId}`);
  const startTime = Date.now();

  const input = buildLibrarianInput(sessionId);
  if (!input) {
    activityBus.log("librarian:complete", "Librarian skipped — no deltas to process.");
    return;
  }

  try {
    const response = await getClient().messages.create({
      model: CONFIG.models.librarian,
      max_tokens: CONFIG.maxTokens.librarian,
      temperature: CONFIG.temperature.librarian,
      system: LIBRARIAN_PROMPT,
      messages: [
        { role: "user", content: input },
        { role: "assistant", content: "{" },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from librarian");
    }

    // Prepend the prefill brace back
    const result: LibrarianResult = extractJSON<LibrarianResult>("{" + textBlock.text);
    const elapsed = Date.now() - startTime;

    // Apply changes
    await applyLibrarianResult(result);

    activityBus.log("librarian:complete", `Librarian complete in ${elapsed}ms — ${result.nodes_to_create.length} created, ${result.nodes_to_update.length} updated, ${result.nodes_to_archive.length} archived`, {
      elapsed,
      created: result.nodes_to_create.length,
      updated: result.nodes_to_update.length,
      archived: result.nodes_to_archive.length,
      newPriors: result.new_priors.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    activityBus.log("librarian:error", `Librarian failed after ${elapsed}ms: ${err.message}`, {
      error: err.message,
    });

    // Retry once
    try {
      activityBus.log("librarian:start", "Librarian retrying...");
      await new Promise((r) => setTimeout(r, 2000));

      const response = await getClient().messages.create({
        model: CONFIG.models.librarian,
        max_tokens: CONFIG.maxTokens.librarian,
        temperature: CONFIG.temperature.librarian,
        system: LIBRARIAN_PROMPT,
        messages: [
          { role: "user", content: input },
          { role: "assistant", content: "{" },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") throw new Error("No text in retry");

      const result: LibrarianResult = extractJSON<LibrarianResult>("{" + textBlock.text);
      await applyLibrarianResult(result);

      activityBus.log("librarian:complete", `Librarian retry succeeded — ${result.nodes_to_create.length} created, ${result.nodes_to_update.length} updated`);
    } catch (retryErr: any) {
      activityBus.log("librarian:error", `Librarian retry failed: ${retryErr.message}. Deltas preserved for next session.`);
    }
  }
}

const VALID_EDGE_TYPES = new Set([
  "relates_to",
  "contradicts",
  "supports",
  "derives_from",
  "pattern_transfer",
]);

function validateEdgeType(type: string): string {
  if (VALID_EDGE_TYPES.has(type)) return type;
  activityBus.log("system:error", `Invalid edge type "${type}" from LLM — defaulting to relates_to`);
  return "relates_to";
}

async function applyLibrarianResult(result: LibrarianResult) {
  // 0. Run decay pass first — reinforced nodes get their timestamps reset
  try {
    const reinforcedPaths = new Set<string>();
    for (const u of result.nodes_to_update) reinforcedPaths.add(u.path);
    runDecay(reinforcedPaths);
  } catch (err: any) {
    activityBus.log("system:error", `Failed during decay pass: ${err.message}`);
  }

  // 1. Create new nodes
  try {
    for (const node of result.nodes_to_create) {
      const filePath = safePath(CONFIG.paths.nodes, node.path, ".md");
      if (!filePath) {
        activityBus.log("system:error", `Invalid node path from LLM: ${node.path}`);
        continue;
      }

      const nodeDir = path.dirname(filePath);
      if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });

      const now = new Date().toISOString().slice(0, 10);
      const frontmatterData: Record<string, any> = {
        id: node.path,
        title: node.title,
        gist: node.gist,
        confidence: node.confidence,
        created: now,
        updated: now,
        decay_rate: 0.05,
        tags: node.tags,
        keywords: node.keywords,
      };

      if (node.edges.length > 0) {
        frontmatterData.edges = node.edges.map(e => ({
          ...e,
          type: validateEdgeType(e.type),
        }));
      }
      if (node.anti_edges && node.anti_edges.length > 0) {
        frontmatterData.anti_edges = node.anti_edges;
      }
      if (node.soma) {
        frontmatterData.soma = node.soma;
      }

      const body = `# ${node.title}\n\n${node.content}`;
      const fullContent = matter.stringify(body, frontmatterData);
      fs.writeFileSync(filePath, fullContent);

      activityBus.log("graph:node_created", `Created node: ${node.path}`, {
        path: node.path,
        confidence: node.confidence,
      });
    }
  } catch (err: any) {
    activityBus.log("system:error", `Failed during node creation: ${err.message}`);
  }

  // 2. Update existing nodes (with proper frontmatter merging via gray-matter)
  try {
    for (const update of result.nodes_to_update) {
      const filePath = safePath(CONFIG.paths.nodes, update.path, ".md");
      if (!filePath) {
        activityBus.log("system:error", `Invalid update path from LLM: ${update.path}`);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        activityBus.log("system:error", `Cannot update non-existent node: ${update.path}`);
        continue;
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      // Merge confidence
      if (update.changes.confidence !== undefined) {
        parsed.data.confidence = update.changes.confidence;
      }

      // Merge new edges (with type validation)
      if (update.changes.new_edges && update.changes.new_edges.length > 0) {
        const existing = parsed.data.edges || [];
        const existingTargets = new Set(existing.map((e: any) => e.target));
        for (const edge of update.changes.new_edges) {
          if (!existingTargets.has(edge.target)) {
            existing.push({ ...edge, type: validateEdgeType(edge.type) });
          }
        }
        parsed.data.edges = existing;
      }

      // Merge new anti-edges
      if (update.changes.new_anti_edges && update.changes.new_anti_edges.length > 0) {
        const existing = parsed.data.anti_edges || [];
        const existingTargets = new Set(existing.map((e: any) => e.target));
        for (const ae of update.changes.new_anti_edges) {
          if (!existingTargets.has(ae.target)) {
            existing.push(ae);
          }
        }
        parsed.data.anti_edges = existing;
      }

      // Update soma
      if (update.changes.soma) {
        parsed.data.soma = update.changes.soma;
      }

      // Update timestamp
      parsed.data.updated = new Date().toISOString().slice(0, 10);

      // Append content
      let body = parsed.content;
      if (update.changes.append_content) {
        body += `\n\n${update.changes.append_content}`;
      }

      fs.writeFileSync(filePath, matter.stringify(body, parsed.data));

      activityBus.log("graph:node_updated", `Updated node: ${update.path}`, {
        path: update.path,
        changes: Object.keys(update.changes),
      });
    }
  } catch (err: any) {
    activityBus.log("system:error", `Failed during node updates: ${err.message}`);
  }

  // 3. Archive nodes
  try {
    for (const archive of result.nodes_to_archive) {
      const srcPath = safePath(CONFIG.paths.nodes, archive.path, ".md");
      const destPath = safePath(CONFIG.paths.archive, archive.path, ".md");
      if (!srcPath || !destPath) {
        activityBus.log("system:error", `Invalid archive path from LLM: ${archive.path}`);
        continue;
      }
      if (!fs.existsSync(srcPath)) continue;

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(srcPath, destPath);

      activityBus.log("graph:node_archived", `Archived node: ${archive.path} — ${archive.reason}`, {
        path: archive.path,
        reason: archive.reason,
      });
    }
  } catch (err: any) {
    activityBus.log("system:error", `Failed during node archival: ${err.message}`);
  }

  // 4. Update PRIORS
  try {
    if (result.new_priors.length > 0 || result.decayed_priors.length > 0) {
      updatePriors(result.new_priors, result.decayed_priors);
    }
  } catch (err: any) {
    activityBus.log("system:error", `Failed during priors update: ${err.message}`);
  }

  // 5. Full MAP rebuild from actual node files (not just LLM output)
  try {
    fullRegenerateMAP();
  } catch (err: any) {
    activityBus.log("system:error", `Failed during MAP rebuild: ${err.message}`);
  }

  // 6. Rebuild index
  try {
    rebuildIndex();
  } catch (err: any) {
    activityBus.log("system:error", `Failed during index rebuild: ${err.message}`);
  }
}

function updatePriors(newPriors: string[], decayedPriors: string[]) {
  // Guard for missing file
  if (!fs.existsSync(CONFIG.paths.priors)) {
    fs.writeFileSync(
      CONFIG.paths.priors,
      `# PRIORS — Behavioral Guidelines\n\n> Derived from cross-session patterns.\n\n`
    );
  }

  let content = fs.readFileSync(CONFIG.paths.priors, "utf-8");
  const lines = content.split("\n");

  // Remove decayed priors (only match numbered prior lines, not headers)
  for (const decayed of decayedPriors) {
    const idx = lines.findIndex((l) => /^\d+\./.test(l) && l.includes(decayed));
    if (idx !== -1) {
      lines.splice(idx, 1);
    }
  }

  // Add new priors
  for (const prior of newPriors) {
    const lastNumber = lines.reduce((max, line) => {
      const match = line.match(/^(\d+)\./);
      if (!match) return max;
      const num = parseInt(match[1], 10);
      return isNaN(num) ? max : Math.max(max, num);
    }, 0);

    // Format: separate label from body if " — " is present, otherwise use as-is
    const parts = prior.split(" — ");
    if (parts.length > 1) {
      lines.push(`${lastNumber + 1}. **${parts[0]}** — ${parts.slice(1).join(" — ")}`);
    } else {
      lines.push(`${lastNumber + 1}. ${prior}`);
    }
  }

  // Enforce maxPriors limit — keep the most recent ones
  const numberedLines = lines.filter(l => /^\d+\./.test(l));
  if (numberedLines.length > CONFIG.graph.maxPriors) {
    const excess = numberedLines.length - CONFIG.graph.maxPriors;
    // Remove the oldest (lowest-numbered) priors
    let removed = 0;
    for (let i = 0; i < lines.length && removed < excess; i++) {
      if (/^\d+\./.test(lines[i])) {
        lines.splice(i, 1);
        removed++;
        i--; // Adjust for splice
      }
    }
    activityBus.log("graph:priors_updated", `Pruned ${excess} oldest priors (limit: ${CONFIG.graph.maxPriors})`);
  }

  fs.writeFileSync(CONFIG.paths.priors, lines.join("\n"));

  activityBus.log("graph:priors_updated", `Priors updated: +${newPriors.length}, -${decayedPriors.length}`, {
    added: newPriors.length,
    removed: decayedPriors.length,
  });
}

/** Rough token estimate: ~1 token per 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface MapEntry {
  nodePath: string;
  line: string;
  confidence: number;
  somaMarker?: string;
}

/**
 * Full MAP rebuild: walks all node files and rebuilds MAP from scratch.
 * Enforces maxMapTokens budget and maxNodesBeforePrune.
 * This ensures MAP always reflects reality, not just what the LLM returned.
 */
function fullRegenerateMAP() {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  // Collect all entries with metadata for sorting/pruning
  const allEntries: MapEntry[] = [];

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const gist = parsed.data.gist || extractFirstParagraph(parsed.content);
      const edges: string[] = (parsed.data.edges || []).map((e: any) => e.target).filter(Boolean);
      const edgeStr = edges.length > 0 ? ` → [${edges.join(", ")}]` : "";
      const confidence = typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.5;

      // Include soma marker if present
      const somaMarker = parsed.data.soma?.marker;
      const somaStr = somaMarker ? ` ⚡${somaMarker}` : "";

      allEntries.push({
        nodePath,
        line: `- **${nodePath}** — ${gist}${edgeStr}${somaStr}`,
        confidence,
        somaMarker,
      });
    } catch {
      // Skip unparseable files
    }
  }

  // Enforce maxNodesBeforePrune: auto-archive lowest-confidence nodes
  if (allEntries.length > CONFIG.graph.maxNodesBeforePrune) {
    const sorted = [...allEntries].sort((a, b) => a.confidence - b.confidence);
    const toArchive = sorted.slice(0, allEntries.length - CONFIG.graph.maxNodesBeforePrune);

    for (const entry of toArchive) {
      try {
        const srcPath = path.join(CONFIG.paths.nodes, `${entry.nodePath}.md`);
        const destPath = path.join(CONFIG.paths.archive, `${entry.nodePath}.md`);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(srcPath, destPath);

        activityBus.log("graph:node_archived", `Auto-pruned (node limit): ${entry.nodePath} (confidence: ${entry.confidence})`, {
          path: entry.nodePath,
          reason: "max_nodes_exceeded",
        });
      } catch {
        // Skip if archive fails
      }
    }

    // Remove pruned entries
    const prunedPaths = new Set(toArchive.map(e => e.nodePath));
    const remaining = allEntries.filter(e => !prunedPaths.has(e.nodePath));
    allEntries.length = 0;
    allEntries.push(...remaining);
  }

  // Build the MAP header
  const header = `# MAP — Knowledge Graph Index\n\n> Auto-generated. Each entry: path | gist | edges\n> ~50-80 tokens per entry. This is the agent's "hippocampus."\n`;
  const headerTokens = estimateTokens(header);

  // Sort entries by confidence descending — highest-confidence nodes survive budget cuts
  allEntries.sort((a, b) => b.confidence - a.confidence);

  // Enforce token budget: include entries until budget exhausted
  let tokenBudget = CONFIG.graph.maxMapTokens - headerTokens;
  const includedEntries: MapEntry[] = [];
  let droppedCount = 0;

  for (const entry of allEntries) {
    const entryTokens = estimateTokens(entry.line + "\n");
    // Reserve ~200 tokens for category headers and dream section
    if (tokenBudget - entryTokens < 200 && includedEntries.length > 0) {
      droppedCount++;
      continue;
    }
    tokenBudget -= entryTokens;
    includedEntries.push(entry);
  }

  if (droppedCount > 0) {
    activityBus.log("graph:map_regenerated", `MAP token budget: dropped ${droppedCount} lowest-confidence entries`, {
      dropped: droppedCount,
      maxTokens: CONFIG.graph.maxMapTokens,
    });
  }

  // Group by category
  const categories = new Map<string, string[]>();
  for (const entry of includedEntries) {
    const cat = entry.nodePath.split("/")[0];
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(entry.line);
  }

  let newMAP = header;

  for (const [cat, entryLines] of categories) {
    newMAP += `\n## ${cat}\n\n`;
    newMAP += entryLines.join("\n") + "\n";
  }

  // Add dream hints for pending dreams above 0.3 confidence
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (fs.existsSync(pendingDir)) {
    const dreamFiles = fs.readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    const dreamHints: string[] = [];
    for (const f of dreamFiles) {
      try {
        const dream = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf-8"));
        if (dream.confidence >= 0.3) {
          dreamHints.push(`- ${dream.fragment.slice(0, 100)} (${dream.type}, confidence: ${dream.confidence})`);
        }
      } catch { /* skip */ }
    }
    if (dreamHints.length > 0) {
      newMAP += `\n## Dreams\n\n`;
      newMAP += dreamHints.join("\n") + "\n";
    }
  }

  if (categories.size === 0) {
    newMAP += `\n_No nodes yet. The graph will grow as conversations happen._\n`;
  }

  fs.writeFileSync(CONFIG.paths.map, newMAP);

  const totalTokens = estimateTokens(newMAP);
  activityBus.log("graph:map_regenerated", `MAP rebuilt: ${includedEntries.length} entries, ~${totalTokens} tokens (budget: ${CONFIG.graph.maxMapTokens})`, {
    entryCount: includedEntries.length,
    estimatedTokens: totalTokens,
    droppedCount,
  });
}

function rebuildIndex() {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return;

  const index: any[] = [];

  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data;

      const gist = fm.gist || extractFirstParagraph(parsed.content);
      const tags = fm.tags || [];
      const keywords = fm.keywords || [];
      const confidence = typeof fm.confidence === "number" ? fm.confidence : 0.5;
      const somaIntensity = fm.soma?.intensity || 0;
      const edges = (fm.edges || []).map((e: any) => e.target).filter(Boolean);
      const antiEdges = (fm.anti_edges || []).map((e: any) => e.target).filter(Boolean);

      index.push({
        path: nodePath,
        gist: (gist as string).slice(0, 200),
        tags,
        keywords,
        edges,
        anti_edges: antiEdges,
        confidence,
        soma_intensity: somaIntensity,
        updated: fm.updated || fm.created || null,
        last_accessed: fm.last_accessed || new Date().toISOString(),
        access_count: fm.access_count || 0,
      });
    } catch {
      // Skip unparseable files
    }
  }

  fs.writeFileSync(CONFIG.paths.index, JSON.stringify(index, null, 2));
}
