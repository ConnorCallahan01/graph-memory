# /refresh-skill

Refresh a skillforged skill that may have drifted from its source nodes.

## Instructions

1. Call `graph_memory(action="status")` to verify the system is initialized.
2. If the user specifies a skill name or node path, find the matching manifest.
3. If no skill specified, list all manifests and ask which to refresh.
4. To trigger a refresh, enqueue a skillforge_refresh job via Bash.
5. Report success and the job ID.

## Notes

- Skills auto-refresh when source content drifts (24h cooldown, max 5 refreshes)
- Cluster skills refresh from all nodes in the cluster
