# Graph Memory Roadmap

## Current State (2026-05-29)

| System | Status |
|--------|--------|
| Active pipeline | scribe → auditor → librarian → dreamer (battle-tested) |
| Mental model | Fully operational — `mind/`, `lenses/`, `sessions/` |
| Notion sync | Operational — two-way, 5 stewards, chunked sync |
| Session injection | model.json → MAP → PINNED → WORKING (~11k tokens) |
| Phase 5 items | All completed (see below) |
| Phase 10 cleanup | Deferred indefinitely — v2/v3 hybrid is the target architecture |

---

## Completed

- **Phase 1 (Stop the Bleeding):** PRIORS truncation, 15k injection budget, pinned node enforcement, orphan cleanup, token accounting.
- **Phase 2 (Quality Over Quantity):** Decay rate defaults, backfill, archive threshold lowered, dream promotion threshold fixed, PRIORS compression to 574 tokens.
- **Phase 3 (Operational):** 8-factor health score, auditor threshold, low-confidence ratio tracking, access tracking on all recall paths, project-aware MAP injection, project-first dashboard.
- **Phase 4 (Intelligence):** Project-aware MAP filtering, cross-session dedup, dreamer prompt with implicit reinforcement, access tracking. (Auditor+librarian merge deferred.)
- **Phase 5 (Automation & Cleanup):**
  - Decay runs on every daemon tick (R1 resolved)
  - Mechanical dream reinforcement on node access (R2 resolved)
  - Scribe default confidence raised to 0.6 (R3 resolved)
  - Skillforge threshold lowered to 0.55 (R4 resolved)
  - MAP rebuilds after decay/archival
- **v4 Merge:** Per-project scribe→auditor→librarian→dreamer pipeline, global observer→compressor, project-aware job scheduling, compatibility cruft removed.
- **Dashboard:** V3 storage unification wiring, path audit fixes, node edit dual-index updates.

---

## Remaining Issues — Resolved

All original remaining issues (R1–R4) were resolved in Phase 5:

- **R1 (Decay not automatic):** `runDecay()` now runs on every daemon tick.
- **R2 (Dream reinforcement prompt-only):** Mechanical reinforcement added — node access bumps referenced dream confidence +0.05.
- **R3 (Scribe over-extraction):** Default confidence raised to 0.6; noise nodes archive via automatic decay.
- **R4 (Skillforge barely running):** Threshold lowered to 0.55.

---

## Current Focus

### Notion Sync Operational Polish

- Workspace manifests and hash gates active
- Five steward agents (knowledge, project, tasks, enrichment, workspace) plus inbound triage
- Chunked sync (100 items per batch)
- Relational database architecture (Patterns, Dreams, Projects as Notion databases)
- Project name normalization and error-path lastSyncAt fix shipped

### Pipeline Reliability

- Edges/anti_edges parsing hardened with `Array.isArray()` guards — was crashing auditor on non-array YAML values
- Daemon steward isolation (try/catch per steward)
- `execNtn` env var injection for Docker keychain priority
- Root CHANGELOG.md synced with plugin CHANGELOG.md for release workflow

### Dashboard Enhancements

- Server path audit: all 5 data-source bugs fixed
- Observation count endpoint reads live from JSONL
- V3 naming cleanup: all 11 API routes renamed from `/api/v3/*` to neutral names

---

## Token Budget Architecture

Session injection uses a **split budget** — global context + project context:

| Layer | Scope | Budget | Actual | Purpose |
|-------|-------|--------|--------|---------|
| model.json | Global | 1,500 | ~400 | Cognitive model |
| MAP | Per-project | 7,000 | ~5,000 | Project-filtered knowledge index |
| PINNED | Per-project | 3,000 | ~2,500 | Essential project procedures |
| WORKING | Per-project | 2,000 | ~1,100 | Recent activity |
| DREAMS | Global | 400 | ~555 | Speculative fragments |
| Guardrails | Global | 1,500 | ~150 | Safety boundaries |
| Session logs | Per-project | 1,000 | ~200 | Recent session activity |
| **Total** | | **15,000** | **~11,000** | Well under budget |

---

## Deferred (Indefinitely)

| Item | Why deferred |
|------|--------------|
| Per-job token cost tracking | Requires worker-level token instrumentation |
| Incremental MAP regeneration | Complex refactor; full regen is ~1s |
| Combine auditor + librarian | Large refactor; clean separation works |
| PRIORS entry age counter for auto-demotion | Nice-to-have; compression already handles it |
| Phase 10 v2/v3 cleanup | v2/v3 hybrid is the target architecture, not a transitional state |
