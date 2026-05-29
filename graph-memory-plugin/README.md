# graph-memory plugin

Persistent, graph-backed memory for Claude Code, OpenCode, and compatible agent workflows.

```text
      o----o----o
     / \  / \    \
    o---oo---o----o
     \  / \  |   /
      o----o-o--o
            \  /
             o

      C O G N I - C O D E
      graph-memory onboarding
```

This directory is the active plugin surface in the repository. If you cloned the repo, install from here rather than from the legacy root prototype.

## What It Does

- remembers preferences, decisions, project context, and recurring patterns across sessions
- exposes a `graph_memory` tool for search, recall, remember, inspection, and maintenance
- loads compact context into new sessions via **mental model injection**, with the older full-context path kept as a fallback
- supports Claude Code (MCP + hooks), OpenCode (native plugin), and pi (extension)
- runs a background pipeline that extracts observations, compresses mental models, and generates creative associations
- keeps git history for memory changes so you can inspect or revert them

## Architecture

### Merged v2/v3 Hybrid

The system runs a merged v2/v3 hybrid architecture:

- **v2 provides**: knowledge graph (`nodes/`), MAP, WORKING, DREAMS, pinned nodes, decay, context regeneration
- **v3 provides**: mental models (`mind/`), observations, session logs, project lenses
- **Single canonical node store**: `nodes/` — the diverged `graph/` directory has been archived to `archive/v3-graph-backup/`

The durable graph is stored once in `nodes/`; the v3 mental-model layers compress that graph into low-token session context.

**Layers:**

| Layer | Storage | Purpose |
|-------|---------|---------|
| Layer 1: Global Mind | `mind/model.json`, `mind/whisper.txt` | Cognitive style, preferences, guardrails, emotional profile |
| Layer 2: Project Lenses | `lenses/{project}/` | Per-project tech stack, conventions, active work, open threads |
| Layer 3: Session Logs | `sessions/{project}.jsonl` | Per-session records of shipped work, decisions, next-session hints |
| Layer 4: Graph | `nodes/` | Durable knowledge nodes with edges, confidence, and decay |

### Pipeline

```text
Session → Scribe → Auditor → Librarian → Dreamer
                       ↓           ↓
                  recommendations   graph updates
                                    context regeneration
```

All four pipeline prompts were improved to capture "true memory" — evolving opinions, frustrations, contradictions, half-formed ideas — not just hard facts. The auditor now prioritizes stale/contradictory node detection, and the librarian follows a prune-over-preserve philosophy.

### Session Start

Session-start uses a single injection path:

**mental-model (model.json direct, unconditional) → MAP (per-project) → PINNED (project-gated) → WORKING**

Both the merged path and the fallback share the same underlying durable nodes. Set `GRAPH_MEMORY_V3=0` only for emergency fallback while debugging the context path.

### v2/v3 Pipeline Stages

The v2 pipeline (scribe → auditor → librarian → dreamer) is the active, proven pipeline. Observer, compressor, and dreamer-v3 stages are present but not active by default — they can be re-enabled with `GRAPH_MEMORY_V3=1`. All stages read and write the same durable node files in `nodes/`, while `mind/`, `lenses/`, and `sessions/` hold compressed context layers.

### Notion Sync

Two-way sync between graph-memory and a Notion workspace for human-readable access. Five steward agents manage scoped areas:

| Steward | Scope |
|---------|-------|
| Knowledge | Knowledge nodes → Notion wiki pages |
| Project | Project lenses → Notion project pages |
| Tasks | Working state → Notion task database |
| Enrichment | Dreams, briefs → Notion databases |
| Workspace | Workspace manifest, structure |

**Outbound sync** uses a diff + plan + execute cycle, chunked at 100 items per batch. The daemon auto-enqueues the next batch after each completed cycle.

**Inbound sync** detects human edits in Notion via webhooks and creates observations/deltas (not direct node mutations). Ngrok tunnels webhook traffic to the daemon on port 3100.

**Three-way merge** — when both sides change, human intent wins with agent info preserved as callouts.

**Commands:** `/notion-setup`, `/notion-sync`, `/notion-consolidate`

### Harness Adapters

The core is harness-agnostic via an adapter system:

```text
adapters/
  types.ts        — HarnessAdapter interface, HarnessType, AdapterConfig
  claude-code.ts  — Claude Code (hooks + MCP)
  opencode.ts     — OpenCode (plugin events + MCP)
  pi.ts           — Pi (plugin events + MCP)
  codex.ts        — Codex (MCP only, degraded mode)
  factory.ts      — Adapter instantiation
  shared.ts       — Shared adapter logic
```

Each adapter declares capabilities and handles platform-specific session lifecycle.

## Install

### Claude Code

From the repository root:

```bash
cd graph-memory-plugin
./bin/install.sh
```

Then start Claude Code and run:

```text
/memory-onboard
```

### OpenCode

From the repository root:

```bash
cd graph-memory-plugin
./bin/install-opencode.sh
```

Then start OpenCode and run:

```text
/memory-onboard
```

Detailed clone-to-first-run instructions are in [../docs/setup-from-clone.md](../docs/setup-from-clone.md).

