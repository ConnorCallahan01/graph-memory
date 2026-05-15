FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npm install -g @openai/codex @mariozechner/pi-coding-agent
RUN ARCH=$(uname -m) && \
    case "$ARCH" in aarch64) GOARCH="arm64" ;; x86_64) GOARCH="amd64" ;; esac && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-${GOARCH}.tar.gz" \
    | tar xz -C /usr/local/bin opencode

RUN curl -fsSL https://ntn.dev/install.sh | bash

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY commands ./commands
COPY agents ./agents
COPY skills ./skills
COPY hooks ./hooks
COPY docker/healthcheck.sh /usr/local/bin/graph-memory-healthcheck

RUN npm run build \
  && chmod +x /usr/local/bin/graph-memory-healthcheck /app/bin/*.sh

ENV GRAPH_MEMORY_DAEMON=1
ENV GRAPH_MEMORY_ROOT=/graph-memory
ENV HOME=/graph-memory-auth

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/graph-memory-healthcheck"]

CMD ["bash", "/app/bin/graph-memory-daemon.sh"]
