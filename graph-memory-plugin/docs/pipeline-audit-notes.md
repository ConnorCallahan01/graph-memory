# Pipeline Audit Notes

Working notes from a fresh audit of the graph-memory plugin. This file is intentionally observational first: document how the system appears to work, where the implementation diverges from the stated intent, and questions to resolve before doing a polish pass.

## Current System Model

- The plugin is a TypeScript/Node package exposing one MCP/native tool: `graph_memory`.
- Claude Code integration uses shell wrappers in `bin/` that execute compiled hook files from `dist/hooks/`.
- OpenCode integration uses `extensions/graph-memory-opencode.ts` and dynamically imports the compiled core from `dist/graph-memory`.
- Runtime storage is resolved by `GRAPH_MEMORY_ROOT`, then `~/.graph-memory-config.yml`, then `~/.graph-memory`.
- The daemon is the main pipeline scheduler. It owns a file-backed queue in `<graphRoot>/.jobs/{queued,running,done,failed}` and polls on `CONFIG.session.daemonPollMs`.
- Pipeline workers are spawned as external agent harnesses through `worker-runner.ts`, using Codex, Claude Code, pi, or OpenCode based on env/runtime config.
- The durable graph store is `nodes/`; v3 Layer 4 now points at the same markdown files instead of a separate `graph/` node tree.
- v3 mental-model components are active by default: `observer`, `compressor`, `dreamer_v3`, v3 graph index, mind/lens/session storage, and project doc bootstrap.
- The older `scribe` -> `auditor` -> `librarian` -> `dreamer` path still exists as a fallback/compatibility path, with `working_update` for project handoff files.
- Other daemon-owned background processes include daily memory analysis, Notion sync/inbound/merge, Skillforge scoring/refresh, decay, stale buffer scavenging, orphan snapshot cleanup, session pruning, and pipeline log rotation.
- The target merge contract is now documented in [docs/v4-merge-plan.md](./v4-merge-plan.md): per-project `scribe -> auditor -> librarian -> dreamer`, global `observer -> compressor`.

## Entry Points And Triggers

- `hooks/hooks.json` registers Claude Code hooks:
  - `SessionStart` -> `bin/session-start.sh`
  - `UserPromptSubmit` -> `bin/on-user-message.sh`
  - `Stop` -> `bin/on-assistant-response.sh`
  - `PreToolUse` -> `bin/on-pre-tool-use.sh`
  - `PostToolUse` -> `bin/on-post-tool-use.sh`
  - `SessionEnd` -> `bin/session-end.sh`
- `on-user-message.ts` records user text, runs ambient recall, and may inject additional context.
- `on-assistant-response.ts` records final assistant text, syncs visible assistant trace, rotates the buffer at `scribeInterval`, and queues `scribe`.
- `session-end.ts` flushes any remaining buffer and queues `scribe`; it may also queue `auditor` if enough delta files exist.
- OpenCode queues both `scribe` and `observer` from each rotated snapshot.
- The daemon can queue:
  - `auditor` after enough completed scribes and active deltas.
  - `observer` after enough completed scribes.
  - `compressor` after enough completed observers.
  - `dreamer_v3` after compressor completion.
  - `memory_analysis` once per day after the configured local hour.
  - `notion_sync` once per day when enabled/configured.
  - `skillforge` and `skillforge_refresh` during each housekeeping tick.
  - `scribe` from stale conversation buffers.

## Questions And Discrepancies

1. **Resolved: v3 is active by default.**
   `GRAPH_MEMORY_V3=0` is now the emergency fallback switch. README and Docker startup were aligned with the live daemon behavior.

2. **Resolved: session-start uses the formal v3 context builder first.**
   Claude Code, OpenCode, and Pi now load `session-start-v3` through the normal dynamic import path and fall back only when v3 data is unavailable or the builder fails.

3. **Is project doc bootstrap active or abandoned?**
   `maybeEnqueueBootstrapFromObserver()` exists and `bootstrapProjectDoc` is implemented, but no live call site was found during the initial daemon trace. `detectDocDrift` is imported in `daemon.ts` but not used.

4. **Should graph-level jobs be strictly serialized?**
   `GRAPH_LEVEL_TYPES` only includes `auditor`, `librarian`, and `dreamer`. The daemon computes `graphLevelBlocked` once before the claim loop. If multiple graph-level jobs are queued before the loop starts, it can claim more than one in the same tick because the block state is not recomputed after claiming the first job.

5. **Should v3 graph-level jobs also block graph mutation?**
   `compressor`, `dreamer_v3`, `bootstrap_project_doc`, `skillforge`, `skillforge_refresh`, `notion_sync`, and `working_update` can all write graph-adjacent files, but they are not in `GRAPH_LEVEL_TYPES`.

6. **Is OpenCode session lifecycle too aggressive?**
   On `session.idle`, OpenCode processes messages, rotates if threshold is reached, then always performs a final flush if `messageCount > 0` and disables capture. That appears to treat every idle event as an end-of-session boundary, which may create many small snapshots.

7. **Resolved: OpenCode v3 context loading no longer uses `require()`.**
   The extension imports `session-start-v3.js` in `loadCore()` and calls the loaded functions from the prompt hook.

8. **Why does daemon import formatting have a joined import?**
   `daemon.ts` has `import { listManifests, findDriftedManifests } from "./skillforge-manifest.js";import { getAssistantTracePath, getToolTracePath } from "../session-trace.js";`. It compiles, but it is a polish/maintainability smell.

