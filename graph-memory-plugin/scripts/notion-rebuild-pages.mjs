import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const GRAPH_ROOT = process.env.GRAPH_MEMORY_ROOT || path.join(process.env.HOME, ".graph-memory");

function ntn(args, opts = {}) {
  return execFileSync("ntn", args, { encoding: "utf-8", timeout: 120_000, ...opts });
}

function getPageId(key) {
  const state = JSON.parse(fs.readFileSync(path.join(GRAPH_ROOT, ".notion-sync-state.json"), "utf-8"));
  return state.pages[key]?.pageId;
}

function archiveChildPages(pageId) {
  try {
    const raw = ntn(["api", `v1/blocks/${pageId}/children`, "-X", "GET"], { timeout: 60_000 });
    const parsed = JSON.parse(raw);
    const children = parsed?.results || [];
    for (const child of children) {
      if (child.type === "child_page" || child.type === "child_database") {
        try {
          ntn(["api", `v1/pages/${child.id}`, "-X", "PATCH", "in_trash:=true"]);
          console.log(`  Archived child: ${child.child_page?.title || child.child_database?.title || child.id}`);
        } catch {}
      }
    }
  } catch {}
}

function updatePage(pageId, markdown) {
  ntn(["pages", "update", pageId], { input: markdown, timeout: 120_000 });
}

function readNode(nodePath) {
  const fullPath = path.join(GRAPH_ROOT, "nodes", nodePath + ".md");
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf-8");
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  let data = {};
  let content = raw;
  if (frontmatterMatch) {
    content = raw.slice(frontmatterMatch[0].length);
    for (const line of frontmatterMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
      if (m) data[m[1]] = m[2];
    }
  }
  return { data, content: content.trim() };
}

function buildHowIThink() {
  const model = JSON.parse(fs.readFileSync(path.join(GRAPH_ROOT, "mind", "model.json"), "utf-8"));
  const m = model.model || {};

  let md = `# How I Think\n\n`;

  md += `## Cognitive Style\n\n`;
  md += (m.cognitiveStyle || "").trim() + "\n\n";

  md += `## Decision Patterns\n\n`;
  const decisions = [
    "**Vertical-slice delivery**: one end-to-end path with full stack depth over comprehensive but shallow work",
    "**Front-loads implementation, skips validation phases** — theoretical bugs don't block forward momentum",
    "**Spec as commitment device** — once scope is agreed, the spec prevents design re-litigation mid-execution",
    "**Accepts pragmatic 'good enough'** including known regressions in legacy surfaces when the new path works",
    "**Root-cause over cosmetic** — race conditions bypass cost-benefit and go straight to structural prevention",
    "**Full revert over accumulating patches** — replace the mechanism when tuning doesn't converge",
    "**Wire evidence over commit claims** — verify against runtime reality, not docs or agent summaries",
    "**Calm-factual debugging** — name what you see before theorizing; fix-then-live-verify is non-negotiable",
    "**Entropy management as workflow phase** — proactive pruning, not deferred backlog",
    "**Invests in instruction-surface quality** — specs and CLAUDE.md are primary delegation enablers",
  ];
  for (const d of decisions) md += `- ${d}\n`;
  md += "\n";

  md += `## Guardrails\n\n`;
  for (const g of (m.guardrails || [])) {
    md += `> ${g.trim()}\n\n`;
  }

  md += `## Preferences\n\n`;
  const prefs = [
    "**Push timing**: Commit approval is not push approval. Any remote push waits for a fresh explicit instruction at the moment of promotion.",
    "**Stepwise live validation**: Give the next action only, wait for screenshot/observation, diagnose before advancing.",
    "**Checklist visibility**: Task plans written to file, checked off as completed. In-file checklists for ambient progress tracking.",
    "**Import diligence before deletion**: Build import map before deleting any file — frontend breakage from deletion is non-negotiable.",
    "**Number-led stat callouts**: Big bold number first, one-line caption, workflow tag. Not descriptive cards.",
    "**Demo scripts**: Two-file workflow — .md master (shooting plan) + .txt teleprompter companion (speakable lines).",
    "**No day framing in handoffs**: Session handoffs describe work state, not calendar structure.",
    "**Protect production while testing**: Feature work deploys to dedicated branch env first. Never touch discovery during active development.",
    "**Code has no comments**: Never add comments unless explicitly asked. Corrected across multiple sessions.",
  ];
  for (const p of prefs) md += `- ${p}\n`;
  md += "\n";

  md += `## Emotional Profile\n\n`;
  md += (m.emotionalProfile || "Values speed and autonomy but demands precision on high-stakes output. Frustrated when agents don't recall known procedures or need hand-holding for tasks they should already know. Trusts agents with broad scope once alignment is confirmed. Will redirect focus mid-session when something unexpected surfaces — follow the redirect immediately.").trim() + "\n";

  return md;
}

