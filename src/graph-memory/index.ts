import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";
import { activityBus } from "./events.js";
import { BufferWatcher } from "./buffer-watcher.js";
import { handleGraphMemory, graphMemorySchema } from "./tools.js";
import { createManifestIfMissing } from "./manifest.js";
import fs from "fs";

export { activityBus } from "./events.js";
export { BufferWatcher } from "./buffer-watcher.js";
export { CONFIG } from "./config.js";

/** Create the graph-memory MCP server with all tools registered */
export function createGraphMemoryServer() {
  const server = createSdkMcpServer({
    name: "graph-memory",
    version: "0.1.0",
    tools: [
      tool(
        "graph_memory",
        "Access the knowledge graph. Actions: read_node (read a node by path), search (keyword search across nodes), list_edges (get edges for a node), read_dream (read dream fragments), write_note (save a working note), status (graph health check).",
        graphMemorySchema,
        async (args) => {
          return handleGraphMemory(args);
        }
      ),
    ],
  });

  activityBus.log("system:init", "Graph memory MCP server created", {
    tools: ["graph_memory"],
  });

  return server;
}

/** Initialize the graph directory structure */
export function initializeGraph() {
  const dirs = [
    CONFIG.paths.graphRoot,
    CONFIG.paths.nodes,
    CONFIG.paths.archive,
    CONFIG.paths.deltas,
    CONFIG.paths.buffer,
    CONFIG.paths.dreams,
    `${CONFIG.paths.dreams}/pending`,
    `${CONFIG.paths.dreams}/integrated`,
    `${CONFIG.paths.dreams}/archived`,
    `${CONFIG.paths.nodes}/_meta`,
    `${CONFIG.paths.nodes}/insight`,
    `${CONFIG.paths.nodes}/pattern`,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Create empty MAP.md if it doesn't exist
  if (!fs.existsSync(CONFIG.paths.map)) {
    fs.writeFileSync(
      CONFIG.paths.map,
      `# MAP — Knowledge Graph Index\n\n> Auto-generated. Each entry: node path | gist | edges\n\n_No nodes yet. The graph will grow as conversations happen._\n`
    );
  }

  // Create empty PRIORS.md if it doesn't exist
  if (!fs.existsSync(CONFIG.paths.priors)) {
    fs.writeFileSync(
      CONFIG.paths.priors,
      `# PRIORS — Behavioral Guidelines\n\n> Derived from cross-session patterns. These shape how you think, not what you know.\n\n_No priors yet. These will emerge from conversation patterns._\n`
    );
  }

  // Create empty index if it doesn't exist
  if (!fs.existsSync(CONFIG.paths.index)) {
    fs.writeFileSync(CONFIG.paths.index, "[]");
  }

  // Create manifest.yml if it doesn't exist (without incrementing session count)
  createManifestIfMissing();

  activityBus.log("system:init", "Graph directory initialized", {
    graphRoot: CONFIG.paths.graphRoot,
  });
}

/** Build the agent system prompt with PRIORS + MAP loaded */
export function buildSystemPrompt(): string {
  let priors = "";
  let map = "";

  if (fs.existsSync(CONFIG.paths.priors)) {
    priors = fs.readFileSync(CONFIG.paths.priors, "utf-8");
  }
  if (fs.existsSync(CONFIG.paths.map)) {
    map = fs.readFileSync(CONFIG.paths.map, "utf-8");
  }

  return `You are a helpful AI assistant with persistent memory powered by a knowledge graph.

## Your Memory System

You have access to a \`graph_memory\` tool that lets you read and search your knowledge graph.
The graph contains nodes (markdown files with structured frontmatter) organized by topic.

### Behavioral Priors
${priors || "_No priors loaded._"}

### Knowledge Map
${map || "_No map loaded._"}

## How to Use Memory

- The MAP above shows all nodes you know about. Use \`graph_memory(action="read_node", path="...")\` to read full details.
- Use \`graph_memory(action="search", query="...")\` to find nodes by topic.
- Use \`graph_memory(action="list_edges", path="...")\` to explore connections.
- Use \`graph_memory(action="write_note", note="...")\` to save observations.
- Use \`graph_memory(action="status")\` to check graph health.

## Important

- Your memory updates happen automatically between sessions. You don't need to manage it.
- Be natural in conversation. Don't mention the memory system unless the user asks about it.
- If the MAP is empty, that's fine — memory will grow from your conversations.`;
}
