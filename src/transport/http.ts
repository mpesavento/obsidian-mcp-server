import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer } from "../server.js";
import { getConfig } from "../config.js";
import { PersonalOAuthProvider } from "../auth/provider.js";
import { DualTokenVerifier } from "../auth/bearer.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Start the MCP server with HTTP transport (Streamable HTTP).
 * Used for remote access via Claude.ai (OAuth) and Claude Code (bearer token).
 */
export async function startHttpTransport(): Promise<void> {
  const config = getConfig();
  const app = express();

  const serverUrl = new URL(
    config.SERVER_URL || `http://localhost:${config.PORT}`
  );

  // OAuth provider (in-memory, auto-approve)
  const oauthProvider = new PersonalOAuthProvider();

  // Dual verifier: accepts both OAuth tokens and static bearer token
  const verifier = new DualTokenVerifier(oauthProvider, config.AUTH_TOKEN);

  // Install OAuth endpoints (/.well-known/*, /register, /authorize, /token, /revoke)
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: serverUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "Obsidian Vault MCP Server",
    })
  );

  // Bearer auth middleware for MCP endpoints
  const authMiddleware = requireBearerAuth({
    verifier,
    resourceMetadataUrl:
      getOAuthProtectedResourceMetadataUrl(serverUrl),
  });

  // Parse JSON bodies for POST requests
  app.use(express.json());

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: "0.1.0",
      transport: "http",
      uptime: process.uptime(),
    });
  });

  // HEAD / — Protocol version discovery (required by Claude.ai)
  app.head("/", (_req, res) => {
    res.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    res.status(200).end();
  });

  // Session tracking for stateful connections
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // POST / — MCP messages
  app.post("/", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: sessionId
            ? "Invalid or expired session"
            : "Missing session ID or not an initialization request",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET / — SSE stream resumption
  app.get("/", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session" },
        id: null,
      });
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE / — Session teardown
  app.delete("/", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session" },
        id: null,
      });
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
    res.status(200).end();
  });

  app.listen(config.PORT, () => {
    console.error(
      `[obsidian-mcp] Server started on HTTP transport at ${serverUrl}`
    );
    console.error(
      `[obsidian-mcp] Health check: ${serverUrl}health`
    );
  });
}
