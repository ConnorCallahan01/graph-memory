import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
function matter(str) {
  const match = str.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: str };
  let data = {};
  try {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^(\w[\w\s]*?):\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (val.match(/^\d+(\.\d+)?$/)) val = parseFloat(val);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val === ">" || val === ">-") continue;
      data[m[1]] = val;
    }
    if (match[1].includes("gist:")) {
      const gistBlock = match[1].match(/gist:\s*([>|-]*)\n([\s\S]*?)(?=\n\w|$)/);
      if (gistBlock) {
        data.gist = (gistBlock[2] || "").replace(/^\s+/, "").replace(/\n\s+/g, " ").trim();
      }
    }
    if (match[1].includes("tags:")) {
      const tagBlock = match[1].match(/tags:\s*\n((\s+-\s+.*\n?)+)/);
      if (tagBlock) {
        data.tags = tagBlock[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
      }
    }
    if (match[1].includes("edges:")) {
      const edgeBlock = match[1].match(/edges:\s*\n((\s+-\s+.*\n?)+)/);
      if (edgeBlock) {
        data.edges = edgeBlock[1].split("\n").filter(l => l.includes("target:")).map(l => {
          const t = l.match(/target:\s*(.+)/);
          return t ? { target: t[1].trim() } : null;
        }).filter(Boolean);
      }
    }
  } catch {}
  return { data, body: match[2] || "" };
}

const GRAPH_ROOT = process.env.GRAPH_ROOT || path.join(process.env.HOME, ".graph-memory");
const STATE_PATH = path.join(GRAPH_ROOT, ".notion-sync-state.json");
const NODES_DIR = path.join(GRAPH_ROOT, "nodes");

function ntn(...args) {
  try {
    return JSON.parse(execFileSync("ntn", args, { encoding: "utf8", timeout: 60000 }));
  } catch (e) {
    console.error("  NTN ERR:", e.stderr?.slice(0, 200) || e.message?.slice(0, 200));
    return null;
  }
}

function ntnApi(method, endpoint, data) {
  const args = ["api", endpoint];
  if (method !== "GET") args.push("-X", method);
  if (data) args.push("--data", JSON.stringify(data));
  try {
    return JSON.parse(execFileSync("ntn", args, { encoding: "utf8", timeout: 60000 }));
  } catch (e) {
    console.error("  API ERR:", e.stderr?.slice(0, 200) || e.message?.slice(0, 200));
    return null;
  }
}

function getDsId(dbId) {
  const db = ntnApi("GET", `v1/databases/${dbId}`);
  return db?.data_sources?.[0]?.id;
}

const LANG_MAP = {
  js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript",
  py: "python", rb: "ruby", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", json: "json", md: "markdown",
  sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin",
  css: "css", html: "html", xml: "xml", dockerfile: "docker",
  toml: "toml", ini: "ini", diff: "diff", plain: "plain text",
};

function markdownToBlocks(md) {
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.match(/^```(\w*)/)) {
      const lang = LANG_MAP[line.match(/^```(\w*)/)?.[1]?.toLowerCase()] || "plain text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        object: "block", type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: codeLines.join("\n").slice(0, 2000) } }],
          language: lang || "plain text",
        },
      });
      i++;
      continue;
    }

    if (line.match(/^###\s+/)) {
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] } });
    } else if (line.match(/^##\s+/)) {
      blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] } });
    } else if (line.match(/^#\s+/)) {
      blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } });
    } else if (line.match(/^\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      for (const item of items) {
        blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: [{ type: "text", text: { content: item.slice(0, 2000) } }] } });
      }
      continue;
    } else if (line.match(/^[-*]\s+\[[ x]\]\s+/i)) {
      const checked = /\[x\]/i.test(line);
      const text = line.replace(/^[-*]\s+\[[ x]\]\s+/i, "");
      blocks.push({ object: "block", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: text } }], checked } });
    } else if (line.match(/^[-*]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/) && !lines[i].match(/^[-*]\s+\[[ x]\]/i)) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      for (const item of items) {
        blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: item.slice(0, 2000) } }] } });
      }
      continue;
    } else if (line.match(/^>\s?/)) {
      const qLines = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        qLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ object: "block", type: "quote", quote: { rich_text: [{ type: "text", text: { content: qLines.join("\n").slice(0, 2000) } }] } });
      continue;
    } else if (line.match(/^---+/)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (line.trim()) {
      const content = line.slice(0, 2000);
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } });
    }
    i++;
  }
  return blocks;
}

function deleteAllBlocks(pageId) {
  // No longer needed — using markdown replace_content instead
}

function replacePageMarkdown(pageId, markdown) {
  return ntnApi("PATCH", `v1/pages/${pageId}/markdown`, {
    type: "replace_content",
    replace_content: {
      new_str: markdown,
      allow_deleting_content: true,
    },
  });
}

