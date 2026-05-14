---
description: Consolidate and clean up your Notion workspace — merge duplicate pages, archive empty ones, reorganize the page hierarchy
---

# /notion-consolidate

Clean up your Notion workspace by merging duplicate pages, archiving empty ones, and reorganizing the hierarchy.

## Instructions

1. Call `graph_memory(action="notion_consolidate")` to run the consolidation. Add `dryRun=true` to preview changes without making them.
2. If the sync is not configured (no parent page ID), suggest running `/notion-setup` first.
3. The consolidation will:
   - **Merge batched pages**: Combines pages like "Patterns (1/9)" through "Patterns (9/9)" into a single "Patterns" page under each wiki section
   - **Archive empty pages**: Removes pages with no source nodes (except root wiki pages)
   - **Clean up state**: Updates the sync state to reflect the new page structure
4. Run with `dryRun=true` first to see what would change, then run without to apply.
5. After consolidation, you can trigger a regular sync with `/notion-sync` to verify the workspace is clean.
