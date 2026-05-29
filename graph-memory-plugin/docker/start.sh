#!/bin/bash
set -euo pipefail

IMAGE="${1:-graph-memory-daemon:local}"
CONTAINER_NAME="graph-memory-daemon-graph-memory"
GRAPH_ROOT="${GRAPH_MEMORY_ROOT:-$HOME/.graph-memory}"
NOTION_DEFAULT_WORKSPACE_ID="24d726e6-b2f9-471c-aebb-544639a61393"

NOTION_WEBHOOK_SECRET=""
NOTION_WEBHOOK_SECRET=$(security find-generic-password -s "NOTION_WEBHOOK_SECRET" -a "graph-memory" -w 2>/dev/null || true)
NOTION_WORKSPACE_ID=""
NOTION_WORKSPACE_ID="${NOTION_WORKSPACE_ID:-$(security find-generic-password -s "notion-workspace-id" -w 2>/dev/null || printf '%s' "$NOTION_DEFAULT_WORKSPACE_ID")}"

ENV_ARGS=()
[ -n "$NOTION_WEBHOOK_SECRET" ] && ENV_ARGS+=(-e "NOTION_WEBHOOK_SECRET=$NOTION_WEBHOOK_SECRET")
[ -n "$NOTION_WORKSPACE_ID" ] && ENV_ARGS+=(-e "NOTION_WORKSPACE_ID=$NOTION_WORKSPACE_ID")

docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

exec docker run -d \
  --name "$CONTAINER_NAME" \
  -v "$GRAPH_ROOT:/graph-memory" \
  -v "graph-memory-auth-graph-memory:/graph-memory-auth" \
  -e GRAPH_MEMORY_DAEMON=1 \
  -e GRAPH_MEMORY_ROOT=/graph-memory \
  -e HOME=/graph-memory-auth \
  -e TZ=America/Los_Angeles \
  -p 3100:3100 \
  "${ENV_ARGS[@]}" \
  "$IMAGE"