### Seeding the Mental Model from Existing Nodes (Legacy)

The migration script `src/graph-memory/scripts/migrate-v2-to-v3.ts` was used during the v3 transition period to populate the mental model structure from existing v2 nodes. It is now legacy — new installations build the mental model organically through the pipeline. The script does not remove or alter existing v2 data.

## Runtime Model

### Manual mode

- tool and graph storage only
- no daemon container
- useful for lightweight local testing
- works with Claude Code, OpenCode, and pi

### Docker daemon mode

- recommended for normal use
- host agent stays on the host
- graph root stays on the host filesystem
- daemon and bounded workers run in Docker against the mounted graph root

Useful helpers (harness-agnostic):

- `bin/docker-bootstrap.sh`
- `bin/docker-doctor.sh`
- `bin/docker-auth-check.sh`

Worker-specific helpers:

- `bin/docker-codex-import-host-auth.sh` / `bin/docker-codex-login.sh` / `bin/docker-codex-login-api-key.sh`
- `bin/docker-pi-import-host-auth.sh` / `bin/docker-pi-auth-status.sh`
- `bin/docker-opencode-import-host-auth.sh` / `bin/docker-opencode-auth-status.sh`

General:

- `bin/docker-stop.sh`

### Ngrok (Notion Webhooks)

If you are using Notion sync with webhooks, start an ngrok tunnel pointing at the daemon port:

```bash
ngrok http 3100
```

Free-tier ngrok URLs change on every restart — update the webhook URL in your Notion integration settings after restarting. See [docs/notion-webhook-troubleshooting.md](docs/notion-webhook-troubleshooting.md) for full details.

## Commands

Installed slash commands (available in both Claude Code and OpenCode):

| Command | Description |
|---------|-------------|
| `/memory-onboard` | Initialize storage, choose runtime mode, and seed first memory nodes |
| `/memory-status` | Report graph health, runtime state, counts, and warnings |
| `/memory-search <query>` | Search the graph index |
| `/memory-morning-kickoff` | Turn the latest brief into a focused daily kickoff |
| `/memory-connect-inputs` | Configure host-side external inputs for briefs and context enrichment |
| `/memory-input-refresh` | Refresh configured external inputs and ingest new data |
| `/memory-switch-harness` | Switch the background pipeline worker between codex, claude, pi, and opencode |
| `/memory-wire-project` | Wire (or refresh) the graph-memory section in this project's `CLAUDE.md` |
| `/notion-setup` | Configure Notion sync for a parent page or database |
| `/notion-sync` | Sync graph-memory content to Notion |
| `/notion-consolidate` | Merge batched wiki pages into category pages, apply reviewed Notion edits back into memory |
| `/refresh-skill` | Manually refresh a skillforged skill whose source node has drifted |

Claude Code also provides `/recall <query>` as a skill command with deeper graph lookup and edge traversal.

## Skillforge

Skillforge is an automatic pipeline stage that converts frequently-accessed memory nodes into executable slash-command skills. When a node crosses a scoring threshold (based on access count, recall actions, session span, pinned status, and procedural content), the daemon enqueues a `skillforge` job that:

1. Reads the source node and its connected nodes
2. Generates a structured workflow skill file
3. Writes it to `.claude/commands/` and `.opencode/commands/` in the project root
4. Creates a manifest in `<graphRoot>/.skillforge/` for tracking

Skills are automatically refreshed when their source node content changes (drift detection). The daemon compares content hashes each tick and enqueues `skillforge_refresh` jobs for drifted manifests.

Key config (`CONFIG.skillforge`):

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable skillforge scoring and job enqueueing |
| `scoreThreshold` | `0.55` | Minimum score to become a skillforge candidate |
| `cooldownDays` | `14` | Days before a skillforged node can be re-scored |
| `maxSkillsPerProject` | `15` | Cap on skills per project |
| `maxJobsPerTick` | `2` | Max skillforge jobs enqueued per daemon tick |

## Project Document Bootstrapping

The daemon can auto-generate project documentation files (CLAUDE.md / AGENT.md) from mental model data:

- Generates sections for mental model context, inject flow, and project working state
- Preserves custom sections between regenerations
- Detects drift between current model state and existing doc content
- Triggers automatically after enough project observations accumulate

## Tool

The plugin exposes one tool: `graph_memory`. In Claude Code it is registered as an MCP server; in OpenCode it is registered directly by the plugin extension.

Supported actions:

| Action | Description |
|--------|-------------|
| `initialize` | Create the graph structure and global pointer file |
| `configure_runtime` | Choose manual or Docker runtime and write runtime config |
| `status` | Report initialization state, runtime, counts, and warnings |
| `remember` | Create or update a durable graph node |
| `write_note` | Save a working note into the buffer |
| `search` | Keyword search over the graph index |
| `recall` | Search plus edge traversal |
| `read_node` | Read a node by path |
| `list_edges` | Inspect node connections |
| `read_dream` | Read dream fragments |
| `consolidate` | Run the consolidation path manually |
| `history` | Show recent git history |
| `revert` | Roll the graph back to an earlier commit |
| `resurface` | Move an archived node back into the active graph |
| `notion_setup` | Create Notion workspace structure (databases + wiki pages) |
| `notion_sync` | Run outbound sync (diff + plan + execute) |
| `notion_consolidate` | Merge batched wiki pages into category pages (supports `dryRun` option) |

