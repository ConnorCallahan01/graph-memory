# Repository Layout

This repository contains both the current product and earlier prototype/reference material. The public entrypoint is the plugin in [`graph-memory-plugin/`](../graph-memory-plugin/).

## Active Directories

### `graph-memory-plugin/`

Current installable product surface.

- `src/graph-memory/`: graph logic, MCP server, runtime configuration, and pipeline
- `src/hooks/`: Claude Code hook entrypoints
- `bin/`: install, runtime, Docker, and hook shell wrappers
- `commands/`: slash command specs installed into Claude Code
- `agents/`: background agent instructions
- `skills/`: memory skill instructions and invocable recall skill
- `.claude-plugin/`: plugin manifest metadata

### `memory-dashboard/`

Optional local inspection UI for graph state, logs, jobs, briefs, deltas, and context artifacts.

### `docs/`

Public-facing repository documentation.

### `examples/`

Concrete usage examples for commands, MCP actions, skills, and Agent SDK integration.

## Legacy Or Reference Material

These paths are kept for context and design history. They are not required for plugin installation or normal usage.

### Root `src/`, `tests/`, `public/`, and `package.json`

Earlier prototype server/application path. Useful if you want to study the project’s earlier architecture, but not part of the current plugin install flow.

### `graph-memory/`

Reference directory kept from earlier iterations. Not part of the current install path.

### `test-app/`

Prototype sandbox directory, not part of the supported public workflow.

## What To Edit For Public Documentation

If you are improving the public-facing repo, prioritize:

1. `README.md`
2. `docs/setup-from-clone.md`
3. `examples/`
4. `graph-memory-plugin/README.md`
5. `graph-memory-plugin/.claude-plugin/plugin.json`

Do not assume the legacy root prototype is safe to delete without a dedicated migration pass.
