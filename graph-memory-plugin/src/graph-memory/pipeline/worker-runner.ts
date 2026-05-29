import fs from "fs";
import os from "os";
import path from "path";
import { spawn, SpawnOptions } from "child_process";
import { loadRuntimeConfig, WorkerProvider } from "../runtime.js";
import { activityBus } from "../events.js";

export interface WorkerRunOptions {
  name: string;
  prompt: string;
  logDir: string;
  graphRoot: string;
  addDirs?: string[];
  model?: string;
  budgetUsd?: number;
  timeoutMs?: number;
}

export interface WorkerRunResult {
  exitCode: number;
  logFile: string;
  pid: number | undefined;
}

// ── Harness Adapter Interface ──────────────────────────────────────────────

interface HarnessSpawnPlan {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
}

interface HarnessAdapter {
  buildPlan(prompt: string, opts: WorkerRunOptions, runtime: ReturnType<typeof loadRuntimeConfig>): HarnessSpawnPlan;
}

// ── Codex Adapter ───────────────────────────────────────────────────────────

const codexAdapter: HarnessAdapter = {
  buildPlan(prompt, opts, runtime) {
    const inDocker = runtime.mode === "docker" &&
      process.env.GRAPH_MEMORY_ROOT === runtime.docker.graphRootInContainer;
    const authHome = inDocker
      ? runtime.docker.authPathInContainer
      : process.env.HOME;
    const sandboxMode = inDocker ? "danger-full-access" : "workspace-write";

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--cd", os.tmpdir(),
      "--color", "never",
    ];

    if (inDocker) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", sandboxMode, "--full-auto");
    }

    if (opts.model) {
      args.splice(args.length - 1, 0, "--model", opts.model);
    }

    for (const dir of opts.addDirs || []) {
      args.push("--add-dir", dir);
    }
    args.push("--add-dir", opts.graphRoot);
    args.push(prompt);

    return {
      command: "codex",
      args,
      spawnOptions: {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"] as const,
        env: {
          ...process.env,
          ...(authHome ? { HOME: authHome } : {}),
          GRAPH_MEMORY_DAEMON: "1",
          GRAPH_MEMORY_WORKER: "1",
          GRAPH_MEMORY_CHILD: "1",
        },
      },
    };
  },
};

// ── Claude Code Adapter ─────────────────────────────────────────────────────

const claudeAdapter: HarnessAdapter = {
  buildPlan(prompt, opts, _runtime) {
    const model = opts.model || "sonnet";
    const budget = opts.budgetUsd || 0.10;
    // Claude tool names are title-case: Read, Write, Edit, Bash, Grep, Glob, Find
    const allowedTools = "Read,Write,Edit,Bash,Grep,Glob";

    const args = [
      "-p", prompt,
      "--model", model,
      "--max-budget-usd", String(budget),
      "--allowedTools", allowedTools,
      "--add-dir", opts.graphRoot,
      "--output-format", "text",
    ];

    for (const dir of opts.addDirs || []) {
      args.push("--add-dir", dir);
    }

    return {
      command: "claude",
      args,
      spawnOptions: {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"] as const,
        env: {
          ...process.env,
          GRAPH_MEMORY_PIPELINE_CHILD: "1",
        },
      },
    };
  },
};

// ── Pi Adapter ──────────────────────────────────────────────────────────────

const piAdapter: HarnessAdapter = {
  buildPlan(prompt, opts, _runtime) {
    const args = [
      "--print", prompt,
      "--tools", "read,write,edit,bash,find",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-session",
      "--color", "never",
    ];

    if (opts.model) {
      args.unshift("--model", opts.model);
    }

    return {
      command: "pi",
      args,
      spawnOptions: {
        // Run from graph root so pi's tools can access the graph data
        cwd: opts.graphRoot,
        stdio: ["ignore", "pipe", "pipe"] as const,
        env: {
          ...process.env,
          GRAPH_MEMORY_PIPELINE_CHILD: "1",
        },
      },
    };
  },
};

// ── OpenCode Adapter ───────────────────────────────────────────────────────

