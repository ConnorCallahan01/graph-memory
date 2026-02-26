import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { CONFIG } from "./config.js";
import { countFiles } from "./utils.js";

interface Manifest {
  last_session: string;
  total_sessions: number;
  node_count: number;
  archived_count: number;
  dream_count: number;
  hot_nodes: string[];
  created: string;
  version: string;
}

/**
 * Create manifest.yml if it doesn't exist, without incrementing session count.
 */
export function createManifestIfMissing(): void {
  if (fs.existsSync(CONFIG.paths.manifest)) return;

  const manifest: Manifest = {
    last_session: "",
    total_sessions: 0,
    node_count: countFiles(CONFIG.paths.nodes, ".md"),
    archived_count: countFiles(CONFIG.paths.archive, ".md"),
    dream_count: 0,
    hot_nodes: [],
    created: new Date().toISOString(),
    version: "0.1.0",
  };

  fs.writeFileSync(CONFIG.paths.manifest, yaml.dump(manifest, { lineWidth: 120 }));
}

/**
 * Update manifest.yml after each session with current graph stats.
 */
export function updateManifest(): void {
  const manifestPath = CONFIG.paths.manifest;
  let manifest: Manifest;

  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    manifest = yaml.load(raw) as Manifest;
    manifest.total_sessions = (manifest.total_sessions || 0) + 1;
  } else {
    manifest = {
      last_session: "",
      total_sessions: 1,
      node_count: 0,
      archived_count: 0,
      dream_count: 0,
      hot_nodes: [],
      created: new Date().toISOString(),
      version: "0.1.0",
    };
  }

  manifest.last_session = new Date().toISOString();
  manifest.node_count = countFiles(CONFIG.paths.nodes, ".md");
  manifest.archived_count = countFiles(CONFIG.paths.archive, ".md");

  const pendingDir = path.join(CONFIG.paths.dreams, "pending");
  manifest.dream_count = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir).filter(f => f.endsWith(".json")).length
    : 0;

  // Find hot nodes (confidence >= hotNodeThreshold)
  manifest.hot_nodes = findHotNodes();

  fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: 120 }));
}

function findHotNodes(): string[] {
  const indexPath = CONFIG.paths.index;
  if (!fs.existsSync(indexPath)) return [];

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    return index
      .filter((e: any) => (e.confidence || 0) >= CONFIG.graph.decayHotNodeThreshold)
      .sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 10)
      .map((e: any) => e.path);
  } catch {
    return [];
  }
}
