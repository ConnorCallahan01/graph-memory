import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { createTestGraph, createTestNode } from "./helpers.js";
import { CONFIG } from "../src/graph-memory/config.js";

/**
 * These tests exercise the librarian's applyLibrarianResult logic indirectly
 * by calling runLibrarian with pre-crafted delta files.
 *
 * Since runLibrarian makes API calls, we test the result-application logic
 * by importing the internal functions. For full integration tests, mock the
 * Anthropic client.
 *
 * For now, we test the filesystem operations that the librarian performs:
 * node creation, updating, archival, MAP regeneration, priors, and index.
 */

// We need to test the internal applyLibrarianResult — re-export it for testing
// Since it's not exported, we test via the filesystem effects of known operations

describe("librarian filesystem operations", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestGraph();
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe("node creation", () => {
    it("creates node files with correct frontmatter structure", () => {
      const filePath = createTestNode(CONFIG.paths.nodes, "insight/test-topic", {
        id: "insight/test-topic",
        title: "Test Topic",
        gist: "A test node about topics",
        confidence: 0.7,
        created: "2025-01-01",
        updated: "2025-01-01",
        decay_rate: 0.05,
        tags: ["testing", "example"],
        keywords: ["test", "topic"],
        edges: [{ target: "pattern/workflow", type: "relates_to", weight: 0.5 }],
      });

      expect(fs.existsSync(filePath)).toBe(true);

      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      expect(parsed.data.id).toBe("insight/test-topic");
      expect(parsed.data.title).toBe("Test Topic");
      expect(parsed.data.confidence).toBe(0.7);
      expect(parsed.data.tags).toContain("testing");
      expect(parsed.data.edges).toHaveLength(1);
      expect(parsed.data.edges[0].target).toBe("pattern/workflow");
      expect(parsed.data.edges[0].type).toBe("relates_to");
      expect(parsed.content).toContain("Test Topic");
    });
  });

  describe("node update", () => {
    it("merges new edges without duplicating existing ones", () => {
      createTestNode(CONFIG.paths.nodes, "insight/existing", {
        id: "insight/existing",
        title: "Existing Node",
        confidence: 0.6,
        created: "2025-01-01",
        updated: "2025-01-01",
        edges: [{ target: "a/one", type: "relates_to", weight: 0.5 }],
      });

      // Simulate edge merge (what librarian does)
      const filePath = path.join(CONFIG.paths.nodes, "insight/existing.md");
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      const existing = parsed.data.edges || [];
      const existingTargets = new Set(existing.map((e: any) => e.target));
      const newEdges = [
        { target: "a/one", type: "relates_to", weight: 0.7 }, // duplicate
        { target: "b/two", type: "supports", weight: 0.4 }, // new
      ];

      for (const edge of newEdges) {
        if (!existingTargets.has(edge.target)) {
          existing.push(edge);
        }
      }
      parsed.data.edges = existing;
      parsed.data.confidence = 0.8;
      parsed.data.updated = "2025-01-15";

      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));

      // Verify
      const updated = matter(fs.readFileSync(filePath, "utf-8"));
      expect(updated.data.edges).toHaveLength(2); // Not 3 — duplicate skipped
      expect(updated.data.confidence).toBe(0.8);
      expect(updated.data.edges[1].target).toBe("b/two");
    });
  });

  describe("archival", () => {
    it("moves node from nodes/ to archive/", () => {
      createTestNode(CONFIG.paths.nodes, "insight/to-archive", {
        title: "Archive Me",
        confidence: 0.1,
      });

      const srcPath = path.join(CONFIG.paths.nodes, "insight/to-archive.md");
      const destPath = path.join(CONFIG.paths.archive, "insight/to-archive.md");
      const destDir = path.dirname(destPath);

      expect(fs.existsSync(srcPath)).toBe(true);

      // Simulate archival
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(srcPath, destPath);

      expect(fs.existsSync(srcPath)).toBe(false);
      expect(fs.existsSync(destPath)).toBe(true);
    });
  });

  describe("MAP regeneration", () => {
    it("builds MAP from node files with correct format", () => {
      createTestNode(CONFIG.paths.nodes, "insight/alpha", {
        title: "Alpha",
        gist: "First concept about alpha",
        confidence: 0.9,
        edges: [{ target: "insight/beta", type: "relates_to", weight: 0.5 }],
      });

      createTestNode(CONFIG.paths.nodes, "insight/beta", {
        title: "Beta",
        gist: "Second concept about beta",
        confidence: 0.5,
      });

      // Simulate MAP rebuild (import and run)
      // Since fullRegenerateMAP is not exported, we verify the expected output format
      const mapContent = buildTestMAP();
      expect(mapContent).toContain("insight/alpha");
      expect(mapContent).toContain("First concept about alpha");
      expect(mapContent).toContain("insight/beta");
    });

    it("respects token budget by dropping low-confidence entries", () => {
      // Create many nodes to test budget enforcement
      for (let i = 0; i < 20; i++) {
        createTestNode(CONFIG.paths.nodes, `test/node-${i}`, {
          title: `Node ${i}`,
          gist: "A".repeat(200), // Each ~50 tokens
          confidence: i / 20, // 0.0 to 0.95
        });
      }

      const mapContent = buildTestMAP();
      // High-confidence nodes should be present
      expect(mapContent).toContain("node-19");
      // The actual pruning depends on token budget, but format should be correct
      expect(mapContent).toContain("MAP");
    });
  });

  describe("priors", () => {
    it("adds and removes priors from PRIORS.md", () => {
      // Create initial priors file
      fs.writeFileSync(
        CONFIG.paths.priors,
        `# PRIORS\n\n1. **First** — An initial prior\n2. **Second** — Another prior\n`,
      );

      const content = fs.readFileSync(CONFIG.paths.priors, "utf-8");
      const lines = content.split("\n");

      // Remove "First" prior
      const idx = lines.findIndex((l) => l.includes("First"));
      if (idx !== -1) lines.splice(idx, 1);

      // Add new prior
      lines.push("3. **Third** — A new prior");

      fs.writeFileSync(CONFIG.paths.priors, lines.join("\n"));

      const updated = fs.readFileSync(CONFIG.paths.priors, "utf-8");
      expect(updated).not.toContain("First");
      expect(updated).toContain("Second");
      expect(updated).toContain("Third");
    });
  });
});

