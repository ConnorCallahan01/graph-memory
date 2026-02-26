import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { activityBus } from "../events.js";
import { extractJSON } from "./parse-utils.js";

const SCRIBE_PROMPT = fs.readFileSync(
  path.join(CONFIG.paths.projectRoot, "src/graph-memory/prompts/scribe.md"),
  "utf-8"
);

export interface ScribeDelta {
  type: string;
  path?: string;
  [key: string]: unknown;
}

export interface ScribeResult {
  summary: string;
  deltas: ScribeDelta[];
}

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

function buildScribeInput(params: {
  map: string;
  summaryChain: string[];
  fragment: string;
}): string {
  const { map, summaryChain, fragment } = params;

  let input = `## Current MAP\n\n${map}\n\n`;

  if (summaryChain.length > 0) {
    input += `## Previous Summaries (narrative continuity)\n\n`;
    summaryChain.forEach((s, i) => {
      input += `${i + 1}. ${s}\n`;
    });
    input += "\n";
  }

  input += `## Message Fragment to Process\n\n${fragment}`;

  return input;
}

export async function fireScribe(params: {
  fragment: string;
  map: string;
  summaryChain: string[];
  sessionId: string;
  scribeId: string;
  fragmentRange: [number, number];
}): Promise<ScribeResult> {
  const { fragment, map, summaryChain, sessionId, scribeId, fragmentRange } = params;

  activityBus.log("scribe:fired", `Scribe ${scribeId} fired (messages ${fragmentRange[0]}-${fragmentRange[1]})`, {
    scribeId,
    sessionId,
    fragmentRange,
  });

  const startTime = Date.now();

  try {
    const client = getClient();
    const userContent = buildScribeInput({ map, summaryChain, fragment });

    const response = await client.messages.create({
      model: CONFIG.models.scribe,
      max_tokens: CONFIG.maxTokens.scribe,
      temperature: CONFIG.temperature.scribe,
      system: SCRIBE_PROMPT,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: "{" }, // prefill forces JSON mode
      ],
    });

    const elapsed = Date.now() - startTime;

    // Extract text response — prepend the "{" prefill back
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from scribe");
    }
    const rawText = "{" + textBlock.text;

    // Check for truncation (stop_reason !== "end_turn" means token limit hit)
    if (response.stop_reason !== "end_turn") {
      activityBus.log("scribe:error", `Scribe ${scribeId} response truncated (stop_reason: ${response.stop_reason}). Tokens: ${response.usage?.output_tokens}`, {
        scribeId,
        stopReason: response.stop_reason,
      });
    }

    // Parse JSON response
    let result: ScribeResult;
    try {
      result = extractJSON<ScribeResult>(rawText);
    } catch (parseErr) {
      activityBus.log("scribe:error", `Scribe ${scribeId} JSON extraction failed. Raw (first 500 chars):\n${rawText.slice(0, 500)}`, {
        scribeId,
        error: String(parseErr),
        rawLength: rawText.length,
        stopReason: response.stop_reason,
      });
      result = { summary: "Scribe parse error", deltas: [] };
    }

    activityBus.log("scribe:complete", `Scribe ${scribeId} complete in ${elapsed}ms — ${result.deltas.length} deltas extracted`, {
      scribeId,
      elapsed,
      deltaCount: result.deltas.length,
      deltaTypes: result.deltas.map((d) => d.type),
      summary: result.summary,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return result;
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    activityBus.log("scribe:error", `Scribe ${scribeId} failed after ${elapsed}ms: ${err.message}`, {
      scribeId,
      error: err.message,
    });

    // Retry once
    try {
      activityBus.log("scribe:fired", `Scribe ${scribeId} retrying...`, { scribeId, retry: true });
      await new Promise((r) => setTimeout(r, 2000));

      const client = getClient();
      const userContent = buildScribeInput({ map, summaryChain, fragment });

      const response = await client.messages.create({
        model: CONFIG.models.scribe,
        max_tokens: CONFIG.maxTokens.scribe,
        temperature: CONFIG.temperature.scribe,
        system: SCRIBE_PROMPT,
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: "{" },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from scribe retry");
      }

      const result: ScribeResult = extractJSON<ScribeResult>("{" + textBlock.text);

      activityBus.log("scribe:complete", `Scribe ${scribeId} retry succeeded — ${result.deltas.length} deltas`, {
        scribeId,
        retry: true,
        deltaCount: result.deltas.length,
      });

      return result;
    } catch (retryErr: any) {
      activityBus.log("scribe:error", `Scribe ${scribeId} retry also failed: ${retryErr.message}. Skipping.`, {
        scribeId,
        error: retryErr.message,
      });
      return { summary: "Scribe failed (both attempts)", deltas: [] };
    }
  }
}

/** Serialize delta file writes to prevent concurrent scribes from clobbering each other */
let deltaWriteLock = Promise.resolve();

/** Save scribe results to the session delta file */
export function saveScribeResult(params: {
  sessionId: string;
  scribeId: string;
  fragmentRange: [number, number];
  result: ScribeResult;
}) {
  deltaWriteLock = deltaWriteLock.then(() => saveScribeResultImpl(params));
  return deltaWriteLock;
}

function saveScribeResultImpl(params: {
  sessionId: string;
  scribeId: string;
  fragmentRange: [number, number];
  result: ScribeResult;
}) {
  const { sessionId, scribeId, fragmentRange, result } = params;
  const deltaDir = CONFIG.paths.deltas;

  if (!fs.existsSync(deltaDir)) {
    fs.mkdirSync(deltaDir, { recursive: true });
  }

  const deltaFile = path.join(deltaDir, `${sessionId}.json`);

  let sessionData: any;
  if (fs.existsSync(deltaFile)) {
    sessionData = JSON.parse(fs.readFileSync(deltaFile, "utf-8"));
  } else {
    sessionData = {
      session_id: sessionId,
      started_at: new Date().toISOString(),
      scribes: [],
    };
  }

  sessionData.scribes.push({
    scribe_id: scribeId,
    fragment_range: fragmentRange,
    completed_at: new Date().toISOString(),
    summary: result.summary,
    deltas: result.deltas,
  });

  fs.writeFileSync(deltaFile, JSON.stringify(sessionData, null, 2));
}
