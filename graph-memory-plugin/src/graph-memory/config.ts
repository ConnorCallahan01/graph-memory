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

  return {
    session: {
      scribeInterval: 5,
      idleTimeoutMs: 120_000,
      maxSessionMessages: 200,
      minSessionMessages: 3,
      pipelineCooldownMs: 300_000,
    },

    graph: {
      maxMapTokens: 5000,
      maxPriors: 30,
      maxNodesBeforePrune: 80,
      decayHalfLifeDays: 30,
      decayArchiveThreshold: 0.15,
      decayHotNodeThreshold: 0.6,
      dreamPendingMaxSessions: 5,
      dreamMinConfidence: 0.2,
      dreamPromoteConfidence: 0.5,
      maxMapDepth: 2,
      maxPendingDreams: 20,
      maxDreamsPerSession: 5,
    },

    paths: {
      graphRoot,
      nodes: path.join(graphRoot, "nodes"),
      archive: path.join(graphRoot, "archive"),
      deltas: path.join(graphRoot, ".deltas"),
      dreams: path.join(graphRoot, "dreams"),
      buffer: path.join(graphRoot, ".buffer"),
      conversationLog: path.join(graphRoot, ".buffer/conversation.jsonl"),
      map: path.join(graphRoot, "MAP.md"),
      priors: path.join(graphRoot, "PRIORS.md"),
      index: path.join(graphRoot, ".index.json"),
      manifest: path.join(graphRoot, "manifest.yml"),
      dirtyState: path.join(graphRoot, ".dirty-session"),
      consolidationPending: path.join(graphRoot, ".consolidation-pending"),
      scribePending: path.join(graphRoot, ".scribe-pending"),
      activeProjects: path.join(graphRoot, ".active-projects"),
      // Prompts are bundled relative to dist/ (or src/ in dev)
      prompts: path.resolve(__dirname, "prompts"),
    },

    git: {
      enabled: local.git?.enabled !== false,
      remote: "origin",
      branch: "main",
      autoPush: local.git?.autoPush || false,
      commitPrefix: "memory:",
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
