import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { createTestGraph, createTestNode } from "./helpers.js";
import { CONFIG } from "../src/graph-memory/config.js";
import { runDecay } from "../src/graph-memory/pipeline/decay.js";

describe("decay system", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestGraph();
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("halves confidence at half-life (30 days)", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    createTestNode(CONFIG.paths.nodes, "test/old-node", {
      title: "Old Node",
      confidence: 0.8,
      decay_rate: 0.05,
      created: thirtyDaysAgo,
      updated: thirtyDaysAgo,
    });

    const result = runDecay();
    expect(result.decayed).toBe(1);

    const raw = fs.readFileSync(
      path.join(CONFIG.paths.nodes, "test/old-node.md"),
      "utf-8",
    );
    const parsed = matter(raw);
    // At exactly half-life with default decay_rate, confidence should be ~0.4
    expect(parsed.data.confidence).toBeCloseTo(0.4, 1);
  });

  it("archives nodes below threshold", () => {
    const longAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    createTestNode(CONFIG.paths.nodes, "test/weak-node", {
      title: "Weak Node",
      confidence: 0.2,
      decay_rate: 0.05,
      created: longAgo,
      updated: longAgo,
    });

    const result = runDecay();
    expect(result.archived).toBe(1);

    // Should be moved to archive
    expect(
      fs.existsSync(path.join(CONFIG.paths.nodes, "test/weak-node.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(CONFIG.paths.archive, "test/weak-node.md")),
    ).toBe(true);
  });

  it("resets timestamp for reinforced nodes", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    createTestNode(CONFIG.paths.nodes, "test/reinforced", {
      title: "Reinforced Node",
      confidence: 0.7,
      decay_rate: 0.05,
      created: tenDaysAgo,
      updated: tenDaysAgo,
    });

    const reinforced = new Set(["test/reinforced"]);
    const result = runDecay(reinforced);

    // Not counted as decayed
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);

    // Updated timestamp should be today
    const raw = fs.readFileSync(
      path.join(CONFIG.paths.nodes, "test/reinforced.md"),
      "utf-8",
    );
    const parsed = matter(raw);
    const today = new Date().toISOString().slice(0, 10);
    expect(parsed.data.updated).toBe(today);
    // Confidence unchanged
    expect(parsed.data.confidence).toBe(0.7);
  });

  it("does not decay within 24h", () => {
    const today = new Date().toISOString().slice(0, 10);

    createTestNode(CONFIG.paths.nodes, "test/fresh", {
      title: "Fresh Node",
      confidence: 0.9,
      decay_rate: 0.05,
      created: today,
      updated: today,
    });

    const result = runDecay();
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);

    const raw = fs.readFileSync(
      path.join(CONFIG.paths.nodes, "test/fresh.md"),
      "utf-8",
    );
    const parsed = matter(raw);
    expect(parsed.data.confidence).toBe(0.9);
  });
});
