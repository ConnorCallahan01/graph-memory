import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { CONFIG } from "../config.js";
import { computeNodeContentHash, computeMultiNodeContentHash } from "./skillforge-score.js";

export interface HarnessAdapter {
  harness: string;
  installDir: string;
  fileExtension: string;
  wrapper: (name: string, description: string, content: string) => string;
}

export const HARNESS_ADAPTERS: Record<string, HarnessAdapter> = {
  "claude-code": {
    harness: "claude-code",
    installDir: ".claude/commands",
    fileExtension: ".md",
    wrapper: (_name, _description, content) => content,
  },
  "opencode": {
    harness: "opencode",
    installDir: ".opencode/commands",
    fileExtension: ".md",
    wrapper: (_name, description, content) => `---\ndescription: ${description}\n---\n\n${content}`,
  },
};

export interface SkillforgeManifest {
  version: 2;
  source_nodes: string[];
  skill_name: string;
  generated_at: string;
  score: number;
  project: string;
  project_root: string | null;
  content_hash: string;
  candidate_type: "cluster" | "single_node";
  canonical_content_path: string;
  installed_harnesses: Record<string, string>;
  reference_nodes: string[];
  refresh_count: number;
  last_refreshed_at: string | null;
  last_accessed_at_refresh: string | null;
}

export function readManifest(fileName: string): SkillforgeManifest | null {
  const filePath = path.join(CONFIG.paths.skillforgeManifests, fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SkillforgeManifest;
  } catch {
    return null;
  }
}

export function listManifests(): SkillforgeManifest[] {
  const dir = CONFIG.paths.skillforgeManifests;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readManifest(f))
    .filter((m): m is SkillforgeManifest => m !== null);
}

export function manifestKeyForNodes(nodePaths: string[]): string {
  return nodePaths.sort().join("+").replace(/\//g, "-") + ".json";
}

export function writeManifest(manifest: SkillforgeManifest): void {
  const key = manifestKeyForNodes(manifest.source_nodes);
  const filePath = path.join(CONFIG.paths.skillforgeManifests, key);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

export function writeCanonicalContent(skillName: string, content: string): string {
  const contentDir = path.join(CONFIG.paths.skillforgeManifests, "content");
  if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });
  const contentPath = path.join(contentDir, `${skillName}.md`);
  fs.writeFileSync(contentPath, content);
  return path.relative(CONFIG.paths.graphRoot, contentPath);
}

export function readCanonicalContent(skillName: string): string | null {
  const contentPath = path.join(CONFIG.paths.skillforgeManifests, "content", `${skillName}.md`);
  if (!fs.existsSync(contentPath)) return null;
  return fs.readFileSync(contentPath, "utf-8");
}

export function installSkillToProject(
  manifest: SkillforgeManifest,
  projectRoot: string,
  harnessIds?: string[]
): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];

  const content = readCanonicalContent(manifest.skill_name);
  if (!content) {
    errors.push(`Canonical content not found for ${manifest.skill_name}`);
    return { installed, errors };
  }

  const description = content.split("\n").find(l => l.trim() && !l.startsWith("#"))?.trim() || manifest.skill_name;

  const targetHarnesses = harnessIds || Object.keys(HARNESS_ADAPTERS);
  for (const harnessId of targetHarnesses) {
    const adapter = HARNESS_ADAPTERS[harnessId];
    if (!adapter) {
      errors.push(`Unknown harness: ${harnessId}`);
      continue;
    }

    const installDir = path.join(projectRoot, adapter.installDir);
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

    const filePath = path.join(installDir, `${manifest.skill_name}${adapter.fileExtension}`);
    const wrapped = adapter.wrapper(manifest.skill_name, description, content);

    try {
      fs.writeFileSync(filePath, wrapped);
      manifest.installed_harnesses[harnessId] = path.relative(projectRoot, filePath);
      installed.push(harnessId);
    } catch (err: any) {
      errors.push(`Failed to install ${harnessId}: ${err.message}`);
    }
  }

  writeManifest(manifest);
  return { installed, errors };
}

export function installAllStagedSkills(): { installed: number; errors: number } {
  const manifests = listManifests().filter(m => m.project_root === null);
  let installed = 0;
  let errors = 0;

  const activeProjectsDir = path.join(CONFIG.paths.graphRoot, ".active-projects");
  if (!fs.existsSync(activeProjectsDir)) return { installed, errors };

  const projectRoots: Record<string, string> = {};
  for (const file of fs.readdirSync(activeProjectsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(activeProjectsDir, file), "utf-8"));
      if (data.project && data.cwd) projectRoots[data.project] = data.cwd;
    } catch {}
  }

  for (const manifest of manifests) {
    const root = projectRoots[manifest.project];
    if (!root) continue;

    const result = installSkillToProject(manifest, root);
    if (result.installed.length > 0) {
      manifest.project_root = root;
      writeManifest(manifest);
      installed++;
    }
    errors += result.errors.length;
  }

  return { installed, errors };
}

export interface DriftedManifest {
  manifest: SkillforgeManifest;
  fileName: string;
  currentHash: string;
  manifestHash: string;
}

const MAX_REFRESH_COUNT = 5;
const REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function findDriftedManifests(): DriftedManifest[] {
  const drifted: DriftedManifest[] = [];

  for (const manifest of listManifests()) {
    if (manifest.refresh_count >= MAX_REFRESH_COUNT) continue;

    if (manifest.last_refreshed_at) {
      const elapsed = Date.now() - new Date(manifest.last_refreshed_at).getTime();
      if (!Number.isNaN(elapsed) && elapsed < REFRESH_COOLDOWN_MS) continue;
    }

    const currentHash = manifest.source_nodes.length > 1
      ? computeMultiNodeContentHash(manifest.source_nodes)
      : computeNodeContentHash(manifest.source_nodes[0]);

    if (!currentHash || currentHash === manifest.content_hash) continue;

    const primaryNode = manifest.source_nodes[0];
    const nodeFullPath = path.join(CONFIG.paths.nodes, primaryNode + ".md");
    if (fs.existsSync(nodeFullPath)) {
      try {
        const raw = fs.readFileSync(nodeFullPath, "utf-8");
        const parsed = matter(raw);
        if (parsed.data?.archived === true) continue;
      } catch {}
    }

    const fileName = manifestKeyForNodes(manifest.source_nodes);
    drifted.push({
      manifest,
      fileName,
      currentHash,
      manifestHash: manifest.content_hash,
    });
  }
  return drifted;
}
