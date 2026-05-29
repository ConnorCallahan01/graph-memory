import fs from "fs";
import path from "path";

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

export interface PluginHooksFile {
  hooks: Record<string, HookEntry[]>;
}

export function loadPluginHooks(filePath: string): PluginHooksFile {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PluginHooksFile;
}

const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";

function resolveCommand(command: string, pluginDir: string): string {
  return command.replaceAll(PLUGIN_ROOT, pluginDir);
}

function sameHookCommand(left: HookCommand, right: HookCommand): boolean {
  return left.type === right.type && left.command === right.command;
}

function sameHookEntry(left: HookEntry, right: HookEntry): boolean {
  if (left.matcher !== right.matcher) return false;
  if (left.hooks.length !== right.hooks.length) return false;
  return left.hooks.every((hook, index) => sameHookCommand(hook, right.hooks[index]!));
}

export function mergeHooksIntoSettings(
  settings: Record<string, unknown>,
  pluginHooks: PluginHooksFile,
  pluginDir?: string
): boolean {
  const resolvedDir = pluginDir || "";
  const hooksRoot =
    typeof settings.hooks === "object" && settings.hooks !== null
      ? (settings.hooks as Record<string, unknown>)
      : {};

  settings.hooks = hooksRoot;

  let changed = false;

  for (const [eventName, entries] of Object.entries(pluginHooks.hooks)) {
    const existing = Array.isArray(hooksRoot[eventName])
      ? (hooksRoot[eventName] as HookEntry[])
      : [];

    if (!Array.isArray(hooksRoot[eventName])) {
      hooksRoot[eventName] = existing;
      changed = true;
    }

    for (const rawEntry of entries) {
      const resolved: HookEntry = {
        matcher: rawEntry.matcher,
        hooks: rawEntry.hooks.map((h) => ({
          type: h.type,
          command: resolveCommand(h.command, resolvedDir),
        })),
      };

      if (existing.some((candidate) => sameHookEntry(candidate, resolved))) {
        continue;
      }
      existing.push(resolved);
      changed = true;
    }
  }

  return changed;
}

export function registerPluginHooks(settingsPath: string, hooksPath: string): boolean {
  const settings = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  const pluginHooks = loadPluginHooks(hooksPath);
  const pluginDir = fs.existsSync(hooksPath)
    ? fs.realpathSync(path.dirname(path.dirname(hooksPath)))
    : "";
  const changed = mergeHooksIntoSettings(settings, pluginHooks, pluginDir);

  if (changed || !fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  return changed;
}
