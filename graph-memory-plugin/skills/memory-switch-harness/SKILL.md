---
name: memory-switch-harness
description: Switch the background pipeline worker harness (codex, claude, pi, opencode) for an already-initialized graph memory system. Use when the user wants to change which agent runs the scribe/auditor/librarian/dreamer daemon pipeline.
---

# /memory-switch-harness

Switch the agent harness that runs the background memory pipeline (scribe → auditor → librarian → dreamer).

## Instructions

### Phase 1: Read current state

1. Try `graph_memory(action="status")`. If it succeeds, extract `mode`, `docker.workerProvider`, `docker.containerName`, and whether memory is initialized.
2. If `status` fails (e.g., MCP server down), fall back to reading `~/.graph-memory/.runtime-config.json` directly. Parse the JSON to get `mode`, `docker.workerProvider`, and `docker.containerName`. Also check for `~/.graph-memory/MAP.md` to confirm initialization.
3. If memory is not initialized (no MAP.md), tell the user to run `/memory-onboard` first. Stop.
4. Extract the current `workerProvider` from the config (fall back to `codex` if missing).
5. Present the current harness and available options:

```
Current harness: <current>
Runtime mode: <mode>
Available: codex | claude | pi | opencode
```

6. Briefly explain what each harness means:
   - **codex** — OpenAI Codex CLI. Best for ChatGPT subscribers. Requires `codex login` or `OPENAI_API_KEY`.
   - **claude** — Anthropic Claude Code. Best for Claude subscribers. Uses existing OAuth or `ANTHROPIC_API_KEY`.
   - **pi** — pi coding agent. Open-source, provider-agnostic. Uses `/login` subscription or API keys (any supported provider: Anthropic, OpenAI, OpenRouter, etc.).
   - **opencode** — OpenCode. Open-source, provider-agnostic. Uses provider API keys configured via `opencode providers`.

7. Ask which harness they want to switch to.

### Phase 1b: Model override (optional)

7b. Ask if they want to set a model override for pipeline workers. Explain:
    - Each harness has a default model (e.g. codex uses the ChatGPT default, claude uses `sonnet`).
    - Setting `workerModel` overrides this for all pipeline stages (scribe, auditor, librarian, dreamer, etc.).
    - Common values: `sonnet`, `o3`, `o4-mini`, `gpt-4.1`, `claude-sonnet-4-20250514`, etc. The value depends on the chosen harness's model naming.
    - Pass `null` or omit to use the harness default.
    - Current `workerModel` is shown in status as `runtime.docker.workerModel`.

### Phase 2: Apply the config switch

8. Once they pick, try `graph_memory(action="configure_runtime", runtimeMode="<mode>", workerProvider="<chosen_harness>", workerModel="<model>" or omit)`.
   - `<mode>` is the current runtime mode from status (typically `docker`).
9. If that fails, fall back to directly editing `~/.graph-memory/.runtime-config.json`: read it, set `docker.workerProvider` to the chosen harness, set `updatedAt` to now, and write it back.

### Phase 3: Ensure Docker image has the harness CLI

10. **Docker mode only (skip if manual mode).** Verify the chosen harness CLI is available inside the running container:
    ```bash
    docker exec "$GRAPH_MEMORY_DOCKER_CONTAINER" which <harness_cli> 2>/dev/null
    ```
    Where `<harness_cli>` is `codex` for codex, `claude` for claude, `pi` for pi, or `opencode` for opencode.

11. **If the CLI is not found** (command fails or returns empty): rebuild the image and restart.
    - First, check the Dockerfile at `<plugin_dir>/docker/Dockerfile` to confirm the harness CLI is included in the install steps. If it's missing from the Dockerfile, add the appropriate install command:
      - **codex**: `@openai/codex` via `npm install -g`
      - **claude**: already bundled in the base node image (no Dockerfile change needed)
      - **pi**: `@mariozechner/pi-coding-agent` via `npm install -g`
      - **opencode**: via `curl -fsSL https://opencode.ai/install | bash`
    - Then rebuild:
      ```bash
      cd <plugin_dir> && npm install --ignore-scripts && bin/docker-build.sh
      ```
      (The `npm install` syncs the lockfile before the Docker build uses `npm ci`.)

12. **If the CLI is found**: no rebuild needed. Continue to Phase 4.

### Phase 4: Restart the daemon

13. **Docker mode:** Determine the plugin directory by finding `graph-memory-plugin/` (search from cwd, then home). Run:
    ```bash
    <plugin_dir>/bin/docker-stop.sh && <plugin_dir>/bin/docker-start.sh
    ```
14. **Manual mode:** If a daemon PID file or lock exists, kill the process and restart it. If you can't determine the process, tell the user to restart manually.

### Phase 5: Handle auth setup

15. Run `<plugin_dir>/bin/docker-auth-check.sh`. This script reads the current `workerProvider` from the runtime config and checks the corresponding auth.

16. **If auth passes**: Confirm success. Done.
    ```
    Harness switched to **<harness>**. Container **<containerName>** restarted and auth is ready.
    ```

17. **If auth fails**: Present the setup path for the chosen harness:

    **For codex:**
    ```
    codex auth is not ready in the container. Choose a setup path:

    A) If you're already logged in on the host:
       <plugin_dir>/bin/docker-codex-import-host-auth.sh

    B) If you want to log in interactively inside the container:
       <plugin_dir>/bin/docker-codex-login.sh

    C) If you have an OpenAI API key:
       OPENAI_API_KEY=sk-... <plugin_dir>/bin/docker-codex-login-api-key.sh
    ```

    **For claude:**
    ```
    claude harness: auth is not automated. The container needs one of:

    A) ANTHROPIC_API_KEY env var set when the container starts
       (add -e ANTHROPIC_API_KEY=sk-ant-... to docker-start.sh)

    B) Claude OAuth token (if using Claude Code subscription)
       (copy host ~/.claude.json to the auth volume)
    ```

     **For pi:**
     ```
     pi auth is not ready in the container. Choose a setup path:

     A) If you're already authenticated on the host:
        <plugin_dir>/bin/docker-pi-import-host-auth.sh

     B) If you need to authenticate on the host first:
        1. Run `pi` on the host
        2. Use `/login` to authenticate with a subscription provider
        3. Exit pi
        4. Run <plugin_dir>/bin/docker-pi-import-host-auth.sh

     C) If you have an API key you want to use:
        1. Create/edit ~/.pi/agent/auth.json on the host:
           {
             "<provider>": {
               "type": "api_key",
               "key": "sk-..."
             }
           }
        2. Set your default provider/model in ~/.pi/agent/settings.json:
           { "defaultProvider": "<provider>", "defaultModel": "<model>" }
        3. Run <plugin_dir>/bin/docker-pi-import-host-auth.sh
     ```

     **For opencode:**
     ```
     opencode auth is not ready in the container. Choose a setup path:

     A) If you're already authenticated on the host:
        <plugin_dir>/bin/docker-opencode-import-host-auth.sh

     B) If you need to configure a provider API key on the host first:
        1. Run `opencode providers` on the host
        2. Follow prompts to add a provider (Anthropic, OpenAI, OpenRouter, etc.)
        3. Run <plugin_dir>/bin/docker-opencode-import-host-auth.sh
     ```

18. After the user completes auth setup, rerun `<plugin_dir>/bin/docker-auth-check.sh` to confirm.
