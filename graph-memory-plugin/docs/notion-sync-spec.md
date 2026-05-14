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
