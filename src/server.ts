import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  createGraphMemoryServer,
  initializeGraph,
  buildSystemPrompt,
  activityBus,
  BufferWatcher,
  CONFIG,
} from "./graph-memory/index.js";
import { runLibrarian } from "./graph-memory/pipeline/librarian.js";
import { runDreamer } from "./graph-memory/pipeline/dreamer.js";
import { autoCommit } from "./graph-memory/git.js";
import { updateManifest } from "./graph-memory/manifest.js";
import fs from "fs";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

// Allow Agent SDK to spawn Claude Code subprocess even when running inside Claude Code
delete process.env.CLAUDECODE;

// --- Startup checks ---
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY environment variable is not set.");
  console.error("Set it in .env or export it before starting the server.");
  process.exit(1);
}

// --- Initialize ---
initializeGraph();
const graphMemoryServer = createGraphMemoryServer();
const bufferWatcher = new BufferWatcher();

// --- Express ---
const app = express();
const httpServer = createServer(app);

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    buffer: bufferWatcher.getStatus(),
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server: httpServer });

function broadcast(data: Record<string, unknown>) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// --- Consolidation Pipeline (runs on session end) ---
bufferWatcher.setOnSessionEnd(async (signal?: AbortSignal) => {
  const memSessionId = bufferWatcher.getSessionId();
  activityBus.log("session:end", `Running consolidation pipeline for ${memSessionId}`);

  try {
    // 1. Librarian: reconcile deltas → update graph
    await runLibrarian(memSessionId);

    // Check abort between steps
    if (signal?.aborted) {
      activityBus.log("session:end", "Pipeline aborted after librarian (new message arrived)");
      return;
    }

    // 2. Dreamer: creative recombination at temp=1.0
    await runDreamer(memSessionId);

    if (signal?.aborted) {
      activityBus.log("session:end", "Pipeline aborted after dreamer");
      return;
    }

    // 3. Update manifest
    updateManifest();

    // 4. Git auto-commit with session number
    const manifestRaw = fs.readFileSync(CONFIG.paths.manifest, "utf-8");
    const manifest = yaml.load(manifestRaw) as { total_sessions: number };
    await autoCommit(`session ${manifest.total_sessions}`);

    activityBus.log("session:end", "Consolidation pipeline complete. Graph updated for next session.");

    // Broadcast to clients that graph was updated
    broadcast({ type: "graph_updated" });
  } catch (err: any) {
    activityBus.log("system:error", `Consolidation pipeline error: ${err.message}`);
  }
});

// Mid-session refresh: run librarian at 200 messages to keep MAP fresh
bufferWatcher.setOnMidSessionRefresh(async () => {
  const memSessionId = bufferWatcher.getSessionId();
  activityBus.log("session:idle_warning", `Running mid-session librarian for ${memSessionId}`);
  try {
    await runLibrarian(memSessionId);
    broadcast({ type: "graph_updated" });
  } catch (err: any) {
    activityBus.log("system:error", `Mid-session refresh error: ${err.message}`);
  }
});

// Forward all activity events to WebSocket clients
activityBus.on("activity", (event) => {
  broadcast({
    type: "activity",
    event_type: event.type,
    message: event.message,
    details: event.details,
    timestamp: event.timestamp,
  });
});

// --- Session Management ---
let sessionId: string | undefined;
let isProcessing = false;

