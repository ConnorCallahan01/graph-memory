import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { NotionSyncState, createEmptyNotionSyncState, readNotionSyncState, writeNotionSyncState } from "./notion-sync.js";
import { checkNtn, createPage, createDatabase, configureDataSource, buildDatabaseProperties, TASKS_DB_SCHEMA, DECISIONS_DB_SCHEMA, BRIEFS_DB_SCHEMA, PROJECTS_DB_SCHEMA, PATTERNS_DB_SCHEMA, DREAMS_DB_SCHEMA } from "./notion-cli.js";

function adjustForExistingTitle(props: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value?.type === "title") {
      if (key === "Name") {
        result[key] = value;
      } else {
        result["Name"] = { name: key };
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface SetupNotionWorkspaceOptions {
  parentPageId?: string;
  workspaceName?: string;
}

export interface SetupNotionWorkspaceResult {
  parentPageId: string;
  workspaceName: string;
  databases: Record<string, { id: string }>;
  pages: string[];
  message: string;
}

export function setupNotionWorkspace(options: SetupNotionWorkspaceOptions = {}): SetupNotionWorkspaceResult {
  let state = readNotionSyncState();
  if (state.parentPageId && !options.parentPageId) {
    return {
      parentPageId: state.parentPageId,
      workspaceName: state.workspaceName,
      databases: Object.fromEntries(
        Object.entries(state.databases).map(([k, v]) => [k, { id: v.id }])
      ),
      pages: Object.keys(state.pages),
      message: "Notion workspace already configured.",
    };
  }

  const ntnStatus = checkNtn();
  if (!ntnStatus.installed) {
    throw new Error("ntn CLI is not installed. Install it with: curl -fsSL https://ntn.dev | bash");
  }
  if (!ntnStatus.authenticated) {
    throw new Error("ntn CLI is not authenticated. Run 'ntn login' to authenticate.");
  }

  state = state.parentPageId ? state : createEmptyNotionSyncState();

  const workspaceName = options.workspaceName || "My Mind";
  let parentPageId = options.parentPageId || "";

  if (!parentPageId) {
    const result = createPage("", `# ${workspaceName}`);
    parentPageId = result.id;
    activityBus.log("notion-sync:start", `Created Notion workspace page: ${workspaceName}`, {
      pageId: parentPageId,
    });
  }

  state.enabled = true;
  state.parentPageId = parentPageId;
  state.workspaceName = workspaceName;
  state.syncHourLocal = CONFIG.notionSync.syncHourLocal;

  const createdPages: string[] = [];

  const tasksDb = createDatabase(parentPageId, "Tasks & Work");
  if (tasksDb.dataSourceId) {
    configureDataSource(tasksDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(TASKS_DB_SCHEMA),
    ));
  }
  state.databases.tasks = { id: tasksDb.id };
  createdPages.push("Tasks & Work");

  const decisionsDb = createDatabase(parentPageId, "Decisions");
  if (decisionsDb.dataSourceId) {
    configureDataSource(decisionsDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(DECISIONS_DB_SCHEMA),
    ));
  }
  state.databases.decisions = { id: decisionsDb.id };
  createdPages.push("Decisions");

  const briefsDb = createDatabase(parentPageId, "Daily Briefs");
  if (briefsDb.dataSourceId) {
    configureDataSource(briefsDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(BRIEFS_DB_SCHEMA),
    ));
  }
  state.databases.briefs = { id: briefsDb.id };
  createdPages.push("Daily Briefs");

  const projectsDb = createDatabase(parentPageId, "Projects");
  if (projectsDb.dataSourceId) {
    configureDataSource(projectsDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(PROJECTS_DB_SCHEMA),
    ));
  }
  state.databases.projects = { id: projectsDb.id };
  createdPages.push("Projects");

  const patternsDb = createDatabase(parentPageId, "Patterns & Insights");
  if (patternsDb.dataSourceId) {
    configureDataSource(patternsDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(PATTERNS_DB_SCHEMA),
    ));
  }
  state.databases.patterns = { id: patternsDb.id };
  createdPages.push("Patterns & Insights");

  const dreamsDb = createDatabase(parentPageId, "Dreams & Experiments");
  if (dreamsDb.dataSourceId) {
    configureDataSource(dreamsDb.dataSourceId, adjustForExistingTitle(
      buildDatabaseProperties(DREAMS_DB_SCHEMA),
    ));
  }
  state.databases.dreams = { id: dreamsDb.id };
  createdPages.push("Dreams & Experiments");

  const wikiPages = [
    { key: "how-i-think", title: "# How I Think" },
    { key: "archive", title: "# Archive" },
  ];

  for (const page of wikiPages) {
    try {
      const result = createPage(parentPageId, page.title);
      state.pages[page.key] = {
        pageId: result.id,
        sourceNodes: [],
        lastSyncedHash: "",
        lastNotionHash: "",
      };
      createdPages.push(page.key);
    } catch (err: any) {
      activityBus.log("notion-sync:error", `Failed to create wiki page ${page.key}: ${err.message}`);
    }
  }

  writeNotionSyncState(state);

  activityBus.log("notion-sync:complete", `Notion workspace setup complete: ${workspaceName}`, {
    parentPageId,
    databases: Object.keys(state.databases),
    pages: createdPages,
  });

  return {
    parentPageId,
    workspaceName,
    databases: Object.fromEntries(
      Object.entries(state.databases).map(([k, v]) => [k, { id: v.id }])
    ),
    pages: createdPages,
    message: `Notion workspace "${workspaceName}" configured with ${createdPages.length} pages/databases.`,
  };
}
