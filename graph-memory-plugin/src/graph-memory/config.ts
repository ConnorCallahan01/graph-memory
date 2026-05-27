import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Global config pointer file: tells the MCP server where the graph root lives.
 * Created during onboarding, read on every startup.
 */
const GLOBAL_CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".graph-memory-config.yml"
);

interface GraphMemoryGlobalConfig {
  graphRoot: string;
}

interface GraphMemoryLocalConfig {
  git?: {
    enabled?: boolean;
    autoPush?: boolean;
  };
  externalInputs?: {
    enabled?: boolean;
  };
  notionSync?: {
    enabled?: boolean;
    syncHourLocal?: number;
    maxBatchSize?: number;
    skipInbound?: boolean;
    webhookSecret?: string;
  };
}

/**
 * Resolve the graph root directory. Priority:
 * 1. GRAPH_MEMORY_ROOT env var
 * 2. ~/.graph-memory-config.yml pointer file
 * 3. Default: ~/.graph-memory/
 */
function resolveGraphRoot(): string {
  // 1. Env var override
  if (process.env.GRAPH_MEMORY_ROOT) {
    return path.resolve(process.env.GRAPH_MEMORY_ROOT);
  }

  // 2. Global config pointer file
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      const config = yaml.load(raw) as GraphMemoryGlobalConfig;
      if (config?.graphRoot) {
        return path.resolve(config.graphRoot);
      }
    } catch {
      // Fall through to default
    }
  }

  // 3. Default
  return path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".graph-memory"
  );
}

/**
 * Load per-graph config.yml if it exists (user overrides for models, git, etc.)
 */
function loadLocalConfig(graphRoot: string): GraphMemoryLocalConfig {
  const configPath = path.join(graphRoot, "config.yml");
  if (!fs.existsSync(configPath)) return {};
  try {
    return (yaml.load(fs.readFileSync(configPath, "utf-8")) as GraphMemoryLocalConfig) || {};
  } catch {
    return {};
  }
}

/**
 * Build the full config object. Called once at startup.
 */
