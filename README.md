# graph-memory

`graph-memory` is persistent, graph-backed memory for AI agents. The primary product in this repository is the Claude Code plugin in [`graph-memory-plugin/`](./graph-memory-plugin/), with an optional local dashboard in [`memory-dashboard/`](./memory-dashboard/).

## What It Is

Most agent workflows are stateless. `graph-memory` gives an agent durable memory that survives across sessions and gets better over time.

It does that with:

- markdown knowledge nodes with YAML frontmatter instead of a database
- a compact `MAP.md` and `PRIORS.md` that can be loaded into future sessions
- an MCP tool, `graph_memory`, for recall, search, reading, and writing memory
- optional background processing that turns buffered sessions into structured graph updates
- git-backed history so memory changes are inspectable and reversible

## Who This Is For

- Claude Code users who want the agent to remember preferences, context, and project history
- teams experimenting with long-lived agent workflows
- developers who want a memory system they can inspect on disk instead of hiding behind embeddings or a vector DB

## Quick Start

```bash
git clone https://github.com/ConnorCallahan01/graph-memory.git
cd graph-memory/graph-memory-plugin
./bin/install.sh
```

Then start Claude Code and run:

```text
/memory-onboard
```

Detailed clone-to-first-run instructions are in [docs/setup-from-clone.md](./docs/setup-from-clone.md).

## How It Works

### 1. Memory Lives On Disk

The graph root contains active nodes, archived nodes, context artifacts, and pipeline state. The default root is `~/.graph-memory/`, with a pointer file at `~/.graph-memory-config.yml`.

Core artifacts:

- `nodes/`: active memory nodes
- `archive/`: decayed or retired nodes
- `MAP.md`: compressed graph index for fast orientation
- `PRIORS.md`: behavioral priors learned from repeated patterns
- `WORKING.md`: volatile working context
- `DREAMS.md`: speculative fragments created by the dreamer pass

### 2. Claude Gets A Tool Surface

The plugin exposes one MCP tool:

- `graph_memory(action="status")`
- `graph_memory(action="search", query="...")`
- `graph_memory(action="recall", query="...", depth=1)`
- `graph_memory(action="remember", ...)`
- `graph_memory(action="read_node", path="...")`
- `graph_memory(action="list_edges", path="...")`
- `graph_memory(action="history")`
- `graph_memory(action="revert", path="<commit>")`

### 3. Optional Background Pipeline Keeps Memory Fresh

In Docker runtime mode, Claude Code stays on the host while a background daemon can process queued jobs through:

`scribe -> auditor -> librarian -> dreamer`

That pipeline extracts deltas from recent sessions, reconciles them into the graph, regenerates context files, and preserves memory history with git.

## Runtime Modes

### Manual

- simplest setup
- MCP tool and graph storage only
- no daemon container

### Docker Daemon

- recommended if you want the full background pipeline
- host Claude Code + host graph root
- bounded daemon/worker runtime in Docker

The plugin README has more runtime detail in [graph-memory-plugin/README.md](./graph-memory-plugin/README.md).

## What Gets Installed

Running `graph-memory-plugin/bin/install.sh`:

1. installs plugin dependencies
2. builds the plugin
3. symlinks it into `~/.claude/plugins/graph-memory`
4. registers the MCP server in `~/.claude.json`
5. installs slash commands into `~/.claude/commands/`
6. registers Claude Code hooks in `~/.claude/settings.json`

## Main Commands

| Command | Purpose |
|---------|---------|
| `/memory-onboard` | initialize storage, choose runtime mode, seed first memory |
| `/memory-status` | inspect graph and runtime health |
| `/memory-search <query>` | search the graph |
| `/memory-morning-kickoff` | generate a repo-specific daily kickoff from memory |
| `/recall <query>` | deep memory recall with edge traversal |

## Repository Layout

Main directories:

- [`graph-memory-plugin/`](./graph-memory-plugin/): installable plugin, hooks, commands, agents, MCP server
- [`memory-dashboard/`](./memory-dashboard/): optional local inspection UI
- [`docs/`](./docs/): setup and repository documentation
- [`examples/`](./examples/): concrete command, MCP, skill, and SDK usage

Legacy/dev-only directories still in the repo:

- [`src/`](./src/), [`tests/`](./tests/), [`public/`](./public/), [`package.json`](./package.json): earlier prototype path
- [`graph-memory/`](./graph-memory/), [`test-app/`](./test-app/): prototype/reference directories

The fuller layout notes are in [docs/repository-layout.md](./docs/repository-layout.md).

## Read Next

- [docs/setup-from-clone.md](./docs/setup-from-clone.md)
- [graph-memory-plugin/README.md](./graph-memory-plugin/README.md)
- [examples/claude-code-commands.md](./examples/claude-code-commands.md)
- [examples/mcp-tool-actions.md](./examples/mcp-tool-actions.md)
- [examples/skill-usage.md](./examples/skill-usage.md)