function mapCategory(nodePath, tags) {
  const cat = nodePath.split("/")[0];
  if (cat === "anti-patterns") return "Anti-Pattern";
  if (cat === "concepts") return "Concept";
  if (cat === "corrections") return "Correction";
  if (cat === "preferences") return "Preference";
  if (cat === "decisions") return "Decision";
  if (tags?.includes("incident")) return "Incident";
  return "Pattern";
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
let updated = 0;
let errors = 0;

const patternsDbId = state.databases.patterns?.id;
const projectsDbId = state.databases.projects?.id;
const dreamsDbId = state.databases.dreams?.id;
const decisionsDbId = state.databases.decisions?.id;

// ─── 1. Backfill Patterns & Insights ───
const SKIP_PATTERNS = process.argv.includes("--skip-patterns");
const SKIP_DREAMS = process.argv.includes("--skip-dreams");
const SKIP_DECISIONS = process.argv.includes("--skip-decisions");
console.log("\n=== Backfilling Patterns & Insights ===");
if (SKIP_PATTERNS) {
  console.log("  (skipped)");
} else if (patternsDbId) {
  for (const [rowKey, rowState] of Object.entries(state.rows)) {
    if (!rowKey.startsWith("pattern:")) continue;
    const nodePath = rowKey.replace("pattern:", "");
    const filePath = path.join(NODES_DIR, nodePath + ".md");
    if (!fs.existsSync(filePath)) {
      console.log(`  Skip ${nodePath}: file not found`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);
    const data = parsed.data || {};
    const body = parsed.body || "";
    const pageId = rowState.pageId;

    const gist = (data.gist || "").replace(/^>-\n\s*/gm, "").replace(/\n/g, " ").trim();
    const confidence = Math.round((data.confidence || 0) * 100);
    const created = (data.created || "").replace(/['"]/g, "");
    const category = mapCategory(nodePath, data.tags);

    const props = {};
    props["Name"] = { title: [{ type: "text", text: { content: (data.title || nodePath.split("/").pop()).slice(0, 100) } }] };
    props["Category"] = { select: { name: category } };
    if (gist) props["Insight"] = { rich_text: [{ type: "text", text: { content: gist.slice(0, 2000) } }] };
    if (confidence) props["Confidence"] = { number: confidence };
    if (created && created.match(/^\d{4}-\d{2}-\d{2}$/)) props["First Seen"] = { date: { start: created } };

    try {
      ntnApi("PATCH", `v1/pages/${pageId}`, { properties: props });

      const bodyMd = body.trim();
      if (bodyMd) {
        replacePageMarkdown(pageId, bodyMd);
      }

      updated++;
      if (updated % 20 === 0) console.log(`  ${updated} patterns updated...`);
    } catch (err) {
      console.log(`  ERR ${nodePath}: ${err.message?.slice(0, 100)}`);
      errors++;
    }
  }
  console.log(`Patterns: ${updated} updated, ${errors} errors`);
}

// ─── 2. Backfill Projects ───
console.log("\n=== Backfilling Projects ===");
let projUpdated = 0;
let projErrors = 0;
const lensesDir = path.join(GRAPH_ROOT, "lenses");

if (projectsDbId && fs.existsSync(lensesDir)) {
  for (const [rowKey, rowState] of Object.entries(state.rows)) {
    if (rowState.sourceField !== "projects") continue;
    const projectName = rowKey.replace(/^project:*/, "");
    const pageId = rowState.pageId;

    const lensDir = path.join(lensesDir, projectName);
    const modelPath = path.join(lensDir, "model.json");
    let description = "";
    let techStack = "";
    let lastActive = "";

    if (fs.existsSync(modelPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
        const m = raw.model || raw;
        description = m.summary || m.description || (m.conventions || []).slice(0, 3).join("; ");
        techStack = (m.techStack || m.tech_stack || []).join(", ");
        lastActive = m.lastActive || m.updatedAt || m.generatedAt || "";
      } catch {}
    }

    const props = {};
    if (description) props["Description"] = { rich_text: [{ type: "text", text: { content: description.slice(0, 2000) } }] };
    if (techStack) props["Tech Stack"] = { rich_text: [{ type: "text", text: { content: techStack.slice(0, 2000) } }] };
    if (lastActive && lastActive.match(/^\d{4}-\d{2}/)) props["Last Active"] = { date: { start: lastActive.slice(0, 10) } };

    if (Object.keys(props).length > 0) {
      try {
        ntnApi("PATCH", `v1/pages/${pageId}`, { properties: props });

        if (description) {
          replacePageMarkdown(pageId, `## Summary\n\n${description}`);
        }

        projUpdated++;
        console.log(`  Updated: ${projectName}`);
      } catch (err) {
        console.log(`  ERR ${projectName}: ${err.message?.slice(0, 100)}`);
        projErrors++;
      }
    }
  }
  console.log(`Projects: ${projUpdated} updated, ${projErrors} errors`);
}

// ─── 3. Backfill Dreams ───
console.log("\n=== Backfilling Dreams ===");
let dreamUpdated = 0;
let dreamErrors = 0;
const dreamsDir = path.join(GRAPH_ROOT, "dreams");

if (SKIP_DREAMS) {
  console.log("  (skipped)");
} else if (dreamsDbId && fs.existsSync(dreamsDir)) {
  const allDreamFiles = {};
  for (const subDir of ["integrated", "pending", "archived"]) {
    const sub = path.join(dreamsDir, subDir);
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith(".json")) continue;
      allDreamFiles[f] = path.join(sub, f);
    }
  }

  const db = ntnApi("GET", `v1/databases/${dreamsDbId}`);
  const dsId = db?.data_sources?.[0]?.id;
  if (!dsId) { console.log("  No data source for dreams DB"); }
  else {
    let cursor;
    const allRows = [];
    while (true) {
      const url = `v1/data_sources/${dsId}/query`;
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const result = ntnApi("POST", url, body);
      if (!result?.results) break;
      allRows.push(...result.results);
      if (!result.has_more) break;
      cursor = result.next_cursor;
    }

    for (const row of allRows) {
      const rowName = row.properties?.Name?.title?.[0]?.plain_text || "";
      const pageId = row.id;

      const dreamFile = allDreamFiles[rowName + ".json"];
      if (!dreamFile) { continue; }

      let dreamData = {};
      try { dreamData = JSON.parse(fs.readFileSync(dreamFile, "utf-8")); }
      catch { continue; }

      const status = dreamData.status || (dreamFile.includes("/integrated/") ? "Integrated" : dreamFile.includes("/pending/") ? "Pending" : "Archived");
      const confidence = Math.round((dreamData.confidence || 0) * 100);
      const prediction = dreamData.prediction || dreamData.gist || dreamData.fragment?.slice(0, 200) || "";
      const sourceNodes = (dreamData.nodes_referenced || dreamData.source_nodes || dreamData.edges || []).map(e => typeof e === "string" ? e : e.target || "").filter(Boolean).join(", ");
      const createdRaw = (dreamData.created || dreamData.generatedAt || "").toString().replace(/['"]/g, "");
      const created = createdRaw.slice(0, 10);

      const title = dreamData.title || dreamData.name || rowName.replace(/\.json$/, "");
      const props = {};
      props["Name"] = { title: [{ type: "text", text: { content: title.slice(0, 100) } }] };
      props["Status"] = { select: { name: status } };
      if (confidence) props["Confidence"] = { number: confidence };
      if (prediction) props["Prediction"] = { rich_text: [{ type: "text", text: { content: prediction.slice(0, 2000) } }] };
      if (sourceNodes) props["Source Nodes"] = { rich_text: [{ type: "text", text: { content: sourceNodes.slice(0, 2000) } }] };
      if (created && created.match(/^\d{4}-\d{2}-\d{2}$/)) props["Created"] = { date: { start: created } };

      try {
        ntnApi("PATCH", `v1/pages/${pageId}`, { properties: props });

        const bodyText = dreamData.content || dreamData.body || dreamData.analysis || dreamData.fragment || "";
        if (bodyText) {
          replacePageMarkdown(pageId, bodyText);
        }

        dreamUpdated++;
        state.rows[`dream:${rowName}`] = { pageId, sourceField: "dreams", status, lastSyncedHash: "" };
      } catch (err) {
        console.log(`  ERR ${rowName}: ${err.message?.slice(0, 100)}`);
        dreamErrors++;
      }
    }
  }
  console.log(`Dreams: ${dreamUpdated} updated, ${dreamErrors} errors`);
}

// ─── 4. Backfill Decisions (properties) ───
console.log("\n=== Backfilling Decisions ===");
let decUpdated = 0;
let decErrors = 0;

if (SKIP_DECISIONS) {
  console.log("  (skipped)");
} else if (decisionsDbId) {
  for (const [rowKey, rowState] of Object.entries(state.rows)) {
    if (rowState.sourceField !== "decisions") continue;
    const nodePath = rowKey;
    const filePath = path.join(NODES_DIR, nodePath + ".md");
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);
    const data = parsed.data || {};
    const body = parsed.body || "";
    const pageId = rowState.pageId;

    const context = body.trim().slice(0, 2000);
    const date = (data.created || data.updated || "").replace(/['"]/g, "").slice(0, 10);
    const project = data.project || "";

    const props = {};
    if (context) props["Context"] = { rich_text: [{ type: "text", text: { content: context } }] };
    if (date && date.match(/^\d{4}-\d{2}-\d{2}$/)) props["Date"] = { date: { start: date } };
    // Project is a relation now — skip it in backfill (will be populated by future syncs)

    if (Object.keys(props).length === 0) continue;

    try {
      ntnApi("PATCH", `v1/pages/${pageId}`, { properties: props });

      if (body.trim()) {
        replacePageMarkdown(pageId, body.trim());
      }

      decUpdated++;
    } catch (err) {
      console.log(`  ERR ${nodePath}: ${err.message?.slice(0, 100)}`);
      decErrors++;
    }
  }
  console.log(`Decisions: ${decUpdated} updated, ${decErrors} errors`);
}

console.log("\n=== Backfill complete ===");
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log("Sync state saved.");
