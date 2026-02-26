#!/usr/bin/env node
/**
 * CLI tool: list recent memory commits and optionally revert to one.
 *
 * Usage:
 *   npm run revert          # List last 10 commits
 *   npm run revert <hash>   # Revert to a specific commit
 */
import { listCommits, revertTo } from "./git.js";
import { initializeGraph } from "./index.js";

initializeGraph();

const targetHash = process.argv[2];

if (!targetHash) {
  // List mode
  console.log("\nRecent memory commits:\n");
  const commits = await listCommits(10);

  if (commits.length === 0) {
    console.log("  No commits found. Graph may not have a git repo yet.");
    console.log("  Run a full session to trigger the first auto-commit.\n");
    process.exit(0);
  }

  for (const c of commits) {
    const shortHash = c.hash.slice(0, 7);
    const date = new Date(c.date).toLocaleString();
    console.log(`  ${shortHash}  ${date}  ${c.message}`);
  }

  console.log(`\nTo revert: npm run revert <hash>\n`);
} else {
  // Revert mode
  console.log(`\nReverting to commit ${targetHash}...\n`);
  const result = await revertTo(targetHash);

  if (result.success) {
    console.log(`  OK: ${result.message}\n`);
  } else {
    console.error(`  FAILED: ${result.message}\n`);
    process.exit(1);
  }
}
