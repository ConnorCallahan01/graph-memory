# Notion Sync Pipeline — Design Specification

## Summary

A two-way sync pipeline that mirrors graph-memory state into a structured Notion workspace. Disk remains the raw agent-readable store. Notion becomes the human-readable "Company Database of My Mind" — organized documentation, task boards, decision logs, and wiki-style knowledge that the user can browse, edit, and organize. Edits flow back to the graph.

## Principles

1. **Disk is agent-readable, Notion is human-readable.** The graph-memory system is unchanged. Notion is a derived view.
2. **Many nodes → one page.** Notion pages are grouped by topic and reference their source node paths. The LLM transforms raw YAML/markdown into polished, readable content.
3. **Two-way sync.** Outbound (disk → Notion) runs daily. Inbound (Notion → disk) detects human edits and uses an agent to apply them back to the graph.
4. **Notion is not the source of truth, but it's authoritative for human edits.** When conflicts arise, a merge mechanism reconciles both sides.
5. **Chunked processing.** Large diffs are split into batches to prevent LLM context overload.

---

## Notion Workspace Structure

```
🧠 My Mind                                    ← top-level page (created during onboarding)
│
├── 📋 Tasks & Work                           ← DATABASE
│   ├── View: "Kanban" (board, grouped by Status)
│   ├── View: "Today" (filtered: Status = Next or In Progress)
│   ├── View: "By Project" (board, grouped by Project)
│   └── Properties:
│       ├── Name (title)
│       ├── Status (select: Backlog / Next / In Progress / Blocked / Done)
│       ├── Project (select)
│       ├── Source (url — links to related Notion page)
│       ├── Due (date)
│       ├── Priority (select: High / Medium / Low)
│       └── First Seen (date — when this appeared in memory)
│
├── 📋 Decisions                              ← DATABASE
│   ├── View: "Recent" (table, sorted by Date desc, last 30)
│   ├── View: "By Project" (table, grouped by Project)
│   └── Properties:
│       ├── Decision (title)
│       ├── Context (rich text)
│       ├── Rationale (rich text)
│       ├── Project (select)
│       ├── Date (date)
│       └── Source Nodes (rich text: comma-separated node paths)
│
├── 📖 How I Think                            ← WIKI PAGE
│   │   Style: wiki-journal — narrative paragraphs, not bullet-point reference.
│   │   Think: "documentation of how this person thinks and works."
│   │
│   ├── Cognitive Style
│   ├── Decision Patterns
│   ├── Preferences (grouped: code style, tools, communication, workflow)
│   ├── Guardrails & Boundaries
│   ├── Emotional Profile
│   └── Relational Notes
│   Sources: mind/model.json, nodes/preferences/*, nodes/guardrails/*
│
├── 📁 Projects                               ← PAGE (parent)
│   ├── 📖 graph-memory-plugin                ← WIKI PAGE
│   │   │   Style: documentation — structured with headings, code blocks, file refs.
│   │   │
│   │   ├── Overview & Tech Stack
│   │   ├── Conventions & Procedures
│   │   ├── Guardrails
│   │   ├── Active Work
│   │   ├── Open Threads
│   │   └── Recent Sessions (last 5)
│   │   Sources: lenses/{project}/model.json, working state, session logs
│   │
│   ├── 📖 memory-dashboard
│   └── ... (per project, created on first sync)
│
├── 📖 Patterns & Insights                    ← WIKI PAGE
│   │   Style: encyclopedia — one section per pattern, with examples.
│   │
│   ├── Coding Patterns
│   ├── Anti-Patterns (from corrections)
│   ├── Workflow Patterns
│   └── Emergent Connections (from dreamer)
│   Sources: nodes with tags pattern, anti_pattern, correction, etc.
│
├── 📖 Dreams & Experiments                   ← WIKI PAGE
│   ├── Pending Dreams
│   └── Integrated Insights
│   Sources: dreams/pending/*, dreams/integrated/*
│
├── 📋 Daily Briefs                           ← DATABASE
│   ├── View: "Gallery" (card per day)
│   ├── View: "Timeline" (calendar)
│   └── Properties:
│       ├── Date (date)
│       ├── One Thing Today (rich text)
│       ├── Friction Count (number)
│       └── (page body contains full brief markdown)
│
└── 🗄️ Archive                               ← PAGE
    └── (archived/stale nodes, grouped by original section)
```

