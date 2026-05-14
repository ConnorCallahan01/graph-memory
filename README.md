# Cogni-Code

<div align="center">

<img src="docs/branding/cogni-code-logo.svg" alt="Cogni-Code" width="640" />

### Your AI agent remembers. Between sessions. Across projects. On disk.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Give Claude Code, OpenCode, or any MCP-compatible agent a persistent memory that lives as markdown files on your filesystem. Searchable. Editable. Diffable. Yours.

</div>

---

## How it works

```
  you talk to your agent
          │
          ▼
  ┌─────────────────┐     ┌──────────────────┐
  │   session hooks  │────▶│  graph-memory     │
  │   capture context│     │  tool (MCP)       │
  └─────────────────┘     └──────┬───────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  scribe → auditor →      │
                    │  librarian → dreamer     │
                    │  (background pipeline)   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  ~/.graph-memory/        │
                    │  nodes/   mind/          │
                    │  lenses/  sessions/      │
                    │  (markdown + JSON)       │
                    └─────────────────────────┘
```

1. **Capture** — Session hooks watch your conversations and extract what changed
2. **Process** — A background pipeline turns raw interaction into structured memory nodes
3. **Compress** — Mental models and context files are generated for fast injection
4. **Inject** — Next session starts with ~1,100 tokens of compressed behavioral context
5. **Evolve** — Memory decays when unused, archives gracefully, and can be resurfaced

---

## 60-second setup

**Claude Code:**

```bash
git clone https://github.com/ConnorCallahan01/cogni-code.git
cd cogni-code/graph-memory-plugin
./bin/install.sh
```

Then open Claude Code and run:

```
/memory-onboard
```

**OpenCode:**

```bash
git clone https://github.com/ConnorCallahan01/cogni-code.git
cd cogni-code/graph-memory-plugin
./bin/install-opencode.sh
```

Then start OpenCode and run:

```
/memory-onboard
```

That's it. The onboard wizard walks you through graph root, runtime mode, and seeds your first memory nodes.

---

## What you can do

### Remember things between sessions

```text
graph_memory(
  action="remember",
  path="preferences/deployment",
  gist="Always use blue-green deploys for production services",
  content="Blue-green for prod. Canary for staging. Never direct push.",
  tags=["preferences", "deployment"],
  confidence=0.9
)
```

### Recall them naturally

```text
/recall deployment strategy
```

Returns matching nodes plus connected knowledge (edge traversal). Works across all your projects.

### It remembers *how you think*, not just what you said

The mental model captures:
- Your cognitive style and decision patterns
- Guardrails — things you've corrected the agent on
- Frustrations and recurring friction points
- Project-specific conventions and tech stacks

Next session, the agent starts with this context injected — compressed into ~1,100 tokens.

### Watch it learn

Open the optional dashboard:

```bash
cd memory-dashboard
npm install && npm run dev
```

Real-time view of your graph, mental model, pipeline state, session history, and dream fragments. Edit nodes inline. Accept or reject dream associations. See exactly what your agent knows.

---

## The surface

### Slash commands

| Command | What it does |
|---------|-------------|
| `/memory-onboard` | First-run setup |
| `/memory-status` | Graph health, node counts, runtime state |
| `/memory-search <query>` | Keyword search across all knowledge |
| `/recall <query>` | Deep lookup with edge traversal |
| `/memory-morning-kickoff` | Start-of-day briefing from memory |
| `/memory-wire-project` | Inject graph-memory context into your project's CLAUDE.md |

### Tool actions

```text
graph_memory(action="remember")    # Write durable memory
graph_memory(action="recall")      # Search + traverse edges
graph_memory(action="search")      # Keyword search
graph_memory(action="read_node")   # Read a specific node
graph_memory(action="list_edges")  # See node connections
graph_memory(action="history")     # Git-backed change log
graph_memory(action="revert")      # Roll back to earlier state
graph_memory(action="status")      # Health snapshot
```

### Background pipeline

| Stage | Job |
|-------|-----|
| **Scribe** | Extracts deltas from conversation buffers |
| **Auditor** | Detects stale nodes, noise, contradictions |
| **Librarian** | Applies graph updates, regenerates context files |
| **Dreamer** | Creates speculative cross-node associations |
| **Skillforge** | Converts high-access nodes into slash commands |
| **Bootstrap** | Auto-generates project docs from mental models |

---

## Why this is different

**Filesystem is the database.** Every memory node is a markdown file with YAML frontmatter. Open it, grep it, edit it, back it up with your normal tools. No hidden vector store.

**Memory decays.** Nodes lose confidence over time. Stale knowledge archives itself. But it's not gone — `resurface` brings it back. Memory that grows forever is memory that becomes noise.

**Behavioral, not factual.** This isn't storing your grocery list. It's learning your decision patterns, your corrections, your guardrails. The agent gets better at working *with you*, not just at remembering *what you said*.

**Git-backed.** Every consolidation is a commit. Inspect what changed, revert mistakes, diff between sessions. Your memory has a history.

**Inspectable by design.** The dashboard shows exactly what your agent knows. No black box. Edit a node if it's wrong. Delete it if it's noise. Accept a dream if it's insightful.

---

## Where things live

```text
~/.graph-memory/
  mind/
    model.json              # Your cognitive profile, preferences, guardrails
    whisper.txt             # Compressed injection paragraph
    observations.jsonl      # Raw observation feed
  lenses/
    {project}/              # Per-project models and context
      model.json
      whisper.txt
  sessions/
    {project}.jsonl         # Session logs (shipped, decided, blocked, next)
  nodes/                    # Durable knowledge graph nodes
  archive/                  # Decayed nodes (resurrectable)
  dreams/                   # Speculative associations
  working/                  # Volatile per-project context
```

Everything is plain text. Your memory is just files.

---

## Project structure

```text
graph-memory-plugin/    # The installable plugin — start here
  src/graph-memory/     # Core logic, pipeline, mental model
  agents/               # Background worker instructions
  bin/                  # Install scripts and Docker helpers
  commands/             # Slash commands
  skills/               # Memory skill + /recall
  extensions/           # Plugin entry points (Claude Code, OpenCode, pi)

memory-dashboard/       # Optional inspection UI (React + Express)
docs/                   # Setup guides and diagrams
examples/               # Command examples and SDK usage
```

---

## Read next

- **[Setup guide](docs/setup-from-clone.md)** — detailed clone-to-first-memory walkthrough
- **[Plugin README](graph-memory-plugin/README.md)** — full architecture and configuration
- **[Examples](examples/)** — commands, tool actions, skill usage, SDK integration

If you're here because you want an agent that remembers — you're in the right place.
