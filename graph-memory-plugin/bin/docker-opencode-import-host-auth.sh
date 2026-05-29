#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
eval "$("$DIR/bin/runtime-env.sh")"

HOST_CONFIG="$HOME/.config/opencode"
HOST_DATA="$HOME/.local/share/opencode"

IMPORTED=false

if [ -d "$HOST_DATA" ] && [ -f "$HOST_DATA/auth.json" ]; then
  echo "Importing opencode auth from: $HOST_DATA/auth.json"
  docker run --rm \
    -v "$GRAPH_MEMORY_DOCKER_AUTH_VOLUME:$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
    -v "$HOST_DATA/auth.json:/host-auth.json:ro" \
    alpine sh -c "mkdir -p '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode' && cp /host-auth.json '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode/auth.json' && chmod 600 '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.local/share/opencode/auth.json'"
  IMPORTED=true
fi

if [ -d "$HOST_CONFIG" ]; then
  HOST_CONFIG_FILE=""
  for f in "$HOST_CONFIG/opencode.json" "$HOST_CONFIG/opencode.jsonc" "$HOST_CONFIG/config.json"; do
    if [ -f "$f" ]; then
      HOST_CONFIG_FILE="$f"
      break
    fi
  done

  if [ -n "$HOST_CONFIG_FILE" ]; then
    echo "Importing opencode config from: $HOST_CONFIG_FILE"
    docker run --rm \
      -v "$GRAPH_MEMORY_DOCKER_AUTH_VOLUME:$GRAPH_MEMORY_CONTAINER_AUTH_PATH" \
      -v "$HOST_CONFIG:/host-opencode-config:ro" \
      alpine sh -c "mkdir -p '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.config/opencode' && cp -r /host-opencode-config/. '$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.config/opencode/'"
    IMPORTED=true
  fi
fi

if [ "$IMPORTED" = true ] && [ -f "$HOST_DATA/auth.json" ]; then
  HOST_MODEL="${OPENCODE_PIPELINE_MODEL:-}"
  if [ -z "$HOST_MODEL" ]; then
    HOST_MODEL=$(grep -o '"modelID"[[:space:]]*:[[:space:]]*"[^"]*"' "$HOST_DATA"/storage/message/*/msg_*.json 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"')
  fi
  if [ -n "$HOST_MODEL" ]; then
    echo "Resolved model from host sessions: $HOST_MODEL"
    CONTAINER_CONFIG="/tmp/opencode-container-config.json"
    echo '{"$schema":"https://opencode.ai/config.json","model":"zai-coding-plan/'"$HOST_MODEL"'"}' > "$CONTAINER_CONFIG"
    docker cp "$CONTAINER_CONFIG" "$GRAPH_MEMORY_DOCKER_CONTAINER:$GRAPH_MEMORY_CONTAINER_AUTH_PATH/.config/opencode/opencode.json"
    rm -f "$CONTAINER_CONFIG"
    echo "Wrote container-safe opencode config with model: zai-coding-plan/$HOST_MODEL"
  else
    echo "Warning: could not resolve host model. Container will use opencode defaults."
  fi
fi

if [ "$IMPORTED" = false ]; then
  echo "No opencode auth or config found on the host."
  echo "Checked: $HOST_DATA/auth.json, $HOST_CONFIG/opencode.json"
  echo "Run 'opencode providers' on the host to configure a provider first."
  exit 1
fi

echo "opencode auth imported into container."
echo

"$DIR/bin/docker-opencode-auth-status.sh"
