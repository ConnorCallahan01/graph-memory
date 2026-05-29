import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { CONFIG } from "./config.js";

export type GraphMemoryRuntimeMode = "manual" | "docker";

export interface RepoMountConfig {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

export type WorkerProvider = "codex" | "claude" | "pi" | "opencode";

export interface DockerRuntimeConfig {
  enabled: boolean;
  workerProvider: WorkerProvider;
  workerModel?: string;
  image: string;
  containerName: string;
  authVolume: string;
  graphRootInContainer: string;
  authPathInContainer: string;
  memoryLimit: string;
  cpuLimit: string;
  repoMounts: RepoMountConfig[];
}

export interface GraphMemoryRuntimeConfig {
  mode: GraphMemoryRuntimeMode;
  createdAt: string;
  updatedAt: string;
  graphRoot: string;
  docker: DockerRuntimeConfig;
}

export type RuntimeConfigPatch = Omit<Partial<GraphMemoryRuntimeConfig>, "docker"> & {
  docker?: Partial<DockerRuntimeConfig>;
};

interface CommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "graph-memory";
}

function resolveDefaultWorkerProvider(): WorkerProvider {
  // Prefer what's already on PATH, falling back to codex
  const which = (cmd: string) => {
    const r = spawnSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0;
  };
  if (which("opencode")) return "opencode";
  if (which("codex")) return "codex";
  if (which("claude")) return "claude";
  return "codex";
}

function defaultDockerConfig(graphRoot: string): DockerRuntimeConfig {
  const suffix = slugify(path.basename(graphRoot));
  return {
    enabled: true,
    workerProvider: resolveDefaultWorkerProvider(),
    image: "graph-memory-daemon:local",
    containerName: `graph-memory-daemon-${suffix}`,
    authVolume: `graph-memory-auth-${suffix}`,
    graphRootInContainer: "/graph-memory",
    authPathInContainer: "/graph-memory-auth",
    memoryLimit: "6g",
    cpuLimit: "6.0",
    repoMounts: [],
  };
}

export function defaultRuntimeConfig(graphRoot = CONFIG.paths.graphRoot): GraphMemoryRuntimeConfig {
  const timestamp = new Date().toISOString();
  return {
    mode: "manual",
    createdAt: timestamp,
    updatedAt: timestamp,
    graphRoot,
    docker: defaultDockerConfig(graphRoot),
  };
}

export function loadRuntimeConfig(): GraphMemoryRuntimeConfig {
  const configPath = CONFIG.paths.runtimeConfig;
  if (!fs.existsSync(configPath)) {
    return defaultRuntimeConfig();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<GraphMemoryRuntimeConfig>;
    const defaults = defaultRuntimeConfig(parsed.graphRoot || CONFIG.paths.graphRoot);
    return {
      ...defaults,
      ...parsed,
      docker: {
        ...defaults.docker,
        ...(parsed.docker || {}),
        repoMounts: parsed.docker?.repoMounts || defaults.docker.repoMounts,
      },
    };
  } catch {
    return defaultRuntimeConfig();
  }
}