9. **Should stale buffer scavenging queue observer too?**
   Normal OpenCode snapshot rotation queues both `scribe` and `observer`, while Claude/session-end queues only `scribe` and daemon later derives observer from completed scribes. Stale buffer scavenging queues only `scribe`. Need to decide the intended consistency model.

10. **Partially resolved: README now documents the unified v3-first model.**
    SPEC still reads like historical implementation planning and MCP/command docs may still reference older marker names like `scribePending` and `consolidationPending`.

11. **Resolved: durable graph storage is unified on `nodes/`.**
    `CONFIG.paths.v3Graph` now points at `CONFIG.paths.nodes`; `CONFIG.paths.v3GraphArchive` points at `archive/`. `graph/.index.json` remains the v3 lookup index location.

12. **Resolved: observer upserts update indexes.**
    `processUpsertNode()` now updates the v3 index incrementally, and `processObserverOutputs()` rebuilds the v2 index after node upserts.

13. **Observer success criteria are weak.**
    SPEC says observer output should be validated and must produce at least one observation or `log_session`. `runObserver()` currently treats a zero-output run as successful unless the worker exits non-zero.

14. **Resolved: compressor and v3 archive now target the unified paths through config.**
    Because `CONFIG.paths.v3Graph` and `CONFIG.paths.v3GraphArchive` map to `nodes/` and `archive/`, compressor archival and index rebuilds operate on the active graph.

15. **Resolved in tests: Notion fixtures now populate `nodes/`.**
    The dirty local Notion change is consistent with the unified graph-store decision.

16. **Resolved: README command list includes Notion commands.**
    `/notion-setup`, `/notion-sync`, and `/notion-consolidate` are now listed.

17. **OpenCode installer's final command list is stale.**
    `bin/install-opencode.sh` symlinks every file in `opencode-commands/*.md`, but the final printed "Commands installed" list omits `/memory-connect-inputs`, `/memory-input-refresh`, `/notion-setup`, `/notion-sync`, `/notion-consolidate`, and `/refresh-skill`.

18. **Claude plugin manifest skills omit several command skills.**
    `.claude-plugin/plugin.json` lists commands for Notion and refresh-skill, but its `skills` array does not include Notion-related skills or `refresh-skill`. This may be intentional if those are command-only, but it is inconsistent with the richer command surface.

19. **Manual refresh-skill command points at a likely invalid package path.**
    `opencode-commands/refresh-skill.md` suggests importing from `$HOME/.graph-memory/node_modules/graph-memory/...`; the plugin installs from the repo/symlink and runtime storage is not a Node package install root by default.

20. **Resolved: Docker no longer force-passes `GRAPH_MEMORY_V3=1`.**
    Runtime defaults live in config, where v3 is enabled unless explicitly set to `0`.

21. **Harness adapter classes look mostly test/documentation-only.**
    `src/graph-memory/adapters/*` implement the documented adapter pattern, but the actual Claude hooks and OpenCode extension use their own direct logic. Current live paths do not appear to route through `createAdapter()` or `buildSessionStartContext()`.

22. **Adapter shared session-end queues observer directly.**
    If adapters become live, `flushAndQueueJobs()` queues both `scribe` and `observer` against the same snapshot path. Both worker prompts instruct deletion for snapshot-mode jobs; if both run concurrently, one can delete the other's input.

## Verification Snapshot

Ran `npm test` on 2026-05-18 before the unification patch. Build completed, tests failed 5/89:

- `tests/notion-sync.check.mjs`: fresh diff no longer includes graph nodes.
- `tests/notion-sync.check.mjs`: synced-state update detection found 0 updated items.
- `tests/notion-sync.check.mjs`: batch assignment test hits `undefined`.
- `tests/release-surface.check.mjs`: README missing `/notion-setup`.
- `tests/v3-pipeline.check.mjs`: observer upsert expected `graph/patterns/incremental-refactor.md`, but no file existed.

These failures were used as the acceptance target for the first unification pass.

Re-ran `npm test` after the patch set on 2026-05-18: 89/89 passing.

## Dashboard Follow-Up

Audited `/Users/patrick/Desktop/agent_memory/memory-dashboard` after the v2/v3 storage unification. The cockpit needed wiring changes:

- Primary graph/project/health reads now prefer `graph/.index.json` when populated and fall back to the legacy `.index.json` when the v3 index exists but is empty.
- Active graph views exclude legacy archived node folders under `nodes/.archive/` and `nodes/archive/`.
- Archive views include `archive/` plus the legacy archived folders under `nodes/`.
- Startup context now reports actual v3 session-start layers: global whisper, guardrails, project whisper, recent session log, and pickup block.
- Node edits update both index files when possible so inline dashboard edits do not leave the graph panel stale.

Live endpoint check on 2026-05-18:

- `/api/status`: 695 active nodes, 1652 archived nodes.
- `/api/graph`: 695 active graph nodes, 0 archived nodes included in graph explorer data.
- `/api/v3/status`: 695 v3-visible nodes, 1 anti-pattern, 4 project lenses.

## Files To Inspect Next

- `pipeline/observer-tools.ts`, `compressor-tools.ts`, and `dreamer-v3-tools.ts` for output validation and cleanup behavior.
- `pipeline/mechanical-apply.ts`, `graph-ops.ts`, `librarian.ts`, and `dreamer.ts` for the v2 mutation path.
- `project-working.ts`, `working-files.ts`, and active project tracking for project handoff correctness.
- Notion sync modules and tests, especially because several dirty local edits currently touch this pipeline.
- install scripts for Claude/OpenCode/pi release surface and dist/source assumptions.
