import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const GRAPH_ROOT = process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME, ".graph-memory");

function ntn(args, opts = {}) {
  return execFileSync("ntn", args, { encoding: "utf-8", timeout: 120_000, ...opts });
}

function ntnApi(method, endpoint, body = {}) {
  const raw = ntn(["api", endpoint, "-X", method, "--data", JSON.stringify(body)], { timeout: 120_000 });
  try { return JSON.parse(raw); } catch { return null; }
}

function getDataSourceId(dbId) {
  const raw = ntn(["api", `v1/databases/${dbId}`]);
  try { return JSON.parse(raw)?.data_sources?.[0]?.id || ""; } catch { return ""; }
}

function archivePage(pageId) {
  try { ntn(["api", `v1/pages/${pageId}`, "-X", "PATCH", "in_trash:=true"]); return true; } catch { return false; }
}

const state = JSON.parse(fs.readFileSync(path.join(GRAPH_ROOT, ".notion-sync-state.json"), "utf-8"));
const parentPageId = state.parentPageId;

console.log("=== Notion Workspace Migration ===\n");
console.log(`Parent page: ${parentPageId}`);

// ─── 1. Create Projects Database ───
console.log("\n--- Creating Projects Database ---");
let projectsDbId = state.databases.projects?.id;
let projectsDsId = "";

if (projectsDbId) {
  console.log(`Projects DB already exists: ${projectsDbId}`);
  projectsDsId = getDataSourceId(projectsDbId);
} else {
  const projectsDb = ntnApi("POST", "v1/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Projects" } }],
  });

  if (!projectsDb?.id) {
    console.error("Failed to create Projects database");
    process.exit(1);
  }

  projectsDbId = projectsDb.id;
  projectsDsId = projectsDb.data_sources?.[0]?.id || "";
  console.log(`Projects DB: ${projectsDbId}, DS: ${projectsDsId}`);
  state.databases.projects = { id: projectsDbId };
}

if (projectsDsId && !state.databases.projects?._schemaDone) {
  ntnApi("PATCH", `v1/data_sources/${projectsDsId}`, {
    properties: {
      "Name": { title: {} },
      "Status": { select: { options: [
        { name: "Active", color: "green" },
        { name: "Paused", color: "yellow" },
        { name: "Complete", color: "gray" },
      ] } },
      "Stack": { rich_text: {} },
      "Overview": { rich_text: {} },
      "Active Work": { rich_text: {} },
      "Open Threads": { rich_text: {} },
      "Conventions": { rich_text: {} },
      "Key Decisions": { rich_text: {} },
      "Last Updated": { date: {} },
    },
  });
  console.log("  Schema configured");
  state.databases.projects._schemaDone = true;
}

// Populate Projects from lenses
const lensesDir = path.join(GRAPH_ROOT, "lenses");
if (fs.existsSync(lensesDir)) {
  const projects = [
    { slug: "ConnorCallahan01__cogni-code", name: "Cogni-Code (Graph Memory)", status: "Active" },
    { slug: "Keel3__keel3_oliver_demo", name: "Keel3 Oliver Demo", status: "Active" },
    { slug: "acellushealth__openpatient", name: "OpenPatient (ACE Engine)", status: "Active" },
    { slug: "brandywine-buzz", name: "Brandywine Buzz", status: "Active" },
    { slug: "acellushealth__ace-engine-api", name: "ACE Engine API", status: "Paused" },
    { slug: "acellushealth__dvc", name: "DVC (Adjudication)", status: "Paused" },
  ];

  for (const proj of projects) {
    const modelPath = path.join(lensesDir, proj.slug, "model.json");
    let model = {};
    if (fs.existsSync(modelPath)) {
      try { model = JSON.parse(fs.readFileSync(modelPath, "utf-8")); } catch {}
    }

    const stack = (model.techStack || []).join(", ");
    const overview = model.projectOverview || model.description || "";
    const activeWork = (model.activeWork || []).join("\n");
    const openThreads = (model.openThreads || []).join("\n");
    const conventions = (model.conventions || []).join("\n");

    const props = {
      "Name": { title: [{ type: "text", text: { content: proj.name } }] },
      "Status": { select: { name: proj.status } },
    };
    if (stack) props["Stack"] = { rich_text: [{ type: "text", text: { content: stack.slice(0, 2000) } }] };
    if (overview) props["Overview"] = { rich_text: [{ type: "text", text: { content: overview.slice(0, 2000) } }] };
    if (activeWork) props["Active Work"] = { rich_text: [{ type: "text", text: { content: activeWork.slice(0, 2000) } }] };
    if (openThreads) props["Open Threads"] = { rich_text: [{ type: "text", text: { content: openThreads.slice(0, 2000) } }] };
    if (conventions) props["Conventions"] = { rich_text: [{ type: "text", text: { content: conventions.slice(0, 2000) } }] };

    const row = ntnApi("POST", "v1/pages", {
      parent: { type: "database_id", database_id: projectsDbId },
      properties: props,
    });

    if (row?.id) {
      const rowKey = `project:${proj.slug}`;
      state.rows[rowKey] = { pageId: row.id, sourceField: "projects", status: proj.status, lastSyncedHash: "" };
      console.log(`  Created: ${proj.name} (${proj.status})`);
    } else {
      console.log(`  Failed: ${proj.name}`);
    }
  }
}

