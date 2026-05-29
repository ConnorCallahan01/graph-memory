/**
 * Phase 9: Migrate existing v2 graph data to v3 mental model architecture.
 *
 * Reads all active nodes from nodes/, high-confidence ones feed into:
 *   - Global mental model (mind/model.json + mind/whisper.txt)
 *   - Project models (lenses/{project}/model.json + whisper.txt)
 *   - Graph index (graph/.index.json)
 *
 * v3 Layer 4 now uses the existing nodes/ directory directly. The migration
 * preserves existing node and archive paths and only builds the compressed
 * mental-model layers plus the v3 lookup index.
 *
 * Usage:
 *   npx tsx src/graph-memory/scripts/migrate-v2-to-v3.ts           # dry run
 *   npx tsx src/graph-memory/scripts/migrate-v2-to-v3.ts --apply    # apply
 *   GRAPH_MEMORY_ROOT=/path/to/data npx tsx ... --apply             # custom root
 */
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG, isGraphInitialized, reloadConfig } from "../config.js";
import { initializeGraph } from "../index.js";
import { walkNodes, extractFirstParagraph } from "../utils.js";
import { activityBus } from "../events.js";
import { writeModel, readModel } from "../mind/model.js";
import { writeWhisper, enforceWhisperCap, estimateTokens } from "../mind/whisper.js";
import { GlobalModel, GlobalModelFile } from "../mind/types.js";
import { ensureLens, writeModel as writeProjectModel, writeWhisper as writeProjectWhisper, readModel as readProjectModel, listActiveLenses } from "../lenses/index.js";
import { ProjectModel, ProjectModelFile } from "../lenses/types.js";
import { rebuildV3Index as rebuildGraphIndex } from "../pipeline/graph-index.js";
import { repairYamlFrontmatter, tryParseWithRepair } from "../pipeline/yaml-repair.js";

interface MigratedNode {
  nodePath: string;
  category: string;
  confidence: number;
  tags: string[];
  gist: string;
  content: string;
  project?: string;
  edges: Array<{ target: string; type: string; weight: number }>;
  anti_pattern?: boolean;
  decay_exempt?: boolean;
  pinned?: boolean;
  updated: string | null;
  created: string | null;
  soma?: { valence: string; intensity: number; marker: string };
}

interface MigrationStats {
  nodesScanned: number;
  nodesAvailable: number;
  globalModelEntries: number;
  projectLenses: string[];
  indexEntries: number;
  antiPatterns: number;
  errors: string[];
}

function parseArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

export function categorize(nodePath: string): string {
  return nodePath.split("/")[0] || "uncategorized";
}

