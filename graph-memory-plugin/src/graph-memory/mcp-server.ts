#!/usr/bin/env node
/**
 * MCP server for graph-memory plugin.
 * Exposes the graph_memory tool and graph://map, graph://priors resources over stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeGraph, isGraphInitialized } from "./index.js";
import { handleGraphMemory, graphMemorySchema } from "./tools.js";
import fs from "fs";
import { CONFIG } from "./config.js";

// Initialize graph directory structure (creates dirs if missing, idempotent)
if (isGraphInitialized() || process.env.GRAPH_MEMORY_ROOT) {
  initializeGraph();
}

const server = new McpServer({
  name: "graph-memory",
  version: "2.0.0",
});

// Main tool
server.tool(
  "graph_memory",
  `Access the persistent knowledge graph. Actions: initialize, configure_runtime, status, remember, write_note, search, recall, read_node, list_edges, read_dream, consolidate, history, revert, resurface.
MEMORY ACTIONS:
- remember: Create or update a graph node directly. Provide path, gist, and optionally content, tags, edges, soma markers.
- recall: Combined search + edge traversal. Returns matching nodes plus connected nodes (1 hop).
- search: Keyword search on the index (gist, tags, keywords).
- read_node: Read full node content including frontmatter.
- list_edges: Show all connections from a node.

RETRIEVAL GUIDANCE — follow these steps proactively:
1. At conversation start, the MAP and PRIORS are loaded via hooks. Use them to understand what you already know.
2. When the user mentions personal details, preferences, past events, or recurring topics, use "recall" with relevant keywords.
3. When a relevant node is found, use "list_edges" to discover related nodes.
4. When you learn something worth remembering, use "remember" to record it as a proper graph node with edges and tags.

PIPELINE:
- consolidate: Run mechanical delta processing (apply scribe deltas, rebuild MAP, decay, git commit).

SETUP:
- initialize: First-time setup. Pass graphRoot to choose storage location (defaults to ~/.graph-memory/).
- configure_runtime: Set manual or Docker runtime configuration. Pass workerProvider (codex, claude, pi, opencode) to choose the pipeline agent harness. Pass workerModel to override the model used by pipeline workers (e.g. 'sonnet', 'o3', 'gpt-4.1').`,
  graphMemorySchema,
  async (args) => {
    return handleGraphMemory(args);
  }
);

// Expose MAP and PRIORS as MCP resources
server.resource(
  "map",
  "graph://map",
  async (uri) => {
    const content = fs.existsSync(CONFIG.paths.map)
      ? fs.readFileSync(CONFIG.paths.map, "utf-8")
      : "_No MAP loaded. Run /memory-onboard to set up memory._";
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: content }],
    };
  }
);

server.resource(
  "priors",
  "graph://priors",
  async (uri) => {
    const content = fs.existsSync(CONFIG.paths.priors)
      ? fs.readFileSync(CONFIG.paths.priors, "utf-8")
      : "_No priors loaded._";
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: content }],
    };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