const opencodeAdapter: HarnessAdapter = {
  buildPlan(prompt, opts, runtime) {
    const inDocker = runtime.mode === "docker" &&
      process.env.GRAPH_MEMORY_ROOT === runtime.docker.graphRootInContainer;
    const authHome = inDocker
      ? runtime.docker.authPathInContainer
      : process.env.HOME;

    const args = [
      "run", prompt,
      "--dir", opts.graphRoot,
      "--dangerously-skip-permissions",
    ];

    if (opts.model) {
      args.unshift("--model", opts.model);
    }

    return {
      command: "opencode",
      args,
      spawnOptions: {
        cwd: opts.graphRoot,
        stdio: ["ignore", "pipe", "pipe"] as const,
        env: {
          ...process.env,
          ...(authHome ? { HOME: authHome } : {}),
          GRAPH_MEMORY_PIPELINE_CHILD: "1",
        },
      },
    };
  },
};

// ── Harness Dispatch ────────────────────────────────────────────────────────

const ADAPTERS: Record<WorkerProvider, HarnessAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  pi: piAdapter,
  opencode: opencodeAdapter,
};

function resolveHarness(): WorkerProvider {
  // 1. Explicit env override
  if (process.env.GRAPH_MEMORY_WORKER_PROVIDER) {
    const v = process.env.GRAPH_MEMORY_WORKER_PROVIDER as WorkerProvider;
    if (ADAPTERS[v]) return v;
    console.error(`[graph-memory] Unknown GRAPH_MEMORY_WORKER_PROVIDER=${v}, falling back`);
  }

  // 2. Runtime config
  try {
    const runtime = loadRuntimeConfig();
    if (runtime.mode === "docker" && ADAPTERS[runtime.docker.workerProvider]) {
      return runtime.docker.workerProvider;
    }
    // For manual mode, check if the runtime config has a worker provider set
    // (configureRuntime stores it in docker.workerProvider regardless of mode)
    if (ADAPTERS[runtime.docker.workerProvider]) {
      return runtime.docker.workerProvider;
    }
  } catch {
    // Fall through
  }

  // 3. Auto-detect: first match on PATH, then codex
  const which = (cmd: string) => {
    const r = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise<boolean>((resolve) => {
      r.on("close", (code) => resolve(code === 0));
      r.on("error", () => resolve(false));
    });
  };
  // We can't easily check sync in the adapter function, so default to codex
  // and let the spawn itself fail if codex isn't available (that's a clear error)
  return "codex";
}

// ── Main Runner ─────────────────────────────────────────────────────────────

export async function runPipelineWorker(opts: WorkerRunOptions): Promise<WorkerRunResult> {
  const harness = resolveHarness();
  const runtime = loadRuntimeConfig();
  const adapter = ADAPTERS[harness];

  if (!adapter) {
    throw new Error(`Unsupported worker harness: ${harness}`);
  }

  if (!fs.existsSync(opts.logDir)) {
    fs.mkdirSync(opts.logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(opts.logDir, `${opts.name}-${timestamp}.log`);
  const fd = fs.openSync(logFile, "w");

  const plan = adapter.buildPlan(opts.prompt, opts, runtime);

  // Redirect stdio to log file for detached output
  plan.spawnOptions.stdio = ["ignore", fd, fd];

  const child = spawn(plan.command, plan.args, {
    ...plan.spawnOptions,
    detached: true,
  });

  const pid = child.pid;
  activityBus.log("system:info", `Worker spawned: ${plan.command} ${plan.args.slice(0, 3).join(" ")}... (pid=${pid})`, { harness, pid, logFile });

  child.on("error", (err) => {
    activityBus.log("system:error", `Worker spawn error (pid=${pid}): ${err.message}`, { harness, pid });
  });

  const timeoutMs = Math.max(30_000, opts.timeoutMs ?? 300_000);
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }

    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
    }, 5_000);
  }, timeoutMs);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  clearTimeout(timeout);
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }

  try {
    fs.closeSync(fd);
  } catch { /* ignore */ }

  // Write metadata alongside the log
  const metaPath = logFile + ".meta.json";
  try {
    fs.writeFileSync(metaPath, JSON.stringify({
      name: opts.name,
      harness,
      pid,
      startedAt: new Date().toISOString(),
      logFile,
      exitCode,
      finishedAt: new Date().toISOString(),
      status: exitCode === 0 ? "completed" : "failed",
    }, null, 2));
  } catch { /* ignore */ }

  if (timedOut) {
    throw new Error(`Worker (${harness}) timed out after ${timeoutMs}ms. See ${logFile}`);
  }

  return { exitCode, logFile, pid };
}