// ─── 2. Create Patterns & Insights Database ───
console.log("\n--- Creating Patterns & Insights Database ---");
let patternsDbId = state.databases.patterns?.id;
let patternsDsId = "";

if (patternsDbId) {
  console.log(`Patterns DB already exists: ${patternsDbId}`);
  patternsDsId = getDataSourceId(patternsDbId);
} else {
  const patternsDb = ntnApi("POST", "v1/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Patterns & Insights" } }],
  });

  if (!patternsDb?.id) {
    console.error("Failed to create Patterns database");
  } else {
    patternsDbId = patternsDb.id;
    patternsDsId = patternsDb.data_sources?.[0]?.id || "";
    console.log(`Patterns DB: ${patternsDbId}, DS: ${patternsDsId}`);
    state.databases.patterns = { id: patternsDbId };
  }
}

if (patternsDbId && patternsDsId && !state.databases.patterns?._schemaDone) {

  if (patternsDsId) {
    ntnApi("PATCH", `v1/data_sources/${patternsDsId}`, {
      properties: {
        "Name": { title: {} },
        "Category": { select: { options: [
          { name: "Pattern", color: "blue" },
          { name: "Anti-Pattern", color: "red" },
          { name: "Concept", color: "purple" },
          { name: "Correction", color: "orange" },
          { name: "Incident", color: "yellow" },
        ] } },
        "Insight": { rich_text: {} },
        "Project": { select: { options: [] } },
        "Confidence": { number: { format: "percent" } },
        "Tags": { rich_text: {} },
        "First Seen": { date: {} },
      },
    });
    console.log("  Schema configured");
    state.databases.patterns._schemaDone = true;
  }
  state.databases.patterns = state.databases.patterns || { id: patternsDbId };

  // Populate from nodes
  const nodesDir = path.join(GRAPH_ROOT, "nodes");
  const categories = [
    { dir: "patterns", category: "Pattern" },
    { dir: "anti-patterns", category: "Anti-Pattern" },
    { dir: "concepts", category: "Concept" },
    { dir: "corrections", category: "Correction" },
    { dir: "incidents", category: "Incident" },
  ];

  let patternsCreated = 0;
  for (const cat of categories) {
    const catDir = path.join(nodesDir, cat.dir);
    if (!fs.existsSync(catDir)) continue;

    for (const file of fs.readdirSync(catDir).filter(f => f.endsWith(".md")).sort()) {
      const raw = fs.readFileSync(path.join(catDir, file), "utf-8");
      let data = {};
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
      let content = raw;
      if (fmMatch) {
        content = raw.slice(fmMatch[0].length);
        for (const line of fmMatch[1].split("\n")) {
          const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
          if (m) data[m[1]] = m[2];
        }
      }

      if (data.archived === "true") continue;

      const title = data.title || file.replace(".md", "").replace(/-/g, " ");
      const gist = (data.gist || "").replace(/^"|"$/g, "");
      const confidence = data.confidence ? parseFloat(data.confidence) : null;
      const tags = (data.tags || "").replace(/[\[\]"]/g, "");
      const project = data.project || "";
      const created = (data.created || "").replace(/['"]/g, "");

      const props = {
        "Name": { title: [{ type: "text", text: { content: title.slice(0, 100) } }] },
        "Category": { select: { name: cat.category } },
      };
      if (gist) props["Insight"] = { rich_text: [{ type: "text", text: { content: gist.slice(0, 2000) } }] };
      if (project) props["Project"] = { select: { name: project } };
      if (confidence && !isNaN(confidence)) props["Confidence"] = { number: Math.round(confidence * 100) };
      if (tags) props["Tags"] = { rich_text: [{ type: "text", text: { content: tags.slice(0, 2000) } }] };
      if (created) props["First Seen"] = { date: { start: created } };

      const bodyContent = content.trim().slice(0, 2000);

      try {
        const row = ntnApi("POST", "v1/pages", {
          parent: { type: "database_id", database_id: patternsDbId },
        properties: props,
        ...(bodyContent ? { children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: bodyContent } }] } }] } : {}),
      });

      if (row?.id) {
        const nodePath = path.join(cat.dir, file.replace(".md", ""));
        state.rows[`pattern:${nodePath}`] = { pageId: row.id, sourceField: "patterns", status: cat.category, lastSyncedHash: "" };
        patternsCreated++;
      }
      } catch (err) {
        console.log(`  Skip: ${file.slice(0, 40)} — ${err.message?.slice(0, 80)}`);
      }
    }
  }
  console.log(`  Created: ${patternsCreated} pattern/concept rows`);
}