---

## Data Sources → Notion Mapping

### Tasks

Tasks are aggregated and deduplicated from multiple sources:

| Source | Field | Task Signal |
|---|---|---|
| `SessionLog.openThreads[]` | Unfinished work per session | New or existing task |
| `SessionLog.blocked[]` | Stuck items | Status = Blocked |
| `WorkingSessionEntry.nextPickup[]` | Verb-first next actions | Status = Next |
| `WorkingSessionEntry.tasksWorkedOn[]` | Active task threads | Status = In Progress |
| `WorkingSessionEntry.didntWork[]` | Failed/rejected | Status = Blocked |
| `WorkingSessionEntry.worked[]` | Successful completions | Status = Done |
| `WorkingSessionEntry.commits[]` | Git commits | Status = Done |
| `ProjectModel.activeWork[]` | Project-level active work | Status = In Progress |
| `ProjectModel.openThreads[]` | Project-level open threads | New or existing task |
| `DailyBriefPayload.open_loops[]` | Curated open loops | New or existing task |
| `DailyBriefPayload.start_here[]` | Priority start items | Priority = High |
| `ExternalInput` (category=action_item) | Gmail action items | New task, with Due |
| `ExternalInput` (category=waiting_on_reply) | Blocked external | Status = Blocked |

### Task Status Resolution (most recent signal wins)

| Signal | Sets Status |
|---|---|
| `nextPickup[]` entry matches | Next |
| `tasksWorkedOn[]` or `activeWork[]` matches | In Progress |
| `blocked[]` or `didntWork[]` matches | Blocked |
| `shipped[]`, `worked[]`, or git commit matches | Done |
| No signal in 7+ days | Backlog |

### Task Completion Detection

The Notion sync agent determines task completion by checking:

1. **Memory signals** — did `shipped[]`, `worked[]`, or `commits[]` in any session log reference this task?
2. **Git commits** — for projects that are git-tracked and had sessions yesterday, the agent reads recent commits (`git log --since=yesterday`) and matches commit messages to open tasks.
3. **Disappearance** — if an `openThread` from a previous session is not mentioned in any subsequent session's active work, and no blocker is recorded, the agent may infer it's done (with lower confidence).

### Task Deduplication

Multiple sources can produce the same task. The LLM worker:

1. Collects all task-like items across sources
2. Clusters by intent (same task described differently = same task)
3. Picks the richest description as canonical
4. Tracks other sources as "also mentioned in"
5. Uses the most recent signal for status

### Decisions

| Source | Field |
|---|---|
| `SessionLog.decisions[]` | Free-text decision description |
| `Observation` (type=decision) | Structured decision with evidence |

The LLM enriches each decision with context from source nodes.

### Wiki Pages (How I Think, Projects, Patterns)

These pages are built from many nodes grouped by topic:

- The LLM reads all relevant nodes, observations, and models
- Groups related content into sections (e.g., 5-8 nodes → one "Coding Patterns" section)
- Produces polished markdown with the appropriate style per section
- Appends a source reference block at the bottom:

```
---
Built from: nodes/patterns/atomic-commits, nodes/decisions/graph-v3,
            lenses/graph-memory-plugin/model.json
Last synced: 2026-05-14T07:00:00Z
```

### Content Styles

| Section | Style | Description |
|---|---|---|
| How I Think | Wiki-journal | Narrative paragraphs about cognitive patterns, with callouts for guardrails. "Patrick gravitates toward bottom-up exploration..." |
| Projects | Documentation | Structured with headings, code blocks, file references. Like a good README. |
| Patterns | Encyclopedia | One section per pattern, with examples and linked anti-patterns. |
| Tasks | Minimal | Title + metadata in database. No body content. |
| Decisions | Log entry | Context + rationale, concise. |
| Briefs | Existing format | Current morning brief markdown rendered as Notion page body. |

