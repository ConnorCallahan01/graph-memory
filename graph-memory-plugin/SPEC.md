# Graph Memory v3 — Mental Model Architecture

> Current implementation note (2026-05-18): v3 is now the default context path. The durable graph node store is unified on `nodes/`; `graph/.index.json` is the v3 lookup index, not a separate node tree. Set `GRAPH_MEMORY_V3=0` only as an emergency fallback while debugging the v3 session context path.

## Overview

This spec describes a ground-up redesign of the graph-memory plugin's backend architecture. The current system (v2) is a graph database with a chat interface — 771 nodes, 53% below 0.4 confidence, injecting 11k tokens per session via 5 separate context files. It has a write-amplification problem (3,000+ I/O ops per pipeline cycle) and makes the user aware it exists through structured tool calls and visible context injection.

v3 replaces this with a **four-layer mental model architecture**:

1. **Global Mental Model** — who the user is (~300 tokens)
2. **Project Mental Models** — how they think about each project (~400 tokens)
3. **Session Logs** — what happened recently (~150 tokens)
4. **The Graph** — full detail, on demand (not injected)

Total passive injection: ~850 tokens. The agent just knows.

---

## Architecture

### Four-Layer Model

```
Layer 1: Global Mental Model
  - Cognitive style, decision patterns, preferences
  - Guardrails (anti-patterns — permanent, never decay)
  - Injected every session, ~300 tokens
  - Storage: mind/model.json, mind/whisper.txt

Layer 2: Project Mental Models
  - How the user thinks about this specific project
  - Tech stack, conventions, procedures, project-specific guardrails
  - Injected when project matches, ~400 tokens
  - Storage: lenses/{project}/model.json, lenses/{project}/whisper.txt

Layer 3: Session Logs
  - Factual log of recent sessions per project
  - Active work, decisions, blockers, open threads
  - Expires in 7-30 days based on age
  - Injected every session, ~150 tokens
  - Storage: sessions/{project}.jsonl

Layer 4: The Graph (Detailed Memory)
  - Granular nodes with full context
  - Queried on demand via recall/search, not injected
  - Categories: patterns, anti-patterns, decisions, preferences,
    procedures, corrections, projects, concepts, architecture, people, tools
  - Storage: nodes/{category}/{node}.md + graph/.index.json
```

### Pipeline

```
v2 Pipeline (4 LLM passes per session):
  scribe → auditor → librarian → dreamer

v3 Pipeline (1-2 LLM passes per session):
  observer → compressor (periodic, not every session)

  observer:    watches conversation, writes observations + session logs + graph nodes
  compressor:  reads observations, folds into models, generates whispers
  dreamer:     periodic background job against compressed models + graph
  deep-audit:  on-demand full graph walk for bloat management
```

### Anti-Patterns

Anti-patterns are first-class citizens:
- Separate category: `graph/anti-patterns/`
- Higher confidence than patterns (typically 0.85-0.95)
- Never decay — `decay_exempt: true`
- Folded into whisper as guardrails
- Tagged with source session for traceability

### Harness Adapter Pattern

The core is harness-agnostic. Each harness (Claude Code, Codex, Pi, OpenCode) provides an adapter:

```typescript
interface HarnessAdapter {
  name: string;
  onSessionStart(cwd: string, sessionId: string): Promise<string>;
  onSessionEnd(sessionId: string): Promise<void>;
  injectContext(text: string): void;
}
```

Codex runs in degraded mode (MCP tools only, no hooks). Claude Code, Pi, and OpenCode get full automatic operation.

### Project Doc Bootstrap

New projects get bootstrapped from the global mental model:
- After first session, observer has enough signal to generate CLAUDE.md / AGENT.md
- Conventions inherit from user's global guardrails
- File format adapts to harness (claude → CLAUDE.md, opencode → AGENT.md)
- Compressor tracks drift between project doc and project model

---

## Storage Layout

