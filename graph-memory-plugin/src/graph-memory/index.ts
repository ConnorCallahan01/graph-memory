import { CONFIG, isGraphInitialized } from "./config.js";
import { activityBus } from "./events.js";
import { createManifestIfMissing } from "./manifest.js";
import { ensureRuntimeConfig } from "./runtime.js";
import { ensureWorkingDirectories } from "./working-files.js";
import { ensureExternalInputsConfig } from "./external-inputs.js";
import fs from "fs";
import path from "path";

export { activityBus } from "./events.js";
export { CONFIG, saveGlobalConfig, isGraphInitialized, reloadConfig } from "./config.js";

/** Initialize the graph directory structure at the configured graphRoot */
export function initializeGraph() {
  const dirs = [
    CONFIG.paths.graphRoot,
    CONFIG.paths.nodes,
    CONFIG.paths.archive,
    CONFIG.paths.deltas,
    CONFIG.paths.buffer,
    CONFIG.paths.dreams,
    CONFIG.paths.sessionTraces,
    CONFIG.paths.briefs,
    CONFIG.paths.dailyBriefs,
    CONFIG.paths.inputsRoot,
    CONFIG.paths.inputsGmailRaw,
    CONFIG.paths.inputsCalendarRaw,
    CONFIG.paths.inputsSlackRaw,
    CONFIG.paths.inputsNormalized,
    CONFIG.paths.inputsClassified,
    CONFIG.paths.logs,
    CONFIG.paths.sessionContext,
    CONFIG.paths.pipelineLogs,
    CONFIG.paths.workingRoot,
    CONFIG.paths.workingProjects,
    CONFIG.paths.jobsRoot,
    CONFIG.paths.jobsQueued,
    CONFIG.paths.jobsRunning,
    CONFIG.paths.jobsDone,
    CONFIG.paths.jobsFailed,
    `${CONFIG.paths.dreams}/pending`,
    `${CONFIG.paths.dreams}/integrated`,
    `${CONFIG.paths.dreams}/archived`,
    `${CONFIG.paths.nodes}/_meta`,
    `${CONFIG.paths.nodes}/insight`,
    `${CONFIG.paths.nodes}/pattern`,

    CONFIG.paths.mind,
    CONFIG.paths.lenses,
    `${CONFIG.paths.lenses}/_archived`,
    CONFIG.paths.sessions,
    path.dirname(CONFIG.paths.graphIndex),
    CONFIG.paths.nodes,
    CONFIG.paths.archive,
    CONFIG.paths.pipelineObservations,
    ...[
      "patterns", "anti-patterns", "decisions", "preferences",
      "procedures", "corrections", "projects", "concepts",
      "architecture", "people", "tools",
    ].map((cat) => `${CONFIG.paths.nodes}/${cat}`),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  if (!fs.existsSync(CONFIG.paths.map)) {
    fs.writeFileSync(
      CONFIG.paths.map,
      `# MAP — Knowledge Graph Index\n\n> Auto-generated. Each entry: node path | gist | edges\n\n_No nodes yet. The graph will grow as conversations happen._\n`
    );
  }

  if (!fs.existsSync(CONFIG.paths.priors)) {
    fs.writeFileSync(
      CONFIG.paths.priors,
      `# PRIORS — Behavioral Guidelines\n\n> Derived from cross-session patterns. These shape how you think, not what you know.\n\n_No priors yet. These will emerge from conversation patterns._\n`
    );
  }

  if (!fs.existsSync(CONFIG.paths.index)) {
    fs.writeFileSync(CONFIG.paths.index, "[]");
  }

  ensureWorkingDirectories();

  if (!fs.existsSync(CONFIG.paths.working)) {
    fs.writeFileSync(
      CONFIG.paths.working,
      `# WORKING — Volatile Working Memory\n\n> Recent session context across active projects. Auto-generated from latest deltas.\n\n_No recent activity._\n`
    );
  }

  if (!fs.existsSync(CONFIG.paths.workingGlobal)) {
    fs.writeFileSync(
      CONFIG.paths.workingGlobal,
      `# WORKING — Global Track\n\n> Cross-project carryover and global working memory.\n\n_No recent activity._\n`
    );
  }

  createManifestIfMissing();
  ensureRuntimeConfig();
  ensureExternalInputsConfig();

  activityBus.log("system:init", "Graph directory initialized", {
    graphRoot: CONFIG.paths.graphRoot,
  });
}
