import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");

function makeTempGraph() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-memory-v3-test-"));
  const graphRoot = path.join(tmp, ".graph-memory");
  return { tmp, graphRoot };
}

function initGraph(graphRoot) {
  const indexPath = pathToFileURL(path.join(pluginDir, "dist/graph-memory/index.js")).href;
  execFileSync(process.execPath, [
    "--input-type=module", "-e",
    `
      process.env.GRAPH_MEMORY_ROOT = ${JSON.stringify(graphRoot)};
      const { CONFIG, reloadConfig } = await import(${JSON.stringify(pathToFileURL(path.join(pluginDir, "dist/graph-memory/config.js")).href)});
      reloadConfig();
      const { initializeGraph } = await import(${JSON.stringify(indexPath)});
      initializeGraph();
    `,
  ], { encoding: "utf-8", env: { ...process.env, GRAPH_MEMORY_ROOT: graphRoot, GRAPH_MEMORY_V3: "1" } });
}

async function setupEnv(graphRoot) {
  process.env.GRAPH_MEMORY_ROOT = graphRoot;
  process.env.GRAPH_MEMORY_V3 = "1";
  const { reloadConfig } = await importModule("config.js");
  reloadConfig();
}

function importModule(name) {
  return import(pathToFileURL(path.join(pluginDir, "dist/graph-memory", name)).href);
}

// --- Phase 0: Directory structure ---

