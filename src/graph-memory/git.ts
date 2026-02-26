import simpleGit, { SimpleGit } from "simple-git";
import fs from "fs";
import { CONFIG } from "./config.js";
import { activityBus } from "./events.js";

let git: SimpleGit | null = null;

/**
 * Initialize git repo in graph/ if not already one.
 * Returns the SimpleGit instance or null if git is disabled.
 */
async function getGit(): Promise<SimpleGit | null> {
  if (!CONFIG.git.enabled) return null;

  if (!git) {
    const graphRoot = CONFIG.paths.graphRoot;

    // Init repo if needed
    if (!fs.existsSync(`${graphRoot}/.git`)) {
      const freshGit = simpleGit(graphRoot);
      await freshGit.init();
      activityBus.log("git:commit", "Initialized git repo in graph/");

      // Create .gitignore for buffer/temp files
      const gitignore = `.buffer/\n.deltas/\n`;
      fs.writeFileSync(`${graphRoot}/.gitignore`, gitignore);
      await freshGit.add(".gitignore");
      await freshGit.commit("memory: init graph repository");
    }

    git = simpleGit(graphRoot);
  }

  return git;
}

/**
 * Auto-commit all graph changes with a descriptive message.
 * Called at end of librarian consolidation.
 */
export async function autoCommit(summary?: string): Promise<void> {
  const g = await getGit();
  if (!g) return;

  try {
    const status = await g.status();

    // Nothing to commit
    if (status.isClean()) return;

    // Stage all graph changes (nodes, MAP, PRIORS, index, dreams)
    await g.add([
      "nodes/",
      "archive/",
      "dreams/",
      "MAP.md",
      "PRIORS.md",
      ".index.json",
      "manifest.yml",
    ]);

    // Re-check after staging
    const staged = await g.status();
    if (staged.staged.length === 0) return;

    // Build structured commit message
    const commitMsg = buildCommitMessage(staged, summary);
    await g.commit(commitMsg);

    activityBus.log("git:commit", `Git commit: ${commitMsg.split("\n")[0]}`, {
      filesChanged: staged.staged.length,
    });

    // Auto-push if configured
    if (CONFIG.git.autoPush) {
      try {
        const remotes = await g.getRemotes();
        if (remotes.length > 0) {
          await g.push(CONFIG.git.remote, CONFIG.git.branch);
          activityBus.log("git:push", `Pushed to ${CONFIG.git.remote}/${CONFIG.git.branch}`);
        }
      } catch (pushErr: any) {
        // Push failures are non-fatal (no remote configured is common)
        activityBus.log("git:error", `Push skipped: ${pushErr.message}`);
      }
    }
  } catch (err: any) {
    activityBus.log("git:error", `Auto-commit failed: ${err.message}`, {
      error: err.message,
    });
  }
}

/**
 * Build a structured commit message categorizing changes.
 */
function buildCommitMessage(status: any, summary?: string): string {
  const created: string[] = [];
  const updated: string[] = [];
  const archived: string[] = [];
  const meta: string[] = [];

  for (const file of status.staged) {
    if (file.startsWith("nodes/") && status.created?.includes(file)) {
      created.push(file);
    } else if (file.startsWith("nodes/")) {
      updated.push(file);
    } else if (file.startsWith("archive/")) {
      archived.push(file);
    } else {
      meta.push(file);
    }
  }

  // First line: summary
  const parts: string[] = [];
  if (created.length > 0) parts.push(`${created.length} new`);
  if (updated.length > 0) parts.push(`${updated.length} updated`);
  if (archived.length > 0) parts.push(`${archived.length} archived`);
  const statsStr = parts.length > 0 ? parts.join(", ") : `${status.staged.length} files`;

  let msg = `${CONFIG.git.commitPrefix} ${summary || "consolidation"} — ${statsStr}`;

  // Detailed body
  const body: string[] = [];
  if (created.length > 0) {
    body.push(`\nNew:`);
    for (const f of created) body.push(`  + ${f}`);
  }
  if (updated.length > 0) {
    body.push(`\nUpdated:`);
    for (const f of updated) body.push(`  ~ ${f}`);
  }
  if (archived.length > 0) {
    body.push(`\nArchived:`);
    for (const f of archived) body.push(`  - ${f}`);
  }
  if (meta.length > 0) {
    body.push(`\nMeta:`);
    for (const f of meta) body.push(`  * ${f}`);
  }

  if (body.length > 0) {
    msg += "\n" + body.join("\n");
  }

  return msg;
}

/**
 * List recent memory commits for recovery purposes.
 */
export async function listCommits(count = 10): Promise<Array<{
  hash: string;
  date: string;
  message: string;
}>> {
  const g = await getGit();
  if (!g) return [];

  try {
    const log = await g.log({ maxCount: count });
    return log.all.map(entry => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
    }));
  } catch {
    return [];
  }
}

/**
 * Revert the graph to a specific commit.
 * Creates a new revert commit rather than destructively resetting.
 */
export async function revertTo(commitHash: string): Promise<{ success: boolean; message: string }> {
  const g = await getGit();
  if (!g) return { success: false, message: "Git is disabled" };

  try {
    // Validate the commit exists
    const log = await g.log({ maxCount: 50 });
    const target = log.all.find(e => e.hash.startsWith(commitHash));
    if (!target) {
      return { success: false, message: `Commit not found: ${commitHash}` };
    }

    // Get current HEAD for the revert message
    const currentHead = log.latest;

    // Checkout the target commit's files into the working tree
    // (without moving HEAD — then commit the result as a new revert commit)
    await g.checkout([commitHash, "--", "."]);

    // Stage everything
    await g.add(".");

    // Commit the revert
    const shortHash = commitHash.slice(0, 7);
    const revertMsg = `${CONFIG.git.commitPrefix} revert to ${shortHash} (${target.message})`;
    await g.commit(revertMsg);

    activityBus.log("git:commit", `Reverted to ${shortHash}: ${target.message}`, {
      targetHash: commitHash,
      previousHead: currentHead?.hash,
    });

    return { success: true, message: `Reverted to ${shortHash}: ${target.message}` };
  } catch (err: any) {
    activityBus.log("git:error", `Revert failed: ${err.message}`);
    return { success: false, message: `Revert failed: ${err.message}` };
  }
}
