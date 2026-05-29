---
description: Refresh a skillforged skill — update from source nodes or list all skills
---

# /refresh-skill

Refresh a skillforged skill that may have drifted from its source nodes.

## Instructions

1. Call `graph_memory` with action `status` to verify the system is initialized.
2. If the user specifies a skill name or node path:
   a. Find the manifest in `~/.graph-memory/.skillforge/` matching that skill or node
   b. If no manifest found, tell the user this node hasn't been skillforged yet
3. If the user doesn't specify a skill, list all manifests:
   a. Read all JSON files in `~/.graph-memory/.skillforge/` (skip `archive-v1/`, `content/`)
   b. Present a summary: skill name, source nodes, refresh count, last refreshed, candidate type
   c. Ask which skill to refresh
4. To trigger a refresh, run via Bash:
   ```bash
   node --input-type=module -e "
   import { enqueueJob } from './dist/graph-memory/pipeline/job-queue.js';
   const manifest = JSON.parse(readFileSync(process.argv[1], 'utf-8'));
   const sourceNodes = manifest.source_nodes || [manifest.source_nodes?.[0] || ''];
   const { job, created } = enqueueJob({
     type: 'skillforge_refresh',
     payload: {
       manifestPath: process.argv[1],
       nodePath: sourceNodes[0],
       sourceNodes,
       skillName: manifest.skill_name,
       project: manifest.project,
       reason: 'manual refresh via /refresh-skill',
     },
     triggerSource: 'slash:refresh-skill',
     idempotencyKey: 'skillforge-refresh:' + sourceNodes.join('+') + ':manual:' + Date.now(),
   });
   console.log('Enqueued:', created, job.id);
   " "${manifestPath}"
   ```
5. Report success and the job ID back to the user.

## Notes

- Skills are automatically refreshed when source node content drifts (24h cooldown, max 5 refreshes)
- Use this command for manual refresh outside the daemon cycle
- Cluster skills (multiple source nodes) refresh from all nodes in the cluster
