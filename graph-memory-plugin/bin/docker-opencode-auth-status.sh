#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
eval "$("$DIR/bin/runtime-env.sh")"

if docker exec \
  -e HOME="$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
  "$GRAPH_MEMORY_DOCKER_CONTAINER" \
  bash -lc 'test -f "$HOME/.local/share/opencode/auth.json" -o -f "$HOME/.config/opencode/config.json" -o -f "$HOME/.config/opencode/opencode.json" -o -f "$HOME/.config/opencode/opencode.jsonc"' 2>/dev/null; then

  CONFIG_FILE=$(docker exec \
    -e HOME="$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
    "$GRAPH_MEMORY_DOCKER_CONTAINER" \
    bash -lc 'cat "$HOME/.local/share/opencode/auth.json" 2>/dev/null || cat "$HOME/.config/opencode/config.json" 2>/dev/null || cat "$HOME/.config/opencode/opencode.json" 2>/dev/null || cat "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null' 2>/dev/null || echo "")

  if [ -n "$CONFIG_FILE" ] && echo "$CONFIG_FILE" | grep -qE '"key"|"token"|"apiKey"|"api_key"|"apiKeyId"'; then
    echo "opencode auth is ready inside the container."
    exit 0
  fi
fi

echo "opencode auth is NOT ready inside the container."
echo
echo "Copy your host opencode config into the container with:"
echo "  $DIR/bin/docker-opencode-import-host-auth.sh"
echo
exit 1
