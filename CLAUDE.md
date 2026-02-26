# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This repository contains a single-file React component (`memory_implementation`) that serves as an interactive specification and implementation guide for **graph-memory** — a persistent, self-evolving memory system for AI agents. The file is not a runnable app; it's a rich documentation artifact rendered as a tabbed React UI.

## Architecture of the Specification

The `memory_implementation` file is a React component with inline styles (no external CSS) organized into 7+ tabs:

- **Tab 0 (VisionTab)**: Problem statement, design philosophy, three divergences (implicit memory, dreaming, embodied experience)
- **Tab 1 (ProjectStructureTab)**: Full project layout for `graph-memory/`, package.json, and `src/config.ts`
- **Tab 2 (SessionLifecycleTab)**: Session boundary detection, MessageBuffer, scribe triggering, lifecycle diagrams, edge cases
- **Tab 3 (GraphRetrievalTab)**: MCP tool definition (`graph_memory`), three retrieval pathways (direct, edge traversal, semantic search), index structure
- **Tab 4 (GitTab)**: Auto-commit strategy, commit message format, recovery/rollback patterns
- **Tab 5 (ParallelScribesTab)**: Concurrency model, delta file structure, scribe-to-librarian handoff, API cost estimates
- **Tab 6 (ImplementationTab)**: Phased build plan (6 phases over ~10 days)

Helper components: `Code`, `Note`, `Label`, `P`, `B`, `I`, `M` — all inline-styled with a dark theme color palette defined in the `C` constant.

## The System Being Specified

The graph-memory system has 5 core components:

1. **The Graph** — Markdown files as knowledge nodes with YAML frontmatter (confidence, edges, somatic markers, decay). Filesystem IS the database.
2. **MAP.md** — Compressed index of all nodes (~50-80 tokens each). Always loaded into agent context. Acts as the "hippocampus."
3. **PRIORS.md** — Behavioral instructions derived from cross-session patterns. Loaded before MAP to shape agent behavior implicitly.
4. **Scribe Pipeline** — Background Haiku agents that extract deltas every 5 messages. Fire-and-forget, never block conversation.
5. **Consolidation Pipeline** — Post-session: Librarian (reconcile deltas, update graph), Dreamer (temp=1.0 creative recombination), Git auto-commit.

Key design decisions:
- No vector databases or embeddings — keyword search on curated gists is sufficient for 50-100 node graphs
- Node paths map directly to filesystem paths (`acellus/ace` → `graph/nodes/acellus/ace.md`)
- Session boundaries detected by idle gaps (5 min), not explicit commands
- `simple-git` for version control, `@anthropic-ai/sdk` for API calls, `gray-matter` for frontmatter parsing
- Scribe uses Haiku (cheap, fast), Librarian and Dreamer use Sonnet
- Dreamer runs at temperature 1.0; dream fragments incubate across sessions

## Tech Stack (of the specified system, not this file)

- Node.js + TypeScript (ESM)
- `tsx` for execution
- `@anthropic-ai/sdk` for Claude API calls
- `simple-git` for git automation
- `gray-matter` + `js-yaml` for markdown frontmatter
- `chokidar` for file watching
- No framework, no vector DB, no external infrastructure
