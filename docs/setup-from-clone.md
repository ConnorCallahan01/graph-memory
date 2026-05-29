# Setup From A Fresh Clone

This is the public setup path for someone cloning the repository and installing the plugin locally.

## Prerequisites

- An AI coding agent: **Claude Code**, **OpenCode**, or **pi**
- Node.js 20+ and `npm`
- Git
- Optional: Docker Desktop if you want background daemon mode
- Optional: Codex CLI auth on the host if you want Docker workers to run bounded background jobs

## 1. Clone The Repository

```bash
git clone https://github.com/ConnorCallahan01/cogni-code.git
cd cogni-code
```

The plugin lives in [`graph-memory-plugin/`](../graph-memory-plugin/). The root `src/` and `tests/` directories are legacy prototype material and are not required for installation.

## 2. Install The Plugin

### Claude Code

```bash
cd graph-memory-plugin
./bin/install.sh
```

What `./bin/install.sh` does:

1. Installs plugin dependencies if needed
2. Builds the TypeScript sources into `dist/`
3. Symlinks the plugin into `~/.claude/plugins/graph-memory`
4. Registers the MCP server in `~/.claude.json`
5. Installs slash commands into `~/.claude/commands/`
6. Registers Claude Code hooks in `~/.claude/settings.json`

### OpenCode

```bash
cd graph-memory-plugin
./bin/install-opencode.sh
```

What `./bin/install-opencode.sh` does:

1. Installs plugin dependencies if needed
2. Builds the TypeScript sources into `dist/`
3. Symlinks the OpenCode extension into `~/.config/opencode/plugins/`
4. Symlinks slash commands into `~/.config/opencode/commands/`
5. Registers the MCP server (disabled by default) in `~/.config/opencode/opencode.json`

The OpenCode plugin registers the `graph_memory` tool directly — no separate MCP server is needed for normal usage. The registered MCP server is available as a fallback for other MCP clients.

If you prefer to do this manually, inspect the install scripts first and mirror those steps yourself.

## 3. Start Your Agent And Onboard

Start a new Claude Code or OpenCode session, then run:

```text
/memory-onboard
```

The onboarding flow will:

1. Check whether graph memory is already initialized
2. Ask where to store the graph root
3. Help you choose runtime mode
4. Seed initial memory nodes and priors

Default graph storage:

- pointer file: `~/.graph-memory-config.yml`
- default graph root: `~/.graph-memory/`

## 4. Choose A Runtime Mode

### Manual mode

Use this if you only want the MCP tool and on-demand memory operations.

- No daemon container
- No background worker queue
- Good for simple local testing

### Docker daemon mode

Use this if you want the full background pipeline.

- Host Claude Code remains the interactive environment
- The graph root stays on the host filesystem
- A Docker container runs the daemon and bounded workers
- Recommended for normal use

Configure runtime through onboarding or directly with:

```text
graph_memory(action="configure_runtime", runtimeMode="manual")
graph_memory(action="configure_runtime", runtimeMode="docker")
```

## 5. If You Choose Docker

Run the harness-agnostic helpers from [`graph-memory-plugin/bin/`](../graph-memory-plugin/bin/):

```bash
./bin/docker-bootstrap.sh
./bin/docker-auth-check.sh
```

The auth-check script detects which worker harness (codex, claude, or pi) is active and validates the correct auth.

If worker auth is missing:

```bash
# For codex:
codex login
./bin/docker-codex-import-host-auth.sh

# For pi:
./bin/docker-pi-import-host-auth.sh
```

Worker-specific auth:

- `./bin/docker-codex-login.sh`
- `./bin/docker-codex-login-api-key.sh`
- `./bin/docker-pi-auth-status.sh`

Useful Docker helper scripts:

- `./bin/docker-build.sh`
- `./bin/docker-start.sh`
- `./bin/docker-status.sh`
- `./bin/docker-healthcheck.sh`
- `./bin/docker-doctor.sh`
- `./bin/docker-stop.sh`

## 6. Ngrok (Required for Notion Webhooks)

If you plan to use Notion sync with webhooks, you need an ngrok tunnel forwarding to the daemon:

```bash
ngrok http 3100
```

Copy the public URL from the ngrok dashboard and set it as your Notion integration's webhook endpoint at `{ngrok-url}/notion-webhook`. Free-tier URLs rotate on restart — update Notion after each `ngrok` restart.

Skip this step if you are not using Notion webhooks.

## 7. Verify The Install

Inside Claude Code:

```text
/memory-status
```

You should see:

- `initialized: true`
- a valid graph root
- runtime information
- node count
- pending job counts

You can also test the MCP tool directly:

```text
graph_memory(action="status")
graph_memory(action="remember", path="notes/first_run", gist="Initial install verified", content="The plugin loaded correctly after onboarding.", tags=["setup"], confidence=0.8)
graph_memory(action="search", query="first run")
```

## 8. Wire Memory Into Your Projects

After the plugin and onboarding are confirmed, wire graph-memory awareness into your project so the agent knows how to use memory:

```text
/memory-wire-project
```

This inserts a `<!-- BEGIN graph-memory plugin section -->` / `<!-- END graph-memory plugin section -->` block into the project's `CLAUDE.md` (for Claude Code) or `AGENTS.md` (for OpenCode), or creates the file if it doesn't exist. The content teaches the agent when to recall, when to remember, how to use the tool, and not to mention the memory system unless asked.

For OpenCode, you can also manually copy `templates/OPENCODE-memory-section.md` into your project's `AGENTS.md`.

The command is idempotent — safe to re-run on a project that already has the section installed.

## 9. Optional Dashboard

The dashboard is not required for the plugin to work. It is a separate inspection UI for local development and debugging.

From the repository root:

```bash
cd memory-dashboard
npm install
npm run dev
```

In a second terminal:

```bash
cd memory-dashboard
npx tsx server.ts
```

Default ports:

- frontend: `http://localhost:5173`
- API: `http://localhost:3001`

## 10. Troubleshooting

### Claude Code

If slash commands do not appear:

- restart Claude Code
- confirm the plugin is symlinked under `~/.claude/plugins/graph-memory`
- confirm commands exist under `~/.claude/commands/`

If `graph_memory` is missing:

- open `/mcp`
- confirm `graph-memory` is registered
- check `~/.claude.json` for the MCP server entry

### OpenCode

If slash commands do not appear:

- restart OpenCode
- confirm the plugin is symlinked under `~/.config/opencode/plugins/graph-memory.ts`
- confirm commands exist under `~/.config/opencode/commands/`

If `graph_memory` is missing:

- confirm the extension symlink points to `extensions/graph-memory-opencode.ts`
- check `~/.config/opencode/opencode.json` for the plugin registration

### Docker

If Docker mode is unhealthy:

- run `./bin/docker-doctor.sh`
- run `./bin/docker-auth-check.sh`
- verify Docker Desktop is running

If you are contributing to the repo rather than just installing it, read [docs/repository-layout.md](./repository-layout.md) next.