function createConfig() {
  const graphRoot = resolveGraphRoot();
  const local = loadLocalConfig(graphRoot);
  const inferredTimeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const nodesPath = path.join(graphRoot, "nodes");
  const archivePath = path.join(graphRoot, "archive");

  return {
    shadow: process.env.GRAPH_MEMORY_SHADOW === "1",

    session: {
      scribeInterval: 10,
      librarianDeltaThreshold: 20,
      auditScribeFileThreshold: 3,
      observerScribeThreshold: 3,
      compressorObserverThreshold: 5,
      idleTimeoutMs: 120_000,
      workerTimeoutMs: 300_000,
      maxSessionMessages: 200,
      minSessionMessages: 3,
      pipelineCooldownMs: 300_000,
      daemonPollMs: 30_000,
      daemonConcurrency: 6,
      dailyAnalysisHourLocal: 7,
      dailyAnalysisTimeZone: inferredTimeZone,
    },

    graph: {
      maxMapTokens: 12000,
      maxMapInjectionTokens: 7000,
      maxSessionStartTokens: 15000,
      maxPinnedTokens: 3000,
      decayHalfLifeDays: 90,
      decayArchiveThreshold: 0.20,
      decayConfidenceFloor: 0.1,
      decayHotNodeThreshold: 0.6,
      decayRecentAccessGraceDays: 7,
      decayRecentAccessArchiveProtectionDays: 45,
      decayAccessCountArchiveProtection: 3,
      // Category protection is intentionally minimal: value is judged by
      // behavioral signals (hotNode / frequentlyAccessed / recentlyAccessed),
      // not by structural category. Only genuinely structural categories that
      // should never be mechanically archived stay here.
      decayProtectedCategories: [
        "meta",
        "people",
      ],
      dreamPendingMaxSessions: 5,
      dreamMinConfidence: 0.2,
      dreamPromoteConfidence: 0.4,
      maxMapDepth: 2,
      maxMapEntriesPerCategory: 8,
      maxPendingDreams: 15,
      maxDreamsPerSession: 3,
      maxPriors: 30,
      maxPriorsTokens: 1500,
      maxNodesBeforePrune: 300,
      maxSomaTokens: 2000,
      maxWorkingTokens: 4000,
      maxDreamsContextTokens: 1500,
    },

    skillforge: {
      enabled: true,
      minAccessCount: 8,
      minRecallActionCount: 3,
      minDistinctSessions: 2,
      scoreThreshold: 0.55,
      cooldownDays: 14,
      maxSkillsPerProject: 15,
      maxJobsPerTick: 2,
      accessCountWeight: 0.30,
      recallActionWeight: 0.25,
      sessionSpanWeight: 0.20,
      pinnedBonus: 0.15,
      proceduralWeight: 0.10,
      proceduralKeywords: [
        "run", "execute", "first", "then", "deploy", "build", "test",
        "install", "configure", "create", "delete", "update", "ssh",
        "commit", "push", "pull", "start", "stop", "restart", "verify",
        "check", "navigate", "open", "copy", "set", "add", "remove",
      ],
    },

    paths: {
      graphRoot,
      nodes: nodesPath,
      archive: archivePath,
      deltas: path.join(graphRoot, ".deltas"),
      dreams: path.join(graphRoot, "dreams"),
      buffer: path.join(graphRoot, ".buffer"),
      map: path.join(graphRoot, "MAP.md"),
      priors: path.join(graphRoot, "PRIORS.md"),
      index: path.join(graphRoot, ".index.json"),
      archiveIndex: path.join(graphRoot, ".archive-index.json"),
      manifest: path.join(graphRoot, "manifest.yml"),
      dirtyState: path.join(graphRoot, ".dirty-session"),
      consolidationPending: path.join(graphRoot, ".consolidation-pending"),
      scribePending: path.join(graphRoot, ".scribe-pending"),
      dreamerPending: path.join(graphRoot, ".dreamer-pending"),
      librarianPending: path.join(graphRoot, ".librarian-pending"),
      preflightReport: path.join(graphRoot, ".preflight-report.json"),
      auditReport: path.join(graphRoot, ".audit-report.json"),
      auditBrief: path.join(graphRoot, ".audit-brief.md"),
      soma: path.join(graphRoot, "SOMA.md"),
      working: path.join(graphRoot, "WORKING.md"),
      workingRoot: path.join(graphRoot, "working"),
      workingGlobal: path.join(graphRoot, "working/global.md"),
      workingProjects: path.join(graphRoot, "working/projects"),
      dreamsContext: path.join(graphRoot, "DREAMS.md"),
      deltasAudited: path.join(graphRoot, ".deltas/audited"),
      activeProjects: path.join(graphRoot, ".active-projects"),
      sessionTraces: path.join(graphRoot, ".sessions"),
      briefs: path.join(graphRoot, "briefs"),
      dailyBriefs: path.join(graphRoot, "briefs/daily"),
      inputsRoot: path.join(graphRoot, ".inputs"),
      inputsConfig: path.join(graphRoot, ".inputs/config.json"),
      inputsGmailRaw: path.join(graphRoot, ".inputs/gmail/raw"),
      inputsCalendarRaw: path.join(graphRoot, ".inputs/calendar/raw"),
      inputsSlackRaw: path.join(graphRoot, ".inputs/slack/raw"),
      inputsNormalized: path.join(graphRoot, ".inputs/normalized"),
      inputsClassified: path.join(graphRoot, ".inputs/classified"),
      logs: path.join(graphRoot, ".logs"),
      sessionContext: path.join(graphRoot, ".session-context"),
      pipelineLogs: path.join(graphRoot, ".pipeline-logs"),
      jobsRoot: path.join(graphRoot, ".jobs"),
      jobsQueued: path.join(graphRoot, ".jobs/queued"),
      jobsRunning: path.join(graphRoot, ".jobs/running"),
      jobsDone: path.join(graphRoot, ".jobs/done"),
      jobsFailed: path.join(graphRoot, ".jobs/failed"),
      daemonLock: path.join(graphRoot, ".jobs/daemon.lock"),
      daemonState: path.join(graphRoot, ".jobs/daemon-state.json"),
      runtimeConfig: path.join(graphRoot, ".runtime-config.json"),
      notionSyncState: path.join(graphRoot, ".notion-sync-state.json"),
      skillforgeManifests: path.join(graphRoot, ".skillforge"),
      // Prompts are bundled relative to dist/ (or src/ in dev)
      prompts: path.resolve(__dirname, "prompts"),

      // project-scoped paths
      auditRoot: path.join(graphRoot, "audit"),
      auditProjects: path.join(graphRoot, "audit", "projects"),
      dreamsProjects: path.join(graphRoot, "dreams", "projects"),
      projectLocks: path.join(graphRoot, ".jobs", "project-locks"),
      globalLock: path.join(graphRoot, ".jobs", "global.lock"),

      // mental model paths
      mind: path.join(graphRoot, "mind"),
      lenses: path.join(graphRoot, "lenses"),
      sessions: path.join(graphRoot, "sessions"),
      // nodes/ is the canonical store; older installs may have an empty graph/
      // shadow directory but pipeline code reads and writes nodes/.
      graphIndex: path.join(graphRoot, "graph", ".index.json"),
      pipelineObservations: path.join(graphRoot, ".pipeline", "observations"),
    },

    git: {
      enabled: local.git?.enabled !== false,
      remote: "origin",
      branch: "main",
      autoPush: local.git?.autoPush || false,
      commitPrefix: "memory:",
    },

    externalInputs: {
      enabled: local.externalInputs?.enabled ?? true,
    },

    notionSync: {
      enabled: local.notionSync?.enabled ?? false,
      syncHourLocal: local.notionSync?.syncHourLocal ?? 8,
      skipInbound: local.notionSync?.skipInbound ?? false,
      webhookSecret: local.notionSync?.webhookSecret
        ? local.notionSync.webhookSecret.replace(/^\$\{(\w+)\}$/, (_, v) => process.env[v] || "")
        : process.env.NOTION_WEBHOOK_SECRET || "",
    },

    /** Path to the global config pointer file */
    globalConfigPath: GLOBAL_CONFIG_PATH,
  };
}

export const CONFIG = createConfig();

/**
 * Reload CONFIG in place after the global config pointer file changes.
 * Called after `initialize` action writes a new graphRoot.
 */
export function reloadConfig(): void {
  const fresh = createConfig();
  Object.assign(CONFIG, fresh);
}

/**
 * Save the graph root path to the global config pointer file.
 * Called during onboarding.
 */
export function saveGlobalConfig(graphRoot: string): void {
  const config: GraphMemoryGlobalConfig = { graphRoot: path.resolve(graphRoot) };
  fs.writeFileSync(GLOBAL_CONFIG_PATH, yaml.dump(config));
}

/**
 * Check if the graph has been initialized (global config exists and points to a valid graph).
 */
export function isGraphInitialized(): boolean {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return false;
  try {
    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const config = yaml.load(raw) as GraphMemoryGlobalConfig;
    if (!config?.graphRoot) return false;
    return fs.existsSync(path.join(config.graphRoot, "MAP.md"));
  } catch {
    return false;
  }
}
