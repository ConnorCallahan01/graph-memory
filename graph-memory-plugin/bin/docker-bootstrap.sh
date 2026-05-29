#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
eval "$("$DIR/bin/runtime-env.sh")"

if [ "$GRAPH_MEMORY_RUNTIME_MODE" != "docker" ]; then
  echo "Runtime mode is $GRAPH_MEMORY_RUNTIME_MODE, not docker. Configure docker mode first."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running or not reachable."
  exit 1
fi

PROVIDER="${GRAPH_MEMORY_WORKER_PROVIDER:-}"

echo "=== graph-memory bootstrap ==="
echo "Worker provider: ${PROVIDER:-auto}"
echo

echo "[1/5] Building image..."
docker build -f "$DIR/docker/Dockerfile" -t "$GRAPH_MEMORY_DOCKER_IMAGE" "$DIR" --quiet
echo "  Image: $GRAPH_MEMORY_DOCKER_IMAGE"

echo "[2/5] Starting container..."
mkdir -p "$GRAPH_MEMORY_HOST_ROOT"
docker rm -f "$GRAPH_MEMORY_DOCKER_CONTAINER" >/dev/null 2>&1 || true

GRAPH_MEMORY_HOST_TIMEZONE="${TZ:-$(systemsetup -gettimezone 2>/dev/null | awk -F': ' 'NF>1{print $2}')}"
if [ -z "${GRAPH_MEMORY_HOST_TIMEZONE:-}" ]; then
  GRAPH_MEMORY_HOST_TIMEZONE="UTC"
fi
NOTION_DEFAULT_WORKSPACE_ID="24d726e6-b2f9-471c-aebb-544639a61393"

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
  "$GRAPH_MEMORY_DOCKER_IMAGE" >/dev/null

echo "[3/5] Waiting for healthcheck..."
attempt=0
until "$DIR/bin/docker-healthcheck.sh" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "  FAILED - healthcheck did not pass in time."
    docker logs "$GRAPH_MEMORY_DOCKER_CONTAINER" 2>&1 | tail -20
    exit 1
  fi
  sleep 2
done
echo "  Healthy."

echo "[4/5] Importing auth + updating plugin..."
docker cp "$DIR/extensions/graph-memory-opencode.ts" "$GRAPH_MEMORY_DOCKER_CONTAINER:$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.config/opencode/plugins/graph-memory.ts" 2>/dev/null && echo "  plugin: updated" || echo "  plugin: no extension found (skipped)"
AUTH_IMPORTED=false

if [ "$PROVIDER" = "opencode" ] || [ "$PROVIDER" = "auto" ] || [ -z "$PROVIDER" ]; then
  HOST_DATA="$HOME/.local/share/opencode"
  HOST_CONFIG="$HOME/.config/opencode"
  if [ -f "$HOST_DATA/auth.json" ]; then
    echo "  opencode: importing auth.json..."
    docker run --rm \
      -v "$GRAPH_MEMORY_DOCKER_AUTH_VOLUME:$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
      -v "$HOST_DATA/auth.json:/host-auth.json:ro" \
      alpine sh -c "mkdir -p '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode' && cp /host-auth.json '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode/auth.json' && chmod 600 '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode/auth.json'" >/dev/null 2>&1
    AUTH_IMPORTED=true

    HOST_MODEL="${OPENCODE_PIPELINE_MODEL:-}"
    if [ -z "$HOST_MODEL" ]; then
      HOST_MODEL=$(grep -o '"modelID"[[:space:]]*:[[:space:]]*"[^"]*"' "$HOST_DATA"/storage/message/*/msg_*.json 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"')
    fi
    if [ -n "$HOST_MODEL" ]; then
      CONTAINER_CONFIG="/tmp/opencode-container-config.json"
      echo '{"$schema":"https://opencode.ai/config.json","model":"zai-coding-plan/'"$HOST_MODEL"'"}' > "$CONTAINER_CONFIG"
      docker cp "$CONTAINER_CONFIG" "$GRAPH_MEMORY_DOCKER_CONTAINER:$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.config/opencode/opencode.json" >/dev/null
      rm -f "$CONTAINER_CONFIG"
      echo "  opencode: resolved model zai-coding-plan/$HOST_MODEL"
    else
      echo "  opencode: warning - could not resolve host model, using defaults"
    fi
  else
    echo "  opencode: no auth found at $HOST_DATA/auth.json"
  fi
fi

if [ "$PROVIDER" = "codex" ] || [ "$PROVIDER" = "auto" ] || [ -z "$PROVIDER" ]; then
  if command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1; then
    echo "  codex: importing host auth..."
    "$DIR/bin/docker-codex-import-host-auth.sh" >/dev/null 2>&1 && AUTH_IMPORTED=true || echo "  codex: import failed"
  else
    echo "  codex: no host auth"
  fi
fi

echo "[5/5] Status..."
echo
docker logs "$GRAPH_MEMORY_DOCKER_CONTAINER" 2>&1 | head -20
echo
echo "=== bootstrap complete ==="
if [ "$AUTH_IMPORTED" = false ]; then
  echo "WARNING: No auth was imported. Pipeline workers may fail."
fi
