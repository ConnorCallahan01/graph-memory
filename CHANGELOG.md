# Changelog

All notable changes to graph-memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Notion sync pipeline** — two-way sync between graph-memory and a Notion workspace for human-readable access to graph state. Outbound mirrors graph state as wiki pages, database rows, and project pages. Inbound detects human edits and creates observations/deltas. Three-way merge with human intent winning. Chunked sync (100/batch), consolidation, daemon daily trigger. MCP actions: `notion_setup`, `notion_sync`, `notion_consolidate`. Slash commands for Claude Code and OpenCode. Design spec: `graph-memory-plugin/docs/notion-sync-spec.md`.
- **Notion CLI adapter** (`notion-cli.ts`) — wraps `ntn` CLI for all Notion API calls. Supports Notion API v2026-03-11 with data sources for property management.
- **Notion workspace setup** (`notion-setup.ts`) — creates Notion workspace structure (parent page, 3 databases, wiki pages per category) with schema-aware property configuration.
- **Notion inbound + merge** (`notion-inbound.ts`) — detects human edits in Notion, creates observations/deltas (not direct node mutations), three-way merge when both sides change.
- **Dashboard skills viewer** — new Skills section on the landing page with card grid showing all generated skills. Click to expand and read the full slash command markdown content. New `/api/skills/:name/content` endpoint.
- **Dashboard Notion sync visibility** — Notion Sync as pipeline step 7 with purple accent in the pipeline flow diagram. Pipeline cutoffs show sync status, last sync time, page/row counts, and in-flight state.
- **Skillforge pipeline** — the background daemon now scores frequently-accessed memory nodes and automatically converts high-scoring candidates into executable skill/command files that agents can invoke as slash commands. Includes scoring (`skillforge-score.ts`), manifest tracking (`skillforge-manifest.ts`), a skillforge agent (`agents/memory-skillforge.md`), and daemon job types `skillforge` and `skillforge_refresh`.
- **`/refresh-skill` command** — new slash command (Claude Code and OpenCode) for manually refreshing a skillforged skill whose source node has drifted.
- **Drift detection and auto-refresh** — the daemon compares content hashes of skillforged nodes against their manifests each tick and enqueues `skillforge_refresh` jobs when the source content has changed.
- **Recall and access tracking** — nodes now track `recall_action_count`, `distinct_sessions`, and `access_sessions` in both frontmatter and the index. `updateLastAccessed` accepts `actionType` and `sessionId` to distinguish reads from recalls and count unique sessions.
- **Per-session conversation buffers** — the OpenCode plugin now writes each session to its own `conversation-{sessionId}.jsonl` file instead of a shared `conversation.jsonl`, preventing cross-session writes. Stale buffers are scavenged on daemon tick.
- **Project-aware scribe payloads** — rotated snapshots from both the OpenCode and pi plugins include the current project in the scribe job payload so downstream pipeline stages can scope correctly.
- **Skills section in daily analysis** — the memory analysis agent now receives and reports on skillforged skills (active, stale, unused) in the daily brief.
- **Librarian skillforge unpin rule** — nodes marked `skillforged_at` are automatically unpinned by the librarian, since the skill file replaces the pinned loading mechanism.
- **Daemon concurrency** — `daemonConcurrency` config field (default 3) controls how many jobs the daemon runs in parallel.
- **Dockerfile fix** — OpenCode binary installed via GitHub releases tarball instead of the shell installer, with arch-aware `GOARCH` resolution.

### Changed

- **OpenCode event property access** — `session.created` reads `info.id` instead of `id`; `session.idle` and `session.deleted` read `sessionID` instead of `id`, matching the current OpenCode plugin API.
- **OpenCode `message.updated` handler** — now fetches messages from the session API instead of relying on the event payload directly, improving reliability of user message capture and ambient recall.
- **`conversationLog` path removed** — replaced by per-session buffer files; `CONFIG.paths.conversationLog` is no longer used.
- **Symlink-safe dist resolution** — the OpenCode plugin resolves its `dist/` directory through `fs.realpathSync` to handle symlinked installs correctly.

### Fixed

