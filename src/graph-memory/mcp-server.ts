#!/usr/bin/env node
/**
 * Standalone MCP server for graph-memory.
 * Exposes the graph_memory tool over stdio for use with Claude Code, Cursor, etc.
 *
 * Usage: npx tsx src/graph-memory/mcp-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeGraph } from "./index.js";
import { handleGraphMemory } from "./tools.js";
import fs from "fs";
import { CONFIG } from "./config.js";

// Initialize graph directory structure
initializeGraph();

const server = new McpServer({
  name: "graph-memory",
  version: "0.1.0",
});

server.tool(
  "graph_memory",
  "Access the knowledge graph. Actions: read_node, search, list_edges, read_dream, write_note, status",
  {
    action: z.enum(["read_node", "search", "list_edges", "read_dream", "write_note", "status"])
      .describe("The action to perform on the knowledge graph"),
    path: z.string().optional()
      .describe("Node path for read_node/list_edges, dream path for read_dream"),
    query: z.string().optional()
      .describe("Search query for the search action"),
    note: z.string().optional()
      .describe("Note content for write_note action"),
  },
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
      : "_No MAP loaded._";
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
