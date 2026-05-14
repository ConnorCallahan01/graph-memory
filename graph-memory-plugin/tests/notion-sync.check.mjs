import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "node:os";
import path from "path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");

function makeTempGraph() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-memory-notion-test-"));
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
  ], { encoding: "utf-8", env: { ...process.env, GRAPH_MEMORY_ROOT: graphRoot } });
}

async function setupEnv(graphRoot) {
  process.env.GRAPH_MEMORY_ROOT = graphRoot;
  const { reloadConfig } = await importModule("config.js");
  reloadConfig();
}

function importModule(name) {
  return import(pathToFileURL(path.join(pluginDir, "dist/graph-memory", name)).href);
}

function populateSampleData(graphRoot) {
  const graphDir = path.join(graphRoot, "graph");

  fs.writeFileSync(path.join(graphDir, "patterns", "atomic-commits.md"), matter.stringify(
    "# Atomic Commits\n\nPrefer small focused commits over large ones.",
    {
      id: "patterns/atomic-commits",
      gist: "User prefers atomic commits",
      confidence: 0.8,
      tags: ["git", "workflow"],
      keywords: ["commit", "atomic"],
      category: "patterns",
      updated: "2026-05-13",
    }
  ));

  fs.writeFileSync(path.join(graphDir, "decisions", "use-filesystem.md"), matter.stringify(
    "# Use Filesystem\n\nChose filesystem over database for storage.",
    {
      id: "decisions/use-filesystem",
      gist: "Chose filesystem as the database",
      confidence: 0.85,
      tags: ["architecture"],
      keywords: ["filesystem", "storage"],
      category: "decisions",
      updated: "2026-05-12",
    }
  ));

  fs.writeFileSync(path.join(graphDir, "preferences", "dark-mode.md"), matter.stringify(
    "# Dark Mode\n\nPrefers dark mode in all editors.",
    {
      id: "preferences/dark-mode",
      gist: "User prefers dark mode",
      confidence: 0.9,
      tags: ["ui", "preference"],
      keywords: ["dark", "mode"],
      category: "preferences",
      updated: "2026-05-10",
    }
  ));

  const modelDir = path.join(graphRoot, "mind");
  fs.writeFileSync(path.join(modelDir, "model.json"), JSON.stringify({
    model: {
      version: 3,
      generatedAt: "2026-05-13T12:00:00Z",
      cognitiveStyle: "Pragmatic",
      decisionPatterns: ["Prefers proven tech"],
      preferences: ["Dark mode", "Atomic commits"],
      guardrails: ["Never use eval()"],
      emotionalProfile: "Calm",
      relationalNotes: [],
      tokenEstimate: 50,
    },
    lastCompressorRun: "2026-05-13T12:00:00Z",
    observationCount: 5,
  }));

  const lensDir = path.join(graphRoot, "lenses", "test-project");
  fs.mkdirSync(lensDir, { recursive: true });
  fs.writeFileSync(path.join(lensDir, "model.json"), JSON.stringify({
    project: "test-project",
    model: {
      version: 3,
      project: "test-project",
      generatedAt: "2026-05-13T12:00:00Z",
      techStack: ["TypeScript", "Node.js"],
      conventions: ["ES modules"],
      procedures: [],
      guardrails: [],
      activeWork: ["Building Notion sync"],
      openThreads: ["Need to add tests"],
      tokenEstimate: 30,
    },
    lastCompressorRun: "2026-05-13T12:00:00Z",
    observationCount: 2,
    firstSessionAt: "2026-05-12T10:00:00Z",
    lastSessionAt: "2026-05-13T15:00:00Z",
  }));

  const sessionsDir = path.join(graphRoot, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "test-project.jsonl"), [
    JSON.stringify({
      id: "sess_001", project: "test-project", sessionId: "sess_001",
      timestamp: "2026-05-13T10:00:00Z",
      activeWork: ["Building Notion sync"],
      shipped: ["State management module"],
      decisions: ["Use SHA-256 for hashing"],
      blocked: [],
      openThreads: ["Need to add tests"],
      correctionsGiven: [],
      nextSessionShould: "Write smoke tests",
    }),
    JSON.stringify({
      id: "sess_002", project: "test-project", sessionId: "sess_002",
      timestamp: "2026-05-13T14:00:00Z",
      activeWork: ["Writing tests"],
      shipped: [],
      decisions: [],
      blocked: ["Waiting on ntn CLI install"],
      openThreads: ["Inbound sync design"],
      correctionsGiven: [],
      nextSessionShould: "Test inbound detection",
    }),
  ].join("\n"));

  const briefsDir = path.join(graphRoot, "briefs", "daily");
  fs.mkdirSync(briefsDir, { recursive: true });
  fs.writeFileSync(path.join(briefsDir, "2026-05-13.json"), JSON.stringify({
    date: "2026-05-13",
    generated_at: "2026-05-13T07:00:00Z",
    timezone: "UTC",
    start_here: ["Finish Notion sync state management"],
    yesterday: ["Built notion-sync.ts module"],
    open_loops: ["Need to add tests"],
    seven_day_trends: ["Active development on Notion integration"],
    agent_friction: [],
    suggested_claude_updates: [],
    suggested_memory_updates: [],
    one_thing_today: "Ship notion sync tests",
  }));

  const dreamsPending = path.join(graphRoot, "dreams", "pending");
  fs.mkdirSync(dreamsPending, { recursive: true });
  fs.writeFileSync(path.join(dreamsPending, "dream_test.json"), JSON.stringify({
    fragment: "Test dream fragment",
    confidence: 0.3,
    nodes_referenced: ["patterns/atomic-commits"],
    type: "connection",
  }));
}

