/**
 * YAML frontmatter repair for malformed node files.
 *
 * Handles real-world malformation patterns found in the live graph:
 * 1. Unquoted colons in title/gist values
 * 2. Duplicated mapping keys (dream_refs, soma, keywords, tags)
 * 3. Extra trailing quotes on date values ('2026-05-10'')
 * 4. Missing opening quote on date values (2026-05-09')
 * 5. Bad indentation (leading space on top-level keys like soma)
 */
import matter from "gray-matter";

export interface RepairResult {
  repaired: string;
  fixes: string[];
}

const STRING_KEYS_WITH_COLONS = new Set([
  "title", "gist", "marker",
]);

const DATE_KEYS = new Set([
  "created", "updated", "last_decay_at", "last_accessed",
]);

export function repairYamlFrontmatter(raw: string): RepairResult {
  const fixes: string[] = [];

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return { repaired: raw, fixes };

  const frontmatter = fmMatch[1];
  const body = raw.slice(fmMatch[0].length);
  let fm = frontmatter;

  // Fix 1: Extra trailing quotes on date values: '2026-05-10'' → '2026-05-10'
  fm = fm.replace(
    new RegExp(`(${[...DATE_KEYS].join("|")}):\\s*'([^']*)''+`, "g"),
    (_match, key: string, val: string) => {
      fixes.push(`extra-trailing-quote on ${key}`);
      return `${key}: '${val}'`;
    },
  );

  // Fix 2: Missing opening quote on date values: 2026-05-09' → '2026-05-09'
  fm = fm.replace(
    new RegExp(`(${[...DATE_KEYS].join("|")}):\\s*([^'"\\s][^\\n']*?)'\\s*$`, "gm"),
    (_match, key: string, val: string) => {
      fixes.push(`missing-opening-quote on ${key}`);
      return `${key}: '${val}'`;
    },
  );

  // Fix 3: Bad indentation — top-level keys with exactly 1 leading space
  // e.g. " soma:" should be "soma:" — but only when the key line itself has
  // exactly 1-space indent (not part of a value block like edges: list items)
  fm = fixBadIndentation(fm, fixes);

  // Fix 4: Unquoted colons in string values for known keys (title, gist, marker)
  fm = fixUnquotedColons(fm, fixes);

  // Fix 5: Unquoted problem values in YAML flow sequences ([...])
  fm = fixFlowSequences(fm, fixes);

  // Fix 6: Duplicated keys — remove earlier occurrences, keep last
  fm = fixDuplicatedKeys(fm, fixes);

  const repaired = `---\n${fm}\n---${body}`;
  return { repaired, fixes };
}

function fixBadIndentation(fm: string, fixes: string[]): string {
  const lines = fm.split("\n");
  const fixed: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for exactly 1-space indented top-level key: " key:"
    const singleSpaceKey = line.match(/^ ([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!singleSpaceKey) {
      fixed.push(line);
      continue;
    }

    const key = singleSpaceKey[1];
    const prevLine = i > 0 ? lines[i - 1] : "";
    const prevTrimmed = prevLine.trimStart();

    // If previous line is a list item ("- ...") or block scalar indicator (| or >),
    // this is legitimately indented content — keep it
    if (prevTrimmed.startsWith("- ") || prevTrimmed.endsWith("|") || prevTrimmed.endsWith(">")) {
      fixed.push(line);
      continue;
    }

    // If previous line is also a top-level key, the 1-space indent is a mistake
    const prevIsKey = prevTrimmed.match(/^[a-zA-Z_][a-zA-Z0-9_-]*:/);
    if (prevIsKey || prevTrimmed === "") {
      fixes.push(`bad-indentation on key ${key}`);
      // Dedent this key to column 0
      fixed.push(line.trimStart());
      // Keep subsequent indented lines as-is — they were indented
      // relative to the correct parent position, not the 1-space error
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const nextTrimmed = nextLine.trimStart();
        if (nextTrimmed === "") break;
        const nextIndent = nextLine.length - nextTrimmed.length;
        if (nextIndent >= 1) {
          fixed.push(nextLine);
          i++;
        } else {
          break;
        }
      }
      continue;
    }

    fixed.push(line);
  }

  return fixed.join("\n");
}

