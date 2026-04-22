# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

This repository contains **graph-memory** — a persistent, self-evolving knowledge graph memory system for AI agents.

Active surfaces:

- **`graph-memory-plugin/`** — The current plugin. MCP server, hooks, runtime helpers, slash commands, skills, and agents.
- **`memory-dashboard/`** — Optional inspection UI for graph state, logs, jobs, and briefs.

Legacy/reference material:

- root **`src/`**, **`tests/`**, **`public/`**, and root **`package.json`** — earlier prototype path, not the current install surface

## Repository Structure

```text
graph-memory-plugin/
  src/graph-memory/       # Core graph logic, runtime, inputs, pipeline
    pipeline/             # daemon, queue, graph ops, librarian, dreamer, preflight
  src/hooks/              # Claude Code hooks
  agents/                 # Background agent instruction files
  commands/               # Slash command specs
  skills/                 # Memory skill + /recall
  bin/                    # Install, runtime, Docker, and hook shell wrappers

memory-dashboard/
  server.ts               # Express API server (port 3001)
  src/                    # React frontend (Vite, port 5173)
    components/           # Graph, jobs, logs, briefs, and context viewers
    lib/api.ts            # Typed API client

~/.graph-memory/          # The actual graph data (outside this repo)
  nodes/                  # Active knowledge nodes
  archive/                # Archived nodes
  dreams/                 # pending/, integrated/, archived/
  briefs/                 # Daily brief outputs
  .deltas/                # Scribe output
  .jobs/                  # Background queue state
  .pipeline-logs/         # Worker logs
  MAP.md, PRIORS.md, SOMA.md, WORKING.md, DREAMS.md  # Context files
```

## Build & Verify

```bash
cd graph-memory-plugin && npm run build
cd graph-memory-plugin && npx tsc --noEmit
cd memory-dashboard && npx tsc --noEmit
```

## Pipeline Architecture

The memory system runs automatically via Claude Code hooks:

1. **Session hooks** capture startup context, user prompts, assistant responses, and tool traces.
2. **Scribe** extracts deltas from buffered session state.
3. **Auditor** does mechanical triage and produces structured recommendations.
4. **Librarian** applies judgment-heavy graph updates and regenerates context files.
5. **Dreamer** creates speculative cross-node fragments.
6. **Git** records graph history for rollback.

Context files loaded at session start:

- **PRIORS.md** — Cognitive model (how the agent should think)
- **SOMA.md** — Emotional engagement calibration
- **MAP.md** — Compressed knowledge index
- **WORKING.md** — Volatile working memory
- **DREAMS.md** — Pending dream fragments

## Using The Memory System

The `graph_memory` MCP tool is available in Claude Code sessions after installation. Common actions:

### Recall

```text
graph_memory(action="recall", query="oliver provisioning", depth=1)
```

### Remember

```text
graph_memory(action="remember", path="patterns/new-pattern", gist="One-sentence summary", content="Full details...", tags=["tag1"], confidence=0.7, edges=[{target: "other/node", type: "supports"}])
```

### Other Actions

- `read_node`
- `search`
- `list_edges`
- `status`
- `history` / `revert`
- `initialize` / `configure_runtime`
- `consolidate`

## Key Design Decisions

- **Filesystem is the database** — markdown files with YAML frontmatter
- **Keyword retrieval over curated gists** — simple and inspectable
- **Archive with recall, not delete** — stale nodes can be resurfaced
- **Git tracks changes** — every consolidation is recoverable