---

## Pipeline Architecture

### New Job Type

```typescript
// job-schema.ts additions
export type GraphMemoryJobType =
  | ...existing...
  | "notion_sync";

export interface NotionSyncJobPayload {
  reason: string;                    // "daily" | "manual" | "onboarding"
  date: string;                      // YYYY-MM-DD
  forceFullSync?: boolean;           // true on first run / onboarding
  batches?: string[];                // specific batches to process (for chunking)
  skipInbound?: boolean;             // skip Notion → disk phase
}
```

Priority: 7 (below memory_analysis at 6, lowest priority).

### Triggering

```typescript
// In daemon loop:
maybeEnqueueNotionSync()
  Conditions:
    1. notionSyncEnabled in config (set during onboarding)
    2. Current hour >= notionSyncHourLocal (default: 8am, after morning brief at 7am)
    3. Today's morning brief exists (notion_sync depends on brief data)
    4. No active notion_sync job
    5. No active memory_analysis job (don't run during analysis)
    6. lastSyncAt is >= 20 hours ago (prevents re-running same day)
```

Also triggerable via MCP: `graph_memory(action="notion_sync")`

### The Four-Phase Sync

```
┌──────────────────────────────────────────────────────────────────┐
│                    NOTION SYNC PIPELINE                         │
│                                                                  │
│  Phase 0: INBOUND  (Notion → disk)                              │
│  Phase 1: DIFF     (mechanical, what changed on disk)           │
│  Phase 2: TRANSFORM (LLM, raw → human-readable)                 │
│  Phase 3: SYNC     (mechanical, shell commands to Notion)       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### Phase 0: Inbound (Notion → Disk)

Detects and processes human edits made in Notion since last sync.

```
1. Read all tracked Notion pages via `ntn pages get <id>`
2. For each page, compute content hash
3. Compare against .notion-sync-state.json → lastNotionHash
4. If hash differs AND lastSyncedHash == lastNotionHash in state:
   → This means: we wrote it, then you edited it
   → Queue for inbound processing
5. If hash differs AND lastSyncedHash != lastNotionHash:
   → Both sides changed → queue for MERGE (Phase 0b)
6. Feed inbound edits to the Inbound Agent
```

**Inbound Agent** (`agents/memory-notion-inbound.md`):

An LLM worker that evaluates each human edit and decides what to do:

| Edit Type | Agent Action |
|---|---|
| Modified preference text | Updates the relevant preference node's content |
| Added a new paragraph/section | Creates a new observation (not a node directly) — the next compressor cycle may promote it to a node |
| Deleted/removed content | Lowers confidence on the related node |
| Changed task status to "Done" | Marks the corresponding nextPickup/openThread as resolved in session log |
| Changed task status to "Blocked" | Updates the task's source node with blocker context |
| Changed a project page's "Conventions" section | Updates the project model's conventions[] |
| Changed guardrails | Updates global model guardrails[] (these are critical — always applied) |
| Added entirely new content with no obvious source | Creates a new observation tagged `source:notion-inbound` for the compressor to evaluate |

The agent writes a `.deltas/notion-inbound-{date}.json` file containing structured deltas. These get picked up by the next regular consolidation cycle (auditor → librarian).

**Key constraint:** The inbound agent does NOT directly create graph nodes. It creates observations and deltas. The normal pipeline (compressor, librarian) decides whether to promote them to full nodes. This prevents typos and casual edits from polluting the graph.

#### Phase 0b: Merge (Both Sides Changed)

When both the graph node and the Notion page changed since last sync:

```
1. Collect: the Notion edit (human version), the disk edit (agent version),
   and the last-synced version (baseline)
