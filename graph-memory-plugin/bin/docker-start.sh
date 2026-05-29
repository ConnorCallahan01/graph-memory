#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
eval "$("$DIR/bin/runtime-env.sh")"

if [ "$GRAPH_MEMORY_RUNTIME_MODE" != "docker" ]; then
  echo "Runtime mode is $GRAPH_MEMORY_RUNTIME_MODE, not docker. Configure docker mode first."
  exit 1
fi

mkdir -p "$GRAPH_MEMORY_HOST_ROOT"

GRAPH_MEMORY_HOST_TIMEZONE="${TZ:-$(systemsetup -gettimezone 2>/dev/null | awk -F': ' 'NF>1{print $2}')}"
if [ -z "${GRAPH_MEMORY_HOST_TIMEZONE:-}" ]; then
  GRAPH_MEMORY_HOST_TIMEZONE="UTC"
fi
NOTION_DEFAULT_WORKSPACE_ID="24d726e6-b2f9-471c-aebb-544639a61393"

if ! docker image inspect "$GRAPH_MEMORY_DOCKER_IMAGE" >/dev/null 2>&1; then
  "$DIR/bin/docker-build.sh"
fi

docker rm -f "$GRAPH_MEMORY_DOCKER_CONTAINER" >/dev/null 2>&1 || true

docker run -d \
  --name "$GRAPH_MEMORY_DOCKER_CONTAINER" \
  --restart unless-stopped \
  --memory "$GRAPH_MEMORY_MEMORY_LIMIT" \
  --cpus "$GRAPH_MEMORY_CPU_LIMIT" \
  -e GRAPH_MEMORY_DAEMON=1 \
  -e GRAPH_MEMORY_ROOT="$GRAPH_MEMORY_CONTAINER_ROOT" \
  -e HOME="$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
  -e TZ="$GRAPH_MEMORY_HOST_TIMEZONE" \
  -e NOTION_API_TOKEN="${NOTION_API_TOKEN:-$(security find-generic-password -s notion-cli -w 2>/dev/null || true)}" \
  -e NOTION_WORKSPACE_ID="${NOTION_WORKSPACE_ID:-$(security find-generic-password -s notion-workspace-id -w 2>/dev/null || printf '%s' "$NOTION_DEFAULT_WORKSPACE_ID")}" \
  -e NOTION_WEBHOOK_SECRET="${NOTION_WEBHOOK_SECRET:-}" \
  -p 3100:3100 \
  -v "$GRAPH_MEMORY_HOST_ROOT:$GRAPH_MEMORY_CONTAINER_ROOT" \
  -v "$GRAPH_MEMORY_DOCKER_AUTH_VOLUME:$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
  "$GRAPH_MEMORY_DOCKER_IMAGE"