export function collectNodes(nodesDir: string): MigratedNode[] {
  const nodes: MigratedNode[] = [];
  let repairedCount = 0;
  for (const { nodePath, filePath } of walkNodes(nodesDir)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const result = tryParseWithRepair(raw);
      if (!result) {
        console.error(`  Error reading ${nodePath}: failed to parse even after repair`);
        continue;
      }
      const fm = result.data;
      const content = result.content;
      if (repairedCount < 3) {
        const directParsed = (() => { try { return matter(raw); } catch { return null; } })();
        if (!directParsed) {
          repairedCount++;
        }
      }
      nodes.push({
        nodePath,
        category: categorize(nodePath),
        confidence: typeof fm.confidence === "number" ? fm.confidence : 0.6,
        tags: (fm.tags || []).map((t: any) => String(t)),
        gist: ((fm.gist || extractFirstParagraph(content)) as string).slice(0, 200),
        content: content.trim(),
        project: fm.project || undefined,
        edges: (fm.edges || []).map((e: any) => ({
          target: e.target,
          type: e.type || "relates_to",
          weight: e.weight ?? 0.5,
        })).filter((e: any) => e.target),
        anti_pattern: fm.anti_pattern || false,
        decay_exempt: fm.decay_exempt || false,
        pinned: fm.pinned || false,
        updated: fm.updated || fm.created || null,
        created: fm.created || null,
        soma: fm.soma ? {
          valence: fm.soma.valence || "neutral",
          intensity: typeof fm.soma.intensity === "number" ? fm.soma.intensity : 0.5,
          marker: fm.soma.marker || "",
        } : undefined,
      });
    } catch (err) {
      console.error(`  Error reading ${nodePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (repairedCount > 0) {
    console.log(`  Repaired ${repairedCount} nodes with malformed YAML (total repaired may be higher)`);
  }
  return nodes;
}

export function buildGlobalModel(nodes: MigratedNode[]): { model: GlobalModel; whisper: string } {
  const CONFIDENCE_THRESHOLD = 0.5;
  const highConfidence = nodes.filter((n) => n.confidence >= CONFIDENCE_THRESHOLD);

  const preferences = highConfidence
    .filter((n) => n.category === "preferences" || n.tags.includes("preference"))
    .map((n) => n.gist)
    .slice(0, 15);

  const decisions = highConfidence
    .filter((n) => n.category === "decisions" || n.tags.includes("decision"))
    .map((n) => n.gist)
    .slice(0, 15);

  const patterns = highConfidence
    .filter((n) => n.category === "patterns" || n.tags.includes("pattern"))
    .map((n) => n.gist)
    .slice(0, 15);

  const emotionalEntries = highConfidence.filter((n) => n.soma && n.soma.intensity >= 0.5);
  const emotionalProfile = emotionalEntries.length > 0
    ? emotionalEntries
        .map((n) => `${n.soma!.valence} (${n.soma!.intensity.toFixed(2)}): ${n.gist}`)
        .slice(0, 10)
        .join("\n")
    : "";

  const people = highConfidence
    .filter((n) => n.category === "people")
    .map((n) => n.gist)
    .slice(0, 10);

  const cognitiveStyle = decisions.length > 0
    ? `Tends toward deliberate, evidence-based decisions. Key themes: ${decisions.slice(0, 3).join("; ")}.`
    : "";

  const antiPatterns = nodes.filter((n) => n.anti_pattern || n.category === "anti-patterns");
  const guardrails = antiPatterns.map((n) => `AVOID: ${n.gist}`).slice(0, 10);

  const allRelational = [...people, ...preferences.slice(0, 3)];

  const tokenEstimate = estimateTokens(
    [cognitiveStyle, ...decisions, ...preferences, ...guardrails, emotionalProfile, ...allRelational].join(" "),
  );

  const model: GlobalModel = {
    version: 3,
    generatedAt: new Date().toISOString(),
    cognitiveStyle,
    decisionPatterns: decisions,
    preferences,
    guardrails,
    emotionalProfile,
    relationalNotes: allRelational,
    tokenEstimate,
  };

  const whisperParts: string[] = [];
  if (cognitiveStyle) whisperParts.push(`Thinking style: ${cognitiveStyle}`);
  if (preferences.length > 0) whisperParts.push(`Key preferences: ${preferences.slice(0, 5).join("; ")}`);
  if (decisions.length > 0) whisperParts.push(`Decision patterns: ${decisions.slice(0, 5).join("; ")}`);
  if (guardrails.length > 0) whisperParts.push(`Guardrails: ${guardrails.slice(0, 5).join("; ")}`);
  if (emotionalProfile) whisperParts.push(`Emotional notes: ${emotionalProfile.slice(0, 200)}`);
  if (people.length > 0) whisperParts.push(`People: ${people.slice(0, 3).join("; ")}`);

  const whisper = enforceWhisperCap(whisperParts.join("\n\n"));

  return { model, whisper };
}

export function buildProjectModels(nodes: MigratedNode[]): Map<string, { model: ProjectModel; whisper: string }> {
  const byProject = new Map<string, MigratedNode[]>();
  for (const node of nodes) {
    const proj = node.project || node.tags.find((t) => t.startsWith("project:"))?.replace("project:", "");
    if (!proj) continue;
    const list = byProject.get(proj) || [];
    list.push(node);
    byProject.set(proj, list);
  }

  const result = new Map<string, { model: ProjectModel; whisper: string }>();

  for (const [project, projNodes] of byProject) {
    const highConfidence = projNodes.filter((n) => n.confidence >= 0.4);

    const conventions = highConfidence
      .filter((n) => n.category === "patterns" || n.tags.includes("convention"))
      .map((n) => n.gist)
      .slice(0, 10);

    const procedures = highConfidence
      .filter((n) => n.tags.includes("procedure") || n.category === "procedures")
      .map((n) => n.gist)
      .slice(0, 10);

    const guardrails = projNodes
      .filter((n) => n.anti_pattern || n.category === "anti-patterns")
      .map((n) => `AVOID: ${n.gist}`)
      .slice(0, 5);

    const techTags = projNodes.flatMap((n) => n.tags).filter((t) =>
      ["typescript", "javascript", "python", "react", "node", "go", "rust", "docker"].includes(t),
    );
    const techStack = [...new Set(techTags)].slice(0, 10);

    const activeWork = highConfidence
      .filter((n) => n.category === "decisions" || n.tags.includes("active"))
      .map((n) => n.gist)
      .slice(0, 5);

    const openThreads: string[] = [];

    const tokenEstimate = estimateTokens(
      [...conventions, ...procedures, ...guardrails, ...techStack, ...activeWork].join(" "),
    );

    const model: ProjectModel = {
      version: 3,
      project,
      generatedAt: new Date().toISOString(),
      techStack,
      conventions,
      procedures,
      guardrails,
      activeWork,
      openThreads,
      tokenEstimate,
    };

    const whisperParts: string[] = [`Project: ${project}`];
    if (techStack.length > 0) whisperParts.push(`Stack: ${techStack.join(", ")}`);
    if (conventions.length > 0) whisperParts.push(`Conventions: ${conventions.slice(0, 3).join("; ")}`);
    if (procedures.length > 0) whisperParts.push(`Procedures: ${procedures.slice(0, 3).join("; ")}`);
    if (guardrails.length > 0) whisperParts.push(`Guardrails: ${guardrails.join("; ")}`);

    const whisper = enforceWhisperCap(whisperParts.join("\n"));
    result.set(project, { model, whisper });
  }

  return result;
}

function printStats(stats: MigrationStats, apply: boolean): void {
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`\n=== Migration v2 → v3 (${mode}) ===`);
  console.log(`Graph root: ${CONFIG.paths.graphRoot}`);
  console.log(`Nodes scanned: ${stats.nodesScanned}`);
  console.log(`Nodes available for v3 graph layer: ${stats.nodesAvailable}`);
  console.log(`Global model entries: ${stats.globalModelEntries}`);
  console.log(`Project lenses created: ${stats.projectLenses.length}`);
  for (const proj of stats.projectLenses) {
    console.log(`  - ${proj}`);
  }
  console.log(`Graph index entries: ${stats.indexEntries}`);
  console.log(`Anti-patterns found: ${stats.antiPatterns}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    for (const err of stats.errors) {
      console.log(`  - ${err}`);
    }
  }
  console.log("================================\n");
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));

  if (!isGraphInitialized()) {
    initializeGraph();
    reloadConfig();
  }

  const nodesDir = CONFIG.paths.nodes;
  const mindDir = CONFIG.paths.mind;
  const lensesDir = CONFIG.paths.lenses;

  if (!fs.existsSync(nodesDir)) {
    console.error(`No v2 nodes directory found at ${nodesDir}`);
    process.exit(1);
  }

  const stats: MigrationStats = {
    nodesScanned: 0,
    nodesAvailable: 0,
    globalModelEntries: 0,
    projectLenses: [],
    indexEntries: 0,
    antiPatterns: 0,
    errors: [],
  };

  // Step 1: Collect all v2 nodes
  console.log("Scanning v2 nodes...");
  const nodes = collectNodes(nodesDir);
  stats.nodesScanned = nodes.length;
  console.log(`  Found ${nodes.length} active nodes`);

  // Step 2: Reuse nodes/ directly for v3 Layer 4
  stats.nodesAvailable = nodes.length;
  console.log(`  Reusing ${nodes.length} nodes from nodes/ for v3 Layer 4`);

  // Step 3: Build global mental model
  console.log("Building global mental model...");
  const { model: globalModel, whisper: globalWhisper } = buildGlobalModel(nodes);
  stats.globalModelEntries =
    globalModel.cognitiveStyle.length +
    globalModel.decisionPatterns.length +
    globalModel.preferences.length +
    globalModel.guardrails.length +
    globalModel.relationalNotes.length;

  if (apply) {
    if (!fs.existsSync(mindDir)) fs.mkdirSync(mindDir, { recursive: true });

    const modelFile: GlobalModelFile = {
      model: globalModel,
      lastCompressorRun: new Date().toISOString(),
      observationCount: 0,
    };
    writeModel(modelFile);
    writeWhisper(globalWhisper);
    console.log(`  Wrote mind/model.json (${globalModel.tokenEstimate} est tokens)`);
    console.log(`  Wrote mind/whisper.txt (${estimateTokens(globalWhisper)} est tokens)`);
  } else {
    console.log(`  Would write global model (${globalModel.tokenEstimate} est tokens)`);
    console.log(`  Would write global whisper (${estimateTokens(globalWhisper)} est tokens)`);
    console.log(`  Preview:\n${globalWhisper.slice(0, 300)}${globalWhisper.length > 300 ? "..." : ""}`);
  }

  // Step 4: Build project models
  console.log("Building project models...");
  const projectModels = buildProjectModels(nodes);
  stats.projectLenses = [...projectModels.keys()];

  if (apply) {
    for (const [project, { model, whisper }] of projectModels) {
      ensureLens(project);

      const projectModelFile: ProjectModelFile = {
        project,
        model,
        lastCompressorRun: new Date().toISOString(),
        observationCount: 0,
        firstSessionAt: new Date().toISOString(),
        lastSessionAt: new Date().toISOString(),
      };
      writeProjectModel(project, projectModelFile);
      writeProjectWhisper(project, whisper);
      console.log(`  Created lens: ${project} (${model.tokenEstimate} est tokens)`);
    }
  } else {
    for (const [project, { model, whisper }] of projectModels) {
      console.log(`  Would create lens: ${project} (${model.tokenEstimate} est tokens)`);
    }
  }

  // Step 5: Build graph index
  console.log("Building v3 graph index...");
  const antiPatterns = nodes.filter((n) => n.anti_pattern || n.category === "anti-patterns");
  stats.antiPatterns = antiPatterns.length;

  if (apply) {
    const indexCount = rebuildGraphIndex();
    stats.indexEntries = indexCount;
    console.log(`  Indexed ${indexCount} nodes`);
  } else {
    stats.indexEntries = nodes.length;
    console.log(`  Would index ${nodes.length} nodes`);
  }

  // Step 6: Create sessions directory
  if (apply) {
    const sessionsDir = CONFIG.paths.sessions;
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      console.log("Created sessions/ directory");
    }

    // Create pipeline observations directory
    const obsDir = CONFIG.paths.pipelineObservations;
    if (!fs.existsSync(obsDir)) {
      fs.mkdirSync(obsDir, { recursive: true });
      console.log("Created .pipeline/observations/ directory");
    }
  }

  printStats(stats, apply);
}

main().catch((err) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