```
~/.graph-memory/
  mind/
    observations.jsonl          ← raw global observations (append-only)
    model.json                  ← compressed global model
    whisper.txt                 ← pre-generated whisper (~300 tokens)

  lenses/
    {project}/
      observations.jsonl        ← project-specific observations
      model.json                ← compressed project model
      whisper.txt               ← project whisper (~400 tokens)
    _archived/                  ← dormant project lenses

  sessions/
    {project}.jsonl             ← session summaries per project

  graph/
    patterns/
    anti-patterns/
    decisions/
    preferences/
    procedures/
    corrections/
    projects/
    concepts/
    architecture/
    people/
    tools/
    .index.json                 ← query index for recall/search
    .archive/                   ← faded/obsolete nodes

  dreams/
    pending/
    integrated/

  .pipeline/
    observations/               ← pending observation batches
    jobs/                       ← job queue (queued/running/done/failed)
    logs/                       ← worker logs

  .sessions/                    ← raw session traces
  .git/                         ← full history
```

---

## Bloat Management

### Lifecycle Rules Per Layer

| Layer | Max Size | Prune Trigger | Prune Action |
|---|---|---|---|
| Observations (.jsonl) | 500KB per file | Compressor run | Delete absorbed > 30d |
| Session logs | 10 entries per project | Compressor run | Expire > 7d, delete > 30d |
| Graph nodes | 200 active (soft), 300 (hard) | Compressor + deep audit | Archive < 0.2 confidence (anti-patterns exempt) |
| Model files | 1,000 tok (global), 1,200 tok (project) | Every compressor run | Compress, fold details into graph |
| Whisper files | 400 tok (global), 500 tok (project) | Every compressor run | Hard cap enforced |
| Project lenses | 10 active | New project creation | Archive dormant > 14d, delete > 60d |

### Graph Node Lifecycle

```
Created → Active (> 0.4) → Fading (0.2-0.4) → Archived (< 0.2)

Rules:
- Anti-patterns: NEVER decay, NEVER archive
- Patterns/decisions: decay at 0.05 rate, archive at < 0.2
- Referenced by 2+ other nodes → decay paused
- Accessed in last 14 days → decay paused
- Archive > 90 days → eligible for deletion (user warning via status)
```

### Session Log Lifecycle

```
Written → Active (< 3 days) → Fading (3-7 days) → Expired (> 7 days)

Rules:
- < 3 days: full detail injected
- 3-7 days: summary only (compressed by compressor)
- > 7 days: only "decisions" and "shipped" kept
- > 30 days: fully deleted (important stuff is in graph/model)
```

---

## Structured Worker Tools

### Observer Tools

```typescript
observe({
  layer: "global" | "project",
  project?: string,
  observation: string,
  evidence: string[],
  confidence: number,
  type: "pattern" | "anti_pattern" | "preference" | "correction" |
        "decision" | "procedure" | "emotional" | "relational"
})

log_session({
  project: string,
  active_work: string[],
  shipped: string[],
  decisions: string[],
  blocked: string[],
  open_threads: string[],
  corrections_given: string[],
  next_session_should: string
})

upsert_node({
  path: string,
  category: string,
  gist: string,
  content: string,
  confidence: number,
  edges: Array<{target, type}>,
  anti_pattern?: boolean,
  tags: string[]
})
```

### Compressor Tools

```typescript
get_observations({ layer, project?, since? })
get_model({ layer, project? })
update_model({ layer, project?, content })
query_graph({ query, category?, limit? })
get_anti_patterns({ project? })
archive_observations({ ids })
prune_session_logs({ project?, older_than_days })
archive_graph_nodes({ paths, reason })
get_graph_stats()
flag_for_deep_audit({ reason })
```

### Dreamer Tools

```typescript
get_models({ layers })
get_graph_nodes({ category?, limit? })
get_anti_patterns({})
propose_dream({ fragment, references, reasoning })
```

### Bootstrap Tool

```typescript
bootstrap_project_doc({
  project: string,
  harness: string,
  cwd: string,
  observations: Obs[],
  global_model: Model,
  graph_nodes: Node[]
})
```

---

## Session Start Flow (New)

```typescript
async function sessionStart(cwd: string, sessionId: string): string {
  const project = detectProject(cwd);
  ensureProjectLens(project); // create if first session

  const globalWhisper = readOrGenerate("mind/whisper.txt");
  const projectWhisper = readOrGenerate(`lenses/${project}/whisper.txt`);
  const sessionLog = readRecent(`sessions/${project}.jsonl`, 3);

  const parts = [globalWhisper, projectWhisper, sessionLog].filter(Boolean);
  return parts.join("\n\n---\n\n");
}
```

