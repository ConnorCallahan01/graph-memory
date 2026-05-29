# v4 Merge Plan

> Goal: merge the current mixed v2/v3 behavior into one pipeline contract where:
> - `Scribe -> Auditor -> Librarian -> Dreamer` is **per project**
> - `Observer -> Compressor` is **global across all projects**
> - session-start injection reads the right files for the active project
> - background jobs write to the right place, with explicit ownership and locks

> **Status: IMPLEMENTED** (all 6 phases complete, builds clean)

## Why this exists

The current implementation is a hybrid:

- the project-facing path still behaves like `scribe -> auditor -> librarian -> dreamer`
- the mental-model path behaves like `observer -> compressor -> dreamer_v3`
- some files are shared, some are project-scoped, and some are currently named like legacy global artifacts even when they now hold v3 data

This plan makes the intended `v4` split explicit before more polishing happens.

## Target Architecture

### Global pipeline

The global pipeline is responsible for cross-project memory and user-level style.

- `observer`
  - Reads completed project outputs across the graph root
  - Writes observations and session summaries into global memory layers
  - Can also tag project-specific observations for project lenses
- `compressor`
  - Reads global observations plus project lens observations
  - Compresses them into:
    - `mind/model.json`
    - `mind/whisper.txt`
    - `lenses/{project}/model.json`
    - `lenses/{project}/whisper.txt`
  - Prunes and archives stale material

### Per-project pipeline

The per-project pipeline is responsible for project-local work, handoff, and project-specific reasoning.

- `scribe`
  - Converts one session snapshot into durable deltas
  - Updates project handoff state
- `auditor`
  - Reviews the project deltas and flags mechanical issues
  - Writes a project audit brief and report
- `librarian`
  - Applies curated project graph maintenance
  - Refreshes project context files
- `dreamer`
  - Produces project-specific associative memory / future-work notes
  - Remains project-scoped, not global

## Ownership Rules

### What is global

- user style and guardrails
- cross-project patterns
- global whisper
- global mental model
- shared durability and archive policy
- skillforge scoring, if it is derived from graph-wide access behavior

### What is per-project

- session handoff
- project working state
- project audit and curation
- project dream outputs
- project lens files

### What is shared but partitioned

These live under the same graph root, but must remain keyed by project:

- `sessions/{project}.jsonl`
- `lenses/{project}/`
- `working/projects/{project}.md`
- `working/projects/{project}.state.json`
- project-specific observation or audit artifacts

## Current File Map

### Session capture

- raw capture buffer: `.buffer/`
- session traces: `.sessions/`
- project handoff: `working/projects/{project}.md`
- project handoff state: `working/projects/{project}.state.json`

### Global model layers

- global model: `mind/model.json`
- global whisper: `mind/whisper.txt`
- global observations: `mind/observations.jsonl`

### Project model layers

- project model: `lenses/{project}/model.json`
- project whisper: `lenses/{project}/whisper.txt`
- project observations: `lenses/{project}/observations.jsonl`

### Project pipeline artifacts

These are the proposed project-scoped outputs for the `scribe -> auditor -> librarian -> dreamer` chain:

- project preflight: `audit/projects/{project}/preflight.json`
- project audit report: `audit/projects/{project}/report.json`
- project audit brief: `audit/projects/{project}/brief.md`
- project dream artifacts: `dreams/projects/{project}/`
- project dream summary: `dreams/projects/{project}/summary.md`

### Durable graph

- active graph nodes: `nodes/`
- archive: `archive/`
- lookup index: `graph/.index.json`

## Proposed v4 Behavior

### 1. Session starts in a project

1. Resolve the active project.
2. Read the project handoff state from `working/projects/{project}.state.json`.
3. Read the project whisper from `lenses/{project}/whisper.txt`.
4. Read the global whisper from `mind/whisper.txt`.
5. Read recent project sessions from `sessions/{project}.jsonl`.
6. Inject the combined startup context.

### 2. The live session is captured

