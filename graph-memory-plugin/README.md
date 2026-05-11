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
- loads compact context artifacts like `MAP.md` and `PRIORS.md` into new sessions
- supports Claude Code (MCP + hooks), OpenCode (native plugin), and pi (extension)
- optionally runs a background `scribe -> auditor -> librarian -> dreamer` pipeline in Docker
- keeps git history for memory changes so you can inspect or revert them

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

Resources:

| Resource | Description |
|----------|-------------|
| `graph://map` | compressed knowledge map |
| `graph://priors` | learned behavioral priors |

## Configuration

| Config | Source | Default |
|--------|--------|---------|
| graph root pointer | `~/.graph-memory-config.yml` | `~/.graph-memory/` |
| per-graph settings | `<graphRoot>/config.yml` | git enabled |
| runtime config | `<graphRoot>/.runtime-config.json` | `manual` |

## Development Notes

- build: `npm run build`
- test: `npm test`
- type-check: `npx tsc --noEmit`
- Claude Code plugin manifest: [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)
- OpenCode extension: [`extensions/graph-memory-opencode.ts`](./extensions/graph-memory-opencode.ts)
- pi extension: [`extensions/graph-memory.ts`](./extensions/graph-memory.ts)
- memory section templates: [`templates/`](./templates/)
- examples: [`../examples/`](../examples/)
