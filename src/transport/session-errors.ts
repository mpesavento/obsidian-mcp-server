/**
 * Responses for requests whose MCP session can't be used.
 *
 * Sessions live in memory, so every server restart forgets them. Per the MCP
 * Streamable HTTP spec, a request carrying an Mcp-Session-Id the server doesn't
 * know MUST get HTTP 404, and a client that sees 404 MUST start a new session.
 * We used to answer 400, which clients don't treat as "reinitialize", so every
 * connected client (claude.ai connectors, agents) stayed broken after a
 * restart until someone reconnected it by hand.
 *
 * A request with no session ID that isn't an initialize request is still a
 * plain bad request (400).
 */

export interface SessionErrorResponse {
  status(code: number): { json(body: unknown): unknown };
}

export function sessionErrorStatus(sessionId: string | undefined): 404 | 400 {
  return sessionId ? 404 : 400;
}

export function rejectSession(
  res: SessionErrorResponse,
  sessionId: string | undefined,
  missingMessage = "Missing session ID or not an initialization request"
): void {
  const status = sessionErrorStatus(sessionId);
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message:
        status === 404
          ? "Session not found (expired or server restarted); start a new session"
          : missingMessage,
    },
    id: null,
  });
}
