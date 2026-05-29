#!/usr/bin/env bash
set -euo pipefail

# graph-memory — Claude Code plugin installer
# Usage: ./bin/install.sh

PLUGIN_NAME="graph-memory"
CLAUDE_DIR="$HOME/.claude"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
REGISTRY_FILE="$PLUGINS_DIR/installed_plugins.json"
COMMANDS_DIR="$CLAUDE_DIR/commands"

# Resolve plugin directory (where this script lives, minus /bin)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Installing $PLUGIN_NAME from $PLUGIN_DIR"

# 1. Install dependencies if needed
if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$PLUGIN_DIR" && npm install)
fi

# 2. Build on every install so dist cannot drift from src after local updates
echo "Building..."
(cd "$PLUGIN_DIR" && npm run build)

# 3. Create plugins directory if needed
mkdir -p "$PLUGINS_DIR"

# 4. Create symlink
SYMLINK="$PLUGINS_DIR/$PLUGIN_NAME"
if [ -L "$SYMLINK" ]; then
  EXISTING_TARGET="$(readlink "$SYMLINK")"
  if [ "$EXISTING_TARGET" = "$PLUGIN_DIR" ]; then
    echo "Symlink already exists and points to correct location."
  else
    echo "Updating symlink: $EXISTING_TARGET -> $PLUGIN_DIR"
    ln -sfn "$PLUGIN_DIR" "$SYMLINK"
  fi
elif [ -e "$SYMLINK" ]; then
  echo "Warning: $SYMLINK exists but is not a symlink. Skipping."
else
  ln -s "$PLUGIN_DIR" "$SYMLINK"
  echo "Created symlink: $SYMLINK -> $PLUGIN_DIR"
fi

# 5. Register in installed_plugins.json
if [ ! -f "$REGISTRY_FILE" ]; then
  echo '{"version":2,"plugins":{}}' > "$REGISTRY_FILE"
fi

# Always upsert registry metadata so moved clones and reinstalls stay correct.
REGISTRY_FILE="$REGISTRY_FILE" PLUGIN_NAME="$PLUGIN_NAME" PLUGIN_DIR="$PLUGIN_DIR" \
node -e "
  const fs = require('fs');
  const registryPath = process.env.REGISTRY_FILE;
  const pluginKey = process.env.PLUGIN_NAME + '@local';
  const pluginDir = process.env.PLUGIN_DIR;
  const now = new Date().toISOString();
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const current = Array.isArray(reg.plugins?.[pluginKey]) ? reg.plugins[pluginKey][0] : null;
  if (!reg.plugins) reg.plugins = {};
  reg.plugins[pluginKey] = [{
    scope: 'user',
    installPath: pluginDir,
    version: 'local',
    installedAt: current?.installedAt || now,
    lastUpdated: now
  }];
  fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n');
"
echo "Updated installed_plugins.json"

# 6. Register MCP server in ~/.claude.json (top-level User MCPs)
#    Claude Code reads top-level mcpServers for the User MCPs list shown in /mcp.
CLAUDE_JSON="$HOME/.claude.json"
MCP_COMMAND="$PLUGIN_DIR/bin/mcp-server.sh"

if [ ! -f "$CLAUDE_JSON" ]; then
  echo "Warning: $CLAUDE_JSON not found. Is Claude Code installed?"
  echo "You can manually add the MCP server later via /mcp in Claude Code."
else
  CLAUDE_JSON="$CLAUDE_JSON" MCP_COMMAND="$MCP_COMMAND" PLUGIN_NAME="$PLUGIN_NAME" \
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync(process.env.CLAUDE_JSON, 'utf8'));
    const name = process.env.PLUGIN_NAME;
    const command = process.env.MCP_COMMAND;
    let changed = false;

    if (!config.mcpServers) config.mcpServers = {};

    const desired = {
      type: 'stdio',
      command: command,
      args: [],
      env: {}
    };

    const existing = config.mcpServers[name];
    if (JSON.stringify(existing) !== JSON.stringify(desired)) {
      config.mcpServers[name] = desired;
      changed = true;
    }

    if (config.projects) {
      for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
        if (projectConfig && Array.isArray(projectConfig.disabledMcpServers) && projectConfig.disabledMcpServers.includes(name)) {
          console.log('Warning: graph-memory is disabled for project scope:', projectPath);
          console.log('         Remove it from disabledMcpServers if /mcp still hides the plugin there.');
        }
      }
    }

    if (changed) {
      fs.writeFileSync(process.env.CLAUDE_JSON, JSON.stringify(config, null, 2) + '\n');
      console.log('Registered MCP server in ~/.claude.json (top-level User MCPs)');
    } else {
      console.log('MCP server already registered in ~/.claude.json');
    }
  "
fi

# 7. Install Claude slash commands (short form + namespaced compatibility)
mkdir -p "$COMMANDS_DIR" "$COMMANDS_DIR/$PLUGIN_NAME"

link_command() {
  local source_file="$1"
  local target_file="$2"

  if [ -L "$target_file" ]; then
    local existing_target
    existing_target="$(readlink "$target_file")"
    if [ "$existing_target" = "$source_file" ]; then
      return
    fi
    ln -sfn "$source_file" "$target_file"
    echo "Updated command symlink: $target_file"
    return
  fi

  if [ -e "$target_file" ]; then
    echo "Warning: $target_file exists and is not a symlink. Skipping."
    return
  fi

  ln -s "$source_file" "$target_file"
  echo "Installed command: $target_file"
}

for command_name in memory-onboard memory-status memory-search memory-morning-kickoff memory-connect-inputs memory-input-refresh memory-wire-project memory-switch-harness notion-setup notion-sync notion-consolidate refresh-skill; do
  source_file="$PLUGIN_DIR/commands/$command_name.md"
  link_command "$source_file" "$COMMANDS_DIR/$command_name.md"
  link_command "$source_file" "$COMMANDS_DIR/$PLUGIN_NAME/$command_name.md"
done

# 8. Register hooks in ~/.claude/settings.json using hooks/hooks.json as the source of truth
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
HOOKS_FILE="$PLUGIN_DIR/hooks/hooks.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

node "$PLUGIN_DIR/dist/graph-memory/register-plugin-hooks.js" "$SETTINGS_FILE" "$HOOKS_FILE"

echo ""
echo "Done! Restart Claude Code or run /mcp to reconnect."
echo "Slash commands installed: /memory-onboard, /memory-status, /memory-search, /memory-morning-kickoff, /memory-connect-inputs, /memory-input-refresh, /memory-wire-project, /memory-switch-harness, /notion-setup, /notion-sync, /notion-consolidate, /refresh-skill"
echo "Compatibility aliases also installed: /graph-memory:memory-onboard, /graph-memory:memory-status, /graph-memory:memory-search, /graph-memory:memory-morning-kickoff, /graph-memory:memory-connect-inputs, /graph-memory:memory-input-refresh, /graph-memory:memory-wire-project"
