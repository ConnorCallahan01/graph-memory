---
description: Switch the worker harness used for pipeline background jobs
---

# /memory-switch-harness

Switch the agent harness that runs the background memory pipeline.

## Instructions

1. Call `graph_memory` with action `status` to confirm memory is initialized and get current runtime config.
2. If memory is not initialized, tell the user to run `/memory-onboard` first. Stop.
3. Extract the current `workerProvider` from `runtime.docker.workerProvider` (or fall back to showing `codex` as the default).
4. Present the current harness and available options.
5. Briefly explain each harness:
   - **codex** — OpenAI Codex CLI. Best for ChatGPT subscribers. Requires `codex login`.
   - **claude** — Anthropic Claude Code. Best for Claude subscribers. Uses existing OAuth or `ANTHROPIC_API_KEY`.
   - **pi** — pi coding agent. Open-source, provider-agnostic. Uses subscription or provider API keys.
   - **opencode** — OpenCode. Open-source, provider-agnostic. Uses provider API keys via `opencode providers`.
6. Ask which harness they want to switch to.
7. Ask if they want to set a model override for pipeline workers (optional). Each harness has a default model, but they can specify one (e.g. `sonnet`, `o3`, `gpt-4.1`). The current `workerModel` is shown in status as `runtime.docker.workerModel`.
8. Call `graph_memory(action="configure_runtime", runtimeMode="docker", workerProvider="<chosen>", workerModel="<model>" or omit)`.
9. Confirm and give restart instructions:
   - Docker mode: "Restart the daemon container: `bin/docker-stop.sh && bin/docker-start.sh`"
   - Manual mode: "Restart any running daemon. Make sure `<harness>` is on PATH."
