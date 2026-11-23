import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer } from "../server.js";
import { getConfig, splitList, type Config } from "../config.js";
import { PersonalOAuthProvider } from "../auth/provider.js";
import { DualTokenVerifier } from "../auth/bearer.js";
import { ConsentGate, CONSENT_PATH } from "../auth/consent.js";
import { base32Decode } from "../auth/totp.js";
import { createNotifier, type Notifier } from "../audit/alert.js";
import { RequestLog, AuthFailureWatch, requestLogger } from "../audit/request-log.js";
import { rejectSession } from "./session-errors.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AppDeps {
  provider?: PersonalOAuthProvider;
  notifier?: Notifier;
  requestLog?: RequestLog;
  now?: () => number;
}

/** Parse and check the consent secret. Throws (so startup fails) when missing or weak. */
export function consentKeyFrom(config: Config): Buffer {
  if (!config.CONSENT_TOTP_SECRET) {
    throw new Error(
      "CONSENT_TOTP_SECRET is not set. Refusing to start the HTTP transport without a consent gate. " +
        "Generate one with: node scripts/totp-setup.mjs"
    );
  }
  const key = base32Decode(config.CONSENT_TOTP_SECRET);
  if (key.length < 16) {
    throw new Error("CONSENT_TOTP_SECRET is too short (need at least 128 bits / 26 base32 chars)");
  }
  return key;
}

/**
 * Build the Express app. Exported separately from startHttpTransport so tests
 * can exercise every route without binding the real port.
 */
export function createApp(config: Config, deps: AppDeps = {}): express.Express {
  const app = express();
  const notifier =
    deps.notifier ?? createNotifier(config.ALERT_TELEGRAM_BOT_TOKEN, config.ALERT_TELEGRAM_CHAT_ID);
  const totpKey = consentKeyFrom(config);

  // Trust exactly 1 proxy hop (Tailscale Funnel), so req.ip is the client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Request log first, so it sees every request including rejected ones.
  const requestLog = deps.requestLog ?? new RequestLog(config.REQUEST_LOG_PATH);
  app.use(requestLogger(requestLog, new AuthFailureWatch(notifier)));

  // CORS for the browser-based Claude.ai connector. Only allowlisted origins get
  // CORS headers; anything else is never reflected (the browser then blocks it).
  // Non-browser clients send no Origin and are unaffected.
  const allowedOrigins = new Set(splitList(config.CORS_ALLOWED_ORIGINS));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, mcp-session-id, mcp-protocol-version, last-event-id, Accept"
      );
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS" && req.path === "/") {
      res.status(204).end();
      return;
    }
    next();
  });

  const serverUrl = new URL(
    config.SERVER_URL || `http://localhost:${config.PORT}`
  );

  // OAuth provider: registration allowlist + TOTP consent gate.
  const oauthProvider =
    deps.provider ??
    new PersonalOAuthProvider({
      allowedRedirectUris: splitList(config.OAUTH_ALLOWED_REDIRECT_URIS),
      allowLoopbackRedirects: config.OAUTH_ALLOW_LOOPBACK,
      maxClients: config.OAUTH_MAX_CLIENTS,
      notifier,
    });
  const consent = new ConsentGate({
    totpKey,
    notifier,
    issueCode: (client, params) => oauthProvider.issueAuthorizationCode(client, params),
    now: deps.now,
  });
  oauthProvider.setConsentGate(consent);

  // Consent form POST (urlencoded, small body).
  app.post(CONSENT_PATH, express.urlencoded({ extended: false, limit: "4kb" }), (req, res) =>
    consent.handle(req, res)
  );

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
      version: "0.2.0",
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
      rejectSession(res, sessionId);
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET / — SSE stream resumption
  app.get("/", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      rejectSession(res, sessionId, "Missing session ID");
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE / — Session teardown
  app.delete("/", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      rejectSession(res, sessionId, "Missing session ID");
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
    res.status(200).end();
  });

  // Anything else: 404 (no implicit routes).
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}

/**
 * Start the MCP server with HTTP transport (Streamable HTTP).
 * Used for remote access via Claude.ai (OAuth) and Claude Code (bearer token).
 */
export async function startHttpTransport(): Promise<void> {
  const config = getConfig();
  const app = createApp(config);
  const serverUrl = new URL(config.SERVER_URL || `http://localhost:${config.PORT}`);

  app.listen(config.PORT, () => {
    console.error(
      `[obsidian-mcp] Server started on HTTP transport at ${serverUrl}`
    );
    console.error(
      `[obsidian-mcp] Health check: ${serverUrl}health`
    );
  });
}