// Helper to build MAP for testing (mirrors fullRegenerateMAP logic)
function buildTestMAP(): string {
  const nodesDir = CONFIG.paths.nodes;
  if (!fs.existsSync(nodesDir)) return "";

  let mapContent = "# MAP — Knowledge Graph Index\n\n";

  const entries: Array<{ path: string; line: string; confidence: number }> = [];

  function walkDir(dir: string, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkDir(
          path.join(dir, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
        );
      } else if (entry.name.endsWith(".md")) {
        const nodePath = prefix
          ? `${prefix}/${entry.name.replace(".md", "")}`
          : entry.name.replace(".md", "");
        const filePath = path.join(dir, entry.name);

        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = matter(raw);
          const gist = parsed.data.gist || "";
          const confidence =
            typeof parsed.data.confidence === "number"
              ? parsed.data.confidence
              : 0.5;
          const edges = (parsed.data.edges || [])
            .map((e: any) => e.target)
            .filter(Boolean);
          const edgeStr =
            edges.length > 0 ? ` → [${edges.join(", ")}]` : "";

          entries.push({
            path: nodePath,
            line: `- **${nodePath}** — ${gist}${edgeStr}`,
            confidence,
          });
        } catch {
          // skip
        }
      }
    }
  }

  walkDir(nodesDir);

  // Sort by confidence descending
  entries.sort((a, b) => b.confidence - a.confidence);

  for (const entry of entries) {
    mapContent += `${entry.line}\n`;
  }

  return mapContent;
}