test("init creates v3 directory structure", () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);

    const requiredDirs = [
      "mind", "lenses", "lenses/_archived", "sessions",
      "graph", "archive", ".pipeline/observations",
      "nodes/patterns", "nodes/anti-patterns", "nodes/decisions",
      "nodes/preferences", "nodes/procedures", "nodes/corrections",
      "nodes/projects", "nodes/concepts", "nodes/architecture",
      "nodes/people", "nodes/tools",
    ];

    for (const dir of requiredDirs) {
      const fullPath = path.join(graphRoot, dir);
      assert.ok(fs.existsSync(fullPath), `Missing directory: ${dir}`);
      assert.ok(fs.statSync(fullPath).isDirectory(), `Not a directory: ${dir}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 0: Mind module ---

test("observations: append, read, absorb, prune", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("mind/observations.js");

    const obs1 = mod.appendObservation({
      layer: "global",
      type: "pattern",
      observation: "User prefers small functions",
      evidence: ["Quote from conversation"],
      confidence: 0.7,
      sessionId: "sess_test1",
    });

    const obs2 = mod.appendObservation({
      layer: "global",
      type: "decision",
      observation: "Chose SQLite over Postgres",
      evidence: ["Reasoning quote"],
      confidence: 0.6,
      sessionId: "sess_test1",
    });

    assert.ok(obs1.id.startsWith("obs_"), "Observation ID has correct prefix");
    assert.equal(obs1.absorbed, false, "New observation is not absorbed");

    const all = mod.readObservations();
    assert.equal(all.length, 2, "Two observations in file");

    mod.markObservationsAbsorbed([obs1.id]);
    const afterAbsorb = mod.readObservations();
    assert.equal(afterAbsorb[0].absorbed, true, "First observation absorbed");
    assert.equal(afterAbsorb[1].absorbed, false, "Second observation not absorbed");

    // Prune absorbed observations older than -1 days (i.e. everything, including just-created)
    const pruned = mod.pruneObservations(-1);
    assert.ok(pruned >= 1, "At least one absorbed observation pruned: got " + pruned);

    const remaining = mod.readObservations();
    assert.equal(remaining.length, 1, "One observation remains after prune");
    assert.equal(remaining[0].id, obs2.id, "Remaining observation is the unabsorbed one");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("model: read empty, write, read back", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("mind/model.js");

    const empty = mod.readModel();
    assert.equal(empty.model.version, 3, "Empty model has version 3");
    assert.equal(empty.model.cognitiveStyle, "", "Empty model has empty cognitive style");
    assert.equal(empty.lastCompressorRun, "", "No compressor run yet");

    mod.writeModel({
      model: {
        version: 3,
        generatedAt: "2026-05-11T12:00:00Z",
        cognitiveStyle: "Pragmatic, prefers simple solutions",
        decisionPatterns: ["Prefers buy over build"],
        preferences: ["Likes TypeScript"],
        guardrails: ["Never use eval()"],
        emotionalProfile: "Calm, methodical",
        relationalNotes: [],
        tokenEstimate: 50,
      },
      lastCompressorRun: "2026-05-11T12:00:00Z",
      observationCount: 5,
    });

    const loaded = mod.readModel();
    assert.equal(loaded.model.cognitiveStyle, "Pragmatic, prefers simple solutions");
    assert.deepEqual(loaded.model.guardrails, ["Never use eval()"]);
    assert.equal(loaded.observationCount, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("whisper: write, read, cap enforcement", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("mind/whisper.js");

    assert.equal(mod.readWhisper(), null, "No whisper initially");

    mod.writeWhisper("GUARDRAILS:\n- Never do X\n\nSTYLE:\nPrefers short answers.");
    assert.equal(mod.readWhisper(), "GUARDRAILS:\n- Never do X\n\nSTYLE:\nPrefers short answers.");

    const longText = "A".repeat(5000);
    const capped = mod.enforceWhisperCap(longText);
    const tokens = mod.estimateTokens(capped);
    assert.ok(tokens <= 400, "Capped whisper is within 400 token budget: got " + tokens);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 0: Lenses module ---

test("lenses: ensure, observe, absorb, archive, restore", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("lenses/manager.js");

    assert.equal(mod.lensExists("test-project"), false, "Lens does not exist yet");

    mod.ensureLens("test-project");
    assert.equal(mod.lensExists("test-project"), true, "Lens created");

    const obs = mod.appendObservation("test-project", {
      type: "preference",
      observation: "Uses vitest for testing",
      evidence: ["Config file shows vitest"],
      confidence: 0.8,
      sessionId: "sess_test1",
    });
    assert.ok(obs.id.startsWith("obs_"));

    const allObs = mod.readObservations("test-project");
    assert.equal(allObs.length, 1);

    mod.markObservationsAbsorbed("test-project", [obs.id]);
    const afterAbsorb = mod.readObservations("test-project");
    assert.equal(afterAbsorb[0].absorbed, true);

    mod.writeWhisper("test-project", "STACK: Node.js, vitest.\nCONVENTIONS: ES modules.");
    assert.equal(mod.readWhisper("test-project"), "STACK: Node.js, vitest.\nCONVENTIONS: ES modules.");

    mod.archiveLens("test-project");
    assert.equal(mod.lensExists("test-project"), false, "Lens archived");
    assert.equal(mod.isArchived("test-project"), true, "Lens in archive");

    mod.restoreLens("test-project");
    assert.equal(mod.lensExists("test-project"), true, "Lens restored");
    assert.equal(mod.isArchived("test-project"), false, "Lens not in archive");

    const restoredObs = mod.readObservations("test-project");
    assert.equal(restoredObs.length, 1, "Observations preserved after archive/restore");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 0: Sessions module ---

test("sessions: append, read recent, prune", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("sessions/manager.js");

    const log1 = mod.appendSessionLog({
      project: "test-project",
      sessionId: "sess_1",
      activeWork: ["Building auth system"],
      shipped: [],
      decisions: ["Use JWT over sessions"],
      blocked: [],
      openThreads: ["Need to add refresh tokens"],
      correctionsGiven: [],
      nextSessionShould: "Finish refresh token flow",
    });

    assert.ok(log1.id.startsWith("sess_"), "Log ID has correct prefix");
    assert.equal(log1.project, "test-project");
    assert.deepEqual(log1.decisions, ["Use JWT over sessions"]);

    mod.appendSessionLog({
      project: "test-project",
      sessionId: "sess_2",
      activeWork: ["Refresh token flow"],
      shipped: ["JWT auth"],
      decisions: [],
      blocked: ["Waiting on API key"],
      openThreads: [],
      correctionsGiven: [],
      nextSessionShould: "Test the refresh flow",
    });

    const recent = mod.readRecentSessions("test-project", 1);
    assert.equal(recent.length, 1, "Only 1 recent session requested");
    assert.equal(recent[0].sessionId, "sess_2", "Most recent session returned");

    const allRecent = mod.readRecentSessions("test-project", 5);
    assert.equal(allRecent.length, 2, "Both sessions returned");

    const pruned = mod.pruneSessionLogs("test-project", -1);
    assert.ok(pruned >= 1, "At least one entry pruned: got " + pruned);

    const remaining = mod.readRecentSessions("test-project", 10);
    assert.ok(remaining.length < 2, "Fewer than 2 sessions after prune: got " + remaining.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 1: Observer tools ---

test("observer-tools: process observe, log_session, upsert_node outputs", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("pipeline/observer-tools.js");

    const obsDir = path.join(graphRoot, ".pipeline", "observations");
    assert.ok(fs.existsSync(obsDir), "Observations staging dir exists");

    fs.writeFileSync(path.join(obsDir, "obs_001.json"), JSON.stringify({
      tool: "observe",
      layer: "global",
      type: "pattern",
      observation: "User prefers incremental refactors",
      evidence: ["Said 'refactor incrementally'"],
      confidence: 0.75,
    }));

    fs.writeFileSync(path.join(obsDir, "obs_002.json"), JSON.stringify({
      tool: "observe",
      layer: "project",
      project: "test-project",
      type: "decision",
      observation: "Chose vitest over jest",
      evidence: ["Added vitest to package.json"],
      confidence: 0.8,
    }));

    fs.writeFileSync(path.join(obsDir, "obs_003.json"), JSON.stringify({
      tool: "log_session",
      project: "test-project",
      active_work: ["Setting up test framework"],
      shipped: ["Added vitest config"],
      decisions: ["vitest over jest"],
      blocked: [],
      open_threads: ["Need to write tests"],
      corrections_given: [],
      next_session_should: "Write first test suite",
    }));

    fs.writeFileSync(path.join(obsDir, "obs_004.json"), JSON.stringify({
      tool: "upsert_node",
      path: "patterns/incremental-refactor",
      category: "patterns",
      gist: "User prefers small incremental refactors over large rewrites",
      content: "When refactoring, break the work into small safe steps. Never rewrite large modules in one go.",
      confidence: 0.7,
      tags: ["refactoring", "workflow"],
      edges: [],
    }));

    fs.writeFileSync(path.join(obsDir, "obs_005.json"), JSON.stringify({
      tool: "upsert_node",
      path: "anti-patterns/never-use-eval",
      category: "anti-patterns",
      gist: "User explicitly forbids eval() usage",
      content: "Never use eval() or Function() constructor. Always use JSON.parse for data.",
      confidence: 0.9,
      anti_pattern: true,
      tags: ["security"],
    }));

    const result = mod.processObserverOutputs("sess_test", "test-project");

    assert.equal(result.observationsCreated, 2, "2 observations created");
    assert.equal(result.sessionLogged, true, "Session logged");
    assert.equal(result.nodesUpserted, 2, "2 nodes upserted");
    assert.equal(result.errors.length, 0, "No errors: " + JSON.stringify(result.errors));

    // Verify observations were written
    const mindObs = (await importModule("mind/observations.js")).readObservations();
    assert.equal(mindObs.length, 1, "1 global observation");
    assert.equal(mindObs[0].type, "pattern");
    assert.equal(mindObs[0].observation, "User prefers incremental refactors");

    const lensObs = (await importModule("lenses/manager.js")).readObservations("test-project");
    assert.equal(lensObs.length, 1, "1 project observation");

    // Verify session log was written
    const sessions = (await importModule("sessions/manager.js")).readRecentSessions("test-project");
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].decisions, ["vitest over jest"]);

    // Verify graph nodes were written
    const patternNode = fs.readFileSync(path.join(graphRoot, "nodes", "patterns", "incremental-refactor.md"), "utf-8");
    assert.ok(patternNode.includes("incremental"), "Pattern node content exists");

    const antiNode = fs.readFileSync(path.join(graphRoot, "nodes", "anti-patterns", "never-use-eval.md"), "utf-8");
    assert.ok(antiNode.includes("anti_pattern: true"), "Anti-pattern has anti_pattern flag");
    assert.ok(antiNode.includes("decay_exempt: true"), "Anti-pattern is decay exempt");
    assert.ok(antiNode.includes("0.9"), "Anti-pattern has high confidence");

    // Verify staging dir is cleaned up
    const remaining = fs.readdirSync(obsDir).filter(f => f.endsWith(".json"));
    assert.equal(remaining.length, 0, "Staging dir cleaned up");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 2: Compressor tools ---

test("compressor-tools: update model, generate whisper, absorb, archive", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("pipeline/compressor-tools.js");

    const obsDir = path.join(graphRoot, ".pipeline", "observations");

    // 1. Update global model
    fs.writeFileSync(path.join(obsDir, "comp_001.json"), JSON.stringify({
      tool: "update_model",
      layer: "global",
      model_json: JSON.stringify({
        version: 3,
        generatedAt: "2026-05-11T12:00:00Z",
        cognitiveStyle: "Pragmatic engineer",
        decisionPatterns: ["Prefers proven tech"],
        preferences: ["TypeScript", "ES modules"],
        guardrails: ["Never use eval()", "Always type-check"],
        emotionalProfile: "Calm under pressure",
        relationalNotes: [],
        tokenEstimate: 80,
      }),
    }));

    // 2. Generate global whisper
    fs.writeFileSync(path.join(obsDir, "comp_002.json"), JSON.stringify({
      tool: "generate_whisper",
      layer: "global",
      whisper_text: "GUARDRAILS:\n- Never use eval()\n- Always run typecheck before committing\n\nSTYLE:\nPragmatic, prefers proven solutions. Concise answers.\n\nCONTEXT:\nTypeScript, ES modules, vitest for testing.",
    }));

    // 3. Archive an observation
    const obsMod = await importModule("mind/observations.js");
    const obs = obsMod.appendObservation({
      layer: "global",
      type: "pattern",
      observation: "Test observation to absorb",
      evidence: ["test"],
      confidence: 0.5,
      sessionId: "sess_test",
    });

    fs.writeFileSync(path.join(obsDir, "comp_003.json"), JSON.stringify({
      tool: "archive_observations",
      layer: "global",
      ids: [obs.id],
    }));

    const result = mod.processCompressorOutputs();

    assert.deepEqual(result.modelsUpdated, ["global"], "Global model updated");
    assert.deepEqual(result.whispersGenerated, ["global"], "Global whisper generated");
    assert.equal(result.observationsAbsorbed, 1, "1 observation absorbed");
    assert.equal(result.errors.length, 0, "No errors: " + JSON.stringify(result.errors));

    // Verify model was written
    const model = (await importModule("mind/model.js")).readModel();
    assert.equal(model.model.cognitiveStyle, "Pragmatic engineer");
    assert.deepEqual(model.model.guardrails, ["Never use eval()", "Always type-check"]);

    // Verify whisper was written
    const whisper = (await importModule("mind/whisper.js")).readWhisper();
    assert.ok(whisper.includes("GUARDRAILS"), "Whisper has guardrails section");
    assert.ok(whisper.includes("Never use eval()"), "Whisper contains anti-pattern");

    // Verify observation was absorbed
    const observations = obsMod.readObservations();
    assert.equal(observations[0].absorbed, true, "Observation marked as absorbed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compressor-tools: archive graph nodes", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    // Create a node to archive
    const nodeDir = path.join(graphRoot, "nodes", "patterns");
    fs.writeFileSync(path.join(nodeDir, "low-confidence.md"), [
      "---",
      "id: patterns/low-confidence",
      "gist: A low confidence node",
      "confidence: 0.15",
      "created: 2026-05-01",
      "updated: 2026-05-01",
      "decay_rate: 0.05",
      "tags: []",
      "category: patterns",
      "---",
      "",
      "# low-confidence",
      "",
      "Not a strong pattern.",
    ].join("\n"));

    const obsDir = path.join(graphRoot, ".pipeline", "observations");
    fs.writeFileSync(path.join(obsDir, "comp_001.json"), JSON.stringify({
      tool: "archive_graph_nodes",
      paths: ["patterns/low-confidence"],
      reason: "confidence below 0.2 threshold",
    }));

    const mod = await importModule("pipeline/compressor-tools.js");
    const result = mod.processCompressorOutputs();

    assert.equal(result.graphNodesArchived, 1, "1 node archived");
    assert.ok(!fs.existsSync(path.join(nodeDir, "low-confidence.md")), "Node removed from active");

    const archived = fs.readFileSync(path.join(graphRoot, "archive", "patterns", "low-confidence.md"), "utf-8");
    assert.ok(archived.includes("archived_reason"), "Archived node has reason");
    assert.ok(archived.includes("confidence below 0.2"), "Archived node has reason text");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 3: Session Start v3 ---

test("session-start-v3: builds context from whispers and session logs", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    // Write global whisper
    const whisperMod = await importModule("mind/whisper.js");
    whisperMod.writeWhisper("GUARDRAILS:\n- Never use eval()\n\nSTYLE:\nPragmatic, concise answers.\n\nCONTEXT:\nTypeScript, ES modules, vitest.");

    // Create project lens with whisper and session log
    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("test-project");
    lensMod.writeWhisper("test-project", "STACK:\nNode.js, vitest.\n\nCONVENTIONS:\nES modules, strict TypeScript.\n\nACTIVE:\nBuilding auth system.");

    const sessionMod = await importModule("sessions/manager.js");
    sessionMod.appendSessionLog({
      project: "test-project",
      sessionId: "sess_1",
      activeWork: ["Auth system"],
      shipped: ["JWT tokens"],
      decisions: ["Use JWT over sessions"],
      blocked: [],
      openThreads: ["Need refresh tokens"],
      correctionsGiven: [],
      nextSessionShould: "Finish refresh flow",
    });

    const { buildV3Context, hasV3Data } = await importModule("session-start-v3.js");

    assert.ok(hasV3Data(), "v3 data detected");

    const result = buildV3Context("test-project");

    assert.ok(result.sources.globalWhisper, "Global whisper included");
    assert.ok(result.sources.projectWhisper, "Project whisper included");
    assert.ok(result.sources.sessionLog, "Session log included");
    assert.equal(result.sources.fallback, false, "No fallback needed");
    assert.ok(result.tokensUsed > 0, "Tokens counted: " + result.tokensUsed);
    assert.ok(result.tokensUsed <= 1100, "Within budget: " + result.tokensUsed + " <= 1100");

    assert.ok(result.context.includes("Never use eval()"), "Global whisper content present");
    assert.ok(result.context.includes("vitest"), "Project whisper content present");
    assert.ok(result.context.includes("JWT"), "Session log content present");
    assert.ok(result.context.includes("refresh"), "Session open threads present");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("session-start-v3: falls back when no v3 data", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { buildV3Context, hasV3Data } = await importModule("session-start-v3.js");

    assert.equal(hasV3Data(), false, "No v3 data");

    const result = buildV3Context("test-project");
    assert.equal(result.sources.fallback, true, "Falls back gracefully");
    assert.equal(result.context, "", "Empty context on fallback");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("session-start-v3: creates lens on first session", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const whisperMod = await importModule("mind/whisper.js");
    whisperMod.writeWhisper("Global whisper content.");

    const lensMod = await importModule("lenses/manager.js");
    assert.equal(lensMod.lensExists("brand-new-project"), false, "Lens does not exist");

    const { buildV3Context } = await importModule("session-start-v3.js");
    buildV3Context("brand-new-project");

    assert.equal(lensMod.lensExists("brand-new-project"), true, "Lens auto-created");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Phase 4: Graph Index v3 ---

test("graph-index-v3: rebuild, lookup, search, category filter", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const patternsDir = path.join(graphRoot, "nodes", "patterns");
    const decisionsDir = path.join(graphRoot, "nodes", "decisions");

    fs.writeFileSync(path.join(patternsDir, "incremental-refactor.md"), matter.stringify(
      "# Incremental Refactor\n\nBreak refactors into small steps.",
      {
        id: "patterns/incremental-refactor",
        gist: "User prefers small incremental refactors",
        confidence: 0.75,
        tags: ["refactoring", "workflow"],
        keywords: ["refactor", "incremental"],
        category: "patterns",
      }
    ));

    fs.writeFileSync(path.join(patternsDir, "test-first.md"), matter.stringify(
      "# Test First\n\nAlways write tests before implementing.",
      {
        id: "patterns/test-first",
        gist: "User writes tests before implementation",
        confidence: 0.7,
        tags: ["testing", "tdd"],
        keywords: ["test", "tdd"],
        category: "patterns",
        project: "test-project",
      }
    ));

    fs.writeFileSync(path.join(decisionsDir, "use-sqlite.md"), matter.stringify(
      "# Use SQLite\n\nChose SQLite for local-first data.",
      {
        id: "decisions/use-sqlite",
        gist: "Chose SQLite over Postgres for local-first architecture",
        confidence: 0.8,
        tags: ["database", "sqlite"],
        keywords: ["sqlite", "database"],
        category: "decisions",
      }
    ));

    const mod = await importModule("pipeline/graph-index-v3.js");

    const count = mod.rebuildV3Index();
    assert.equal(count, 3, "3 nodes indexed");

    const entry = mod.lookup("patterns/incremental-refactor");
    assert.ok(entry, "Lookup finds node");
    assert.equal(entry.gist, "User prefers small incremental refactors");
    assert.equal(entry.category, "patterns");
    assert.equal(entry.confidence, 0.75);

    const results = mod.search("refactor");
    assert.ok(results.length >= 1, "Search returns results");
    assert.equal(results[0].path, "patterns/incremental-refactor");

    const decisions = mod.getByCategory("decisions");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].path, "decisions/use-sqlite");

    const projectNodes = mod.getByProject("test-project");
    assert.equal(projectNodes.length, 1);
    assert.equal(projectNodes[0].path, "patterns/test-first");

    const stats = mod.getStats();
    assert.equal(stats.totalNodes, 3);
    assert.equal(stats.categories.patterns, 2);
    assert.equal(stats.categories.decisions, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("graph-index-v3: incremental add and remove", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/graph-index-v3.js");

    mod.addEntryToIndex({
      path: "patterns/direct-add",
      gist: "A pattern added directly to the index",
      tags: ["test"],
      keywords: ["direct"],
      edges: [],
      anti_edges: [],
      confidence: 0.6,
      category: "patterns",
      updated: "2026-05-11",
      last_accessed: "2026-05-11",
      access_count: 0,
      recall_action_count: 0,
      soma_intensity: 0,
    });

    const entry = mod.lookup("patterns/direct-add");
    assert.ok(entry, "Direct add creates index entry");

    const stats = mod.getStats();
    assert.equal(stats.totalNodes, 1);
    assert.equal(stats.categories.patterns, 1);

    mod.removeFromIndex("patterns/direct-add");
    assert.equal(mod.lookup("patterns/direct-add"), null, "Entry removed");
    const afterRemove = mod.getStats();
    assert.equal(afterRemove.totalNodes, 0);
    assert.deepEqual(afterRemove.categories, {}, "Category index cleaned up");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("graph-index-v3: anti-pattern support", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/graph-index-v3.js");

    mod.addEntryToIndex({
      path: "anti-patterns/never-use-eval",
      gist: "Never use eval() in any codebase",
      tags: ["security"],
      keywords: ["eval", "security"],
      edges: [],
      anti_edges: [],
      confidence: 0.9,
      category: "anti-patterns",
      anti_pattern: true,
      decay_exempt: true,
      updated: "2026-05-11",
      last_accessed: "2026-05-11",
      access_count: 0,
      recall_action_count: 0,
      soma_intensity: 0,
    });

    mod.addEntryToIndex({
      path: "patterns/some-pattern",
      gist: "A regular pattern",
      tags: [],
      keywords: [],
      edges: [],
      anti_edges: [],
      confidence: 0.6,
      category: "patterns",
      updated: "2026-05-11",
      last_accessed: "2026-05-11",
      access_count: 0,
      recall_action_count: 0,
      soma_intensity: 0,
    });

    const antiPatterns = mod.getAntiPatterns();
    assert.equal(antiPatterns.length, 1);
    assert.equal(antiPatterns[0].anti_pattern, true);
    assert.equal(antiPatterns[0].decay_exempt, true);

    const stats = mod.getStats();
    assert.equal(stats.antiPatterns, 1);
    assert.equal(stats.totalNodes, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: observer produces observations that compressor absorbs", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    // Observer produces outputs
    const obsDir = path.join(graphRoot, ".pipeline", "observations");
    fs.writeFileSync(path.join(obsDir, "obs_001.json"), JSON.stringify({
      tool: "observe",
      layer: "global",
      type: "preference",
      observation: "User strongly prefers dark mode in editors",
      evidence: ["Mentioned multiple times"],
      confidence: 0.85,
    }));
    fs.writeFileSync(path.join(obsDir, "obs_002.json"), JSON.stringify({
      tool: "log_session",
      project: "global",
      active_work: ["Configuring editor"],
      shipped: [],
      decisions: [],
      blocked: [],
      open_threads: [],
      corrections_given: [],
      next_session_should: "Continue setup",
    }));

    const observerMod = await importModule("pipeline/observer-tools.js");
    const observerResult = observerMod.processObserverOutputs("sess_e2e");
    assert.equal(observerResult.observationsCreated, 1);
    assert.equal(observerResult.sessionLogged, true);

    // Verify observation is unabsorbed
    const obsMod = await importModule("mind/observations.js");
    const observations = obsMod.readObservations();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].absorbed, false);
    assert.equal(observations[0].observation, "User strongly prefers dark mode in editors");

    // Compressor absorbs the observation and generates whisper
    fs.writeFileSync(path.join(obsDir, "comp_001.json"), JSON.stringify({
      tool: "update_model",
      layer: "global",
      model_json: JSON.stringify({
        version: 3, generatedAt: new Date().toISOString(),
        cognitiveStyle: "Visual thinker", decisionPatterns: [],
        preferences: ["Dark mode in editors", "Minimal UI"],
        guardrails: [], emotionalProfile: "",
        relationalNotes: [], tokenEstimate: 30,
      }),
    }));
    fs.writeFileSync(path.join(obsDir, "comp_002.json"), JSON.stringify({
      tool: "generate_whisper",
      layer: "global",
      whisper_text: "CONTEXT:\nUser prefers dark mode and minimal UI. Visual thinker.",
    }));
    fs.writeFileSync(path.join(obsDir, "comp_003.json"), JSON.stringify({
      tool: "archive_observations",
      layer: "global",
      ids: [observations[0].id],
    }));

    const compressorMod = await importModule("pipeline/compressor-tools.js");
    const compressorResult = compressorMod.processCompressorOutputs();
    assert.deepEqual(compressorResult.modelsUpdated, ["global"]);
    assert.deepEqual(compressorResult.whispersGenerated, ["global"]);
    assert.equal(compressorResult.observationsAbsorbed, 1);

    // Verify the full pipeline: observation → model → whisper
    const whisper = (await importModule("mind/whisper.js")).readWhisper();
    assert.ok(whisper.includes("dark mode"), "Whisper contains the preference");
    assert.ok(whisper.includes("minimal"), "Whisper is enriched beyond just the observation");

    const model = (await importModule("mind/model.js")).readModel();
    assert.ok(model.model.preferences.includes("Dark mode in editors"));
    assert.equal(model.lastCompressorRun.length > 0, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 5: decay_exempt nodes skip decay", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const nodesDir = path.join(graphRoot, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });

    const decayMod = await importModule("pipeline/decay.js");

    const normalNode = matter.stringify("# Normal\n\nNormal node.", {
      id: "test/normal",
      confidence: 0.5,
      decay_rate: 1.0,
      created: "2020-01-01",
      updated: "2020-01-01",
    });
    fs.writeFileSync(path.join(nodesDir, "normal.md"), normalNode);

    const exemptNode = matter.stringify("# Exempt\n\nExempt node.", {
      id: "test/exempt",
      confidence: 0.5,
      decay_rate: 1.0,
      decay_exempt: true,
      created: "2020-01-01",
      updated: "2020-01-01",
    });
    fs.writeFileSync(path.join(nodesDir, "exempt.md"), exemptNode);

    const { decayed } = decayMod.runDecay();

    const archiveDir = path.join(graphRoot, "archive");
    const normalArchived = fs.existsSync(path.join(archiveDir, "normal.md"));
    const exemptParsed = matter(fs.readFileSync(path.join(nodesDir, "exempt.md"), "utf-8"));

    assert.ok(normalArchived, "Normal node was archived by decay");
    assert.equal(exemptParsed.data.confidence, 0.5, "Exempt node did not decay");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 5: guardrails injected in session start", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const antiPatternsDir = path.join(graphRoot, "nodes", "anti-patterns");
    fs.writeFileSync(
      path.join(antiPatternsDir, "no-console-log.md"),
      matter.stringify("# No Console Log\n\nNever use console.log in production.", {
        id: "anti-patterns/no-console-log",
        gist: "Never use console.log in production code",
        confidence: 0.9,
        anti_pattern: true,
        decay_exempt: true,
        tags: ["anti-pattern"],
        category: "anti-patterns",
      })
    );
    fs.writeFileSync(
      path.join(antiPatternsDir, "no-any-type.md"),
      matter.stringify("# No Any Type\n\nAvoid TypeScript any.", {
        id: "anti-patterns/no-any-type",
        gist: "Avoid TypeScript any type",
        confidence: 0.95,
        anti_pattern: true,
        decay_exempt: true,
        tags: ["anti-pattern", "typescript"],
        category: "anti-patterns",
        project: "test-project",
      })
    );

    const indexMod = await importModule("pipeline/graph-index-v3.js");
    indexMod.rebuildV3Index();

    const whisperMod = await importModule("mind/whisper.js");
    whisperMod.writeWhisper("User prefers dark mode and clean code.");

    const sessionMod = await importModule("session-start-v3.js");
    const result = sessionMod.buildV3Context("test-project");

    assert.ok(result.context.includes("Guardrails"), "Context includes guardrails section");
    assert.ok(result.context.includes("Never use console.log"), "Global anti-pattern injected");
    assert.ok(result.context.includes("Avoid TypeScript any"), "Project anti-pattern injected");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 5: status action includes v3 anti-pattern counts", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const antiPatternsDir = path.join(graphRoot, "nodes", "anti-patterns");
    fs.writeFileSync(
      path.join(antiPatternsDir, "ap1.md"),
      matter.stringify("# AP1\n\nRule 1.", {
        id: "anti-patterns/ap1",
        gist: "Anti-pattern rule 1",
        confidence: 0.9,
        anti_pattern: true,
        decay_exempt: true,
        category: "anti-patterns",
      })
    );
    fs.writeFileSync(
      path.join(antiPatternsDir, "ap2.md"),
      matter.stringify("# AP2\n\nRule 2.", {
        id: "anti-patterns/ap2",
        gist: "Anti-pattern rule 2",
        confidence: 0.92,
        anti_pattern: true,
        decay_exempt: true,
        category: "anti-patterns",
        project: "my-project",
      })
    );

    const indexMod = await importModule("pipeline/graph-index-v3.js");
    indexMod.rebuildV3Index();

    const toolsMod = await importModule("tools.js");
    const statusResult = await toolsMod.handleGraphMemory({ action: "status" });
    const status = JSON.parse(statusResult.content[0].text);

    assert.ok(status.v3, "Status includes v3 section");
    assert.equal(status.v3.antiPatterns.total, 2, "2 anti-patterns total");
    assert.equal(status.v3.antiPatterns.global, 1, "1 global anti-pattern");
    assert.equal(status.v3.antiPatterns.project, 1, "1 project anti-pattern");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 6: bootstrap project doc generates CLAUDE.md", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const projectDir = path.join(tmp, "my-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const obsMod = await importModule("mind/observations.js");
    obsMod.appendObservation({
      layer: "global",
      type: "preference",
      observation: "User prefers TypeScript",
      evidence: ["stated in conversation"],
      confidence: 0.8,
      sessionId: "test-session",
    });

    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("my-project");
    const { writeModel: writeProjectModel } = await importModule("lenses/manager.js");
    writeProjectModel("my-project", {
      project: "my-project",
      model: {
        version: 3,
        project: "my-project",
        generatedAt: new Date().toISOString(),
        techStack: ["TypeScript", "Node.js"],
        conventions: ["Use ESM modules", "No console.log"],
        procedures: ["Run tests before commit"],
        guardrails: [],
        activeWork: ["Feature X"],
        openThreads: ["Bug Y"],
        tokenEstimate: 50,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 5,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    });

    const antiPatternsDir = path.join(graphRoot, "nodes", "anti-patterns");
    fs.writeFileSync(
      path.join(antiPatternsDir, "no-any.md"),
      matter.stringify("# No Any\n\nNo any.", {
        id: "anti-patterns/no-any",
        gist: "Never use TypeScript any",
        confidence: 0.9,
        anti_pattern: true,
        decay_exempt: true,
        category: "anti-patterns",
        project: "my-project",
      })
    );

    const indexMod = await importModule("pipeline/graph-index-v3.js");
    indexMod.rebuildV3Index();

    const bootstrapMod = await importModule("pipeline/bootstrap.js");
    const result = bootstrapMod.bootstrapProjectDoc("my-project", "claude-code", projectDir);

    assert.ok(result.created, "Doc was created");
    assert.equal(path.basename(result.filePath), "CLAUDE.md");
    assert.ok(result.sections.includes("Tech Stack"));
    assert.ok(result.sections.includes("Conventions"));
    assert.ok(result.sections.includes("Guardrails"));

    const content = fs.readFileSync(result.filePath, "utf-8");
    assert.ok(content.includes("TypeScript"), "Includes tech stack");
    assert.ok(content.includes("Never use TypeScript any"), "Includes anti-pattern");
    assert.ok(content.includes("custom start"), "Includes custom section placeholder");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 6: bootstrap preserves custom sections on re-bootstrap", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const projectDir = path.join(tmp, "my-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const existingDoc = [
      "<!-- graph-memory:bootstrap -->",
      "# Project Context — my-project",
      "",
      "## Tech Stack",
      "",
      "- Old Stack",
      "",
      "<!-- custom start -->",
      "This is my custom content that must survive.",
      "<!-- custom end -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "AGENT.md"), existingDoc);

    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("my-project");
    const { writeModel: writeProjectModel } = await importModule("lenses/manager.js");
    writeProjectModel("my-project", {
      project: "my-project",
      model: {
        version: 3,
        project: "my-project",
        generatedAt: new Date().toISOString(),
        techStack: ["New Stack"],
        conventions: [],
        procedures: [],
        guardrails: [],
        activeWork: [],
        openThreads: [],
        tokenEstimate: 10,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 1,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    });

    const bootstrapMod = await importModule("pipeline/bootstrap.js");
    const result = bootstrapMod.bootstrapProjectDoc("my-project", "opencode", projectDir);

    assert.ok(!result.created, "Doc was updated, not created");
    const content = fs.readFileSync(result.filePath, "utf-8");
    assert.ok(content.includes("New Stack"), "Updated with new tech stack");
    assert.ok(content.includes("This is my custom content that must survive"), "Custom section preserved");
    assert.ok(!content.includes("Old Stack"), "Old content replaced");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 6: bootstrap action via MCP tool", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const projectDir = path.join(tmp, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("test-project");
    const { writeModel: writeProjectModel } = await importModule("lenses/manager.js");
    writeProjectModel("test-project", {
      project: "test-project",
      model: {
        version: 3,
        project: "test-project",
        generatedAt: new Date().toISOString(),
        techStack: ["Rust"],
        conventions: ["Use cargo clippy"],
        procedures: [],
        guardrails: [],
        activeWork: [],
        openThreads: [],
        tokenEstimate: 10,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 3,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    });

    const toolsMod = await importModule("tools.js");
    const result = await toolsMod.handleGraphMemory({
      action: "bootstrap",
      project: "test-project",
      harness: "opencode",
      cwd: projectDir,
    });

    const response = JSON.parse(result.content[0].text);
    assert.ok(response.success, "Bootstrap succeeded");
    assert.equal(path.basename(response.filePath), "AGENT.md");
    assert.ok(response.created, "Doc was created");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 6: drift detection finds missing sections", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const projectDir = path.join(tmp, "drift-project");
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, "AGENT.md"), [
      "<!-- graph-memory:bootstrap -->",
      "# Project Context — drift-project",
      "",
      "## Tech Stack",
      "- Old",
      "",
    ].join("\n"));

    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("drift-project");
    const { writeModel: writeProjectModel } = await importModule("lenses/manager.js");
    writeProjectModel("drift-project", {
      project: "drift-project",
      model: {
        version: 3,
        project: "drift-project",
        generatedAt: new Date().toISOString(),
        techStack: ["New"],
        conventions: ["New convention added"],
        procedures: [],
        guardrails: ["No direct DB access"],
        activeWork: [],
        openThreads: [],
        tokenEstimate: 10,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 1,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    });

    const bootstrapMod = await importModule("pipeline/bootstrap.js");
    const drift = bootstrapMod.detectDocDrift("drift-project", projectDir, "opencode");

    assert.ok(drift.drifted, "Drift detected");
    assert.ok(drift.missing.includes("conventions"), "Missing conventions");
    assert.ok(drift.missing.includes("guardrails"), "Missing guardrails");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 7: dreamer v3 tools — propose and promote dreams", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const pendingDir = path.join(graphRoot, "dreams", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    const obsDir = path.join(graphRoot, ".pipeline", "observations");
    fs.mkdirSync(obsDir, { recursive: true });

    fs.writeFileSync(path.join(obsDir, "dream_001.json"), JSON.stringify({
      tool: "propose_dream",
      fragment: "User's preference for small commits mirrors their approach to debugging — incremental verification at every step",
      references: ["patterns/incremental-commits", "patterns/debug-first"],
      reasoning: "Cross-domain pattern in cognitive style",
      type: "connection",
    }));

    const existingDream = {
      fragment: "Old dream fragment",
      confidence: 0.4,
      nodes_referenced: ["patterns/test-first"],
      type: "emergence",
      source: "dreamer-v3",
      created: new Date(Date.now() - 3 * 86400000).toISOString(),
      reinforcement_sessions: 2,
    };
    fs.writeFileSync(path.join(pendingDir, "dream_old_abc.json"), JSON.stringify(existingDream));

    fs.writeFileSync(path.join(obsDir, "dream_002.json"), JSON.stringify({
      tool: "promote_dream",
      dream_file: "dream_old_abc.json",
      reason: "Reinforced across multiple sessions",
      new_confidence: 0.55,
    }));

    const dreamerMod = await importModule("pipeline/dreamer-v3-tools.js");
    const result = dreamerMod.processDreamerV3Outputs();

    assert.equal(result.dreamsProposed, 1, "1 dream proposed");
    assert.equal(result.dreamsPromoted, 1, "1 dream promoted");

    const newDreams = fs.readdirSync(pendingDir).filter((f) => f.startsWith("dream_") && !f.includes("old"));
    assert.equal(newDreams.length, 1, "New dream file created");

    const promoted = JSON.parse(fs.readFileSync(path.join(graphRoot, "dreams", "integrated", "dream_old_abc.json"), "utf-8"));
    assert.equal(promoted.confidence, 0.55, "Dream promoted to 0.55");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 7: dreamer v3 builds input from models", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const modelMod = await importModule("mind/model.js");
    modelMod.writeModel({
      model: {
        version: 3,
        generatedAt: new Date().toISOString(),
        cognitiveStyle: "analytical",
        decisionPatterns: ["prefers boring technology"],
        preferences: ["dark mode", "vim keybindings"],
        guardrails: [],
        emotionalProfile: "calm",
        relationalNotes: [],
        tokenEstimate: 50,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 5,
    });

    const lensMod = await importModule("lenses/manager.js");
    lensMod.ensureLens("test-project");
    const { writeModel: writeProjectModel } = await importModule("lenses/manager.js");
    writeProjectModel("test-project", {
      project: "test-project",
      model: {
        version: 3,
        project: "test-project",
        generatedAt: new Date().toISOString(),
        techStack: ["TypeScript"],
        conventions: ["Use ESM"],
        procedures: [],
        guardrails: [],
        activeWork: [],
        openThreads: [],
        tokenEstimate: 20,
      },
      lastCompressorRun: new Date().toISOString(),
      observationCount: 2,
      firstSessionAt: new Date().toISOString(),
      lastSessionAt: new Date().toISOString(),
    });

    const dreamerMod = await importModule("pipeline/dreamer-v3-tools.js");
    const input = dreamerMod.buildDreamerV3Input();

    assert.ok(input.includes("analytical"), "Contains cognitive style");
    assert.ok(input.includes("dark mode"), "Contains preferences");
    assert.ok(input.includes("TypeScript"), "Contains project tech stack");
    assert.ok(input.includes("Global Model"), "Has global model section");
    assert.ok(input.includes("Project Model: test-project"), "Has project model section");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 7: dream reinforcement max confidence is 0.65", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const pendingDir = path.join(graphRoot, "dreams", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    const dream = {
      fragment: "Test dream",
      confidence: 0.60,
      nodes_referenced: ["patterns/test"],
      type: "connection",
    };
    fs.writeFileSync(path.join(pendingDir, "dream_test.json"), JSON.stringify(dream));

    const toolsMod = await importModule("tools.js");
    toolsMod.reinforceDreams("patterns/test");

    const updated = JSON.parse(fs.readFileSync(path.join(pendingDir, "dream_test.json"), "utf-8"));
    assert.ok(updated.confidence > 0.60, "Confidence increased");
    assert.ok(updated.confidence <= 0.65, "Confidence capped at 0.65");

    toolsMod.reinforceDreams("patterns/test");

    const updated2 = JSON.parse(fs.readFileSync(path.join(pendingDir, "dream_test.json"), "utf-8"));
    assert.equal(updated2.confidence, 0.65, "Confidence exactly at max 0.65");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 8: createAdapter returns correct adapter types", async () => {
  const { createAdapter } = await importModule("adapters/index.js");

  const claude = createAdapter("claude-code");
  assert.equal(claude.name, "claude-code");

  const opencode = createAdapter("opencode");
  assert.equal(opencode.name, "opencode");

  const pi = createAdapter("pi");
  assert.equal(pi.name, "pi");

  const codex = createAdapter("codex");
  assert.equal(codex.name, "codex");
});

test("phase 8: shared session start context builds correctly", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const whisperMod = await importModule("mind/whisper.js");
    whisperMod.writeWhisper("User prefers dark mode.");

    const sharedMod = await importModule("adapters/shared.js");
    const ctx = sharedMod.buildSessionStartContext(tmp, "test-session-1");

    assert.equal(ctx.sessionId, "test-session-1");
    assert.equal(ctx.v3Used, true, "v3 context used when whisper exists");
    assert.ok(ctx.tokensUsed > 0, "tokens were counted");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("phase 8: codex adapter is no-op", async () => {
  const { createAdapter } = await importModule("adapters/index.js");
  const codex = createAdapter("codex");

  const startResult = await codex.onSessionStart("/tmp", "sess-1");
  assert.equal(startResult, "", "Codex returns empty context");

  await codex.onSessionEnd("sess-1");
});

test("phase 8: adapter configs match harness capabilities", async () => {
  const { ADAPTER_CONFIGS, isDegradedMode } = await importModule("adapters/index.js");

  assert.equal(ADAPTER_CONFIGS["claude-code"].supportsHooks, true);
  assert.equal(ADAPTER_CONFIGS["claude-code"].projectDocFilename, "CLAUDE.md");

  assert.equal(ADAPTER_CONFIGS["opencode"].supportsPluginEvents, true);
  assert.equal(ADAPTER_CONFIGS["opencode"].projectDocFilename, "AGENT.md");

  assert.equal(ADAPTER_CONFIGS["pi"].supportsPluginEvents, true);

  assert.equal(ADAPTER_CONFIGS["codex"].supportsHooks, false);
  assert.equal(ADAPTER_CONFIGS["codex"].supportsPluginEvents, false);
  assert.equal(isDegradedMode("codex"), true);
  assert.equal(isDegradedMode("claude-code"), false);
});

// --- Phase 9: Migration ---

test("phase 9: migration dry run scans nodes and builds models", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const nodesDir = path.join(graphRoot, "nodes");
    const prefsDir = path.join(nodesDir, "preferences");
    fs.mkdirSync(prefsDir, { recursive: true });

    fs.writeFileSync(path.join(prefsDir, "test-pref.md"), [
      "---",
      "id: preferences/test-pref",
      "gist: User prefers dark mode for all UI work",
      "confidence: 0.85",
      "created: '2026-01-01'",
      "updated: '2026-05-01'",
      "tags: [preference, ui, dark-mode]",
      "edges: []",
      "keywords: []",
      "---",
      "# test-pref",
      "",
      "Explicitly stated preference for dark interfaces.",
    ].join("\n"));

    const decDir = path.join(nodesDir, "decisions");
    fs.mkdirSync(decDir, { recursive: true });
    fs.writeFileSync(path.join(decDir, "use-typescript.md"), [
      "---",
      "id: decisions/use-typescript",
      "gist: Always use TypeScript for new projects",
      "confidence: 0.9",
      "created: '2026-01-15'",
      "updated: '2026-04-20'",
      "tags: [decision, typescript, language]",
      "edges: []",
      "keywords: []",
      "project: agent-memory",
      "---",
      "# use-typescript",
      "",
      "TypeScript is mandatory for all new code.",
    ].join("\n"));

    const apDir = path.join(nodesDir, "anti-patterns");
    fs.mkdirSync(apDir, { recursive: true });
    fs.writeFileSync(path.join(apDir, "no-eval.md"), [
      "---",
      "id: anti-patterns/no-eval",
      "gist: Never use eval() in any context",
      "confidence: 0.95",
      "created: '2026-02-01'",
      "anti_pattern: true",
      "tags: [anti-pattern, safety, eval]",
      "edges: []",
      "keywords: []",
      "---",
      "# no-eval",
      "",
      "eval() is a security risk and should never be used.",
    ].join("\n"));

    const { buildGlobalModel, buildProjectModels } = await importModule("scripts/migrate-v2-to-v3.js");

    const { collectNodes } = await importModule("scripts/migrate-v2-to-v3.js");
    const nodes = collectNodes(nodesDir);

    assert.equal(nodes.length, 3, "Scanned all 3 nodes");
    assert.ok(nodes.some(n => n.category === "preferences"), "Found preference node");
    assert.ok(nodes.some(n => n.category === "decisions"), "Found decision node");
    assert.ok(nodes.some(n => n.category === "anti-patterns"), "Found anti-pattern node");

    const pref = nodes.find(n => n.category === "preferences");
    assert.equal(pref.confidence, 0.85, "Parsed confidence");
    assert.ok(pref.tags.includes("preference"), "Parsed tags");

    const dec = nodes.find(n => n.category === "decisions");
    assert.equal(dec.project, "agent-memory", "Parsed project from frontmatter");

    const { model, whisper } = buildGlobalModel(nodes);
    assert.ok(model.preferences.length > 0, "Global model has preferences");
    assert.ok(model.decisionPatterns.length > 0, "Global model has decision patterns");
    assert.ok(model.guardrails.length > 0, "Global model has guardrails from anti-patterns");
    assert.ok(whisper.length > 0, "Global whisper generated");

    const projectModels = buildProjectModels(nodes);
    assert.ok(projectModels.has("agent-memory"), "Created project model for agent-memory");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- YAML Repair ---

test("yaml-repair: fixes unquoted colons in title and gist", async () => {
  const { repairYamlFrontmatter, tryParseWithRepair } = await importModule("pipeline/yaml-repair.js");

  const raw = [
    "---",
    "id: test/node",
    "title: Auto-Provision Region Default: nyc1 vs nyc3 Misconfiguration",
    "gist: Patrick's decision pattern: when an existing system already handles it",
    "confidence: 0.85",
    "created: '2026-01-01'",
    "tags: []",
    "edges: []",
    "---",
    "# test",
  ].join("\n");

  const parsed = tryParseWithRepair(raw);
  assert.ok(parsed, "Parsed after repair");
  assert.equal(parsed.data.confidence, 0.85, "Confidence preserved");
  assert.ok(parsed.data.title.includes("nyc1"), "Title content preserved");

  const { fixes } = repairYamlFrontmatter(raw);
  assert.ok(fixes.some(f => f.includes("unquoted-colon")), "Detected unquoted colon fix");
});

test("yaml-repair: fixes duplicated keys", async () => {
  const { repairYamlFrontmatter, tryParseWithRepair } = await importModule("pipeline/yaml-repair.js");

  const raw = [
    "---",
    "id: test/node",
    "title: Test",
    "confidence: 0.7",
    "dream_refs:",
    "  - dreams/a.json",
    "edges: []",
    "dream_refs:",
    "  - dreams/b.json",
    "  - dreams/c.json",
    "---",
    "# test",
  ].join("\n");

  const parsed = tryParseWithRepair(raw);
  assert.ok(parsed, "Parsed after duplicate key repair");
  assert.ok(parsed.data.dream_refs.length >= 2, "Dream refs merged");

  const { fixes } = repairYamlFrontmatter(raw);
  assert.ok(fixes.some(f => f.includes("duplicate-key")), "Detected duplicate key fix");
});

test("yaml-repair: fixes extra trailing quotes on dates", async () => {
  const { repairYamlFrontmatter, tryParseWithRepair } = await importModule("pipeline/yaml-repair.js");

  const raw = [
    "---",
    "id: test/node",
    "title: Test",
    "confidence: 0.7",
    "created: '2026-04-09'",
    "updated: '2026-05-10''",
    "tags: []",
    "edges: []",
    "---",
    "# test",
  ].join("\n");

  const parsed = tryParseWithRepair(raw);
  assert.ok(parsed, "Parsed after quote repair");
  assert.equal(parsed.data.updated, "2026-05-10", "Date value corrected");
});

test("yaml-repair: fixes bad indentation", async () => {
  const { repairYamlFrontmatter, tryParseWithRepair } = await importModule("pipeline/yaml-repair.js");

  const raw = [
    "---",
    "id: test/node",
    "title: Test",
    "edges:",
    "  - target: foo",
    "    type: relates_to",
    "    weight: 0.5",
    " soma:",
    "  valence: positive",
    "  intensity: 0.56",
    "  marker: test",
    "---",
    "# test",
  ].join("\n");

  const parsed = tryParseWithRepair(raw);
  assert.ok(parsed, "Parsed after indentation repair");
  assert.ok(parsed.data.soma, "Soma parsed");
  assert.equal(parsed.data.soma.valence, "positive", "Soma valence preserved");
});

// --- File interactions ---

test("collectFileInteractions groups files by path with counts and roles", async () => {
  const { collectFileInteractions } = await importModule("project-working.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-memory-fi-test-"));
  const tracePath = path.join(tmp, "tool-trace.jsonl");

  const events = [
    { toolName: "Read", accessKind: "read", targetPaths: ["src/foo.ts", "src/bar.ts"], success: true },
    { toolName: "Read", accessKind: "read", targetPaths: ["src/foo.ts"], success: true },
    { toolName: "Edit", accessKind: "write", targetPaths: ["src/foo.ts"], success: true },
    { toolName: "Write", accessKind: "write", targetPaths: ["src/new-file.ts"], success: true },
    { toolName: "Bash", accessKind: "execute", commandPreview: "npx tsc --noEmit", success: true },
    { toolName: "Bash", accessKind: "execute", commandPreview: "npm test -- src/foo.test.ts", success: true },
    { toolName: "Read", accessKind: "read", targetPaths: ["node_modules/blah/index.js"], success: true },
    { toolName: "Read", accessKind: "read", targetPaths: [".graph-memory/nodes/test.md"], success: true },
  ];

  for (const event of events) {
    fs.appendFileSync(tracePath, JSON.stringify(event) + "\n");
  }

  const result = collectFileInteractions(tracePath);

  assert.ok(result.length > 0, "Returns interactions");

  const fooEntry = result.find((fi) => fi.path === "src/foo.ts");
  assert.ok(fooEntry, "Groups src/foo.ts");
  assert.equal(fooEntry.count, 3, "Three touches on foo.ts");
  assert.ok(fooEntry.roles.includes("read"), "Has read role");
  assert.ok(fooEntry.roles.includes("edited"), "Has edited role");

  const newFileEntry = result.find((fi) => fi.path === "src/new-file.ts");
  assert.ok(newFileEntry, "Includes created file");
  assert.ok(newFileEntry.roles.includes("edited"), "Created file has edited role");

  const nodeModulesEntry = result.find((fi) => fi.path.includes("node_modules"));
  assert.ok(!nodeModulesEntry, "Excludes node_modules");

  const graphEntry = result.find((fi) => fi.path.includes(".graph-memory"));
  assert.ok(!graphEntry, "Excludes .graph-memory paths");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("renderProjectWorkingMarkdown includes Files section from keyFiles", async () => {
  const graphRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "graph-memory-render-")), ".graph-memory");
  process.env.GRAPH_MEMORY_ROOT = graphRoot;
  process.env.GRAPH_MEMORY_V3 = "1";
  const { reloadConfig } = await importModule("config.js");
  reloadConfig();
  const { updateProjectWorkingFromSession } = await importModule("project-working.js");

  const stateDir = path.join(graphRoot, "working", "projects");
  fs.mkdirSync(stateDir, { recursive: true });

  const updateDir = path.join(stateDir, "_updates", "test_proj");
  fs.mkdirSync(updateDir, { recursive: true });
  const updatePath = path.join(updateDir, "sess1.json");
  const fileInteractionPath = path.join(updateDir, "sess1.files.json");

  const artifact = {
    sessionId: "sess1",
    project: "test_proj",
    generatedAt: new Date().toISOString(),
    summaries: ["Fixed the rendering bug"],
    tasksWorkedOn: ["Fix rendering"],
    keyFiles: [
      { path: "src/render.ts", role: "edited", note: "fixed layout bug" },
      { path: "tests/render.test.ts", role: "ran", note: "all passing" },
    ],
  };
  fs.writeFileSync(updatePath, JSON.stringify(artifact));

  const fileInteractionData = [
    { path: "src/render.ts", count: 5, roles: ["edited"] },
    { path: "tests/render.test.ts", count: 2, roles: ["ran"] },
  ];
  fs.writeFileSync(fileInteractionPath, JSON.stringify(fileInteractionData));

  const deltaDir = path.join(graphRoot, ".deltas");
  fs.mkdirSync(deltaDir, { recursive: true });
  fs.writeFileSync(path.join(deltaDir, "sess1.json"), JSON.stringify({
    session_id: "sess1",
    scribes: [{ summary: "Fixed the rendering bug", deltas: [{ type: "create_node", path: "decisions/test", project: "test_proj" }] }],
  }));

  updateProjectWorkingFromSession({
    project: "test_proj",
    sessionId: "sess1",
    updatePath,
    fileInteractionPath,
  });

  const workingMd = fs.readFileSync(path.join(stateDir, "test_proj.md"), "utf-8");
  assert.ok(workingMd.includes("## Files"), "Includes Files section");
  assert.ok(workingMd.includes("src/render.ts"), "Mentions render.ts");
  assert.ok(workingMd.includes("edited"), "Shows edited role");
  assert.ok(workingMd.includes("tests/render.test.ts"), "Mentions test file");

  fs.rmSync(path.dirname(graphRoot), { recursive: true, force: true });
});