Three file reads. No MAP regeneration. No index rebuild. No pinned node scanning.

---

## Implementation Phases

### Phase 0: Scaffolding and Core Types ✅

Create the new directory structure, type definitions, and harness adapter interfaces. No behavior changes yet.

**Completed 2026-05-11.** All tasks done, clean build.

**Tasks:**

- [x] Create `src/graph-memory/mind/` module with types for observations, models, whispers
- [x] Create `src/graph-memory/lenses/` module for project mental model management
- [x] Create `src/graph-memory/sessions/` module for session log management
- [x] Define `HarnessAdapter` interface in `src/graph-memory/adapters/`
- [x] Define structured tool schemas for observer, compressor, dreamer
- [x] Create `src/graph-memory/pipeline/observer.ts` (empty shell)
- [x] Create `src/graph-memory/pipeline/compressor.ts` (empty shell)
- [x] Update `config.ts` with new paths (mind/, lenses/, sessions/, graph/) alongside existing paths
- [x] Update `index.ts` to create new directory structure on init

**Implementation notes:**

- `mind/` has 4 files: `types.ts` (Observation, GlobalModel, GlobalModelFile), `observations.ts` (append-only JSONL with prune/absorb), `model.ts` (read/write model.json), `whisper.ts` (read/write whisper.txt with token cap enforcement)
- `lenses/` mirrors `mind/` structure per-project — `manager.ts` handles observations, models, whispers, plus archive/restore lifecycle
- `sessions/` uses JSONL per project with 3-tier compaction (full → summary → delete) and 7/30 day boundaries
- `adapters/types.ts` defines HarnessAdapter interface plus per-harness config (supportsHooks, supportsMCP, projectDocFilename), with `isDegradedMode()` for codex
- `pipeline/v3-tool-schemas.ts` has Zod schemas for all 16 structured tools (observe, log_session, upsert_node, get_observations, get_model, update_model, query_graph, get_anti_patterns, archive_observations, prune_session_logs, archive_graph_nodes, get_graph_stats, flag_for_deep_audit, get_models, get_graph_nodes, propose_dream, bootstrap_project_doc)
- v3 paths added to config as `v3Mind`, `v3Lenses`, `v3Sessions`, `v3Graph`, `v3GraphIndex`, `v3GraphArchive`, `v3PipelineObservations` — no v2 paths removed
- init creates `graph/` with all 11 categories (patterns, anti-patterns, decisions, preferences, procedures, corrections, projects, concepts, architecture, people, tools)

### Phase 1: Observer ✅

Build the observer — the replacement for the scribe. This is the first LLM pass that replaces the current scribe + auditor pipeline.

**Completed 2026-05-11.** All tasks done, clean build.

**Tasks:**

- [x] Write observer agent prompt (`agents/memory-observer.md`)
  - Must be concise (~120 lines max) — structured tools handle the mechanics
  - Focus on: what to observe, what to ignore, how to classify layer/type
  - Include anti-pattern detection rules
- [x] Implement observer structured tools (`pipeline/observer-tools.ts`)
  - `observe()` — validates, writes to observations.jsonl
  - `log_session()` — writes to sessions/{project}.jsonl
  - `upsert_node()` — writes/updates graph nodes
  - Each tool enforces schema validation
- [x] Implement observer job in daemon (`pipeline/daemon.ts`)
  - New job type: "observer"
  - Same harness dispatch as current scribe (uses worker-runner.ts)
  - Writes structured tools module path in prompt
  - Validates output (observer must produce at least one observation or log_session)
- [x] Wire observer into session-end hook (replace scribe enqueue with observer enqueue)
- [x] Wire observer into buffer-watcher (replace scribe rotation with observer rotation)
- [x] Add observer job type to job-queue priority map (priority 0, same as scribe)

**Implementation notes:**

