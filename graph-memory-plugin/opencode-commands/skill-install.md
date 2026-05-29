---
description: Install skillforged skills into a project for the current harness
---

# /skill-install

Install skillforged skills from the graph memory into the current project. Skills are generated as harness-agnostic canonical content and then adapted to your specific harness (Claude Code, OpenCode, etc.) at install time.

## Instructions

1. Call `graph_memory` with action `status` to verify the system is initialized.
2. If the user specifies a skill name:
   a. Find the manifest in `~/.graph-memory/.skillforge/` matching that skill name
   b. If not found, list available skills and ask which to install
3. If no skill specified, list all available skills:
   a. Read all JSON files in `~/.graph-memory/.skillforge/` (skip `archive-v1/` and `content/`)
   b. Present a summary: skill name, source nodes, project, candidate type
   c. Ask which skill(s) to install
4. To install, run via Bash:
   ```bash
   node --input-type=module -e "
   import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
   import { join, dirname } from 'path';
   import { fileURLToPath } from 'url';

   const graphRoot = process.env.GRAPH_MEMORY_ROOT || process.env.HOME + '/.graph-memory';
   const manifestFile = process.argv[1];
   const projectRoot = process.argv[2];
   const harness = process.argv[3] || 'opencode';

   const manifest = JSON.parse(readFileSync(join(graphRoot, manifestFile), 'utf-8'));
   const contentPath = join(graphRoot, manifest.canonical_content_path);
   if (!existsSync(contentPath)) { console.error('No canonical content'); process.exit(1); }
   const content = readFileSync(contentPath, 'utf-8');
   const description = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || manifest.skill_name;

   let installDir, fileName, wrapped;
   if (harness === 'claude-code') {
     installDir = join(projectRoot, '.claude', 'commands');
     fileName = manifest.skill_name + '.md';
     wrapped = content;
   } else {
     installDir = join(projectRoot, '.opencode', 'commands');
     fileName = manifest.skill_name + '.md';
     wrapped = '---\ndescription: ' + description + '\n---\n\n' + content;
   }

   mkdirSync(installDir, { recursive: true });
   writeFileSync(join(installDir, fileName), wrapped);
   console.log('Installed:', harness, '->', join(installDir, fileName));
   " "${manifestFile}" "${projectRoot}" "${harness}
   ```
5. Report installed skill path back to the user.

## Notes

- Skills are generated automatically by the skillforge pipeline based on co-access patterns
- Installation is per-project — each project gets its own copy in the native harness format
- Re-running install overwrites the existing files with the latest content
- If a skill exists in staging (no project root), use this command to install it manually
