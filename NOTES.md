# Remaining Gaps: Spec vs. Implementation

Audit date: 2026-02-26. Compared `memory_implementation` spec (7 tabs) against `src/graph-memory/`.

Three critical gaps (MAP budget, access tracking, recovery) have been fixed. Everything below is what remains.

---

## Medium Priority

### Session Lifecycle

- **Short session skip** — Sessions with < 3 messages should skip librarian/dreamer to save API costs. Currently every session triggers the full pipeline regardless of message count.
- **Rapid session debouncing** — Spec says defer consolidation if last pipeline ran < 10 min ago. No debouncing exists; rapid reconnects cause rapid-fire librarian calls.
- **Pipeline cancellation** — If user returns mid-pipeline, spec says cancel or background it. No mechanism exists.
- **Natural language session-end detection** — Spec says detect "done" / "thanks" / "that's it" as session boundaries. Only idle timeout triggers session end.
- **Process exit handler** — No `SIGINT`/`SIGTERM` handler to flush scribes and run consolidation on shutdown. If server is killed, pending work is lost.

### Git

- **Structured commit messages** — Partially fixed. Spec describes rich multi-line commits with session numbering (e.g., `memory: session 47 — 3 updates, 1 new node`). Current implementation categorizes changes (New/Updated/Archived/Meta) but doesn't track session numbers.

### Somatic Markers

- **Soma not surfaced in MAP** — Soma markers are stored in node frontmatter but spec says they should appear in MAP entries. Partially fixed (added `somaStr` to MAP lines) but no soma-based search ranking or behavioral influence on the agent.
- **No `soma.ts` module** — Spec describes a standalone somatic marker manager. Currently handled inline.

### Graph Health

- **No graph health monitoring warnings** — The `status` tool returns basic counts but doesn't warn when MAP approaches token budget or node count nears prune limit. No proactive alerting.

### Tests

- **No test files** — Spec describes `tests/scribe.test.ts`, `tests/librarian.test.ts`, `tests/decay.test.ts`. None exist.

---

## Low Priority

### Structural / Naming

- Module organization differs from spec layout (no `session/`, `graph/`, `git/` directory hierarchy; functionality is all under `graph-memory/`)
- No standalone `store.ts`, `traversal.ts`, `branch-manager.ts` modules
- No `agent-prefix.md` prompt template (system prompt hardcoded in `index.ts`)
- Class named `BufferWatcher` not `MessageBuffer` per spec

### Minor Behavioral

- Idle timeout is 1 minute (comment says "5 min in production") vs spec's 5 minutes
- Buffer is disk-based not in-memory (arguably more robust, but differs from spec)
- Scribe `max_tokens: 4096` vs spec's `1000`
- `status` action exists (spec doesn't mention it — this is an enhancement)
- No `match_reason` field in search results (spec says explain why each result matched)
- Index loaded from disk on every search (spec says cache in memory after first load)
- Delta file missing `ended_at` and `message_count` session-level metadata
- Dreamer has no retry-once logic (scribe and librarian do)
- Edge types not validated against spec's enum (`relates_to`, `contradicts`, `supports`, `derives_from`, `pattern_transfer`)
- `manifest.yml` not created at init (only on first session end)

---

## What's Working Well

- Core pipeline: scribe → librarian → dreamer → graph
- Gray-matter frontmatter parsing throughout
- Decay system with half-life formula + auto-archive
- MAP token budget enforcement (prunes lowest-confidence entries)
- `maxNodesBeforePrune` enforcement (auto-archives excess nodes)
- `maxPriors` enforcement (trims oldest priors)
- Access tracking persisted in node frontmatter (survives index rebuilds)
- Recovery tooling: `npm run revert`, `history`/`revert` tool actions
- Dream types (all 5 specified), promotion/archival lifecycle
- Path traversal protection via `safePath()`
- Delta write serialization (no concurrent clobbering)
- Standalone MCP server for Claude Code / Cursor
- Git auto-commit with structured messages
- Prefill `{` trick on all LLM calls
- Per-step error handling in librarian
- Mid-session refresh at 200 messages