function buildPatternsInsights() {
  const nodesDir = path.join(GRAPH_ROOT, "nodes");
  const patterns = [];
  const antiPatterns = [];
  const concepts = [];

  for (const category of ["patterns", "anti-patterns", "concepts"]) {
    const dir = path.join(nodesDir, category);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
      const node = readNode(path.join(category, file.replace(".md", "")));
      if (!node || node.data.archived === "true") continue;
      const title = node.data.title || file.replace(".md", "").replace(/-/g, " ");
      const gist = node.data.gist || "";
      const entry = { title, gist: gist.replace(/^"|"$/g, ""), category };
      if (category === "patterns") patterns.push(entry);
      else if (category === "anti-patterns") antiPatterns.push(entry);
      else concepts.push(entry);
    }
  }

  let md = `# Patterns & Insights\n\n`;

  if (patterns.length > 0) {
    md += `## Patterns\n\n`;
    for (const p of patterns) {
      md += `### ${p.title}\n\n${p.gist}\n\n`;
    }
  }

  if (antiPatterns.length > 0) {
    md += `## Anti-Patterns\n\n`;
    for (const a of antiPatterns) {
      md += `### ${a.title}\n\n${a.gist}\n\n`;
    }
  }

  if (concepts.length > 0) {
    md += `## Concepts\n\n`;
    for (const c of concepts) {
      md += `### ${c.title}\n\n${c.gist}\n\n`;
    }
  }

  return md;
}

function buildProjects() {
  const lensesDir = path.join(GRAPH_ROOT, "lenses");
  if (!fs.existsSync(lensesDir)) return "# Projects\n";

  let md = `# Projects\n\n`;

  for (const entry of fs.readdirSync(lensesDir, { withFileTypes: true }).sort()) {
    if (!entry.isDirectory() || entry.name === "_archived") continue;
    const modelPath = path.join(lensesDir, entry.name, "model.json");
    if (!fs.existsSync(modelPath)) continue;

    const model = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
    const name = model.projectName || entry.name.replace(/__/g, "/").replace(/-/g, " ");
    const stack = model.techStack || [];
    const active = model.activeWork || [];
    const threads = model.openThreads || [];
    const conventions = model.conventions || [];

    md += `## ${name}\n\n`;
    if (stack.length > 0) md += `**Stack**: ${stack.join(", ")}\n\n`;
    if (conventions.length > 0) md += `**Conventions**: ${conventions.slice(0, 5).join("; ")}\n\n`;
    if (active.length > 0) {
      md += `**Active work**:\n`;
      for (const a of active.slice(0, 5)) md += `- ${a}\n`;
      md += "\n";
    }
    if (threads.length > 0) {
      md += `**Open threads**:\n`;
      for (const t of threads.slice(0, 5)) md += `- ${t}\n`;
      md += "\n";
    }
  }

  return md;
}

function buildDreams() {
  const dreamsDir = path.join(GRAPH_ROOT, "dreams");
  let pending = 0;
  let integrated = 0;

  for (const sub of ["pending", "integrated"]) {
    const subPath = path.join(dreamsDir, sub);
    if (fs.existsSync(subPath)) {
      const count = fs.readdirSync(subPath).filter(f => f.endsWith(".json")).length;
      if (sub === "pending") pending = count;
      else integrated = count;
    }
  }

  return `# Dreams & Experiments

## Pending Dreams

${pending} dream fragments awaiting integration.

## Integrated Dreams

${integrated} dream fragments have been integrated into the graph. Dreams are generated by the dreamer pipeline stage and integrated by the librarian during consolidation passes.

---

*Built from: dreams/pending, dreams/integrated*
`;
}

console.log("Rebuilding Notion pages from source data...\n");

const pages = [
  { key: "how-i-think", builder: buildHowIThink, name: "How I Think" },
  { key: "patterns-insights", builder: buildPatternsInsights, name: "Patterns & Insights" },
  { key: "projects", builder: buildProjects, name: "Projects" },
  { key: "dreams-experiments", builder: buildDreams, name: "Dreams & Experiments" },
];

for (const { key, builder, name } of pages) {
  const pageId = getPageId(key);
  if (!pageId) { console.log(`SKIP ${name}: not in state`); continue; }

  console.log(`Rebuilding: ${name}`);
  const md = builder();
  const preview = md.slice(0, 100).replace(/\n/g, " ");
  console.log(`  Content: ${md.length} chars, preview: ${preview}...`);

  archiveChildPages(pageId);

  try {
    updatePage(pageId, md);
    console.log(`  OK`);
  } catch (err) {
    console.error(`  FAILED: ${err.message?.slice(0, 200)}`);
  }
  console.log();
}

console.log("Done. Pages rebuilt from source data.");
