import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { readModel } from "./mind/model.js";
import { ensureLens, readModel as readProjectModel, lensExists } from "./lenses/manager.js";
import { readRecentSessions } from "./sessions/manager.js";
import { SessionLog } from "./sessions/types.js";
import { getAntiPatterns } from "./pipeline/graph-index.js";
import { getProjectWorkingStatePath } from "./working-files.js";
import { readNotionSyncState } from "./pipeline/notion-sync.js";
import { searchDatabaseRows, listChildBlocks } from "./pipeline/notion-cli.js";

export interface SessionStartResult {
  context: string;
  tokensUsed: number;
  sources: {
    globalModel: boolean;
    projectModel: boolean;
    sessionLog: boolean;
    guardrails: boolean;
    pickup: boolean;
    notionTasks: boolean;
    fallback: boolean;
  };
}

export function buildSessionStartContext(projectName: string): SessionStartResult {
  const parts: string[] = [];
  let tokensUsed = 0;
  const sources = {
    globalModel: false,
    projectModel: false,
    sessionLog: false,
    guardrails: false,
    pickup: false,
    notionTasks: false,
    fallback: false,
  };

  const globalFile = readModel();
  if (globalFile?.model) {
    const block = formatGlobalModel(globalFile.model);
    if (block) {
      parts.push(block);
      tokensUsed += estimateTokens(block);
      sources.globalModel = true;
    }
  }

  const guardrails = buildGuardrails(projectName);
  if (guardrails) {
    parts.push(guardrails);
    tokensUsed += estimateTokens(guardrails);
    sources.guardrails = true;
  }

  if (projectName && projectName !== "global") {
    if (!lensExists(projectName)) {
      ensureLens(projectName);
    }

    const projectFile = readProjectModel(projectName);
    if (projectFile?.model) {
      const block = formatProjectModel(projectFile.model);
      if (block) {
        parts.push(block);
        tokensUsed += estimateTokens(block);
        sources.projectModel = true;
      }
    }

    const recentSessions = readRecentSessions(projectName, 1);
    if (recentSessions.length > 0) {
      const logBlock = formatSessionLog(recentSessions[0]);
      if (logBlock) {
        parts.push(logBlock);
        tokensUsed += estimateTokens(logBlock);
        sources.sessionLog = true;
      }
    }

    const pickupBlock = readNextPickup(projectName);
    if (pickupBlock) {
      parts.push(pickupBlock);
      tokensUsed += estimateTokens(pickupBlock);
      sources.pickup = true;
    }
  }

  const notionTasks = fetchNotionTasks(projectName);
  if (notionTasks) {
    parts.push(notionTasks);
    tokensUsed += estimateTokens(notionTasks);
    sources.notionTasks = true;
  }

  if (parts.length === 0) {
    sources.fallback = true;
  }

  return {
    context: parts.join("\n\n---\n\n"),
    tokensUsed,
    sources,
  };
}

function formatGlobalModel(model: any): string {
  const sections: string[] = [];

  if (model.guardrails?.length > 0) {
    sections.push("## Guardrails\n");
    for (const g of model.guardrails) {
      sections.push("- " + g);
    }
  }

  if (model.cognitiveStyle) {
    sections.push("\n## Style\n\n" + model.cognitiveStyle);
  }

  if (model.decisionPatterns?.length > 0) {
    sections.push("\n## Decision Patterns\n");
    for (const d of model.decisionPatterns) {
      sections.push("- " + d);
    }
  }

  if (model.preferences?.length > 0) {
    sections.push("\n## Preferences\n");
    for (const p of model.preferences) {
      sections.push("- " + p);
    }
  }

  if (model.emotionalProfile) {
    sections.push("\n## Engagement\n\n" + model.emotionalProfile);
  }

  if (model.relationalNotes?.length > 0) {
    sections.push("\n## Relational Notes\n");
    for (const n of model.relationalNotes) {
      sections.push("- " + n);
    }
  }

  return sections.join("\n");
}

function formatProjectModel(model: any): string {
  const sections: string[] = [];

  if (model.techStack?.length > 0) {
    sections.push("## Tech Stack\n");
    for (const t of model.techStack) {
      sections.push("- " + t);
    }
  }

  if (model.conventions?.length > 0) {
    sections.push("\n## Conventions\n");
    for (const c of model.conventions) {
      sections.push("- " + c);
    }
  }

  if (model.procedures?.length > 0) {
    sections.push("\n## Procedures\n");
    for (const p of model.procedures) {
      sections.push("- " + p);
    }
  }

  if (model.guardrails?.length > 0) {
    sections.push("\n## Project Guardrails\n");
    for (const g of model.guardrails) {
      sections.push("- " + g);
    }
  }

  if (model.activeWork?.length > 0) {
    sections.push("\n## Active Work\n");
    for (const a of model.activeWork) {
      sections.push("- " + a);
    }
  }

  if (model.openThreads?.length > 0) {
    sections.push("\n## Open Threads\n");
    for (const o of model.openThreads) {
      sections.push("- " + o);
    }
  }

  return sections.join("\n");
}

