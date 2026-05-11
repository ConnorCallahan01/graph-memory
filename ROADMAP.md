# Graph Memory Roadmap

## Current State (2026-05-09)

| Metric | Before | Now | Healthy? |
|--------|--------|-----|----------|
| Active nodes | 756 | 771 (decay not running) | No — needs Phase 5 |
| Archived nodes | ~5 | 285 | Improving |
| PRIORS size | 28,925 tokens | 574 tokens | Yes |
| MAP size (full) | 11,935 tokens | ~12,000 tokens | OK (condensed at injection) |
| MAP size (injected) | 11,935 tokens | ~5,000 tokens | Yes |
| Pinned nodes | 58 (48,282 tokens) | 15 (~9,600 tokens) | Yes |
| Pinned injection | 48,189 tokens | ~2,545 tokens | Yes |
| Total injection | ~93,000 tokens | ~11,000 tokens | Yes |
| Orphan snapshots | 192 (2.4 MB) | 0 | Fixed |
| Pending dreams | 20/20 (stale) | 15 (trimmed) | OK |
| Dream promotion | Blocked (0.5/3 sessions) | Unblocked (0.4/2 sessions) | Not yet observed |
| Pipeline jobs | 726 done, 7 failed | 732 done, 0 failed | Reliable |
| Nodes < 0.4 confidence | 387 (51%) | 409 (53%) | **Worse** — decay not running |

### Confidence Distribution (771 active nodes)

| Range | Count | Notes |
|-------|-------|-------|
| < 0.2 | 1 | Would archive if decay ran |
| 0.2–0.3 | 243 | Should be archiving |
| 0.3–0.4 | 166 | |
| 0.4–0.5 | 41 | |
| 0.5–0.6 | 27 | |
| 0.6–0.7 | 39 | |
| 0.7–0.8 | 87 | |
| 0.8+ | 167 | Healthy |

---

## Completed Phases

### Phase 1: Stop the Bleeding — Done

| Item | Status |
|------|--------|
| P1.1 Score-based PRIORS truncation in regeneration | Done |
| P1.2 15k total injection budget in session-start (4k global + 11k project) | Done |
| P1.3 Pinned node budget enforcement (total, not per-node) | Done |
| P1.4 Orphan snapshot cleanup in daemon tick | Done |
| P1.5 Token accounting in health endpoint | Done |

### Phase 2: Quality Over Quantity — Done

| Item | Status |
|------|--------|
| P2.1 Default `decay_rate: 0.05` on all new nodes | Done |
| P2.2 Backfill `decay_rate` on existing nodes | Done — 770/771 have it |
| P2.3 Lower archive threshold to 0.20 | Done — in config |
| P2.4 Fix dream promotion threshold (0.4, 2 sessions) | Done — but reinforcement not working mechanically |
| P2.5 PRIORS compression and quality gate | Done — 574 tokens |

### Phase 3: Operational — Done

| Item | Status |
|------|--------|
| P3.2 8-factor health score | Done |
| P3.4 Auditor threshold at 5 deltas | Done |
| P3.5 Low-confidence ratio as quality proxy | Done |
| Access tracking on all recall paths | Done |
| Project-aware MAP injection | Done |
| Project-first dashboard | Done |

### Phase 4: Intelligence — Done (except P4.6)

| Item | Status |
|------|--------|
| P4.1 Project-aware MAP filtering | Done |
| P4.2 Cross-session dedup (gist overlap >50%) | Done |
| P4.3 Project-first dashboard | Done |
| P4.4 Dreamer prompt with implicit reinforcement | Done — prompt only, not mechanical |
| P4.5 Access tracking on all recall paths | Done |
| P4.6 Combine auditor + librarian | Deferred |

---

## Remaining Issues

### R1. Decay only runs on manual `consolidate` — not automatic

**What:** `runDecay()` is called in the `consolidate` action handler (`tools.ts:513`) but not during daemon ticks. The daemon runs scribe → auditor → librarian → dreamer pipeline jobs, but decay only fires when someone explicitly calls the `consolidate` MCP action.

**Impact:** 409 nodes below 0.4 confidence are sitting idle. With a 90-day half-life and 0.20 archive threshold, nodes at 0.3 confidence from 90+ days ago should be archiving — but they can't because decay never runs.

**Fix:** Add `runDecay()` to the daemon tick cycle, after processing pipeline jobs.

### R2. Dream reinforcement is prompt-only — no mechanical tracking

**What:** P4.4 added implicit reinforcement (+0.05 when referenced nodes get activity) to the dreamer *prompt* but there's no mechanical code that tracks `reinforcement_sessions` or bumps dream confidence when referenced nodes are accessed.

**Impact:** All 15 pending dreams have `reinforcement_sessions: 0`. None will promote unless the dreamer LLM happens to notice the correlation.

