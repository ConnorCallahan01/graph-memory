import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTestGraph } from "./helpers.js";
import { CONFIG } from "../src/graph-memory/config.js";
import { saveScribeResult, type ScribeResult } from "../src/graph-memory/pipeline/scribe.js";

describe("scribe", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestGraph();
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe("saveScribeResult", () => {
    it("creates delta file with correct structure", async () => {
      const result: ScribeResult = {
        summary: "User discussed debugging strategies",
        deltas: [
          { type: "create", path: "insight/debugging", title: "Debugging tips" },
          { type: "update", path: "pattern/workflow", confidence: 0.8 },
        ],
      };

      await saveScribeResult({
        sessionId: "session_test1",
        scribeId: "S01",
        fragmentRange: [1, 5],
        result,
      });

      const deltaFile = path.join(
        CONFIG.paths.deltas,
        "session_test1.json",
      );
      expect(fs.existsSync(deltaFile)).toBe(true);

      const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
      expect(data.session_id).toBe("session_test1");
      expect(data.started_at).toBeDefined();
      expect(data.scribes).toHaveLength(1);
      expect(data.scribes[0].scribe_id).toBe("S01");
      expect(data.scribes[0].fragment_range).toEqual([1, 5]);
      expect(data.scribes[0].summary).toBe(
        "User discussed debugging strategies",
      );
      expect(data.scribes[0].deltas).toHaveLength(2);
      expect(data.scribes[0].completed_at).toBeDefined();
    });

    it("serializes concurrent saves correctly", async () => {
      const result1: ScribeResult = {
        summary: "First fragment",
        deltas: [{ type: "create", path: "a/one" }],
      };
      const result2: ScribeResult = {
        summary: "Second fragment",
        deltas: [{ type: "create", path: "b/two" }],
      };

      // Fire both saves concurrently
      const p1 = saveScribeResult({
        sessionId: "session_concurrent",
        scribeId: "S01",
        fragmentRange: [1, 5],
        result: result1,
      });
      const p2 = saveScribeResult({
        sessionId: "session_concurrent",
        scribeId: "S02",
        fragmentRange: [6, 10],
        result: result2,
      });

      await Promise.all([p1, p2]);

      const deltaFile = path.join(
        CONFIG.paths.deltas,
        "session_concurrent.json",
      );
      const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));

      // Both scribes should be present (serialization lock prevents clobbering)
      expect(data.scribes).toHaveLength(2);
      expect(data.scribes[0].scribe_id).toBe("S01");
      expect(data.scribes[1].scribe_id).toBe("S02");
    });

    it("appends to existing delta file", async () => {
      // Save first result
      await saveScribeResult({
        sessionId: "session_append",
        scribeId: "S01",
        fragmentRange: [1, 5],
        result: { summary: "First", deltas: [] },
      });

      // Save second result
      await saveScribeResult({
        sessionId: "session_append",
        scribeId: "S02",
        fragmentRange: [6, 10],
        result: { summary: "Second", deltas: [{ type: "create", path: "x" }] },
      });

      const deltaFile = path.join(
        CONFIG.paths.deltas,
        "session_append.json",
      );
      const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));

      expect(data.scribes).toHaveLength(2);
      expect(data.scribes[1].deltas).toHaveLength(1);
    });
  });
});
