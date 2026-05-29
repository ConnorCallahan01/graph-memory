import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const GRAPH_ROOT = process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME, ".graph-memory");

function ntn(args) {
  return execFileSync("ntn", args, { encoding: "utf-8", timeout: 60_000 });
}

function getDataSourceId(databaseId) {
  const raw = ntn(["api", `v1/databases/${databaseId}`]);
  const parsed = JSON.parse(raw);
  return parsed?.data_sources?.[0]?.id || "";
}

function queryDatabase(databaseId) {
  const dsId = getDataSourceId(databaseId);
  const endpoint = dsId
    ? `v1/data_sources/${dsId}/query`
    : `v1/databases/${databaseId}/query`;
  const raw = ntn(["api", endpoint, "--data", "{}"]);
  try { return JSON.parse(raw)?.results || []; } catch { return []; }
}

function archivePage(pageId) {
  try {
    ntn(["api", `v1/pages/${pageId}`, "-X", "PATCH", "in_trash:=true"]);
    return true;
  } catch (err) {
    console.error(`  Failed to archive ${pageId}: ${err.message}`);
    return false;
  }
}

function loadState() {
  const p = path.join(GRAPH_ROOT, ".notion-sync-state.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function saveState(state) {
  const p = path.join(GRAPH_ROOT, ".notion-sync-state.json");
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
}

function cleanupDecisions(state) {
  const dbId = state.databases.decisions?.id;
  if (!dbId) { console.log("No decisions database"); return []; }

  const rows = queryDatabase(dbId);
  console.log(`\n=== DECISIONS: ${rows.length} rows ===`);

  const seen = new Map();
  const toArchive = [];

  for (const row of rows) {
    const props = row.properties || {};
    const title = props.Decision?.title?.map(t => t.plain_text).join("") || "";
    const key = normalize(title);

    if (!key) { toArchive.push({ id: row.id, title: "(empty)" }); continue; }

    if (seen.has(key)) {
      const existing = seen.get(key);
      const existingDate = existing.created_time || "";
      const thisDate = row.created_time || "";
      if (thisDate > existingDate) {
        toArchive.push({ id: existing.id, title: existing.title });
        seen.set(key, { id: row.id, title, created_time: thisDate });
      } else {
        toArchive.push({ id: row.id, title });
      }
    } else {
      seen.set(key, { id: row.id, title, created_time: row.created_time });
    }
  }

  console.log(`  Unique: ${seen.size}, Duplicates to archive: ${toArchive.length}`);
  for (const item of toArchive) {
    console.log(`  Archiving: "${item.title}"`);
    if (archivePage(item.id)) {
      for (const [rowKey, rowState] of Object.entries(state.rows)) {
        if (rowState.pageId === item.id) delete state.rows[rowKey];
      }
    }
  }

  return toArchive;
}

function cleanupTasks(state) {
  const dbId = state.databases.tasks?.id;
  if (!dbId) { console.log("No tasks database"); return []; }

  const rows = queryDatabase(dbId);
  console.log(`\n=== TASKS: ${rows.length} rows ===`);

  const seen = new Map();
  const toArchive = [];

  const stalePatterns = ["test", "new task", "test new page", "test creation"];

  for (const row of rows) {
    const props = row.properties || {};
    const title = props.Name?.title?.map(t => t.plain_text).join("") || "";
    const status = props.Status?.status?.name || props.Status?.select?.name || "";
    const key = normalize(title);

    if (!key || stalePatterns.some(p => title.toLowerCase().includes(p))) {
      toArchive.push({ id: row.id, title: title || "(empty)", reason: "stale/empty" });
      continue;
    }

    if (status === "Done") {
      toArchive.push({ id: row.id, title, reason: "completed" });
      continue;
    }

    if (seen.has(key)) {
      toArchive.push({ id: row.id, title, reason: "duplicate" });
    } else {
      seen.set(key, { id: row.id, title });
    }
  }

  console.log(`  Unique active: ${seen.size}, To archive: ${toArchive.length}`);
  for (const item of toArchive) {
    console.log(`  Archiving: "${item.title}" (${item.reason})`);
    if (archivePage(item.id)) {
      for (const [rowKey, rowState] of Object.entries(state.rows)) {
        if (rowState.pageId === item.id) delete state.rows[rowKey];
      }
    }
  }

  return toArchive;
}

function cleanupBriefs(state) {
  const dbId = state.databases.briefs?.id;
  if (!dbId) { console.log("No briefs database"); return []; }

  const rows = queryDatabase(dbId);
  console.log(`\n=== BRIEFS: ${rows.length} rows ===`);

  const seen = new Map();
  const toArchive = [];

  for (const row of rows) {
    const props = row.properties || {};
    const date = props.Date?.title?.map(t => t.plain_text).join("") || "";
    const dateKey = date.replace(/[^0-9-]/g, "").slice(0, 10);

    if (!dateKey) { toArchive.push({ id: row.id, title: "(empty)", reason: "empty" }); continue; }

    if (seen.has(dateKey)) {
      const existing = seen.get(dateKey);
      const existingIsInput = existing.title.includes(".input");
      const thisIsInput = date.includes(".input");
      if (thisIsInput && !existingIsInput) {
        toArchive.push({ id: row.id, title: date, reason: "input duplicate" });
      } else {
        toArchive.push({ id: existing.id, title: existing.title, reason: "duplicate" });
        seen.set(dateKey, { id: row.id, title: date });
      }
    } else {
      seen.set(dateKey, { id: row.id, title: date });
    }
  }

  console.log(`  Unique dates: ${seen.size}, Duplicates to archive: ${toArchive.length}`);
  for (const item of toArchive) {
    console.log(`  Archiving: "${item.title}" (${item.reason})`);
    if (archivePage(item.id)) {
      for (const [rowKey, rowState] of Object.entries(state.rows)) {
        if (rowState.pageId === item.id) delete state.rows[rowKey];
      }
    }
  }

  return toArchive;
}

function cleanupPages(state) {
  console.log(`\n=== PAGES: ${Object.keys(state.pages).length} tracked ===`);

  const stubProjects = [];
  const realProjects = [];

  for (const [key, ps] of Object.entries(state.pages)) {
    if (!key.startsWith("project:") || key.includes("__")) continue;

    const name = key.replace("project:", "");
    if (ps.sourceNodes.length === 0 && !ps.lastSyncedHash.startsWith("sha256:new")) {
      stubProjects.push({ key, pageId: ps.pageId });
    }
  }

  const duplicateProjectPages = [
    "project:ace-engine-extract-curation",
    "project:acellushealth-dvc",
    "project:agent-memory-v3-audit",
    "project:keel3-oliver-demo-chat-ui-polish",
    "project:oliver",
    "project:brandywine-buzz",
  ];

  console.log(`  Stub/duplicate project pages to archive: ${duplicateProjectPages.length}`);
  for (const key of duplicateProjectPages) {
    const ps = state.pages[key];
    if (!ps) { console.log(`  Skip ${key}: not in state`); continue; }
    console.log(`  Archiving page: ${key}`);
    if (archivePage(ps.pageId)) {
      delete state.pages[key];
    }
  }

  const wikiGroupFragments = [
    "wiki-group:dreams-experiments/meta:0",
    "wiki-group:dreams-experiments/working",
    "wiki-group:how-i-think/anti-patterns",
    "wiki-group:how-i-think/preferences",
    "wiki-group:patterns-insights/architecture",
    "wiki-group:patterns-insights/concepts",
    "wiki-group:patterns-insights/corrections",
    "wiki-group:patterns-insights/facts",
    "wiki-group:patterns-insights/incidents",
    "wiki-group:patterns-insights/infrastructure",
    "wiki-group:patterns-insights/people",
    "wiki-group:patterns-insights/tools",
    "wiki-group:project:brandywine-buzz",
    "wiki-group:archive/.archive",
    "wiki-group:archive/archive",
    "wiki-group:patterns-insights/patterns",
  ];

  console.log(`\n  Wiki-group fragment pages to archive: ${wikiGroupFragments.length}`);
  for (const key of wikiGroupFragments) {
    const ps = state.pages[key];
    if (!ps) { console.log(`  Skip ${key}: not in state`); continue; }
    console.log(`  Archiving: ${key}`);
    if (archivePage(ps.pageId)) {
      delete state.pages[key];
    }
  }
}

console.log("Notion Workspace Cleanup");
console.log("========================");

const state = loadState();
let totalArchived = 0;

totalArchived += cleanupDecisions(state);
totalArchived += cleanupTasks(state);
totalArchived += cleanupBriefs(state);
cleanupPages(state);

saveState(state);
console.log(`\n=== DONE ===`);
console.log(`State saved. ${totalArchived.length} database rows archived.`);
console.log("Run a notion_sync to re-baseline hashes.");