async function handleUserMessage(content: string, ws: WebSocket) {
  if (isProcessing) {
    ws.send(JSON.stringify({ type: "error", message: "Agent is still processing. Please wait." }));
    return;
  }

  isProcessing = true;

  // Log to conversation buffer
  bufferWatcher.appendMessage({
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    tokenEstimate: Math.ceil(content.length / 4),
  });

  try {
    const systemPrompt = buildSystemPrompt();

    const options: Record<string, unknown> = {
      systemPrompt,
      mcpServers: {
        "graph-memory": graphMemoryServer,
      },
      allowedTools: [
        "mcp__graph-memory__graph_memory",
      ],
      includePartialMessages: true,
      maxTurns: 10,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      stderr: (data: string) => {
        console.error("[SDK stderr]", data.trim());
      },
    };

    if (sessionId) {
      (options as any).resume = sessionId;
    }

    let fullResponse = "";
    let currentToolName: string | null = null;

    for await (const message of query({ prompt: content, options: options as any })) {
      // Capture session ID from init
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        activityBus.log("system:init", `Agent session: ${sessionId}`, {
          model: (message as any).model,
          tools: (message as any).tools,
        });
        continue;
      }

      // Stream text deltas
      if (message.type === "stream_event") {
        const event = (message as any).event;

        if (event?.type === "content_block_start" && event?.content_block?.type === "tool_use") {
          currentToolName = event.content_block.name;
          broadcast({
            type: "tool_use_start",
            tool: currentToolName,
          });
          activityBus.log("graph:node_updated", `Tool called: ${currentToolName}`);
        }

        if (event?.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") {
            broadcast({ type: "assistant_text", text: event.delta.text });
            fullResponse += event.delta.text;
          }
        }

        if (event?.type === "content_block_stop" && currentToolName) {
          broadcast({ type: "tool_use_end", tool: currentToolName });
          currentToolName = null;
        }
        continue;
      }

      // Complete assistant message
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            // Only send if we didn't already stream it
            if (!fullResponse.includes(block.text)) {
              broadcast({ type: "assistant_text", text: block.text });
              fullResponse += block.text;
            }
          }
        }
        continue;
      }

      // Result
      if (message.type === "result") {
        const result = message as any;
        broadcast({
          type: "assistant_done",
          cost: result.total_cost_usd,
          turns: result.num_turns,
        });
        activityBus.log("system:init", `Turn complete — cost: $${result.total_cost_usd?.toFixed(4) || "?"}, turns: ${result.num_turns || "?"}`, {
          cost: result.total_cost_usd,
          turns: result.num_turns,
          subtype: result.subtype,
        });

        // Log assistant response to buffer
        if (fullResponse) {
          bufferWatcher.appendMessage({
            role: "assistant",
            content: fullResponse,
            timestamp: new Date().toISOString(),
            tokenEstimate: Math.ceil(fullResponse.length / 4),
          });
        }
        continue;
      }
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    console.error("Agent error:", errorMsg);
    ws.send(JSON.stringify({ type: "error", message: errorMsg }));
    activityBus.log("system:error", `Agent error: ${errorMsg}`);
  } finally {
    isProcessing = false;
  }
}

// --- WebSocket Connection Handler ---
wss.on("connection", (ws) => {
  console.log("Client connected");

  // Start session on first connection if not active
  if (!bufferWatcher.getStatus().sessionActive) {
    bufferWatcher.startSession();
  }

  // Send current status
  ws.send(JSON.stringify({
    type: "status",
    buffer: bufferWatcher.getStatus(),
    sessionId,
  }));

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "user_message" && data.content) {
        // Broadcast the user message back to all clients for display
        broadcast({ type: "user_message", content: data.content });
        handleUserMessage(data.content, ws);
      }
    } catch (err) {
      console.error("Invalid WebSocket message:", err);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// --- Start Server ---
httpServer.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Graph Memory Test App`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`========================================\n`);
  activityBus.log("system:init", `Server started on port ${PORT}`);
});

// --- Process Exit Handler (Gap 5) ---
async function gracefulShutdown(signal: string) {
  activityBus.log("system:init", `Received ${signal} — starting graceful shutdown`);

  try {
    // Flush pending scribes
    await bufferWatcher.flush();

    // Run librarian (skip dreamer — non-critical, deltas preserved for next session)
    const memSessionId = bufferWatcher.getSessionId();
    const status = bufferWatcher.getStatus();
    if (memSessionId && status.totalSessionMessages >= CONFIG.session.minSessionMessages) {
      await runLibrarian(memSessionId);
      updateManifest();
      await autoCommit(`shutdown (${signal})`);
    }

    activityBus.log("system:init", "Graceful shutdown complete");
  } catch (err: any) {
    activityBus.log("system:error", `Shutdown error: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