**Fix:** Add mechanical dream reinforcement in `tools.ts` — when a node is accessed via recall/search/read_node, check if any pending dream references it and bump confidence +0.05.

### R3. Scribe over-extraction creates low-confidence noise

**What:** The scribe creates nodes at 0.5 confidence by default. Over 756+ sessions, many single-mention observations get extracted as nodes. The dedup (P4.2) helps prevent duplicates but doesn't prevent low-value extractions.

**Impact:** 409/771 (53%) nodes below 0.4 confidence — higher than before the fix.

**Fix:** Once decay runs automatically (R1), this resolves itself as noise archives. Also consider raising the scribe default confidence to 0.6 and requiring more evidence before node creation.

### R4. Skillforge barely running

**What:** 1 manifest on disk. The scoring depends on `access_count` being updated, which now works (P4.5), but the threshold (0.65) may still be too high.

**Fix:** Lower skillforge score threshold to 0.55 and monitor. Surface `skillforgeCandidateCount` in health endpoint.

---

## Phase 5: Automation & Cleanup

| Item | Issue | Effort | Impact |
|------|-------|--------|--------|
| P5.1 Run decay on every daemon tick | R1 | Small | Archives ~200 noise nodes automatically |
| P5.2 Mechanical dream reinforcement on node access | R2 | Medium | Dreams start promoting |
| P5.3 Scribe default confidence to 0.6 | R3 | Small | Fewer low-value nodes created |
| P5.4 Lower skillforge threshold to 0.55 | R4 | Small | More skills surface |
| P5.5 Rebuild MAP after decay/archival | R1 | Small | MAP stays in sync with active nodes |

### P5.1 — Decay on daemon tick

Add `runDecay()` call at the end of each daemon tick, after pipeline job processing. This ensures nodes decay and archive automatically without requiring manual `consolidate` calls.

File: `daemon.ts` — add after job processing loop.

### P5.2 — Mechanical dream reinforcement

When a node is accessed via `recall`, `search`, `read_node`, or `listEdges`, check `~/.graph-memory/dreams/pending/` for any dream that references this node. If found and `reinforcement_sessions < 2`, bump confidence by +0.05 and increment `reinforcement_sessions`.

File: `tools.ts` — in `updateLastAccessed()` or a new `reinforceDreams()` helper called from access-tracking paths.

### P5.3 — Scribe default confidence

Change default confidence in scribe delta template from 0.5 to 0.6. Nodes need to earn their place — single-mention observations should start higher and decay naturally, or not be created at all.

File: `agents/memory-scribe.md`, `mechanical-apply.ts` default frontmatter.

### P5.4 — Skillforge threshold

Lower `skillforgeScoreThreshold` from 0.65 to 0.55 in config.

File: `config.ts`.

### P5.5 — MAP rebuild after decay

After decay runs (which may archive nodes), trigger `regenerateCoreContextFiles()` to keep MAP in sync. This is already done in `consolidate` but needs to happen in the daemon tick too.

File: `daemon.ts` — after `runDecay()`.

---

## Token Budget Architecture

Session injection uses a **split budget** — global context + project context:

| Layer | Scope | Budget | Actual | Purpose |
|-------|-------|--------|--------|---------|
| PRIORS | Global | 1,500 | 574 | Cognitive model |
| SOMA | Global | 800 | ~1,200 | Emotional calibration |
| DREAMS | Global | 400 | ~555 | Speculative fragments |
| **Global subtotal** | | **4,000** | **~2,300** | |
| MAP | Per-project | 7,000 | ~5,000 | Project-filtered knowledge index |
| WORKING | Per-project | 2,000 | ~1,100 | Recent activity |
| PINNED | Per-project | 3,000 | ~2,500 | Essential project procedures |
| **Project subtotal** | | **11,000** | **~8,600** | |
| **Total** | | **15,000** | **~11,000** | Well under budget |

---

## Deferred (Future)

| Item | Why deferred |
|------|--------------|
| Per-job token cost tracking | Requires worker-level token instrumentation |
| Incremental MAP regeneration | Complex refactor; full regen is ~1s |
| Combine auditor + librarian | Large refactor; clean separation works |
| PRIORS entry age counter for auto-demotion | Nice-to-have; compression already handles it |

---

## Success Metrics

| Metric | Before | Now | After Phase 5 Target |
|--------|--------|-----|----------------------|
| Session injection | 93k tokens | ~11k tokens | ~10k tokens |
| Active nodes | 756 | 771 | ~450 |
| Nodes < 0.4 confidence | 387 (51%) | 409 (53%) | <50 (11%) |
| Dream promotion rate | Near zero | Near zero | 2-3/month |
| Skillforge manifests | 1 | 1 | 5+ |
| Pipeline jobs done | 726 | 732 | Reliable |
| Failed jobs | 7 | 0 | 0 |