function fixUnquotedColons(fm: string, fixes: string[]): string {
  const lines = fm.split("\n");
  const fixed: string[] = [];

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!keyMatch) {
      fixed.push(line);
      continue;
    }

    const key = keyMatch[1];
    const value = keyMatch[2];

    // Skip already-quoted, block scalars, arrays, objects
    if (
      value.startsWith("'") || value.startsWith('"') ||
      value.startsWith("|") || value.startsWith(">") ||
      value.startsWith("[") || value.startsWith("{")
    ) {
      fixed.push(line);
      continue;
    }

    if (STRING_KEYS_WITH_COLONS.has(key) && value.includes(":")) {
      fixes.push(`unquoted-colon in ${key}`);
      const escaped = value.replace(/'/g, "''");
      fixed.push(`${key}: '${escaped}'`);
      continue;
    }

    fixed.push(line);
  }

  return fixed.join("\n");
}

function fixFlowSequences(fm: string, fixes: string[]): string {
  // Fix YAML flow sequences (e.g., keywords: [...]) where values contain
  // unquoted colons or @ symbols that break the parser
  return fm.replace(
    /^(\s*[a-zA-Z_][a-zA-Z0-9_-]*:\s*)\[([^\]]+)\]/gm,
    (_match, prefix: string, inner: string) => {
      const items = inner.split(",").map((item: string) => {
        const trimmed = item.trim();
        // Skip already-quoted items
        if (trimmed.startsWith("'") || trimmed.startsWith('"')) return item;
        // Quote items containing colons or @
        if (trimmed.includes(":") || trimmed.includes("@")) {
          fixes.push(`flow-sequence-value quoted: ${trimmed.slice(0, 30)}`);
          return ` '${trimmed.replace(/'/g, "''")}'`;
        }
        return item;
      });
      return `${prefix}[${items.join(",")}]`;
    },
  );
}

function fixDuplicatedKeys(fm: string, fixes: string[]): string {
  const lines = fm.split("\n");

  // Find all top-level key positions
  const keyPositions = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
    if (match) {
      const key = match[1];
      const positions = keyPositions.get(key) || [];
      positions.push(i);
      keyPositions.set(key, positions);
    }
  }

  // Find duplicates
  const duplicates = [...keyPositions.entries()].filter(([_, positions]) => positions.length > 1);
  if (duplicates.length === 0) return fm;

  // Build set of line indices to remove (earlier occurrences + their value blocks)
  const removeIndices = new Set<number>();

  for (const [key, positions] of duplicates) {
    // Keep the LAST occurrence, remove earlier ones
    for (let p = 0; p < positions.length - 1; p++) {
      const keyLineIdx = positions[p];
      removeIndices.add(keyLineIdx);

      // Also remove the value block belonging to the earlier key
      // (indented lines following the key)
      let j = keyLineIdx + 1;
      while (j < lines.length) {
        const nextTrimmed = lines[j].trimStart();
        if (nextTrimmed === "") break;
        const nextIndent = lines[j].length - nextTrimmed.length;
        if (nextIndent >= 2 || nextTrimmed.startsWith("- ")) {
          // Check this line isn't part of the LAST occurrence's block
          // by ensuring it comes before the last key position
          if (j < positions[positions.length - 1]) {
            removeIndices.add(j);
          }
          j++;
        } else {
          break;
        }
      }
    }

    fixes.push(`duplicate-key ${key}: kept last of ${positions.length} occurrences`);
  }

  // Filter out removed lines
  const kept = lines.filter((_, i) => !removeIndices.has(i));

  // Clean up: remove trailing blank lines before the kept duplicate's value block
  // that were left behind
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function tryParseWithRepair(raw: string): { data: Record<string, any>; content: string } | null {
  try {
    const parsed = matter(raw);
    return { data: parsed.data as Record<string, any>, content: parsed.content };
  } catch {
    // first attempt failed, try repair
  }

  const { repaired, fixes } = repairYamlFrontmatter(raw);
  if (fixes.length === 0) return null;

  try {
    const parsed = matter(repaired);
    return { data: parsed.data as Record<string, any>, content: parsed.content };
  } catch {
    return null;
  }
}