2. Feed all three to the Merge Agent
3. Merge Agent produces a merged version that:
   - Preserves human intent (their edit is important)
   - Includes new agent-learned information (don't lose memory)
   - Notes conflicts where both sides changed the same section
4. Apply merged version to BOTH:
   - Write merged content to graph node
   - Queue merged content for Phase 3 (write to Notion)
5. For unresolvable conflicts:
   - Prefer the human version (Notion wins)
   - Append the agent's version as a "Agent note:" callout in the Notion page
   - Create an observation noting the conflict for next session
```

**Merge Agent** (`agents/memory-notion-merge.md`):

Receives a three-way diff and produces a merged result. Simple rules:

- If human added and agent added different sections → keep both
- If human modified and agent modified same section → keep human version, append agent version as callout
- If human deleted and agent updated → keep human deletion, create observation with the lost agent content
- If human added and agent deleted → keep human addition (they explicitly re-added it)

#### Phase 1: Diff (Mechanical)

```
1. Load .notion-sync-state.json
2. Scan all data sources, compare timestamps/hashes:
   - Graph nodes (updatedAt vs lastSyncedAt)
   - Mental models (global + per-project)
   - Session logs (new entries since last sync)
   - Working state (new sessions since last sync)
   - Morning briefs (new brief since last sync)
   - External inputs (new classified items)
   - Dream state (pending/integrated dreams)
3. Classify: new / updated / archived / unchanged
4. Group into batches:
   - "tasks" — all task-like items
   - "decisions" — decision entries
   - "project:{name}" — per-project wiki content
   - "global-wiki" — How I Think, Patterns & Insights
   - "dreams" — dream pages
   - "briefs" — daily brief entries
5. If total items > 50, split into sub-batches of ~30
6. Write .notion-sync-input.json (the diff report)
```

#### Phase 2: Transform (LLM)

For each batch, spawn a worker reading `agents/memory-notion-sync.md`:

```
Input: the diff report + relevant source data
Output: a sync plan JSON containing:

{
  "creates": [
    {
      "type": "database_row" | "wiki_page",
      "target": "tasks" | "decisions" | "briefs" | "project:foo" | ...,
      "properties": { ... },        // for database rows
      "markdown": "...",            // for wiki pages
      "sourceNodes": ["path/1", "path/2"]
    }
  ],
  "updates": [
    {
      "notionPageId": "abc-123",
      "type": "database_row" | "wiki_page",
      "changedProperties": { ... },  // only changed fields
      "markdown": "...",             // full replacement for wiki pages
      "sourceNodes": ["path/1"],
      "mergeStrategy": "replace" | "append" | "merge"
    }
  ],
  "archives": [
    { "notionPageId": "def-456", "reason": "node archived" }
  ]
}
```

The agent handles:
- Task deduplication and status resolution
- Grouping nodes into wiki sections
- Choosing appropriate content style per section
- Matching git commits to tasks for completion detection

#### Phase 3: Sync (Mechanical)

Execute the sync plan via `ntn` CLI commands:

```
First run (onboarding):
  ntn pages create --parent <workspace-root> --content "..."  → creates "My Mind"
  ntn api v1/databases --data '{ ... }'                       → creates each database
  ntn api v1/views --data '{ ... }'                            → creates Kanban, Today, etc. views

Subsequent runs:
  # Database rows (tasks, decisions, briefs)
  ntn api v1/pages --data '{ parent: {database_id: "..."}, properties: {...} }'

  # Wiki pages
  ntn pages update <page-id> --content <markdown>

  # Archive
  ntn api "v1/pages/{id}" -X PATCH archived:=true

After each operation:
  - Update .notion-sync-state.json with new hashes and page IDs
```

---

## State File

```jsonc
// ~/.graph-memory/.notion-sync-state.json
{
  "version": 1,
  "enabled": true,
  "parentPageId": "abc-123",           // "My Mind" page
  "lastSyncAt": "2026-05-14T08:00:00Z",
  "lastInboundAt": "2026-05-14T08:00:00Z",
  "syncHourLocal": 8,
  "workspaceName": "My Mind",

  "databases": {
    "tasks": {
      "id": "def-456",
      "views": {
        "kanban": "v1-id",
        "today": "v2-id",
        "by_project": "v3-id"
      }
    },
    "decisions": {
      "id": "ghi-789",
      "views": {
        "recent": "v4-id",
        "by_project": "v5-id"
      }
    },
    "briefs": {
      "id": "jkl-012",
      "views": {
        "gallery": "v6-id",
        "timeline": "v7-id"
      }
    }
  },

  "pages": {
    "how-i-think": {
      "pageId": "mno-345",
      "sourceNodes": ["mind/model", "nodes/preferences/*"],
      "lastSyncedHash": "sha256:abc...",
      "lastNotionHash": "sha256:abc..."
    },
    "projects/graph-memory-plugin": {
      "pageId": "pqr-678",
      "sourceNodes": [
        "lenses/graph-memory-plugin/model",
        "nodes/decisions/*graph*"
      ],
      "lastSyncedHash": "sha256:def...",
      "lastNotionHash": "sha256:def..."
    }
    // ... more pages
  },

  "rows": {
    "task:graph-memory-plugin:fix-worker-spawn-storm": {
      "pageId": "stu-901",
      "sourceField": "nextPickup",
      "sourceSession": "sess_abc123",
      "status": "In Progress",
      "lastSyncedHash": "sha256:ghi..."
    }
  }
}
```

Hash tracking enables:
- `lastSyncedHash` — what we last wrote to Notion
- `lastNotionHash` — what Notion currently contains
- If `lastNotionHash != lastSyncedHash` → human edited (inbound)
- If disk node hash != hash at last sync → agent updated (outbound)
- If both changed → merge needed

---

## Onboarding Flow

The Notion sync setup happens during the graph-memory onboarding process (or as a separate `/notion-setup` command).

```
1. Check if ntn CLI is installed
   → If not: "Install Notion CLI: curl -fsSL https://ntn.dev | bash"

2. Check if ntn is authenticated
   → If not: run `ntn login` (opens browser)

3. Prompt user for workspace preference:
   "Would you like to create a new 'My Mind' page, or use an existing page?"
   → If new: ntn pages create --parent <workspace> --content "# My Mind"
   → If existing: user provides page ID or URL

4. Create database structure under parent page:
   - Tasks & Work (database with Kanban view)
   - Decisions (database with table view)
   - Daily Briefs (database with gallery view)
   - Wiki pages: How I Think, Projects, Patterns, Dreams, Archive

5. Write initial config to .notion-sync-state.json:
   - parentPageId
   - database IDs and view IDs
   - enabled: true

6. Optionally run first full sync:
   graph_memory(action="notion_sync", forceFullSync=true)
```

Config additions to `config.ts`:

```typescript
notionSync: {
  enabled: boolean;              // set during onboarding
  syncHourLocal: number;         // default: 8
  parentPageId?: string;         // the "My Mind" page
  maxBatchSize: number;          // default: 30 items per LLM chunk
  skipInbound: boolean;          // for debugging
}
```

---

## Files to Create / Modify

### New Files

| File | Purpose |
|---|---|
| `src/graph-memory/pipeline/notion-sync.ts` | Diff logic, state management, batch building |
| `src/graph-memory/pipeline/notion-inbound.ts` | Inbound edit detection and delta generation |
| `agents/memory-notion-sync.md` | Outbound transform agent instructions |
| `agents/memory-notion-inbound.md` | Inbound parse agent instructions |
| `agents/memory-notion-merge.md` | Three-way merge agent instructions |
| `commands/notion-setup.md` or `opencode-commands/notion-setup.md` | Onboarding slash command |

### Modified Files

| File | Changes |
|---|---|
| `src/graph-memory/pipeline/job-schema.ts` | Add `"notion_sync"` job type + `NotionSyncJobPayload` |
| `src/graph-memory/pipeline/job-queue.ts` | Add priority 7 for `notion_sync` |
| `src/graph-memory/pipeline/daemon.ts` | Add `runNotionSync()`, `maybeEnqueueNotionSync()`, dispatch case |
| `src/graph-memory/config.ts` | Add `notionSync` config section |
| `src/graph-memory/tools.ts` | Add `notion_sync` MCP action |
| `bin/graph-memory-setup` or setup script | Add Notion onboarding step |

---

## Agent Instructions Overview

### memory-notion-sync.md (Outbound Transform)

The outbound agent receives a diff report and produces a sync plan:

- Reads all changed nodes, session logs, working state, briefs
- For tasks: deduplicates, resolves status, assigns priority
- For wiki pages: groups nodes into sections, writes polished markdown in the appropriate style
- For decisions: enriches with context from source nodes
- Checks git logs for task completion (runs `git log --since=yesterday --oneline` for each active project)
- Outputs structured sync plan JSON

### memory-notion-inbound.md (Inbound Parse)

The inbound agent receives human edits and decides how to apply them:

- Reads the current Notion page content and the last-synced version
- Diffs the two to identify what the human changed
- Maps each change to the appropriate graph action:
  - Preference edit → update node
  - New section → create observation
  - Deletion → lower confidence
  - Task status change → update session/working state
  - Guardrail change → update model (always applied)
- Outputs structured delta JSON for the consolidation pipeline

### memory-notion-merge.md (Three-Way Merge)

The merge agent handles conflicts:

- Receives: baseline (last synced), human version (Notion), agent version (disk)
- Produces: merged version + conflict notes
- Rules: human intent preserved, agent info appended as callouts, guardrails always human-authoritative

---

## Chunking Strategy

Large diffs are split to keep LLM context manageable:

```
If Phase 1 produces > 50 changed items:
  1. Sort by priority: tasks > decisions > project docs > global wiki > briefs
  2. Group into sub-batches of ~30 items
  3. Each sub-batch becomes a separate LLM worker spawn
  4. Phase 3 (sync to Notion) runs after each sub-batch completes
  5. State file updated incrementally after each batch
  6. If a batch fails, remaining batches are still processed
```

This prevents a single massive sync from getting stuck.

---

## Task Completion via Git

For projects with active sessions yesterday, the Notion sync agent:

1. Identifies projects with sessions in the last 24h
2. For each project that's git-tracked:
   ```bash
   git log --since="yesterday" --oneline --no-merges
   ```
3. Matches commit messages against open task titles/descriptions
4. If a commit clearly relates to a task → mark as Done
5. The matching is fuzzy (LLM-assisted) — commit "fix: worker spawn race condition"
   matches task "Fix worker spawn storm in daemon"

---

## Error Handling

| Scenario | Response |
|---|---|
| `ntn` CLI not installed | Skip sync, log warning, suggest installation |
| `ntn` not authenticated | Skip sync, log warning |
| Notion API rate limit (3 req/s) | Built-in retry with exponential backoff |
| Single page sync fails | Skip that page, continue with others, log error |
| Inbound agent fails | Skip inbound for this cycle, try again next sync |
| Merge agent fails | Fall back to "Notion wins" strategy, log conflict |
| State file corrupted | Rebuild from scratch (treat as first sync) |
| Entire sync fails | Retry once next daemon tick, then skip until tomorrow |

---

## Future Considerations

- **Real-time sync** — Could use Notion webhooks to trigger inbound sync immediately when you edit, rather than waiting for the daily cycle
- **Selective sync** — Let users choose which sections to sync (e.g., only tasks and projects, not dreams)
- **Multiple Notion workspaces** — Support different workspaces for different purposes
- **Notion comments as observations** — Your comments on Notion pages could become graph observations
- **Bi-directional task creation** — Tasks created directly in Notion get synced back as new openThreads

---

## Operational Guide

### Quick Start

1. Run `/notion-setup` — creates the Notion workspace structure (top-level page, databases, wiki pages)
2. Set `NOTION_API_TOKEN` in your environment or config
3. Run `/notion-sync` — performs the first sync
4. (Optional) Set up webhooks for inbound sync — see [notion-webhook-troubleshooting.md](./notion-webhook-troubleshooting.md)

### Sync Cycle

The outbound sync runs in four phases:

1. **Diff phase** — compares current graph state against `lastSyncAt` timestamp in `.notion-sync-state.json`. Scans all data sources (nodes, mental models, session logs, working state, briefs, dreams) and classifies each item as new, updated, archived, or unchanged. Groups results into batches (tasks, decisions, per-project wiki content, global wiki, dreams, briefs). Writes the diff to `.notion-sync-input.json`.

2. **Plan phase** — steward agents generate per-area sync plans. Each steward reads the diff report filtered to its domain, cross-references against the workspace manifest, and produces a structured plan of creates, updates, and archives. Plans are written to `.notion-sync-plan.json`.

3. **Execute phase** — applies changes to Notion in batches of 100, sorted by confidence. Uses `ntn` CLI for all Notion API calls. State is updated incrementally after each batch succeeds. If a single page fails, it is skipped and the rest continue.

4. **State update** — writes new `lastSyncAt`, content hashes, and any new page IDs to `.notion-sync-state.json`. Hash gates (`lastSyncedHash` vs `lastNotionHash`) are refreshed to enable inbound change detection on the next cycle.

### Steward Agents

Five specialized stewards divide the sync workload by domain. Each reads the diff report filtered to its area, cross-references the workspace manifest, and produces an independent plan.

#### Knowledge Steward

Syncs patterns, concepts, anti-patterns, corrections, preferences, dreams, and decisions from graph nodes into Notion database rows. Manages three Notion databases:

- **Patterns & Insights** — one row per pattern/concept/anti-pattern/correction/preference node, with Category, Insight, Confidence, and First Seen properties
- **Dreams & Experiments** — one row per dream fragment (pending or integrated), with Status, Confidence, Prediction, and Source Nodes properties
- **Decisions** — one row per decision node, with Context, Date, and Project relation properties

Reads from `nodes/patterns/`, `nodes/concepts/`, `nodes/anti-patterns/`, `nodes/corrections/`, `nodes/decisions/`, `nodes/preferences/`, and `dreams/`. Triggered by any diff items with matching batch types.

#### Project Steward

Syncs project-level information from lenses and working state into the Projects database. Each project gets a row with Name, Status (Active/Paused/Stale), Overview, Tech Stack, Last Active, and Open Threads properties. The body is written as a project brief (narrative prose, not a raw data dump).

Reads from `lenses/{project}/model.json`, `lenses/{project}/whisper.txt`, `lenses/{project}/observations.jsonl`, `working/projects/{project}.md`, and `working/projects/{project}.state.json`. Triggered by diff items with `batch` starting with `project:`.

#### Tasks Steward

Manages the full task lifecycle in the Tasks database — creating new tasks from working state, updating statuses, completing tasks via git commit matching, rotating stale items to Backlog, and archiving dead tasks.

Reads from all `working/projects/*.md` and `working/projects/*.state.json` files (always, regardless of diff), plus `nodes/decisions/` and `nodes/patterns/` for context on new tasks. Status resolution follows: `nextPickup` → Next, `tasksWorkedOn` → In Progress, `blocked`/`didntWork` → Blocked, `shipped`/`worked`/commits → Done, no signal in 7+ days → Backlog. Max 5 creates per cycle. Triggered on every sync (tasks are derived from working state, not direct node changes).

#### Enrichment Steward

Takes sparse human-created Notion items (tasks with no body, decisions with no context, empty wiki sections) and enriches them using graph context. Unlike outbound stewards, it reads a specific sparse item and uses graph knowledge to flesh it out.

Reads from `working/projects/`, `nodes/decisions/`, `nodes/patterns/`, and project models to find relevant context. Produces two outputs: an enrichment plan (what to write back to Notion) and memory deltas (observations recording the human's creation). Enrichment adds to sparse content — it never overwrites existing human text. Triggered by the inbound triage pipeline when a sparse item is detected.

#### Workspace Steward

Owns the How I Think wiki page, the Briefs database, and workspace-level hygiene. The How I Think page synthesizes the global mental model into narrative paragraphs covering cognitive style, decision patterns, preferences, guardrails, and emotional profile.

Reads from `mind/model.json`, `nodes/preferences/`, `nodes/anti-patterns/`, and `briefs/daily/`. Always rotates brief statuses (Today/Yesterday/Old) on every sync cycle, regardless of whether anything else changed. Creates new brief rows when brief files exist but no Notion row does. Triggered by global-model changes or new daily briefs.

### Inbound Sync

The inbound path handles human edits made in Notion:

1. **Webhook event** — Notion sends an event to the `/notion-webhook` endpoint (or, in daily polling mode, the sync reads all tracked pages via `ntn pages get <id>` and computes content hashes).

2. **Triage** — a `notion_inbound_triage` job classifies each edit by type: content change, new page creation, property update, or deletion. Sparse items (new tasks with no body, empty decisions) are flagged for enrichment. The triage output is written to `.notion-sync-input.json` with inbound items separated by type.

3. **Enrichment** — a `notion_inbound_enrich` job adds context to sparse items using the enrichment steward. For substantive edits, the inbound agent (`agents/memory-notion-inbound.md`) maps each change to the appropriate graph action: preference edits update nodes, new sections create observations, deletions lower confidence, task status changes update session/working state, guardrail changes always apply.

4. **Application** — inbound deltas are written to `.deltas/notion-inbound-{date}.json` and picked up by the normal scribe → auditor → librarian pipeline. The inbound agent does not create nodes directly — it creates observations and deltas. The pipeline decides whether to promote them to full nodes.

### Three-Way Merge

When both the graph node and the Notion page changed since last sync:

- **Human intent wins.** If both sides modified the same section, the human version is kept and the agent version is appended as a callout/blockquote in the Notion page.
- **Agent info preserved.** If both sides added different sections, both are kept. If the human deleted content that the agent updated, the deletion stands but an observation is created with the lost agent content.
- **Hash gates prevent redundant syncs.** Content hashes are compared before any write. If `lastSyncedHash == lastNotionHash`, the system knows it wrote the current Notion content and any difference is a human edit. If both hashes diverged from the baseline, merge is triggered.
- **Manual override.** Force a full sync (ignoring hashes) with `forceFullSync: true` in the job payload: `graph_memory(action="notion_sync")` with a manual trigger.

### Monitoring

Check these files to monitor sync health:

```bash
cat ~/.graph-memory/.notion-sync-state.json          # current sync state + lastSyncAt
cat ~/.graph-memory/.notion-sync-plan.json            # latest sync plan (after plan phase)
ls ~/.graph-memory/.pipeline-logs/notion_sync-*.log   # pipeline worker logs
ls ~/.graph-memory/.jobs/failed/notion_sync_*.json    # failed jobs
grep "notion" ~/.graph-memory/.logs/activity.jsonl | tail -20  # recent Notion-related activity
```

### Troubleshooting

**All API calls fail with keychain error**

The `ntn` CLI checks macOS Keychain before the `NOTION_API_TOKEN` env var, causing failures inside Docker containers where Keychain is unavailable. Fix: ensure `NOTION_API_TOKEN` is set in the Docker environment. The `execNtn` function injects it automatically.

**Sync hangs at "planning"**

A steward agent likely timed out. Check pipeline logs for the specific steward that stalled:
```bash
grep "timeout\|error\|steward" ~/.graph-memory/.pipeline-logs/notion_sync-*.log | tail -20
```

**Duplicate databases after re-running setup**

The `/notion-setup` command is not idempotent — re-running it creates duplicate databases and wiki pages. Delete duplicates manually in Notion.

**Webhook not firing**

See [notion-webhook-troubleshooting.md](./notion-webhook-troubleshooting.md).

**Content hash mismatch after manual edits**

Content hashes track what was last synced. If hashes are stale or mismatched, force a full sync to reset them:
```bash
graph_memory(action="notion_sync")
```

### Configuration

Key config options in `config.yml`:

| Option | Type | Default | Description |
|---|---|---|---|
| `notionSync.enabled` | boolean | `false` | Enable/disable Notion sync |
| `notionSync.dailyHour` | number | `3` | Hour of day (local) for automatic sync |
| `notionSync.skipInbound` | boolean | `false` | Skip inbound triage/enrichment phase |
| `notionSync.maxBatchSize` | number | `30` | Items per LLM chunk |
| `NOTION_API_TOKEN` | string | — | Notion API token (env var, required) |
| `NOTION_WEBHOOK_SECRET` | string | — | Webhook verification secret (env var, for inbound) |

### Notion API Version

Uses Notion API v2026-03-11. Properties are managed via data sources, not databases. This affects how properties are created and updated — use the data sources API for property management rather than the databases API.