// ─── 3. Create Dreams & Experiments Database ───
console.log("\n--- Creating Dreams & Experiments Database ---");
let dreamsDbId = state.databases.dreams?.id;
let dreamsDsId = "";

if (dreamsDbId) {
  console.log(`Dreams DB already exists: ${dreamsDbId}`);
  dreamsDsId = getDataSourceId(dreamsDbId);
} else {
  const dreamsDb = ntnApi("POST", "v1/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Dreams & Experiments" } }],
  });

  if (!dreamsDb?.id) {
    console.error("Failed to create Dreams database");
  } else {
    dreamsDbId = dreamsDb.id;
    dreamsDsId = dreamsDb.data_sources?.[0]?.id || "";
    console.log(`Dreams DB: ${dreamsDbId}, DS: ${dreamsDsId}`);
    state.databases.dreams = { id: dreamsDbId };
  }
}

if (dreamsDbId && dreamsDsId && !state.databases.dreams?._schemaDone) {

  if (dreamsDsId) {
    ntnApi("PATCH", `v1/data_sources/${dreamsDsId}`, {
      properties: {
        "Name": { title: {} },
        "Status": { select: { options: [
          { name: "Pending", color: "yellow" },
          { name: "Integrated", color: "green" },
          { name: "Archived", color: "gray" },
        ] } },
        "Confidence": { number: { format: "percent" } },
        "Prediction": { rich_text: {} },
        "Source Nodes": { rich_text: {} },
        "Created": { date: {} },
      },
    });
    console.log("  Schema configured");
    state.databases.dreams._schemaDone = true;
  }
  state.databases.dreams = state.databases.dreams || { id: dreamsDbId };

  // Populate from dreams directory
  const dreamsDir = path.join(GRAPH_ROOT, "dreams");
  let dreamsCreated = 0;

  for (const subDir of ["pending", "integrated"]) {
    const subPath = path.join(dreamsDir, subDir);
    if (!fs.existsSync(subPath)) continue;

    for (const file of fs.readdirSync(subPath).filter(f => f.endsWith(".json")).sort()) {
      let dream;
      try { dream = JSON.parse(fs.readFileSync(path.join(subPath, file), "utf-8")); } catch { continue; }

      const title = dream.title || dream.id || file.replace(".json", "");
      const confidence = dream.confidence ? Math.round(dream.confidence * 100) : null;
      const prediction = (dream.prediction || dream.gist || "").slice(0, 2000);
      const sourceNodes = (dream.edges || []).map(e => e.target).join(", ").slice(0, 2000);

      const props = {
        "Name": { title: [{ type: "text", text: { content: title.slice(0, 100) } }] },
        "Status": { select: { name: subDir === "pending" ? "Pending" : "Integrated" } },
      };
      if (confidence && !isNaN(confidence)) props["Confidence"] = { number: confidence };
      if (prediction) props["Prediction"] = { rich_text: [{ type: "text", text: { content: prediction } }] };
      if (sourceNodes) props["Source Nodes"] = { rich_text: [{ type: "text", text: { content: sourceNodes } }] };

      try {
      const row = ntnApi("POST", "v1/pages", {
        parent: { type: "database_id", database_id: dreamsDbId },
        properties: props,
      });

      if (row?.id) {
        dreamsCreated++;
      }
      } catch (err) {
        console.log(`  Skip dream: ${file.slice(0, 40)} — ${err.message?.slice(0, 80)}`);
      }
    }
  }
  console.log(`  Created: ${dreamsCreated} dream rows`);
}

// ─── 4. Archive old wiki pages ───
console.log("\n--- Archiving old wiki pages ---");
for (const key of ["projects", "patterns-insights", "dreams-experiments"]) {
  const ps = state.pages[key];
  if (ps?.pageId) {
    if (archivePage(ps.pageId)) {
      console.log(`  Archived: ${key}`);
      delete state.pages[key];
    }
  }
}

// ─── 5. Save state ───
const statePath = path.join(GRAPH_ROOT, ".notion-sync-state.json");
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log("\n=== Migration complete ===");
console.log(`New databases: projects, patterns, dreams`);
console.log(`State saved.`);
