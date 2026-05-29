#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$DIR/bin/node-env.sh"
export GRAPH_MEMORY_DAEMON=1

echo "=== graph-memory daemon startup ==="
echo "Provider: ${GRAPH_MEMORY_WORKER_PROVIDER:-auto}"
echo "HOME: $HOME"
echo "TZ: $TZ"
echo "CLI tools:"
command -v opencode >/dev/null 2>&1 && echo "  opencode: $(opencode --version 2>/dev/null || echo 'version-unknown')" || echo "  opencode: not found"
command -v codex >/dev/null 2>&1 && echo "  codex: $(codex --version 2>/dev/null || echo 'version-unknown')" || echo "  codex: not found"
command -v pi >/dev/null 2>&1 && echo "  pi: found" || echo "  pi: not found"
command -v claude >/dev/null 2>&1 && echo "  claude: found" || echo "  claude: not found"
echo "Auth state:"
test -f "$HOME/.local/share/opencode/auth.json" && echo "  opencode: auth found" || echo "  opencode: no auth"
test -f "$HOME/.config/opencode/opencode.json" && echo "  opencode config: found ($(grep -o '"model":"[^"]*"' "$HOME/.config/opencode/opencode.json" 2>/dev/null || echo 'no model set'))" || echo "  opencode config: not found"
test -f "$HOME/.codex/auth.json" && echo "  codex: auth found" || echo "  codex: no auth"
test -f "$HOME/.pi/agent/auth.json" && echo "  pi: auth found" || echo "  pi: no auth"
echo "==================================="

exec node "$DIR/dist/graph-memory/pipeline/daemon.js" "$@"
