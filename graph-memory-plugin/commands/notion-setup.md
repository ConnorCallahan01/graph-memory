# /notion-setup

Set up the Notion sync workspace. This creates the "My Mind" page structure in Notion with databases for tasks, decisions, and daily briefs, plus wiki pages for your mental model.

## Instructions

1. Call `graph_memory(action="notion_setup")` to start the setup process.
2. If the user has an existing Notion page they want to use as the parent, pass `parentPageId` with the page ID.
3. If the user wants a custom workspace name, pass `workspaceName` (default is "My Mind").
4. The setup will:
   - Check that `ntn` CLI is installed and authenticated
   - Create the workspace page (or use the provided one)
   - Create three databases: Tasks & Work, Decisions, Daily Briefs
   - Create wiki pages: How I Think, Projects, Patterns & Insights, Dreams & Experiments, Archive
5. If `ntn` is not installed, tell the user to install it: `curl -fsSL https://ntn.dev | bash`
6. If `ntn` is not authenticated, tell the user to run `ntn login`
7. After successful setup, inform the user that the first sync will run automatically at the configured time (default 8am), or they can trigger it manually with `graph_memory(action="notion_sync")`.
