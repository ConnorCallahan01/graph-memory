---
name: memory-status
description: Check the health and status of the graph memory system. Use when the user asks about memory health, node counts, queue activity, or warnings.
---

# /memory-status

Check the health and status of the graph memory system.

## Instructions

1. Call `graph_memory(action="status")` to get the current system state.
2. Present the results in a clear, readable format using these sections:

### System
- `initialized` / `firstRun` — whether graph is set up
- `graphRoot` — filesystem path to graph data
- `activeProject` — current project scope

### Runtime
- `runtime.mode` — `docker` or `manual`
- If Docker: container state (`runtime.docker.state.Status`, `Running`, `Health`), resource limits (`memoryLimit`, `cpuLimit`), worker provider (`workerProvider`), worker model (`workerModel` — model override for pipeline workers, null if using harness default)
- `runtime.daemonState` — daemon PID, concurrency, in-flight jobs, last updated
- `runtime.docker.codexAuth` / `runtime.docker.opencodeAuth` — auth readiness for each provider

### Graph
- `nodeCount` — total node files on disk
- `graphIndex.graphNodes` — indexed node count (may differ from total)
- `graphIndex.categories` — per-category breakdown
- `graphIndex.projects` — per-project node counts
- `pendingDreams` — unprocessed dream fragments
- `mapLoaded` / `priorsLoaded` / `indexBuilt` — core file presence

### Queue
- `queuedJobs`, `runningJobs` — global job counts
- `scribePending` — scribe jobs in queue or running
- `consolidationPending` — auditor + librarian + dreamer jobs

### Workers
- `workers` array — one entry per currently running job
- For each worker: `jobId`, `type`, `project`, `startedAt`, `elapsedMs`, `elapsedHuman`, `attempt`, `workerPid`, `logFile`, `triggerSource`
- Present as a table showing type, project, elapsed time, and attempt
- If a worker has been running for an unusually long time (e.g. >10m for scribe, >30m for librarian/dreamer), flag it as potentially stuck

### Warnings
- `warnings` array — check for MAP budget exceeded, node count near limit, low-confidence nodes
- MAP usage is `mapContent.length / 4 / maxMapTokens`; warning fires above 90%
- Node count warning fires above 80% of `maxNodesBeforePrune`
- Low-confidence flag counts nodes below 0.3 confidence

3. If `firstRun` is true, suggest running `/memory-onboard` to set up memory.
4. If Docker runtime is configured but `runtime.docker.state.present` is false or container status is not `running`, call that out explicitly and suggest `bin/docker-bootstrap.sh`.
5. If `codexAuth.ready` or `opencodeAuth.ready` is false, note which provider needs auth and suggest `bin/docker-codex-import-host-auth.sh` or `bin/docker-auth-check.sh`.
6. If there are warnings, briefly explain what they mean and recommend actions:
   - MAP near budget → next consolidation should archive nodes
   - Node count near limit → librarian pass needed
   - Low-confidence nodes → candidates for decay/archival