- Observer runs in **parallel** with scribe (both get enqueued for the same snapshot). This lets us validate observer output against scribe output before removing scribe in Phase 10
- `agents/memory-observer.md` is ~130 lines, focused on classification rules and output format. Agent writes JSON files to `.pipeline/observations/` which are then processed by `observer-tools.ts`
- `observer-tools.ts` reads the JSON output files and applies them: observe→observations.jsonl (global or project), log_session→sessions/{project}.jsonl, upsert_node→graph/{category}/{path}.md
- Anti-patterns get `confidence >= 0.85` and `decay_exempt: true` automatically
- Job type `observer` has priority 0 (same as scribe), max 3 attempts
- Event types added: `observer:fired`, `observer:pending`, `observer:complete`, `observer:warnings`, `observer:error`
- `ObserverJobPayload` mirrors `ScribeJobPayload` exactly (snapshotPath, sessionId, project, traces)

### Phase 2: Compressor ✅

Build the compressor — reads observations, produces mental models and whispers. Runs periodically, not every session.

**Completed 2026-05-11.** All tasks done, clean build.

**Tasks:**

- [x] Write compressor agent prompt (`agents/memory-compressor.md`)
  - Reads pending observations, current model, relevant graph nodes
  - Folds new observations into model
  - Handles contradictions (re-evaluate, don't just append)
  - Enforces model size caps
  - Handles bloat: prune observations, trim session logs, archive graph nodes
- [x] Implement compressor structured tools (`pipeline/compressor-tools.ts`)
  - `update_model()`, `generate_whisper()`, `archive_observations()`
  - `archive_graph_nodes()`, `prune_session_logs()`, `flag_for_deep_audit()`
- [x] Implement compressor job in daemon
  - New job type: "compressor"
  - Trigger: after 5 observer completions (configurable)
  - Also triggerable on demand via MCP action
  - Generates whisper.txt files as output
- [x] Implement whisper generation
  - Whisper text written by the LLM agent, capped by `enforceWhisperCap()` (400 tok global, 500 tok project)
  - Token estimation via chars/4 heuristic
- [x] Implement graph node archival in compressor
  - Archive nodes via `archive_graph_nodes` tool call with reason tracking
  - Anti-patterns protected (frontmatter check in agent prompt)
- [x] Implement observation pruning
  - Mark observations absorbed after compression
  - Auto-prune absorbed observations > 30d
  - Hard cap on observations.jsonl size (500KB)

**Implementation notes:**

- `agents/memory-compressor.md` is ~180 lines covering compression logic, whisper structure, bloat management
- Compressor agent writes JSON files to `.pipeline/observations/` (same staging directory as observer, but with `comp_` prefixed filenames)
- `compressor-tools.ts` processes 6 tool types: update_model, generate_whisper, archive_observations, archive_graph_nodes, prune_session_logs, flag_for_deep_audit
- `maybeEnqueueCompressorFromObserverBacklog()` triggers after 5 completed observer jobs since the last compressor run
- Graph node archival does frontmatter surgery to add `archived_reason` and `archived_date` before moving to `graph/.archive/`
- Whisper generation is LLM-driven (the agent writes the whisper text), with mechanical token cap enforcement
- Compressor runs at priority 1 (same as working_update), with 3 max attempts and 10-minute timeout

### Phase 3: Session Start Redesign ✅

Replace the current 5-file injection with the whisper model.

**Completed 2026-05-11.** All tasks done, clean build, 17/17 tests pass.

**Tasks:**

- [x] Rewrite `session-start.ts` to read whisper files
  - Read `mind/whisper.txt`
  - Read `lenses/{project}/whisper.txt`
  - Read `sessions/{project}.jsonl` (last 3 entries)
  - Total: 3 file reads instead of current ~50+
- [x] Add project lens creation on first session
  - If no lens exists for detected project, create lens directory
  - Seed with empty model.json
- [x] Update context budget enforcement
  - Global whisper: hard cap 400 tokens
  - Project whisper: hard cap 500 tokens
  - Session log: hard cap 200 tokens
  - Total: hard cap 1,100 tokens
- [x] Update hooks to pass through to harness adapters
  - Claude Code: stdout (same as current)
  - OpenCode: client.session.prompt (same as current)
  - Pi: client.session.prompt (same as current)
- [x] Keep MCP tool registration for `graph_memory` — it still works for Layer 4 queries

**Implementation notes:**

- New module `session-start-v3.ts` with `buildV3Context()` and `hasV3Data()` — shared across all harnesses
- Claude Code hook (`session-start.ts`) tries v3 first via `hasV3Data()`, falls back to v2 when no whisper exists yet
- OpenCode extension (`graph-memory-opencode.ts`) same pattern: v3 first, v2 fallback
- Auto-creates project lens on first session via `ensureLens()` in `buildV3Context()`
- Session logs formatted with date, shipped, decisions, open threads, next session recommendation
- Token budgets enforced: 400 global + 500 project + 200 session = 1,100 total
- Added `compress` MCP action for manual compressor triggering (via `graph_memory(action="compress")`)
- 3 new tests: whisper injection, fallback behavior, auto lens creation

### Phase 4: Graph Layer (Layer 4) Redesign ✅

Redesign the graph for efficient on-demand querying. The graph stays but becomes a pull-only layer.

**Tasks:**

- [x] Redesign graph index for O(1) lookups
  - Replace flat JSON array with Map-keyed structure
  - Key: node path → value: index entry
  - Support category-based filtering
  - Support project-based filtering
  - Lazy load, cache with invalidation
- [x] Implement incremental index updates
  - `addToIndex(nodePath, entry)` — single node add/update
  - `removeFromIndex(nodePath)` — single node remove
  - `rebuildV3Index()` — full rebuild (only on deep audit or post-compressor)
  - No more full rebuild on every remember/recall/consolidation
- [x] Wire v3 index into pipeline
  - observer-tools.ts: `addToIndex` after every node upsert
  - compressor-tools.ts: `removeFromIndex` after every node archival
  - daemon.ts: `rebuildV3Index` after compressor completes
- [x] Update `tools.ts` — fix confidence default from 0.5 to 0.6
- [x] Update `tools.ts` — `updateIndexEntry` dual-writes to v2+v3 index
- [x] Tests: rebuild/lookup/search, incremental add/remove, anti-pattern support (3 tests)

### Phase 5: Anti-Patterns ✅

First-class anti-pattern support across all layers.

**Tasks:**

- [x] Add `anti_patterns` category to graph node conventions
- [x] Implement `decay_exempt` flag in decay logic — anti-patterns never decay
- [x] Implement anti-pattern injection in whisper generation
  - Global anti-patterns → global whisper guardrails section
  - Project anti-patterns → project whisper guardrails section
  - Format: "## Guardrails\n\n- Rule 1\n- Rule 2\n..."
  - Budget: 150 tokens for guardrails section
- [x] Update observer to classify corrections as anti-patterns
  - Anti-pattern observations get confidence floor of 0.85
  - Anti-patterns auto-set `decay_exempt: true`
- [x] Add anti-pattern visibility to `graph_memory` status action
  - `v3.antiPatterns.total`, `v3.antiPatterns.global`, `v3.antiPatterns.project`
  - Full v3 graph stats included in status response
- [x] Tests: decay_exempt, guardrails injection, status visibility (3 tests)

### Phase 6: Project Doc Bootstrap ✅

Generate project root .md files (CLAUDE.md / AGENT.md) from mental models.

**Tasks:**

- [x] Implement `bootstrap_project_doc` tool
  - Takes: project name, harness, cwd
  - Generates: harness-appropriate file (CLAUDE.md / AGENT.md)
  - Writes to project root
  - Seeds from project model, global model, anti-patterns, graph nodes
- [x] Add bootstrap trigger to observer
  - After ≥5 unabsorbed observations for a project → queue bootstrap job
- [x] Add bootstrap trigger to MCP tool
  - `graph_memory(action="bootstrap")` — explicit trigger
- [x] Implement project doc drift detection
  - Compare current doc sections to project model
  - Flags missing sections (tech-stack, conventions, guardrails)
  - Surfaces drift in bootstrap action response
- [x] Add `<!-- custom start/end -->` section preservation
  - Hand-edited sections in project docs are preserved during re-bootstrap
- [x] Harness-aware file naming
  - claude-code → CLAUDE.md (prefers .claude/CLAUDE.md if dir exists)
  - opencode/codex/pi → AGENT.md
  - Reuses CLAUDE.md if it already exists and harness is non-claude
- [x] Tests: bootstrap generation, custom section preservation, MCP action, drift detection (4 tests)

### Phase 7: Dreamer Redesign ✅

Adapt the dreamer to work against compressed models instead of the raw node graph.

**Tasks:**

- [x] Write dreamer v3 prompt (`agents/memory-dreamer-v3.md`)
  - Input: global model + project models + anti-patterns + graph stats + pending dreams
  - Looks for surprising connections between compressed model entries
  - Uses anti-patterns as "dream around" constraints
  - Strategies: self-model, connection, inversion, analogy, emergence, integration
- [x] Implement dreamer v3 structured tools (`pipeline/dreamer-v3-tools.ts`)
  - `propose_dream` — creates new dream fragment JSON in dreams/pending/
  - `promote_dream` — raises confidence on existing dream
  - `buildDreamerV3Input()` — assembles models, anti-patterns, pending dreams
  - `processDreamerV3Outputs()` — reads JSON files from pipeline observations
  - Hard cap enforcement on pending dreams
- [x] Update dreamer job in daemon
  - `dreamer_v3` job type added to job-schema, job-queue
  - Triggered after compressor completion (auto-enqueues)
  - `runDreamerV3()` builds input inline, processes outputs
- [x] Update dream reinforcement
  - Max confidence for reinforced dreams: 0.65 (was 0.55)
- [x] Tests: dream propose/promote, input building, reinforcement cap (3 tests)

### Phase 8: Harness Adapters ✅

Implement the adapter pattern for all four harnesses.

**Tasks:**

- [x] Implement Claude Code adapter (`adapters/claude-code.ts`)
  - session-start: stdout injection (same as current hooks.json)
  - session-end: flush buffer, enqueue scribe + observer
  - tools: MCP server (same as current)
  - project detection: cwd from hook stdin
- [x] Implement OpenCode adapter (`adapters/opencode.ts`)
  - session-start: `client.session.prompt({ noReply: true })` injection
  - session-end: flush buffer, enqueue scribe + observer
  - tools: plugin-native `tool()` builder
  - project detection: worktree from plugin API
- [x] Implement Pi adapter (`adapters/pi.ts`)
  - session-start: returns context string for `before_agent_start` injection
  - session-end: flush buffer via `session_shutdown` event
  - tools: `registerTool()` with TypeBox schema
  - project detection: cwd from process (no worktree API)
- [x] Implement Codex adapter (`adapters/codex.ts`) — degraded mode
  - session-start: none (no hooks available)
  - session-end: daemon watches for orphaned buffers
  - tools: MCP server
  - project detection: cwd from process
- [x] Shared session logic (`adapters/shared.ts`)
  - `buildSessionStartContext()` — unified v3-first/v2-fallback context builder
  - `buildV2Injection()` — traditional 5-file injection as fallback
  - `flushAndQueueJobs()` — buffer flush + scribe/observer job enqueue
  - `cleanupSession()` — active project removal + dirty state clear
- [x] Adapter factory (`adapters/factory.ts`)
  - `createAdapter(harness)` returns correct adapter instance
- [x] Tests: factory routing, shared context, codex no-op, config validation (4 tests)

### Phase 9: Migration ✅

Migrate existing graph data to the new format.

**Tasks:**

- [x] Implement migration script (`src/graph-memory/scripts/migrate-v2-to-v3.ts`)
  - Read existing nodes from ~/.graph-memory/nodes/
  - Run a one-time "bootstrap compressor" pass
  - Generate initial mind/model.json from high-confidence nodes
  - Generate initial project models from project-tagged nodes
  - Generate initial whispers
  - Reuse nodes/ directly for v3 Layer 4
  - Preserve existing archive/ directory
- [x] Validate against current live data shape
  - Live nodes are under ~/.graph-memory/nodes/
  - ~/.graph-memory/graph/ contains no markdown node store
- [ ] Run migration against current live data (~797 nodes)
  - Verify generated whisper quality
  - Verify graph recall still works
  - Verify anti-patterns are correctly identified
- [x] Keep fallback paths functional during transition
  - Durable graph paths are unified on nodes/
  - Feature flag: `GRAPH_MEMORY_V3=0` disables the v3 context path for emergency fallback
  - Default: v3 active, shadow mode disabled unless `GRAPH_MEMORY_V3_SHADOW=1`

### Phase 10: Cleanup and Removal

Remove v2 code after v3 is validated.

**Tasks:**

- [ ] Remove old pipeline components:
  - `pipeline/spawn.ts` (already deprecated)
  - `pipeline/librarian.ts` (replaced by compressor)
  - Old scribe-related code in daemon.ts
- [ ] Remove old context file generation:
  - MAP.md generation (replaced by whispers)
  - PRIORS.md (replaced by global model)
  - SOMA.md (replaced by global model emotional section)
  - WORKING.md (replaced by session logs)
  - DREAMS.md (dreamer writes directly)
- [ ] Remove old agent prompts:
  - memory-scribe.md (replaced by memory-observer.md)
  - memory-auditor.md (replaced by compressor)
  - memory-librarian.md (replaced by compressor)
- [x] Update dashboard to new data model
  - Show mental model, project lenses, session logs
  - Show anti-patterns as separate view
  - Show observation stream
  - Keep graph explorer for Layer 4
- [ ] Remove feature flag — v3 is the only path
- [ ] Update documentation (README, CLAUDE.md, PRODUCT.md)

---

## Phase Dependency Graph

```
Phase 0 (types/structure)
  │
  ├──► Phase 1 (observer)
  │      │
  │      └──► Phase 2 (compressor)
  │             │
  │             ├──► Phase 3 (session start redesign)
  │             │
  │             ├──► Phase 5 (anti-patterns)
  │             │
  │             └──► Phase 7 (dreamer redesign)
  │
  ├──► Phase 4 (graph redesign)  [independent of 1-3]
  │
  ├──► Phase 6 (project doc bootstrap) [depends on 1, 2]
  │
  └──► Phase 8 (harness adapters) [depends on 3]

Phase 9 (migration) [depends on 1-8]
  │
  └──► Phase 10 (cleanup) [depends on 9]
```

Phase 4 (graph redesign) and Phases 1-3 (observer/compressor/session-start) can be built in parallel.

---

## Open Questions

### Architecture

1. **Compressor prompt design.** We've defined the tools but not the actual compression logic. How does the compressor decide what to fold, what to keep, what to discard? This needs a detailed prompt design pass. The prompt needs to handle:
   - Observations that reinforce existing model entries (strengthen, don't extend)
   - Observations that contradict (re-evaluate the model entry)
   - Observations about something entirely new (add tentatively)
   - Model entries getting verbose (compress aggressively)
   - Deciding when an observation is "absorbed" vs still needs to exist separately

2. **Observation quality control.** The observer is more open-ended than the current scribe. Bad observations compress into bad model entries which become bad whispers. No human-in-the-loop exists yet. Options:
   - Confidence threshold: only fold observations > 0.7 into model
   - Multi-observer: run observer twice and only keep observations both agree on (expensive)
   - User correction: when user corrects something the whisper caused, downgrade the source observation
   - Trust gradient: new observations are tentative until reinforced by 2+ sessions

3. **Cold start problem.** The system is minimal for the first 2-3 sessions in a new project. The global whisper helps (guardrails carry over) but the project whisper is empty. Mitigation options:
   - Bootstrap the project whisper from the first session more aggressively
   - Allow the agent to query the graph on first session even without a whisper
   - Accept that 2-3 sessions of "getting to know you" is natural and correct

4. **Migration fidelity.** Converting 771 existing nodes into a mental model is lossy. Some nodes will compress well, others won't. The migration needs to:
   - Preserve anti-patterns at full fidelity
   - Preserve high-confidence nodes (> 0.7) as graph entries
   - Attempt to compress low-confidence nodes into model entries
   - Allow manual review of the generated model before activation

### Concurrency and Correctness

5. **Concurrent session handling.** Patrick might have Claude Code open on keel3_demo while OpenCode is running on agent_memory. Both trigger session start simultaneously. The core needs:
   - No cross-project race conditions (each lens is independent)
   - Global model updates are atomic (one compressor run at a time)
   - Observer jobs can run in parallel (per-session, no conflicts)
   - Graph index updates are atomic (file lock or append-only)

6. **Locking model.** The current system has a daemon lock and a consolidation lock. The new system needs:
   - Daemon lock (same — one daemon per graph root)
   - Compressor lock (only one compressor run at a time — it rewrites model files)
   - No observer lock needed (append-only writes)
   - Graph index lock for incremental updates

### Performance

7. **Graph index structure.** We kept the graph but didn't redesign the index beyond "use a Map." Specific questions:
   - Should the index be a single JSON file or multiple per-category files?
   - Should we use a real embedded DB (SQLite, LMDB) instead of JSON?
   - How large can the index get before read performance degrades?
   - Should the index be memory-mapped or loaded entirely?

8. **Whisper generation cost.** The compressor generates whispers. If the compressor runs every 5 sessions, the whisper could be up to 5 sessions stale. Is that acceptable? Options:
   - Generate whisper after every session (more LLM cost, fresher context)
   - Generate whisper on session start (computation during injection — defeats the "3 file reads" goal)
   - Hybrid: compressor generates whisper, but session start can trigger a quick refresh if model changed since last whisper generation

9. **Observer LLM cost.** The current scribe runs once per 10-message rotation. The observer runs at the same cadence. But the observer produces more output (observations + session log + graph nodes) than the scribe (deltas only). Is the observer more expensive per run? Need to benchmark.

### Scoping Gaps

10. **Dashboard redesign.** The memory dashboard shows the current graph/pipeline. It needs significant frontend work to show mental models, project lenses, session logs, and anti-patterns. This is a full frontend redesign not scoped here.

11. **Ambient recall.** The current Pi and OpenCode extensions scan the graph on every user message and inject relevant nodes. Does this survive in v3? The whisper handles most cases, but for deep queries, ambient recall of the graph might still be valuable. Need to decide whether to keep, remove, or redesign this feature.

12. **Multiple projects in one session.** If Patrick opens agent_memory but then cd's into a subdirectory that's a different git repo, does the project context switch? The current system doesn't handle this well. The new system should at least detect project changes mid-session.

13. **Explicit memory commands.** The user can currently call `graph_memory(action="remember", ...)` to explicitly store knowledge. This still works against Layer 4 (the graph). But should explicit remember also update the project model immediately? Or wait for the next compressor run? The tradeoff is freshness vs. cost.

14. **Dreamer input size.** The current dreamer reads the full MAP. The new dreamer reads compressed models. But compressed models might be too abstract for creative connections. Should the dreamer also sample graph nodes for detail? How many? This affects LLM cost.

15. **Project doc update workflow.** When the compressor detects project doc drift, it flags it. But the actual update requires writing a file to the project root (outside ~/.graph-memory/). This crosses a security boundary. Need to design the update flow — probably through the MCP tool, not automatically.

16. **Testing strategy.** The current system has thin test coverage. The new system needs integration tests for:
    - Observer → observations written correctly
    - Compressor → model compression preserves key insights
    - Whisper → stays under token budget
    - Anti-patterns → never decay
    - Session start → correct whisper for project
    - Migration → v2 data produces valid v3 model
    These tests don't exist yet and aren't scoped in the phases above.

17. **Skillforge.** The current system has a skillforge pipeline that converts high-access nodes into installable agent skills. This feature is not addressed in v3. It needs to be adapted to work against the new graph structure, but the core logic (score candidates, generate skill files) should still apply.

18. **External inputs.** The current system has Gmail/Calendar/Slack input normalization. This is a separate subsystem that feeds into the graph. It's not affected by the v3 redesign architecturally, but the pipeline integration (how external inputs trigger observations) needs to be defined.

19. **Memory sharing.** Can two users share a graph? Can a team have a shared project mental model? This is out of scope for v3 but the data model should not prevent it in the future.

20. **Undo/revert.** The current system uses git for rollback. The new system should too. But the mental model files (model.json, whisper.txt) are regenerated by the compressor — reverting them might conflict with the next compressor run. Need to define what "revert" means for compressed models.