function formatSessionLog(log: SessionLog): string | null {
  const lines: string[] = ["## Last Session", ""];
  const date = log.timestamp.slice(0, 10);
  lines.push("**" + date + "**");

  if (log.openThreads.length > 0) {
    lines.push("Open: " + log.openThreads.join("; "));
  }
  if (log.nextSessionShould) {
    lines.push("Next: " + log.nextSessionShould);
  }
  lines.push("");

  const result = lines.join("\n").trim();
  return result === "## Last Session" ? null : result;
}

function buildGuardrails(projectName: string): string | null {
  try {
    const antiPatterns = getAntiPatterns(projectName !== "global" ? projectName : undefined);
    if (antiPatterns.length === 0) return null;

    const lines: string[] = ["## Anti-Patterns", ""];
    for (const ap of antiPatterns) {
      lines.push("- " + ap.gist);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function readNextPickup(projectName: string): string | null {
  try {
    const statePath = getProjectWorkingStatePath(projectName);
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const latest = state.sessions?.[0];
    if (!latest?.nextPickup?.length) return null;

    const items = latest.nextPickup.slice(0, 3);
    const lines = ["## Pick Up", ""];
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function fetchNotionTasks(projectName: string): string | null {
  try {
    const notionState = readNotionSyncState();
    if (!notionState?.databases?.tasks?.id || !notionState?.databases?.projects?.id) return null;

    const projectPageId = resolveNotionProjectId(notionState.databases.projects.id, projectName);
    const filter: Record<string, any> = {
      and: [
        { property: "Status", select: { equals: "Next" } },
      ],
    };
    if (projectPageId) {
      filter.and.push({ property: "Project", relation: { contains: projectPageId } });
    }

    const rows = searchDatabaseRows(notionState.databases.tasks.id, filter);
    if (!rows || rows.length === 0) return null;

    const lines: string[] = ["## Next Tasks", ""];
    for (const row of rows.slice(0, 10)) {
      const props = row.properties || {};
      const name = extractPropText(props, "Name") || "Untitled";
      const priority = extractPropSelect(props, "Priority") || "";
      const prefix = priority ? `[${priority}] ` : "";
      lines.push(`- ${prefix}${name}`);

      try {
        const blocks = listChildBlocks(row.id);
        const contentLines = extractBlockText(blocks);
        if (contentLines.length > 0) {
          for (const cl of contentLines.slice(0, 8)) {
            lines.push(`  ${cl}`);
          }
        }
      } catch { /* skip content */ }
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

function resolveNotionProjectId(projectsDbId: string, projectName: string): string | null {
  try {
    const slug = projectName.replace(/[^a-zA-Z0-9._-]+/g, "__");
    const rows = searchDatabaseRows(projectsDbId);
    for (const row of rows) {
      const props = row.properties || {};
      const name = extractPropText(props, "Name") || "";
      const nameSlug = name.toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "__");
      if (nameSlug === slug.toLowerCase() || name.toLowerCase().includes(projectName.split("/").pop()?.toLowerCase() || "")) {
        return row.id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function extractBlockText(blocks: any[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const btype = block.type;
    if (!btype) continue;
    const content = block[btype];
    if (!content?.rich_text) continue;
    const text = content.rich_text.map((t: any) => t.plain_text || "").join("");
    if (!text) continue;

    if (btype === "heading_1" || btype === "heading_2" || btype === "heading_3") {
      lines.push(`**${text}**`);
    } else if (btype === "bulleted_list_item" || btype === "numbered_list_item") {
      lines.push(`  - ${text}`);
    } else if (btype === "to_do") {
      const checked = content.checked ? "x" : " ";
      lines.push(`  [${checked}] ${text}`);
    } else {
      lines.push(text);
    }
  }
  return lines;
}

function extractPropText(props: Record<string, any>, key: string): string {
  const prop = props[key];
  if (!prop) return "";
  if (prop.title) return prop.title.map((t: any) => t.plain_text || "").join("");
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text || "").join("");
  return "";
}

function extractPropSelect(props: Record<string, any>, key: string): string {
  const prop = props[key];
  if (!prop) return "";
  if (prop.select?.name) return prop.select.name;
  if (prop.status?.name) return prop.status.name;
  return "";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function hasMentalModelData(): boolean {
  const modelPath = path.join(CONFIG.paths.mind, "model.json");
  return fs.existsSync(modelPath);
}
