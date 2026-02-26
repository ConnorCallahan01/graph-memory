import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";
import { CONFIG } from "../src/graph-memory/config.js";

/**
 * Create an isolated temp graph directory and patch CONFIG.paths for test isolation.
 * Returns the temp root and a cleanup function.
 *
 * NOTE: Tests must run serially (not --concurrent) because this mutates the
 * module-level CONFIG singleton. Each test's afterEach must call cleanup() to
 * restore original paths.
 */
export function createTestGraph(): {
  root: string;
  cleanup: () => void;
  originalPaths: typeof CONFIG.paths;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
  const originalPaths = { ...CONFIG.paths };

  // Patch CONFIG paths to point to temp directory
  const mutableConfig = CONFIG as { paths: Record<string, string> };
  mutableConfig.paths = {
    ...originalPaths,
    projectRoot: root,
    graphRoot: path.join(root, "graph"),
    manifest: path.join(root, "graph/manifest.yml"),
    map: path.join(root, "graph/MAP.md"),
    priors: path.join(root, "graph/PRIORS.md"),
    index: path.join(root, "graph/.index.json"),
    deltas: path.join(root, "graph/.deltas"),
    dreams: path.join(root, "graph/dreams"),
    nodes: path.join(root, "graph/nodes"),
    archive: path.join(root, "graph/archive"),
    buffer: path.join(root, "graph/.buffer"),
    conversationLog: path.join(root, "graph/.buffer/conversation.jsonl"),
  };

  // Create directories
  const dirs = [
    mutableConfig.paths.graphRoot,
    mutableConfig.paths.nodes,
    mutableConfig.paths.archive,
    mutableConfig.paths.deltas,
    mutableConfig.paths.buffer,
    path.join(mutableConfig.paths.dreams, "pending"),
    path.join(mutableConfig.paths.dreams, "integrated"),
    path.join(mutableConfig.paths.dreams, "archived"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create empty index
  fs.writeFileSync(mutableConfig.paths.index, "[]");

  return {
    root,
    originalPaths,
    cleanup: () => {
      // Restore original paths
      (CONFIG as any).paths = originalPaths;
      // Remove temp directory
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create a test node file with the given frontmatter and content.
 */
export function createTestNode(
  nodesDir: string,
  nodePath: string,
  frontmatter: Record<string, any>,
  content?: string,
) {
  const filePath = path.join(nodesDir, `${nodePath}.md`);
  const fileDir = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  const body = content || `# ${frontmatter.title || nodePath}\n\nTest content.`;
  const fullContent = matter.stringify(body, frontmatter);
  fs.writeFileSync(filePath, fullContent);
  return filePath;
}