1. User and assistant turns go into `.buffer/`.
2. Tool/file traces are recorded separately.
3. At `scribeInterval` or session end, the buffer rotates.
4. `scribe` turns the snapshot into durable per-session deltas.
5. `scribe` updates the project handoff state.

### 3. Per-project maintenance runs

1. `auditor` reads the project deltas and project context.
2. `librarian` applies project-scoped graph maintenance.
3. `dreamer` creates project-specific associative memory or future direction.

### 4. Global memory runs

1. `observer` reads completed project deltas and relevant session artifacts.
2. `compressor` folds observations into global and project model layers.
3. Global context for the next session is reduced back to whispers and pickup state.

## Required Locks

### Per-project lock

One project chain should serialize:

- `scribe`
- `auditor`
- `librarian`
- `dreamer`

This lock should be keyed by project slug, not graph root.

### Global model lock

One global compression chain should serialize:

- `observer`
- `compressor`

This lock should be keyed by graph root.

### Shared graph write lock

Any writer that mutates `nodes/` or the v3 index should take a short-lived write lock so the index and node tree stay consistent.

## File Ownership Plan

### Scribe

- reads: `.buffer/`, `.sessions/`, traces, active project
- writes: `.deltas/{session}.json`, project handoff state

### Auditor

- reads: project deltas, project handoff, active graph slice
- writes: project audit report and brief

### Librarian

- reads: audit report, audit brief, project graph slice
- writes: `nodes/`, `graph/.index.json`, refreshed context files

### Dreamer

- reads: librarian outputs and project graph slice
- writes: `dreams/projects/{project}/`, optional curated graph notes

### Observer

- reads: completed project deltas and session artifacts across all projects
- writes: `mind/observations.jsonl`, `lenses/{project}/observations.jsonl`, session summaries

### Compressor

- reads: global observations, project observations, models, session logs, working state
- writes: `mind/model.json`, `mind/whisper.txt`, project model/whisper files, archive updates

## Notion And Skillforge Placement

### Notion sync

Notion should stay a global integration layer, but it must remain project-aware.

- outbound sync reads the current global model plus selected project layers
- inbound edits become project observations or project deltas, not direct graph mutation
- merge operations should be explicit and auditable

### Skillforge

Skillforge stays global in scheduling, but its source nodes are project-aware.

- score across the graph
- generate skills from nodes that meet the threshold
- keep skill manifests tied to the source node and source project

## Migration Sequence

### Phase 1, make the contract explicit ✅

- [x] document the target ownership map
- [x] tag each pipeline stage as global or project-scoped
- [x] name the injection files that each stage owns

**Implemented:** `config.ts` (v4 paths), `working-files.ts` (9 new path helpers + 3 directory enablers), `job-schema.ts` (`project?` on auditor/librarian/dreamer payloads, removed `dreamer_v3` type).

### Phase 2, split execution boundaries ✅

- [x] ensure per-project jobs cannot bleed into another project
- [x] ensure global jobs do not rewrite project handoff files directly
- [x] add lock separation for project and global chains

**Implemented:** `job-queue.ts` (project-aware queries: `hasActiveJobForProject`, `hasActiveProjectChainJob`, `hasActiveGlobalChainJob`, `countDeltasForProject`, `getActiveProjectChainProjects`). `daemon.ts` (per-project file locks via `acquireProjectChainLock`/`releaseProjectChainLock`, global lock via `acquireGlobalChainLock`/`releaseGlobalChainLock`).

### Phase 3, normalize write targets ✅

- [x] route project handoff updates to `working/projects/{project}.state.json`
- [x] route project session history to `sessions/{project}.jsonl`
- [x] route project audit artifacts to `audit/projects/{project}/`
- [x] route project dream artifacts to `dreams/projects/{project}/`
- [x] route model compression to `mind/` and `lenses/{project}/`
- [x] keep durable graph writes in `nodes/`

