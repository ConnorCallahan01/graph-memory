# /skill-install

Install skillforged skills from the graph memory into the current project.

## Instructions

1. Call `graph_memory(action="status")` to verify the system is initialized.
2. If the user specifies a skill name, find the matching manifest in `~/.graph-memory/.skillforge/`.
3. If no skill specified, list all manifests (skip `archive-v1/` and `content/`) and ask which to install.
4. Read the manifest and its canonical content from `.skillforge/content/{skillName}.md`.
5. Write the skill to the current project:
   - Claude Code: `.claude/commands/{skillName}.md` (raw content)
6. Report the installed path.

## Notes

- Skills are generated automatically by skillforge based on co-access patterns
- Installation is per-project, harness-specific
- Re-running overwrites with latest content
