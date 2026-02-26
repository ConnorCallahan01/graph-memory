import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { extractJSON } from "./parse-utils.js";

const DREAMER_PROMPT = fs.readFileSync(
  path.join(CONFIG.paths.projectRoot, "src/graph-memory/prompts/dreamer.md"),
  "utf-8"
);

interface DreamFragment {
  fragment: string;
  confidence: number;
  nodes_referenced: string[];
  type: "connection" | "inversion" | "analogy" | "emergence" | "integration";
}

interface DreamerResult {
  dreams: DreamFragment[];
  promotions: Array<{
    dream_file: string;
    reason: string;
    new_confidence: number;
  }>;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

function loadPendingDreams(): Array<{ file: string; content: any }> {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (!fs.existsSync(pendingDir)) return [];

  return fs.readdirSync(pendingDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      content: JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf-8")),
    }));
}

function buildDreamerInput(sessionId: string): string | null {
  let map = "_Empty graph._";
  if (fs.existsSync(CONFIG.paths.map)) {
    map = fs.readFileSync(CONFIG.paths.map, "utf-8");
  }

  // Load session deltas
  const deltaFile = path.join(CONFIG.paths.deltas, `${sessionId}.json`);
  let deltas = "No deltas.";
  if (fs.existsSync(deltaFile)) {
    const data = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
    const allDeltas = data.scribes.flatMap((s: any) => s.deltas || []);
    if (allDeltas.length === 0) return null;
    deltas = JSON.stringify(allDeltas, null, 2);
  } else {
    return null;
  }

  // Load pending dreams
  const pending = loadPendingDreams();
  const pendingStr = pending.length > 0
    ? pending.map((p) => `### ${p.file}\n${JSON.stringify(p.content, null, 2)}`).join("\n\n")
    : "No pending dreams.";

  return `## Current MAP\n\n${map}\n\n## Recent Session Deltas\n\n${deltas}\n\n## Pending Dreams (${pending.length})\n\n${pendingStr}`;
}

export async function runDreamer(sessionId: string): Promise<void> {
  activityBus.log("dreamer:start", `Dreamer starting for ${sessionId}`);
  const startTime = Date.now();

  const input = buildDreamerInput(sessionId);
  if (!input) {
    activityBus.log("dreamer:complete", "Dreamer skipped — no deltas to dream on.");
    return;
  }

  try {
    const response = await getClient().messages.create({
      model: CONFIG.models.dreamer,
      max_tokens: CONFIG.maxTokens.dreamer,
      temperature: CONFIG.temperature.dreamer, // 1.0 — maximum divergence
      system: DREAMER_PROMPT,
      messages: [
        { role: "user", content: input },
        { role: "assistant", content: "{" },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from dreamer");
    }

    const result: DreamerResult = extractJSON<DreamerResult>("{" + textBlock.text);
    const elapsed = Date.now() - startTime;

    applyDreamerResult(result, sessionId);

    activityBus.log("dreamer:complete", `Dreamer complete in ${elapsed}ms — ${result.dreams.length} fragments, ${result.promotions.length} promotions`, {
      elapsed,
      fragments: result.dreams.length,
      promotions: result.promotions.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    activityBus.log("dreamer:error", `Dreamer failed after ${elapsed}ms: ${err.message}. Retrying...`, {
      error: err.message,
    });

    // Retry once (following scribe.ts pattern)
    try {
      await new Promise((r) => setTimeout(r, 2000));

      const response = await getClient().messages.create({
        model: CONFIG.models.dreamer,
        max_tokens: CONFIG.maxTokens.dreamer,
        temperature: CONFIG.temperature.dreamer,
        system: DREAMER_PROMPT,
        messages: [
          { role: "user", content: input },
          { role: "assistant", content: "{" },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") throw new Error("No text in retry");

      const result: DreamerResult = extractJSON<DreamerResult>("{" + textBlock.text);
      applyDreamerResult(result, sessionId);

      activityBus.log("dreamer:complete", `Dreamer retry succeeded — ${result.dreams.length} fragments, ${result.promotions.length} promotions`);
    } catch (retryErr: any) {
      activityBus.log("dreamer:error", `Dreamer retry failed: ${retryErr.message}. Deltas preserved for next session.`);
    }
  }
}

/** Apply dreamer results: save new fragments, process promotions, archive stale dreams */
function applyDreamerResult(result: DreamerResult, sessionId: string) {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });

  for (const dream of result.dreams) {
    const dreamFile = `dream_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
    fs.writeFileSync(
      path.join(pendingDir, dreamFile),
      JSON.stringify({ ...dream, session: sessionId, created: new Date().toISOString() }, null, 2)
    );

    activityBus.log("dreamer:complete", `Dream fragment: "${dream.fragment.slice(0, 80)}..." (${dream.type}, confidence: ${dream.confidence})`, {
      type: dream.type,
      confidence: dream.confidence,
      nodesReferenced: dream.nodes_referenced,
    });
  }

  // Process promotions
  for (const promo of result.promotions) {
    const srcPath = path.join(pendingDir, promo.dream_file);
    if (!fs.existsSync(srcPath)) continue;

    const dreamData = JSON.parse(fs.readFileSync(srcPath, "utf-8"));

    if (promo.new_confidence >= CONFIG.graph.dreamPromoteConfidence) {
      const integratedDir = path.join(CONFIG.paths.dreams, "integrated");
      if (!fs.existsSync(integratedDir)) fs.mkdirSync(integratedDir, { recursive: true });

      dreamData.promoted_at = new Date().toISOString();
      dreamData.confidence = promo.new_confidence;
      dreamData.promotion_reason = promo.reason;

      fs.writeFileSync(path.join(integratedDir, promo.dream_file), JSON.stringify(dreamData, null, 2));
      fs.unlinkSync(srcPath);

      activityBus.log("dreamer:complete", `Dream promoted: ${promo.dream_file} (confidence → ${promo.new_confidence})`, {
        dreamFile: promo.dream_file,
        newConfidence: promo.new_confidence,
      });
    } else {
      dreamData.confidence = promo.new_confidence;
      fs.writeFileSync(srcPath, JSON.stringify(dreamData, null, 2));
    }
  }

  archiveStaleDreams();
}

/**
 * Archive pending dreams that are older than dreamPendingMaxSessions
 * and still below dreamMinConfidence.
 */
function archiveStaleDreams() {
  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  if (!fs.existsSync(pendingDir)) return;

  const archivedDir = path.join(CONFIG.paths.dreams, "archived");
  const maxAge = CONFIG.graph.dreamPendingMaxSessions; // ~5 sessions
  const minConfidence = CONFIG.graph.dreamMinConfidence;

  // Approximate: use creation date, consider each day ~1 session
  const cutoffMs = maxAge * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const file of fs.readdirSync(pendingDir).filter(f => f.endsWith(".json"))) {
    try {
      const filePath = path.join(pendingDir, file);
      const dream = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const createdAt = dream.created ? new Date(dream.created).getTime() : 0;
      const age = now - createdAt;

      if (age > cutoffMs && (dream.confidence || 0) < minConfidence) {
        if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
        dream.archived_reason = "stale";
        dream.archived_date = new Date().toISOString();
        fs.writeFileSync(path.join(archivedDir, file), JSON.stringify(dream, null, 2));
        fs.unlinkSync(filePath);

        activityBus.log("dreamer:complete", `Archived stale dream: ${file} (confidence: ${dream.confidence}, age: ${Math.round(age / 86400000)}d)`, {
          dreamFile: file,
          confidence: dream.confidence,
        });
      }
    } catch {
      // Skip unparseable dreams
    }
  }
}
