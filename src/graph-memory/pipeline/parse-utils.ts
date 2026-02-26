/**
 * Robustly extract JSON from LLM output.
 * Handles: raw JSON, markdown code fences, preamble text before JSON,
 * and text after the closing brace.
 */
export function extractJSON<T>(raw: string): T {
  const text = raw.trim();

  // 1. Try direct parse first (cleanest case)
  try {
    return JSON.parse(text);
  } catch {
    // continue to more lenient strategies
  }

  // 2. Extract from markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // 3. Find first { and last matching } — handles preamble and postamble text
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }
  }

  throw new Error(`Could not extract JSON from response (length=${text.length}): ${text.slice(0, 200)}`);
}