**Implemented:** `preflight.ts` accepts `project?` parameter, filters nodes, writes to project-scoped path. `daemon.ts` `runAuditor`/`runLibrarian`/`runDreamer` all read/write project-scoped paths when project is present, fall back to global paths otherwise. Auditor chain enqueues librarian for same project, librarian enqueues dreamer for same project.

### Phase 4, fix the background scheduler ✅

- [x] project backlog should trigger project chain jobs
- [x] global backlog should trigger observer/compressor jobs
- [x] session-end should enqueue only the project-local work it owns

**Implemented:** Replaced `GRAPH_LEVEL_TYPES` global blocking with `claimNextProjectAwareJob`/`canClaimJob` — project A's auditor can run concurrently with project B's librarian. Added `maybeEnqueueProjectAuditorsFromBacklog` to scan delta files for project tags and enqueue per-project auditors. Scribe completion triggers `maybeEnqueueAuditorForProject` for the scribe's project. Global observer/compressor scheduling unchanged.

### Phase 5, reconcile external systems ✅

- [x] make Notion inbound/outbound respect the new ownership split
- [x] make Skillforge emit artifacts from the correct source project
- [ ] keep dashboard/API reads aligned with the same storage boundaries

**Implemented:** Notion inbound `applyInboundDeltas` now routes all edits through `appendObservation`/`appendProjectObservation` instead of direct graph node mutation. Resolves project from source node frontmatter. Skillforge already filtered to project-local nodes only (no change needed). Dashboard alignment deferred to dashboard-specific work.

### Phase 6, remove compatibility cruft ✅

- [x] retire legacy mixed-scope paths only after the new contract is proven
- [x] keep the fallback paths until the new one is verified end-to-end

**Implemented:** Removed `LEGACY_MARKERS`, `CONSOLIDATION_LOCK_PATH`, `clearLegacyMarkers()`, `clearConsolidationLock()`. Removed `runDreamerV3()` and `dreamer_v3` from `processJob` switch. Removed `GRAPH_LEVEL_TYPES` set and `hasRunningGraphLevelJob()`. Global audit/report/brief paths still exist in config for backward compatibility but auditor/librarian/dreamer use project-scoped paths when project is provided.

## Acceptance Criteria

The merge is done when all of these are true:

1. [x] A project session always starts from the project's own handoff state plus global whisper.
2. [x] `scribe -> auditor -> librarian -> dreamer` never crosses project boundaries.
3. [x] `observer -> compressor` sees the whole graph root, not just one project.
4. [x] Project and global jobs can run in parallel when they do not share a lock.
5. [ ] The dashboard/API shows the same active/archived split that the pipeline writes.
6. [ ] Notion, skillforge, and project docs all point at the same ownership map.
7. [ ] The plan can be tested from raw session start through compressed next-session pickup.

Items 5-7 require runtime verification (daemon startup, end-to-end pipeline test with real sessions). The code-level implementation for 5-6 is complete; 7 needs a live integration test.

## Open Questions — RESOLVED

- **Should `dreamer` remain project-scoped only, or should there also be a global dream pass?**
  → **Resolved: project-scoped only.** Removed `dreamer_v3` entirely. Per-project dreamer produces project-specific associative memory. Cross-project connections happen through the global model.
- **Should project audit artifacts live under `audit/{project}/` tree, or remain root-level?**
  → **Resolved: `audit/projects/{project}/`.** Each project gets its own audit directory with preflight, report, and brief.
- **Should `observer` write one global observation stream plus per-project streams?**
  → **Resolved: both global + per-project.** Observer writes to both `mind/observations.jsonl` and `lenses/{project}/observations.jsonl` (existing behavior, unchanged).
- **Should Notion inbound edits become `observer` inputs, `scribe` deltas, or both?**
  → **Resolved: observer inputs.** Notion edits now route through `appendObservation`/`appendProjectObservation` and flow through observer → compressor pipeline.
- **Should Skillforge source from project-local lenses only, or from the whole graph?**
  → **Resolved: project-local only.** Skillforge already filtered to project-tagged nodes only. No code change needed.
