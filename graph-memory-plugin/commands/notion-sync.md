# /notion-sync

Trigger a manual Notion sync. This pushes your current graph memory state to the configured Notion workspace.

## Instructions

1. Call `graph_memory(action="notion_sync")` to queue a sync job.
2. If the sync is not configured yet (no parent page ID), suggest running `/notion-setup` first.
3. If a sync is already in progress, let the user know and suggest waiting.
4. The sync runs asynchronously — the user will see results in the next daemon tick.
5. The sync includes:
   - Phase 0: Inbound (detects any human edits in Notion since last sync)
   - Phase 1: Diff (scans disk for changes)
   - Phase 2: Transform (LLM produces human-readable content)
   - Phase 3: Sync (writes to Notion via ntn CLI)