Resources:

| Resource | Description |
|----------|-------------|
| `graph://map` | compressed knowledge map |
| `graph://priors` | learned behavioral priors |

## Pipeline Job Types

| Job Type | Description |
|----------|-------------|
| `scribe` | Extract deltas from conversation buffer |
| `observer` | v3: produce observations, session logs, node upserts |
| `compressor` | v3: fold observations into mental models, generate whispers |
| `auditor` | Mechanical triage of scribe deltas |
| `librarian` | Judgment-heavy graph updates and context regeneration |
| `dreamer` | v2: creative cross-node associations |
| `dreamer_v3` | v3: creative associations against compressed models |
| `working_update` | Update per-project working state from session activity |
| `skillforge` | Convert high-access nodes into slash commands |
| `skillforge_refresh` | Update drifted skillforged skills |
| `bootstrap_project_doc` | Auto-generate project documentation |
| `memory_analysis` | Daily brief and analysis generation |
| `notion_sync` | Outbound sync to Notion |
| `notion_inbound_triage` | Triage incoming Notion edits |
| `notion_inbound_enrich` | Enrich triaged Notion edits |

## Configuration

| Config | Source | Default |
|--------|--------|---------|
| graph root pointer | `~/.graph-memory-config.yml` | `~/.graph-memory/` |
| per-graph settings | `<graphRoot>/config.yml` | git enabled |
| runtime config | `<graphRoot>/.runtime-config.json` | `manual` |
| v3 enable | `GRAPH_MEMORY_V3` env var | enabled unless set to `0` |
| v3 shadow mode | `GRAPH_MEMORY_V3_SHADOW` env var | disabled unless set to `1` |

## Storage Layout

```text
~/.graph-memory/
  nodes/                    # Active durable knowledge nodes (canonical store, 22 category dirs)
  archive/                  # Archived nodes + legacy docs
    v3-graph-backup/        # Archived diverged v3 graph directory
  dreams/                   # pending/, integrated/, archived/, projects/
  briefs/                   # Daily brief outputs
    daily/
  mind/                     # Global mental model
    model.json              # cognitive style, preferences, guardrails
    whisper.txt             # pre-generated injection paragraph
    observations.jsonl      # append-only observation feed
  lenses/                   # Per-project models
    {project}/
      model.json            # project model
      whisper.txt           # project whisper
      observations.jsonl    # project observations
    _archived/              # decommissioned project lenses
  sessions/                 # Session logs
    {project}.jsonl
  working/                  # Per-project working state
    global.md
    projects/{project}.md
  .deltas/                  # Scribe output
  .jobs/                    # Background queue state
  .pipeline-logs/           # Worker logs
  .pipeline/                # Pipeline intermediate state
    observations/absorbed/  # Absorbed observation deltas
  .logs/                    # Activity log + input-refresh logs
  .inputs/                  # External brief inputs
    gmail/, calendar/, slack/  # Per-source classified/normalized/
    config.json
  .skillforge/              # Generated skill manifests
  .notion-sync-state.json   # Notion workspace sync state
  .notion-sync-input.json   # Notion sync input staging
  .notion-sync-plan.json    # Notion sync execution plan
  MAP.md                    # Knowledge graph index (context file)
  WORKING.md                # Project handoff state (context file)
  DREAMS.md                 # Speculative fragments (context file)
  PRIORS.md, SOMA.md        # Legacy context files (superseded by mental model)
```

## Dashboard

The optional `memory-dashboard/` provides a real-time inspection UI:

- **Architecture view** — mental model inspector (global model, project models, whisper preview, inject flow)
- **Graph explorer** — interactive node graph with detail panel and inline editing
- **Session replay** — per-session event timeline with tool traces
- **Activity rail** — real-time SSE feed of pipeline events, jobs, and health metrics
- **Memory health** — 4-factor health score with node count, confidence, coverage, staleness

Server: Express on port 3001. Frontend: React + Vite on port 5173.

## Development Notes

- build: `npm run build`
- test: `npm test`
- type-check: `npx tsc --noEmit`
- Claude Code plugin manifest: [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)
- OpenCode extension: [`extensions/graph-memory-opencode.ts`](./extensions/graph-memory-opencode.ts)
- pi extension: [`extensions/graph-memory.ts`](./extensions/graph-memory.ts)
- memory section templates: [`templates/`](./templates/)
- agent instructions: [`agents/`](./agents/)
- v3 pipeline agents: observer, compressor, dreamer-v3
- migration script: [`src/graph-memory/scripts/migrate-v2-to-v3.ts`](./src/graph-memory/scripts/migrate-v2-to-v3.ts) (legacy)
- Notion sync design spec: [`docs/notion-sync-spec.md`](./docs/notion-sync-spec.md)
- examples: [`../examples/`](../examples/)