- **Observer stale file poison** — `processObserverOutputs` failed on stale observation files from prior runs that were never cleaned up, poisoning every subsequent run. Failed observation files are now unlinked after error.
- **Session log ENOENT** — `appendSessionLog` threw ENOENT for project names with `/` (e.g. `Keel3/keel3_oliver_demo`) because the parent directory wasn't created. Parent directories are now ensured before appending.
- **Working update type error** — `normalizeBullet` in working update threw `text.replace is not a function` when LLM agents wrote non-string values into JSON artifact arrays. Now guarded with `typeof` check.
- **Decay archival stall** — decay archival was stalled by over-broad category protection that was skipping archive targets.
- **Dashboard crash on unknown job types** — `readAllJobs` crashed on unknown job types. Added dynamic fallback for any job type not in the `byType` map.
- **Daemon log spam** — `reconcileProjectWorkingBacklog()` re-processed scribe jobs with invalid project paths (`private/tmp`) every tick. Now skips projects starting with `private/`, `tmp/`, or `/`.
- **Skillforge infinite creation/refresh loop** — `skillforged_at` was written to node frontmatter but never synced to the index, so the cooldown check always passed. Content hashing included volatile tracking fields (`access_count`, `last_accessed`), causing every access update to trigger a refresh. The scorer also didn't check for existing manifests. All three root causes fixed; daemon now writes authoritative post-refresh hash to manifests.
- **Stale job recovery** — `requeueStaleRunningJobs` now runs every daemon tick (30-minute threshold) instead of only at startup, preventing zombie workers from blocking the pipeline indefinitely.
- **Skillforge scoring data gap** — `sessionId` is now threaded through access tracking (plugin → tool → `updateLastAccessed`) so `distinct_sessions` and `recall_action_count` are populated correctly instead of always being zero.

## [2.2.0] — 2026-05-06

### Added

- **OpenCode as a pipeline worker provider** — `opencode` is now a first-class harness option alongside codex, claude, and pi for the background daemon pipeline. The `opencodeAdapter` spawns `opencode run` in non-interactive mode with `--dangerously-skip-permissions`.
- **OpenCode auth scripts** — `bin/docker-opencode-auth-status.sh` and `bin/docker-opencode-import-host-auth.sh` for checking and importing opencode provider credentials into the Docker daemon container.
- OpenCode listed as a harness option in `/memory-onboard`, `/memory-switch-harness`, MCP tool description, and zod schema.

## [2.1.0] — 2026-05-06

### Added

- **OpenCode plugin extension** (`extensions/graph-memory-opencode.ts`) — native OpenCode plugin that registers the `graph_memory` tool, injects context files (MAP, PRIORS, SOMA, WORKING, DREAMS) at session start, performs ambient auto-recall on user messages, and captures conversation for the scribe pipeline.
- **`bin/install-opencode.sh`** — installer that symlinks the OpenCode extension and slash commands into `~/.config/opencode/` and registers the MCP server (disabled by default) in `opencode.json`.
- **`opencode-commands/`** — 7 slash commands for OpenCode (`memory-onboard`, `memory-status`, `memory-search`, `memory-morning-kickoff`, `memory-connect-inputs`, `memory-input-refresh`, `memory-wire-project`).
- **`templates/OPENCODE-memory-section.md`** — memory instruction template for wiring into OpenCode project `AGENTS.md` files.
- **`.dockerignore`** — excludes unnecessary files from Docker builds.
- Updated documentation across `CLAUDE.md`, `README.md`, `graph-memory-plugin/README.md`, and `docs/setup-from-clone.md` to reflect OpenCode as a supported harness alongside Claude Code and pi.
- **Release workflow** (`.github/workflows/release.yml`) — creates a GitHub Release automatically on merge to master, using the version from `graph-memory-plugin/package.json` and the `[Unreleased]` section from `CHANGELOG.md`.

### Changed

- **`package.json`** description updated to mention OpenCode; `opencode-commands/` added to files array.

### Fixed

- Patched npm audit vulnerabilities.

## [2.0.0] — 2026-05-04

### Added

- **pi coding agent harness** — pi is now a supported worker provider alongside codex and claude. The Docker image includes `@mariozechner/pi-coding-agent`, and new scripts (`docker-pi-auth-status.sh`, `docker-pi-import-host-auth.sh`) handle pi auth import into the container. Pipeline spawner and worker-runner both support pi as a dispatch target.
- **`/memory-switch-harness` command and skill** — switch the background pipeline worker between codex, claude, and pi without manual config editing.
- **Memory skills suite** — standalone skills for `/memory-onboard`, `/memory-search`, `/memory-status`, `/memory-morning-kickoff`, `/memory-wire-project`, `/memory-connect-inputs`, `/memory-input-refresh`, and `/recall`.
- **`CHANGELOG.md`** — this file, tracking notable changes in keepachangelog format.

### Changed

- **Project-aware WORKING.md** — pipeline context regeneration now respects the active project scope, preventing non-project-aware runs from overwriting WORKING.md with global-only content.
- **CLAUDE.md** wired with idempotent graph-memory section via `/memory-wire-project`.
- **Agent instructions** updated for memory-onboarder and memory-working-updater.
- **Auth check** generalized to detect the active worker provider and validate the correct harness auth.
- **MCP server** and runtime config now support `workerProvider` as a first-class field.

### Fixed

- **WORKING.md project drift** — non-project-aware `regenerateAllContextFiles()` could overwrite project-scoped WORKING.md from other sessions. Generator now respects the configured project.