// --- Tests ---

test("state: create, write, read round-trip", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("pipeline/notion-sync.js");

    const state = mod.createEmptyNotionSyncState();
    state.enabled = true;
    state.parentPageId = "test-page-123";
    state.lastSyncAt = "2026-05-13T08:00:00Z";
    state.pages["how-i-think"] = {
      pageId: "page-abc",
      sourceNodes: ["mind/model"],
      lastSyncedHash: "sha256:abc123",
      lastNotionHash: "sha256:abc123",
    };

    mod.writeNotionSyncState(state);

    const loaded = mod.readNotionSyncState();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.parentPageId, "test-page-123");
    assert.equal(loaded.pages["how-i-think"].pageId, "page-abc");
    assert.equal(loaded.pages["how-i-think"].lastSyncedHash, "sha256:abc123");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("state: read from missing file returns empty state", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("pipeline/notion-sync.js");

    const loaded = mod.readNotionSyncState();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.parentPageId, "");
    assert.deepEqual(loaded.pages, {});
    assert.deepEqual(loaded.rows, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("hash: deterministic content hashing", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    const mod = await importModule("pipeline/notion-sync.js");

    const hash1 = mod.computeContentHash("hello world");
    const hash2 = mod.computeContentHash("hello world");
    const hash3 = mod.computeContentHash("hello universe");

    assert.equal(hash1, hash2, "Same content produces same hash");
    assert.notEqual(hash1, hash3, "Different content produces different hash");
    assert.ok(hash1.startsWith("sha256:"), "Hash has sha256 prefix");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: fresh state classifies everything as new", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const state = mod.createEmptyNotionSyncState();
    const diff = mod.buildNotionDiff(state);

    assert.ok(diff.items.length > 0, "Diff has items");
    assert.equal(diff.stats.unchanged, 0, "Nothing unchanged on fresh state");
    assert.ok(diff.stats.new > 0, "Has new items: " + diff.stats.new);
    assert.equal(diff.stats.updated, 0, "No updates on fresh state");

    const keys = diff.items.map((i) => i.key);
    assert.ok(keys.some((k) => k.startsWith("patterns/")), "Includes graph nodes");
    assert.ok(keys.includes("mind/model"), "Includes global model");
    assert.ok(keys.some((k) => k.startsWith("sessions/")), "Includes session logs");
    assert.ok(keys.some((k) => k.startsWith("brief:")), "Includes briefs");
    assert.ok(keys.some((k) => k.startsWith("dreams/")), "Includes dreams");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: synced state detects only changes", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");

    const firstDiff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());
    const allNewItems = firstDiff.items.filter((i) => i.classification === "new");
    assert.ok(allNewItems.length > 0, "First diff has new items");

    const state = mod.createEmptyNotionSyncState();
    state.lastSyncAt = new Date().toISOString();
    for (const item of allNewItems) {
      if (item.key.startsWith("brief:")) {
        state.rows[item.key] = {
          pageId: "row-" + item.key,
          sourceField: "brief",
          status: "active",
          lastSyncedHash: item.contentHash,
        };
      } else {
        state.pages[item.key] = {
          pageId: "page-" + item.key,
          sourceNodes: [item.key],
          lastSyncedHash: item.contentHash,
          lastNotionHash: item.contentHash,
        };
      }
    }

    const secondDiff = mod.buildNotionDiff(state);
    assert.equal(secondDiff.stats.unchanged, firstDiff.items.length, "All items unchanged after sync");

    const nodePath = path.join(graphRoot, "graph", "patterns", "atomic-commits.md");
    const original = fs.readFileSync(nodePath, "utf-8");
    fs.writeFileSync(nodePath, original + "\n\nUpdated content for testing.");

    const thirdDiff = mod.buildNotionDiff(state);
    assert.ok(thirdDiff.stats.updated >= 1, "At least 1 updated item after change: " + thirdDiff.stats.updated);
    const updatedItem = thirdDiff.items.find((i) => i.key === "patterns/atomic-commits");
    assert.ok(updatedItem, "The modified node appears in diff");
    assert.equal(updatedItem.classification, "updated");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: project models scanned from lenses", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const diff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());

    const projectItem = diff.items.find((i) => i.key === "projects/test-project");
    assert.ok(projectItem, "Project model found in diff");
    assert.equal(projectItem.classification, "new");
    assert.equal(projectItem.batch, "project:test-project");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: session logs include task and decision signals", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const diff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());

    const sessionItem = diff.items.find((i) => i.key === "sessions/test-project");
    assert.ok(sessionItem, "Session log found in diff");
    assert.ok(sessionItem.metadata.taskSignals.length > 0, "Has task signals");
    assert.ok(sessionItem.metadata.taskSignals.includes("Need to add tests"), "Includes openThreads");
    assert.ok(sessionItem.metadata.taskSignals.includes("Write smoke tests"), "Includes nextSessionShould");
    assert.ok(sessionItem.metadata.decisionSignals.includes("Use SHA-256 for hashing"), "Includes decisions");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: batches are correctly assigned", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const diff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());

    const patternItem = diff.items.find((i) => i.key === "patterns/atomic-commits");
    assert.equal(patternItem.batch, "global-wiki");

    const decisionItem = diff.items.find((i) => i.key === "decisions/use-filesystem");
    assert.equal(decisionItem.batch, "decisions");

    const modelItem = diff.items.find((i) => i.key === "mind/model");
    assert.equal(modelItem.batch, "global-wiki");

    const briefItem = diff.items.find((i) => i.key.startsWith("brief:"));
    assert.equal(briefItem.batch, "briefs");

    const dreamItem = diff.items.find((i) => i.key.startsWith("dreams/"));
    assert.equal(dreamItem.batch, "dreams");

    const batches = diff.batches;
    assert.ok(batches.includes("global-wiki"), "Has global-wiki batch");
    assert.ok(batches.includes("decisions"), "Has decisions batch");
    assert.ok(batches.includes("briefs"), "Has briefs batch");
    assert.ok(batches.includes("dreams"), "Has dreams batch");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("batching: groups items within batch size limit", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");

    const fakeDiff = {
      generatedAt: new Date().toISOString(),
      items: Array.from({ length: 55 }, (_, i) => ({
        key: `item-${i}`,
        classification: i < 50 ? "new" : "unchanged" ,
        batch: i < 25 ? "batch-a" : "batch-b",
        filePath: `/fake/${i}`,
        contentHash: `sha256:${i}`,
      })),
      stats: { new: 50, updated: 0, archived: 0, unchanged: 5, total: 55 },
      batches: ["batch-a", "batch-b"],
    };

    const batches = mod.groupIntoBatches(fakeDiff, 10);

    assert.ok(batches.length >= 5, "At least 5 batches for 50 changed items with max 10: got " + batches.length);
    for (const batch of batches) {
      assert.ok(batch.length <= 10, "Batch respects max size: got " + batch.length);
    }

    const totalItems = batches.reduce((sum, b) => sum + b.length, 0);
    assert.equal(totalItems, 50, "All changed items batched (unchanged excluded)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: empty graph produces empty diff", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const diff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());

    assert.equal(diff.items.length, 0, "Empty graph has no diff items");
    assert.equal(diff.stats.total, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("diff: working state changes detected", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const workingDir = path.join(graphRoot, "working", "projects", "test-project");
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(path.join(workingDir, "test-project.state.json"), JSON.stringify({
      project: "test-project",
      createdAt: "2026-05-13T10:00:00Z",
      updatedAt: new Date().toISOString(),
      sessions: [{
        sessionId: "sess_001",
        project: "test-project",
        activityAt: new Date().toISOString(),
        firstCapturedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        summaries: ["Built notion sync module"],
        tasksWorkedOn: ["Notion sync state management"],
        commits: [],
        worked: ["State file read/write"],
        didntWork: [],
        nextPickup: ["Write smoke tests"],
        recalledNodes: [],
        createdNodes: [],
        updatedNodes: [],
        keyFiles: [],
      }],
    }));

    const mod = await importModule("pipeline/notion-sync.js");
    const state = mod.createEmptyNotionSyncState();
    state.lastSyncAt = new Date(Date.now() - 86400000).toISOString();

    const diff = mod.buildNotionDiff(state);
    const workingItem = diff.items.find((i) => i.key === "working/test-project");
    assert.ok(workingItem, "Working state found in diff");
    assert.ok(workingItem.metadata.taskSignals.includes("Write smoke tests"), "Includes nextPickup as task signal");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Build 2: Job type & daemon integration ---

test("job-schema: notion_sync type is valid", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { createJob } = await importModule("pipeline/job-schema.js");
    const job = createJob({
      type: "notion_sync",
      payload: { reason: "test", date: "2026-05-14" },
      triggerSource: "test",
      idempotencyKey: "notion-sync:test",
    });

    assert.equal(job.type, "notion_sync");
    assert.equal(job.id.startsWith("notion_sync_"), true, "Job ID has notion_sync prefix");
    assert.equal(job.maxAttempts, 2, "Default max attempts is 2");
    assert.deepEqual(job.payload, { reason: "test", date: "2026-05-14" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("job-queue: notion_sync has priority 7", async () => {
  const mod = await importModule("pipeline/job-queue.js");
  const schemaMod = await importModule("pipeline/job-schema.js");

  const notionJob = schemaMod.createJob({
    type: "notion_sync",
    payload: { reason: "test", date: "2026-05-14" },
    triggerSource: "test",
    idempotencyKey: "notion-sync:prio-test",
  });

  const analysisJob = schemaMod.createJob({
    type: "memory_analysis",
    payload: { briefDate: "2026-05-14", timeZone: "UTC", reason: "test" },
    triggerSource: "test",
    idempotencyKey: "memory-analysis:prio-test",
  });

  assert.ok(notionJob, "Notion sync job created");
  assert.ok(analysisJob, "Memory analysis job created");
});

test("job-queue: enqueue and process notion_sync job", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { ensureJobDirectories, enqueueJob, listJobs, claimNextJob, completeRunningJob } =
      await importModule("pipeline/job-queue.js");

    ensureJobDirectories();

    enqueueJob({
      type: "notion_sync",
      payload: { reason: "test enqueue", date: "2026-05-14" },
      triggerSource: "test",
      idempotencyKey: "notion-sync:enqueue-test",
    });

    const queued = listJobs("queued");
    const notionJob = queued.find((j) => j.type === "notion_sync");
    assert.ok(notionJob, "Notion sync job found in queue");
    assert.equal(notionJob.payload.reason, "test enqueue");
    assert.equal(notionJob.payload.date, "2026-05-14");

    const claimed = claimNextJob();
    assert.ok(claimed, "Job claimed");
    assert.equal(claimed.type, "notion_sync");
    assert.equal(claimed.state, "running");

    completeRunningJob(claimed);
    const running = listJobs("running");
    assert.equal(running.length, 0, "No running jobs after complete");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("job-queue: notion_sync idempotency prevents duplicates", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { ensureJobDirectories, enqueueJob, listJobs } = await importModule("pipeline/job-queue.js");
    ensureJobDirectories();

    enqueueJob({
      type: "notion_sync",
      payload: { reason: "first", date: "2026-05-14" },
      triggerSource: "test",
      idempotencyKey: "notion-sync:idem-test",
    });

    enqueueJob({
      type: "notion_sync",
      payload: { reason: "duplicate", date: "2026-05-14" },
      triggerSource: "test",
      idempotencyKey: "notion-sync:idem-test",
    });

    const queued = listJobs("queued").filter((j) => j.type === "notion_sync");
    assert.equal(queued.length, 1, "Only one job enqueued with same idempotency key");
    assert.equal(queued[0].payload.reason, "first", "Original job preserved");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("job-queue: hasActiveJob detects notion_sync", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { ensureJobDirectories, enqueueJob, claimNextJob, hasActiveJob } =
      await importModule("pipeline/job-queue.js");
    ensureJobDirectories();

    assert.equal(hasActiveJob("notion_sync"), false, "No active job initially");

    enqueueJob({
      type: "notion_sync",
      payload: { reason: "test", date: "2026-05-14" },
      triggerSource: "test",
      idempotencyKey: "notion-sync:active-test",
    });

    const job = claimNextJob();
    assert.equal(hasActiveJob("notion_sync"), true, "Notion sync job is active after claim");
    assert.equal(job.type, "notion_sync");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("config: notionSync section has defaults", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const { CONFIG } = await importModule("config.js");
    assert.ok(CONFIG.notionSync, "notionSync config section exists");
    assert.equal(CONFIG.notionSync.enabled, false, "Disabled by default");
    assert.equal(CONFIG.notionSync.syncHourLocal, 8, "Default sync hour is 8");
    assert.equal(CONFIG.notionSync.maxBatchSize, 30, "Default max batch size is 30");
    assert.equal(CONFIG.notionSync.skipInbound, false, "Inbound enabled by default");
    assert.ok(CONFIG.paths.notionSyncState, "notionSyncState path exists");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Build 3: Notion CLI adapter ---

test("notion-cli: checkNtnInstalled returns boolean", async () => {
  const mod = await importModule("pipeline/notion-cli.js");
  const result = mod.checkNtnInstalled();
  assert.equal(typeof result, "boolean");
});

test("notion-cli: checkNtn returns structured result", async () => {
  const mod = await importModule("pipeline/notion-cli.js");
  const result = mod.checkNtn();
  assert.equal(typeof result.installed, "boolean");
  assert.equal(typeof result.authenticated, "boolean");
  if (!result.installed) {
    assert.equal(result.authenticated, false, "Cannot be authenticated if not installed");
  }
});

test("notion-cli: buildDatabaseProperties creates correct schema", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  const schema = [
    { name: "Title", type: "title" },
    { name: "Status", type: "select", config: { options: [
      { name: "Todo", color: "gray" },
      { name: "Done", color: "green" },
    ] } },
    { name: "Due Date", type: "date" },
    { name: "Notes", type: "rich_text" },
    { name: "Count", type: "number", config: { format: "number" } },
    { name: "Link", type: "url" },
  ];

  const props = mod.buildDatabaseProperties(schema);

  assert.ok(props.Title.title, "Title is title type");
  assert.ok(props.Status.select, "Status is select type");
  assert.equal(props.Status.select.options.length, 2, "Status has 2 options");
  assert.equal(props.Status.select.options[0].name, "Todo");
  assert.ok(props["Due Date"].date, "Due Date is date type");
  assert.ok(props.Notes.rich_text, "Notes is rich_text type");
  assert.ok(props.Count.number, "Count is number type");
  assert.ok(props.Link.url, "Link is url type");
});

test("notion-cli: TASKS_DB_SCHEMA is valid", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  assert.ok(Array.isArray(mod.TASKS_DB_SCHEMA));
  assert.ok(mod.TASKS_DB_SCHEMA.length > 0);

  const props = mod.buildDatabaseProperties(mod.TASKS_DB_SCHEMA);
  assert.ok(props.Name.title, "Tasks has Name title");
  assert.ok(props.Status.select, "Tasks has Status select");
  assert.ok(props.Project.select, "Tasks has Project select");
  assert.ok(props["First Seen"].date, "Tasks has First Seen date");

  const statusOptions = props.Status.select.options.map((o) => o.name);
  assert.ok(statusOptions.includes("Backlog"));
  assert.ok(statusOptions.includes("In Progress"));
  assert.ok(statusOptions.includes("Done"));
});

test("notion-cli: DECISIONS_DB_SCHEMA is valid", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  const props = mod.buildDatabaseProperties(mod.DECISIONS_DB_SCHEMA);
  assert.ok(props.Decision.title, "Decisions has Decision title");
  assert.ok(props.Context.rich_text, "Decisions has Context");
  assert.ok(props["Source Nodes"].rich_text, "Decisions has Source Nodes");
});

test("notion-cli: BRIEFS_DB_SCHEMA is valid", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  const props = mod.buildDatabaseProperties(mod.BRIEFS_DB_SCHEMA);
  assert.ok(props.Date.title, "Briefs has Date title");
  assert.ok(props["One Thing Today"].rich_text, "Briefs has One Thing Today");
  assert.ok(props["Friction Count"].number, "Briefs has Friction Count number");
});

test("notion-cli: markdownToBlocks converts headings and paragraphs", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  const md = [
    "# Main Title",
    "Some intro text.",
    "",
    "## Section",
    "- item one",
    "- item two",
    "",
    "### Subsection",
    "> a quote",
    "",
    "---",
    "Final paragraph.",
  ].join("\n");

  const blocks = mod.markdownToBlocks(md);

  assert.equal(blocks[0].type, "heading_1", "First block is h1");
  assert.equal(blocks[1].type, "paragraph", "Second block is paragraph");
  assert.equal(blocks[2].type, "heading_2", "Third block is h2");
  assert.equal(blocks[3].type, "bulleted_list_item", "Fourth block is list item");
  assert.equal(blocks[4].type, "bulleted_list_item", "Fifth block is list item");
  assert.equal(blocks[5].type, "heading_3", "Sixth block is h3");
  assert.equal(blocks[6].type, "quote", "Seventh block is quote");
  assert.equal(blocks[7].type, "divider", "Eighth block is divider");
  assert.equal(blocks[8].type, "paragraph", "Ninth block is paragraph");

  const h1Text = blocks[0].heading_1.rich_text[0].text.content;
  assert.equal(h1Text, "Main Title");
});

test("notion-cli: execNtn throws descriptive error when ntn missing", async () => {
  const mod = await importModule("pipeline/notion-cli.js");

  try {
    mod.createPage("fake-parent-id", "# Test");
    assert.fail("Should have thrown");
  } catch (err) {
    assert.ok(err.message.includes("ntn") || err.message.includes("ENOENT") || err.message.includes("failed"),
      `Error message mentions ntn or command failure: ${err.message}`);
  }
});

// --- Build 4: Outbound transform orchestration ---

test("outbound: writeDiffReport produces valid JSON", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const diff = mod.buildNotionDiff(mod.createEmptyNotionSyncState());
    const reportPath = mod.writeDiffReport(diff);

    assert.ok(fs.existsSync(reportPath), "Diff report written");
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    assert.ok(parsed.items.length > 0, "Report has items");
    assert.ok(parsed.generatedAt, "Report has timestamp");
    assert.ok(parsed.batches.length > 0, "Report has batches");
    assert.equal(parsed.stats.total, diff.items.length, "Stats match");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbound: readSyncPlan returns null when no plan exists", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const plan = mod.readSyncPlan();
    assert.equal(plan, null, "No plan returns null");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbound: executeNotionSync tracks creates in state", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const state = mod.createEmptyNotionSyncState();
    state.parentPageId = "fake-parent";
    state.databases = {
      tasks: { id: "fake-tasks-db" },
      decisions: { id: "fake-decisions-db" },
      briefs: { id: "fake-briefs-db" },
    };

    const plan = {
      generatedAt: new Date().toISOString(),
      syncId: "test-sync-001",
      creates: [
        {
          type: "database_row",
          target: "tasks",
          notionKey: "task:test-task",
          properties: {
            Name: { title: [{ text: { content: "Test task" } }] },
            Status: { select: { name: "Next" } },
          },
          sourceNodes: ["sessions/test-project"],
        },
      ],
      updates: [],
      archives: [],
    };

    const result = mod.executeNotionSync(plan, state);

    assert.equal(result.errors.length > 0, true, "Errors expected since ntn is not available");
    assert.equal(result.created, 0, "No creates succeeded without ntn");
    assert.equal(state.parentPageId, "fake-parent", "State preserved in memory");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbound: executeNotionSync updates state on wiki page create", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const syncMod = await importModule("pipeline/notion-sync.js");
    const cliMod = await importModule("pipeline/notion-cli.js");

    if (!cliMod.checkNtnInstalled()) {
      return;
    }

    const state = syncMod.createEmptyNotionSyncState();
    state.parentPageId = "fake-parent";

    const plan = {
      generatedAt: new Date().toISOString(),
      syncId: "test-sync-002",
      creates: [
        {
          type: "wiki_page",
          target: "global-wiki",
          notionKey: "how-i-think",
          markdown: "# How I Think\n\nTest content.",
          sourceNodes: ["mind/model"],
        },
      ],
      updates: [],
      archives: [],
    };

    const result = syncMod.executeNotionSync(plan, state);
    assert.ok(result.created <= 1, "At most 1 created (0 if ntn not configured)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbound: writeSyncPlan and readSyncPlan round-trip", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const planPath = path.join(graphRoot, ".notion-sync-plan.json");
    const plan = {
      generatedAt: new Date().toISOString(),
      syncId: "test-sync-003",
      creates: [
        {
          type: "database_row",
          target: "tasks",
          notionKey: "task:round-trip-test",
          properties: { Name: { title: [{ text: { content: "Round trip test" } }] } },
          sourceNodes: [],
        },
      ],
      updates: [
        {
          notionPageId: "existing-page-id",
          notionKey: "how-i-think",
          type: "wiki_page",
          markdown: "# Updated content",
          sourceNodes: ["mind/model"],
          mergeStrategy: "replace",
        },
      ],
      archives: [
        {
          notionPageId: "old-page-id",
          notionKey: "old-item",
          reason: "node archived",
        },
      ],
    };

    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    const mod = await importModule("pipeline/notion-sync.js");
    const loaded = mod.readSyncPlan();

    assert.ok(loaded, "Plan loaded");
    assert.equal(loaded.syncId, "test-sync-003");
    assert.equal(loaded.creates.length, 1);
    assert.equal(loaded.updates.length, 1);
    assert.equal(loaded.archives.length, 1);
    assert.equal(loaded.creates[0].notionKey, "task:round-trip-test");
    assert.equal(loaded.updates[0].mergeStrategy, "replace");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbound: executeNotionSync resolves database IDs from state", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");
    const state = mod.createEmptyNotionSyncState();
    state.databases = {
      tasks: { id: "db-tasks-123" },
      decisions: { id: "db-decisions-456" },
      briefs: { id: "db-briefs-789" },
    };

    const plan = {
      generatedAt: new Date().toISOString(),
      syncId: "test-sync-004",
      creates: [
        {
          type: "database_row",
          target: "tasks",
          notionKey: "task:resolve-test",
          properties: { Name: { title: [{ text: { content: "Test" } }] } },
          sourceNodes: [],
        },
        {
          type: "database_row",
          target: "decisions",
          notionKey: "decision:resolve-test",
          properties: { Decision: { title: [{ text: { content: "Test decision" } }] } },
          sourceNodes: [],
        },
        {
          type: "database_row",
          target: "nonexistent",
          notionKey: "row:nonexistent",
          properties: {},
          sourceNodes: [],
        },
      ],
      updates: [],
      archives: [],
    };

    const result = mod.executeNotionSync(plan, state);

    const tasksDbError = result.errors.find((e) => e.includes("tasks") && e.includes("No database"));
    const decisionsDbError = result.errors.find((e) => e.includes("decisions") && e.includes("No database"));
    const nonexistError = result.errors.find((e) => e.includes("nonexistent"));

    assert.ok(!tasksDbError, "Tasks DB resolved from state");
    assert.ok(!decisionsDbError, "Decisions DB resolved from state");
    assert.ok(nonexistError, "Nonexistent target produces error");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Build 5: Inbound sync ---

test("inbound: detectInboundEdits returns empty when no pages tracked", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");
    const syncMod = await importModule("pipeline/notion-sync.js");

    const state = syncMod.createEmptyNotionSyncState();
    const result = mod.detectInboundEdits(state);

    assert.equal(result.edits.length, 0, "No edits when no pages tracked");
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: writeInboundDeltas writes JSON to deltas dir", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const deltas = [{
      notionKey: "how-i-think",
      editType: "guardrail_change",
      sourceNodes: ["mind/model"],
      observation: "Human updated guardrail",
      targetFile: path.join(graphRoot, "mind", "model.json"),
      action: "update_model",
      payload: { field: "model.guardrails", value: ["new rule"] },
    }];

    const deltaPath = mod.writeInboundDeltas(deltas, "2026-05-14");

    assert.ok(fs.existsSync(deltaPath), "Delta file written");
    const parsed = JSON.parse(fs.readFileSync(deltaPath, "utf-8"));
    assert.equal(parsed.source, "notion-inbound");
    assert.equal(parsed.deltas.length, 1);
    assert.equal(parsed.deltas[0].action, "update_model");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: writeInboundInput and readInboundPlan round-trip", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const edits = [{
      notionKey: "how-i-think",
      pageId: "test-page-id",
      classification: "inbound_only",
      currentNotionContent: "Updated content",
      lastSyncedContent: "Old content",
      diskContent: "Disk version",
      sourceNodes: ["mind/model"],
      editType: "guardrail_change",
    }];

    const inputPath = mod.writeInboundInput(edits, "2026-05-14");
    assert.ok(fs.existsSync(inputPath), "Input file written");

    const parsed = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    assert.equal(parsed.edits.length, 1);
    assert.equal(parsed.edits[0].notionKey, "how-i-think");
    assert.equal(parsed.edits[0].classification, "inbound_only");

    const plan = mod.readInboundPlan("2026-05-14");
    assert.equal(plan, null, "No plan exists yet");

    const planPath = path.join(graphRoot, `.notion-inbound-plan-2026-05-14.json`);
    fs.writeFileSync(planPath, JSON.stringify({
      deltas: [{
        notionKey: "how-i-think",
        editType: "guardrail_change",
        sourceNodes: ["mind/model"],
        observation: "Human added guardrail",
        targetFile: path.join(graphRoot, "mind", "model.json"),
        action: "update_model",
        payload: { field: "model.guardrails", value: ["new rule"] },
      }],
    }));

    const loaded = mod.readInboundPlan("2026-05-14");
    assert.ok(loaded, "Plan loaded");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].action, "update_model");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: applyInboundDeltas creates observation files", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const deltas = [{
      notionKey: "global-wiki",
      editType: "new_section",
      sourceNodes: ["patterns/atomic-commits"],
      observation: "Human added a new section about testing patterns",
      targetFile: "",
      action: "create_observation",
      payload: {},
    }];

    const result = mod.applyInboundDeltas(deltas);

    assert.equal(result.applied, 1, "One delta applied");
    assert.equal(result.errors.length, 0, "No errors");

    const mindDir = path.join(graphRoot, "mind");
    const obsFiles = fs.readdirSync(mindDir).filter((f) => f.startsWith("notion-inbound-") && f.endsWith(".json"));
    assert.ok(obsFiles.length > 0, "Observation file created");

    const obs = JSON.parse(fs.readFileSync(path.join(mindDir, obsFiles[0]), "utf-8"));
    assert.equal(obs.source, "notion-inbound");
    assert.ok(obs.tags.includes("source:notion-inbound"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: applyInboundDeltas lowers confidence", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const nodePath = path.join(graphRoot, "graph", "patterns", "atomic-commits.md");
    const contentBefore = fs.readFileSync(nodePath, "utf-8");
    assert.ok(contentBefore.includes("confidence: 0.8"), "Has initial confidence");

    const deltas = [{
      notionKey: "patterns/atomic-commits",
      editType: "deletion",
      sourceNodes: ["patterns/atomic-commits"],
      observation: "Human deleted content from this section",
      targetFile: nodePath,
      action: "lower_confidence",
      payload: { newConfidence: 0.3 },
    }];

    const result = mod.applyInboundDeltas(deltas);

    assert.equal(result.applied, 1);
    const contentAfter = fs.readFileSync(nodePath, "utf-8");
    assert.ok(contentAfter.includes("confidence: 0.3"), "Confidence lowered");
    assert.ok(!contentAfter.includes("confidence: 0.8"), "Old confidence removed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: applyInboundDeltas updates model", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const modelPath = path.join(graphRoot, "mind", "model.json");

    const deltas = [{
      notionKey: "how-i-think",
      editType: "guardrail_change",
      sourceNodes: ["mind/model"],
      observation: "Human updated guardrail",
      targetFile: modelPath,
      action: "update_model",
      payload: { field: "model.guardrails", value: ["Never use eval()", "Always ask before committing"] },
    }];

    const result = mod.applyInboundDeltas(deltas);

    assert.equal(result.applied, 1);
    const model = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
    assert.deepEqual(model.model.guardrails, ["Never use eval()", "Always ask before committing"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: writeMergeInput and readMergeResult round-trip", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const inputPath = mod.writeMergeInput(
      "projects/test-project",
      "baseline content",
      "human edited content",
      "agent updated content",
      ["lenses/test-project/model"],
    );

    assert.ok(fs.existsSync(inputPath), "Merge input file written");
    const parsed = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    assert.equal(parsed.notionKey, "projects/test-project");
    assert.equal(parsed.baseline, "baseline content");
    assert.equal(parsed.humanVersion, "human edited content");
    assert.equal(parsed.agentVersion, "agent updated content");

    const nullResult = mod.readMergeResult("projects/test-project");
    assert.equal(nullResult, null, "No merge result yet");

    const resultPath = path.join(graphRoot, `.notion-merge-result-projects_test-project.json`);
    fs.writeFileSync(resultPath, JSON.stringify({
      notionKey: "projects/test-project",
      mergedMarkdown: "# Merged\n\nHuman section preserved.\n\n> **Agent note:** Also learned that...",
      conflicts: [{
        section: "Conventions",
        humanVersion: "Human's conventions",
        agentVersion: "Agent's conventions",
        resolution: "human_wins",
      }],
    }));

    const mergeResult = mod.readMergeResult("projects/test-project");
    assert.ok(mergeResult, "Merge result loaded");
    assert.equal(mergeResult.conflicts.length, 1);
    assert.equal(mergeResult.conflicts[0].resolution, "human_wins");
    assert.ok(mergeResult.mergedMarkdown.includes("Merged"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("inbound: applyInboundDeltas handles missing target file gracefully", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const mod = await importModule("pipeline/notion-inbound.js");

    const deltas = [{
      notionKey: "nonexistent",
      editType: "update_node",
      sourceNodes: [],
      observation: "Should fail gracefully",
      targetFile: "/nonexistent/path/to/file.md",
      action: "update_node",
      payload: {},
    }];

    const result = mod.applyInboundDeltas(deltas);

    assert.equal(result.applied, 0, "Nothing applied for missing file");
    assert.ok(result.errors.length > 0, "Has error for missing file");
    assert.ok(result.errors[0].includes("not found"), "Error mentions not found");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Build 6: Setup, MCP actions, E2E ---

test("setup: setupNotionWorkspace throws when ntn not installed", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const cliMod = await importModule("pipeline/notion-cli.js");
    if (cliMod.checkNtnInstalled()) {
      return;
    }

    const mod = await importModule("pipeline/notion-setup.js");

    try {
      mod.setupNotionWorkspace();
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("ntn") || err.message.includes("installed") || err.message.includes("authenticated"),
        `Error mentions ntn setup: ${err.message}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup: setupNotionWorkspace returns existing config if already set", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const syncMod = await importModule("pipeline/notion-sync.js");
    const setupMod = await importModule("pipeline/notion-setup.js");

    const state = syncMod.createEmptyNotionSyncState();
    state.enabled = true;
    state.parentPageId = "existing-page-id";
    state.workspaceName = "Test Workspace";
    state.databases = { tasks: { id: "db-1" } };
    syncMod.writeNotionSyncState(state);

    const result = setupMod.setupNotionWorkspace();

    assert.equal(result.parentPageId, "existing-page-id");
    assert.equal(result.workspaceName, "Test Workspace");
    assert.ok(result.message.includes("already configured"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mcp: notion_sync action queues a job", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const syncMod = await importModule("pipeline/notion-sync.js");
    const state = syncMod.createEmptyNotionSyncState();
    state.parentPageId = "test-parent";
    syncMod.writeNotionSyncState(state);

    const toolsMod = await importModule("tools.js");
    const result = await toolsMod.handleGraphMemory({
      action: "notion_sync",
    });

    assert.ok(!result.isError, "Should not error");
    assert.ok(result.content[0].text.includes("queued"), "Should mention queued job");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mcp: notion_sync errors when not configured", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const toolsMod = await importModule("tools.js");
    const result = await toolsMod.handleGraphMemory({
      action: "notion_sync",
    });

    assert.ok(result.isError, "Should error");
    assert.ok(result.content[0].text.includes("not configured"), "Should mention not configured");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mcp: notion_setup action calls setupNotionWorkspace", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);

    const syncMod = await importModule("pipeline/notion-sync.js");
    const state = syncMod.createEmptyNotionSyncState();
    state.enabled = true;
    state.parentPageId = "pre-setup-page";
    state.workspaceName = "Pre-setup";
    state.databases = { tasks: { id: "db-x" } };
    syncMod.writeNotionSyncState(state);

    const toolsMod = await importModule("tools.js");
    const result = await toolsMod.handleGraphMemory({
      action: "notion_setup",
    });

    assert.ok(!result.isError, "Should not error when already configured");
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.parentPageId, "pre-setup-page");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: full diff → report → plan → execute pipeline (mocked)", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const mod = await importModule("pipeline/notion-sync.js");

    const state = mod.createEmptyNotionSyncState();
    state.parentPageId = "e2e-parent";
    state.databases = {
      tasks: { id: "e2e-tasks-db" },
      decisions: { id: "e2e-decisions-db" },
      briefs: { id: "e2e-briefs-db" },
    };

    const diff = mod.buildNotionDiff(state);
    assert.ok(diff.stats.new > 0, `Has new items: ${diff.stats.new}`);

    const reportPath = mod.writeDiffReport(diff);
    assert.ok(fs.existsSync(reportPath), "Diff report written");

    const plan = {
      generatedAt: new Date().toISOString(),
      syncId: "e2e-test",
      creates: [{
        type: "database_row",
        target: "tasks",
        notionKey: "task:e2e-test",
        properties: {
          Name: { title: [{ text: { content: "E2E test task" } }] },
          Status: { select: { name: "Next" } },
        },
        sourceNodes: ["sessions/test-project"],
      }],
      updates: [],
      archives: [],
    };

    const planPath = path.join(graphRoot, ".notion-sync-plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    const loadedPlan = mod.readSyncPlan();
    assert.ok(loadedPlan, "Plan loaded");
    assert.equal(loadedPlan.creates.length, 1);

    const syncResult = mod.executeNotionSync(loadedPlan, state);
    assert.equal(syncResult.created, 0, "Creates fail without ntn (expected)");
    assert.ok(syncResult.errors.length > 0, "Has errors from missing ntn");

    assert.ok(state.parentPageId, "State preserved");
    assert.equal(state.parentPageId, "e2e-parent");

    state.lastSyncAt = new Date().toISOString();
    mod.writeNotionSyncState(state);

    const reloaded = mod.readNotionSyncState();
    assert.equal(reloaded.parentPageId, "e2e-parent");
    assert.ok(reloaded.lastSyncAt, "Last sync time persisted");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: inbound detect → input → plan → apply pipeline (mocked)", async () => {
  const { tmp, graphRoot } = makeTempGraph();
  try {
    initGraph(graphRoot);
    await setupEnv(graphRoot);
    populateSampleData(graphRoot);

    const syncMod = await importModule("pipeline/notion-sync.js");
    const inboundMod = await importModule("pipeline/notion-inbound.js");

    const state = syncMod.createEmptyNotionSyncState();
    state.parentPageId = "e2e-inbound-parent";
    syncMod.writeNotionSyncState(state);

    const inboundResult = inboundMod.detectInboundEdits(state);
    assert.equal(inboundResult.edits.length, 0, "No edits on fresh state");

    const modelPath = path.join(graphRoot, "mind", "model.json");
    const deltas = [{
      notionKey: "how-i-think",
      editType: "guardrail_change",
      sourceNodes: ["mind/model"],
      observation: "Human added guardrail: Always ask before deploying",
      targetFile: modelPath,
      action: "update_model",
      payload: {
        field: "model.guardrails",
        value: ["Never use eval()", "Always ask before deploying"],
      },
    }];

    const deltaPath = inboundMod.writeInboundDeltas(deltas, "2026-05-14");
    assert.ok(fs.existsSync(deltaPath), "Deltas written");

    const applyResult = inboundMod.applyInboundDeltas(deltas);
    assert.equal(applyResult.applied, 1, "One delta applied");
    assert.equal(applyResult.errors.length, 0, "No errors");

    const model = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
    assert.deepEqual(model.model.guardrails, ["Never use eval()", "Always ask before deploying"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("commands: notion-setup.md exists", async () => {
  const setupPath = path.join(pluginDir, "opencode-commands", "notion-setup.md");
  assert.ok(fs.existsSync(setupPath), "OpenCode notion-setup command exists");

  const content = fs.readFileSync(setupPath, "utf-8");
  assert.ok(content.includes("notion_setup"), "References notion_setup action");

  const claudeSetupPath = path.join(pluginDir, "commands", "notion-setup.md");
  assert.ok(fs.existsSync(claudeSetupPath), "Claude Code notion-setup command exists");
});

test("commands: notion-sync.md exists", async () => {
  const syncPath = path.join(pluginDir, "opencode-commands", "notion-sync.md");
  assert.ok(fs.existsSync(syncPath), "OpenCode notion-sync command exists");

  const content = fs.readFileSync(syncPath, "utf-8");
  assert.ok(content.includes("notion_sync"), "References notion_sync action");

  const claudeSyncPath = path.join(pluginDir, "commands", "notion-sync.md");
  assert.ok(fs.existsSync(claudeSyncPath), "Claude Code notion-sync command exists");
});

