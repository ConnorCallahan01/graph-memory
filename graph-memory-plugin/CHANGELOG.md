# Changelog

## 2026-05-10 — Phase 5: Automation & Project Isolation

### Automatic decay on daemon tick
- `runDecay()` now runs on every daemon tick when no graph-level job (auditor/librarian/dreamer) is in progress
- If any nodes decay or archive, `regenerateCoreContextFiles()` fires automatically to keep MAP in sync
- First tick decayed 388 nodes and rebuilt MAP (166 entries from 771 nodes)

### Mechanical dream reinforcement
- `reinforceDreams()` in `tools.ts`: when a node is accessed via recall/search/read_node, any pending dream referencing that node gets +0.05 confidence and `reinforcement_sessions` incremented
- Called from `updateLastAccessed()` so all access paths trigger it
- New event type: `graph:dream_reinforced`

### Scribe default confidence raised to 0.6
- New nodes now start at 0.6 confidence (was 0.5)
- Updated in both `mechanical-apply.ts` and scribe prompt examples
- Reduces low-confidence noise creation

### Skillforge threshold lowered
- `scoreThreshold` lowered from 0.65 to 0.55
- More nodes should surface as skillforge candidates

### Project isolation cleanup
- Merged duplicate project names: `keel3/oliver` → `Keel3/keel3_oliver_demo`, `keel3/keel3_oliver_demo` (lowercase) → `Keel3/keel3_oliver_demo`, `ConnorCallahan01/cogni-code` → `agent_memory`
- Renamed working files for `ConnorCallahan01/cogni-code` → `agent_memory`
- Dashboard `deriveProjects()` now only shows projects with WORKING files — stale projects with only nodes no longer appear in the chip strip

### Roadmap rewrite
- Replaced the Phase 1–4 roadmap with a current-state document reflecting completed work, remaining issues (R1–R4), and Phase 5 implementation plan
- All 5 phases (1–5) now complete; deferred items documented separately

---

## 2026-05-08 — Phase 1–4: Token Budget, Quality, Dashboard

### Phase 1: Stop the bleeding
- Score-based PRIORS truncation in `graph-ops.ts` (generality, conciseness, specificity scoring)
- 15k total injection budget in `session-start.ts` (split: 4k global + 11k project)
- Pinned node budget enforcement (3k total, respects both pinned and session budgets)
- Orphan snapshot cleanup in daemon tick (>4hrs, no active job) — cleaned 193 on first run
- Token accounting in `/api/health` with per-layer counts, budgets, overBudget flag

### Phase 2: Quality over quantity
- `decay_rate: 0.05` on all new nodes (scribe template + all code paths)
- Auditor mechanically adds `decay_rate: 0.05` to nodes missing it; `decay.ts` falls back to 0.05
- Archive threshold 0.10 → 0.20 in config
- Dream promotion 0.5/3 sessions → 0.4/2 sessions
- Librarian PRIORS compression (Step 2): compresses verbose entries, demotes project-specific to nodes
- One-time data cleanup: PRIORS compressed 28,925 → 574 tokens, 43/58 stale pinned nodes unpinned

### Phase 3: Operational
- Project-aware MAP injection: `buildProjectMAP()` in session-start — top 8 project + 2 other per category
- Project detection never falls back to "global" — `deriveProjectName()` uses `parent/base` from cwd
- Access tracking on `search`, `listEdges`, and connected nodes from `recall`
- Health score: 8 factors (node coverage 15, staleness 15, orphans 10, MAP 10, PRIORS 15, pinned 15, low-confidence 10, budget 10 = 100)
- Pipeline stats (scribe/auditor/librarian/dreamer/skillforge job counts) in health endpoint

### Phase 4: Intelligence
- Cross-session dedup in `mechanical-apply.ts` — `findSimilarNode()` checks gist word overlap >50% within category
- Project-first dashboard with auto-select, per-project scoping, injection budget in top bar

### Dashboard
- Complete CSS rewrite with OKLCH light theme design system
- App.tsx: project-first nav (top bar switcher), 4 views, persistent activity rail
- BriefView, GraphExplorer, ContextView, SessionReplay implemented
- ActivityPanel: persistent 300px right rail with Pipeline, Skills, Jobs, Health, Dreams, Audit, Events
- Memory health: GET `/api/health` with 8-factor score, token accounting, pipeline stats
- Dreams: POST accept/reject endpoints + action buttons
- Node editing via PUT `/api/node/:path` + inline form
