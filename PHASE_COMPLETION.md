# Graph Memory — Phase Completion Log

> Detailed record of what was built, files created/modified, and decisions made.
> Use this to trace back bugs or understand why something was done a certain way.

---

## Phase 1: Skeleton + Visibility

**Goal**: Chat with agent, see messages flowing through buffer, watch events in activity panel. No actual memory yet — just plumbing.

**Status**: COMPLETE

### Architecture Decisions

1. **Single package, not monorepo**: Kept `graph-memory/` as a module within the project rather than a separate npm package. Can be extracted later for standalone MCP server mode.
2. **Agent SDK with in-process MCP server**: Using `createSdkMcpServer()` + `tool()` from the Agent SDK for the graph_memory tool. Portable — same tool logic can power a standalone stdio MCP server later.
3. **Conversation tap via JSONL file**: Host appends to `graph/.buffer/conversation.jsonl`. Buffer watcher counts messages, rotates to timestamped snapshots at threshold (5 messages). Universal interface — any host can append JSONL.
4. **Resume-based multi-turn**: Each user message creates a new `query()` call that resumes the previous session via `sessionId`. Cleaner than streaming input for a chat app.
5. **WebSocket for real-time**: Activity events + streamed agent responses both flow over WebSocket. Single connection per client.
6. **Zod v4 required**: Agent SDK peer-depends on zod ^4.0.0 (not v3).

### Files Created

| File | Purpose |
|------|---------|
| `package.json` | Project config, dependencies, scripts |
| `tsconfig.json` | TypeScript config (ESM, strict) |
| `.env.example` | Template for API key |
| `.env` | Actual env file (needs API key) |
| `src/graph-memory/config.ts` | All configuration constants (models, thresholds, paths) |
| `src/graph-memory/events.ts` | ActivityBus singleton — typed event emitter for all system events |
| `src/graph-memory/buffer-watcher.ts` | BufferWatcher class — JSONL append, message counting, rotation, idle detection |
| `src/graph-memory/tools.ts` | graph_memory tool handler + zod schema (read_node, search, list_edges, read_dream, write_note, status) |
| `src/graph-memory/index.ts` | MCP server creation, graph initialization, system prompt builder |
| `src/server.ts` | Express + WebSocket + Agent SDK — main server entry point |
| `public/index.html` | Split-pane UI (chat left, activity log right) with dark theme |

### Directories Created

```
graph/
  .buffer/          # Conversation JSONL + rotated snapshots
  .deltas/          # Scribe delta files (Phase 3)
  nodes/            # Knowledge graph nodes
    _meta/
    insight/
    pattern/
  archive/          # Decayed nodes
  dreams/
    pending/
    integrated/
    archived/
```

### Bug Fixes

1. **Activity event type collision**: `broadcast({ type: "activity", ...event })` would overwrite `type` with the event's own type. Fixed by sending `event_type` as a separate field.

### How to Run

```bash
# Add API key to .env
echo "ANTHROPIC_API_KEY=sk-..." > .env

# Start server
npm run dev

# Open http://localhost:3000
```

---

## Phase 2: Static Graph + Retrieval

**Goal**: Seed the graph with initial nodes, populate MAP and PRIORS, verify all 3 retrieval pathways work.

**Status**: COMPLETE

### Files Created

| File | Purpose |
|------|---------|
| `graph/PRIORS.md` | 5 starter behavioral priors |
| `graph/MAP.md` | Index with 5 seed nodes, gists, and edge references |
| `graph/.index.json` | Search index with gists, tags, keywords, edges, confidence |
| `graph/nodes/_meta/system_overview.md` | System architecture overview node |
| `graph/nodes/_meta/design_principles.md` | Seven design principles node |
| `graph/nodes/pattern/session_lifecycle.md` | Session lifecycle pattern node |
| `graph/nodes/pattern/scribe_pipeline.md` | Scribe pipeline pattern node |
| `graph/nodes/insight/memory_architecture.md` | Why the architecture works — three divergences |

### Verified

- `read_node` — reads node by path (O(1) filesystem lookup)
- `search` — keyword overlap scoring with 3x gist, 2x tags, 1x keywords. Returns ranked results.
- `list_edges` — extracts YAML frontmatter edges
- `status` — reports 5 nodes, MAP/PRIORS/index all loaded

---

## Phase 3: Scribe Pipeline

**Goal**: Every 5 messages, fire a background Haiku scribe to extract structured deltas.

**Status**: COMPLETE

### Architecture Decisions

1. **Direct Anthropic SDK for scribes**: Uses `@anthropic-ai/sdk` directly (not Agent SDK) — simple prompt→response calls to Haiku.
2. **Fire-and-forget with scribeQueue**: Scribe promises collected in array. Only awaited at session end via `flush()`.
3. **Summary chain for continuity**: Each scribe appends summary. Next scribe gets chain for narrative context.
4. **Retry once on failure**: Wait 2s and retry. If retry fails, skip.

### Files Created

| File | Purpose |
|------|---------|
| `src/graph-memory/prompts/scribe.md` | Scribe system prompt — delta extraction instructions |
| `src/graph-memory/pipeline/scribe.ts` | `fireScribe()` — API call + delta parsing + retry logic |

### Files Modified

| File | Change |
|------|--------|
| `src/graph-memory/buffer-watcher.ts` | Rewritten — fires scribes on threshold, manages queue, flush(), session IDs, summary chain |
| `package.json` | Added `@anthropic-ai/sdk` dependency |

---

## Phase 4: Librarian + Consolidation

**Goal**: Session end triggers consolidation — reconcile deltas, update graph, regenerate MAP.

**Status**: COMPLETE

### Files Created

| File | Purpose |
|------|---------|
| `src/graph-memory/prompts/librarian.md` | Librarian system prompt — consolidation rules |
| `src/graph-memory/pipeline/librarian.ts` | Full librarian: API call, node CRUD, PRIORS update, MAP regeneration, index rebuild |

### Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | Wired `setOnSessionEnd()` to consolidation pipeline |

---

## Phase 5: Dreamer + Soma + Priors

**Goal**: Post-librarian creative recombination at temp=1.0. Dream fragments incubate across sessions.

**Status**: COMPLETE

### Files Created

| File | Purpose |
|------|---------|
| `src/graph-memory/prompts/dreamer.md` | Dreamer system prompt — creative recombination |
| `src/graph-memory/pipeline/dreamer.ts` | Dreamer: temp=1.0 API call, dream storage, promotion logic |

### Full Pipeline Flow (session end)

1. Buffer flush → await pending scribes
2. Librarian → reconcile deltas → update graph
3. Dreamer → creative recombination → dream fragments
4. Broadcast `graph_updated` to frontend

### Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | Added dreamer, wired into pipeline after librarian |