export function saveRuntimeConfig(next: RuntimeConfigPatch): GraphMemoryRuntimeConfig {
  const current = loadRuntimeConfig();
  const merged: GraphMemoryRuntimeConfig = {
    ...current,
    ...next,
    docker: {
      ...current.docker,
      ...(next.docker || {}),
      repoMounts: next.docker?.repoMounts || current.docker.repoMounts,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!fs.existsSync(CONFIG.paths.graphRoot)) {
    fs.mkdirSync(CONFIG.paths.graphRoot, { recursive: true });
  }
  fs.writeFileSync(CONFIG.paths.runtimeConfig, JSON.stringify(merged, null, 2));
  return merged;
}

export function ensureRuntimeConfig(): GraphMemoryRuntimeConfig {
  if (!fs.existsSync(CONFIG.paths.runtimeConfig)) {
    return saveRuntimeConfig(defaultRuntimeConfig());
  }
  return loadRuntimeConfig();
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = result.stdout?.trim?.() || "";
  const stderr = result.stderr?.trim?.() || "";
  if (result.status === 0) {
    return { ok: true, stdout, stderr };
  }

  return {
    ok: false,
    stdout,
    stderr,
    error: result.error?.message || `Command exited with status ${result.status ?? "unknown"}`,
  };
}

function getDockerState(runtime: GraphMemoryRuntimeConfig): Record<string, unknown> | null {
  const dockerCheck = runCommand("docker", ["--version"]);
  if (!dockerCheck.ok) {
    return {
      available: false,
      error: dockerCheck.error || dockerCheck.stderr || "docker not available",
    };
  }

  const inspect = runCommand("docker", [
    "inspect",
    runtime.docker.containerName,
    "--format",
    "{{json .State}}",
  ]);

  if (!inspect.ok || !inspect.stdout) {
    return {
      available: true,
      present: false,
      error: inspect.stderr || inspect.error || "container missing",
    };
  }

  try {
    const state = JSON.parse(inspect.stdout) as Record<string, unknown>;
    return {
      available: true,
      present: true,
      ...state,
    };
  } catch {
    return {
      available: true,
      present: true,
      raw: inspect.stdout,
    };
  }
}

function getCodexAuthState(runtime: GraphMemoryRuntimeConfig, dockerState: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!dockerState || dockerState.available !== true || dockerState.present !== true || dockerState.Running !== true) {
    return null;
  }

  const auth = runCommand("docker", [
    "exec",
    "-e", `HOME=${runtime.docker.authPathInContainer}`,
    runtime.docker.containerName,
    "bash",
    "-lc",
    "codex login status",
  ]);

  if (!auth.ok) {
    return {
      ready: false,
      error: auth.stderr || auth.error || "codex auth unavailable",
    };
  }

  const output = auth.stdout || auth.stderr || "";
  return {
    ready: /Logged in/i.test(output),
    status: output,
  };
}

function getOpenCodeAuthState(runtime: GraphMemoryRuntimeConfig, dockerState: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!dockerState || dockerState.available !== true || dockerState.present !== true || dockerState.Running !== true) {
    return null;
  }

  const auth = runCommand("docker", [
    "exec",
    "-e", `HOME=${runtime.docker.authPathInContainer}`,
    runtime.docker.containerName,
    "bash",
    "-lc",
    'cat "$HOME/.local/share/opencode/auth.json" 2>/dev/null || for f in "$HOME/.config/opencode/config.json" "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.jsonc"; do [ -f "$f" ] && cat "$f" && break; done',
  ]);

  if (!auth.ok || !auth.stdout) {
    return {
      ready: false,
      error: auth.stderr || auth.error || "opencode auth unavailable",
    };
  }

  const hasKey = /"key"|"token"|"apiKey"|"api_key"|"apiKeyId"/i.test(auth.stdout);
  return {
    ready: hasKey,
    status: hasKey ? "opencode auth is ready" : "config exists but no provider credentials found",
  };
}

export function getRuntimeStatus(): Record<string, unknown> {
  const runtime = loadRuntimeConfig();
  let daemonState: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(CONFIG.paths.daemonState)) {
      daemonState = JSON.parse(fs.readFileSync(CONFIG.paths.daemonState, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    daemonState = null;
  }

  const dockerState = runtime.mode === "docker" ? getDockerState(runtime) : null;
  const codexAuth = runtime.mode === "docker" ? getCodexAuthState(runtime, dockerState) : null;
  const opencodeAuth = runtime.mode === "docker" ? getOpenCodeAuthState(runtime, dockerState) : null;

  return {
    mode: runtime.mode,
    graphRoot: runtime.graphRoot,
    docker: runtime.mode === "docker" ? {
      enabled: runtime.docker.enabled,
      workerProvider: runtime.docker.workerProvider,
      workerModel: runtime.docker.workerModel || null,
      image: runtime.docker.image,
      containerName: runtime.docker.containerName,
      authVolume: runtime.docker.authVolume,
      graphRootInContainer: runtime.docker.graphRootInContainer,
      authPathInContainer: runtime.docker.authPathInContainer,
      repoMountCount: runtime.docker.repoMounts.length,
      memoryLimit: runtime.docker.memoryLimit,
      cpuLimit: runtime.docker.cpuLimit,
      state: dockerState,
      codexAuth,
      opencodeAuth,
    } : null,
    daemonState,
    daemonLockPresent: fs.existsSync(CONFIG.paths.daemonLock),
  };
}
