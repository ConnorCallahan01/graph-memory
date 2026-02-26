import fs from "fs";
import path from "path";
import matter from "gray-matter";

/**
 * Resolve a user/LLM-controlled path safely within a base directory.
 * Returns null if the resolved path escapes the base directory.
 */
export function safePath(base: string, userPath: string, ext: string): string | null {
  const resolved = path.resolve(base, `${userPath}${ext}`);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null;
  }
  return resolved;
}

/**
 * Walk a directory of markdown node files, yielding each node's path and file path.
 */
export function* walkNodes(dir: string, prefix = ""): Generator<{ nodePath: string; filePath: string }> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      yield* walkNodes(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
    } else if (entry.name.endsWith(".md")) {
      const nodePath = prefix
        ? `${prefix}/${entry.name.replace(".md", "")}`
        : entry.name.replace(".md", "");
      yield { nodePath, filePath: path.join(dir, entry.name) };
    }
  }
}

/**
 * Count files with a given extension in a directory tree.
 */
export function countFiles(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name), ext);
    } else if (entry.name.endsWith(ext)) {
      count++;
    }
  }
  return count;
}

/**
 * Extract the first paragraph of markdown content (after removing heading).
 */
export function extractFirstParagraph(content: string): string {
  const cleaned = content.replace(/^#[^\n]+\n+/, "").trim();
  const para = cleaned.split("\n\n")[0];
  return para?.trim() || "";
}
